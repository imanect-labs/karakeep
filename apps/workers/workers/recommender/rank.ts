import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  recBriefings,
  recCandidates,
  recDomains,
  recFeedbackEvents,
  recImpressions,
  recSources,
} from "@karakeep/db/schema";
import type { ArmShares, RankableCandidate } from "@karakeep/recommender";
import {
  clusterPreferenceLookup,
  deserializeVector,
  explainScore,
  makeRng,
  maxSimilarity,
  mixArms,
  scoreHeuristic,
  validateShares,
} from "@karakeep/recommender";
import { RecommenderQueue } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { refreshProfiles } from "./profiles";
import {
  chunk,
  IN_CLAUSE_CHUNK,
  localDateString,
  posteriorMean,
} from "./shared";

export const MODEL_VERSION_HEURISTIC = "heuristic-v1";
export const MODEL_VERSION_FALLBACK = "fallback";

/** 提示されなかった候補も上位これだけは記録する（FR-R-05）。 */
const SHADOW_IMPRESSIONS = 100;

export interface RankResult {
  briefingId: string;
  modelVersion: string;
  shown: number;
  shadow: number;
  candidatesConsidered: number;
}

/**
 * 日次 Briefing の生成（FR-R-01〜07）。
 *
 * 失敗しても前日分は残る（NFR-08）。候補が 1 件も無い日は空の Briefing を
 * 作って、その旨を UI で出せるようにする（NFR-09）。
 */
export async function runRank(
  userId: string,
  briefingDate: string | undefined,
  jobId: string,
): Promise<RankResult> {
  const cfg = serverConfig.recommender;
  const now = new Date();
  const date = briefingDate ?? localDateString(now);
  const log = (msg: string) =>
    logger.info(`[recommender][rank][${jobId}] ${msg}`);

  const shares: ArmShares = cfg.arms;
  const sharesProblem = validateShares(shares);
  if (sharesProblem) {
    // 設定が壊れていても Briefing は出す。既定に戻して警告を残す。
    logger.error(
      `[recommender][rank][${jobId}] invalid arm shares (${sharesProblem}), falling back to defaults`,
    );
  }

  const briefingId = await upsertBriefing(userId, date, now);

  const candidates = await loadRankableCandidates(userId);
  log(`${candidates.length} active candidates`);

  if (candidates.length === 0) {
    await db
      .update(recBriefings)
      .set({
        status: "ready",
        itemCount: 0,
        generatedAt: now,
        modelVersion: MODEL_VERSION_FALLBACK,
      })
      .where(eq(recBriefings.id, briefingId));
    return {
      briefingId,
      modelVersion: MODEL_VERSION_FALLBACK,
      shown: 0,
      shadow: 0,
      candidatesConsidered: 0,
    };
  }

  const bundle = await refreshProfiles(userId);
  const lookupPreference = clusterPreferenceLookup(bundle.clusterPreferences);

  const scored = candidates.map((candidate) => {
    const embedding = candidate.embedding
      ? deserializeVector(candidate.embedding)
      : null;
    const result = scoreHeuristic(
      {
        embedding,
        publishedAt: candidate.publishedAt,
        clusterId: candidate.clusterId,
        clusterPreference: lookupPreference(candidate.clusterId),
        clusterRecentImpressions: candidate.clusterId
          ? (bundle.clusterRecentImpressions[candidate.clusterId] ?? 0)
          : 0,
        domainPosterior: posteriorMean(
          candidate.betaAlpha ?? 1,
          candidate.betaBeta ?? 4,
        ),
        maxSimilarityToLibrary:
          embedding && bundle.libraryVectors.length > 0
            ? maxSimilarity(embedding, bundle.libraryVectors)
            : 0,
      },
      bundle.profiles,
      now,
    );
    return { candidate, result };
  });

  const rankable: RankableCandidate[] = scored.map(({ candidate, result }) => ({
    id: candidate.id,
    score: result.score,
    uncertainty: result.uncertainty,
    clusterId: candidate.clusterId,
    domainId: candidate.domainId,
    isTrialDomain: candidate.domainStatus === "trial",
    profileIndependent: candidate.profileIndependent ?? false,
  }));

  // Thompson Sampling の重みサンプルは 1 Briefing につき 1 回だけ引く
  // （FR-R-03b）。学習前は乱数の種を日付で固定することが同じ役割を果たし、
  // その日の 20 件が一貫した方針で選ばれる。
  const rng = makeRng(hashSeed(`${userId}:${date}`));
  const selections = mixArms(rankable, {
    size: cfg.briefingSize,
    shares: sharesProblem ? undefined : shares,
    temperature: cfg.softmaxTemperature,
    rng,
  });

  const byId = new Map(scored.map((s) => [s.candidate.id, s]));
  await writeImpressions(
    userId,
    briefingId,
    selections,
    byId,
    bundle.hash,
    now,
  );

  const shadow = await writeShadowImpressions(
    userId,
    briefingId,
    scored,
    new Set(selections.map((s) => s.candidateId)),
    bundle.hash,
    now,
  );

  await touchSelectedDomains(selections, byId, now);

  await db
    .update(recBriefings)
    .set({
      status: "ready",
      itemCount: selections.length,
      generatedAt: now,
      modelVersion: MODEL_VERSION_HEURISTIC,
    })
    .where(eq(recBriefings.id, briefingId));

  await enqueueDigest(userId, briefingId, date, jobId);

  log(`selected ${selections.length}, logged ${shadow} unshown candidates`);
  return {
    briefingId,
    modelVersion: MODEL_VERSION_HEURISTIC,
    shown: selections.length,
    shadow,
    candidatesConsidered: candidates.length,
  };
}

