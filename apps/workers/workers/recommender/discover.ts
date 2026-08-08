import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  bookmarkLinks,
  bookmarks,
  highlights,
  recDomainDiscoveries,
  recDomains,
  recSources,
  userReadingProgress,
} from "@karakeep/db/schema";
import type { DiscoveredDomain, DomainState } from "@karakeep/recommender";
import {
  aggregateBookmarkDomains,
  aggregateOutboundDomains,
  CONVENTIONAL_FEED_PATHS,
  describeBookmarkEvidence,
  describeOutboundEvidence,
  discoverFeedUrls,
  domainOf,
  isAllowed,
  makeRng,
  parseRobots,
  planPromotions,
  planTrialIntake,
  rulesForUnavailableRobots,
  screenDomain,
} from "@karakeep/recommender";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import {
  chunk,
  DomainThrottle,
  IN_CLAUSE_CHUNK,
  recommenderFetchContext,
} from "./shared";

export interface DiscoverResult {
  backfilled: number;
  fromOutboundLinks: number;
  screened: number;
  feedsResolved: number;
  trialsStarted: number;
  promoted: number;
  demoted: number;
}

/** 1 回の実行で審査するドメイン数の上限。相手にも自分にも優しくする。 */
const MAX_SCREENED_PER_RUN = 20;

/** D2 の入力に使う正例ブックマークの数。 */
const MAX_POSITIVE_BOOKMARKS = 200;

/**
 * ソース発見（FR-D-01〜18）。
 *
 * Phase 1 で動かすのは D1〜D4。D1・D2 は既存データだけで完結し、追加の
 * クロールが要らないので、初日から効く。D3 だけがネットワークに出る。
 */
export async function runDiscover(
  userId: string,
  jobId: string,
): Promise<DiscoverResult> {
  const now = new Date();
  const log = (msg: string) =>
    logger.info(`[recommender][discover][${jobId}] ${msg}`);

  const backfilled = await discoverFromBookmarks(userId, now);
  const fromOutboundLinks = await discoverFromOutboundLinks(userId, now);
  log(`D1 found ${backfilled}, D2 found ${fromOutboundLinks} new domains`);

  const { screened, feedsResolved } = await screenDiscovered(
    userId,
    now,
    jobId,
  );
  log(`screened ${screened} domains, resolved ${feedsResolved} feeds`);

  const trialsStarted = await startTrials(userId, now);
  const { promoted, demoted } = await applyLifecycle(userId, now);
  log(
    `started ${trialsStarted} trials, promoted ${promoted}, demoted ${demoted}`,
  );

  return {
    backfilled,
    fromOutboundLinks,
    screened,
    feedsResolved,
    trialsStarted,
    promoted,
    demoted,
  };
}

// ---------------------------------------------------------------------------
// D1: 既存ブックマークのドメイン逆引き
// ---------------------------------------------------------------------------

/**
 * 手で保存したことがあるのに購読していないドメインを掘る（FR-D-03）。
 * **初期のソースプールがこれで埋まる**ので、コールドスタートがほぼ消える。
 */
async function discoverFromBookmarks(
  userId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({
      bookmarkId: bookmarks.id,
      url: bookmarkLinks.url,
      favourited: bookmarks.favourited,
      readingProgress: userReadingProgress.readingProgressPercent,
      highlightId: highlights.id,
    })
    .from(bookmarks)
    .innerJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .leftJoin(
      userReadingProgress,
      and(
        eq(userReadingProgress.bookmarkId, bookmarks.id),
        eq(userReadingProgress.userId, userId),
      ),
    )
    .leftJoin(highlights, eq(highlights.bookmarkId, bookmarks.id))
    .where(eq(bookmarks.userId, userId));

  // 同じブックマークがハイライトの数だけ重複して返る。id で畳む。
  const byBookmark = new Map<
    string,
    { bookmarkId: string; url: string; isPositive: boolean }
  >();
  for (const row of rows) {
    const existing = byBookmark.get(row.bookmarkId);
    const isPositive =
      row.favourited || !!row.highlightId || (row.readingProgress ?? 0) >= 60;
    if (existing) {
      existing.isPositive ||= isPositive;
    } else {
      byBookmark.set(row.bookmarkId, {
        bookmarkId: row.bookmarkId,
        url: row.url,
        isPositive,
      });
    }
  }

  return await recordDiscoveries(
    userId,
    aggregateBookmarkDomains([...byBookmark.values()]),
    "bookmark_backfill",
    describeBookmarkEvidence,
    now,
  );
}

