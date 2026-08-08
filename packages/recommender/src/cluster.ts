import { dot, l2Normalize } from "./vector";

/**
 * 候補埋め込みの k-means（FR-S-04 / FR-S-05）。
 *
 * ベクトルは L2 正規化済みなので、距離ではなく内積で回す球面 k-means にする。
 * 重心も毎回正規化して単位球に戻す。ユークリッド距離版と違い、ノルムの差が
 * 混ざらない。
 *
 * クラスタ ID の連続性が重要（FR-S-05）。前日の重心を初期値に渡すと、
 * 「クラスタ 12 = 推薦システム」というラベルが日をまたいで生き残る。ここが
 * 崩れると、UI の「興味の現在地」も学習の特徴量 6・7 も毎日意味が変わる。
 */

/** k は候補数の平方根、上限 64（FR-S-04）。 */
export function chooseK(candidateCount: number): number {
  if (candidateCount <= 1) {
    return candidateCount;
  }
  return Math.max(1, Math.min(64, Math.round(Math.sqrt(candidateCount))));
}

export interface KMeansOptions {
  k: number;
  maxIterations?: number;
  /** 前日の重心。渡すとクラスタ ID の連続性が保たれる。 */
  initialCentroids?: Float32Array[];
  /** 決定的に動かすための種。initialCentroids が無いときだけ効く。 */
  seed?: number;
  /** 割り当ての変化がこの割合を下回ったら収束とみなす。 */
  tolerance?: number;
}

export interface KMeansResult {
  centroids: Float32Array[];
  /** 各ベクトルのクラスタ添字。 */
  assignments: number[];
  iterations: number;
  sizes: number[];
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * k-means++ の初期化。無作為に k 個選ぶより、初期重心が散らばって局所解に
 * はまりにくい。
 */
function kmeansPlusPlusInit(
  vectors: Float32Array[],
  k: number,
  rng: () => number,
): Float32Array[] {
  const centroids: Float32Array[] = [];
  const first = Math.floor(rng() * vectors.length);
  centroids.push(new Float32Array(vectors[first]));

  // 単位ベクトルなので、距離の 2 乗は 2(1 - cos) に比例する。
  const distances = vectors.map((v) => 1 - dot(v, centroids[0]));

  while (centroids.length < k) {
    const total = distances.reduce((sum, d) => sum + Math.max(0, d), 0);
    if (total <= 0) {
      // 全ベクトルが既存の重心と一致している。残りは埋められない。
      break;
    }
    let threshold = rng() * total;
    let chosen = distances.length - 1;
    for (let i = 0; i < distances.length; i++) {
      threshold -= Math.max(0, distances[i]);
      if (threshold <= 0) {
        chosen = i;
        break;
      }
    }
    const next = new Float32Array(vectors[chosen]);
    centroids.push(next);
    for (let i = 0; i < vectors.length; i++) {
      distances[i] = Math.min(distances[i], 1 - dot(vectors[i], next));
    }
  }
  return centroids;
}

export function kmeans(
  vectors: Float32Array[],
  opts: KMeansOptions,
): KMeansResult {
  const maxIterations = opts.maxIterations ?? 25;
  const tolerance = opts.tolerance ?? 0.001;

  if (vectors.length === 0) {
    return { centroids: [], assignments: [], iterations: 0, sizes: [] };
  }

  const dims = vectors[0].length;
  const k = Math.max(1, Math.min(opts.k, vectors.length));

  let centroids: Float32Array[];
  if (opts.initialCentroids && opts.initialCentroids.length > 0) {
    // 前日の重心をそのまま使う。k が増えていたら k-means++ で足す。
    centroids = opts.initialCentroids
      .filter((c) => c.length === dims)
      .slice(0, k)
      .map((c) => l2Normalize(c));
    if (centroids.length < k) {
      const extra = kmeansPlusPlusInit(
        vectors,
        k - centroids.length,
        makeRng(opts.seed ?? 1),
      );
      centroids.push(...extra);
    }
  } else {
    centroids = kmeansPlusPlusInit(vectors, k, makeRng(opts.seed ?? 1));
  }

  const assignments = Array.from<number>({ length: vectors.length }).fill(-1);
  let iterations = 0;

  for (; iterations < maxIterations; iterations++) {
    let changed = 0;
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const score = dot(vectors[i], centroids[c]);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed++;
      }
    }

    // 重心の再計算。空になったクラスタは、いちばん重心から遠い点を単独で
    // 与えて生き返らせる。潰すとクラスタ ID がずれて連続性が壊れる。
    const sums = centroids.map(() => new Float64Array(dims));
    const counts = Array.from<number>({ length: centroids.length }).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      counts[c]++;
      const sum = sums[c];
      const v = vectors[i];
      for (let d = 0; d < dims; d++) {
        sum[d] += v[d];
      }
    }

    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) {
        const orphan = farthestPoint(vectors, assignments, centroids);
        if (orphan >= 0) {
          centroids[c] = l2Normalize(vectors[orphan]);
          assignments[orphan] = c;
        }
        continue;
      }
      const next = new Float32Array(dims);
      for (let d = 0; d < dims; d++) {
        next[d] = sums[c][d] / counts[c];
      }
      centroids[c] = l2Normalize(next);
    }

    if (changed / vectors.length < tolerance) {
      iterations++;
      break;
    }
  }

  const sizes = Array.from<number>({ length: centroids.length }).fill(0);
  for (const c of assignments) {
    sizes[c]++;
  }

  return { centroids, assignments, iterations, sizes };
}

/** 自分の重心からいちばん離れている点。空クラスタの種にする。 */
function farthestPoint(
  vectors: Float32Array[],
  assignments: number[],
  centroids: Float32Array[],
): number {
  let worst = -1;
  let worstScore = Infinity;
  for (let i = 0; i < vectors.length; i++) {
    const c = assignments[i];
    if (c < 0) {
      continue;
    }
    const score = dot(vectors[i], centroids[c]);
    if (score < worstScore) {
      worstScore = score;
      worst = i;
    }
  }
  return worst;
}

/**
 * クラスタ選好スコア（FR-L-03）。正例率をベータ分布で平滑化する
 * （事前分布 α=1, β=4 — つまり「何も分からなければ 20%」）。
 *
 * 生の正例率を使うと、提示 1 件・正例 1 件のクラスタが選好度 1.0 になって
 * 上位を占める。平滑化はその暴走を止める。
 */
export function clusterPreferenceScore(
  positiveCount: number,
  examinedCount: number,
  priorAlpha = 1,
  priorBeta = 4,
): number {
  const alpha = priorAlpha + Math.max(0, positiveCount);
  const beta = priorBeta + Math.max(0, examinedCount - positiveCount);
  return alpha / (alpha + beta);
}
