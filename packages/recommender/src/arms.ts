import { softmaxSampleWithoutReplacement } from "./bandit";

/**
 * 枠の混合（FR-R-02〜04b）。
 *
 * 記事レベルの探索。`trial` はソースレベルの探索で、この 2 階層があって
 * 初めて「候補の母集団そのもの」が広がる。
 */

export type Arm = "exploit" | "adjacent" | "uncertain" | "trial" | "random";

export interface ArmShares {
  exploit: number;
  adjacent: number;
  uncertain: number;
  trial: number;
  random: number;
}

export const DEFAULT_ARM_SHARES: ArmShares = {
  exploit: 0.55,
  adjacent: 0.2,
  uncertain: 0.1,
  // 既定は段階的有効化の前半 2 週に合わせる（trial 0% / random 15%）。
  trial: 0,
  random: 0.15,
};

/**
 * 探索枠のハードフロア（FR-R-02）。
 *
 * `uncertain + trial + random` は 25% を下回れない。モデルがどれだけ自信を
 * 持っていても削らない。ここを削れるようにすると、フィードバックループが
 * 必ず勝つ。
 */
export const MIN_EXPLORATION_SHARE = 0.25;

export interface DiversityLimits {
  /** 同一クラスタからの採用上限（FR-R-03）。 */
  maxPerCluster: number;
  /** 同一ドメインからの採用上限（FR-R-03）。 */
  maxPerDomain: number;
  /** 試用ドメイン由来の記事の上限（FR-R-02b）。 */
  maxTrialArticles: number;
}

export const DEFAULT_DIVERSITY: DiversityLimits = {
  maxPerCluster: 3,
  maxPerDomain: 2,
  maxTrialArticles: 2,
};

export interface RankableCandidate {
  id: string;
  score: number;
  uncertainty: number;
  clusterId: string | null;
  domainId: string | null;
  /** 試用中のドメイン由来か。`trial` 枠の対象。 */
  isTrialDomain: boolean;
  /** プロフィール非依存のソース由来か。`random` 枠の対象。 */
  profileIndependent: boolean;
}

export interface Selection {
  candidateId: string;
  arm: Arm;
  rank: number;
  /** `P(枠) × P(記事 | 枠)`。後から復元できないので必ず記録する。 */
  propensity: number;
}

export interface MixOptions {
  size: number;
  shares?: ArmShares;
  diversity?: DiversityLimits;
  temperature?: number;
  rng: () => number;
}

/**
 * 枠ごとのスロット数を出す。端数は exploit に寄せる。
 *
 * 探索枠が floor で削られると、20 件中 10% の `uncertain` が 2 件のはずが
 * 1 件になるようなことが起きる。**探索側を先に切り上げ**、余りを exploit で
 * 吸収する。
 */
export function allocateSlots(
  size: number,
  shares: ArmShares,
): Record<Arm, number> {
  const explorationArms: Arm[] = ["adjacent", "uncertain", "trial", "random"];
  const slots: Record<Arm, number> = {
    exploit: 0,
    adjacent: 0,
    uncertain: 0,
    trial: 0,
    random: 0,
  };

  let assigned = 0;
  for (const arm of explorationArms) {
    const count = Math.min(size - assigned, Math.ceil(size * shares[arm]));
    slots[arm] = Math.max(0, count);
    assigned += slots[arm];
  }
  slots.exploit = Math.max(0, size - assigned);
  return slots;
}

/** 設定された枠配分がハードフロアを満たしているか（FR-R-02）。 */
export function validateShares(shares: ArmShares): string | null {
  const exploration = shares.uncertain + shares.trial + shares.random;
  if (exploration < MIN_EXPLORATION_SHARE - 1e-9) {
    return `exploration share ${exploration.toFixed(2)} is below the ${MIN_EXPLORATION_SHARE} floor`;
  }
  const total =
    shares.exploit +
    shares.adjacent +
    shares.uncertain +
    shares.trial +
    shares.random;
  if (Math.abs(total - 1) > 0.01) {
    return `arm shares sum to ${total.toFixed(2)}, not 1`;
  }
  return null;
}

/**
 * 1 Briefing 分の選定。
 *
 * 枠の順序が意味を持つ。**`trial` を先に取る**。最後に回すと、多様性制約で
 * 席が埋まったあとに試用記事が入る余地が無くなり、ソース探索が静かに死ぬ。
 * 逆に `exploit` は最後でも困らない — 候補が最も多いので、制約に引っかかって
 * も次点がいくらでもある。
 */
