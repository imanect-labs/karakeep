import { beforeEach, describe, expect, it, vi } from "vitest";

import { PAIRWISE_FEATURES } from "@karakeep/recommender";

const mock = vi.hoisted(() => ({
  rows: [] as unknown[],
  insert: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@karakeep/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          leftJoin: () => ({ where: async () => mock.rows }),
        }),
      }),
    }),
    insert: () => ({ values: mock.insert }),
  },
}));
vi.mock("@karakeep/shared/logger", () => ({ default: { info: mock.log } }));

import { runTrain } from "./train";

describe("runTrain", () => {
  beforeEach(() => {
    mock.rows = [];
    vi.clearAllMocks();
  });

  it("logs the data shortage and keeps serving without a model", async () => {
    await runTrain("user", "job");
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.log.mock.calls.flat().join(" ")).toContain("examined=0");
    expect(mock.log.mock.calls.flat().join(" ")).toContain("skipped");
  });

  it("fits and persists a shadow model when eligible history is sufficient", async () => {
    mock.rows = Array.from({ length: 70 }, (_, day) =>
      Array.from({ length: 40 }, (_, index) => ({
        id: `${day}:${index}`,
        candidateId: `${day}:${index}`,
        briefingId: `b${day}`,
        date: new Date(Date.UTC(2026, 7, day + 1)).toISOString().slice(0, 10),
        features: Object.fromEntries(
          PAIRWISE_FEATURES.map((key) => [
            key,
            key === "stable"
              ? index < 2
                ? 1
                : 0
              : key === "rank"
                ? index + 1
                : 0,
          ]),
        ),
        event: index < 2 ? "saved" : "viewed",
      })),
    ).flat();
    await runTrain("user", "job");
    expect(mock.insert).toHaveBeenCalledOnce();
    const model = mock.insert.mock.calls[0][0];
    expect(model).toMatchObject({
      userId: "user",
      kind: "logreg",
      status: "shadow",
      positiveCount: 140,
      trainSampleCount: 2800,
    });
    expect(model.params.weights.every(Number.isFinite)).toBe(true);
    expect(model.metrics.validationPairAccuracy).toBe(1);
  });

  it("starts regularized shadow learning before the production promotion thresholds", async () => {
    mock.rows = Array.from({ length: 10 }, (_, day) =>
      Array.from({ length: 15 }, (_, index) => ({
        id: `${day}:${index}`,
        candidateId: `${day}:${index}`,
        briefingId: `b${day}`,
        date: new Date(Date.UTC(2026, 7, day + 1)).toISOString().slice(0, 10),
        features: Object.fromEntries(
          PAIRWISE_FEATURES.map((key) => [
            key,
            key === "stable"
              ? index < 2
                ? 1
                : 0
              : key === "rank"
                ? index + 1
                : 0,
          ]),
        ),
        event: index < 2 ? "saved" : "viewed",
      })),
    ).flat();
    await runTrain("user", "job");
    expect(mock.insert).toHaveBeenCalledOnce();
    expect(mock.insert.mock.calls[0][0]).toMatchObject({
      status: "shadow",
      positiveCount: 20,
      trainSampleCount: 150,
      params: { lambda: 1 },
      metrics: { regularizationCrossValidated: 0 },
    });
  });
});
