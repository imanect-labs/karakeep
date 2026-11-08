import type { HeuristicScore } from "./heuristic";
import { dot } from "../vector";

// An explicit prior supplements the unchanged heuristic-v1 learning features.
// Each topic is compared separately so unrelated interests do not cancel out.
export function applyExplicitTopics(
  base: HeuristicScore,
  embedding: Float32Array | null,
  topics: Float32Array[],
): HeuristicScore {
  if (!embedding || topics.length === 0) return base;
  const compatible = topics.filter((t) => t.length === embedding.length);
  if (compatible.length === 0) return base;
  const similarity = Math.max(0, ...compatible.map((t) => dot(embedding, t)));
  if (!Number.isFinite(similarity)) return base;
  const explicitTopics = 1.5 * Math.min(1, similarity);
  return {
    ...base,
    score: base.score + explicitTopics,
    contributions: { ...base.contributions, explicitTopics },
  };
}
