import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  bookmarkLinks,
  bookmarks,
  highlights,
  recCandidates,
  recDomains,
  recImpressions,
  userReadingProgress,
} from "@karakeep/db/schema";
import { normalizeTitleHash, normalizeUrl } from "@karakeep/recommender";
import { RecommenderEmbedQueue } from "@karakeep/shared-server";
import logger from "@karakeep/shared/logger";

import { chunk, IN_CLAUSE_CHUNK } from "./shared";

/** 1 回の実行で取り込むブックマークの上限。 */
const DEFAULT_LIMIT = 2000;

export interface BootstrapResult {
  scanned: number;
  imported: number;
  positives: number;
}

/**
 * 既存ブックマークを候補プールへ取り込む（FR-F-04）。
 *
 * **コールドスタートの解消がこの機能の最大の利点**で、それを実現するのが
 * ここ。既存のブックマーク・お気に入り・ハイライト・読了進捗が、初日から
 * プロフィールの材料になる。
 *
 * 設計から 1 点動かして、`recCandidates` に `origin='bootstrap'` /
 * `status='promoted'` として入れる。プロフィール重心の計算が候補も
 * ブックマークも同じ 1 本のクエリで済み、埋め込みの持ち方も 1 通りになる。
 *
 * ブートストラップの impression は `source='bootstrap'` で、
 * **`examined` の分母にもペア生成にも入らない**（提示されていないため）。
 * 正例のカウントにだけ効く。
 */
export async function runBootstrap(
  userId: string,
  limit: number | undefined,
  jobId: string,
): Promise<BootstrapResult> {
  const now = new Date();
  const rows = await db
    .select({
      bookmarkId: bookmarks.id,
      url: bookmarkLinks.url,
      title: bookmarkLinks.title,
      description: bookmarkLinks.description,
      author: bookmarkLinks.author,
      publishedAt: bookmarkLinks.datePublished,
      summary: bookmarks.summary,
      favourited: bookmarks.favourited,
      createdAt: bookmarks.createdAt,
    })
    .from(bookmarks)
    .innerJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt))
    .limit(limit ?? DEFAULT_LIMIT);

  if (rows.length === 0) {
    return { scanned: 0, imported: 0, positives: 0 };
  }

  const positiveIds = await loadPositiveBookmarkIds(
    userId,
    rows.map((r) => r.bookmarkId),
  );

  const domainIds = await ensureDomains(
    userId,
    rows
      .map((r) => normalizeUrl(r.url)?.domain)
      .filter((d): d is string => !!d),
    now,
  );

  const values = rows.flatMap((row) => {
    const normalized = normalizeUrl(row.url);
    if (!normalized) {
      return [];
    }
    return [
      {
        userId,
        domainId: domainIds.get(normalized.domain) ?? null,
        origin: "bootstrap" as const,
        url: row.url,
        canonicalUrl: normalized.canonicalUrl,
        urlHash: normalized.urlHash,
        titleHash: normalizeTitleHash(row.title),
        title: row.title,
        summary: row.summary ?? row.description,
        contentExcerpt: null,
        author: row.author,
        publishedAt: row.publishedAt,
        fetchedAt: row.createdAt,
        // 既にブックマークになっているので、ランキングの対象外。
        status: "promoted" as const,
        bookmarkId: row.bookmarkId,
      },
    ];
  });

  let imported = 0;
  const importedByBookmark = new Map<string, string>();
  for (const batch of chunk(values)) {
    const inserted = await db
      .insert(recCandidates)
      .values(batch)
      // 既に取り込み済み、または同じ URL の候補が居る場合は何もしない。
      .onConflictDoNothing()
      .returning({
        id: recCandidates.id,
        bookmarkId: recCandidates.bookmarkId,
      });
    for (const row of inserted) {
      if (row.bookmarkId) {
        importedByBookmark.set(row.bookmarkId, row.id);
      }
    }
    imported += inserted.length;
  }

  const positives = await writeBootstrapImpressions(
    userId,
    importedByBookmark,
    positiveIds,
    now,
  );

  if (imported > 0) {
    await RecommenderEmbedQueue.enqueue({ userId }, { groupId: userId });
  }

  logger.info(
    `[recommender][bootstrap][${jobId}] scanned ${rows.length}, imported ${imported}, ${positives} positives`,
  );
  return { scanned: rows.length, imported, positives };
}

/** お気に入り・ハイライトあり・読了 60% 以上を正例とみなす。 */
async function loadPositiveBookmarkIds(
  userId: string,
  bookmarkIds: string[],
): Promise<Set<string>> {
  const positives = new Set<string>();
  for (const batch of chunk(bookmarkIds, IN_CLAUSE_CHUNK)) {
    const favourited = await db
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.userId, userId),
          eq(bookmarks.favourited, true),
          inArray(bookmarks.id, batch),
        ),
      );
    for (const row of favourited) {
      positives.add(row.id);
    }

    const highlighted = await db
      .selectDistinct({ id: highlights.bookmarkId })
      .from(highlights)
      .where(
        and(
          eq(highlights.userId, userId),
          inArray(highlights.bookmarkId, batch),
        ),
      );
    for (const row of highlighted) {
      positives.add(row.id);
    }

    const read = await db
      .select({
        id: userReadingProgress.bookmarkId,
        percent: userReadingProgress.readingProgressPercent,
      })
      .from(userReadingProgress)
      .where(
        and(
          eq(userReadingProgress.userId, userId),
          inArray(userReadingProgress.bookmarkId, batch),
        ),
      );
    for (const row of read) {
      if ((row.percent ?? 0) >= 60) {
        positives.add(row.id);
      }
    }
  }
  return positives;
}

/**
 * 正例のブックマークに `source='bootstrap'` の impression を付ける。
 *
 * `briefingId` は null、`shown` と `examined` は false のまま。提示されて
 * いないので、指標の分母にもペア生成にも入らない。**プロフィール構築専用**。
 */
async function writeBootstrapImpressions(
  userId: string,
  importedByBookmark: Map<string, string>,
  positiveIds: Set<string>,
  now: Date,
): Promise<number> {
  const rows = [...importedByBookmark.entries()]
    .filter(([bookmarkId]) => positiveIds.has(bookmarkId))
    .map(([, candidateId]) => ({
      userId,
      briefingId: null,
      candidateId,
      source: "bootstrap" as const,
      shown: false,
      examined: false,
      rewardFinalized: true,
      rewardValue: 1,
      createdAt: now,
    }));

  for (const batch of chunk(rows)) {
    await db.insert(recImpressions).values(batch).onConflictDoNothing();
  }
  return rows.length;
}

async function ensureDomains(
  userId: string,
  domains: string[],
  now: Date,
): Promise<Map<string, string>> {
  const unique = [...new Set(domains)];
  const ids = new Map<string, string>();
  if (unique.length === 0) {
    return ids;
  }

  for (const batch of chunk(unique, IN_CLAUSE_CHUNK)) {
    const rows = await db
      .select({ id: recDomains.id, domain: recDomains.domain })
      .from(recDomains)
      .where(
        and(eq(recDomains.userId, userId), inArray(recDomains.domain, batch)),
      );
    for (const row of rows) {
      ids.set(row.domain, row.id);
    }
  }

  const missing = unique.filter((d) => !ids.has(d));
  for (const batch of chunk(missing)) {
    const inserted = await db
      .insert(recDomains)
      .values(
        batch.map((domain) => ({
          userId,
          domain,
          status: "discovered" as const,
          firstSeenAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: recDomains.id, domain: recDomains.domain });
    for (const row of inserted) {
      ids.set(row.domain, row.id);
    }
  }
  return ids;
}
