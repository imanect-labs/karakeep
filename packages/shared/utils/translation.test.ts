import { describe, expect, it } from "vitest";
import { readerTranslationHtml } from "./translation";

describe("streaming reader content", () => {
  const source = "<p>One</p><p>Two</p><p>Three</p>";
  it("shows draft prose in place of its source chunk, followed by the untranslated remainder", () => {
    const html = readerTranslationHtml({
      source,
      translated: "<p>一</p>",
      sourceOffset: 10,
      incomplete: true,
      preview: { text: "二の途中", sourceEnd: 20 },
    });
    expect(html).toContain("<p>一</p>");
    expect(html).toContain("二の途中");
    expect(html).toContain("<p>Three</p>");
    expect(html).not.toContain("Two");
  });
  it("escapes model text instead of executing streamed markup", () => {
    const html = readerTranslationHtml({
      source,
      translated: "",
      sourceOffset: 0,
      incomplete: true,
      preview: { text: '<img src=x onerror="alert(1)"> & data', sourceEnd: 10 },
    });
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("&amp; data");
  });
  it("ignores invalid offsets and restores source while a failed chunk is retryable", () => {
    expect(
      readerTranslationHtml({
        source,
        translated: "",
        sourceOffset: 0,
        incomplete: true,
        preview: { text: "invalid", sourceEnd: 10000 },
      }),
    ).toBe(source);
  });
  it("uses only validated HTML after completion", () => {
    expect(
      readerTranslationHtml({
        source,
        translated: "<p>完了</p>",
        sourceOffset: source.length,
        incomplete: false,
        preview: { text: "stale", sourceEnd: 10 },
      }),
    ).toBe("<p>完了</p>");
  });
});
