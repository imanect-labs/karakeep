import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  bookmarks,
  highlights,
  recBriefings,
  recCandidates,
  recClusters,
  recDomains,
  recFeedbackEvents,
  recImpressions,
  userReadingProgress,
} from "@karakeep/db/schema";
import type { RewardEvent } from "@karakeep/recommender";
import {
  computeReward,
  finalizeObservation,
  isAbandonedRead,
  readingProgressEvent,
} from "@karakeep/recommender";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { chunk, IN_CLAUSE_CHUNK, localDateString } from "./shared";

/** 遅延報酬の観測窓（FR-F-03）。7 日で確定し、以後は更新しない。 */
const REWARD_WINDOW_DAYS = 7;

export interface RewardJoinResult {
  briefingsFinalized: number;
  examinedMarked: number;
  delayedEvents: number;
  abandonedReads: number;
  rewardsFinalized: number;
  domainsUpdated: number;
}

/**
 * 日次のフィードバック確定（FR-F-02〜07）。
 *
 * 1. 昨日以前の Briefing の観測状態と `examined` を確定する
 * 2. 保存されたブックマークの読了・ハイライト・お気に入りを遅延報酬として join
 * 3. 「訳して読む」が空振りに終わったものを弱い負例にする
 * 4. 観測窓を過ぎた impression の報酬を確定する
 * 5. ドメインとクラスタのカウントを更新する
 *
 * **順序が意味を持つ。** `examined` を先に確定しないと、ドメインの
 * `examinedCount` が実際より少なくなり、降格も昇格も判定がずれる。
 * 3 は 2 の後・4 の前でなければならない — 2 が書いた読了イベントを見て
 * 判定し、その結果を 4 の報酬計算に含める必要がある。
 */
export async function runRewardJoin(
  userId: string,
  jobId: string,
): Promise<RewardJoinResult> {
  const now = new Date();
  const log = (msg: string) =>
    logger.info(`[recommender][reward][${jobId}] ${msg}`);

  const { briefingsFinalized, examinedMarked } = await finalizeBriefings(
    userId,
    now,
  );
  const delayedEvents = await joinDelayedRewards(userId, now);
  const abandonedReads = await markAbandonedReads(userId, now);
  const rewardsFinalized = await finalizeRewards(userId, now);
  const domainsUpdated = await refreshCounters(userId);

  log(
    `finalized ${briefingsFinalized} briefings (${examinedMarked} examined), ` +
      `${delayedEvents} delayed events, ${abandonedReads} abandoned reads, ` +
      `${rewardsFinalized} rewards, ${domainsUpdated} domains`,
  );
  return {
    briefingsFinalized,
    examinedMarked,
    delayedEvents,
    abandonedReads,
    rewardsFinalized,
    domainsUpdated,
  };
}

/**
 * 昨日以前の Briefing について観測状態と `examined` を確定する。
 *
 * 当日ぶんは触らない。まだ見るかもしれない Briefing を `unobserved` に
 * 固めてしまうと、その日のログが丸ごと学習から落ちる。
 */
