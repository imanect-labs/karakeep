import { describe, expect, test } from "vitest";

import {
  buildBatchDigestUserPrompt,
  buildDigestUserPrompt,
  NO_BODY_PLACEHOLDER,
  parseBatchDigestResponse,
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

describe("buildBatchDigestUserPrompt", () => {
  test("numbers the articles from 1 and separates them", () => {
    const prompt = buildBatchDigestUserPrompt([
      { title: "First", url: "https://example.com/1", body: "one" },
      { title: "Second", url: "https://example.com/2", body: "two" },
    ]);
    expect(prompt).toContain("[1]\nTITLE: First");
    expect(prompt).toContain("[2]\nTITLE: Second");
    expect(prompt).toContain("\n---\n");
  });
});

describe("parseBatchDigestResponse", () => {
  const expected = (n: number) => ({
    titleJa: `訳題${n}`,
    summaryJa: `要約${n}`,
  });

  test("reads the documented items[] shape", () => {
    const parsed = parseBatchDigestResponse(
      '{"items":[{"id":1,"title_ja":"訳題1","summary_ja":"要約1"},{"id":2,"title_ja":"訳題2","summary_ja":"要約2"}]}',
    );
    expect(parsed.get(1)).toEqual(expected(1));
    expect(parsed.get(2)).toEqual(expected(2));
  });

  test("reads an id-keyed object", () => {
    // 実測 (OpenCode Go / mimo-v2.5): strict な json_schema を付けても
    // この形で返ってくることがある。
    const parsed = parseBatchDigestResponse(
      '{"1":{"title_ja":"訳題1","summary_ja":"要約1"},"2":{"title_ja":"訳題2","summary_ja":"要約2"}}',
    );
    expect(parsed.size).toBe(2);
    expect(parsed.get(2)).toEqual(expected(2));
  });

  test("reads an array under a different key, and a bare array", () => {
    expect(
      parseBatchDigestResponse(
        '{"results":[{"id":7,"title_ja":"訳題7","summary_ja":"要約7"}]}',
      ).get(7),
    ).toEqual(expected(7));
    expect(
      parseBatchDigestResponse(
        '[{"id":1,"title_ja":"訳題1","summary_ja":"要約1"}]',
      ).get(1),
    ).toEqual(expected(1));
  });

  test("falls back to the position when an array item has no id", () => {
    const parsed = parseBatchDigestResponse(
      '[{"title_ja":"訳題1","summary_ja":"要約1"},{"title_ja":"訳題2","summary_ja":"要約2"}]',
    );
    expect(parsed.get(1)).toEqual(expected(1));
    expect(parsed.get(2)).toEqual(expected(2));
  });

  test('reads a string "1" as an id', () => {
    expect(
      parseBatchDigestResponse(
        '{"items":[{"id":"3","title_ja":"訳題3","summary_ja":"要約3"}]}',
      ).get(3),
    ).toEqual(expected(3));
  });

  test("keeps the readable items and drops the broken ones", () => {
    // 欠けた ID は呼び出し側が単発で作り直す。1 件の取りこぼしで
    // バッチ全体を捨てない。
    const parsed = parseBatchDigestResponse(
      '{"items":[{"id":1,"title_ja":"訳題1","summary_ja":"要約1"},{"id":2,"title_ja":"","summary_ja":"要約2"},{"id":3,"summary_ja":"要約3"}]}',
    );
    expect([...parsed.keys()]).toEqual([1]);
  });

  test("turns an empty summary into null", () => {
    expect(
      parseBatchDigestResponse(
        '{"items":[{"id":1,"title_ja":"訳題1","summary_ja":"   "}]}',
      ).get(1),
    ).toEqual({ titleJa: "訳題1", summaryJa: null });
  });

  test("drops items that leaked simplified Chinese", () => {
    // バッチだと 3〜4% の頻度で「中间」「时」のような字が混ざる (実測)。
    // 読めなかった扱いにして単発で作り直させる。
    const parsed = parseBatchDigestResponse(
      '{"items":[' +
        '{"id":1,"title_ja":"訳題1","summary_ja":"中间ステップが潜在空間にある。"},' +
        '{"id":2,"title_ja":"潜在推論モデルの时代","summary_ja":"要約2"},' +
        '{"id":3,"title_ja":"訳題3","summary_ja":"要約3"}]}',
    );
    expect([...parsed.keys()]).toEqual([3]);
  });

  test("keeps kanji that Japanese actually uses", () => {
    const parsed = parseBatchDigestResponse(
      '{"items":[{"id":1,"title_ja":"中間表現と時間","summary_ja":"問題の実現には認識と経験が必要。専門用語は原語のまま。"}]}',
    );
    expect(parsed.get(1)?.titleJa).toBe("中間表現と時間");
  });

  test("survives a code fence, and returns empty on junk", () => {
    expect(
      parseBatchDigestResponse(
        'はい:\n```json\n{"items":[{"id":1,"title_ja":"訳題1","summary_ja":"要約1"}]}\n```',
      ).get(1),
    ).toEqual(expected(1));
    expect(parseBatchDigestResponse("すみません").size).toBe(0);
    expect(parseBatchDigestResponse("").size).toBe(0);
    expect(parseBatchDigestResponse("{ broken").size).toBe(0);
  });
});
