import { expect, test } from "vitest";
import { applyExplicitTopics } from "./explicitTopics";
import { pairwiseScore, PAIRWISE_FEATURES } from "./pairwise";
import { profileHash } from "../profile";

const base = { score: 0.4, uncertainty: 0.2, contributions: { stable: 0.4 } };
test("leaves unset interests unchanged and does not downrank an unrelated topic", () => {
  expect(applyExplicitTopics(base, new Float32Array([1, 0]), [])).toBe(base);
  expect(applyExplicitTopics(base, null, [new Float32Array([1, 0])])).toBe(
    base,
  );
  expect(
    applyExplicitTopics(base, new Float32Array([-1, 0]), [
      new Float32Array([1, 0]),
    ]).score,
  ).toBe(base.score);
});
test("boosts either of two interests without averaging them together", () => {
  const topics = [new Float32Array([1, 0]), new Float32Array([0, 1])];
  expect(applyExplicitTopics(base, topics[0], topics).score).toBeCloseTo(1.9);
  expect(applyExplicitTopics(base, topics[1], topics).score).toBeCloseTo(1.9);
  expect(base.contributions).toEqual({ stable: 0.4 });
});
test("ignores incompatible dimensions and invalid provider vectors", () => {
  expect(
    applyExplicitTopics(base, new Float32Array([1, 0]), [
      new Float32Array([1]),
    ]),
  ).toBe(base);
  expect(
    applyExplicitTopics(base, new Float32Array([1, 0]), [
      new Float32Array([NaN, 0]),
    ]),
  ).toBe(base);
});
test("keeps historical pairwise inputs separate from the explicit prior", () => {
  const features = Object.fromEntries(PAIRWISE_FEATURES.map((key) => [key, 1]));
  const weights = PAIRWISE_FEATURES.map(() => 1);
  expect(pairwiseScore({ ...features, explicitTopics: 1.5 }, weights)).toBe(
    pairwiseScore(features, weights),
  );
  const profiles = { stable: null, recent: null, negative: null };
  expect(profileHash(profiles, [new Float32Array([1, 0])])).not.toBe(
    profileHash(profiles),
  );
});