async function finalizeBriefings(
  userId: string,
  now: Date,
): Promise<{ briefingsFinalized: number; examinedMarked: number }> {
  const today = localDateString(now);
  const pending = await db
    .select({
      id: recBriefings.id,
      openedAt: recBriefings.openedAt,
      briefingDate: recBriefings.briefingDate,
    })
    .from(recBriefings)
    .where(
      and(
        eq(recBriefings.userId, userId),
        eq(recBriefings.status, "ready"),
        lt(recBriefings.briefingDate, today),
        sql`${recBriefings.observationFinalizedAt} is null`,
      ),
    );

  let examinedMarked = 0;
  for (const briefing of pending) {
    const impressions = await db
      .select({
        impressionId: recImpressions.id,
        rank: recImpressions.rank,
      })
      .from(recImpressions)
      .where(
        and(
          eq(recImpressions.briefingId, briefing.id),
          eq(recImpressions.shown, true),
        ),
      );

    // 相関サブクエリで数えると、条件が噛み合わなくても 0 が返るだけで
    // **エラーにならない**。examined が黙って 1 件も立たなくなるので、
    // ここは素直に 2 本のクエリに分ける。
    const viewedRows = await db
      .selectDistinct({ impressionId: recFeedbackEvents.impressionId })
      .from(recFeedbackEvents)
      .innerJoin(
        recImpressions,
        eq(recImpressions.id, recFeedbackEvents.impressionId),
      )
      .where(
        and(
          eq(recImpressions.briefingId, briefing.id),
          eq(recFeedbackEvents.eventType, "viewed"),
        ),
      );
    const viewed = new Set(viewedRows.map((v) => v.impressionId));

    const result = finalizeObservation(
      impressions.map((i) => ({
        impressionId: i.impressionId,
        rank: i.rank,
        viewed: viewed.has(i.impressionId),
      })),
      !!briefing.openedAt,
    );

    for (const batch of chunk(result.examinedIds, IN_CLAUSE_CHUNK)) {
      await db
        .update(recImpressions)
        .set({ examined: true })
        .where(inArray(recImpressions.id, batch));
      examinedMarked += batch.length;
    }

    await db
      .update(recBriefings)
      .set({
        observationState: result.state,
        deepestViewedRank: result.deepestViewedRank,
        observationFinalizedAt: now,
      })
      .where(eq(recBriefings.id, briefing.id));
  }

  return { briefingsFinalized: pending.length, examinedMarked };
}

/**
 * 保存されたブックマークの読了・ハイライト・お気に入りを、対応する
 * impression に遅延報酬として join する（FR-F-02）。
 */
