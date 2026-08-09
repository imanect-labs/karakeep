import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { db } from "@karakeep/db";
import { recCandidates, recClusters } from "@karakeep/db/schema";
import type { DedupeItem } from "@karakeep/recommender";
import {
  chooseK,
  deserializeVector,
  embedDocuments,
  findDuplicates,
  kmeans,
  serializeVector,
} from "@karakeep/recommender";
import { EmbeddingClientFactory } from "@karakeep/shared/embedding";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import {
  isEmbeddingCacheHit,
  loadArticleCache,
  putEmbedding,
  touchArticleCache,
} from "./articleCache";
import { chunk, IN_CLAUSE_CHUNK } from "./shared";

export interface EmbedResult {
  embedded: number;
  /** 共有キャッシュから貰った件数。埋め込みプロバイダを叩いていない。 */
  shared: number;
  failed: number;
  duplicatesMarked: number;
  clusters: number;
}

/**
 * 候補の埋め込み・重複クラスタ化・k-means（FR-S-01〜05）。
 *
 * 埋め込みは専用プロバイダ経由（FR-S-00）。ここが動かないと推薦は
 * ヒューリスティックすら出せないので、失敗はメトリクスに出す。
 */
export async function runEmbed(
  userId: string,
  candidateIds: string[] | undefined,
  jobId: string,
): Promise<EmbedResult> {
  const cfg = serverConfig.recommender;
  const log = (msg: string) =>
    logger.info(`[recommender][embed][${jobId}] ${msg}`);

  const client = EmbeddingClientFactory.build();
  if (!client) {
    // 候補は残す。新着順フォールバックの対象にはなる（NFR-09）。
    logger.warn(
      `[recommender][embed][${jobId}] no embedding client configured, skipping`,
    );
    return {
      embedded: 0,
      shared: 0,
      failed: 0,
      duplicatesMarked: 0,
      clusters: 0,
    };
  }

  const pending = await db.query.recCandidates.findMany({
    where: candidateIds
      ? and(
          eq(recCandidates.userId, userId),
          inArray(recCandidates.id, candidateIds),
        )
      : and(
          eq(recCandidates.userId, userId),
          eq(recCandidates.embeddingStatus, "pending"),
          // `active` に絞らない。ブートストラップした既存ブックマークは
          // `promoted` で入るので、絞ると**新規性の特徴量が永久に 0 になる**
          // （比較相手のライブラリ埋め込みが 1 件も作られない）。
          ne(recCandidates.status, "expired"),
        ),
    columns: {
      id: true,
      title: true,
      summary: true,
      contentExcerpt: true,
      urlHash: true,
      canonicalUrl: true,
      titleHash: true,
      publishedAt: true,
      // 共有キャッシュへ**書く**かどうかの判定に使う。
      origin: true,
    },
  });

  log(`${pending.length} candidates need an embedding`);

  let embedded = 0;
  let shared = 0;
  let failed = 0;
  const freshlyEmbedded: DedupeItem[] = [];

  // 先に共有キャッシュを引く。同じ収集元を使う別ユーザーが既に埋め込んで
  // いれば、そのままベクトルを貰える。
  const now = new Date();
  const cached = await loadArticleCache(pending.map((c) => c.urlHash));
  const misses: typeof pending = [];
  const hitHashes: string[] = [];

  for (const candidate of pending) {
    const row = cached.get(candidate.urlHash);
    if (!isEmbeddingCacheHit(row, client.modelId, cfg.embeddingDimensions)) {
      misses.push(candidate);
      continue;
    }
    await db
      .update(recCandidates)
      .set({
        embedding: row!.embedding,
        embeddingModelId: row!.embeddingModelId,
        embeddingStatus: "success",
      })
      .where(eq(recCandidates.id, candidate.id));
    shared++;
    hitHashes.push(candidate.urlHash);
    // 重複判定と k-means の入力に入れる。ここで落とすと、共有で埋めた候補
    // だけ重複マークもクラスタ割り当ても付かない。
    freshlyEmbedded.push({
      id: candidate.id,
      urlHash: candidate.urlHash,
      titleHash: candidate.titleHash,
      embedding: deserializeVector(row!.embedding!),
      publishedAt: candidate.publishedAt,
    });
  }
  await touchArticleCache(hitHashes, now);
  if (shared > 0) {
    log(`${shared} embeddings came from the shared article cache`);
  }

  for (const batch of chunk(misses, cfg.embedBatchSize)) {
    let results;
    try {
      results = await embedDocuments(
        client,
        batch.map((c) => ({
          title: c.title,
          summary: c.summary,
          body: c.contentExcerpt,
        })),
        cfg.embeddingDimensions
          ? { dimensions: cfg.embeddingDimensions }
          : undefined,
      );
    } catch (e) {
      // バッチ単位で諦める。1 バッチの失敗でジョブ全体を落とすと、その日の
      // 候補が丸ごと埋め込みなしになる。
      failed += batch.length;
      logger.warn(
        `[recommender][embed][${jobId}] batch of ${batch.length} failed: ${e}`,
      );
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      const candidate = batch[i];
      const result = results[i];
      if (!result) {
        // 整形できるものが何も無かった候補。再試行しても変わらない。
        failed++;
        await db
          .update(recCandidates)
          .set({ embeddingStatus: "failure" })
          .where(eq(recCandidates.id, candidate.id));
        continue;
      }
      const serialized = serializeVector(result.vector);
      await db
        .update(recCandidates)
        .set({
          embedding: serialized,
          embeddingModelId: result.modelId,
          embeddingStatus: "success",
        })
        .where(eq(recCandidates.id, candidate.id));
      embedded++;
      // **書くのは `collected` 由来だけ。** `bootstrap` は本人のブックマーク
      // なので、`urlHash` の行が在ること自体が「誰かがこの URL を保存した」
      // という信号になる。読むのは許している（既に誰かの収集結果として
      // 存在している行なので何も漏れない）。
      if (candidate.origin === "collected") {
        await putEmbedding({
          urlHash: candidate.urlHash,
          canonicalUrl: candidate.canonicalUrl,
          embedding: serialized,
          modelId: result.modelId,
          // 次元は modelId に含まれないので明示的に持つ。未設定なら
          // モデルが決めた実寸を記録する。
          dimensions: cfg.embeddingDimensions ?? result.vector.length,
          now,
        });
      }
      freshlyEmbedded.push({
        id: candidate.id,
        urlHash: candidate.urlHash,
        titleHash: candidate.titleHash,
        embedding: result.vector,
        publishedAt: candidate.publishedAt,
      });
    }
  }

  const duplicatesMarked = await markNearDuplicates(
    userId,
    freshlyEmbedded,
    client.modelId,
  );
  const clusters = await recluster(userId, client.modelId, jobId);

  log(
    `embedded ${embedded} (${shared} shared), failed ${failed}, marked ${duplicatesMarked} duplicates, ${clusters} clusters`,
  );
  return { embedded, shared, failed, duplicatesMarked, clusters };
}

