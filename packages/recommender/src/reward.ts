/**
 * 報酬の分解と観測状態の判定（§6）。
 *
 * 合成報酬は保存しない。**生イベントを記録し、重みは設定で後から変える。**
 * 一度合成してしまうと、重みを変えたときに過去のログが使えなくなる。
 */

export type RewardEvent =
  | "viewed"
  | "clicked"
  | "saved"
  | "liked"
  | "dismissed"
  | "read_partial"
  | "read_full"
  | "highlighted"
  | "favourited"
  // 「訳して読む」を押した（FR-U-14）。**正例でも負例でもない意図の記録。**
  // 保存 (`saved`) は重み 1.2 と全イベント中で最大なので、読むために押した
  // だけの記事にそれが付くと、興味の重心が実態から離れる。
  | "read_intent"
  // 上を押したのに観測窓を過ぎても何の反応も無かった（弱い負例）。
  // 派生イベントで、`runRewardJoin` が書く。
  | "read_abandoned";

/** §6.1 の既定重み。 */
export const DEFAULT_REWARD_WEIGHTS: Record<RewardEvent, number> = {
  viewed: 0,
  clicked: 0.2,
  saved: 1.2,
  liked: 1.0,
  dismissed: -1.0,
  read_partial: 0.5,
  read_full: 0.8,
  highlighted: 0.9,
  favourited: 1.0,
  // 意図そのものには報酬を与えない。読んだかどうかは read_partial /
  // read_full が別に測る。
  read_intent: 0,
  // 「読むつもりで開いたのに何も起きなかった」。`dismissed` (-1.0) より
  // 弱くする — 明示的に「興味なし」を押した人と、単に読まなかった人を
  // 同じ強さで扱うと、後者が多いぶん負例が過剰になる。
  read_abandoned: -0.4,
};

/**
 * `no_click` というイベントは定義しない。「押されなかったこと」は観測では
 * ないため（§6.3）。ここに足したくなったら、まず §6.3 を読み直すこと。
 */
export function computeReward(
  events: RewardEvent[],
  weights: Record<RewardEvent, number> = DEFAULT_REWARD_WEIGHTS,
): number {
  // 同じ種類のイベントが複数回あっても 1 回ぶんとして数える。誤タップで
  // 2 回押した記事の報酬が 2 倍になるのはおかしい。
  const unique = new Set(events);
  let reward = 0;
  for (const event of unique) {
    reward += weights[event] ?? 0;
  }
  return reward;
}

/** 強い正例（§6.2 の `P_b`）。 */
const STRONG_POSITIVES: RewardEvent[] = [
  "saved",
  "liked",
  "favourited",
  "highlighted",
  "read_full",
];

export function isStrongPositive(events: RewardEvent[]): boolean {
  return events.some((e) => STRONG_POSITIVES.includes(e));
}

/**
 * 空振りではないと見なすイベント。**`read_partial` を含めるのが要点**で、
 * 途中まで読んだものは負例にしない。
 */
const ENGAGEMENT_EVENTS: RewardEvent[] = [...STRONG_POSITIVES, "read_partial"];

/**
 * 「訳して読む」が空振りに終わったか（FR-U-14）。
 *
 * `read_intent` は押した時点では何も判断しない中立の記録で、観測窓を
 * 過ぎてから初めてここで評価する。何の engagement も無ければ
 * 「読もうとしたが、読むに値しなかった」という**弱い負例**にする。
 *
 * **判定は保守的にする。** 負例は偽陽性のコストが高い — 興味の重心が実態から
 * ずれ、以後その方向の記事が出なくなる。しかも本人には見えない。だから
 * 途中まで読んだもの (`read_partial`) も、既に明示的な負例がある
 * (`dismissed`) ものも対象外にする。
 *
 * 呼び出し側は**観測窓が満了した impression にだけ**適用すること。まだ窓の
 * 中のものに当てると、これから読む記事を先回りで負例にしてしまう。
 */
export function isAbandonedRead(events: RewardEvent[]): boolean {
  const seen = new Set(events);
  if (!seen.has("read_intent")) {
    return false;
  }
  if (seen.has("dismissed") || seen.has("read_abandoned")) {
    return false;
  }
  return !ENGAGEMENT_EVENTS.some((e) => seen.has(e));
}

export function isWeakPositive(events: RewardEvent[]): boolean {
  return !isStrongPositive(events) && events.includes("clicked");
}

export function isDismissed(events: RewardEvent[]): boolean {
  return events.includes("dismissed");
}

/** 読了率から遅延報酬のイベントを決める（§6.1）。 */
export function readingProgressEvent(
  percent: number | null | undefined,
): "read_partial" | "read_full" | null {
  if (percent === null || percent === undefined) {
    return null;
  }
  if (percent >= 60) {
    return "read_full";
  }
  if (percent >= 30) {
    return "read_partial";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 観測状態と examined の判定（§6.3）
// ---------------------------------------------------------------------------

export type ObservationState = "unobserved" | "partial" | "observed";

export interface ImpressionObservation {
  impressionId: string;
  rank: number | null;
  /** そのカードに `viewed` イベントがあるか。 */
  viewed: boolean;
}

export interface ObservationResult {
  state: ObservationState;
  deepestViewedRank: number | null;
  /** `examined = true` にする impression の id。 */
  examinedIds: string[];
}

/**
 * Briefing 全体の観測状態と、各 impression の `examined` を確定する。
 *
 * **通過証明が要点**（FR-F-06）。自分に `viewed` が無くても、より下位の
 * カードに `viewed` があれば、スクロールで飛ばされただけで視界には入って
 * いる。ここを見落とすと、速く読む人の記事がまとめて「見ていない」扱いに
 * なり、ペアの母集団が不当に小さくなる。
 *
 * 逆に、最後に `viewed` されたカードより下は `examined = false`。ここを
 * 甘くすると、見えていない記事が比較対象に入って**偽の負例**になる。
 */
export function finalizeObservation(
  impressions: ImpressionObservation[],
  opened: boolean,
): ObservationResult {
  if (!opened) {
    // 開かれていない Briefing には一切ラベルを付けない（FR-F-07）。
    return { state: "unobserved", deepestViewedRank: null, examinedIds: [] };
  }

  const ranked = impressions
    .filter((i) => i.rank !== null)
    .sort((a, b) => a.rank! - b.rank!);
  if (ranked.length === 0) {
    return { state: "partial", deepestViewedRank: null, examinedIds: [] };
  }

  const viewedRanks = ranked.filter((i) => i.viewed).map((i) => i.rank!);
  if (viewedRanks.length === 0) {
    // 開いたがカードが 1 枚も視界に入らなかった。開いた事実は残すが、
    // 比較対象になる記事は 1 件も無い。
    return { state: "partial", deepestViewedRank: null, examinedIds: [] };
  }

  const deepest = Math.max(...viewedRanks);
  const examinedIds = ranked
    .filter((i) => i.rank! <= deepest)
    .map((i) => i.impressionId);

  const lastRank = ranked[ranked.length - 1].rank!;
  return {
    state: deepest >= lastRank ? "observed" : "partial",
    deepestViewedRank: deepest,
    examinedIds,
  };
}
