import { describe, expect, it } from "vitest";

import {
  aggregateBookmarkDomains,
  aggregateOutboundDomains,
  describeBookmarkEvidence,
  describeOutboundEvidence,
  extractOutboundDomains,
} from "./links";

describe("extractOutboundDomains", () => {
  it("collects external domains from anchors", () => {
    const html = `
      <a href="https://simonwillison.net/2026/post">a</a>
      <a href="https://lobste.rs/s/abc">b</a>`;
    expect(extractOutboundDomains(html, "example.com").sort()).toEqual([
      "lobste.rs",
      "simonwillison.net",
    ]);
  });

  it("drops self links", () => {
    const html = `<a href="https://example.com/other">a</a>`;
    expect(extractOutboundDomains(html, "example.com")).toEqual([]);
  });

  it("counts a domain once per article", () => {
    // 目次やナビで同じ先を何度も指すページがある。数えると票が壊れる。
    const html = `
      <a href="https://lobste.rs/a">1</a>
      <a href="https://lobste.rs/b">2</a>
      <a href="https://lobste.rs/c">3</a>`;
    expect(extractOutboundDomains(html, "example.com")).toEqual(["lobste.rs"]);
  });

  it("ignores boilerplate hosts", () => {
    const html = `
      <a href="https://www.w3.org/TR/html5">spec</a>
      <a href="https://creativecommons.org/licenses/by/4.0/">license</a>
      <a href="https://cdn.jsdelivr.net/x.js">cdn</a>`;
    expect(extractOutboundDomains(html, "example.com")).toEqual([]);
  });

  it("ignores non-http links", () => {
    const html = `<a href="mailto:a@b.com">mail</a><a href="#top">top</a>`;
    expect(extractOutboundDomains(html, "example.com")).toEqual([]);
  });
});

describe("aggregateOutboundDomains", () => {
  it("weights by the reward of the referring article, not the link count", () => {
    // リンクを大量に張る記事 1 本で順位が決まらないようにする。
    const result = aggregateOutboundDomains([
      {
        bookmarkId: "loved",
        html: `<a href="https://a.example/x">a</a>`,
        sourceDomain: "src.example",
        reward: 2.0,
      },
      {
        bookmarkId: "meh",
        html: `<a href="https://b.example/x">b</a>`,
        sourceDomain: "src.example",
        reward: 0.2,
      },
    ]);
    expect(result[0].domain).toBe("a.example");
    expect(result[0].weight).toBeCloseTo(2.0, 6);
  });

  it("accumulates across articles and keeps evidence", () => {
    const result = aggregateOutboundDomains([
      {
        bookmarkId: "b1",
        html: `<a href="https://a.example/1">x</a>`,
        sourceDomain: "src.example",
        reward: 1,
      },
      {
        bookmarkId: "b2",
        html: `<a href="https://a.example/2">y</a>`,
        sourceDomain: "src.example",
        reward: 1,
      },
    ]);
    expect(result[0].referrerCount).toBe(2);
    expect(result[0].evidenceBookmarkIds).toEqual(["b1", "b2"]);
    expect(describeOutboundEvidence(result[0])).toBe(
      "あなたが保存した記事 2 本からリンクされていました",
    );
  });

  it("caps how much evidence it keeps", () => {
    const result = aggregateOutboundDomains(
      Array.from({ length: 20 }, (_, i) => ({
        bookmarkId: `b${i}`,
        html: `<a href="https://a.example/${i}">x</a>`,
        sourceDomain: "src.example",
        reward: 1,
      })),
    );
    expect(result[0].referrerCount).toBe(20);
    expect(result[0].evidenceBookmarkIds).toHaveLength(5);
  });

  it("never lets a negative reward subtract weight", () => {
    const result = aggregateOutboundDomains([
      {
        bookmarkId: "dismissed",
        html: `<a href="https://a.example/x">a</a>`,
        sourceDomain: "src.example",
        reward: -1,
      },
    ]);
    expect(result[0].weight).toBe(0);
  });

  it("returns nothing for articles with no outbound links", () => {
    expect(
      aggregateOutboundDomains([
        {
          bookmarkId: "b",
          html: "<p>no links here</p>",
          sourceDomain: "src.example",
          reward: 1,
        },
      ]),
    ).toEqual([]);
  });
});

describe("aggregateBookmarkDomains", () => {
  it("ranks domains the user actually engaged with higher", () => {
    const result = aggregateBookmarkDomains([
      { bookmarkId: "1", url: "https://read.example/a", isPositive: true },
      { bookmarkId: "2", url: "https://saved.example/a", isPositive: false },
      { bookmarkId: "3", url: "https://saved.example/b", isPositive: false },
    ]);
    // read は 1 本で重み 2、saved は 2 本で重み 2 の同点だが、順位は
    // 参照本数で割れる。どちらにせよ両方が候補に上がることが要点。
    expect(result.map((r) => r.domain).sort()).toEqual([
      "read.example",
      "saved.example",
    ]);
    expect(result.find((r) => r.domain === "read.example")!.weight).toBe(2);
  });

  it("collapses subdomain-free duplicates through URL normalization", () => {
    const result = aggregateBookmarkDomains([
      { bookmarkId: "1", url: "https://www.blog.example/a", isPositive: false },
      {
        bookmarkId: "2",
        url: "http://blog.example/b?utm_source=x",
        isPositive: false,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("blog.example");
    expect(describeBookmarkEvidence(result[0])).toBe(
      "あなたが 2 本のブックマークを保存しているサイトです",
    );
  });

  it("skips unparseable urls", () => {
    expect(
      aggregateBookmarkDomains([
        { bookmarkId: "1", url: "not a url", isPositive: false },
      ]),
    ).toEqual([]);
  });
});
