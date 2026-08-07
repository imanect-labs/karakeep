import { describe, expect, it } from "vitest";

import {
  acceptsQualityClass,
  extractPrimarySourceSignals,
  hasRecentActivity,
  isBlockedDomain,
  looksLikePrimarySource,
  screenDomain,
} from "./quality";

const NOW = new Date("2026-08-07T05:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("isBlockedDomain", () => {
  it("blocks link shorteners", () => {
    expect(isBlockedDomain("bit.ly")).toBe(true);
    expect(isBlockedDomain("t.co")).toBe(true);
  });

  it("blocks multi-author platforms", () => {
    // ドメイン単位のバンディットが機能しない。中身の質が書き手ごとに
    // まったく違うので、ドメインの事後分布が何も意味しない。
    expect(isBlockedDomain("medium.com")).toBe(true);
    expect(isBlockedDomain("qiita.com")).toBe(true);
    expect(isBlockedDomain("zenn.dev")).toBe(true);
  });

  it("blocks subdomains of blocked hosts", () => {
    expect(isBlockedDomain("blog.medium.com")).toBe(true);
  });

  it("leaves independent sites alone", () => {
    expect(isBlockedDomain("simonwillison.net")).toBe(false);
    expect(isBlockedDomain("blog.example.ac.jp")).toBe(false);
  });

  it("does not match on a coincidental suffix", () => {
    expect(isBlockedDomain("notmedium.com")).toBe(false);
  });
});

describe("hasRecentActivity", () => {
  it("accepts a site with three recent articles", () => {
    expect(hasRecentActivity([daysAgo(1), daysAgo(30), daysAgo(80)], NOW)).toBe(
      true,
    );
  });

  it("rejects a site that stopped publishing", () => {
    expect(
      hasRecentActivity([daysAgo(200), daysAgo(300), daysAgo(400)], NOW),
    ).toBe(false);
  });

  it("rejects a site with too few articles", () => {
    expect(hasRecentActivity([daysAgo(1), daysAgo(2)], NOW)).toBe(false);
  });

  it("ignores missing dates", () => {
    expect(hasRecentActivity([null, undefined, daysAgo(1)], NOW)).toBe(false);
  });
});

describe("looksLikePrimarySource", () => {
  const healthy = {
    medianBodyLength: 4000,
    outboundLinkRatio: 0.4,
    adScriptCount: 2,
  };

  it("accepts a normal article site", () => {
    expect(looksLikePrimarySource(healthy).passed).toBe(true);
  });

  it("rejects pages with almost no text", () => {
    expect(
      looksLikePrimarySource({ ...healthy, medianBodyLength: 120 }).passed,
    ).toBe(false);
  });

  it("rejects link farms", () => {
    expect(
      looksLikePrimarySource({ ...healthy, outboundLinkRatio: 6 }).passed,
    ).toBe(false);
  });

  it("rejects ad-saturated pages", () => {
    expect(
      looksLikePrimarySource({ ...healthy, adScriptCount: 40 }).passed,
    ).toBe(false);
  });

  it("keeps a short-form personal blog", () => {
    // しきい値を厳しくすると、短い記事を書く良質な個人ブログを落とす。
    // 微妙なものは LLM 分類（4 段目）に渡す。
    expect(
      looksLikePrimarySource({
        medianBodyLength: 900,
        outboundLinkRatio: 1.2,
        adScriptCount: 0,
      }).passed,
    ).toBe(true);
  });
});

describe("extractPrimarySourceSignals", () => {
  it("measures text length, link ratio and ad scripts", () => {
    const html = `<html><body>
      <p>${"本文".repeat(300)}</p>
      <p><a href="https://a.example/x">one</a></p>
      <script src="https://www.googletagmanager.com/gtm.js"></script>
      <script src="https://pagead2.googlesyndication.com/x.js"></script>
    </body></html>`;
    const signals = extractPrimarySourceSignals([html]);
    expect(signals.medianBodyLength).toBeGreaterThan(500);
    expect(signals.outboundLinkRatio).toBeCloseTo(0.5, 1);
    expect(signals.adScriptCount).toBe(2);
  });

  it("excludes script and style bodies from the text length", () => {
    const html = `<html><body>
      <script>${"x".repeat(5000)}</script>
      <style>${"y".repeat(5000)}</style>
      <p>short</p></body></html>`;
    expect(extractPrimarySourceSignals([html]).medianBodyLength).toBeLessThan(
      50,
    );
  });

  it("returns zeros for an empty sample", () => {
    expect(extractPrimarySourceSignals([])).toEqual({
      medianBodyLength: 0,
      outboundLinkRatio: 0,
      adScriptCount: 0,
    });
  });
});

describe("screenDomain", () => {
  const recent = [daysAgo(1), daysAgo(10), daysAgo(20)];

  it("passes a healthy independent site", () => {
    expect(
      screenDomain({
        domain: "simonwillison.net",
        articleDates: recent,
        signals: {
          medianBodyLength: 4000,
          outboundLinkRatio: 0.5,
          adScriptCount: 1,
        },
        now: NOW,
      }),
    ).toEqual({ passed: true });
  });

  it("stops at the blocklist before doing any work", () => {
    expect(
      screenDomain({ domain: "bit.ly", articleDates: recent, now: NOW }),
    ).toEqual({ passed: false, reason: "blocklist" });
  });

  it("reports why it rejected, so the decision is not repeated", () => {
    // 同じドメインが再発見されたときに再審査しないため（FR-D-18）。
    const verdict = screenDomain({
      domain: "dead.example",
      articleDates: [daysAgo(300)],
      now: NOW,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("fewer than 3 articles");
  });

  it("passes without signals when they could not be gathered", () => {
    expect(
      screenDomain({ domain: "a.example", articleDates: recent, now: NOW })
        .passed,
    ).toBe(true);
  });
});

describe("acceptsQualityClass", () => {
  it("takes primary and analysis, rejects syndication and promotion", () => {
    expect(acceptsQualityClass("primary")).toBe(true);
    expect(acceptsQualityClass("analysis")).toBe(true);
    expect(acceptsQualityClass("syndication")).toBe(false);
    expect(acceptsQualityClass("promotional")).toBe(false);
    expect(acceptsQualityClass("unknown")).toBe(false);
  });
});
