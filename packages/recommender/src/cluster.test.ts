import { describe, expect, it } from "vitest";

import { chooseK, clusterPreferenceScore, kmeans } from "./cluster";
import { dot, l2Normalize } from "./vector";

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** `center` のまわりに小さくばらつく単位ベクトルを作る。 */
function around(
  center: number[],
  rng: () => number,
  spread = 0.05,
): Float32Array {
  return l2Normalize(center.map((c) => c + (rng() - 0.5) * spread));
}

describe("chooseK", () => {
  it("uses the square root of the candidate count", () => {
    expect(chooseK(100)).toBe(10);
    expect(chooseK(2500)).toBe(50);
  });

  it("caps at 64", () => {
    expect(chooseK(100000)).toBe(64);
  });

  it("degrades gracefully on tiny pools", () => {
    expect(chooseK(0)).toBe(0);
    expect(chooseK(1)).toBe(1);
  });
});

describe("kmeans", () => {
  it("separates well-defined groups", () => {
    const rng = makeRng(3);
    const groupA = Array.from({ length: 20 }, () => around([1, 0, 0], rng));
    const groupB = Array.from({ length: 20 }, () => around([0, 1, 0], rng));
    const groupC = Array.from({ length: 20 }, () => around([0, 0, 1], rng));
    const vectors = [...groupA, ...groupB, ...groupC];

    const { assignments, sizes } = kmeans(vectors, { k: 3, seed: 7 });

    // 各群の中では割り当てが一致していること。
    expect(new Set(assignments.slice(0, 20)).size).toBe(1);
    expect(new Set(assignments.slice(20, 40)).size).toBe(1);
    expect(new Set(assignments.slice(40, 60)).size).toBe(1);
    expect(new Set(assignments).size).toBe(3);
    expect(sizes.sort()).toEqual([20, 20, 20]);
  });

  it("returns unit-length centroids", () => {
    const rng = makeRng(5);
    const vectors = Array.from({ length: 30 }, () =>
      around([1, 1, 1], rng, 1.5),
    );
    const { centroids } = kmeans(vectors, { k: 3, seed: 2 });
    for (const c of centroids) {
      expect(dot(c, c)).toBeCloseTo(1, 4);
    }
  });

  it("keeps cluster ids stable when seeded with yesterday's centroids", () => {
    // ここが崩れると「クラスタ 12 = 推薦システム」というラベルが毎日別物に
    // なり、UI の「興味の現在地」も特徴量 6・7 も意味を失う。
    const rng = makeRng(11);
    const groupA = Array.from({ length: 15 }, () => around([1, 0], rng));
    const groupB = Array.from({ length: 15 }, () => around([0, 1], rng));
    const day1 = kmeans([...groupA, ...groupB], { k: 2, seed: 1 });

    // 翌日、順番を入れ替えたうえで数件増えた候補プール。
    const day2Vectors = [
      ...groupB,
      ...groupA,
      around([0, 1], rng),
      around([1, 0], rng),
    ];
    const day2 = kmeans(day2Vectors, {
      k: 2,
      initialCentroids: day1.centroids,
    });

    // day1 でグループ A に付いた添字が、day2 でも A に付いていること。
    const aClusterDay1 = day1.assignments[0];
    const aClusterDay2 = day2.assignments[15];
    expect(aClusterDay2).toBe(aClusterDay1);
  });

  it("is deterministic for a given seed", () => {
    const rng = makeRng(13);
    const vectors = Array.from({ length: 40 }, () => around([1, 2, 3], rng, 2));
    expect(kmeans(vectors, { k: 4, seed: 9 }).assignments).toEqual(
      kmeans(vectors, { k: 4, seed: 9 }).assignments,
    );
  });

  it("handles an empty pool", () => {
    expect(kmeans([], { k: 5 })).toEqual({
      centroids: [],
      assignments: [],
      iterations: 0,
      sizes: [],
    });
  });

  it("clamps k to the number of vectors", () => {
    const vectors = [l2Normalize([1, 0]), l2Normalize([0, 1])];
    expect(kmeans(vectors, { k: 10, seed: 1 }).centroids.length).toBe(2);
  });

  it("survives a pool of identical vectors", () => {
    // k-means++ が距離ゼロで割り算に落ちないこと。
    const vectors = Array.from({ length: 10 }, () => l2Normalize([1, 0]));
    const result = kmeans(vectors, { k: 3, seed: 1 });
    expect(result.assignments).toHaveLength(10);
    expect(result.assignments.every((a) => a >= 0)).toBe(true);
  });

  it("ignores stale centroids whose dimensions no longer match", () => {
    // 埋め込みモデルを差し替えた翌日。次元の違う重心は捨てて作り直す。
    const rng = makeRng(17);
    const vectors = Array.from({ length: 10 }, () => around([1, 0, 0], rng));
    const result = kmeans(vectors, {
      k: 2,
      initialCentroids: [l2Normalize([1, 0]), l2Normalize([0, 1])],
      seed: 1,
    });
    expect(result.centroids.every((c) => c.length === 3)).toBe(true);
  });
});

describe("clusterPreferenceScore", () => {
  it("starts at the prior when nothing is known", () => {
    expect(clusterPreferenceScore(0, 0)).toBeCloseTo(0.2, 6);
  });

  it("does not let one lucky hit reach 1.0", () => {
    // 生の正例率だと 1 件 1 正例のクラスタが選好度 1.0 になり上位を独占する。
    expect(clusterPreferenceScore(1, 1)).toBeLessThan(0.5);
  });

  it("rises with sustained evidence", () => {
    expect(clusterPreferenceScore(40, 50)).toBeGreaterThan(
      clusterPreferenceScore(4, 5),
    );
  });

  it("falls when a cluster is examined but never liked", () => {
    expect(clusterPreferenceScore(0, 50)).toBeLessThan(0.05);
  });
});