/**
 * 日本語ダイジェストを別ジョブに切り出す（FR-U-13）。
 *
 * **ここで待たない。** Briefing は 05:30 に原文で出て、日本語は数分後に
 * 埋まる。ローカル LLM は 30 件で 6 分ほどかかり、落ちている日もある。
 * rank の中で回すと、その日の Briefing 自体が出なくなる。
 *
 * 投入の失敗も rank を落とさない。翌日の rank でまた投入される。
 */
async function enqueueDigest(
  userId: string,
  briefingId: string,
  date: string,
  jobId: string,
): Promise<void> {
  if (serverConfig.recommender.digest.provider === "off") {
    return;
  }
  try {
    await RecommenderQueue.enqueue(
      { type: "digest", userId, briefingId },
      {
        groupId: userId,
        // rank を手で再実行しても、同じ日のダイジェストは 1 回しか走らない。
        idempotencyKey: `rec:digest:${userId}:${date}`,
      },
    );
  } catch (e) {
    logger.error(
      `[recommender][rank][${jobId}] failed to enqueue the digest job: ${e}`,
    );
  }
}

async function upsertBriefing(
  userId: string,
  date: string,
  now: Date,
): Promise<string> {
  const existing = await db
    .select({ id: recBriefings.id })
    .from(recBriefings)
    .where(
      and(
        eq(recBriefings.userId, userId),
        eq(recBriefings.briefingDate, date),
        eq(recBriefings.slot, "morning"),
      ),
    );
  if (existing.length > 0) {
    // 同じ日に再実行された。impression を作り直すので既存を消すが、
    // **フィードバックが付いているものは残す**。
    //
    // `recFeedbackEvents.impressionId` は `onDelete: cascade` なので、
    // 無条件に消すと**ユーザの操作履歴が道連れで消える**。実際に本番で
    // rank を流し直した際、その日の viewed / clicked / liked / saved /
    // dismissed が全部消えた。dismissed が消えると negative プロフィールが
    // 作れなくなるので、学習にも直接効く。
    //
    // 反応済みの impression を残しても実害は無い。下の insert は
    // 同じ候補を選べば新しい行を作るが、`examined` と報酬の計算は
    // impression 単位で閉じているため、履歴が二重に効くことはない。
    const withFeedback = await db
      .selectDistinct({ id: recFeedbackEvents.impressionId })
      .from(recFeedbackEvents)
      .innerJoin(
        recImpressions,
        eq(recImpressions.id, recFeedbackEvents.impressionId),
      )
      .where(eq(recImpressions.briefingId, existing[0].id));
    const keep = withFeedback.map((r) => r.id);

    await db
      .delete(recImpressions)
      .where(
        keep.length > 0
          ? and(
              eq(recImpressions.briefingId, existing[0].id),
              notInArray(recImpressions.id, keep),
            )
          : eq(recImpressions.briefingId, existing[0].id),
      );
    await db
      .update(recBriefings)
      .set({ status: "generating", generatedAt: now })
      .where(eq(recBriefings.id, existing[0].id));
    return existing[0].id;
  }

  const [inserted] = await db
    .insert(recBriefings)
    .values({
      userId,
      briefingDate: date,
      slot: "morning",
      status: "generating",
    })
    .returning({ id: recBriefings.id });
  return inserted.id;
}

interface ScoredCandidate {
  candidate: Awaited<ReturnType<typeof loadRankableCandidates>>[number];
  result: ReturnType<typeof scoreHeuristic>;
}

async function loadRankableCandidates(userId: string) {
  return await db
    .select({
      id: recCandidates.id,
      publishedAt: recCandidates.publishedAt,
      clusterId: recCandidates.clusterId,
      domainId: recCandidates.domainId,
      embedding: recCandidates.embedding,
      domainStatus: recDomains.status,
      betaAlpha: recDomains.betaAlpha,
      betaBeta: recDomains.betaBeta,
      // random 枠はプロフィール非依存のソース由来から引く（FR-C-03 / FR-R-02）。
      profileIndependent: recSources.profileIndependent,
    })
    .from(recCandidates)
    .leftJoin(recDomains, eq(recDomains.id, recCandidates.domainId))
    .leftJoin(recSources, eq(recSources.id, recCandidates.sourceId))
    .where(
      and(
        eq(recCandidates.userId, userId),
        eq(recCandidates.status, "active"),
        eq(recCandidates.origin, "collected"),
        // 重複としてまとめられた候補は出さない。
        isNull(recCandidates.duplicateOfId),
      ),
    );
}

