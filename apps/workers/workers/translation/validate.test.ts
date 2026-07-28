import { describe, expect, test } from "vitest";

import {
  findChunkProblems,
  restoreCodeContent,
  stripCodeFence,
  stripPreamble,
} from "./validate";

const PROSE = `<p>${"We keep our bound variables stored as an ambient map of variable names to their evaluated values for now. ".repeat(3)}</p>`;
const JA = `<p>${"束縛変数は変数名からその評価値への環境マップとして保持します。".repeat(6)}</p>`;

describe("stripCodeFence", () => {
  test("removes a ```html fence", () => {
    expect(stripCodeFence("```html\n<p>あ</p>\n```")).toBe("<p>あ</p>");
  });
  test("leaves plain output alone", () => {
    expect(stripCodeFence("<p>あ</p>")).toBe("<p>あ</p>");
  });
});

describe("stripPreamble", () => {
  test("drops a preamble when the source starts with a tag", () => {
    expect(
      stripPreamble("<p>hello</p>", "以下が翻訳したものです。 <p>やあ</p>"),
    ).toBe("<p>やあ</p>");
    expect(stripPreamble("<p>hello</p>", "# 翻訳結果\n<p>やあ</p>")).toBe(
      "<p>やあ</p>",
    );
  });

  test("keeps leading text when the source itself starts with text", () => {
    // hardSplitAtTagBoundaries can cut a chunk mid-content.
    const out = "続きの文です。<p>やあ</p>";
    expect(stripPreamble("continued text.<p>hello</p>", out)).toBe(out);
  });

  test("is a no-op when the output already starts with a tag", () => {
    expect(stripPreamble("<p>hello</p>", "<p>やあ</p>")).toBe("<p>やあ</p>");
  });
});

describe("restoreCodeContent", () => {
  test("puts the source's code back, keeping the translated prose", () => {
    const src = `<p>Set the field.</p><code>EPrim (PString "found")</code>`;
    const out = `<p>フィールドを設定します。</p><code>EPrim (PString "見つかった")</code>`;
    expect(restoreCodeContent(src, out)).toBe(
      `<p>フィールドを設定します。</p><code>EPrim (PString "found")</code>`,
    );
    expect(findChunkProblems(src, restoreCodeContent(src, out), true)).toEqual(
      [],
    );
  });

  test("restores each block positionally", () => {
    const src = `<code>a</code><p>x</p><pre>b</pre>`;
    const out = `<code>あ</code><p>え</p><pre>い</pre>`;
    expect(restoreCodeContent(src, out)).toBe(
      `<code>a</code><p>え</p><pre>b</pre>`,
    );
  });

  test("leaves the output alone when the block counts disagree", () => {
    const src = `<code>a</code><code>b</code>`;
    const out = `<code>あ</code>`;
    expect(restoreCodeContent(src, out)).toBe(out);
    expect(findChunkProblems(src, out, true)).toContain(
      "code content was modified",
    );
  });

  test("is a no-op without code blocks", () => {
    expect(restoreCodeContent("<p>a</p>", "<p>あ</p>")).toBe("<p>あ</p>");
  });
});

describe("findChunkProblems", () => {
  test("accepts a clean translation", () => {
    expect(findChunkProblems(PROSE, JA, true)).toEqual([]);
  });

  test("flags an echoed source", () => {
    expect(findChunkProblems(PROSE, PROSE, true)).toContain(
      "echoed the source verbatim",
    );
  });

  test("flags output left in the source language", () => {
    const reworded = PROSE.replace("We keep", "We will keep");
    expect(findChunkProblems(PROSE, reworded, true)).toContain(
      "output is still in the source language",
    );
  });

  test("does not flag the source language when the target is not japanese", () => {
    expect(
      findChunkProblems(PROSE, PROSE.replace("We keep", "We will keep"), false),
    ).toEqual([]);
  });

  test("flags a large change in tag count", () => {
    const extra = JA + "<div></div><div></div><div></div><div></div>";
    expect(findChunkProblems(PROSE, extra, true).join()).toContain(
      "tag count changed",
    );
  });

  test("tolerates a tag or two of drift", () => {
    expect(findChunkProblems(PROSE, JA + "<br>", true)).toEqual([]);
  });

  test("flags translated code content", () => {
    const src = `<p>Set the field.</p><code>EPrim (PString "found")</code>`;
    const out = `<p>フィールドを設定します。</p><code>EPrim (PString "見つかった")</code>`;
    expect(findChunkProblems(src, out, true)).toContain(
      "code content was modified",
    );
  });

  test("accepts untouched code content", () => {
    const src = `<p>Set the field.</p><code>EPrim (PString "found")</code>`;
    const out = `<p>フィールドを設定します。</p><code>EPrim (PString "found")</code>`;
    expect(findChunkProblems(src, out, true)).toEqual([]);
  });

  test("ignores tiny fragments where the heuristics are meaningless", () => {
    expect(findChunkProblems("<p>Hi</p>", "<p>Hi</p>", true)).toEqual([]);
  });
});
