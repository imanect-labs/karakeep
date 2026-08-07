import type { BetaPosterior, ThompsonArm } from "../bandit";
import {
  posteriorFromCounts,
  posteriorMean,
  PRIOR_MEAN,
  thompsonSelect,
} from "../bandit";

/**
 * ドメインのライフサイクル（FR-D-13〜16）。
 *
 * ```
 * discovered ──品質ゲート──► screened ──試用枠──► trial ──昇格──► subscribed
 *                                                                    │
 *                                                        dormant ◄───┘
 * ```
 *
 * 設計の中心は「席は上限ではなく定数」という点にある。上限 300 のような
 * 設計だと降格条件が発火せず、一度入った平凡なサイトが不死身になる。
 * 1 日 20 枠を 300 ドメインで分けると、降格判定に必要な提示数が貯まるのに
 * 400 日以上かかるため。
 */

export type DomainStatus =
  | "discovered"
  | "screened"
  | "trial"
  | "subscribed"
  | "dormant"
  | "rejected"
  | "retired";

/** 購読席の既定数。feedback loop が実際に評価しきれる規模（40〜90）から。 */
export const DEFAULT_DOMAIN_SEATS = 80;

/** 同時に試用できるドメイン数（FR-D-16c）。クロール先への礼儀の側。 */
export const DEFAULT_MAX_TRIAL_DOMAINS = 10;

/** 試用の打ち切り条件（FR-D-13）。 */
export const TRIAL_MAX_ARTICLES = 6;
export const TRIAL_MAX_DAYS = 28;

/** 昇格に必要な最低 examined 数（FR-D-14）。 */
export const PROMOTION_MIN_EXAMINED = 6;

/** 埋没判定（FR-D-15b）。examined の蓄積に依存しない降格条件。 */
export const BURIED_DAYS = 60;

/** 更新が止まったドメイン（FR-D-15c）。 */
export const STALE_DAYS = 90;

/** 直近この件数の examined で正例ゼロなら降格（FR-D-15a）。 */
export const DEMOTE_EXAMINED_WINDOW = 20;

export interface DomainState {
  id: string;
  status: DomainStatus;
  examinedCount: number;
  positiveCount: number;
  /** 直近 `DEMOTE_EXAMINED_WINDOW` 件の examined のうちの正例数。 */
  recentPositiveCount?: number;
  recentExaminedCount?: number;
  trialStartedAt?: Date | null;
  trialImpressionCount?: number;
  /** 最後に Briefing に選ばれた日。埋没判定の基準。 */
  lastSelectedAt?: Date | null;
  lastArticleAt?: Date | null;
  promotedAt?: Date | null;
  manualDecision?: "subscribe" | "reject" | null;
}

export function stateToPosterior(state: DomainState): BetaPosterior {
  return posteriorFromCounts(state.positiveCount, state.examinedCount);
}

export function stateToMean(state: DomainState): number {
  return posteriorMean(stateToPosterior(state));
}

// ---------------------------------------------------------------------------
// 試用への投入
// ---------------------------------------------------------------------------

export interface TrialIntakeOptions {
  maxTrialDomains?: number;
  rng: () => number;
}

/**
 * `screened` から試用に上げるドメインを Thompson Sampling で選ぶ（FR-D-13）。
 *
 * 事後平均の高い順ではないのが要点。平均だけで選ぶと、証拠がまだ無い
 * ドメイン（全部が事前値 0.2 で並ぶ）の中で id 順のような無意味な基準に
 * 落ち、しかも一度外れた新参が二度と選ばれない。
 */
export function planTrialIntake(
  screened: DomainState[],
  currentTrialCount: number,
  opts: TrialIntakeOptions,
): string[] {
  const maxTrials = opts.maxTrialDomains ?? DEFAULT_MAX_TRIAL_DOMAINS;
  const vacancies = maxTrials - currentTrialCount;
  if (vacancies <= 0 || screened.length === 0) {
    return [];
  }

  // 手動で「購読」と判断されたものはモデルの判定より優先する（FR-D-17）。
  const manual = screened.filter((d) => d.manualDecision === "subscribe");
  if (manual.length >= vacancies) {
    return manual.slice(0, vacancies).map((d) => d.id);
  }

  const rest: ThompsonArm<string>[] = screened
    .filter((d) => d.manualDecision !== "subscribe")
    .map((d) => ({ item: d.id, posterior: stateToPosterior(d) }));

  return [
    ...manual.map((d) => d.id),
    ...thompsonSelect(rest, vacancies - manual.length, opts.rng),
  ];
}

