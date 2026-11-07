import { describe, expect, it } from "vitest";

import type { TrainingItem } from "./pairwise";
import {
  evaluatePairwise,
  fitPairwise,
  makeTrainingPairs,
  PAIRWISE_FEATURES,
  pairwiseScore,
  selectRegularization,
  trainingVector,
} from "./pairwise";

function item(id: string, overrides: Partial<TrainingItem> = {}): TrainingItem {
  return {
    id,
    briefingId: "b",
    date: "2026-08-01",
    features: Object.fromEntries(
      PAIRWISE_FEATURES.map((key) => [key, key === "rank" ? 1 : 0]),
    ),
    events: ["viewed"],
    ...overrides,
  };
}

describe("pairwise training", () => {
  it("uses complete logged snapshots and ignores extra fields", () => {
    const features = item("a").features;
    expect(trainingVector({ ...features, "shadow:future": 999 })).toEqual(
      trainingVector(features),
    );
    expect(trainingVector({ ...features, stable: NaN })).toBeNull();
    expect(trainingVector({})).toBeNull();
    expect(trainingVector({ ...features, rank: 50 }, true)?.at(-1)).toBe(0.02);
  });

  it("never pairs articles from different briefings or labels untouched days", () => {
    expect(
      makeTrainingPairs([
        item("a", { events: ["saved"] }),
        item("b", { briefingId: "other" }),
      ]),
    ).toEqual([]);
    expect(makeTrainingPairs([item("a"), item("b")])).toEqual([]);
  });

  it("normalizes each positive's weight and discounts clicks", () => {
    const pairs = makeTrainingPairs([
      item("p", { events: ["saved", "saved"] }),
      item("n1"),
      item("n2"),
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs.reduce((sum, p) => sum + p.weight, 0)).toBe(1);
    expect(
      makeTrainingPairs([item("p", { events: ["clicked"] }), item("n")])[0]
        .weight,
    ).toBe(0.3);
  });

  it("uses dismissals even on days without positives and excludes read intents", () => {
    expect(
      makeTrainingPairs([item("a"), item("b", { events: ["dismissed"] })])[0]
        .weight,
    ).toBe(1.5);
    expect(
      makeTrainingPairs([
        item("a", { events: ["saved"] }),
        item("b", { events: ["read_intent"] }),
      ]),
    ).toEqual([]);
  });

  it("learns relative relevance and evaluates without position leakage", () => {
    const p = item("p", { events: ["saved"] });
    p.features.stable = 1;
    const n = item("n");
    n.features.rank = 20;
    const weights = fitPairwise(makeTrainingPairs([p, n]), 0.01);
    expect(pairwiseScore(p.features, weights)).toBeGreaterThan(
      pairwiseScore(n.features, weights),
    );
    expect(evaluatePairwise([p, n], weights).pairAccuracy).toBe(1);
    expect(evaluatePairwise([p, n], weights).ndcg20).toBe(1);
    expect(
      evaluatePairwise(
        [p, n],
        PAIRWISE_FEATURES.map((key) => (key === "rank" ? -10 : 0)),
      ).pairAccuracy,
    ).toBe(0.5);
  });

  it("requires enough chronological history for validation", () => {
    expect(
      selectRegularization([item("p", { events: ["saved"] }), item("n")]),
    ).toBeNull();
    const history = Array.from({ length: 70 }, (_, day) => {
      const date = new Date(Date.UTC(2026, 7, day + 1))
        .toISOString()
        .slice(0, 10);
      const p = item(`p${day}`, {
        briefingId: `b${day}`,
        date,
        events: ["saved"],
      });
      p.features.stable = 1;
      return [p, item(`n${day}`, { briefingId: `b${day}`, date })];
    }).flat();
    expect(selectRegularization(history)).not.toBeNull();
  });
});
