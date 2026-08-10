import { and, eq, inArray } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  recCandidates,
  recDomainDiscoveries,
  recDomains,
  recSources,
} from "@karakeep/db/schema";
import type { CollectedItem, RecSourceKind } from "@karakeep/recommender";
import {
  allocateIntake,
  getSourceAdapter,
  isDueForFetch,
  normalizeTitleHash,
  normalizeUrl,
} from "@karakeep/recommender";
import { RecommenderEmbedQueue } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import {
  chunk,
  DomainThrottle,
  IN_CLAUSE_CHUNK,
  posteriorMean,
  recommenderFetchContext,
} from "./shared";

/** 5 回続けて失敗したソースは無効化する（FR-C-07）。 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** ドメインの標本として使うソース種別（D4 / FR-D-06）。 */
const AGGREGATOR_KINDS = new Set<RecSourceKind>(["hn", "github"]);

type SourceRow = typeof recSources.$inferSelect;
type DomainRow = typeof recDomains.$inferSelect;

interface FetchedSource {
  source: SourceRow;
  domain: DomainRow | null;
  items: CollectedItem[];
}

interface PendingCandidate {
  sourceId: string;
  articleDomain: string;
  canonicalUrl: string;
  urlHash: string;
  titleHash: string | null;
  item: CollectedItem;
}

export interface CollectResult {
  sourcesTried: number;
  sourcesFailed: number;
  fetched: number;
  inserted: number;
  skippedDuplicates: number;
  newDomains: number;
}

export interface CollectOptions {
  /**
   * 取り込んだ候補の埋め込みを `RecommenderEmbedQueue` へ投入するか。
   *
   * **呼び出し側が続けて自分で `runEmbed` を回すなら `false` にする。**
   * 既定は `true`（日次 cron の経路）。
   */
  enqueueEmbed?: boolean;
}

/**
 * 候補収集（FR-C-01〜07）。
 *
 * ブックマークは作らない。候補プールに入れるだけで、ブックマーク化は
 * ユーザーが「保存」を押した時点で既存フローに渡す。
 */
export async function runCollect(
  userId: string,
  jobId: string,
  { enqueueEmbed = true }: CollectOptions = {},
): Promise<CollectResult> {
  const cfg = serverConfig.recommender;
  const now = new Date();
  const log = (msg: string) =>
    logger.info(`[recommender][collect][${jobId}] ${msg}`);

  const sources = await db.query.recSources.findMany({
    where: and(eq(recSources.userId, userId), eq(recSources.enabled, true)),
    with: { domain: true },
  });

  const due = sources.filter((s) => isSourceDue(s, s.domain ?? null, now));
  log(`${due.length}/${sources.length} sources are due`);

  const throttle = new DomainThrottle();
  const fetched: FetchedSource[] = [];
  let sourcesFailed = 0;

  for (const source of due) {
    const domain = source.domain ?? null;
    if (domain) {
      await throttle.wait(domain.domain);
    }
    try {
      const items = await fetchSource(source, cfg.perSourceFetchLimit);
      fetched.push({ source, domain, items });
      await markSourceSuccess(source.id, now);
    } catch (e) {
      // 1 ソースの失敗で収集全体を止めない（FR-C-07）。
      sourcesFailed++;
      logger.warn(
        `[recommender][collect][${jobId}] source ${source.name} (${source.kind}) failed: ${e}`,
      );
      await markSourceFailure(source, String(e), now);
    }
  }

  // `pending[i]` は `fetched[i]` に対応する。以降この対応を崩さない。
  const pending = toPendingCandidates(fetched);
  const totalFetched = pending.reduce((sum, p) => sum + p.length, 0);
  log(`fetched ${totalFetched} items from ${fetched.length} sources`);

  // 記事のドメイン行を先に用意する。RSS ならソースと同じドメインだが、
  // アグリゲータ経由の記事はどのドメインから来るか分からない。ここで
  // `discovered` として登録することが D4（ドメイン標本）そのものになる。
  const flat = pending.flat();
  const { domainIds, created } = await ensureDomains(
    userId,
    [...new Set(flat.map((p) => p.articleDomain))],
    now,
  );

  const allocation = allocateIntake(
    fetched.map(({ source, domain }, i) => ({
      id: source.id,
      weight: domain
        ? posteriorMean(domain.betaAlpha, domain.betaBeta)
        : // ドメインを持たない全体ソース（HN / arXiv 等）は事前値で扱う。
          0.2,
      available: pending[i].length,
      profileIndependent: source.profileIndependent,
    })),
    { totalCap: cfg.dailyIntakeCap },
  );

  const selected = selectWithinBudget(pending, allocation);
  const deduped = await dropKnownDuplicates(userId, selected);
  log(
    `selected ${selected.length} within the ${cfg.dailyIntakeCap} cap, ${
      selected.length - deduped.length
    } were already known`,
  );

  const inserted = await insertCandidates(
    userId,
    deduped,
    domainIds,
    now,
    cfg.candidateTtlDays,
  );
  await recordAggregatorDiscoveries(fetched, deduped, domainIds, now);
  await touchDomains(fetched, now);

  // 呼び出し側が自分で `runEmbed` を回すなら投入しない。**投入すると二重に
  // 埋め込む。** `runEmbed` は `embeddingStatus='pending'` を掴むだけで
  // 取り合いの調停をしないので、2 つのランナーがほぼ同時に走ると同じ候補を
  // 両方が処理する。2026-08-10 の enroll 実測では、直接呼び出しが 793 件を
  // 掴んだ 4 秒後にキュー側が残り 704 件を掴み、**704 件を二重に埋め込んで
  // いた**（9 分のうちおよそ半分が無駄）。
  if (inserted > 0 && enqueueEmbed) {
    await RecommenderEmbedQueue.enqueue({ userId }, { groupId: userId });
  }

  return {
    sourcesTried: due.length,
    sourcesFailed,
    fetched: totalFetched,
    inserted,
    skippedDuplicates: selected.length - deduped.length,
    newDomains: created,
  };
}