// ---------------------------------------------------------------------------
// 試用の打ち切り
// ---------------------------------------------------------------------------

/** 試用の期限が来ているか（記事 6 件 または 4 週間）。 */
export function isTrialComplete(state: DomainState, now: Date): boolean {
  if ((state.trialImpressionCount ?? 0) >= TRIAL_MAX_ARTICLES) {
    return true;
  }
  if (!state.trialStartedAt) {
    return false;
  }
  const days = (now.getTime() - state.trialStartedAt.getTime()) / 86_400_000;
  return days >= TRIAL_MAX_DAYS;
}

// ---------------------------------------------------------------------------
// 昇格と押し出し
// ---------------------------------------------------------------------------

export interface Promotion {
  domainId: string;
  /** 押し出される現職。空席に入る場合は null。 */
  displacedDomainId: string | null;
}

export interface Demotion {
  domainId: string;
  reason: "displaced" | "no_positives" | "buried" | "stale" | "trial_failed";
}

export interface PromotionPlan {
  promotions: Promotion[];
  demotions: Demotion[];
}

export interface PromotionOptions {
  seats?: number;
  now: Date;
}

/**
 * 昇格・降格をまとめて計画する（FR-D-14 / FR-D-15）。
 *
 * 順序が意味を持つ。**先に現職の降格を確定させてから**空席を数える。
 * 逆にすると、降格予定の現職が「押し出す相手」として残り、押し出せる
 * はずの新人が弾かれる。
 */
export function planPromotions(
  trials: DomainState[],
  subscribed: DomainState[],
  opts: PromotionOptions,
): PromotionPlan {
  const seats = opts.seats ?? DEFAULT_DOMAIN_SEATS;
  const demotions = planDemotions(subscribed, opts.now);
  const demotedIds = new Set(demotions.map((d) => d.domainId));

  const incumbents = subscribed
    .filter((d) => !demotedIds.has(d.id))
    .map((d) => ({ state: d, mean: stateToMean(d) }))
    // 弱い順。押し出す相手は先頭から取る。
    .sort((a, b) => a.mean - b.mean || (a.state.id < b.state.id ? -1 : 1));

  // 試用が終わったドメインだけが昇格の対象。
  const finished = trials.filter((d) => isTrialComplete(d, opts.now));
  const manualSubscribe = finished.filter(
    (d) => d.manualDecision === "subscribe",
  );
  const eligible = finished
    .filter(
      (d) =>
        d.manualDecision !== "subscribe" &&
        d.manualDecision !== "reject" &&
        d.examinedCount >= PROMOTION_MIN_EXAMINED,
    )
    .map((d) => ({ state: d, mean: stateToMean(d) }))
    // 強い順。良い候補から席を取る。
    .sort((a, b) => b.mean - a.mean || (a.state.id < b.state.id ? -1 : 1));

  const admissionFloor = seatAdmissionFloor(incumbents.map((i) => i.mean));

  const promotions: Promotion[] = [];
  let occupied = incumbents.length;
  let displaceIndex = 0;

  // 手動判断は席の空きに関係なく通す。人間の一発判断はモデルより優先する。
  for (const domain of manualSubscribe) {
    promotions.push({ domainId: domain.id, displacedDomainId: null });
    occupied++;
  }

  for (const candidate of eligible) {
    if (occupied < seats) {
      // 空席でも無条件には座らせない（FR-D-14）。examined を積んだうえで
      // 事後が下限を割っているドメインは、席が空いていても入れる価値がない。
      // 「試したが駄目だった」ことが分かっている相手を入れるのは、
      // 「まだ何も分かっていない」相手を入れるより悪い。
      if (candidate.mean < admissionFloor) {
        break;
      }
      promotions.push({
        domainId: candidate.state.id,
        displacedDomainId: null,
      });
      occupied++;
      continue;
    }
    // 満席。最下位の現職を上回れる場合にのみ押し出す。
    const weakest = incumbents[displaceIndex];
    if (!weakest || candidate.mean <= weakest.mean) {
      // 以降の候補はさらに弱いので、ここで打ち切ってよい。
      break;
    }
    promotions.push({
      domainId: candidate.state.id,
      displacedDomainId: weakest.state.id,
    });
    demotions.push({ domainId: weakest.state.id, reason: "displaced" });
    displaceIndex++;
  }

  // 昇格しなかった「試用終了」ドメインは試用失敗として dormant に落とす。
  const promotedIds = new Set(promotions.map((p) => p.domainId));
  for (const domain of finished) {
    if (!promotedIds.has(domain.id)) {
      demotions.push({ domainId: domain.id, reason: "trial_failed" });
    }
  }

  return { promotions, demotions };
}

