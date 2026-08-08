import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEURISTIC_WEIGHTS,
  explainScore,
  freshnessScore,
  scoreHeuristic,
} from "./model/heuristic";
import {
  buildProfiles,
  clusterPreferenceLookup,
  halfLifeWeight,
  profileHash,
} from "./profile";
import { dot, l2Normalize } from "./vector";

const NOW = new Date("2026-08-07T05:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const TOPIC_A = l2Normalize([1, 0, 0]);
const TOPIC_B = l2Normalize([0, 1, 0]);
const TOPIC_C = l2Normalize([0, 0, 1]);

describe("halfLifeWeight", () => {
  it("halves every 7 days", () => {
    expect(halfLifeWeight(daysAgo(0), NOW)).toBeCloseTo(1, 6);
    expect(halfLifeWeight(daysAgo(7), NOW)).toBeCloseTo(0.5, 6);
    expect(halfLifeWeight(daysAgo(14), NOW)).toBeCloseTo(0.25, 6);
  });

  it("treats a future timestamp as current", () => {
    expect(halfLifeWeight(new Date(NOW.getTime() + 1000), NOW)).toBe(1);
  });
});

describe("buildProfiles", () => {
  it("returns nulls before there is any evidence", () => {
    // 正例が 1 件も無い初日でも落ちないこと。
    expect(buildProfiles([], [], NOW)).toEqual({
      stable: null,
      recent: null,
      negative: null,
    });
  });

  it("puts the long-term profile between the topics read", () => {
    const profiles = buildProfiles(
      [
        { vector: TOPIC_A, occurredAt: daysAgo(1) },
        { vector: TOPIC_B, occurredAt: daysAgo(60) },
      ],
      [],
      NOW,
    );
    expect(dot(profiles.stable!, TOPIC_A)).toBeCloseTo(
      dot(profiles.stable!, TOPIC_B),
      5,
    );
  });

  it("lets the recent profile follow a shift in interest", () => {
    // 長期は動かないが直近は動く、というのが 2 本持つ理由。
    const profiles = buildProfiles(
      [
        { vector: TOPIC_A, occurredAt: daysAgo(1) },
        { vector: TOPIC_B, occurredAt: daysAgo(60) },
      ],
      [],
      NOW,
    );
    expect(dot(profiles.recent!, TOPIC_A)).toBeGreaterThan(
      dot(profiles.recent!, TOPIC_B),
    );
  });

  it("returns a null recent profile when every positive is ancient", () => {
    const profiles = buildProfiles(
      [{ vector: TOPIC_A, occurredAt: daysAgo(400) }],
      [],
      NOW,
    );
    expect(profiles.stable).not.toBeNull();
    expect(profiles.recent).toBeNull();
  });

  it("builds the negative profile from dismissals", () => {
    const profiles = buildProfiles(
      [{ vector: TOPIC_A, occurredAt: daysAgo(1) }],
      [{ vector: TOPIC_C, occurredAt: daysAgo(1) }],
      NOW,
    );
    expect(dot(profiles.negative!, TOPIC_C)).toBeCloseTo(1, 5);
  });

  it("normalizes, so scores do not drift as positives accumulate", () => {
    // 件数でスコアの絶対値が動くと、しきい値が日ごとに意味を変えてしまう。
    const few = buildProfiles(
      [{ vector: TOPIC_A, occurredAt: daysAgo(1) }],
      [],
      NOW,
    );
    const many = buildProfiles(
      Array.from({ length: 100 }, () => ({
        vector: TOPIC_A,
        occurredAt: daysAgo(1),
      })),
      [],
      NOW,
    );
    expect(dot(few.stable!, few.stable!)).toBeCloseTo(1, 5);
    expect(dot(many.stable!, many.stable!)).toBeCloseTo(1, 5);
  });
});

describe("profileHash", () => {
  it("is stable for the same profile", () => {
    const profiles = buildProfiles(
      [{ vector: TOPIC_A, occurredAt: daysAgo(1) }],
      [],
      NOW,
    );
    expect(profileHash(profiles)).toBe(profileHash(profiles));
  });

  it("changes when the profile changes", () => {
    const a = buildProfiles(
      [{ vector: TOPIC_A, occurredAt: daysAgo(1) }],
      [],
      NOW,
    );
    const b = buildProfiles(
      [{ vector: TOPIC_B, occurredAt: daysAgo(1) }],
      [],
      NOW,
    );
    expect(profileHash(a)).not.toBe(profileHash(b));
  });

  it("handles an empty profile", () => {
    expect(profileHash({ stable: null, recent: null, negative: null })).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });
});

describe("clusterPreferenceLookup", () => {
  it("falls back to the prior for unknown clusters", () => {
    const lookup = clusterPreferenceLookup({ a: 0.7 });
    expect(lookup("a")).toBe(0.7);
    expect(lookup("unknown")).toBe(0.2);
    expect(lookup(null)).toBe(0.2);
  });
});

describe("freshnessScore", () => {
  it("decays with a 48 hour half life", () => {
    expect(freshnessScore(NOW, NOW)).toBe(1);
    expect(
      freshnessScore(new Date(NOW.getTime() - 48 * 3_600_000), NOW),
    ).toBeCloseTo(0.5, 5);
  });

  it("gives undated candidates a middling score, not the bottom", () => {
    // 最下位に落とすと、日付を出さないフィードの記事が永久に出ない。
    expect(freshnessScore(null, NOW)).toBe(0.5);
  });
});

describe("scoreHeuristic", () => {
  const profiles = buildProfiles(
    [{ vector: TOPIC_A, occurredAt: daysAgo(1) }],
    [{ vector: TOPIC_C, occurredAt: daysAgo(1) }],
    NOW,
  );

  const base = {
    publishedAt: daysAgo(0.5),
    clusterId: "c1",
    clusterPreference: 0.2,
    clusterRecentImpressions: 0,
    domainPosterior: 0.2,
    maxSimilarityToLibrary: 0,
  };

  it("ranks an on-profile article above an off-profile one", () => {
    const onProfile = scoreHeuristic(
      { ...base, embedding: TOPIC_A },
      profiles,
      NOW,
    );
    const offProfile = scoreHeuristic(
      { ...base, embedding: TOPIC_B },
      profiles,
      NOW,
    );
    expect(onProfile.score).toBeGreaterThan(offProfile.score);
  });

  it("penalizes an article close to the negative profile", () => {
    const disliked = scoreHeuristic(
      { ...base, embedding: TOPIC_C },
      profiles,
      NOW,
    );
    const neutral = scoreHeuristic(
      { ...base, embedding: TOPIC_B },
      profiles,
      NOW,
    );
    expect(disliked.score).toBeLessThan(neutral.score);
  });

  it("does not reward being the opposite of a disliked topic", () => {
    // 「嫌いなものと逆」であることに意味は無い。
    const opposite = scoreHeuristic(
      { ...base, embedding: l2Normalize([0, 0, -1]) },
      profiles,
      NOW,
    );
    expect(opposite.contributions.negative).toBeCloseTo(0, 10);
  });

  it("penalizes a cluster that has been shown a lot", () => {
    const fresh = scoreHeuristic(
      { ...base, embedding: TOPIC_A, clusterRecentImpressions: 0 },
      profiles,
      NOW,
    );
    const repeated = scoreHeuristic(
      { ...base, embedding: TOPIC_A, clusterRecentImpressions: 15 },
      profiles,
      NOW,
    );
    expect(repeated.score).toBeLessThan(fresh.score);
  });

  it("penalizes an article the library already has", () => {
    const novel = scoreHeuristic(
      { ...base, embedding: TOPIC_A, maxSimilarityToLibrary: 0 },
      profiles,
      NOW,
    );
    const duplicate = scoreHeuristic(
      { ...base, embedding: TOPIC_A, maxSimilarityToLibrary: 0.95 },
      profiles,
      NOW,
    );
    expect(duplicate.score).toBeLessThan(novel.score);
  });

  it("uses impression count as the stand-in for uncertainty", () => {
    // 学習前は事後分散が無いので、提示の少ないクラスタほど不確実とみなす。
    expect(
      scoreHeuristic(
        { ...base, embedding: TOPIC_A, clusterRecentImpressions: 0 },
        profiles,
        NOW,
      ).uncertainty,
    ).toBeGreaterThan(
      scoreHeuristic(
        { ...base, embedding: TOPIC_A, clusterRecentImpressions: 20 },
        profiles,
        NOW,
      ).uncertainty,
    );
  });

  it("still scores a candidate whose embedding failed", () => {
    // 埋め込みに失敗した候補も新着順フォールバックに乗せる（NFR-09）。
    const scored = scoreHeuristic({ ...base, embedding: null }, profiles, NOW);
    expect(Number.isFinite(scored.score)).toBe(true);
  });

  it("works on day one, before any profile exists", () => {
    const empty = { stable: null, recent: null, negative: null };
    const scored = scoreHeuristic({ ...base, embedding: TOPIC_A }, empty, NOW);
    expect(Number.isFinite(scored.score)).toBe(true);
  });

  it("respects reweighting", () => {
    const noRecency = scoreHeuristic(
      { ...base, embedding: TOPIC_A },
      profiles,
      NOW,
      { ...DEFAULT_HEURISTIC_WEIGHTS, freshness: 0 },
    );
    expect(noRecency.contributions.freshness).toBe(0);
  });
});

describe("explainScore", () => {
  const profiles = buildProfiles(
    [{ vector: TOPIC_A, occurredAt: daysAgo(1) }],
    [],
    NOW,
  );

  it("names the strongest reasons in natural language", () => {
    const scored = scoreHeuristic(
      {
        embedding: TOPIC_A,
        publishedAt: daysAgo(0.1),
        clusterId: "c1",
        clusterPreference: 0.8,
        clusterRecentImpressions: 0,
        domainPosterior: 0.2,
        maxSimilarityToLibrary: 0,
      },
      profiles,
      NOW,
    );
    const text = explainScore(scored);
    expect(text.length).toBeGreaterThan(0);
    // 全部並べると読まれないので 2 つまで。
    expect(text.split("。").filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it("always says something", () => {
    const scored = scoreHeuristic(
      {
        embedding: null,
        publishedAt: null,
        clusterId: null,
        clusterPreference: 0.2,
        clusterRecentImpressions: 0,
        domainPosterior: 0.2,
        maxSimilarityToLibrary: 0,
      },
      { stable: null, recent: null, negative: null },
      NOW,
    );
    expect(explainScore(scored).length).toBeGreaterThan(0);
  });
});
