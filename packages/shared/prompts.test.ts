import { describe, expect, test } from "vitest";

import { constructTranslationPrompt } from "./prompts";

const FRAGMENT = "<p>Hello <code>foo()</code> world.</p>";

describe("constructTranslationPrompt", () => {
  test("capitalises the target language and includes the fragment last", () => {
    const prompt = constructTranslationPrompt("japanese", FRAGMENT);
    expect(prompt).toContain("publication-quality Japanese");
    expect(prompt).not.toContain("publication-quality japanese");
    expect(prompt.trimEnd().endsWith(FRAGMENT)).toBe(true);
  });

  test("omits the context block when no context is given", () => {
    const prompt = constructTranslationPrompt("japanese", FRAGMENT);
    expect(prompt).not.toContain("# Context");
    expect(prompt).not.toContain("Document title");
  });

  test("includes only the context parts that are provided", () => {
    const prompt = constructTranslationPrompt("japanese", FRAGMENT, {
      title: "Two Wolves",
      previousTranslation: "……二匹の狼がいます。",
    });
    expect(prompt).toContain("# Context (reference ONLY)");
    expect(prompt).toContain("Document title: Two Wolves");
    expect(prompt).toContain("……二匹の狼がいます。");
    expect(prompt).not.toContain(
      "Source text immediately before this fragment",
    );
    // The context must be clearly fenced off from the fragment to translate.
    expect(prompt.indexOf("# Context")).toBeLessThan(
      prompt.indexOf("# HTML fragment to translate"),
    );
  });

  test("applies the style instruction only when a style is set", () => {
    expect(
      constructTranslationPrompt("japanese", FRAGMENT, {
        style: "だ・である調",
      }),
    ).toContain("consistent だ・である調 style");
    expect(
      constructTranslationPrompt("japanese", FRAGMENT, { style: "" }),
    ).not.toContain("consistent  style");
  });
});