// ---------------------------------------------------------------------------
// D2: 高評価記事の外部リンク抽出
// ---------------------------------------------------------------------------

/**
 * 正例ブックマークの `htmlContent` から外部リンクのドメインを掘る
 * （FR-D-04）。crawler が既に HTML を保存しているので**追加のクロールが
 * 要らない**。発見チャネルの中で最も費用対効果が高い。
 */
async function discoverFromOutboundLinks(
  userId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({
      bookmarkId: bookmarks.id,
      url: bookmarkLinks.url,
      html: bookmarkLinks.htmlContent,
      favourited: bookmarks.favourited,
      readingProgress: userReadingProgress.readingProgressPercent,
    })
    .from(bookmarks)
    .innerJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .leftJoin(
      userReadingProgress,
      and(
        eq(userReadingProgress.bookmarkId, bookmarks.id),
        eq(userReadingProgress.userId, userId),
      ),
    )
    .where(
      and(
        eq(bookmarks.userId, userId),
        isNotNull(bookmarkLinks.htmlContent),
        or(
          eq(bookmarks.favourited, true),
          sql`${userReadingProgress.readingProgressPercent} >= 60`,
        ),
      ),
    )
    .orderBy(desc(bookmarks.createdAt))
    .limit(MAX_POSITIVE_BOOKMARKS);

  const discovered = aggregateOutboundDomains(
    rows.map((row) => ({
      bookmarkId: row.bookmarkId,
      html: row.html ?? "",
      sourceDomain: domainOf(row.url),
      // お気に入りと読了で重みを分ける。よく読んだ記事のリンク先ほど強い。
      reward: row.favourited ? 1.2 : 0.8,
    })),
  );

  return await recordDiscoveries(
    userId,
    discovered,
    "outbound_link",
    describeOutboundEvidence,
    now,
  );
}

/**
 * 発見結果を `recDomains` と `recDomainDiscoveries` に落とす。
 *
 * 既に `rejected` / `retired` になっているドメインは復活させない
 * （FR-D-18）。証拠だけは積む — 何度も推されるようなら人間が手動で
 * 拾い直せる。
 */
