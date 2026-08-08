import { describe, expect, it } from "vitest";

import { makeRng } from "../bandit";
import type { DomainState } from "./lifecycle";
import {
  isTrialComplete,
  planDemotions,
  planPromotions,
  planTrialIntake,
  recommendedSeatCount,
} from "./lifecycle";

const NOW = new Date("2026-08-07T05:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function domain(id: string, overrides: Partial<DomainState> = {}): DomainState {
  return {
    id,
    status: "subscribed",
    examinedCount: 30,
    positiveCount: 6,
    recentExaminedCount: 20,
    recentPositiveCount: 4,
    lastSelectedAt: daysAgo(1),
    lastArticleAt: daysAgo(1),
    promotedAt: daysAgo(100),
    ...overrides,
  };
}

describe("planTrialIntake", () => {
  it("fills the vacancies and no more", () => {
    const screened = Array.from({ length: 20 }, (_, i) =>
      domain(`s${i}`, {
        status: "screened",
        examinedCount: 0,
        positiveCount: 0,
      }),
    );
    expect(
      planTrialIntake(screened, 7, { maxTrialDomains: 10, rng: makeRng(1) }),
    ).toHaveLength(3);
  });

  it("does nothing when trials are full", () => {
    const screened = [domain("s1", { status: "screened" })];
    expect(
      planTrialIntake(screened, 10, { maxTrialDomains: 10, rng: makeRng(1) }),
    ).toEqual([]);
  });

  it("puts a manual subscribe ahead of the sampler", () => {
    // 人間の一発判断はモデルの試用判定より優先する（FR-D-17）。
    const screened = [
      domain("sampled", {
        status: "screened",
        examinedCount: 0,
        positiveCount: 0,
      }),
      domain("manual", {
        status: "screened",
        examinedCount: 0,
        positiveCount: 0,
        manualDecision: "subscribe",
      }),
    ];
    expect(
      planTrialIntake(screened, 9, { maxTrialDomains: 10, rng: makeRng(1) }),
    ).toEqual(["manual"]);
  });
});