export function mixArms(
  candidates: RankableCandidate[],
  opts: MixOptions,
): Selection[] {
  const shares = opts.shares ?? DEFAULT_ARM_SHARES;
  const diversity = opts.diversity ?? DEFAULT_DIVERSITY;
  const temperature = opts.temperature ?? 0.15;
  const slots = allocateSlots(opts.size, shares);

  const taken = new Set<string>();
  const perCluster = new Map<string, number>();
  const perDomain = new Map<string, number>();
  let trialArticles = 0;
  const selections: Selection[] = [];

  const fits = (candidate: RankableCandidate): boolean => {
    if (taken.has(candidate.id)) {
      return false;
    }
    if (
      candidate.clusterId &&
      (perCluster.get(candidate.clusterId) ?? 0) >= diversity.maxPerCluster
    ) {
      return false;
    }
    if (
      candidate.domainId &&
      (perDomain.get(candidate.domainId) ?? 0) >= diversity.maxPerDomain
    ) {
      return false;
    }
    if (
      candidate.isTrialDomain &&
      trialArticles >= diversity.maxTrialArticles
    ) {
      return false;
    }
    return true;
  };

  const commit = (
    candidate: RankableCandidate,
    arm: Arm,
    propensity: number,
  ) => {
    taken.add(candidate.id);
    if (candidate.clusterId) {
      perCluster.set(
        candidate.clusterId,
        (perCluster.get(candidate.clusterId) ?? 0) + 1,
      );
    }
    if (candidate.domainId) {
      perDomain.set(
        candidate.domainId,
        (perDomain.get(candidate.domainId) ?? 0) + 1,
      );
    }
    if (candidate.isTrialDomain) {
      trialArticles++;
    }
    selections.push({
      candidateId: candidate.id,
      arm,
      rank: selections.length + 1,
      propensity: shares[arm] * propensity,
    });
  };

  // --- trial: 試用ドメイン由来からのみ ---
  fillByScore(
    candidates.filter((c) => c.isTrialDomain),
    slots.trial,
    "trial",
    temperature,
    opts.rng,
    fits,
    commit,
  );

  // --- uncertain: スコア上位 30% に絞ってから不確実性の大きい順 ---
  // 絞らないと「有望ではないが単に特徴が外れ値なだけの記事」が毎回選ばれる
  // （FR-R-03c）。
  const byScore = [...candidates].sort((a, b) => b.score - a.score);
  const topSlice = byScore.slice(
    0,
    Math.max(1, Math.ceil(byScore.length * 0.3)),
  );
  const uncertainPool = [...topSlice].sort(
    (a, b) => b.uncertainty - a.uncertainty,
  );
  fillDeterministically(
    uncertainPool,
    slots.uncertain,
    "uncertain",
    fits,
    commit,
  );

  // --- random: プロフィール非依存から一様に ---
  fillUniformly(
    candidates.filter((c) => c.profileIndependent),
    slots.random,
    opts.rng,
    fits,
    commit,
    // 非依存ソースが枯れている日は候補全体から引く。枠を空けたままにしない。
    candidates,
  );

  // --- adjacent: 未提示クラスタの中でスコアの高いもの ---
  const usedClusters = new Set(perCluster.keys());
  const adjacentPool = candidates.filter(
    (c) => c.clusterId && !usedClusters.has(c.clusterId),
  );
  fillByScore(
    adjacentPool,
    slots.adjacent,
    "adjacent",
    temperature,
    opts.rng,
    fits,
    commit,
  );

  // --- exploit: 残り全部から ---
  const remainingSlots = opts.size - selections.length;
  fillByScore(
    candidates,
    remainingSlots,
    "exploit",
    temperature,
    opts.rng,
    fits,
    commit,
  );

  return selections;
}

/**
 * 温度つき softmax の非復元抽出で埋める（FR-R-04b）。
 *
 * argmax にしないのは propensity を実値で残すため。これが無いと Phase 5 の
 * オフポリシー評価が原理的にできない。
 */
function fillByScore(
  pool: RankableCandidate[],
  slots: number,
  arm: Arm,
  temperature: number,
  rng: () => number,
  fits: (c: RankableCandidate) => boolean,
  commit: (c: RankableCandidate, arm: Arm, propensity: number) => void,
): void {
  if (slots <= 0) {
    return;
  }
  const eligible = pool.filter(fits);
  if (eligible.length === 0) {
    return;
  }
  // 制約に引っかかる候補が出るので、必要数より多めに引いてから絞る。
  const drawn = softmaxSampleWithoutReplacement(
    eligible.map((c) => ({ item: c, score: c.score })),
    Math.min(eligible.length, slots * 4),
    temperature,
    rng,
  );

  let filled = 0;
  for (const { item, propensity } of drawn) {
    if (filled >= slots) {
      return;
    }
    if (!fits(item)) {
      continue;
    }
    commit(item, arm, propensity);
    filled++;
  }
}

function fillDeterministically(
  pool: RankableCandidate[],
  slots: number,
  arm: Arm,
  fits: (c: RankableCandidate) => boolean,
  commit: (c: RankableCandidate, arm: Arm, propensity: number) => void,
): void {
  let filled = 0;
  for (const candidate of pool) {
    if (filled >= slots) {
      return;
    }
    if (!fits(candidate)) {
      continue;
    }
    // 決定的に選んでいるので、この枠の中での選出確率は 1。
    commit(candidate, arm, 1);
    filled++;
  }
}

function fillUniformly(
  pool: RankableCandidate[],
  slots: number,
  rng: () => number,
  fits: (c: RankableCandidate) => boolean,
  commit: (c: RankableCandidate, arm: Arm, propensity: number) => void,
  fallbackPool: RankableCandidate[],
): void {
  if (slots <= 0) {
    return;
  }
  let eligible = pool.filter(fits);
  if (eligible.length === 0) {
    eligible = fallbackPool.filter(fits);
  }
  let filled = 0;
  while (filled < slots && eligible.length > 0) {
    const index = Math.floor(rng() * eligible.length);
    const candidate = eligible[index];
    eligible.splice(index, 1);
    if (!fits(candidate)) {
      continue;
    }
    // 一様抽出なので選出確率は厳密に分かる。random 枠だけは元から
    // 正確な IPS が可能（§12）。
    commit(candidate, "random", 1 / (eligible.length + 1));
    filled++;
  }
}