/**
 * 現職が十分に揃うまでは四分位を使わない最小人数。1〜2 件しかない集合の
 * 下位四分位は、その 1 件の成績そのもの。最初に入った優秀なドメインが
 * 基準になってしまい、以後どのドメインも入れなくなる。
 */
const MIN_INCUMBENTS_FOR_QUARTILE = 8;

/**
 * 空席に座るための下限（FR-D-14）。
 *
 * 現職が少ないうちは事前平均（0.2）だけを下限にする。「まだ何も分かって
 * いない」ドメインと同程度には期待できることを要求する、という意味。
 * 現職が揃ったら、そこへ現職の下位四分位を重ねる。
 */
function seatAdmissionFloor(incumbentMeans: number[]): number {
  const priorFloor = PRIOR_MEAN;
  if (incumbentMeans.length < MIN_INCUMBENTS_FOR_QUARTILE) {
    return priorFloor;
  }
  const sorted = [...incumbentMeans].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  return Math.max(priorFloor, q1);
}

/**
 * 現職の降格（FR-D-15）。
 *
 * **埋没判定が要**。降格条件を `examined` の蓄積だけに依存させると、
 * exploit 枠が良いドメインに集中するせいで平凡なドメインは提示されず、
 * 提示されないから評価されず、評価されないから降格しない、という
 * 不死身のループに入る。「60 日間 1 度も選ばれなかった」はそのループを
 * 外から断ち切る。
 */
export function planDemotions(
  subscribed: DomainState[],
  now: Date,
): Demotion[] {
  const demotions: Demotion[] = [];
  for (const domain of subscribed) {
    if (domain.manualDecision === "subscribe") {
      // 手動で購読と決めたものは自動降格させない。
      continue;
    }
    const reason = demotionReason(domain, now);
    if (reason) {
      demotions.push({ domainId: domain.id, reason });
    }
  }
  return demotions;
}

function demotionReason(
  domain: DomainState,
  now: Date,
): Demotion["reason"] | null {
  const recentExamined = domain.recentExaminedCount ?? 0;
  const recentPositive = domain.recentPositiveCount ?? 0;
  if (recentExamined >= DEMOTE_EXAMINED_WINDOW && recentPositive === 0) {
    return "no_positives";
  }

  // 埋没判定は「購読してから」数える。昇格直後のドメインを、まだ選ばれる
  // 機会が無いうちに落とさないため。
  const buriedSince = domain.lastSelectedAt ?? domain.promotedAt;
  if (buriedSince && daysBetween(buriedSince, now) >= BURIED_DAYS) {
    return "buried";
  }

  if (
    domain.lastArticleAt &&
    daysBetween(domain.lastArticleAt, now) >= STALE_DAYS
  ) {
    return "stale";
  }
  return null;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/**
 * 席数が妥当かの検算（FR-D-15b）。
 *
 * 「下位四分位のドメインが 120 日以内に examined 20 件へ到達できる」ことを
 * 満たす最大の席数を返す。実測の提示数から四半期ごとに見直す。
 */
export function recommendedSeatCount(opts: {
  dailyBriefingSize: number;
  observationRate: number;
  /** 下位 75% のドメインへ回る枠の割合。exploit の集中を織り込んだ実測値。 */
  tailShare?: number;
  targetDays?: number;
  examinedForDecision?: number;
}): number {
  const tailShare = opts.tailShare ?? 0.4;
  const targetDays = opts.targetDays ?? 120;
  const examinedForDecision =
    opts.examinedForDecision ?? DEMOTE_EXAMINED_WINDOW;

  const examinedPerDay = opts.dailyBriefingSize * opts.observationRate;
  const tailExaminedPerDay = examinedPerDay * tailShare;
  const tailCapacity = (tailExaminedPerDay * targetDays) / examinedForDecision;
  // 下位 75% が `tailCapacity` 件なので、全体はその 4/3 倍。
  return Math.max(1, Math.round((tailCapacity * 4) / 3));
}