/**
 * 埋め込み近傍による重複判定（FR-C-05 の 3 段目）。
 *
 * 比較相手は同じモデルで埋め込まれた候補だけに限る。モデルを差し替えた
 * 直後は空間が違うので、混ぜて比べると無意味な近傍が出る。
 */
async function markNearDuplicates(
  userId: string,
  incoming: DedupeItem[],
  modelId: string,
): Promise<number> {
  if (incoming.length === 0) {
    return 0;
  }
  const incomingIds = new Set(incoming.map((i) => i.id));

  const existingRows = await db.query.recCandidates.findMany({
    where: and(
      eq(recCandidates.userId, userId),
      eq(recCandidates.embeddingStatus, "success"),
      eq(recCandidates.embeddingModelId, modelId),
      ne(recCandidates.status, "expired"),
    ),
    columns: {
      id: true,
      urlHash: true,
      titleHash: true,
      embedding: true,
      publishedAt: true,
    },
  });

  const existing: DedupeItem[] = existingRows
    .filter((row) => !incomingIds.has(row.id) && row.embedding)
    .map((row) => ({
      id: row.id,
      urlHash: row.urlHash,
      titleHash: row.titleHash,
      embedding: deserializeVector(row.embedding!),
      publishedAt: row.publishedAt,
    }));

  const duplicates = findDuplicates(incoming, existing);
  for (const [duplicateId, representativeId] of duplicates) {
    await db
      .update(recCandidates)
      .set({ duplicateOfId: representativeId })
      .where(eq(recCandidates.id, duplicateId));
  }
  return duplicates.size;
}

