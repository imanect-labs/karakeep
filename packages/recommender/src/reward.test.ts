import { describe, expect, it } from "vitest";

import type { ImpressionObservation, RewardEvent } from "./reward";
import {
  computeReward,
  DEFAULT_REWARD_WEIGHTS,
  finalizeObservation,
  isDismissed,
  isStrongPositive,
  isWeakPositive,
  readingProgressEvent,
} from "./reward";

describe("computeReward", () => {
  it("sums the weights of the events that happened", () => {
    expect(computeReward(["clicked", "saved"])).toBeCloseTo(1.4, 6);
  });

  it("counts a repeated event once", () => {
    // 誤タップで 2 回押した記事の報酬が 2 倍になるのはおかしい。
    expect(computeReward(["liked", "liked"])).toBeCloseTo(1.0, 6);
  });

  it("gives an untouched impression zero, not a negative", () => {
    // 「押されなかったこと」は観測ではないので、罰にもしない。
    expect(computeReward([])).toBe(0);
    expect(computeReward(["viewed"])).toBe(0);
  });

  it("makes dismissal the only negative", () => {
    expect(computeReward(["dismissed"])).toBeLessThan(0);
  });

  it("does not define a no_click event", () => {
    expect(Object.keys(DEFAULT_REWARD_WEIGHTS)).not.toContain("no_click");
  });

  it("respects reweighting", () => {
    const weights = { ...DEFAULT_REWARD_WEIGHTS, saved: 5 };
    expect(computeReward(["saved"], weights)).toBe(5);
  });
});

describe("positive classification", () => {
  it("treats a save as a strong positive", () => {
    expect(isStrongPositive(["saved"])).toBe(true);
    expect(isWeakPositive(["saved"])).toBe(false);
  });

  it("treats a bare click as a weak positive", () => {
    expect(isWeakPositive(["clicked"])).toBe(true);
    expect(isStrongPositive(["clicked"])).toBe(false);
  });

  it("promotes a click that led to a save", () => {
    expect(isStrongPositive(["clicked", "saved"])).toBe(true);
    expect(isWeakPositive(["clicked", "saved"])).toBe(false);
  });

  it("recognizes dismissal", () => {
    expect(isDismissed(["viewed", "dismissed"])).toBe(true);
    expect(isDismissed(["viewed"])).toBe(false);
  });
});

describe("readingProgressEvent", () => {
  it("maps progress onto the delayed reward events", () => {
    expect(readingProgressEvent(80)).toBe("read_full");
    expect(readingProgressEvent(45)).toBe("read_partial");
    expect(readingProgressEvent(10)).toBeNull();
  });

  it("returns null when there is no progress record", () => {
    expect(readingProgressEvent(null)).toBeNull();
    expect(readingProgressEvent(undefined)).toBeNull();
  });
});

describe("finalizeObservation", () => {
  const briefing = (viewedRanks: number[], size = 5): ImpressionObservation[] =>
    Array.from({ length: size }, (_, i) => ({
      impressionId: `i${i + 1}`,
      rank: i + 1,
      viewed: viewedRanks.includes(i + 1),
    }));

  it("labels nothing when the briefing was never opened", () => {
    // FR-F-07: unobserved の impression には一切ラベルを付けない。
    const result = finalizeObservation(briefing([1, 2, 3]), false);
    expect(result.state).toBe("unobserved");
    expect(result.examinedIds).toEqual([]);
  });

  it("marks everything above the deepest view as examined", () => {
    // 通過証明。自分に viewed が無くても、より下位が見られていれば視界には
    // 入っている。ここを落とすと速く読む人の記事がまとめて除外される。
    const result = finalizeObservation(briefing([1, 4]), true);
    expect(result.examinedIds).toEqual(["i1", "i2", "i3", "i4"]);
    expect(result.deepestViewedRank).toBe(4);
    expect(result.state).toBe("partial");
  });

  it("leaves everything below the deepest view unexamined", () => {
    // ここを甘くすると、見えていない記事が比較対象に入って偽の負例になる。
    const result = finalizeObservation(briefing([1, 2]), true);
    expect(result.examinedIds).not.toContain("i3");
    expect(result.examinedIds).not.toContain("i5");
  });

  it("reaches observed only when the last card was seen", () => {
    expect(finalizeObservation(briefing([1, 5]), true).state).toBe("observed");
    expect(finalizeObservation(briefing([1, 4]), true).state).toBe("partial");
  });

  it("handles opening without seeing a single card", () => {
    const result = finalizeObservation(briefing([]), true);
    expect(result.state).toBe("partial");
    expect(result.examinedIds).toEqual([]);
  });

  it("handles an empty briefing", () => {
    const result = finalizeObservation([], true);
    expect(result.state).toBe("partial");
    expect(result.examinedIds).toEqual([]);
  });

  it("ignores shadow impressions, which have no rank", () => {
    const withShadow: ImpressionObservation[] = [
      { impressionId: "shown1", rank: 1, viewed: true },
      { impressionId: "shadow", rank: null, viewed: false },
    ];
    const result = finalizeObservation(withShadow, true);
    expect(result.examinedIds).toEqual(["shown1"]);
  });

  it("copes with ranks arriving out of order", () => {
    const shuffled: ImpressionObservation[] = [
      { impressionId: "i3", rank: 3, viewed: true },
      { impressionId: "i1", rank: 1, viewed: false },
      { impressionId: "i2", rank: 2, viewed: false },
    ];
    const result = finalizeObservation(shuffled, true);
    expect(result.examinedIds.sort()).toEqual(["i1", "i2", "i3"]);
    expect(result.state).toBe("observed");
  });
});

describe("reward weights as a whole", () => {
  it("ranks a save above a bare click by a wide margin", () => {
    // クリックだけを報酬にすると、扇情的なタイトルばかりが強化される。
    const events: RewardEvent[] = ["clicked"];
    expect(computeReward(["saved"])).toBeGreaterThan(computeReward(events) * 3);
  });

  it("lets reading depth outweigh a bare click", () => {
    expect(computeReward(["clicked", "read_full"])).toBeGreaterThan(
      computeReward(["clicked"]),
    );
  });
});
