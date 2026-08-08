import { describe, expect, test } from "vitest";

import {
  buildDigestUserPrompt,
  NO_BODY_PLACEHOLDER,
  parseDigestResponse,
} from "./digest";

describe("buildDigestUserPrompt", () => {
  test("puts the placeholder in when there is no body at all", () => {
    const prompt = buildDigestUserPrompt({
      title: "A Six-Dimensional Taxonomy",
      url: "https://arxiv.org/abs/1",
      body: "   ",
    });
    expect(prompt).toContain("TITLE: A Six-Dimensional Taxonomy");
    expect(prompt).toContain("URL: https://arxiv.org/abs/1");
    // プロンプトが「(本文情報なし)」のときだけ空要約を許している。
    // ここの文字列を変えるならシステムプロンプトも直すこと。
    expect(prompt).toContain(`BODY: ${NO_BODY_PLACEHOLDER}`);
  });

  test("keeps an empty TITLE line when the candidate has no title", () => {
    const prompt = buildDigestUserPrompt({
      title: null,
      url: "https://example.com/",
      body: "hello",
    });
    expect(prompt.split("\n")[0]).toBe("TITLE: ");
    expect(prompt).toContain("BODY: hello");
  });
});

describe("parseDigestResponse", () => {
  test("reads a plain JSON object", () => {
    const parsed = parseDigestResponse(
      '{"title_ja":"六次元分類","summary_ja":"要約です。"}',
    );
    expect(parsed).toEqual({ titleJa: "六次元分類", summaryJa: "要約です。" });
  });

  test("survives a code fence and a preamble", () => {
    const parsed = parseDigestResponse(
      'はい、こちらです:\n```json\n{"title_ja":"訳題","summary_ja":"要約"}\n```',
    );
    expect(parsed?.titleJa).toBe("訳題");
  });

  test("turns an empty summary into null rather than an empty string", () => {
    // 本文情報が無い記事ではモデルに空文字を返させている。UI 側で
    // 「要約あり」と誤判定しないよう null に寄せる。
    const parsed = parseDigestResponse('{"title_ja":"訳題","summary_ja":"  "}');
    expect(parsed).toEqual({ titleJa: "訳題", summaryJa: null });
  });

  test("fails when the translated title is missing", () => {
    // 訳題が空なら失敗扱いにする。原題を出したほうがまだ読める。
    expect(
      parseDigestResponse('{"title_ja":"","summary_ja":"要約"}'),
    ).toBeNull();
    expect(parseDigestResponse('{"summary_ja":"要約"}')).toBeNull();
  });

  test("fails on non-JSON output", () => {
    expect(parseDigestResponse("すみません、わかりません")).toBeNull();
    expect(parseDigestResponse("")).toBeNull();
    expect(parseDigestResponse("{ broken")).toBeNull();
  });
});
