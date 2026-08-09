import { inArray, sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import { recArticleCache } from "@karakeep/db/schema";

import { chunk, IN_CLAUSE_CHUNK } from "./shared";

/**
 * 記事単位の共有キャッシュ（FR-S-06）へのアクセス。
 *
 * 日本語ダイジェストも埋め込みも「その記事が何であるか」だけで決まり、誰が
 * 読むかに依存しない。`recCandidates` は `(userId, urlHash)` 一意なので、
 * 同じ収集元を使う 5 人は同じ記事を 5 回訳し 5 回埋め込むことになる。
 * ローカル LLM は concurrency 1 で回しているので、そこが朝の律速になる。
 *
 * cache-aside。読み出しの正本は `recCandidates` のままで、ランキングも UI も
 * この表を知らない。
 */

export interface ArticleCacheRow {
  urlHash: string;
  titleJa: string | null;
  summaryJa: string | null;
  digestModelId: string | null;
  embedding: Buffer | null;
  embeddingModelId: string | null;
  embeddingDimensions: number | null;
}

/**
 * ダイジェストのヒット判定。`digest.ts` の候補側ガードと同じ規則。
 *
 * `titleJa` が空のものは失敗とみなして書いていないので、非 null であることが
 * そのまま「使える訳題がある」を意味する。
 */
export function isDigestCacheHit(
  row: ArticleCacheRow | undefined,
  modelId: string,
): boolean {
  if (!row?.titleJa) {
    return false;
  }
  return row.digestModelId === modelId;
}

/**
 * 埋め込みのヒット判定。
 *
 * **次元を別に見る必要がある。** `OllamaEmbeddingClient.modelId` は
 * `ollama/<model>` で `RECOMMENDER_EMBEDDING_DIMENSIONS` を含まない。次元は
 * `embedDocuments` が後から MRL 切り詰めで適用するので、768 → 512 の変更は
 * モデル ID からは見えない。モデル ID だけで判定すると、次元の違うベクトルを
 * 別ユーザーへ配ることになる。
 *
 * 次元を設定していないときはモデルが次元を決めるので、モデル ID の一致で足りる。
 */
export function isEmbeddingCacheHit(
  row: ArticleCacheRow | undefined,
  modelId: string,
  expectedDimensions: number | undefined,
): boolean {
  if (!row?.embedding || row.embeddingModelId !== modelId) {
    return false;
  }
  if (expectedDimensions === undefined) {
    return true;
  }
  return row.embeddingDimensions === expectedDimensions;
}

/** `urlHash` でまとめて引く。件数は 1 日の取り込み上限までいく。 */
export async function loadArticleCache(
  urlHashes: string[],
): Promise<Map<string, ArticleCacheRow>> {
  const byHash = new Map<string, ArticleCacheRow>();
  const unique = [...new Set(urlHashes)];
  for (const batch of chunk(unique, IN_CLAUSE_CHUNK)) {
    const rows = await db
      .select({
        urlHash: recArticleCache.urlHash,
        titleJa: recArticleCache.titleJa,
        summaryJa: recArticleCache.summaryJa,
        digestModelId: recArticleCache.digestModelId,
        embedding: recArticleCache.embedding,
        embeddingModelId: recArticleCache.embeddingModelId,
        embeddingDimensions: recArticleCache.embeddingDimensions,
      })
      .from(recArticleCache)
      .where(inArray(recArticleCache.urlHash, batch));
    for (const row of rows) {
      byHash.set(row.urlHash, row);
    }
  }
  return byHash;
}

export async function putDigest(entry: {
  urlHash: string;
  canonicalUrl: string;
  titleJa: string;
  summaryJa: string | null;
  modelId: string;
  now: Date;
}): Promise<void> {
  await db
    .insert(recArticleCache)
    .values({
      urlHash: entry.urlHash,
      canonicalUrl: entry.canonicalUrl,
      titleJa: entry.titleJa,
      summaryJa: entry.summaryJa,
      digestModelId: entry.modelId,
      digestedAt: entry.now,
      lastUsedAt: entry.now,
    })
    .onConflictDoUpdate({
      target: recArticleCache.urlHash,
      // モデルを差し替えたら上書きする。古い行を溜めない。
      set: {
        titleJa: entry.titleJa,
        summaryJa: entry.summaryJa,
        digestModelId: entry.modelId,
        digestedAt: entry.now,
        lastUsedAt: entry.now,
      },
    });
}

export async function putEmbedding(entry: {
  urlHash: string;
  canonicalUrl: string;
  embedding: Buffer;
  modelId: string;
  dimensions: number;
  now: Date;
}): Promise<void> {
  await db
    .insert(recArticleCache)
    .values({
      urlHash: entry.urlHash,
      canonicalUrl: entry.canonicalUrl,
      embedding: entry.embedding,
      embeddingModelId: entry.modelId,
      embeddingDimensions: entry.dimensions,
      embeddedAt: entry.now,
      lastUsedAt: entry.now,
    })
    .onConflictDoUpdate({
      target: recArticleCache.urlHash,
      set: {
        embedding: entry.embedding,
        embeddingModelId: entry.modelId,
        embeddingDimensions: entry.dimensions,
        embeddedAt: entry.now,
        lastUsedAt: entry.now,
      },
    });
}

/** ヒットした行の最終利用時刻を進める。maintain の掃除がこれを見る。 */
export async function touchArticleCache(
  urlHashes: string[],
  now: Date,
): Promise<void> {
  if (urlHashes.length === 0) {
    return;
  }
  for (const batch of chunk([...new Set(urlHashes)], IN_CLAUSE_CHUNK)) {
    await db
      .update(recArticleCache)
      .set({ lastUsedAt: now })
      .where(inArray(recArticleCache.urlHash, batch));
  }
}

/**
 * 誰も参照しなくなった記事を落とす（`maintain` から呼ぶ）。
 *
 * 無いと 1 日 5MB 程度で無限に伸びる。`lastUsedAt` は生成時にも入るので、
 * 一度も再利用されなかった行も同じ物差しで落ちる。
 */
export async function purgeArticleCache(
  now: Date,
  purgeDays: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - purgeDays * 86_400_000);
  const rows = await db
    .delete(recArticleCache)
    .where(
      sql`coalesce(${recArticleCache.lastUsedAt}, ${recArticleCache.createdAt}) < ${cutoff}`,
    )
    .returning({ urlHash: recArticleCache.urlHash });
  return rows.length;
}
