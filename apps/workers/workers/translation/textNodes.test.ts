import { describe, expect, test } from "vitest";

import {
  applySegments,
  applyTextRuns,
  decodeEntities,
  encodeEntities,
  extractInlineSegments,
  extractTextRuns,
  isWellNested,
  maskInlineTags,
  normalizePlaceholders,
  restoreInlineTags,
} from "./textNodes";
import { tagSequence } from "./validate";

describe("extractInlineSegments", () => {
  test("splits at block boundaries and keeps inline tags inside a segment", () => {
    const segments = extractInlineSegments(
      '<p>Hello <a href="/x">there</a> world</p><p>Second</p>',
    );
    expect(segments.map((s) => s.raw)).toEqual([
      'Hello <a href="/x">there</a> world',
      "Second",
    ]);
  });

  test("never looks inside script/style/pre", () => {
    const segments = extractInlineSegments(
      "<p>Before</p><pre><code>let x = translate me</code></pre><p>After</p>",
    );
    expect(segments.map((s) => s.raw)).toEqual(["Before", "After"]);
  });

  test("drops fragments with no letters", () => {
    // 記号や数字だけの断片を翻訳モデルに渡すと文を捏造する。
    expect(extractInlineSegments("<td>—</td><td>42</td>")).toEqual([]);
  });

  test("survives an unterminated tag at a chunk boundary", () => {
    expect(() => extractInlineSegments("<p>Text</p><div class=")).not.toThrow();
  });
});

describe("maskInlineTags", () => {
  test("replaces inline tags with numbered placeholders", () => {
    const masked = maskInlineTags('Read the <a href="/x">docs</a> now')!;
    expect(masked.masked).toBe("Read the [0]docs[1] now");
    expect(masked.tokens).toEqual(['<a href="/x">', "</a>"]);
  });

  test("masks a whole inline code element, content included", () => {
    // 中身を見せると `found` を「見つかりました」に訳す。実測で毎回起きる。
    const masked = maskInlineTags("Run <code>rustup update</code> first")!;
    expect(masked.masked).toBe("Run [0] first");
    expect(masked.tokens).toEqual(["<code>rustup update</code>"]);
  });

  test("bails out when nothing but markup would be left", () => {
    // `[0][1]` だけを渡すと、モデルが記号について解説を始める。
    expect(
      maskInlineTags('<a href="/x"><code>f32::floor</code></a>'),
    ).toBeNull();
  });

  test("bails out when the prose already contains a placeholder-like token", () => {
    expect(
      maskInlineTags("See footnote [0] for details <b>here</b>"),
    ).toBeNull();
  });

  test("keeps the surrounding whitespace separate from the sentence", () => {
    const masked = maskInlineTags("\n  Hello world\n")!;
    expect(masked.masked).toBe("Hello world");
    expect(masked.leading).toBe("\n  ");
    expect(masked.trailing).toBe("\n");
  });
});

describe("restoreInlineTags", () => {
  const tokens = ['<a href="/x">', "</a>"];

  test("restores placeholders that came back in order", () => {
    expect(restoreInlineTags("[0]ドキュメント[1]を読む", tokens)).toBe(
      '<a href="/x">ドキュメント</a>を読む',
    );
  });

  test("accepts reordering as long as the result is still well nested", () => {
    // 日本語は語順が違うので、句が文中で移動するのは正しい翻訳の結果。
    expect(restoreInlineTags("今すぐ[0]ドキュメント[1]", tokens)).toBe(
      '今すぐ<a href="/x">ドキュメント</a>',
    );
  });

  test("rejects an order that would break the nesting", () => {
    expect(restoreInlineTags("[1]ドキュメント[0]", tokens)).toBeNull();
  });

  test("rejects a dropped or duplicated placeholder", () => {
    expect(restoreInlineTags("[0]ドキュメント", tokens)).toBeNull();
    expect(restoreInlineTags("[0]ドキュメント[0]", tokens)).toBeNull();
  });

  test("normalizes the full-width brackets the model writes in Japanese", () => {
    expect(restoreInlineTags("【0】ドキュメント【1】", tokens)).toBe(
      '<a href="/x">ドキュメント</a>',
    );
  });
});

describe("isWellNested", () => {
  test("accepts balanced markup and void elements", () => {
    expect(isWellNested("<a><b>x</b></a>")).toBe(true);
    expect(isWellNested("a<br>b<img src='x'>")).toBe(true);
  });

  test("rejects crossed or unbalanced markup", () => {
    expect(isWellNested("<a><b>x</a></b>")).toBe(false);
    expect(isWellNested("<a>x")).toBe(false);
    expect(isWellNested("x</a>")).toBe(false);
  });
});

describe("applySegments", () => {
  test("keeps every tag when the segments go through mask/restore", () => {
    // これがこの方式の存在理由。モデルの出力がどうであれ、mask → restore を
    // 通った訳文はタグを 1 つも増減させない。
    const html = '<p>Hello <a href="/x">there</a></p><p>Second</p>';
    const segments = extractInlineSegments(html);
    const replacements = segments.map((segment) => {
      const masked = maskInlineTags(segment.raw)!;
      // モデルが訳文とプレースホルダを返してきた体で、語順も入れ替える。
      const pretendModelOutput = masked.tokens.length
        ? "[0]あそこ[1]にこんにちは"
        : "2 番目";
      return restoreInlineTags(pretendModelOutput, masked.tokens);
    });
    const out = applySegments(html, segments, replacements);
    expect(out).toBe('<p><a href="/x">あそこ</a>にこんにちは</p><p>2 番目</p>');
    expect(tagSequence(out)).toEqual(tagSequence(html));
  });

  test("returns the input unchanged when nothing was translated", () => {
    const html = "<p>Hello</p>";
    const segments = extractInlineSegments(html);
    expect(applySegments(html, segments, [null])).toBe(html);
  });
});

describe("extractTextRuns / applyTextRuns", () => {
  test("skips the contents of inline code", () => {
    const runs = extractTextRuns("Run <code>rustup</code> now");
    expect(runs.map((r) => r.text)).toEqual(["Run", "now"]);
  });

  test("splices translations back without moving any tag", () => {
    const raw = "Hello <b>world</b>";
    const runs = extractTextRuns(raw);
    const out = applyTextRuns(raw, runs, ["こんにちは", "世界"]);
    expect(out).toBe("こんにちは <b>世界</b>");
    expect(tagSequence(out)).toEqual(tagSequence(raw));
  });
});

describe("entities", () => {
  test("decodes for the model and re-escapes on the way back", () => {
    expect(decodeEntities("a &amp;&lt;b&gt; &nbsp;c")).toBe(
      "a &<b> ,c".replace(",", " "),
    );
    expect(encodeEntities("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  test("does not double-decode &amp;lt;", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });
});

describe("normalizePlaceholders", () => {
  test("only touches bracketed digits", () => {
    expect(normalizePlaceholders("【0】と［12］と〔3〕")).toBe(
      "[0]と[12]と[3]",
    );
    expect(normalizePlaceholders("【重要】")).toBe("【重要】");
  });
});