async function recordDiscoveries(
  userId: string,
  discovered: DiscoveredDomain[],
  channel: "bookmark_backfill" | "outbound_link",
  describe: (d: DiscoveredDomain) => string,
  now: Date,
): Promise<number> {
  if (discovered.length === 0) {
    return 0;
  }

  const known = new Map<string, string>();
  for (const batch of chunk(
    discovered.map((d) => d.domain),
    IN_CLAUSE_CHUNK,
  )) {
    const rows = await db
      .select({ id: recDomains.id, domain: recDomains.domain })
      .from(recDomains)
      .where(
        and(eq(recDomains.userId, userId), inArray(recDomains.domain, batch)),
      );
    for (const row of rows) {
      known.set(row.domain, row.id);
    }
  }

  const missing = discovered.filter((d) => !known.has(d.domain));
  let created = 0;
  for (const batch of chunk(missing)) {
    const rows = await db
      .insert(recDomains)
      .values(
        batch.map((d) => ({
          userId,
          domain: d.domain,
          status: "discovered" as const,
          firstSeenAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: recDomains.id, domain: recDomains.domain });
    for (const row of rows) {
      known.set(row.domain, row.id);
      created++;
    }
  }

  const evidence = discovered
    .filter((d) => known.has(d.domain))
    .map((d) => ({
      domainId: known.get(d.domain)!,
      channel,
      evidenceRef: d.evidenceBookmarkIds.join(","),
      evidenceLabel: describe(d),
      weight: d.weight,
      discoveredAt: now,
    }));

  for (const batch of chunk(evidence)) {
    await db.insert(recDomainDiscoveries).values(batch);
  }
  return created;
}

// ---------------------------------------------------------------------------
// 品質ゲートと D3: フィード自動発見
// ---------------------------------------------------------------------------

async function screenDiscovered(
  userId: string,
  now: Date,
  jobId: string,
): Promise<{ screened: number; feedsResolved: number }> {
  // 発見の重みが大きい順に審査する。全部を一度に審査しない。
  const candidates = await db
    .select({
      id: recDomains.id,
      domain: recDomains.domain,
      weight: sql<number>`coalesce(sum(${recDomainDiscoveries.weight}), 0)`,
    })
    .from(recDomains)
    .leftJoin(
      recDomainDiscoveries,
      eq(recDomainDiscoveries.domainId, recDomains.id),
    )
    .where(
      and(eq(recDomains.userId, userId), eq(recDomains.status, "discovered")),
    )
    .groupBy(recDomains.id)
    .orderBy(desc(sql`coalesce(sum(${recDomainDiscoveries.weight}), 0)`))
    .limit(MAX_SCREENED_PER_RUN);

  const throttle = new DomainThrottle();
  let screened = 0;
  let feedsResolved = 0;

  for (const candidate of candidates) {
    // 1〜3 段目はネットワークに出ない。ここで落ちるものを D3 に回さない
    // のが、クロール量を抑える一番効く手。
    const verdict = screenDomain({
      domain: candidate.domain,
      // 記事の日付はこの時点では持っていないので、更新頻度の判定は
      // フィードが取れてから行う。ここではブロックリストだけが効く。
      articleDates: [now, now, now],
      now,
    });
    if (!verdict.passed) {
      await db
        .update(recDomains)
        .set({ status: "rejected", blockedReason: verdict.reason })
        .where(eq(recDomains.id, candidate.id));
      continue;
    }

    const resolved = await resolveFeed(candidate.domain, throttle, jobId);
    if (resolved.feedUrl) {
      feedsResolved++;
    }
    if (!resolved.feedUrl && !resolved.reachable) {
      // 到達できないドメインは保留にする。次の実行でまた試す。
      continue;
    }

    await db
      .update(recDomains)
      .set({
        status: "screened",
        feedUrl: resolved.feedUrl,
        scrapable: !resolved.feedUrl,
        lastCrawledAt: now,
      })
      .where(eq(recDomains.id, candidate.id));
    screened++;
  }

  return { screened, feedsResolved };
}

interface FeedResolution {
  feedUrl: string | null;
  reachable: boolean;
}

/**
 * D3: `<link rel="alternate">` と慣例パスからフィード URL を解決する
 * （FR-D-05）。ここが唯一ネットワークに出る発見チャネルなので、
 * robots.txt と間隔をきちんと守る。
 */
async function resolveFeed(
  domain: string,
  throttle: DomainThrottle,
  jobId: string,
): Promise<FeedResolution> {
  const ctx = recommenderFetchContext({ limit: 1 });
  const origin = `https://${domain}`;

  let rules;
  try {
    await throttle.wait(domain);
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": ctx.userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    rules = response.ok
      ? parseRobots(await response.text(), "karakeeprecommender")
      : rulesForUnavailableRobots(response.status);
  } catch {
    // 取得できなかった。相手の都合が分からないので今日は触らない。
    return { feedUrl: null, reachable: false };
  }

  if (!isAllowed(rules, "/")) {
    logger.debug(
      `[recommender][discover][${jobId}] ${domain} disallows crawling, skipping`,
    );
    return { feedUrl: null, reachable: false };
  }

  let html: string;
  try {
    await throttle.wait(domain);
    const response = await fetch(origin, {
      headers: { "User-Agent": ctx.userAgent },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return { feedUrl: null, reachable: false };
    }
    html = await response.text();
  } catch {
    return { feedUrl: null, reachable: false };
  }

  const declared = discoverFeedUrls(html, origin);
  if (declared.length > 0) {
    return { feedUrl: declared[0], reachable: true };
  }

  // `<link>` が無いサイト向けの慣例パス。robots.txt で拒否されている
  // パスは試さない。
  for (const path of CONVENTIONAL_FEED_PATHS) {
    if (!isAllowed(rules, path)) {
      continue;
    }
    try {
      await throttle.wait(domain);
      const response = await fetch(`${origin}${path}`, {
        headers: { "User-Agent": ctx.userAgent },
        signal: AbortSignal.timeout(15_000),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok && /xml|rss|atom/i.test(contentType)) {
        return { feedUrl: `${origin}${path}`, reachable: true };
      }
    } catch {
      // 次のパスを試す。
    }
  }

  // フィードが無くても到達はできた。スクレイプ対象として screened に
  // 上げてよい（FR-D-05）。
  return { feedUrl: null, reachable: true };
}

// ---------------------------------------------------------------------------
// 試用・昇格・降格
// ---------------------------------------------------------------------------

async function startTrials(userId: string, now: Date): Promise<number> {
  const cfg = serverConfig.recommender;
  const [screenedRows, trialCount] = await Promise.all([
    db
      .select()
      .from(recDomains)
      .where(
        and(eq(recDomains.userId, userId), eq(recDomains.status, "screened")),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(recDomains)
      .where(and(eq(recDomains.userId, userId), eq(recDomains.status, "trial")))
      .then((r) => r[0]?.count ?? 0),
  ]);

  const selected = planTrialIntake(
    screenedRows.map(toDomainState),
    trialCount,
    {
      maxTrialDomains: cfg.maxTrialDomains,
      // 日付を種にする。同じ日に 2 回走っても同じ選択になる。
      rng: makeRng(hashSeed(`${userId}:${now.toISOString().slice(0, 10)}`)),
    },
  );

  if (selected.length === 0) {
    return 0;
  }

  for (const batch of chunk(selected, IN_CLAUSE_CHUNK)) {
    await db
      .update(recDomains)
      .set({ status: "trial", trialStartedAt: now, trialImpressionCount: 0 })
      .where(inArray(recDomains.id, batch));
  }
  await ensureSourcesForDomains(userId, selected);
  return selected.length;
}

/**
 * 試用に上げたドメインを実際に収集するための `recSources` 行を作る。
 * これが無いと trial に上げても記事が 1 件も入らない。
 */
async function ensureSourcesForDomains(
  userId: string,
  domainIds: string[],
): Promise<void> {
  const domains = await db
    .select({
      id: recDomains.id,
      domain: recDomains.domain,
      feedUrl: recDomains.feedUrl,
    })
    .from(recDomains)
    .where(inArray(recDomains.id, domainIds));

  const existing = await db
    .select({ domainId: recSources.domainId })
    .from(recSources)
    .where(
      and(
        eq(recSources.userId, userId),
        inArray(recSources.domainId, domainIds),
      ),
    );
  const known = new Set(existing.map((e) => e.domainId));

  const rows = domains
    .filter((d) => !known.has(d.id) && d.feedUrl)
    .map((d) => ({
      userId,
      domainId: d.id,
      name: d.domain,
      kind: "rss" as const,
      config: { feedUrl: d.feedUrl! },
    }));

  for (const batch of chunk(rows)) {
    await db.insert(recSources).values(batch);
  }
}

async function applyLifecycle(
  userId: string,
  now: Date,
): Promise<{ promoted: number; demoted: number }> {
  const rows = await db
    .select()
    .from(recDomains)
    .where(
      and(
        eq(recDomains.userId, userId),
        inArray(recDomains.status, ["trial", "subscribed"]),
      ),
    );

  const trials = rows.filter((r) => r.status === "trial").map(toDomainState);
  const subscribed = rows
    .filter((r) => r.status === "subscribed")
    .map(toDomainState);

  const plan = planPromotions(trials, subscribed, {
    seats: serverConfig.recommender.domainSeats,
    now,
  });

  for (const promotion of plan.promotions) {
    await db
      .update(recDomains)
      .set({ status: "subscribed", promotedAt: now, fetchTier: "every3days" })
      .where(eq(recDomains.id, promotion.domainId));
  }
  for (const demotion of plan.demotions) {
    await db
      .update(recDomains)
      .set({
        status: "dormant",
        demotedAt: now,
        blockedReason: demotion.reason,
      })
      .where(eq(recDomains.id, demotion.domainId));
    // 降格したドメインのソースは止める。候補が入り続けないように。
    await db
      .update(recSources)
      .set({ enabled: false })
      .where(eq(recSources.domainId, demotion.domainId));
  }

  return { promoted: plan.promotions.length, demoted: plan.demotions.length };
}

function toDomainState(row: typeof recDomains.$inferSelect): DomainState {
  return {
    id: row.id,
    status: row.status,
    examinedCount: row.examinedCount,
    positiveCount: row.positiveCount,
    // 直近の窓は Phase 1 では通算値で代用する。impression のログが貯まったら
    // rewardJoinWorker が正しい窓の値を書き込む。
    recentExaminedCount: row.examinedCount,
    recentPositiveCount: row.positiveCount,
    trialStartedAt: row.trialStartedAt,
    trialImpressionCount: row.trialImpressionCount,
    lastSelectedAt: row.lastSelectedAt,
    lastArticleAt: row.lastArticleAt,
    promotedAt: row.promotedAt,
    manualDecision: row.manualDecision,
  };
}

function hashSeed(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
