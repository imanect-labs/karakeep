/**
 * ソースレベルのバンディット（§4.0 / FR-D-13）。
 *
 * ドメインごとにベータ事後分布 `Beta(1 + 正例数, 4 + examined 数 − 正例数)` を
 * 持ち、試用枠のドメイン選択に Thompson Sampling を使う。
 *
 * 記事レベルより統計効率が良い。ドメインは数百、記事は数万。1 ドメインを
 * 6 記事試せば、そのドメインの当たり外れは記事単位よりずっと早く分かる。
 */

/** 事前分布。「何も分からなければ 20%」という弱い事前。 */
export const PRIOR_ALPHA = 1;
export const PRIOR_BETA = 4;

/** 事前分布の平均。「何も分からないドメイン」の期待値。 */
export const PRIOR_MEAN = PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA);

export interface BetaPosterior {
  alpha: number;
  beta: number;
}

export function posteriorFromCounts(
  positiveCount: number,
  examinedCount: number,
): BetaPosterior {
  return {
    alpha: PRIOR_ALPHA + Math.max(0, positiveCount),
    beta: PRIOR_BETA + Math.max(0, examinedCount - positiveCount),
  };
}

export function posteriorMean(posterior: BetaPosterior): number {
  const total = posterior.alpha + posterior.beta;
  return total > 0 ? posterior.alpha / total : 0;
}

/** 事後の標準偏差。証拠が少ないほど大きい。 */
export function posteriorStdDev(posterior: BetaPosterior): number {
  const { alpha, beta } = posterior;
  const total = alpha + beta;
  if (total <= 1) {
    return 0;
  }
  return Math.sqrt((alpha * beta) / (total * total * (total + 1)));
}

/** 決定的な擬似乱数。日次ジョブを再現可能にするため。 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Box–Muller 法による標準正規乱数。 */
function sampleNormal(rng: () => number): number {
  // rng() が 0 を返すと log(0) になるので下駄をはかせる。
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Marsaglia–Tsang 法によるガンマ乱数（shape > 0, scale = 1）。
 * ベータ乱数を 2 つのガンマ乱数から作るために使う。
 */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // shape < 1 は shape + 1 で引いてから補正する（Marsaglia–Tsang の
    // 前提が shape >= 1 のため）。
    const u = Math.max(rng(), Number.EPSILON);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) {
      return d * v;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** ベータ分布からのサンプリング。 */
export function sampleBeta(
  posterior: BetaPosterior,
  rng: () => number,
): number {
  const x = sampleGamma(posterior.alpha, rng);
  const y = sampleGamma(posterior.beta, rng);
  const total = x + y;
  return total > 0 ? x / total : 0;
}

export interface ThompsonArm<T> {
  item: T;
  posterior: BetaPosterior;
}

/**
 * Thompson Sampling で上位 `count` 件を選ぶ。各腕の事後から 1 回引き、
 * 引いた値の大きい順に取る。
 *
 * 「事後平均の高い順」ではないのが要点。事後平均だけで選ぶと、たまたま
 * 最初の数件が外れた新しいドメインが二度と選ばれない。分散の大きい腕が
 * ときどき上に来ることで、試す価値のあるものが試される。
 */
export function thompsonSelect<T>(
  arms: ThompsonArm<T>[],
  count: number,
  rng: () => number,
): T[] {
  if (count <= 0) {
    return [];
  }
  return arms
    .map((arm) => ({ item: arm.item, draw: sampleBeta(arm.posterior, rng) }))
    .sort((a, b) => b.draw - a.draw)
    .slice(0, count)
    .map((a) => a.item);
}

/**
 * 温度つき softmax の非復元抽出（Plackett–Luce / FR-R-04b）。
 *
 * **これが無いとオフポリシー評価が原理的にできない。** argmax で選んでいる
 * 限り propensity は 0 か 1 にしかならず、逆確率重み付けが機能しない。
 * `τ = 0.15` なら実質 argmax とほぼ同じ並びになり、体感の推薦品質を
 * 落とさずに選出確率を厳密に得られる。
 *
 * 返すのは選んだ順の要素と、その要素がその位置で選ばれた確率の積
 * （＝この枠の中での propensity）。
 */
export interface SampledWithPropensity<T> {
  item: T;
  propensity: number;
}

export function softmaxSampleWithoutReplacement<T>(
  items: { item: T; score: number }[],
  count: number,
  temperature: number,
  rng: () => number,
): SampledWithPropensity<T>[] {
  const remaining = [...items];
  const picked: SampledWithPropensity<T>[] = [];
  const tau = Math.max(temperature, 1e-6);

  while (picked.length < count && remaining.length > 0) {
    // 数値安定化のため最大値を引いてから指数を取る。τ が小さいと
    // exp(score/τ) はすぐ Infinity になる。
    const maxScore = Math.max(...remaining.map((r) => r.score));
    const weights = remaining.map((r) => Math.exp((r.score - maxScore) / tau));
    const total = weights.reduce((sum, w) => sum + w, 0);

    let threshold = rng() * total;
    let chosen = remaining.length - 1;
    for (let i = 0; i < weights.length; i++) {
      threshold -= weights[i];
      if (threshold <= 0) {
        chosen = i;
        break;
      }
    }

    picked.push({
      item: remaining[chosen].item,
      propensity: total > 0 ? weights[chosen] / total : 1,
    });
    remaining.splice(chosen, 1);
  }

  return picked;
}
