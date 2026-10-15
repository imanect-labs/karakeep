import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpenAIInferenceClient } from "./inference";
import type { OpenAIInferenceConfig } from "./inference";

const capturedBodies: Record<string, unknown>[] = [];
const capturedRequestOptions: { headers?: Record<string, string> }[] = [];
const tagSchema = z.object({ tags: z.array(z.string()) });

vi.mock("openai", () => {
  const OpenAIMock = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(
          async (
            body: Record<string, unknown>,
            options: { headers?: Record<string, string> },
          ) => {
            capturedBodies.push(body);
            capturedRequestOptions.push(options);
            return {
              choices: [{ message: { content: "{}" } }],
              usage: { total_tokens: 1 },
            };
          },
        ),
      },
    },
  }));

  return { default: OpenAIMock };
});

vi.mock("openai/helpers/zod", () => ({
  zodResponseFormat: (schema: unknown, name: string) => ({
    type: "json_schema",
    json_schema: { name, schema },
  }),
}));

function makeConfig(
  outputSchema: OpenAIInferenceConfig["outputSchema"],
): OpenAIInferenceConfig {
  return {
    apiKey: "test-key",
    textModel: "test-text-model",
    imageModel: "test-image-model",
    contextLength: 2048,
    maxOutputTokens: 1024,
    useMaxCompletionTokens: false,
    outputSchema,
  };
}

describe("OpenAIInferenceClient response_format", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  it("omits response_format for schema-less text inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromText("summarize this text", { schema: null });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toBeUndefined();
  });

  it("keeps json_object for schema-backed text inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromText("infer tags as json", { schema: tagSchema });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format for schema-less image inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromImage("describe this image", "image/png", "BASE64", {
      schema: null,
    });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toBeUndefined();
  });

  it("keeps structured response_format for schema-backed text inference in structured mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("structured"));

    await client.inferFromText("infer tags", { schema: tagSchema });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "schema" },
    });
  });
});

describe("OpenAIInferenceClient x-opencode-session", () => {
  beforeEach(() => {
    capturedRequestOptions.length = 0;
  });

  it("sends no extra headers when disabled", async () => {
    const client = new OpenAIInferenceClient(makeConfig("plain"));

    await client.inferFromText("hi", { schema: null, sessionId: "s-1" });

    expect(capturedRequestOptions[0].headers).toBeUndefined();
  });

  it("sends the caller's session id when enabled", async () => {
    const client = new OpenAIInferenceClient({
      ...makeConfig("plain"),
      opencodeSession: true,
    });

    await client.inferFromText("hi", { schema: null, sessionId: "s-1" });

    expect(capturedRequestOptions[0].headers).toMatchObject({
      "x-opencode-session": "s-1",
      "User-Agent": "karakeep",
    });
  });

  it("falls back to a fixed session id", async () => {
    const client = new OpenAIInferenceClient({
      ...makeConfig("plain"),
      opencodeSession: true,
    });

    await client.inferFromImage("describe", "image/png", "BASE64", {
      schema: null,
    });

    expect(capturedRequestOptions[0].headers).toMatchObject({
      "x-opencode-session": "karakeep",
    });
  });
});
