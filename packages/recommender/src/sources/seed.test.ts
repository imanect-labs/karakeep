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
    const independent = SEED_SOURCES.filter((s) => s.profileIndependent);
    expect(independent.length).toBeGreaterThan(0);
    expect(PROFILE_INDEPENDENT_FLOOR).toBe(0.2);
  });

  test("is large enough to fill a briefing on day one", () => {
    // 少なすぎると初日の候補プールが薄くなり、多様性の上限がそこで決まる。
    expect(SEED_SOURCES.length).toBeGreaterThanOrEqual(50);
  });
});