function isSourceDue(
  source: SourceRow,
  domain: DomainRow | null,
  now: Date,
): boolean {
  if (!domain) {
    // ドメインに紐づかない全体ソース（HN / arXiv / GitHub）は毎日取る。
    return isDueForFetch("daily", source.lastFetchedAt, now);
  }
  if (domain.status !== "subscribed" && domain.status !== "trial") {
    return false;
  }
  return isDueForFetch(domain.fetchTier, domain.lastCrawledAt, now);
}

async function fetchSource(
  source: SourceRow,
  limit: number,
): Promise<CollectedItem[]> {
  const adapter = getSourceAdapter(source.kind);
  if (!adapter) {
    // 未実装の種別はスキップする。例外にしない。
    return [];
  }
  const ctx = recommenderFetchContext({
    limit,
    // 前回「成功した」取得時刻を使う。失敗した試行で時計を進めると、
    // 失敗している間に流れた記事を取りこぼす。
    since: source.lastSuccessfulFetchAt,
  });
  return await adapter.fetchItems((source.config ?? {}) as never, ctx);
}

/** ソースごとの取得結果を、URL 正規化まで済ませた候補に変換する。 */
function toPendingCandidates(fetched: FetchedSource[]): PendingCandidate[][] {
  return fetched.map(({ source, items }) => {
    const out: PendingCandidate[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const normalized = normalizeUrl(item.url);
      if (!normalized) {
        continue;
      }
      // 同一ソース内の重複はここで潰す。フィードが同じ記事を 2 回出すことがある。
      if (seen.has(normalized.urlHash)) {
        continue;
      }
      seen.add(normalized.urlHash);
      out.push({
        sourceId: source.id,
        articleDomain: normalized.domain,
        canonicalUrl: normalized.canonicalUrl,
        urlHash: normalized.urlHash,
        titleHash: normalizeTitleHash(item.title),
        item,
      });
    }
    // 新しい順。上限で切られるときに古い記事が残らないようにする。
    out.sort(
      (a, b) =>
        (b.item.publishedAt?.getTime() ?? 0) -
        (a.item.publishedAt?.getTime() ?? 0),
    );
    return out;
  });
}