async function joinDelayedRewards(userId: string, now: Date): Promise<number> {
  const windowStart = new Date(now.getTime() - REWARD_WINDOW_DAYS * 86_400_000);

  const rows = await db
    .select({
      impressionId: recImpressions.id,
      bookmarkId: recCandidates.bookmarkId,
      favourited: bookmarks.favourited,
      progress: userReadingProgress.readingProgressPercent,
      highlightId: highlights.id,
    })
    .from(recImpressions)
    .innerJoin(recCandidates, eq(recCandidates.id, recImpressions.candidateId))
    .innerJoin(bookmarks, eq(bookmarks.id, recCandidates.bookmarkId))
    .leftJoin(
      userReadingProgress,
      and(
        eq(userReadingProgress.bookmarkId, bookmarks.id),
        eq(userReadingProgress.userId, userId),
      ),
    )
    .leftJoin(highlights, eq(highlights.bookmarkId, bookmarks.id))
    .where(
      and(
        eq(recImpressions.userId, userId),
        eq(recImpressions.rewardFinalized, false),
        isNotNull(recCandidates.bookmarkId),
        gte(recImpressions.createdAt, windowStart),
      ),
    );

  const events: (typeof recFeedbackEvents.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const push = (eventType: RewardEvent) => {
      const key = `${row.impressionId}:${eventType}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      events.push({
        impressionId: row.impressionId,
        userId,
        eventType,
        occurredAt: now,
      });
    };

    const progressEvent = readingProgressEvent(row.progress);
    if (progressEvent) {
      push(progressEvent);
    }
    if (row.highlightId) {
      push("highlighted");
    }
    if (row.favourited) {
      push("favourited");
    }
  }

  for (const batch of chunk(events)) {
    // 同じ日に 2 回走っても二重に入らない（一意制約 + occurredAt が同一）。
    await db.insert(recFeedbackEvents).values(batch).onConflictDoNothing();
  }
  return events.length;
}

/**
 * 「訳して読む」が空振りに終わったものを弱い負例にする（FR-U-14）。
 *
 * 「訳して読む」(`read_intent`) は正例でも負例でもない**意図の記録**で、
 * 押した時点では何も判断しない。観測窓 (7 日) を過ぎても保存・いいね・
 * 読了・ハイライト・お気に入りが 1 つも付かなかったら、そこで初めて
 * 「読もうとしたが、読むに値しなかった」という弱い負例として確定する。
 *
 * **`read_partial` があるものは対象外。** 途中まで読んだのは engagement で
 * あって空振りではない。負例は偽陽性のコストが高い（興味の重心が実態から
 * ずれ、以後その方向の記事が出なくなる）ので、判定は保守的にする。
 * 同じ理由で `dismissed` 済みのものも対象外 — 明示的な負例が既にある。
 *
 * 押した瞬間ではなく窓の満了時に判定するので、`joinDelayedRewards` の
 * **後**に呼ぶこと。順序を逆にすると、読了イベントが書かれる前に空振りと
 * 判定してしまう。
 */
async function markAbandonedReads(userId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - REWARD_WINDOW_DAYS * 86_400_000);

  const rows = await db
    .select({
      impressionId: recImpressions.id,
      eventType: recFeedbackEvents.eventType,
    })
    .from(recImpressions)
    .innerJoin(
      recFeedbackEvents,
      eq(recFeedbackEvents.impressionId, recImpressions.id),
    )
    .where(
      and(
        eq(recImpressions.userId, userId),
        eq(recImpressions.rewardFinalized, false),
        lt(recImpressions.createdAt, cutoff),
      ),
    );

  const byImpression = new Map<string, Set<RewardEvent>>();
  for (const row of rows) {
    const set = byImpression.get(row.impressionId) ?? new Set<RewardEvent>();
    set.add(row.eventType);
    byImpression.set(row.impressionId, set);
  }

  const events: (typeof recFeedbackEvents.$inferInsert)[] = [];
  for (const [impressionId, types] of byImpression) {
    if (!isAbandonedRead([...types])) {
      continue;
    }
    events.push({
      impressionId,
      userId,
      eventType: "read_abandoned",
      occurredAt: now,
    });
  }

  for (const batch of chunk(events)) {
    await db.insert(recFeedbackEvents).values(batch).onConflictDoNothing();
  }
  return events.length;
}

/**
 * 観測窓を過ぎた impression の報酬を確定する（FR-F-03）。
 * 確定後は更新しない — 学習中に過去のラベルが動くと再現性が消える。
 */
async function finalizeRewards(userId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - REWARD_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({
      impressionId: recImpressions.id,
      eventType: recFeedbackEvents.eventType,
    })
    .from(recImpressions)
    .leftJoin(
      recFeedbackEvents,
      eq(recFeedbackEvents.impressionId, recImpressions.id),
    )
    .where(
      and(
        eq(recImpressions.userId, userId),
        eq(recImpressions.rewardFinalized, false),
        eq(recImpressions.shown, true),
        lt(recImpressions.createdAt, cutoff),
      ),
    );

  const byImpression = new Map<string, RewardEvent[]>();
  for (const row of rows) {
    const list = byImpression.get(row.impressionId) ?? [];
    if (row.eventType) {
      list.push(row.eventType);
    }
    byImpression.set(row.impressionId, list);
  }

  for (const [impressionId, events] of byImpression) {
    await db
      .update(recImpressions)
      .set({ rewardFinalized: true, rewardValue: computeReward(events) })
      .where(eq(recImpressions.id, impressionId));
  }
  return byImpression.size;
}

/**
 * ドメインとクラスタのカウントを実ログから引き直す（FR-L-03 / FR-L-03b）。
 *
 * 差分更新ではなく毎回集計し直している。差分にすると、イベントの取り消しや
 * 再提示でカウントが少しずつずれ、**ずれたことに誰も気づけない**。
 * 1 人ぶんのログなら全件集計しても一瞬で終わる。
 */
async function refreshCounters(userId: string): Promise<number> {
  // examined のものだけを分母にする（§6.3）。提示数を分母にすると、忙しくて
  // 見なかった週にドメインの評価が不当に下がる。
  const examined = await db
    .select({
      impressionId: recImpressions.id,
      domainId: recImpressions.domainId,
      clusterId: recCandidates.clusterId,
    })
    .from(recImpressions)
    .innerJoin(recCandidates, eq(recCandidates.id, recImpressions.candidateId))
    .where(
      and(eq(recImpressions.userId, userId), eq(recImpressions.examined, true)),
    );

  const positives = await impressionIdsWithEvents(userId, [
    "saved",
    "liked",
    "favourited",
    "highlighted",
    "read_full",
  ]);
  // クラスタの負例は「興味なし」だけ。`read_abandoned` は意図的に入れない
  // — クラスタのカウントは整数で重みを付けられないので、足すと推測に
  // すぎない空振りが、明示的に押された「興味なし」と同じ重さになる。
  // 弱い負例として扱いたい場所は重みを掛けられる profiles.ts のほう。
  const dismissals = await impressionIdsWithEvents(userId, ["dismissed"]);

  const domainStats = new Map<string, { examined: number; positive: number }>();
  const clusterStats = new Map<
    string,
    { positive: number; negative: number }
  >();

  for (const row of examined) {
    if (row.domainId) {
      const stat = domainStats.get(row.domainId) ?? {
        examined: 0,
        positive: 0,
      };
      stat.examined++;
      if (positives.has(row.impressionId)) {
        stat.positive++;
      }
      domainStats.set(row.domainId, stat);
    }
    if (row.clusterId) {
      const stat = clusterStats.get(row.clusterId) ?? {
        positive: 0,
        negative: 0,
      };
      if (positives.has(row.impressionId)) {
        stat.positive++;
      }
      // 「興味なし」だけを負例に数える。examined 未操作は負例ではない。
      if (dismissals.has(row.impressionId)) {
        stat.negative++;
      }
      clusterStats.set(row.clusterId, stat);
    }
  }

  for (const [domainId, stat] of domainStats) {
    await db
      .update(recDomains)
      .set({
        examinedCount: stat.examined,
        positiveCount: stat.positive,
        betaAlpha: 1 + stat.positive,
        betaBeta: 4 + Math.max(0, stat.examined - stat.positive),
      })
      .where(eq(recDomains.id, domainId));
  }

  for (const [clusterId, stat] of clusterStats) {
    await db
      .update(recClusters)
      .set({ positiveCount: stat.positive, negativeCount: stat.negative })
      .where(eq(recClusters.id, clusterId));
  }

  logger.debug(
    `[recommender][reward] seats=${serverConfig.recommender.domainSeats}, refreshed ${domainStats.size} domains and ${clusterStats.size} clusters`,
  );
  return domainStats.size;
}

/**
 * 指定したイベントを持つ impression の id 集合。
 *
 * 相関サブクエリで数えると、条件が噛み合わなくても 0 が返るだけで
 * **エラーにならない**。事後分布が黙って事前値に張り付くので、素直に
 * 集合を引いて JS で突き合わせる。1 人ぶんのログなら全件でも一瞬で終わる。
 */
async function impressionIdsWithEvents(
  userId: string,
  eventTypes: RewardEvent[],
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ impressionId: recFeedbackEvents.impressionId })
    .from(recFeedbackEvents)
    .where(
      and(
        eq(recFeedbackEvents.userId, userId),
        inArray(recFeedbackEvents.eventType, eventTypes),
      ),
    );
  return new Set(rows.map((r) => r.impressionId));
}

/**
 * 未観測だった Briefing の上位 5 件を、翌日 1 回だけ再提示の対象にする
 * （§6.3）。
 *
 * **新しい impression として記録する**必要があるので、ここでは候補を
 * `active` に戻すだけにして、実際の提示は rankWorker に任せる。元の
 * impression は未ラベルのまま残す。
 */
export async function requeueUnobserved(
  userId: string,
  now: Date,
): Promise<number> {
  const yesterday = localDateString(new Date(now.getTime() - 86_400_000));
  const briefings = await db
    .select({ id: recBriefings.id })
    .from(recBriefings)
    .where(
      and(
        eq(recBriefings.userId, userId),
        eq(recBriefings.briefingDate, yesterday),
        eq(recBriefings.observationState, "unobserved"),
      ),
    );
  if (briefings.length === 0) {
    return 0;
  }

  const top = await db
    .select({ candidateId: recImpressions.candidateId })
    .from(recImpressions)
    .where(
      and(
        eq(recImpressions.briefingId, briefings[0].id),
        eq(recImpressions.shown, true),
      ),
    )
    .orderBy(recImpressions.rank)
    .limit(5);

  const ids = top.map((t) => t.candidateId);
  if (ids.length === 0) {
    return 0;
  }

  // 期限が切れていても、再提示のぶんだけ 1 日延ばす。
  await db
    .update(recCandidates)
    .set({
      status: "active",
      expiresAt: new Date(now.getTime() + 86_400_000),
    })
    .where(
      and(
        inArray(recCandidates.id, ids),
        eq(recCandidates.userId, userId),
        sql`${recCandidates.bookmarkId} is null`,
      ),
    );
  return ids.length;
}
