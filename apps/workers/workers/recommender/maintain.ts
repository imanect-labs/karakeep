import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import { recCandidates, recDomains, recImpressions } from "@karakeep/db/schema";
import { assignFetchTiers } from "@karakeep/recommender";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { chunk, IN_CLAUSE_CHUNK, posteriorMean } from "./shared";

export interface MaintainResult {
  expired: number;
  purged: number;
  retiered: number;
}

/**
 * 日次の後片付け（FR-C-06 / FR-D-16）。
 *
 * 候補の expire、古い候補のパージ、取得頻度の層の振り直し。
 */
export async function runMaintain(
  userId: string,
  jobId: string,
): Promise<MaintainResult> {
  const cfg = serverConfig.recommender;
  const now = new Date();

  const expiredRows = await db
    .update(recCandidates)
    .set({ status: "expired" })
    .where(
      and(
        eq(recCandidates.userId, userId),
        eq(recCandidates.status, "active"),
        lt(recCandidates.expiresAt, now),
      ),
    )
    .returning({ id: recCandidates.id });

  const purged = await purgeOldCandidates(userId, now, cfg.candidatePurgeDays);
  const retiered = await retierDomains(userId);

  logger.info(
    `[recommender][maintain][${jobId}] expired ${expiredRows.length}, purged ${purged}, retiered ${retiered} domains`,
  );
  return { expired: expiredRows.length, purged, retiered };
}

/**
 * 90 日を過ぎた expired 候補を消す。
 *
 * **提示されたことのある候補は消さない。** 要件は「ログ整合のため 90 日間は
 * 削除しない」だが、`recImpressions.candidateId` は cascade delete なので、
 * 素直に消すと学習データそのものが消える。提示された候補は候補プールの
 * 一部ではなく**ログの一部**なので、保持する。
 *
 * 提示されなかった候補（大半）はこれで消え、プールは膨らまない。
 */
async function purgeOldCandidates(
  userId: string,
  now: Date,
  purgeDays: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - purgeDays * 86_400_000);
  const impressed = db
    .select({ candidateId: recImpressions.candidateId })
    .from(recImpressions)
    .where(eq(recImpressions.userId, userId));

  const rows = await db
    .delete(recCandidates)
    .where(
      and(
        eq(recCandidates.userId, userId),
        eq(recCandidates.status, "expired"),
        lt(recCandidates.createdAt, cutoff),
        notInArray(recCandidates.id, impressed),
      ),
    )
    .returning({ id: recCandidates.id });
  return rows.length;
}

/**
 * 購読ドメインを事後平均で 3 層に振り直す（FR-D-16）。ドメインが増えても
 * クロール総量が線形に増えないようにする仕組み。
 */
async function retierDomains(userId: string): Promise<number> {
  const domains = await db
    .select({
      id: recDomains.id,
      betaAlpha: recDomains.betaAlpha,
      betaBeta: recDomains.betaBeta,
      fetchTier: recDomains.fetchTier,
    })
    .from(recDomains)
    .where(
      and(eq(recDomains.userId, userId), eq(recDomains.status, "subscribed")),
    );

  if (domains.length === 0) {
    return 0;
  }

  const tiers = assignFetchTiers(
    domains.map((d) => ({
      id: d.id,
      posteriorMean: posteriorMean(d.betaAlpha, d.betaBeta),
    })),
  );

  // 層が変わったドメインだけ更新する。毎日全行を書き換えると WAL が膨らむ。
  const byTier = new Map<string, string[]>();
  for (const domain of domains) {
    const tier = tiers.get(domain.id);
    if (!tier || tier === domain.fetchTier) {
      continue;
    }
    const list = byTier.get(tier);
    if (list) {
      list.push(domain.id);
    } else {
      byTier.set(tier, [domain.id]);
    }
  }

  let updated = 0;
  for (const [tier, ids] of byTier) {
    for (const batch of chunk(ids, IN_CLAUSE_CHUNK)) {
      await db
        .update(recDomains)
        .set({ fetchTier: tier as "daily" | "every3days" | "weekly" })
        .where(inArray(recDomains.id, batch));
      updated += batch.length;
    }
  }
  return updated;
}

/** 試用中のドメイン数。メトリクス用。 */
export async function countDomainsByStatus(
  userId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      status: recDomains.status,
      count: sql<number>`count(*)`,
    })
    .from(recDomains)
    .where(eq(recDomains.userId, userId))
    .groupBy(recDomains.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