async function ensureDomains(
  userId: string,
  domains: string[],
  now: Date,
): Promise<{ domainIds: Map<string, string>; created: number }> {
  const domainIds = new Map<string, string>();
  if (domains.length === 0) {
    return { domainIds, created: 0 };
  }

  for (const batch of chunk(domains, IN_CLAUSE_CHUNK)) {
    const rows = await db
      .select({ id: recDomains.id, domain: recDomains.domain })
      .from(recDomains)
      .where(
        and(eq(recDomains.userId, userId), inArray(recDomains.domain, batch)),
      );
    for (const row of rows) {
      domainIds.set(row.domain, row.id);
    }
  }

  const missing = domains.filter((d) => !domainIds.has(d));
  let created = 0;
  for (const batch of chunk(missing)) {
    const rows = await db
      .insert(recDomains)
      .values(
        batch.map((domain) => ({
          userId,
          domain,
          status: "discovered" as const,
          firstSeenAt: now,
        })),
      )
      // 同時に走った別ジョブが先に入れていても落ちない。
      .onConflictDoNothing()
      .returning({ id: recDomains.id, domain: recDomains.domain });
    for (const row of rows) {
      domainIds.set(row.domain, row.id);
      created++;
    }
  }

  // onConflictDoNothing で返ってこなかったぶんを引き直す。
  const stillMissing = domains.filter((d) => !domainIds.has(d));
  for (const batch of chunk(stillMissing, IN_CLAUSE_CHUNK)) {
    const rows = await db
      .select({ id: recDomains.id, domain: recDomains.domain })
      .from(recDomains)
      .where(
        and(eq(recDomains.userId, userId), inArray(recDomains.domain, batch)),
      );
    for (const row of rows) {
      domainIds.set(row.domain, row.id);
    }
  }

  return { domainIds, created };
}

function selectWithinBudget(
  pending: PendingCandidate[][],
  allocation: Map<string, number>,
): PendingCandidate[] {
  const selected: PendingCandidate[] = [];
  for (const group of pending) {
    if (group.length === 0) {
      continue;
    }
    const quota = allocation.get(group[0].sourceId) ?? 0;
    selected.push(...group.slice(0, quota));
  }
  return selected;
}

/**
 * すでに候補プールにある記事を落とす（FR-C-05 の 1 段目と 2 段目）。
 *
 * 埋め込み近傍による判定は embedWorker 側でやる。ここで見るのは URL と
 * タイトルのハッシュだけ。プール全体を読み込まず、今日の分のハッシュで
 * 引き当てる。
 */
async function dropKnownDuplicates(
  userId: string,
  candidates: PendingCandidate[],
): Promise<PendingCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }

  const knownUrlHashes = new Set<string>();
  const knownTitleHashes = new Set<string>();

  for (const batch of chunk(
    candidates.map((c) => c.urlHash),
    IN_CLAUSE_CHUNK,
  )) {
    const rows = await db
      .select({ urlHash: recCandidates.urlHash })
      .from(recCandidates)
      .where(
        and(
          eq(recCandidates.userId, userId),
          inArray(recCandidates.urlHash, batch),
        ),
      );
    for (const row of rows) {
      knownUrlHashes.add(row.urlHash);
    }
  }

  const titleHashes = candidates
    .map((c) => c.titleHash)
    .filter((h): h is string => !!h);
  for (const batch of chunk(titleHashes, IN_CLAUSE_CHUNK)) {
    const rows = await db
      .select({ titleHash: recCandidates.titleHash })
      .from(recCandidates)
      .where(
        and(
          eq(recCandidates.userId, userId),
          inArray(recCandidates.titleHash, batch),
        ),
      );
    for (const row of rows) {
      if (row.titleHash) {
        knownTitleHashes.add(row.titleHash);
      }
    }
  }

  const out: PendingCandidate[] = [];
  for (const candidate of candidates) {
    if (knownUrlHashes.has(candidate.urlHash)) {
      continue;
    }
    if (candidate.titleHash && knownTitleHashes.has(candidate.titleHash)) {
      continue;
    }
    // 同じ日に複数のソースから来た同一記事もここで 1 件に絞る。
    knownUrlHashes.add(candidate.urlHash);
    if (candidate.titleHash) {
      knownTitleHashes.add(candidate.titleHash);
    }
    out.push(candidate);
  }
  return out;
}

