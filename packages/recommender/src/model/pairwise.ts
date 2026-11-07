import type { RewardEvent } from "../reward";
import { isStrongPositive } from "../reward";

// These are the immutable heuristic-v1 contributions already logged in production.
// Do not reconstruct past features with today's profile, or include shadow scores.
export const PAIRWISE_FEATURES = [
  "stable",
  "recent",
  "negative",
  "clusterPreference",
  "freshness",
  "repetition",
  "domain",
  "novelty",
  "rank",
] as const;

export interface TrainingItem {
  id: string;
  briefingId: string;
  date: string;
  features: Record<string, number>;
  events: RewardEvent[];
}

export interface TrainingPair {
  difference: number[];
  weight: number;
}

export function trainingVector(
  features: Record<string, number>,
  inference = false,
): number[] | null {
  const values = PAIRWISE_FEATURES.map((key) =>
    key === "rank" ? (inference ? 1 : features.rank) / 50 : features[key],
  );
  return values.every(Number.isFinite) ? values : null;
}

export function pairwiseScore(
  features: Record<string, number>,
  weights: number[],
  inference = true,
): number {
  const vector = trainingVector(features, inference);
  return vector
    ? vector.reduce((sum, value, i) => sum + value * weights[i], 0)
    : NaN;
}

function strength(item: TrainingItem): number {
  if (item.events.includes("dismissed")) return -1;
  if (isStrongPositive(item.events)) return 2;
  if (item.events.includes("clicked") || item.events.includes("read_partial"))
    return 1;
  // Intent/abandonment are not an examined, untouched comparison article.
  return item.events.every((e) => e === "viewed") ? 0 : NaN;
}

export function trainingGroups(items: TrainingItem[]): TrainingItem[][] {
  const groups = new Map<string, TrainingItem[]>();
  for (const item of items) {
    if (!trainingVector(item.features)) continue;
    const group = groups.get(item.briefingId) ?? [];
    group.push(item);
    groups.set(item.briefingId, group);
  }
  return [...groups.values()].sort((a, b) =>
    a[0].date.localeCompare(b[0].date),
  );
}

export function makeTrainingPairs(items: TrainingItem[]): TrainingPair[] {
  const pairs: TrainingPair[] = [];
  for (const group of trainingGroups(items)) {
    for (const positive of group) {
      const p = strength(positive);
      if (!Number.isFinite(p) || p < 0) continue;
      const opponents = group.filter((negative) => {
        const n = strength(negative);
        return n < p && (p > 0 || n === -1);
      });
      const x = trainingVector(positive.features)!;
      for (const negative of opponents) {
        const y = trainingVector(negative.features)!;
        const weight =
          strength(negative) === -1
            ? 1.5
            : p === 1 || strength(negative) === 1
              ? 0.3
              : 1;
        pairs.push({
          difference: x.map((v, i) => v - y[i]),
          weight: weight / opponents.length,
        });
      }
    }
  }
  return pairs;
}

export function fitPairwise(pairs: TrainingPair[], lambda: number): number[] {
  const weights = PAIRWISE_FEATURES.map(() => 0);
  const total = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  if (!total) return weights;
  for (let step = 0; step < 400; step++) {
    const gradient = weights.map((w) => lambda * w);
    for (const pair of pairs) {
      const score = pair.difference.reduce(
        (sum, v, i) => sum + v * weights[i],
        0,
      );
      const error = -1 / (1 + Math.exp(Math.max(-40, Math.min(40, score))));
      for (let i = 0; i < weights.length; i++)
        gradient[i] += (pair.weight / total) * error * pair.difference[i];
    }
    for (let i = 0; i < weights.length; i++) weights[i] -= 0.5 * gradient[i];
  }
  return weights;
}

export function evaluatePairwise(items: TrainingItem[], weights: number[]) {
  const pairs = makeTrainingPairs(items);
  let correct = 0;
  let total = 0;
  for (const pair of pairs) {
    // rank is a nuisance variable: evaluation and serving both fix it to 1.
    const score = pair.difference.reduce(
      (sum, v, i) => (i === weights.length - 1 ? sum : sum + v * weights[i]),
      0,
    );
    correct += pair.weight * (score > 0 ? 1 : score === 0 ? 0.5 : 0);
    total += pair.weight;
  }
  const ndcgs: number[] = [];
  for (const group of trainingGroups(items)) {
    const gain = (item: TrainingItem) => Math.max(0, strength(item)) || 0;
    const dcg = (ranked: TrainingItem[]) =>
      ranked
        .slice(0, 20)
        .reduce(
          (sum, item, i) => sum + (2 ** gain(item) - 1) / Math.log2(i + 2),
          0,
        );
    const ideal = dcg([...group].sort((a, b) => gain(b) - gain(a)));
    if (ideal > 0)
      ndcgs.push(
        dcg(
          [...group].sort(
            (a, b) =>
              pairwiseScore(b.features, weights) -
              pairwiseScore(a.features, weights),
          ),
        ) / ideal,
      );
  }
  return {
    pairAccuracy: total ? correct / total : 0,
    ndcg20: ndcgs.length ? ndcgs.reduce((a, b) => a + b, 0) / ndcgs.length : 0,
    pairs: pairs.length,
    briefings: ndcgs.length,
  };
}

export function selectRegularization(items: TrainingItem[]): number | null {
  const groups = trainingGroups(items);
  if (!groups.length) return null;
  const start = Date.parse(groups[0][0].date);
  const end = Date.parse(groups[groups.length - 1][0].date);
  const day = 86_400_000;
  const folds: { train: TrainingItem[]; test: TrainingItem[] }[] = [];
  for (
    let cutoff = start + 28 * day;
    cutoff + 14 * day <= end;
    cutoff += 14 * day
  ) {
    // Leave a seven-day gap so delayed rewards were known at the fold's cutoff.
    const train = items.filter((i) => Date.parse(i.date) < cutoff - 7 * day);
    const test = items.filter(
      (i) =>
        Date.parse(i.date) >= cutoff && Date.parse(i.date) < cutoff + 14 * day,
    );
    if (makeTrainingPairs(train).length && makeTrainingPairs(test).length)
      folds.push({ train, test });
  }
  if (!folds.length) return null;
  return [0.001, 0.01, 0.1, 1]
    .map((lambda) => ({
      lambda,
      score:
        folds.reduce(
          (sum, fold) =>
            sum +
            evaluatePairwise(
              fold.test,
              fitPairwise(makeTrainingPairs(fold.train), lambda),
            ).pairAccuracy,
          0,
        ) / folds.length,
    }))
    .sort((a, b) => b.score - a.score)[0].lambda;
}
