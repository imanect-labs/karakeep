import { describe, expect, test } from "vitest";

import { getPotentialRelevantTagsPrompt, getTagStylePrompt } from "./tag";

describe("getPotentialRelevantTagsPrompt", () => {
  test("is empty when there is nothing to reuse", () => {
    expect(getPotentialRelevantTagsPrompt()).toBe("");
    expect(getPotentialRelevantTagsPrompt([])).toBe("");
  });

  test("lists the tags and demands verbatim reuse", () => {
    const prompt = getPotentialRelevantTagsPrompt(["LLM", "機械学習", "Rust"]);
    expect(prompt).toContain("LLM, 機械学習, Rust");
    expect(prompt).toContain("MUST reuse it verbatim");
  });

  test("names the variants that must not be invented", () => {
    const prompt = getPotentialRelevantTagsPrompt(["LLM"]);
    // The three ways the library drifted: casing, separators, translation.
    expect(prompt).toContain("no case changes");
    expect(prompt).toContain("no different separators");
    expect(prompt).toContain("no translation of it");
    expect(prompt).toContain('do not emit "llm"');
  });

  test("still allows a new tag when nothing fits", () => {
    expect(getPotentialRelevantTagsPrompt(["LLM"])).toContain(
      "Only invent a new tag when nothing listed fits",
    );
  });
});

describe("getTagStylePrompt", () => {
  test("as-generated adds no styling instruction", () => {
    // The title-case instruction ships English examples, which fought the
    // "tags must be in 日本語" rule.
    expect(getTagStylePrompt("as-generated")).toBe("");
  });

  test("an explicit style still produces one", () => {
    expect(getTagStylePrompt("lowercase-hyphens")).toContain("lowercase");
  });
});
