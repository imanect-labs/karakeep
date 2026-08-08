import { describe, expect, test } from "vitest";

import {
  cjkRatio,
  findChunkProblems,
  proseText,
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

// The skip-if-already-in-target check is cjkRatio(proseText(html)) > 0.3.
describe("cjkRatio over proseText", () => {
  const detects = (html: string) => cjkRatio(proseText(html)) > 0.3;

  test("recognises a Japanese article whose code drags the raw ratio down", () => {
    // Shape of the zenn post that was needlessly translated: a few Japanese
    // paragraphs plus long Rust snippets full of identifiers.
    const html =
      `<p>${"バックエンドの主要な開発言語には Rust を使用しています。".repeat(4)}</p>` +
      `<pre><code>${"fn check_expr(cx: &LateContext, expr: &Expr) -> Option<Span> { }\n".repeat(20)}</code></pre>`;
    expect(cjkRatio(html.replace(/<[^>]+>/g, " "))).toBeLessThan(0.3);
    expect(detects(html)).toBe(true);
  });

  test("does not claim an English article is Japanese", () => {
    expect(detects(PROSE)).toBe(false);
  });

  test("does not fire on an English article that quotes a little Japanese", () => {
    const html = PROSE + `<p>The word is 日本語 in Japanese.</p>`;
    expect(detects(html)).toBe(false);
  });

  test("looks at the whole document, not just the opening", () => {
    // Japanese article that opens with an English abstract.
    const html =
      `<p>${"This post is a reprint of the original article. ".repeat(6)}</p>` +
      `<p>${"モデルが一回に出す量は増え続けており、読む側の処理能力は変わりません。".repeat(10)}</p>`;
    expect(detects(html)).toBe(true);
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
