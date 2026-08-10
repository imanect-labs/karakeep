import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";

import type { ArticleCacheRow } from "./articleCache";
import {
  buildArticleCachePurgeFilter,
  isDigestCacheHit,
  isEmbeddingCacheHit,
} from "./articleCache";

function row(overrides: Partial<ArticleCacheRow> = {}): ArticleCacheRow {
  return {
    urlHash: "h",
    titleJa: null,
    summaryJa: null,
    digestModelId: null,
    embedding: null,
    embeddingModelId: null,
    embeddingDimensions: null,
    ...overrides,
  };
}

describe("isDigestCacheHit", () => {
  test("hits when the title and model match", () => {
    const hit = row({ titleJa: "訳題", digestModelId: "ollama/qwen3.5:4b" });
    expect(isDigestCacheHit(hit, "ollama/qwen3.5:4b")).toBe(true);
  });

  test("misses on a different model", () => {
    const hit = row({ titleJa: "訳題", digestModelId: "ollama/qwen3.5:4b" });
    expect(isDigestCacheHit(hit, "ollama/gemma3:4b")).toBe(false);
  });

  test("misses when there is no row", () => {
    expect(isDigestCacheHit(undefined, "ollama/qwen3.5:4b")).toBe(false);
  });

  test("misses when only the embedding side is populated", () => {
    // 埋め込みだけ先に入った行。ダイジェストはまだ無い。
    const partial = row({
      embedding: Buffer.alloc(4),
      embeddingModelId: "ollama/embeddinggemma:300m",
    });
    expect(isDigestCacheHit(partial, "ollama/qwen3.5:4b")).toBe(false);
  });
});

describe("isEmbeddingCacheHit", () => {
  const vector = Buffer.alloc(8);

  test("hits when the model and dimensions match", () => {
    const hit = row({
      embedding: vector,
      embeddingModelId: "ollama/embeddinggemma:300m",
      embeddingDimensions: 768,
    });
    expect(isEmbeddingCacheHit(hit, "ollama/embeddinggemma:300m", 768)).toBe(
      true,
    );
  });

  test("misses when the dimensions changed even though the model did not", () => {
    // これがこの表で一番怖い誤り。modelId は `ollama/<model>` で
    // RECOMMENDER_EMBEDDING_DIMENSIONS を含まないので、768 → 512 の変更は
    // モデル ID からは見えない。次元を見ないと空間の違うベクトルを配る。
    const hit = row({
      embedding: vector,
      embeddingModelId: "ollama/embeddinggemma:300m",
      embeddingDimensions: 768,
    });
    expect(isEmbeddingCacheHit(hit, "ollama/embeddinggemma:300m", 512)).toBe(
      false,
    );
  });

  test("ignores the dimensions when none is configured", () => {
    // 未設定ならモデルが次元を決めるので、モデル ID の一致で足りる。
    const hit = row({
      embedding: vector,
      embeddingModelId: "ollama/embeddinggemma:300m",
      embeddingDimensions: 768,
    });
    expect(
      isEmbeddingCacheHit(hit, "ollama/embeddinggemma:300m", undefined),
    ).toBe(true);
  });

  test("misses on a different model", () => {
    const hit = row({
      embedding: vector,
      embeddingModelId: "ollama/embeddinggemma:300m",
      embeddingDimensions: 768,
    });
    expect(isEmbeddingCacheHit(hit, "openai/text-embedding-3-small", 768)).toBe(
      false,
    );
  });

  test("misses when there is no vector", () => {
    // ダイジェストだけ入っている行。埋め込みはまだ無い。
    const partial = row({
      titleJa: "訳題",
      digestModelId: "ollama/qwen3.5:4b",
      embeddingModelId: "ollama/embeddinggemma:300m",
      embeddingDimensions: 768,
    });
    expect(
      isEmbeddingCacheHit(partial, "ollama/embeddinggemma:300m", 768),
    ).toBe(false);
  });

  test("misses when there is no row", () => {
    expect(
      isEmbeddingCacheHit(undefined, "ollama/embeddinggemma:300m", 768),
    ).toBe(false);
  });
});

describe("buildArticleCachePurgeFilter", () => {
  /**
   * **ここが壊れると `maintain` が丸ごと落ちる。** 実際 2026-08-10 まで
   * `sql` テンプレートに `Date` を差し込んでいて、`purgeArticleCache` の
   * 手前で `SQLite3 can only bind numbers, strings, bigints, buffers, and null`
   * が投がり、期限切れの掃除も収集元の配り直しも一度も走っていなかった。
   * cron が発火していなかったので気づけなかった。
   */
  const dialect = new SQLiteSyncDialect();

  test("binds no Date objects", () => {
    const { params } = dialect.sqlToQuery(
      buildArticleCachePurgeFilter(new Date("2026-05-12T00:00:00Z"))!,
    );
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) {
      expect(p, `${String(p)} は driver がバインドできない`).not.toBeInstanceOf(
        Date,
      );
      expect(["number", "string", "bigint"]).toContain(typeof p);
    }
  });

  test("also matches rows that were never re-used", () => {
    // `coalesce` をやめて `or` に分けた理由。SQL の `NULL < x` は NULL なので、
    // `lastUsedAt` の比較だけでは未再利用の行が永久に残る。
    const { sql: text } = dialect.sqlToQuery(
      buildArticleCachePurgeFilter(new Date("2026-05-12T00:00:00Z"))!,
    );
    expect(text).toContain("is null");
    expect(text).toContain("createdAt");
  });
});
