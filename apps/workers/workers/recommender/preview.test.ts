import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ fetch: vi.fn(), enqueue: vi.fn() }));
vi.mock("network", () => ({
  fetchWithProxy: mock.fetch,
  validateUrl: async () => ({ ok: true }),
}));
vi.mock("@karakeep/shared-server", () => ({
  RecommenderQueue: { enqueue: mock.enqueue },
}));
vi.mock("@karakeep/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const schema = await import("@karakeep/db/schema");
  const db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "../../packages/db/drizzle" });
  return { db };
});

import { db } from "@karakeep/db";
import {
  recArticleCache,
  recBriefings,
  recCandidates,
  recImpressions,
  users,
} from "@karakeep/db/schema";

import { extractArticlePreview, runArticlePreviews } from "./preview";

describe("article preview extraction", () => {
  it("resolves relative OG images against the fetched page and reads its language", () => {
    expect(
      extractArticlePreview(
        '<html lang="en-US"><head><meta property="og:image" content="/images/article.png"></head></html>',
        "https://example.com/posts/one",
      ),
    ).toEqual({
      imageUrl: "https://example.com/images/article.png",
      lang: "en-US",
    });
  });
  it("falls back to Twitter images and ignores untrusted executable URLs", () => {
    expect(
      extractArticlePreview(
        '<meta name="twitter:image" content="https://cdn.example.com/a.png">',
        "https://example.com",
      ).imageUrl,
    ).toBe("https://cdn.example.com/a.png");
    expect(
      extractArticlePreview(
        '<meta property="og:image" content="javascript:alert(1)">',
        "https://example.com",
      ).imageUrl,
    ).toBeNull();
    expect(
      extractArticlePreview(
        '<meta property="og:image" content="data:image/svg+xml,test">',
        "https://example.com",
      ).imageUrl,
    ).toBeNull();
    expect(
      extractArticlePreview(
        '<meta property="og:image" content="https://user:pass@example.com/a.png">',
        "https://example.com",
      ).imageUrl,
    ).toBeNull();
  });
  it("keeps articles usable when image metadata is missing or malformed", () => {
    expect(
      extractArticlePreview("<p>No image</p>", "https://example.com").imageUrl,
    ).toBeNull();
    expect(
      extractArticlePreview(
        '<meta property="og:image" content="https://[broken">',
        "https://example.com",
      ).imageUrl,
    ).toBeNull();
  });
});

describe("preview batches", () => {
  beforeEach(async () => {
    await db.delete(recImpressions);
    await db.delete(recCandidates);
    await db.delete(recBriefings);
    await db.delete(recArticleCache);
    await db.delete(users);
    await db
      .insert(users)
      .values({ id: "u", name: "Test", email: "test@example.com" });
    await db
      .insert(recBriefings)
      .values({ id: "b", userId: "u", briefingDate: "2026-11-09" });
    for (let i = 0; i < 10; i++) {
      await db.insert(recCandidates).values({
        id: `c${i}`,
        userId: "u",
        url: `https://host${i}.example.com/article`,
        canonicalUrl: `https://host${i}.example.com/article`,
        urlHash: `hash${i}`,
      });
      await db.insert(recImpressions).values({
        userId: "u",
        briefingId: "b",
        candidateId: `c${i}`,
        rank: i + 1,
        shown: true,
      });
    }
    mock.enqueue.mockClear().mockResolvedValue(undefined);
    mock.fetch.mockClear().mockResolvedValue({
      ok: true,
      headers: { get: () => "text/html" },
      url: "https://example.com/article",
      text: async () =>
        '<meta property="og:image" content="https://cdn.example.com/image.png">',
      body: { destroy: vi.fn() },
    });
  });
  it("yields after five articles and continues without fetching cached entries again", async () => {
    await runArticlePreviews("u", "b", "first");
    expect(mock.fetch).toHaveBeenCalledTimes(5);
    expect(await db.select().from(recArticleCache)).toHaveLength(5);
    expect(mock.enqueue).toHaveBeenCalledOnce();
    await runArticlePreviews("u", "b", "second");
    expect(mock.fetch).toHaveBeenCalledTimes(10);
    expect(await db.select().from(recArticleCache)).toHaveLength(10);
    await runArticlePreviews("u", "b", "finished");
    expect(mock.fetch).toHaveBeenCalledTimes(10);
  });
  it("does not fetch another user's briefing", async () => {
    await runArticlePreviews("someone-else", "b", "test");
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it("caches unavailable images so reading does not trigger repeated requests", async () => {
    mock.fetch.mockResolvedValue({ ok: false, body: { destroy: vi.fn() } });
    await runArticlePreviews("u", "b", "first");
    const cached = await db.select().from(recArticleCache);
    expect(
      cached.every((row) => row.previewFetchedAt && row.imageUrl === null),
    ).toBe(true);
  });
});
