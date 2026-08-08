import { describe, expect, test } from "vitest";

import {
  cleanTranslatedText,
  hasInventedDigits,
  isUsableTranslation,
} from "./localChunk";

describe("cleanTranslatedText", () => {
  test("drops the </s> CAT-Translate leaks into its output", () => {
    expect(cleanTranslatedText("これは翻訳です。</s>")).toBe(
      "これは翻訳です。",
    );
  });

  test("drops a code fence", () => {
    expect(cleanTranslatedText("```\nこれは翻訳です。\n```")).toBe(
      "これは翻訳です。",
    );
  });

  test("collapses to a single line", () => {
    // 元はテキストノード 1 つなので、行が増えているのはモデルが余計なことを
    // 書いた合図。
    expect(cleanTranslatedText("これは\n\n翻訳です。")).toBe(
      "これは 翻訳です。",
    );
  });
});

describe("hasInventedDigits", () => {
  test("flags a number the source never had", () => {
    // 実測の代表的な壊れ方: "LLD is now the default linker on [0]" に対して
    // "LLD 1.25は、[0]で…" という存在しない版番号を書いてくる。
    expect(
      hasInventedDigits(
        "LLD is now the default linker on [0]",
        "LLD 1.25は、[0]でデフォルトのリンカーになりました。",
      ),
    ).toBe(true);
  });

  test("allows numbers that are in the source", () => {
    expect(
      hasInventedDigits("Rust 1.90.0 is out", "Rust 1.90.0 が出ました"),
    ).toBe(false);
  });
});

describe("isUsableTranslation", () => {
  const source =
    "If you encounter any issues with the LLD linker, let us know.";

  test("accepts an ordinary translation", () => {
    expect(
      isUsableTranslation(
        source,
        "LLD リンカーで問題が発生した場合はお知らせください。",
        true,
      ),
    ).toBe(true);
  });

  test("rejects a degenerate run-on", () => {
    // 実測: モデルが ". . . . ." を延々と吐いた。
    expect(isUsableTranslation(source, ". ".repeat(200), true)).toBe(false);
  });

  test("rejects output that stayed in the source language", () => {
    expect(isUsableTranslation(source, source, true)).toBe(false);
  });

  test("rejects an empty response", () => {
    expect(isUsableTranslation(source, "", true)).toBe(false);
  });

  test("only applies the digit guard to short fragments", () => {
    // 長い文では "ten times" -> "10倍" のような正当な変換がある。
    const long = "a".repeat(60);
    expect(isUsableTranslation(long, "これは 10 倍の速さです。", true)).toBe(
      true,
    );
    expect(isUsableTranslation("get ", "1つ取得する", true)).toBe(false);
  });
});
