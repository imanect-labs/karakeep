import { describe, expect, test } from "vitest";

import { PROFILE_INDEPENDENT_FLOOR } from "../intake";
import type { RssSourceConfig } from "./rss";
import { SEED_SOURCES } from "./seed";

/**
 * 手書きの一覧なので、テストは「値が何か」ではなく「形が壊れていないか」に
 * 当てる。feed の到達性は見ない（ネットワーク依存で不安定になるうえ、
 * 全件が本番投入前に実測済み）。
 */
describe("SEED_SOURCES", () => {
  test("has names unique enough to serve as the idempotency key", () => {
    // enroll は `(userId, name)` の重複で二重登録を防ぐ。ここが重複すると
    // 片方が永久に登録されない。
    const names = SEED_SOURCES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every rss source carries a parseable, unique feedUrl", () => {
    const feedUrls: string[] = [];
    for (const source of SEED_SOURCES) {
      if (source.kind !== "rss") {
        continue;
      }
      const { feedUrl } = source.config as RssSourceConfig;
      expect(feedUrl, `${source.name} has no feedUrl`).toBeTruthy();
      expect(
        () => new URL(feedUrl),
        `${source.name}: ${feedUrl}`,
      ).not.toThrow();
      expect(new URL(feedUrl).protocol, source.name).toBe("https:");
      feedUrls.push(feedUrl);
    }
    expect(new Set(feedUrls).size, "duplicate feedUrl").toBe(feedUrls.length);
  });

  test("only uses kinds that have an adapter", () => {
    // `scrape` と `custom` は未実装で、`getSourceAdapter` が null を返す ──
    // 登録しても黙って飛ばされるだけになる。
    const implemented = new Set(["rss", "hn", "arxiv", "github"]);
    for (const source of SEED_SOURCES) {
      expect(implemented.has(source.kind), source.name).toBe(true);
    }
  });

  test("keeps profile-independent aggregators available", () => {
    // FR-C-03 の床は取り込み件数に対する 20% だが、供給できる非依存ソースが
    // 無いと `allocateIntake` の reserved が 0 になり床が死ぬ。`random` アームも
    // 同じプールから引くので、そちらも枯れる。
    //
    // **件数の下限を置く理由。** 床は 800 × 0.2 = 160 **候補**で、ソース数では
    // ない。1 ソースが 1 日に出す記事は多くて数十件なので、3 件では 160 に
    // 届かず床が黙って縮む（`min(reserved, independentAvailable)`）。
    // 6 件あれば平常時は満たせる。減らすときはこの算数をやり直すこと。
    const independent = SEED_SOURCES.filter((s) => s.profileIndependent);
    expect(independent.length).toBeGreaterThanOrEqual(6);
    expect(PROFILE_INDEPENDENT_FLOOR).toBe(0.2);
  });

  test("is large enough to fill a briefing on day one", () => {
    // 少なすぎると初日の候補プールが薄くなり、多様性の上限がそこで決まる。
    expect(SEED_SOURCES.length).toBeGreaterThanOrEqual(50);
  });

  test("no single host dominates the supply", () => {
    // giken-ops #120 の再発防止。**供給層は全員共通で削らない**方針なので、
    // 偏りはランキングでは取り消せず、ここでしか直せない。特定のホストが
    // 大半を占めると、そのホストが落ちた日に供給がまとめて消えるリスクも付く。
    //
    // Zenn の Publication のように、同じホストで書き手が違うものは意図的に
    // 別ソースにしてある（`zenn.dev` が最多になるのはそのため）。上限は
    // その運用が続けられる程度に緩く取る。
    const hosts = new Map<string, number>();
    for (const source of SEED_SOURCES) {
      if (source.kind !== "rss") {
        continue;
      }
      const { hostname } = new URL((source.config as RssSourceConfig).feedUrl);
      hosts.set(hostname, (hosts.get(hostname) ?? 0) + 1);
    }
    const [topHost, topCount] = [...hosts].sort((a, b) => b[1] - a[1])[0];
    expect(
      topCount / SEED_SOURCES.length,
      `${topHost} が ${topCount}/${SEED_SOURCES.length} 件を占めている`,
    ).toBeLessThan(0.15);
  });
});