/**
 * 候補プール全体の k-means（FR-S-04 / FR-S-05）。
 *
 * 前日の重心を初期値に渡してクラスタ ID の連続性を保つ。ラベル生成は
 * 別途 LLM に投げるが、そこは 1 クラスタ 1 回だけなのでクラスタが安定して
 * いることが前提になる。
 */
async function recluster(
  userId: string,
  modelId: string,
  jobId: string,
): Promise<number> {
  const rows = await db.query.recCandidates.findMany({
    where: and(
      eq(recCandidates.userId, userId),
      eq(recCandidates.status, "active"),
      eq(recCandidates.embeddingStatus, "success"),
      eq(recCandidates.embeddingModelId, modelId),
      isNotNull(recCandidates.embedding),
    ),
    columns: { id: true, embedding: true },
  });

  if (rows.length < 2) {
    return 0;
  }

  const vectors = rows.map((r) => deserializeVector(r.embedding!));
  const previous = await db.query.recClusters.findMany({
    where: eq(recClusters.userId, userId),
    columns: { id: true, centroid: true },
  });

  const k = chooseK(rows.length);
  const result = kmeans(vectors, {
    k,
    initialCentroids: previous.map((p) => deserializeVector(p.centroid)),
  });

  // 前日のクラスタ行を添字の順に再利用する。行の id を保つことが「クラスタ
  // ID の連続性」の実体で、ラベルと選好スコアがそこにぶら下がっている。
  const clusterIds: string[] = [];
  for (let i = 0; i < result.centroids.length; i++) {
    const centroid = serializeVector(result.centroids[i]);
    const size = result.sizes[i] ?? 0;
    const reused = previous[i];
    if (reused) {
      await db
        .update(recClusters)
        .set({ centroid, size, computedAt: new Date() })
        .where(eq(recClusters.id, reused.id));
      clusterIds.push(reused.id);
    } else {
      const [inserted] = await db
        .insert(recClusters)
        .values({ userId, centroid, size, computedAt: new Date() })
        .returning({ id: recClusters.id });
      clusterIds.push(inserted.id);
    }
  }

  // k が減った場合、余った旧クラスタは所属候補がいなくなる。行は消さずに
  // size=0 にしておく（過去の impression が clusterId を参照している）。
  for (const stale of previous.slice(result.centroids.length)) {
    await db
      .update(recClusters)
      .set({ size: 0, computedAt: new Date() })
      .where(eq(recClusters.id, stale.id));
  }

  // 割り当ての書き戻し。クラスタごとにまとめて 1 本の UPDATE にする。
  const byCluster = new Map<string, string[]>();
  rows.forEach((row, i) => {
    const clusterId = clusterIds[result.assignments[i]];
    if (!clusterId) {
      return;
    }
    const list = byCluster.get(clusterId);
    if (list) {
      list.push(row.id);
    } else {
      byCluster.set(clusterId, [row.id]);
    }
  });

  for (const [clusterId, candidateIds] of byCluster) {
    for (const batch of chunk(candidateIds, IN_CLAUSE_CHUNK)) {
      await db
        .update(recCandidates)
        .set({ clusterId })
        .where(inArray(recCandidates.id, batch));
    }
  }

  logger.debug(
    `[recommender][embed][${jobId}] reclustered ${rows.length} candidates into ${clusterIds.length} clusters in ${result.iterations} iterations`,
  );
  return clusterIds.length;
}
