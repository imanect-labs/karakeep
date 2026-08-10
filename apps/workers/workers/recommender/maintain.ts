import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  recCandidates,
  recDomains,
  recImpressions,
  recSources,
} from "@karakeep/db/schema";
import { assignFetchTiers, SEED_SOURCES } from "@karakeep/recommender";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { purgeArticleCache } from "./articleCache";
import { chunk, IN_CLAUSE_CHUNK, posteriorMean } from "./shared";

export interface MaintainResult {
  expired: number;
  purged: number;
  /** 共有キャッシュから落とした記事数。ユーザー横断なので参考値。 */
  purgedArticles: number;
  retiered: number;
  /** 追加された共通シード収集元の数（FR-C-08b）。 */
  syncedSources: number;
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
  // 共有キャッシュはユーザーに紐づかないので、誰の maintain で掃除しても同じ。
  // 冪等なので複数ユーザーで重複して走っても害はない。
  const purgedArticles = await purgeArticleCache(now, cfg.candidatePurgeDays);
  const retiered = await retierDomains(userId);
  const syncedSources = await syncSeedSources(userId);

  logger.info(
    `[recommender][maintain][${jobId}] expired ${expiredRows.length}, purged ${purged} candidates and ${purgedArticles} cached articles, retiered ${retiered} domains, synced ${syncedSources} seed sources`,
  );
  return {
    expired: expiredRows.length,
    purged,
    purgedArticles,
    retiered,
    syncedSources,
  };
}

/**
 * 共通シード（`SEED_SOURCES`）に足りない収集元を配る（FR-C-08b）。
 *
 * **なぜ maintain でやるか。** シードを配るのは `enroll` だけで、そちらは
 * 「`recSources` が 1 件でもあれば何もしない」。つまり**一度登録した人には
 * 一覧を増やしても永久に届かない**。フィードは死ぬし分野の穴も後から見つかる
 * ので、一覧は今後も変わる。そのたびに全ユーザーへ手作業で流し込むのは、
 * 忘れた瞬間に「人によって供給が違う」状態を作る ── 供給層は全員共通、という
 * 前提そのものが崩れる。
 *
 * **`name` で突き合わせて、無いものだけ足す。** 既にある行には触らない。
 * とくに `enabled = false`（FR-C-07 の連続失敗で止められた収集元）は
 * そのまま止まったままにする ── ここで復活させると、壊れた feed を毎日
 * 叩き続けることになる。
 *
 * **消しはしない。** 一覧から外した収集元が各自の手元に残るが、それは
 * 「供給層は削らない」方針と整合する。害があるものは連続失敗で自然に止まる。
 */
async function syncSeedSources(userId: string): Promise<number> {
  const existing = await db
    .select({ name: recSources.name })
    .from(recSources)
    .where(eq(recSources.userId, userId));

  const missing = selectMissingSeedSources(existing.map((row) => row.name));
  if (missing.length === 0) {
    return 0;
  }

  for (const batch of chunk(missing, IN_CLAUSE_CHUNK)) {
    await db.insert(recSources).values(
      batch.map((source) => ({
        userId,
        // domainId は付けない（FR-C-08）。enroll と同じ形で入れる。
        name: source.name,
        kind: source.kind,
        config: source.config as Record<string, unknown>,
        profileIndependent: source.profileIndependent ?? false,
      })),
    );
  }
  return missing.length;
}

/**
 * 既に持っている収集元名から、配り直すべきシードを選ぶ。
 *
 * 判定だけ切り出してある ── ここが壊れても例外にはならず、「一部の人にだけ
 * 収集元が増えない」という気づきにくい形で出るため。
 */
export function selectMissingSeedSources(
  existingNames: readonly string[],
): (typeof SEED_SOURCES)[number][] {
  // 0 件 = そもそも未登録。maintain は `recommenderUserIds()`（収集元を持つ
  // 人）にしか投入されないので通常あり得ないが、ここで配ると「画面から自分で
  // 始める」という有効化の設計を裏口から破ることになるので、明示的に弾く。
  if (existingNames.length === 0) {
    return [];
  }
  const have = new Set(existingNames);
  return SEED_SOURCES.filter((source) => !have.has(source.name));
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
