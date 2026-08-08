import { describe, expect, it } from "vitest";

import { domainOf, normalizeTitleHash, normalizeUrl } from "./url";

function canonical(raw: string): string | null {
  return normalizeUrl(raw)?.canonicalUrl ?? null;
}

describe("normalizeUrl", () => {
  it("rejects things that are not http(s) URLs", () => {
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("mailto:a@example.com")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://example.com/f")).toBeNull();
  });

  it("folds http to https", () => {
    // 同じ記事が両方のスキームで流れてくる。ここを分けると重複する。
    expect(canonical("http://example.com/post")).toBe(
      "https://example.com/post",
    );
  });

  it("drops www, the default port, and the fragment", () => {
    expect(canonical("https://www.example.com:443/post#section-2")).toBe(
      "https://example.com/post",
    );
  });

  it("drops the trailing slash except at the root", () => {
    expect(canonical("https://example.com/post/")).toBe(
      "https://example.com/post",
    );
    expect(canonical("https://example.com/")).toBe("https://example.com/");
    expect(canonical("https://example.com")).toBe("https://example.com/");
  });

  it("strips tracking parameters", () => {
    expect(
      canonical(
        "https://example.com/post?utm_source=rss&utm_medium=feed&fbclid=abc&gclid=def",
      ),
    ).toBe("https://example.com/post");
  });

  it("keeps parameters that identify the article", () => {
    // CMS のパーマリンクを巻き込んで消すほうが害が大きい。
    expect(canonical("https://example.com/index.php?p=123&utm_source=x")).toBe(
      "https://example.com/index.php?p=123",
    );
  });

  it("sorts the surviving parameters", () => {
    expect(canonical("https://example.com/s?b=2&a=1")).toBe(
      canonical("https://example.com/s?a=1&b=2"),
    );
  });

  it("only strips host-scoped tracking on that host", () => {
    expect(canonical("https://youtube.com/watch?v=abc&si=xyz")).toBe(
      "https://youtube.com/watch?v=abc",
    );
    // 他サイトの si は意味があるかもしれないので残す。
    expect(canonical("https://example.com/p?si=xyz")).toBe(
      "https://example.com/p?si=xyz",
    );
  });

  it("resolves AMP variants to the same URL", () => {
    const plain = canonical("https://example.com/post");
    expect(canonical("https://example.com/post/amp")).toBe(plain);
    expect(canonical("https://amp.example.com/post")).toBe(plain);
    expect(canonical("https://example.com/post?amp=1")).toBe(plain);
  });

  it("unwraps the Google AMP cache", () => {
    expect(
      canonical("https://example-com.cdn.ampproject.org/c/s/example.com/post"),
    ).toBe("https://example.com/post");
  });

  it("gives the same hash to URLs that normalize the same", () => {
    const a = normalizeUrl("http://WWW.Example.com/post/?utm_source=rss#x");
    const b = normalizeUrl("https://example.com/post");
    expect(a!.urlHash).toBe(b!.urlHash);
  });

  it("gives different hashes to genuinely different URLs", () => {
    expect(normalizeUrl("https://example.com/a")!.urlHash).not.toBe(
      normalizeUrl("https://example.com/b")!.urlHash,
    );
  });

  it("keeps subdomains apart as separate domains", () => {
    // blog.example.com と shop.example.com は別のソースとして扱いたい。
    expect(domainOf("https://blog.example.com/x")).toBe("blog.example.com");
    expect(domainOf("https://shop.example.com/x")).toBe("shop.example.com");
    expect(domainOf("https://www.example.com/x")).toBe("example.com");
  });

  it("returns null for a domain it cannot parse", () => {
    expect(domainOf("nonsense")).toBeNull();
  });
});

describe("normalizeTitleHash", () => {
  it("ignores punctuation, case and spacing", () => {
    expect(normalizeTitleHash("Hello, World!")).toBe(
      normalizeTitleHash("hello world"),
    );
    expect(normalizeTitleHash("SQLite の WAL モード")).toBe(
      normalizeTitleHash("SQLiteのWALモード"),
    );
  });

  it("normalizes full-width characters", () => {
    expect(normalizeTitleHash("ＳＱＬｉｔｅ")).toBe(
      normalizeTitleHash("SQLite"),
    );
  });

  it("keeps versions apart", () => {
    // ストップワード除去まで踏み込むとここが同一になってしまう。
    expect(normalizeTitleHash("Rust 1.90 released")).not.toBe(
      normalizeTitleHash("Rust 1.91 released"),
    );
  });

  it("returns null when there is nothing left", () => {
    expect(normalizeTitleHash(null)).toBeNull();
    expect(normalizeTitleHash("")).toBeNull();
    expect(normalizeTitleHash("!!! ---")).toBeNull();
  });
});
