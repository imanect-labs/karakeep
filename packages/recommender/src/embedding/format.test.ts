import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  formatDocumentForEmbedding,
  MAX_EMBEDDING_TOKENS,
  truncateToTokens,
} from "./format";

describe("estimateTokens", () => {
  it("charges CJK text more per character than Latin text", () => {
    // 同じ文字数でも日本語のほうがトークンを食う。ここが逆転していると、
    // 日本語記事だけモデル側で黙って切られる。
    const ja = "分散システムの話題について";
    const en = "aaaaaaaaaaaaa";
    expect(ja.length).toBe(en.length);
    expect(estimateTokens(ja)).toBeGreaterThan(estimateTokens(en));
  });

  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("truncateToTokens", () => {
  it("leaves short text untouched", () => {
    expect(truncateToTokens("hello", 100)).toBe("hello");
  });

  it("cuts long text down to the budget", () => {
    const long = "分散システム".repeat(1000);
    const cut = truncateToTokens(long, 100);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(100);
    expect(cut.length).toBeGreaterThan(0);
    expect(long.startsWith(cut)).toBe(true);
  });

  it("can cut all the way to empty when the budget is 0", () => {
    expect(truncateToTokens("あああ", 0)).toBe("");
  });
});

describe("formatDocumentForEmbedding", () => {
  it("uses the document format the model expects", () => {
    expect(
      formatDocumentForEmbedding({ title: "SQLite の WAL", body: "本文" }),
    ).toBe("title: SQLite の WAL | text: 本文");
  });

  it("writes 'none' when there is no title", () => {
    // 空文字にすると書式が崩れ、学習時の分布から外れる。
    expect(formatDocumentForEmbedding({ body: "本文だけ" })).toBe(
      "title: none | text: 本文だけ",
    );
  });

  it("returns null when there is nothing to embed", () => {
    expect(formatDocumentForEmbedding({})).toBeNull();
    expect(
      formatDocumentForEmbedding({ title: "  ", summary: "", body: null }),
    ).toBeNull();
  });

  it("keeps a title-only document (FR-S-03)", () => {
    // 本文取得に失敗しても候補を落とさない。
    expect(formatDocumentForEmbedding({ title: "見出しだけ" })).toBe(
      "title: 見出しだけ | text: ",
    );
  });

  it("collapses whitespace", () => {
    expect(
      formatDocumentForEmbedding({ title: " a \n b ", body: "c\t\td" }),
    ).toBe("title: a b | text: c d");
  });

  it("drops the body when it just repeats the summary", () => {
    const summary =
      "この記事は組み込み向けデータベースの書き込み経路について解説する。";
    const body = `${summary} 続きの本文がここに入る。`;
    const formatted = formatDocumentForEmbedding({ title: "t", summary, body });
    expect(formatted).toBe(`title: t | text: ${summary}`);
  });

  it("keeps both when the body genuinely differs from the summary", () => {
    const formatted = formatDocumentForEmbedding({
      title: "t",
      summary: "要約です",
      body: "まったく別の本文が続きます",
    });
    expect(formatted).toBe(
      "title: t | text: 要約です まったく別の本文が続きます",
    );
  });

  it("stays inside the token budget for a long Japanese article", () => {
    const formatted = formatDocumentForEmbedding({
      title: "長い記事",
      summary: "要約".repeat(500),
      body: "本文".repeat(5000),
    });
    expect(estimateTokens(formatted!)).toBeLessThanOrEqual(
      MAX_EMBEDDING_TOKENS,
    );
  });

  it("stays inside the token budget for a long English article", () => {
    const formatted = formatDocumentForEmbedding({
      title: "A long article",
      summary: "summary ".repeat(200),
      body: "the quick brown fox ".repeat(2000),
    });
    expect(estimateTokens(formatted!)).toBeLessThanOrEqual(
      MAX_EMBEDDING_TOKENS,
    );
  });

  it("caps the body by characters, not only by tokens", () => {
    // 英語本文はトークン上限だけだと 4,000 文字以上通ってしまう。話題では
    // なく細部が効きはじめるので、文字数側でも止める。
    const formatted = formatDocumentForEmbedding({
      title: "t",
      body: "x".repeat(9000),
    });
    expect(formatted!.length).toBeLessThan(2000);
  });
});
