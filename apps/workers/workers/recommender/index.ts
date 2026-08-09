import {
  recommenderBriefingsCounter,
  recommenderCandidatesCounter,
  recommenderDigestsCounter,
  recommenderDomainsCounter,
  recommenderEmbeddingsCounter,
  recommenderSourceFailuresCounter,
  workerStatsCounter,
} from "metrics";
import cron from "node-cron";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import type {
  ZRecommenderEmbedTask,
  ZRecommenderTask,
} from "@karakeep/shared-server";
import {
  addLogFields,
  RecommenderEmbedQueue,
  RecommenderQueue,
  zRecommenderEmbedTaskSchema,
  zRecommenderTaskSchema,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { DequeuedJob, getQueueClient } from "@karakeep/shared/queueing";

import { runBootstrap } from "./bootstrap";
import { runCollect } from "./collect";
import { runDigest } from "./digest";
import { runDiscover } from "./discover";
import { runEmbed } from "./embed";
import { requeueUnobserved, runRewardJoin } from "./feedback";
import { runMaintain } from "./maintain";
import { runRank } from "./rank";
import { recommenderUserIds } from "./shared";

/**
 * 日次パイプラインの本体。`discover` → `collect` → `embed` → `rank` の順に
 * 時刻をずらして走る。
 *
 * Phase 1 の実装が進むまで、未実装のタスクは警告だけ出して何もしない。
 * ジョブを失敗させると再試行で無駄にキューが回る。
 */
async function runRecommenderTask(job: DequeuedJob<ZRecommenderTask>) {
  const task = job.data;
  const jobId = job.id;
  addLogFields<"recommenderWorker.run">({
    "recommender.task": task.type,
    "user.id": task.userId,
  });

  switch (task.type) {
    case "collect": {
      const result = await runCollect(task.userId, jobId);
      addLogFields<"recommenderWorker.run">({
        "recommender.sources_tried": result.sourcesTried,
        "recommender.sources_failed": result.sourcesFailed,
        "recommender.fetched": result.fetched,
        "recommender.inserted": result.inserted,
        "recommender.new_domains": result.newDomains,
      });
      recommenderCandidatesCounter.labels("inserted").inc(result.inserted);
      recommenderCandidatesCounter
        .labels("duplicate")
        .inc(result.skippedDuplicates);
      recommenderSourceFailuresCounter.inc(result.sourcesFailed);
      return;
    }
    case "maintain": {
      await runMaintain(task.userId, jobId);
      return;
    }
    case "discover": {
      const result = await runDiscover(task.userId, jobId);
      addLogFields<"recommenderWorker.run">({
        "recommender.new_domains": result.backfilled + result.fromOutboundLinks,
      });
      recommenderDomainsCounter.labels("screened").inc(result.screened);
      recommenderDomainsCounter.labels("trial").inc(result.trialsStarted);
      recommenderDomainsCounter.labels("promoted").inc(result.promoted);
      recommenderDomainsCounter.labels("demoted").inc(result.demoted);
      return;
    }
    case "rank": {
      const result = await runRank(task.userId, task.briefingDate, jobId);
      recommenderBriefingsCounter.labels(result.modelVersion).inc();
      logger.info(`[recommender][rank][${jobId}] ${JSON.stringify(result)}`);
      return;
    }
    case "bootstrap": {
      await runBootstrap(task.userId, task.limit, jobId);
      return;
    }
    case "digest": {
      const result = await runDigest(task.userId, task.briefingId, jobId);
      addLogFields<"recommenderWorker.run">({
        "recommender.digests_generated": result.generated,
        "recommender.digests_shared": result.shared,
        "recommender.digests_failed": result.failed,
      });
      recommenderDigestsCounter.labels("success").inc(result.generated);
      recommenderDigestsCounter.labels("cached").inc(result.cached);
      // `cached` (同一ユーザー・別日) と分けて取る。混ぜるとユーザー間共有が
      // 効いているかを測れない。
      recommenderDigestsCounter.labels("shared").inc(result.shared);
      recommenderDigestsCounter.labels("failure").inc(result.failed);
      recommenderDigestsCounter.labels("skipped").inc(result.skipped);
      return;
    }
    case "reward_join": {
      const result = await runRewardJoin(task.userId, jobId);
      const requeued = await requeueUnobserved(task.userId, new Date());
      logger.info(
        `[recommender][reward][${jobId}] ${JSON.stringify(result)}, requeued ${requeued}`,
      );
      return;
    }
    case "train": {
      // Phase 2。ログが貯まるまで学習しない（FR-L-07）。
      logger.info(
        `[recommender][${jobId}] training starts in Phase 2, nothing to do yet`,
      );
      return;
    }
  }
}

async function runRecommenderEmbedTask(
  job: DequeuedJob<ZRecommenderEmbedTask>,
) {
  addLogFields<"recommenderEmbedWorker.run">({ "user.id": job.data.userId });
  const result = await runEmbed(job.data.userId, job.data.candidateIds, job.id);
  addLogFields<"recommenderEmbedWorker.run">({
    "recommender.embedded": result.embedded,
    "recommender.embed_shared": result.shared,
    "recommender.embed_failed": result.failed,
    "recommender.duplicates": result.duplicatesMarked,
    "recommender.clusters": result.clusters,
  });
  recommenderEmbeddingsCounter.labels("success").inc(result.embedded);
  // 共有キャッシュから貰った分。埋め込みプロバイダを叩いていない。
  recommenderEmbeddingsCounter.labels("shared").inc(result.shared);
  recommenderEmbeddingsCounter.labels("failure").inc(result.failed);
}

export class RecommenderWorker {
  static async build() {
    logger.info("Starting recommender worker ...");
    return (await getQueueClient()).createRunner<ZRecommenderTask>(
      RecommenderQueue,
      {
        run: withWorkerTracing(
          "recommenderWorker.run",
          withWorkerEventLog("recommenderWorker.run", runRecommenderTask),
        ),
        onComplete: async () => {
          workerStatsCounter.labels("recommender", "completed").inc();
        },
        onError: async (job) => {
          workerStatsCounter.labels("recommender", "failed").inc();
          logger.error(
            `[recommender][${job.id}] job failed: ${job.error}\n${job.error.stack}`,
          );
        },
      },
      {
        // 日次バッチを直列に流す。同時に走らせても速くならず、SQLite の
        // ロック待ちだけが増える。
        concurrency: 1,
        pollIntervalMs: 5000,
        timeoutSecs: serverConfig.recommender.jobTimeoutSec,
        validator: zRecommenderTaskSchema,
      },
    );
  }
}

export class RecommenderEmbedWorker {
  static async build() {
    logger.info("Starting recommender embedding worker ...");
    return (await getQueueClient()).createRunner<ZRecommenderEmbedTask>(
      RecommenderEmbedQueue,
      {
        run: withWorkerTracing(
          "recommenderEmbedWorker.run",
          withWorkerEventLog(
            "recommenderEmbedWorker.run",
            runRecommenderEmbedTask,
          ),
        ),
        onComplete: async () => {
          workerStatsCounter.labels("recommender_embed", "completed").inc();
        },
        onError: async (job) => {
          workerStatsCounter.labels("recommender_embed", "failed").inc();
          logger.error(
            `[recommender][embed][${job.id}] job failed: ${job.error}\n${job.error.stack}`,
          );
        },
      },
      {
        concurrency: serverConfig.recommender.numWorkers,
        pollIntervalMs: 5000,
        timeoutSecs: serverConfig.recommender.jobTimeoutSec,
        validator: zRecommenderEmbedTaskSchema,
      },
    );
  }
}

function scheduleDaily(
  expression: string,
  // digest は rank が briefingId 付きで投入するので、cron からは呼べない。
  type: Exclude<ZRecommenderTask["type"], "bootstrap" | "digest">,
) {
  return cron.schedule(
    expression,
    () => {
      void (async () => {
        try {
          const userIds = await recommenderUserIds();
          for (const userId of userIds) {
            await RecommenderQueue.enqueue(
              { type, userId },
              {
                groupId: userId,
                // 同じ日に 2 回走っても 1 回しか実行されない。cron が
                // 二重に発火しても候補が二重に入らない。
                idempotencyKey: `rec:${type}:${userId}:${new Date()
                  .toISOString()
                  .slice(0, 10)}`,
              },
            );
          }
        } catch (e) {
          logger.error(`[recommender] failed to schedule "${type}": ${e}`);
        }
      })();
    },
    { runOnInit: false, scheduled: false },
  );
}

/**
 * 日次スケジューラ。`RECOMMENDER_ENABLED=false` のあいだは 1 つも登録しない
 * ので、既存のデプロイに影響しない。
 */
export const RecommenderSchedulingWorker = {
  tasks: [] as ReturnType<typeof cron.schedule>[],

  start() {
    if (!serverConfig.recommender.enabled) {
      logger.info(
        "[recommender] RECOMMENDER_ENABLED is false, not scheduling any jobs",
      );
      return;
    }
    const { cron: schedule } = serverConfig.recommender;
    this.tasks = [
      scheduleDaily(schedule.maintain, "maintain"),
      // 観測状態と examined の確定は、その日の収集より前に済ませる。
      // 順番が逆だと、当日の impression が未確定のまま集計に入る。
      scheduleDaily(schedule.maintain, "reward_join"),
      scheduleDaily(schedule.train, "train"),
      scheduleDaily(schedule.discover, "discover"),
      scheduleDaily(schedule.collect, "collect"),
      scheduleDaily(schedule.rank, "rank"),
    ];
    for (const task of this.tasks) {
      task.start();
    }
    logger.info(
      `[recommender] scheduled maintain=${schedule.maintain} train=${schedule.train} discover=${schedule.discover} collect=${schedule.collect} rank=${schedule.rank}`,
    );
  },

  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
  },
};
