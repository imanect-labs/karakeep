import { describe, expect, it } from "vitest";

import {
  articleTranslationPrompt,
  isEnglishArticle,
  parseArticleTranslation,
} from "./briefing";

describe("Briefing language and translation", () => {
  it("shows translation for English, including technical titles, but not Japanese", () => {
    expect(isEnglishArticle({ lang: "en-US", title: "Go" })).toBe(true);
    expect(isEnglishArticle({ title: "PostgreSQL concurrency control" })).toBe(
      true,
    );
    expect(isEnglishArticle({ title: "RustのPinを理解する" })).toBe(false);
    expect(isEnglishArticle({ lang: "ja", title: "PostgreSQL" })).toBe(false);
    expect(isEnglishArticle({ title: null, summary: null })).toBe(false);
  });
  it("accepts fenced JSON and rejects empty translated titles", () => {
    expect(
      parseArticleTranslation(
        '```json\n{"titleJa":"並行性の制御","summaryJa":null}\n```',
      ),
    ).toEqual({ titleJa: "並行性の制御", summaryJa: null });
    expect(() =>
      parseArticleTranslation('{"titleJa":"","summaryJa":null}'),
    ).toThrow();
    expect(() => parseArticleTranslation("not JSON")).toThrow();
  });
  it("asks for translation rather than summary generation and bounds the input", () => {
    const prompt = articleTranslationPrompt("Concurrency", "a".repeat(10000));
    expect(prompt).toContain("要約・加筆・推測はせず");
    expect(prompt).not.toContain("a".repeat(6001));
  });
});
