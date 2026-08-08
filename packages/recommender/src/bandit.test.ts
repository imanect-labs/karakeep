import { describe, expect, it } from "vitest";

import {
  makeRng,
  posteriorFromCounts,
  posteriorMean,
  posteriorStdDev,
  sampleBeta,
  softmaxSampleWithoutReplacement,
  thompsonSelect,
} from "./bandit";

describe("posterior", () => {
  it("starts at the 0.2 prior", () => {
    expect(posteriorMean(posteriorFromCounts(0, 0))).toBeCloseTo(0.2, 6);
  });

  it("moves toward the observed rate as evidence accumulates", () => {
    const few = posteriorMean(posteriorFromCounts(1, 2));
    const many = posteriorMean(posteriorFromCounts(50, 100));
    expect(many).toBeGreaterThan(few);
    expect(many).toBeCloseTo(0.49, 1);
  });

  it("shrinks its uncertainty as evidence accumulates", () => {
    // これが Thompson Sampling が効く理由。証拠が少ないうちは幅が広い。
    expect(posteriorStdDev(posteriorFromCounts(1, 2))).toBeGreaterThan(
      posteriorStdDev(posteriorFromCounts(50, 100)),
    );
  });
});

describe("sampleBeta", () => {
  it("stays inside [0, 1]", () => {
    const rng = makeRng(5);
    for (let i = 0; i < 500; i++) {
      const draw = sampleBeta(posteriorFromCounts(3, 10), rng);
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThanOrEqual(1);
    }
  });

  it("has a mean close to the posterior mean", () => {
    const rng = makeRng(7);
    const posterior = posteriorFromCounts(6, 20);
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      sum += sampleBeta(posterior, rng);
    }
    expect(sum / n).toBeCloseTo(posteriorMean(posterior), 1);
  });

  it("is deterministic for a given seed", () => {
    const p = posteriorFromCounts(2, 5);
    expect(sampleBeta(p, makeRng(11))).toBe(sampleBeta(p, makeRng(11)));
  });
});

describe("thompsonSelect", () => {
  it("usually prefers the stronger arm", () => {
    const rng = makeRng(13);
    let strongWins = 0;
    for (let i = 0; i < 200; i++) {
      const [winner] = thompsonSelect(
        [
          { item: "strong", posterior: posteriorFromCounts(30, 40) },
          { item: "weak", posterior: posteriorFromCounts(1, 40) },
        ],
        1,
        rng,
      );
      if (winner === "strong") {
        strongWins++;
      }
    }
    expect(strongWins).toBeGreaterThan(190);
  });

  it("still gives an unproven arm a real chance", () => {
    // 事後平均だけで選ぶと、たまたま最初の数件が外れた新参が二度と
    // 選ばれない。探索が死ぬかどうかがここで決まる。
    const rng = makeRng(17);
    let unprovenWins = 0;
    for (let i = 0; i < 400; i++) {
      const [winner] = thompsonSelect(
        [
          { item: "proven", posterior: posteriorFromCounts(6, 20) },
          { item: "unproven", posterior: posteriorFromCounts(0, 0) },
        ],
        1,
        rng,
      );
      if (winner === "unproven") {
        unprovenWins++;
      }
    }
    expect(unprovenWins).toBeGreaterThan(40);
    expect(unprovenWins).toBeLessThan(360);
  });

  it("returns nothing for a non-positive count", () => {
    expect(thompsonSelect([], 3, makeRng(1))).toEqual([]);
    expect(
      thompsonSelect(
        [{ item: "a", posterior: posteriorFromCounts(1, 1) }],
        0,
        makeRng(1),
      ),
    ).toEqual([]);
  });

  it("caps at the number of arms available", () => {
    expect(
      thompsonSelect(
        [{ item: "a", posterior: posteriorFromCounts(1, 1) }],
        5,
        makeRng(1),
      ),
    ).toHaveLength(1);
  });
});

describe("softmaxSampleWithoutReplacement", () => {
  const items = [
    { item: "a", score: 1.0 },
    { item: "b", score: 0.9 },
    { item: "c", score: 0.2 },
    { item: "d", score: 0.1 },
  ];

  it("never repeats an item", () => {
    const picked = softmaxSampleWithoutReplacement(items, 4, 0.15, makeRng(3));
    expect(new Set(picked.map((p) => p.item)).size).toBe(4);
  });

  it("records a propensity in (0, 1] for every pick", () => {
    // propensity は後から復元できない唯一の値。ここが 0 や 1 に潰れると
    // Phase 5 のオフポリシー評価が原理的にできなくなる。
    for (const pick of softmaxSampleWithoutReplacement(
      items,
      3,
      0.15,
      makeRng(5),
    )) {
      expect(pick.propensity).toBeGreaterThan(0);
      expect(pick.propensity).toBeLessThanOrEqual(1);
    }
  });

  it("stays close to argmax at the default temperature", () => {
    // τ=0.15 なら体感の推薦品質を落とさない、というのが設計の主張。
    const rng = makeRng(23);
    let topFirst = 0;
    for (let i = 0; i < 200; i++) {
      const [first] = softmaxSampleWithoutReplacement(items, 1, 0.15, rng);
      if (first.item === "a") {
        topFirst++;
      }
    }
    expect(topFirst).toBeGreaterThan(100);
  });

  it("explores more as the temperature rises", () => {
    const count = (tau: number) => {
      const rng = makeRng(29);
      let notTop = 0;
      for (let i = 0; i < 200; i++) {
        const [first] = softmaxSampleWithoutReplacement(items, 1, tau, rng);
        if (first.item !== "a") {
          notTop++;
        }
      }
      return notTop;
    };
    expect(count(1.0)).toBeGreaterThan(count(0.05));
  });

  it("does not overflow when the temperature is tiny", () => {
    // exp(score/τ) は τ が小さいとすぐ Infinity になる。最大値を引いてから
    // 指数を取っているのはそのため。
    const picked = softmaxSampleWithoutReplacement(items, 4, 1e-6, makeRng(31));
    expect(picked).toHaveLength(4);
    for (const pick of picked) {
      expect(Number.isFinite(pick.propensity)).toBe(true);
    }
  });

  it("handles fewer items than requested", () => {
    expect(
      softmaxSampleWithoutReplacement(items.slice(0, 2), 5, 0.15, makeRng(1)),
    ).toHaveLength(2);
  });
});
