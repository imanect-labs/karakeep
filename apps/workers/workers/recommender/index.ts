import {
  recommenderCandidatesCounter,
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

import { runCollect } from "./collect";
import { runEmbed } from "./embed";
import { runMaintain } from "./maintain";
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
    case "discover":
    case "rank":
    case "train":
    case "reward_join":
    case "bootstrap": {
      logger.warn(
        `[recommender][${jobId}] task "${task.type}" is not implemented yet, skipping`,
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
    "recommender.embed_failed": result.failed,
    "recommender.duplicates": result.duplicatesMarked,
    "recommender.clusters": result.clusters,
  });
  recommenderEmbeddingsCounter.labels("success").inc(result.embedded);
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
  type: Exclude<ZRecommenderTask["type"], "bootstrap">,
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
