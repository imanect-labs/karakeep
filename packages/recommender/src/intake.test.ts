import { describe, expect, it } from "vitest";

import type { IntakeBucket } from "./intake";
import {
  allocateIntake,
  assignFetchTiers,
  DEFAULT_DAILY_INTAKE_CAP,
  isDueForFetch,
} from "./intake";

function bucket(
  id: string,
  weight: number,
  available: number,
  profileIndependent = false,
): IntakeBucket {
  return { id, weight, available, profileIndependent };
}

function total(allocation: Map<string, number>): number {
  return [...allocation.values()].reduce((a, b) => a + b, 0);
}

describe("allocateIntake", () => {
  it("takes everything when the day's supply is under the cap", () => {
    const allocation = allocateIntake([
      bucket("a", 0.5, 10),
      bucket("b", 0.1, 20),
    ]);
    expect(allocation.get("a")).toBe(10);
    expect(allocation.get("b")).toBe(20);
  });

  it("never exceeds the cap", () => {
    const buckets = Array.from({ length: 50 }, (_, i) =>
      bucket(`s${i}`, 0.3, 100),
    );
    expect(total(allocateIntake(buckets))).toBe(DEFAULT_DAILY_INTAKE_CAP);
  });

  it("decouples pool size from domain count", () => {
    // ドメインが 4 倍になっても取り込み総数は変わらない。この性質が
    // 埋め込みコスト・ランキング時間・SQLite サイズの上限を決めている。
    const small = Array.from({ length: 50 }, (_, i) =>
      bucket(`s${i}`, 0.3, 50),
    );
    const large = Array.from({ length: 200 }, (_, i) =>
      bucket(`s${i}`, 0.3, 50),
    );
    expect(total(allocateIntake(large))).toBe(total(allocateIntake(small)));
  });

  it("gives more to domains with a higher posterior", () => {
    const allocation = allocateIntake([
      bucket("good", 0.8, 500),
      bucket("meh", 0.1, 500),
    ]);
    expect(allocation.get("good")!).toBeGreaterThan(allocation.get("meh")!);
    // 比例配分なので概ね 8:1。
    expect(allocation.get("good")! / allocation.get("meh")!).toBeGreaterThan(5);
  });

  it("never starves a bucket whose posterior has collapsed to zero", () => {
    // 悪いドメインを追い出すのは降格であって兵糧攻めではない。取り込みが 0 に
    // なると事後が更新されず、良くなったかを二度と確かめられなくなる。
    const allocation = allocateIntake([
      bucket("known", 0.9, 500),
      bucket("collapsed", 0, 500),
    ]);
    expect(allocation.get("collapsed")!).toBeGreaterThan(0);
    // ただし取り分はごくわずかであること。
    expect(allocation.get("collapsed")!).toBeLessThan(
      allocation.get("known")! / 10,
    );
  });

  it("respects the 20% profile-independent floor", () => {
    // 事後の高いプロフィール依存ソースが枠を食い尽くさないこと。
    const allocation = allocateIntake([
      bucket("hot", 0.95, 1000, false),
      bucket("neutral", 0.05, 1000, true),
    ]);
    expect(allocation.get("neutral")!).toBeGreaterThanOrEqual(
      DEFAULT_DAILY_INTAKE_CAP * 0.2,
    );
    expect(total(allocation)).toBe(DEFAULT_DAILY_INTAKE_CAP);
  });

  it("does not hold the floor open when independent sources are dry", () => {
    // 非依存ソースが 5 件しか出さない日に、80 件分の枠を空けたままにしない。
    const allocation = allocateIntake([
      bucket("hot", 0.9, 1000, false),
      bucket("dry", 0.1, 5, true),
    ]);
    expect(allocation.get("dry")).toBe(5);
    expect(total(allocation)).toBe(DEFAULT_DAILY_INTAKE_CAP);
  });

  it("never allocates more than a bucket actually has", () => {
    const allocation = allocateIntake([
      bucket("tiny", 0.9, 3),
      bucket("big", 0.1, 1000),
    ]);
    expect(allocation.get("tiny")).toBe(3);
    expect(total(allocation)).toBe(DEFAULT_DAILY_INTAKE_CAP);
  });

  it("is deterministic across runs", () => {
    const buckets = Array.from({ length: 30 }, (_, i) =>
      bucket(`s${i}`, 0.3, 100),
    );
    expect([...allocateIntake(buckets)]).toEqual([...allocateIntake(buckets)]);
  });

  it("handles an empty day", () => {
    expect(total(allocateIntake([]))).toBe(0);
    expect(total(allocateIntake([bucket("a", 0.5, 0)]))).toBe(0);
  });
});

describe("assignFetchTiers", () => {
  it("splits into 25 / 50 / 25 by posterior", () => {
    const domains = Array.from({ length: 8 }, (_, i) => ({
      id: `d${i}`,
      posteriorMean: 1 - i * 0.1,
    }));
    const tiers = assignFetchTiers(domains);
    const counts = { daily: 0, every3days: 0, weekly: 0 };
    for (const tier of tiers.values()) {
      counts[tier]++;
    }
    expect(counts).toEqual({ daily: 2, every3days: 4, weekly: 2 });
    expect(tiers.get("d0")).toBe("daily");
    expect(tiers.get("d7")).toBe("weekly");
  });

  it("handles an empty and a single-domain set", () => {
    expect(assignFetchTiers([]).size).toBe(0);
    expect(assignFetchTiers([{ id: "a", posteriorMean: 0.5 }]).get("a")).toBe(
      "daily",
    );
  });

  it("is stable when posteriors tie", () => {
    const domains = [
      { id: "b", posteriorMean: 0.5 },
      { id: "a", posteriorMean: 0.5 },
    ];
    expect(assignFetchTiers(domains).get("a")).toBe("daily");
  });
});

describe("isDueForFetch", () => {
  const now = new Date("2026-08-07T05:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("always fetches a domain that was never crawled", () => {
    expect(isDueForFetch("weekly", null, now)).toBe(true);
  });

  it("tolerates a slightly late job", () => {
    // 間隔をぴったり 24 時間にすると、ジョブが数分遅れた日に 1 日飛ぶ。
    expect(isDueForFetch("daily", hoursAgo(23), now)).toBe(true);
  });

  it("does not refetch within the interval", () => {
    expect(isDueForFetch("daily", hoursAgo(4), now)).toBe(false);
    expect(isDueForFetch("every3days", hoursAgo(48), now)).toBe(false);
    expect(isDueForFetch("weekly", hoursAgo(100), now)).toBe(false);
  });

  it("fetches once the interval has passed", () => {
    expect(isDueForFetch("every3days", hoursAgo(72), now)).toBe(true);
    expect(isDueForFetch("weekly", hoursAgo(168), now)).toBe(true);
  });
});
