import { PRIOR_MEAN } from "../bandit";
import type { Profiles } from "../profile";
import { dot } from "../vector";

/**
 * 学習前の決め打ちスコアリング（`heuristic-v1`）。
 *
 * 初日から動く必要がある。ログが貯まるまでの数か月はこれが本番の推薦器に
 * なるので、「そこそこ妥当」では足りず、**無作為に対してはっきり勝つ**
 * 必要がある。段階的有効化の判断ゲート（exploit 枠が random 枠を上回るか）
 * はまさにここを見ている。
 */

export interface HeuristicWeights {
  stable: number;
  recent: number;
  negative: number;
  clusterPreference: number;
  freshness: number;
  repetitionPenalty: number;
  domainPosterior: number;
  novelty: number;
}

export const DEFAULT_HEURISTIC_WEIGHTS: HeuristicWeights = {
  // 長期より直近をやや強く見る。興味は動くので。
  stable: 1.0,
  recent: 1.3,
  // 否定プロフィールは強めに引く。明示的な負例は数が少ないぶん貴重で、
  // 弱く扱うと「興味なし」を押した意味が体感できない。
  negative: 1.2,
  clusterPreference: 0.8,
  freshness: 0.6,
  repetitionPenalty: 0.5,
  domainPosterior: 0.4,
  novelty: 0.3,
};

export interface HeuristicInput {
  embedding: Float32Array | null;
  publishedAt: Date | null;
  clusterId: string | null;
  /** そのクラスタの選好スコア（ベータ平滑化済み）。 */
  clusterPreference: number;
  /** そのクラスタの直近 7 日の提示回数。 */
  clusterRecentImpressions: number;
  /** ドメインのベータ事後平均。未知は事前値。 */
  domainPosterior: number;
  /** 既存ブックマークとの最大コサイン。新規性の裏返し。 */
  maxSimilarityToLibrary: number;
}

export interface HeuristicScore {
  score: number;
  /** 学習前は事後分散が無いので、提示回数の逆数で代用する。 */
  uncertainty: number;
  /** UI の「選定理由」に使う内訳。 */
  contributions: Record<string, number>;
}

/** 鮮度の減衰。半減期 2 日で、1 週間経つとほぼ効かなくなる。 */
export function freshnessScore(
  publishedAt: Date | null,
  now: Date,
  halfLifeHours = 48,
): number {
  if (!publishedAt) {
    // 日付の無い候補を最下位に落とすと、日付を出さないフィードの記事が
    // 永久に出ない。中庸の値を与える。
    return 0.5;
  }
  const hours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (hours <= 0) {
    return 1;
  }
  return Math.pow(0.5, hours / halfLifeHours);
}

export function scoreHeuristic(
  input: HeuristicInput,
  profiles: Profiles,
  now: Date,
  weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
): HeuristicScore {
  const contributions: Record<string, number> = {};

  const cosStable =
    input.embedding && profiles.stable
      ? dot(input.embedding, profiles.stable)
      : 0;
  const cosRecent =
    input.embedding && profiles.recent
      ? dot(input.embedding, profiles.recent)
      : 0;
  const cosNegative =
    input.embedding && profiles.negative
      ? dot(input.embedding, profiles.negative)
      : 0;

  contributions.stable = weights.stable * cosStable;
  contributions.recent = weights.recent * cosRecent;
  // 否定プロフィールとの近さは減点。負の相関は加点にしない（「嫌いなものと
  // 逆」であることに意味は無い）。
  contributions.negative = -weights.negative * Math.max(0, cosNegative);

  contributions.clusterPreference =
    weights.clusterPreference * (input.clusterPreference - PRIOR_MEAN);

  contributions.freshness =
    weights.freshness * (freshnessScore(input.publishedAt, now) - 0.5);

  // 同じクラスタを何度も見せない。対数にしているのは、2 回目と 3 回目の差は
  // 大きいが 20 回目と 21 回目の差は小さいため。
  contributions.repetition =
    -weights.repetitionPenalty *
    Math.log1p(Math.max(0, input.clusterRecentImpressions)) *
    0.3;

  contributions.domain =
    weights.domainPosterior * (input.domainPosterior - PRIOR_MEAN);

  // 新規性 = 1 − 既存ブックマークとの最大コサイン。既に持っている記事と
  // ほぼ同じものを勧めない。
  contributions.novelty =
    weights.novelty * (1 - Math.max(0, input.maxSimilarityToLibrary));

  const score = Object.values(contributions).reduce((sum, v) => sum + v, 0);

  return {
    score,
    // 学習前の不確実性は「そのクラスタをどれだけ見せたか」の逆数で代用する。
    // 提示が少ないクラスタほど、当たるかどうか分かっていない。
    uncertainty: 1 / (1 + Math.max(0, input.clusterRecentImpressions)),
    contributions,
  };
}

/**
 * スコアの内訳から自然文の選定理由を作る（FR-U-02）。
 *
 * 上位 2 つの寄与だけを言う。全部並べると読まれない。
 */
export function explainScore(score: HeuristicScore): string {
  const labels: Record<string, [string, string]> = {
    stable: ["これまで反応した記事群と意味的に近い", "これまでの関心から遠い"],
    recent: ["直近よく読んでいるテーマに近い", "直近の関心からは外れている"],
    negative: ["", "「興味なし」にした記事に似ている"],
    clusterPreference: [
      "反応の良いトピックに属している",
      "反応の薄いトピックに属している",
    ],
    freshness: ["公開されたばかり", "公開からしばらく経っている"],
    repetition: ["", "同じテーマの提示が続いているため減点"],
    domain: ["よく読んでいる情報源", "まだ実績の少ない情報源"],
    novelty: ["手持ちのブックマークにない切り口", "既に持っている記事と近い"],
  };

  const ranked = Object.entries(score.contributions)
    .filter(([key]) => key in labels)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 2);

  const phrases = ranked
    .map(([key, value]) => labels[key][value >= 0 ? 0 : 1])
    .filter((phrase) => phrase !== "");

  return phrases.length > 0 ? phrases.join("。") : "候補プールから選ばれた";
}