async function insertCandidates(
  userId: string,
  candidates: PendingCandidate[],
  domainIds: Map<string, string>,
  now: Date,
  ttlDays: number,
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
  let inserted = 0;

  for (const batch of chunk(candidates)) {
    const rows = await db
      .insert(recCandidates)
      .values(
        batch.map((c) => ({
          userId,
          sourceId: c.sourceId,
          domainId: domainIds.get(c.articleDomain) ?? null,
          origin: "collected" as const,
          url: c.item.url,
          canonicalUrl: c.canonicalUrl,
          urlHash: c.urlHash,
          titleHash: c.titleHash,
          title: c.item.title,
          summary: c.item.summary,
          contentExcerpt: c.item.contentExcerpt,
          author: c.item.author,
          publishedAt: c.item.publishedAt,
          fetchedAt: now,
          lang: c.item.lang,
          status: "active" as const,
          expiresAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: recCandidates.id });
    inserted += rows.length;
  }
  return inserted;
}

/**
 * D4: アグリゲータから来た記事のドメインを「発見」として記録する
 * （FR-D-06）。記事そのものは玉石混交でも、上位に上がるドメインの分布は
 * 良質な独立ブログの標本として優秀。
 *
 * 品質ゲートと昇格判定は discoverWorker 側の仕事で、ここは証拠を残すだけ。
 */
async function recordAggregatorDiscoveries(
  fetched: FetchedSource[],
  candidates: PendingCandidate[],
  domainIds: Map<string, string>,
  now: Date,
): Promise<void> {
  const aggregatorSourceIds = new Set(
    fetched
      .filter(({ source }) => AGGREGATOR_KINDS.has(source.kind))
      .map(({ source }) => source.id),
  );
  if (aggregatorSourceIds.size === 0) {
    return;
  }

  const sourceNames = new Map(
    fetched.map(({ source }) => [source.id, source.name]),
  );
  const seen = new Set<string>();
  const rows: (typeof recDomainDiscoveries.$inferInsert)[] = [];

  for (const candidate of candidates) {
    if (!aggregatorSourceIds.has(candidate.sourceId)) {
      continue;
    }
    const domainId = domainIds.get(candidate.articleDomain);
    if (!domainId || seen.has(domainId)) {
      continue;
    }
    seen.add(domainId);
    rows.push({
      domainId,
      channel: "aggregator",
      evidenceRef: candidate.sourceId,
      evidenceLabel: `${sourceNames.get(candidate.sourceId) ?? "aggregator"} に載っていました`,
      weight: 1,
      discoveredAt: now,
    });
  }

  for (const batch of chunk(rows)) {
    await db.insert(recDomainDiscoveries).values(batch);
  }
}

async function touchDomains(
  fetched: FetchedSource[],
  now: Date,
): Promise<void> {
  const domainIds = [
    ...new Set(
      fetched
        .map(({ domain }) => domain?.id)
        .filter((id): id is string => !!id),
    ),
  ];
  for (const batch of chunk(domainIds, IN_CLAUSE_CHUNK)) {
    await db
      .update(recDomains)
      .set({ lastCrawledAt: now })
      .where(inArray(recDomains.id, batch));
  }
}

async function markSourceSuccess(sourceId: string, now: Date): Promise<void> {
  await db
    .update(recSources)
    .set({
      lastFetchedAt: now,
      lastSuccessfulFetchAt: now,
      consecutiveFailures: 0,
      lastError: null,
    })
    .where(eq(recSources.id, sourceId));
}

async function markSourceFailure(
  source: SourceRow,
  error: string,
  now: Date,
): Promise<void> {
  const failures = source.consecutiveFailures + 1;
  await db
    .update(recSources)
    .set({
      lastFetchedAt: now,
      consecutiveFailures: failures,
      lastError: error.slice(0, 500),
      enabled: failures < MAX_CONSECUTIVE_FAILURES,
    })
    .where(eq(recSources.id, source.id));

  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    logger.error(
      `[recommender][collect] disabling source ${source.name} after ${failures} consecutive failures: ${error}`,
    );
  }
}
