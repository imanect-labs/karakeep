import { describe, expect, test } from "vitest";

import { extractArticleText, pickLocalBody } from "./digest";

describe("pickLocalBody", () => {
  test("prefers whichever of excerpt/summary carries more text", () => {
    expect(
      pickLocalBody(
        {
          url: "https://example.com/",
          summary: "短い説明",
          contentExcerpt: "こちらのほうが長い本文の抜粋です",
        },
        100,
      ),
    ).toBe("こちらのほうが長い本文の抜粋です");
    expect(
      pickLocalBody(
        {
          url: "https://example.com/",
          summary: "こちらのほうが長い説明文になっています",
          contentExcerpt: "短い",
        },
        100,
      ),
    ).toBe("こちらのほうが長い説明文になっています");
  });

  test("truncates to the configured limit", () => {
    expect(
      pickLocalBody(
        {
          url: "https://example.com/",
          summary: null,
          contentExcerpt: "abcdef",
        },
        3,
      ),
    ).toBe("abc");
  });

  test("returns an empty string when the candidate has neither", () => {
    expect(
      pickLocalBody(
        { url: "https://example.com/", summary: null, contentExcerpt: null },
        100,
      ),
    ).toBe("");
  });
});

describe("extractArticleText", () => {
  test("keeps the article body and drops nav/script", () => {
    const html = `<!doctype html><html><head><title>T</title>
      <script>var tracking = 1;</script></head>
      <body>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <article>
          <h1>pgrust 0.2</h1>
          <p>We released version 0.2 of pgrust last week. This release was all
          about performance, and it is roughly ten times faster than the previous
          version across our benchmark suite.</p>
          <p>On OLTP benchmarks it is 30% faster than PostgreSQL, and on
          Clickbench it is 300 times faster.</p>
        </article>
      </body></html>`;
    const text = extractArticleText(html, "https://example.com/pgrust");
    expect(text).toContain("released version 0.2 of pgrust");
    expect(text).toContain("300 times faster");
    expect(text).not.toContain("var tracking");
    // 空白は 1 つに潰してから LLM に渡す（無駄なトークンを使わない）。
    expect(text).not.toMatch(/\s{2}/);
  });

  test("returns an empty string instead of throwing on junk input", () => {
    expect(extractArticleText("", "https://example.com/")).toBe("");
  });
});
