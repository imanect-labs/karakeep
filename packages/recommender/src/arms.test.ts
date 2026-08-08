import { describe, expect, it } from "vitest";

import { allocateSlots, mixArms, validateShares } from "./arms";
import type { ArmShares, RankableCandidate } from "./arms";
import { makeRng } from "./bandit";

const BASELINE: ArmShares = {
  exploit: 0.55,
  adjacent: 0.2,
  uncertain: 0.1,
  trial: 0,
  random: 0.15,
};

const ROLLED_OUT: ArmShares = {
  exploit: 0.55,
  adjacent: 0.2,
  uncertain: 0.1,
  trial: 0.1,
  random: 0.05,
};

function candidate(
  id: string,
  overrides: Partial<RankableCandidate> = {},
): RankableCandidate {
  return {
    id,
    score: 0.5,
    uncertainty: 0.5,
    clusterId: `cluster-${id}`,
    domainId: `domain-${id}`,
    isTrialDomain: false,
    profileIndependent: false,
    ...overrides,
  };
}

function pool(size: number, overrides: Partial<RankableCandidate> = {}) {
  return Array.from({ length: size }, (_, i) =>
    candidate(`c${i}`, { score: 1 - i * 0.01, ...overrides }),
  );
}

describe("allocateSlots", () => {
  it("adds up to the briefing size", () => {
    const slots = allocateSlots(20, ROLLED_OUT);
    expect(Object.values(slots).reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("rounds exploration up, not down", () => {
    // floor で削られると 10% の uncertain が 2 件のはずが 1 件になる。
    const slots = allocateSlots(20, ROLLED_OUT);
    expect(slots.uncertain).toBe(2);
    expect(slots.trial).toBe(2);
    expect(slots.random).toBe(1);
  });

  it("gives trial nothing during the baseline fortnight", () => {
    expect(allocateSlots(20, BASELINE).trial).toBe(0);
    expect(allocateSlots(20, BASELINE).random).toBe(3);
  });

  it("never over-allocates on a tiny briefing", () => {
    const slots = allocateSlots(3, ROLLED_OUT);
    expect(Object.values(slots).reduce((a, b) => a + b, 0)).toBe(3);
    expect(slots.exploit).toBeGreaterThanOrEqual(0);
  });
});

describe("validateShares", () => {
  it("accepts both rollout steps", () => {
    expect(validateShares(BASELINE)).toBeNull();
    expect(validateShares(ROLLED_OUT)).toBeNull();
  });

  it("rejects starving exploration", () => {
    // モデルがどれだけ自信を持っていても探索は削らせない。
    expect(
      validateShares({
        exploit: 0.9,
        adjacent: 0.05,
        uncertain: 0.02,
        trial: 0.01,
        random: 0.02,
      }),
    ).toMatch(/below the 0.25 floor/);
  });

  it("rejects shares that do not sum to one", () => {
    expect(validateShares({ ...ROLLED_OUT, exploit: 0.9 })).toMatch(/sum to/);
  });
});

describe("mixArms", () => {
  it("fills the briefing without repeating a candidate", () => {
    const selections = mixArms(pool(100), {
      size: 20,
      shares: BASELINE,
      rng: makeRng(1),
    });
    expect(selections).toHaveLength(20);
    expect(new Set(selections.map((s) => s.candidateId)).size).toBe(20);
  });

  it("numbers ranks from 1 with no gaps", () => {
    const selections = mixArms(pool(100), {
      size: 10,
      shares: BASELINE,
      rng: makeRng(2),
    });
    expect(selections.map((s) => s.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("records a usable propensity for every slot", () => {
    // argmax だと 0 か 1 にしかならず、オフポリシー評価が原理的に不可能。
    const selections = mixArms(pool(100), {
      size: 20,
      shares: ROLLED_OUT,
      rng: makeRng(3),
    });
    for (const selection of selections) {
      expect(selection.propensity).toBeGreaterThan(0);
      expect(selection.propensity).toBeLessThanOrEqual(1);
    }
  });

  it("respects the per-cluster cap", () => {
    const crowded = pool(60).map((c, i) => ({
      ...c,
      clusterId: `cluster-${i % 3}`,
      domainId: `domain-${i}`,
    }));
    const selections = mixArms(crowded, {
      size: 20,
      shares: BASELINE,
      rng: makeRng(5),
    });
    const perCluster = new Map<string, number>();
    for (const selection of selections) {
      const c = crowded.find((x) => x.id === selection.candidateId)!;
      perCluster.set(c.clusterId!, (perCluster.get(c.clusterId!) ?? 0) + 1);
    }
    for (const count of perCluster.values()) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it("respects the per-domain cap", () => {
    const crowded = pool(60).map((c, i) => ({
      ...c,
      clusterId: `cluster-${i}`,
      domainId: `domain-${i % 4}`,
    }));
    const selections = mixArms(crowded, {
      size: 20,
      shares: BASELINE,
      rng: makeRng(7),
    });
    const perDomain = new Map<string, number>();
    for (const selection of selections) {
      const c = crowded.find((x) => x.id === selection.candidateId)!;
      perDomain.set(c.domainId!, (perDomain.get(c.domainId!) ?? 0) + 1);
    }
    for (const count of perDomain.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it("shows at most two trial articles", () => {
    // 毎朝ゴミを見せられて Briefing 自体を見なくなるのを避ける。
    const withTrials = [
      ...pool(40),
      ...Array.from({ length: 20 }, (_, i) =>
        candidate(`t${i}`, { score: 0.99, isTrialDomain: true }),
      ),
    ];
    const selections = mixArms(withTrials, {
      size: 20,
      shares: ROLLED_OUT,
      rng: makeRng(11),
    });
    const trialCount = selections.filter((s) => {
      const c = withTrials.find((x) => x.id === s.candidateId)!;
      return c.isTrialDomain;
    }).length;
    expect(trialCount).toBeLessThanOrEqual(2);
  });

  it("gives trial its slots even when the pool is crowded", () => {
    // trial を最後に回すと、多様性制約で席が埋まってソース探索が静かに死ぬ。
    const withTrials = [
      // 試用記事はスコアが低い。exploit では絶対に選ばれない。
      ...Array.from({ length: 5 }, (_, i) =>
        candidate(`t${i}`, { score: 0.01, isTrialDomain: true }),
      ),
      ...pool(100),
    ];
    const selections = mixArms(withTrials, {
      size: 20,
      shares: ROLLED_OUT,
      rng: makeRng(13),
    });
    expect(selections.some((s) => s.arm === "trial")).toBe(true);
  });

  it("shows no trial articles during the baseline fortnight", () => {
    const withTrials = [
      ...Array.from({ length: 10 }, (_, i) =>
        candidate(`t${i}`, { score: 0.99, isTrialDomain: true }),
      ),
      ...pool(50),
    ];
    const selections = mixArms(withTrials, {
      size: 20,
      shares: BASELINE,
      rng: makeRng(17),
    });
    expect(selections.some((s) => s.arm === "trial")).toBe(false);
  });

  it("draws the uncertain arm from the top of the score distribution", () => {
    // 絞らないと「有望ではないが単に特徴が外れ値なだけの記事」が毎回選ばれる。
    const candidates = [
      ...Array.from({ length: 50 }, (_, i) =>
        candidate(`good${i}`, { score: 0.9 - i * 0.001, uncertainty: 0.1 }),
      ),
      // スコアは最下位だが不確実性は最大、という罠。
      candidate("outlier", { score: -5, uncertainty: 1 }),
    ];
    const selections = mixArms(candidates, {
      size: 20,
      shares: ROLLED_OUT,
      rng: makeRng(19),
    });
    const outlier = selections.find((s) => s.candidateId === "outlier");
    expect(outlier?.arm).not.toBe("uncertain");
  });

  it("falls back to the whole pool when no profile-independent source produced anything", () => {
    // 非依存ソースが枯れている日に random 枠を空けたままにしない。
    const selections = mixArms(pool(50, { profileIndependent: false }), {
      size: 20,
      shares: BASELINE,
      rng: makeRng(23),
    });
    expect(selections.filter((s) => s.arm === "random").length).toBeGreaterThan(
      0,
    );
  });

  it("returns what it can when the pool is smaller than the briefing", () => {
    const selections = mixArms(pool(5), {
      size: 20,
      shares: BASELINE,
      rng: makeRng(29),
    });
    expect(selections).toHaveLength(5);
  });

  it("returns nothing for an empty pool", () => {
    expect(mixArms([], { size: 20, rng: makeRng(31) })).toEqual([]);
  });

  it("is deterministic for a given seed", () => {
    const candidates = pool(60);
    const a = mixArms(candidates, { size: 20, rng: makeRng(37) });
    const b = mixArms(candidates, { size: 20, rng: makeRng(37) });
    expect(a).toEqual(b);
  });
});
