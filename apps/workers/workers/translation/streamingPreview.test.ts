import { expect, it } from "vitest";
import { streamingProse } from "./streamingPreview";

it("extracts prose from incomplete HTML without exposing code or executable content", () => {
  expect(
    streamingProse(
      "<p>翻訳しています</p><pre><code>const secret=1;</code></pre><script>alert(1)</script><p>途中",
    ),
  ).toBe("翻訳しています\n\n途中");
  expect(streamingProse("<p>本文</p><code>incomplete")).toBe("本文");
});
it("handles fenced responses and encoded text as plain preview text", () => {
  expect(streamingProse("```html\n<p>A &amp; B</p>\n```")).toBe("A & B");
});
