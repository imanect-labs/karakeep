import { describe, expect, it } from "vitest";

import type { EmbeddingClient } from "@karakeep/shared/embedding";

import { dot } from "../vector";
import { embedDocuments } from "./client";

function fakeClient(vectors: number[][]): EmbeddingClient {
  return {
    modelId: "fake/model",
    generateEmbeddingFromText: async (inputs) => ({
      embeddings: vectors.slice(0, inputs.length),
      promptTokens: 1,
      totalTokens: 1,
    }),
  };
}

function unitish(dims: number, hot: number): number[] {
  const v = Array.from({ length: dims }, () => 0.01);
  v[hot] = 1;
  return v;
}

describe("embedDocuments", () => {
  it("returns L2-normalized vectors", async () => {
    const [result] = await embedDocuments(fakeClient([unitish(32, 0)]), [
      { title: "t", body: "b" },
    ]);
    expect(dot(result!.vector, result!.vector)).toBeCloseTo(1, 5);
  });

  it("keeps the input positions, with null for unembeddable documents", async () => {
    const results = await embedDocuments(
      fakeClient([unitish(32, 0), unitish(32, 1)]),
      [{ title: "a" }, {}, { title: "b" }],
    );
    expect(results).toHaveLength(3);
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).not.toBeNull();
  });

  it("records the model id so mixed spaces can be detected later", async () => {
    const [result] = await embedDocuments(fakeClient([unitish(32, 0)]), [
      { title: "t" },
    ]);
    expect(result!.modelId).toBe("fake/model");
  });

  it("truncates and renormalizes when a dimension is requested", async () => {
    const [result] = await embedDocuments(
      fakeClient([unitish(64, 0)]),
      [{ title: "t" }],
      { dimensions: 32 },
    );
    expect(result!.vector).toHaveLength(32);
    expect(dot(result!.vector, result!.vector)).toBeCloseTo(1, 5);
  });

  it("makes no request when nothing can be formatted", async () => {
    let called = false;
    const client: EmbeddingClient = {
      modelId: "fake/model",
      generateEmbeddingFromText: async () => {
        called = true;
        return { embeddings: [], promptTokens: 0, totalTokens: 0 };
      },
    };
    expect(await embedDocuments(client, [{}, {}])).toEqual([null, null]);
    expect(called).toBe(false);
  });

  it("rejects implausibly small vectors", async () => {
    // OpenAI SDK は encoding_format を明示しないと既定で base64 を要求し、
    // 素の float 配列を返すサーバの応答を base64 として復号してしまう。
    // その失敗は例外ではなく「やたら短いベクトル」として現れる。検算が
    // ないと、無意味なベクトルが候補プールに溜まり続けて推薦が静かに壊れる。
    await expect(
      embedDocuments(fakeClient([[1, 0]]), [{ title: "t" }]),
    ).rejects.toThrow(/too small to be real/);
  });

  it("rejects a batch whose vectors disagree on dimensions", async () => {
    await expect(
      embedDocuments(fakeClient([unitish(32, 0), unitish(64, 0)]), [
        { title: "a" },
        { title: "b" },
      ]),
    ).rejects.toThrow(/inconsistent dimensions/);
  });

  it("rejects a response with the wrong number of vectors", async () => {
    await expect(
      embedDocuments(fakeClient([unitish(32, 0)]), [
        { title: "a" },
        { title: "b" },
      ]),
    ).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });
});