async function writeImpressions(
  userId: string,
  briefingId: string,
  selections: ReturnType<typeof mixArms>,
  byId: Map<string, ScoredCandidate>,
  profileHashValue: string,
  now: Date,
): Promise<void> {
  const rows = selections.flatMap((selection) => {
    const scored = byId.get(selection.candidateId);
    if (!scored) {
      return [];
    }
    return [
      {
        userId,
        briefingId,
        candidateId: selection.candidateId,
        domainId: scored.candidate.domainId,
        source: "briefing" as const,
        rank: selection.rank,
        arm: selection.arm,
        shown: true,
        examined: false,
        score: scored.result.score,
        uncertainty: scored.result.uncertainty,
        propensity: selection.propensity,
        modelVersion: MODEL_VERSION_HEURISTIC,
        features: {
          ...scored.result.contributions,
          rank: selection.rank,
        },
        featureSchemaVersion: MODEL_VERSION_HEURISTIC,
        profileHash: profileHashValue,
        domainStatusAtImpression: scored.candidate.domainStatus,
        domainAlpha: scored.candidate.betaAlpha,
        domainBeta: scored.candidate.betaBeta,
        shownAt: now,
      },
    ];
  });

  for (const batch of chunk(rows)) {
    await db.insert(recImpressions).values(batch).onConflictDoNothing();
  }
}

/**
 * 提示されなかった上位候補も記録する（FR-R-05 / §12）。
 * オフポリシー評価の母集団になるので、後から復元できない。
 */
async function writeShadowImpressions(
  userId: string,
  briefingId: string,
  scored: ScoredCandidate[],
  selectedIds: Set<string>,
  profileHashValue: string,
  now: Date,
): Promise<number> {
  const rows = scored
    .filter((s) => !selectedIds.has(s.candidate.id))
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, SHADOW_IMPRESSIONS)
    .map((s) => ({
      userId,
      briefingId,
      candidateId: s.candidate.id,
      domainId: s.candidate.domainId,
      source: "briefing" as const,
      rank: null,
      arm: null,
      shown: false,
      examined: false,
      score: s.result.score,
      uncertainty: s.result.uncertainty,
      // 選ばれなかったので、この候補の選出確率は記録できない。
      propensity: null,
      modelVersion: MODEL_VERSION_HEURISTIC,
      features: s.result.contributions,
      featureSchemaVersion: MODEL_VERSION_HEURISTIC,
      profileHash: profileHashValue,
      domainStatusAtImpression: s.candidate.domainStatus,
      domainAlpha: s.candidate.betaAlpha,
      domainBeta: s.candidate.betaBeta,
      shownAt: null,
      createdAt: now,
    }));

  for (const batch of chunk(rows)) {
    await db.insert(recImpressions).values(batch).onConflictDoNothing();
  }
  return rows.length;
}

/**
 * 選ばれたドメインの `lastSelectedAt` を進める。**埋没判定の分母がこれ。**
 * ここを書き忘れると、全ドメインが 60 日後に一斉降格する。
 */
async function touchSelectedDomains(
  selections: ReturnType<typeof mixArms>,
  byId: Map<string, ScoredCandidate>,
  now: Date,
): Promise<void> {
  const domainIds = new Set<string>();
  // 試用の打ち切りは「6 記事」で数える（FR-D-13）。ドメイン単位で 1 回
  // 足すと、同じ日に 2 件出た分が数えられず、試用がいつまでも終わらない。
  const trialArticleCounts = new Map<string, number>();
  for (const selection of selections) {
    const scored = byId.get(selection.candidateId);
    if (!scored?.candidate.domainId) {
      continue;
    }
    domainIds.add(scored.candidate.domainId);
    if (scored.candidate.domainStatus === "trial") {
      trialArticleCounts.set(
        scored.candidate.domainId,
        (trialArticleCounts.get(scored.candidate.domainId) ?? 0) + 1,
      );
    }
  }

  for (const batch of chunk([...domainIds], IN_CLAUSE_CHUNK)) {
    await db
      .update(recDomains)
      .set({ lastSelectedAt: now })
      .where(inArray(recDomains.id, batch));
  }
  for (const [domainId, count] of trialArticleCounts) {
    await db
      .update(recDomains)
      .set({
        trialImpressionCount: sql`${recDomains.trialImpressionCount} + ${count}`,
      })
      .where(eq(recDomains.id, domainId));
  }
}

/** UI に出す選定理由。impression の特徴量スナップショットから復元する。 */
export function explainImpression(
  features: Record<string, number> | null,
): string {
  if (!features) {
    return "候補プールから選ばれた";
  }
  return explainScore({ score: 0, uncertainty: 0, contributions: features });
}

function hashSeed(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
