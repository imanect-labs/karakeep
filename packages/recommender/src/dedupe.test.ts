import { describe, expect, it } from "vitest";

import type { DedupeItem } from "./dedupe";
import { findDuplicates, pickRepresentative } from "./dedupe";
import { l2Normalize } from "./vector";

function item(id: string, overrides: Partial<DedupeItem> = {}): DedupeItem {
  return {
    id,
    urlHash: `url-${id}`,
    titleHash: `title-${id}`,
    ...overrides,
  };
}

/** 指定したコサインになるように、基準ベクトルから傾けた単位ベクトルを作る。 */
function vectorAtCosine(cos: number): Float32Array {
  return l2Normalize([cos, Math.sqrt(Math.max(0, 1 - cos * cos))]);
}

describe("findDuplicates", () => {
  it("finds nothing when everything is distinct", () => {
    expect(findDuplicates([item("a"), item("b")]).size).toBe(0);
  });

  it("catches a repeat of an existing candidate by URL", () => {
    const dupes = findDuplicates(
      [item("new", { urlHash: "same" })],
      [item("old", { urlHash: "same" })],
    );
    expect(dupes.get("new")).toBe("old");
  });

  it("catches a mirror by normalized title", () => {
    const dupes = findDuplicates(
      [item("mirror", { titleHash: "same-title" })],
      [item("original", { titleHash: "same-title" })],
    );
    expect(dupes.get("mirror")).toBe("original");
  });

  it("catches two of today's sources carrying the same article", () => {
    // 同じ日に RSS と HN から同じ記事が来ても 1 件しか残さない。
    const dupes = findDuplicates([
      item("rss", { urlHash: "same" }),
      item("hn", { urlHash: "same" }),
    ]);
    expect(dupes.get("hn")).toBe("rss");
    expect(dupes.has("rss")).toBe(false);
  });

  it("catches a reworded repost by embedding proximity", () => {
    const dupes = findDuplicates(
      [item("repost", { embedding: vectorAtCosine(0.97) })],
      [item("origin", { embedding: vectorAtCosine(1) })],
    );
    expect(dupes.get("repost")).toBe("origin");
  });

  it("leaves a merely related article alone", () => {
    // 0.93 は「同じ話題の別記事」も拾いうる閾値。閾値未満は潰さない。
    const dupes = findDuplicates(
      [item("related", { embedding: vectorAtCosine(0.9) })],
      [item("origin", { embedding: vectorAtCosine(1) })],
    );
    expect(dupes.size).toBe(0);
  });

  it("never compares vectors from different embedding models", () => {
    // 次元が違うベクトルを比べると例外になるうえ、比べること自体が誤り。
    const dupes = findDuplicates(
      [item("new", { embedding: l2Normalize([1, 0, 0]) })],
      [item("old", { embedding: l2Normalize([1, 0]) })],
    );
    expect(dupes.size).toBe(0);
  });

  it("collapses a chain instead of pointing at another duplicate", () => {
    // b が a の重複、c が b の重複でも、c は a を指す。そうしないと後段で
    // 代表の candidate を引けない。
    const dupes = findDuplicates([
      item("a", { embedding: vectorAtCosine(1) }),
      item("b", { titleHash: "t", embedding: vectorAtCosine(0.99) }),
      item("c", { titleHash: "t", embedding: vectorAtCosine(0.98) }),
    ]);
    expect(dupes.get("b")).toBe("a");
    expect(dupes.get("c")).toBe("a");
  });

  it("ignores candidates that have no embedding yet", () => {
    const dupes = findDuplicates(
      [item("pending", { embedding: null })],
      [item("origin", { embedding: vectorAtCosine(1) })],
    );
    expect(dupes.size).toBe(0);
  });
});

describe("pickRepresentative", () => {
  it("keeps the oldest, which is more likely the original", () => {
    const chosen = pickRepresentative([
      item("repost", { publishedAt: new Date("2026-08-05") }),
      item("origin", { publishedAt: new Date("2026-08-01") }),
    ]);
    expect(chosen.id).toBe("origin");
  });

  it("puts undated items last", () => {
    const chosen = pickRepresentative([
      item("undated", { publishedAt: null }),
      item("dated", { publishedAt: new Date("2026-08-05") }),
    ]);
    expect(chosen.id).toBe("dated");
  });

  it("breaks ties deterministically", () => {
    const at = new Date("2026-08-01");
    const group = [
      item("b", { publishedAt: at }),
      item("a", { publishedAt: at }),
    ];
    expect(pickRepresentative(group).id).toBe("a");
  });
});