describe("isTrialComplete", () => {
  it("ends after six articles", () => {
    expect(
      isTrialComplete(
        domain("t", {
          status: "trial",
          trialImpressionCount: 6,
          trialStartedAt: daysAgo(2),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("ends after four weeks even with few articles", () => {
    expect(
      isTrialComplete(
        domain("t", {
          status: "trial",
          trialImpressionCount: 1,
          trialStartedAt: daysAgo(28),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps running otherwise", () => {
    expect(
      isTrialComplete(
        domain("t", {
          status: "trial",
          trialImpressionCount: 2,
          trialStartedAt: daysAgo(5),
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("planPromotions", () => {
  const finishedTrial = (id: string, positives: number, examined = 10) =>
    domain(id, {
      status: "trial",
      trialImpressionCount: 6,
      trialStartedAt: daysAgo(10),
      examinedCount: examined,
      positiveCount: positives,
      recentExaminedCount: examined,
      recentPositiveCount: positives,
    });

  it("seats a good trial when there is a vacancy", () => {
    const plan = planPromotions([finishedTrial("new", 5)], [domain("old")], {
      seats: 10,
      now: NOW,
    });
    expect(plan.promotions).toEqual([
      { domainId: "new", displacedDomainId: null },
    ]);
    expect(plan.demotions).toEqual([]);
  });

  it("refuses a trial with too little evidence", () => {
    // examined 6 件未満は昇格させない（FR-D-14）。
    const plan = planPromotions([finishedTrial("thin", 2, 3)], [], {
      seats: 10,
      now: NOW,
    });
    expect(plan.promotions).toEqual([]);
    expect(plan.demotions).toEqual([
      { domainId: "thin", reason: "trial_failed" },
    ]);
  });

  it("displaces the weakest incumbent when full", () => {
    // 「増える」ではなく「入れ替わる」構造であること。
    const incumbents = [
      domain("strong", { positiveCount: 20, examinedCount: 40 }),
      domain("weak", { positiveCount: 1, examinedCount: 40 }),
    ];
    const plan = planPromotions([finishedTrial("new", 8, 12)], incumbents, {
      seats: 2,
      now: NOW,
    });
    expect(plan.promotions).toEqual([
      { domainId: "new", displacedDomainId: "weak" },
    ]);
    expect(plan.demotions).toContainEqual({
      domainId: "weak",
      reason: "displaced",
    });
  });

  it("does not displace an incumbent it cannot beat", () => {
    const incumbents = [
      domain("strong", { positiveCount: 30, examinedCount: 40 }),
    ];
    const plan = planPromotions(
      [finishedTrial("mediocre", 1, 10)],
      incumbents,
      {
        seats: 1,
        now: NOW,
      },
    );
    expect(plan.promotions).toEqual([]);
    expect(plan.demotions).toContainEqual({
      domainId: "mediocre",
      reason: "trial_failed",
    });
  });

  it("frees a seat by demoting before counting vacancies", () => {
    // 順序が逆だと、降格予定の現職が「押し出す相手」として残り、
    // 押し出せるはずの新人が弾かれる。
    const buried = domain("buried", { lastSelectedAt: daysAgo(90) });
    const plan = planPromotions([finishedTrial("new", 4, 10)], [buried], {
      seats: 1,
      now: NOW,
    });
    expect(plan.promotions).toEqual([
      { domainId: "new", displacedDomainId: null },
    ]);
    expect(plan.demotions).toContainEqual({
      domainId: "buried",
      reason: "buried",
    });
  });

  it("ignores trials that have not finished yet", () => {
    const running = domain("running", {
      status: "trial",
      trialImpressionCount: 2,
      trialStartedAt: daysAgo(3),
    });
    const plan = planPromotions([running], [], { seats: 10, now: NOW });
    expect(plan.promotions).toEqual([]);
    expect(plan.demotions).toEqual([]);
  });

  it("honours a manual subscribe regardless of seats", () => {
    const manual = finishedTrial("manual", 0, 1);
    manual.manualDecision = "subscribe";
    const plan = planPromotions([manual], [domain("incumbent")], {
      seats: 1,
      now: NOW,
    });
    expect(plan.promotions).toEqual([
      { domainId: "manual", displacedDomainId: null },
    ]);
  });
});

describe("planDemotions", () => {
  it("drops a domain examined 20 times with no positives", () => {
    expect(
      planDemotions(
        [domain("dud", { recentExaminedCount: 20, recentPositiveCount: 0 })],
        NOW,
      ),
    ).toEqual([{ domainId: "dud", reason: "no_positives" }]);
  });

  it("drops a domain that has not been selected for 60 days", () => {
    // 埋没判定。降格条件が examined の蓄積だけに依存すると、提示されない
    // ドメインは評価されず、評価されないから降格しない不死身のループに入る。
    expect(
      planDemotions([domain("buried", { lastSelectedAt: daysAgo(61) })], NOW),
    ).toEqual([{ domainId: "buried", reason: "buried" }]);
  });

  it("counts burial from promotion when nothing has been selected yet", () => {
    expect(
      planDemotions(
        [domain("fresh", { lastSelectedAt: null, promotedAt: daysAgo(3) })],
        NOW,
      ),
    ).toEqual([]);
  });

  it("drops a domain that stopped publishing", () => {
    expect(
      planDemotions([domain("dead", { lastArticleAt: daysAgo(120) })], NOW),
    ).toEqual([{ domainId: "dead", reason: "stale" }]);
  });

  it("leaves a healthy domain alone", () => {
    expect(planDemotions([domain("good")], NOW)).toEqual([]);
  });

  it("never auto-demotes a manual subscribe", () => {
    expect(
      planDemotions(
        [
          domain("pinned", {
            manualDecision: "subscribe",
            recentExaminedCount: 20,
            recentPositiveCount: 0,
            lastSelectedAt: daysAgo(200),
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("recommendedSeatCount", () => {
  it("lands in the 40-90 range the design argues for", () => {
    const seats = recommendedSeatCount({
      dailyBriefingSize: 20,
      observationRate: 0.7,
    });
    expect(seats).toBeGreaterThanOrEqual(40);
    expect(seats).toBeLessThanOrEqual(90);
  });

  it("shrinks when the briefing is observed less often", () => {
    // 観測率が落ちると、評価しきれるドメイン数も落ちる。
    expect(
      recommendedSeatCount({ dailyBriefingSize: 20, observationRate: 0.3 }),
    ).toBeLessThan(
      recommendedSeatCount({ dailyBriefingSize: 20, observationRate: 0.9 }),
    );
  });
});

describe("seat admission floor", () => {
  const finishedTrial = (id: string, positives: number, examined: number) =>
    domain(id, {
      status: "trial",
      trialImpressionCount: 6,
      trialStartedAt: daysAgo(10),
      examinedCount: examined,
      positiveCount: positives,
      recentExaminedCount: examined,
      recentPositiveCount: positives,
    });

  it("refuses a seat to a trial that demonstrably failed", () => {
    // 空席でも無条件には座らせない。「試したが駄目だった」ことが分かって
    // いる相手を入れるのは、「まだ何も分かっていない」相手より悪い。
    const plan = planPromotions([finishedTrial("dud", 0, 10)], [], {
      seats: 10,
      now: NOW,
    });
    expect(plan.promotions).toEqual([]);
    expect(plan.demotions).toContainEqual({
      domainId: "dud",
      reason: "trial_failed",
    });
  });

  it("seats a trial that beat the prior", () => {
    const plan = planPromotions([finishedTrial("good", 6, 12)], [], {
      seats: 10,
      now: NOW,
    });
    expect(plan.promotions).toEqual([
      { domainId: "good", displacedDomainId: null },
    ]);
  });

  it("does not let one excellent incumbent lock everyone else out", () => {
    // 現職が 1 件のとき、その集合の下位四分位はその 1 件の成績そのもの。
    // 四分位を使うと最初に入った優秀なドメインが基準になり、以後どの
    // ドメインも入れなくなる。
    const star = domain("star", { positiveCount: 38, examinedCount: 40 });
    const plan = planPromotions([finishedTrial("decent", 4, 12)], [star], {
      seats: 10,
      now: NOW,
    });
    expect(plan.promotions).toEqual([
      { domainId: "decent", displacedDomainId: null },
    ]);
  });

  it("applies the incumbent quartile once there are enough incumbents", () => {
    const incumbents = Array.from({ length: 10 }, (_, i) =>
      domain(`inc${i}`, { positiveCount: 20, examinedCount: 40 }),
    );
    // 現職の下位四分位は約 0.49。事前値 0.2 は超えるが四分位に届かない候補。
    const plan = planPromotions([finishedTrial("mid", 3, 10)], incumbents, {
      seats: 20,
      now: NOW,
    });
    expect(plan.promotions).toEqual([]);
  });
});
