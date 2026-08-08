import { describe, expect, it } from "vitest";

import {
  centroid,
  cosine,
  deserializeVector,
  dot,
  l2Normalize,
  maxSimilarity,
  meanTopSimilarity,
  serializeVector,
  topK,
  truncateMRL,
  weightedCentroid,
} from "./vector";

/** 決定的な擬似乱数。テストを再現可能にするため Math.random は使わない。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomUnitVector(rng: () => number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    v[i] = rng() * 2 - 1;
  }
  return l2Normalize(v);
}

describe("serialize / deserialize", () => {
  it("round-trips exactly", () => {
    const original = Float32Array.from([0.5, -0.25, 0, 1, -1]);
    const restored = deserializeVector(serializeVector(original));
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it("accepts a plain number array", () => {
    const restored = deserializeVector(serializeVector([1, 2, 3]));
    expect(Array.from(restored)).toEqual([1, 2, 3]);
  });

  it("uses 4 bytes per dimension", () => {
    expect(serializeVector(new Float32Array(768)).byteLength).toBe(768 * 4);
  });

  it("copies, so mutating the source does not change the blob", () => {
    const source = Float32Array.from([1, 2, 3]);
    const blob = serializeVector(source);
    source[0] = 99;
    expect(Array.from(deserializeVector(blob))).toEqual([1, 2, 3]);
  });

  it("survives an unaligned buffer offset", () => {
    // SQLite ドライバが共有プールから切り出した Buffer は byteOffset が 4 の
    // 倍数とは限らない。Float32Array はアラインメントを要求するので、そこで
    // 落ちないことを確かめる。
    const original = Float32Array.from([0.5, -0.25, 0.125]);
    const blob = serializeVector(original);
    const padded = Buffer.alloc(blob.byteLength + 1);
    blob.copy(padded, 1);
    const unaligned = padded.subarray(1);
    expect(unaligned.byteOffset % 4).not.toBe(0);
    expect(Array.from(deserializeVector(unaligned))).toEqual(
      Array.from(original),
    );
  });

  it("rejects a blob whose length is not a multiple of 4", () => {
    expect(() => deserializeVector(Buffer.alloc(7))).toThrow(/multiple of 4/);
  });
});

describe("l2Normalize", () => {
  it("produces a unit vector", () => {
    const normalized = l2Normalize([3, 4]);
    expect(normalized[0]).toBeCloseTo(0.6, 6);
    expect(normalized[1]).toBeCloseTo(0.8, 6);
    expect(dot(normalized, normalized)).toBeCloseTo(1, 6);
  });

  it("leaves the zero vector alone instead of producing NaN", () => {
    const normalized = l2Normalize([0, 0, 0]);
    expect(Array.from(normalized)).toEqual([0, 0, 0]);
  });

  it("does not mutate its input", () => {
    const source = Float32Array.from([3, 4]);
    l2Normalize(source);
    expect(Array.from(source)).toEqual([3, 4]);
  });
});

describe("dot and cosine", () => {
  it("agree on normalized vectors", () => {
    const rng = makeRng(7);
    const a = randomUnitVector(rng, 64);
    const b = randomUnitVector(rng, 64);
    expect(dot(a, b)).toBeCloseTo(cosine(a, b), 6);
  });

  it("cosine ignores magnitude", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([5, 0]);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it("returns 0 rather than NaN when a vector is zero", () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toBe(
      0,
    );
  });

  it("rejects mismatched dimensions", () => {
    expect(() =>
      dot(Float32Array.from([1]), Float32Array.from([1, 2])),
    ).toThrow(/Dimension mismatch/);
  });
});

describe("truncateMRL", () => {
  it("renormalizes after cutting, so the result stays a unit vector", () => {
    const rng = makeRng(11);
    const full = randomUnitVector(rng, 768);
    const cut = truncateMRL(full, 256);
    expect(cut.length).toBe(256);
    expect(dot(cut, cut)).toBeCloseTo(1, 5);
  });

  it("keeps the leading dimensions", () => {
    const cut = truncateMRL(Float32Array.from([1, 0, 0, 0]), 2);
    expect(Array.from(cut)).toEqual([1, 0]);
  });

  it("refuses to grow a vector", () => {
    expect(() => truncateMRL(new Float32Array(128), 256)).toThrow(
      /Cannot truncate/,
    );
  });
});

describe("centroid", () => {
  it("averages component-wise", () => {
    const c = centroid([Float32Array.from([1, 0]), Float32Array.from([0, 2])]);
    expect(Array.from(c!)).toEqual([0.5, 1]);
  });

  it("returns null for an empty set", () => {
    expect(centroid([])).toBeNull();
  });
});

describe("weightedCentroid", () => {
  it("weights entries", () => {
    const c = weightedCentroid([
      { vector: Float32Array.from([1, 0]), weight: 3 },
      { vector: Float32Array.from([0, 1]), weight: 1 },
    ]);
    expect(Array.from(c!)).toEqual([0.75, 0.25]);
  });

  it("returns null when every weight is zero", () => {
    // 直近 7 日プロフィールは指数減衰の重みを掛ける。古い正例しかない日は
    // 重みが全部 0 になりうるので、そこで NaN を作らないことを確かめる。
    expect(
      weightedCentroid([{ vector: Float32Array.from([1, 0]), weight: 0 }]),
    ).toBeNull();
  });
});

describe("topK", () => {
  it("returns the k nearest in descending score order", () => {
    const query = Float32Array.from([1, 0]);
    const vectors = [
      Float32Array.from([0, 1]), // 0.0
      Float32Array.from([1, 0]), // 1.0
      l2Normalize([1, 1]), // ~0.707
    ];
    const result = topK(query, vectors, 2);
    expect(result.map((r) => r.index)).toEqual([1, 2]);
    expect(result[0].score).toBeCloseTo(1, 6);
    expect(result[1].score).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("agrees with a full sort", () => {
    const rng = makeRng(23);
    const query = randomUnitVector(rng, 32);
    const vectors = Array.from({ length: 200 }, () =>
      randomUnitVector(rng, 32),
    );
    const expected = vectors
      .map((v, index) => ({ index, score: dot(query, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    expect(topK(query, vectors, 10)).toEqual(expected);
  });

  it("handles k larger than the candidate count", () => {
    const rng = makeRng(29);
    const query = randomUnitVector(rng, 8);
    const vectors = [randomUnitVector(rng, 8), randomUnitVector(rng, 8)];
    expect(topK(query, vectors, 10)).toHaveLength(2);
  });

  it("returns nothing for k <= 0", () => {
    expect(topK(Float32Array.from([1]), [Float32Array.from([1])], 0)).toEqual(
      [],
    );
  });
});

describe("maxSimilarity and meanTopSimilarity", () => {
  it("maxSimilarity picks the closest", () => {
    const query = Float32Array.from([1, 0]);
    expect(
      maxSimilarity(query, [
        Float32Array.from([0, 1]),
        Float32Array.from([1, 0]),
      ]),
    ).toBeCloseTo(1, 6);
  });

  it("maxSimilarity returns 0 for an empty set", () => {
    // 正例がまだ 1 件もない初日でも特徴量抽出が落ちないこと。
    expect(maxSimilarity(Float32Array.from([1, 0]), [])).toBe(0);
  });

  it("meanTopSimilarity averages only the top n", () => {
    const query = Float32Array.from([1, 0]);
    const vectors = [
      Float32Array.from([1, 0]), // 1.0
      l2Normalize([1, 1]), // ~0.707
      Float32Array.from([0, 1]), // 0.0
    ];
    expect(meanTopSimilarity(query, vectors, 2)).toBeCloseTo(
      (1 + Math.SQRT1_2) / 2,
      6,
    );
  });

  it("meanTopSimilarity returns 0 for an empty set", () => {
    expect(meanTopSimilarity(Float32Array.from([1, 0]), [], 5)).toBe(0);
  });
});

describe("brute-force scan budget", () => {
  // ROADMAP の A. 基盤にある「5,000 件 × 768 次元で 50 ms 以内」を守る。
  // 総当たりで足りるという設計判断（requirements.md §5）が崩れたら、ここが
  // 先に落ちて HNSW / Meilisearch への移行を検討する合図になる。
  // CI は 4 つのテストスイートと docker build が同時に走る 4 コアのランナー
  // なので、実測が負荷次第で 3 倍以上に振れる（50 ms 予算に対して 153 ms で
  // 落ちた実績あり）。壁時計の閾値をそのまま CI に持ち込むと不安定になるだけ
  // なので、CI では桁が変わる退行だけを捕まえる緩い予算にする。開発機では
  // 本来の 50 ms を守らせる。
  const budgetMs = process.env.CI ? 500 : 50;

  it(`scans 5,000 x 768 within the ${budgetMs} ms budget`, () => {
    const rng = makeRng(31);
    const dims = 768;
    const query = randomUnitVector(rng, dims);
    const vectors = Array.from({ length: 5000 }, () =>
      randomUnitVector(rng, dims),
    );

    // JIT を暖めてから測る。
    topK(query, vectors, 20);

    const started = performance.now();
    const result = topK(query, vectors, 20);
    const elapsedMs = performance.now() - started;

    expect(result).toHaveLength(20);
    expect(elapsedMs).toBeLessThan(budgetMs);
  });
});
