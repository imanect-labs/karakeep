import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ infer: vi.fn() }));
vi.mock("@karakeep/shared/inference", () => ({
  InferenceClientFactory: { build: () => ({ inferFromText: mock.infer }) },
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
  bookmarks,
  recCandidates,
  recFeedbackEvents,
  users,
} from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { runArticleTranslation } from "./translate";

describe("requested Briefing translation", () => {
  beforeEach(async () => {
    await db.delete(recCandidates);
    await db.delete(bookmarks);
    await db.delete(users);
    await db
      .insert(users)
      .values({ id: "u", name: "Test", email: "test@example.com" });
    await db
      .insert(bookmarks)
      .values({ id: "b", userId: "u", type: BookmarkTypes.LINK });
    await db.insert(recCandidates).values({
      id: "c",
      userId: "u",
      bookmarkId: "b",
      url: "https://example.com/article",
      canonicalUrl: "https://example.com/article",
      urlHash: "hash",
      title: "Concurrency control",
      digestStatus: "pending",
    });
    mock.infer.mockReset().mockResolvedValue({
      response:
        '{"titleJa":"並行性の制御","summaryJa":"トランザクションの解説です。"}',
    });
  });
  it("stores translated titles for the card and reader without adding a positive event", async () => {
    await runArticleTranslation("u", "c", "test");
    expect((await db.select().from(recCandidates))[0]).toMatchObject({
      title: "Concurrency control",
      titleJa: "並行性の制御",
      digestStatus: "success",
    });
    expect((await db.select().from(bookmarks))[0].title).toBe("並行性の制御");
    expect(await db.select().from(recFeedbackEvents)).toHaveLength(0);
    await runArticleTranslation("u", "c", "test-again");
    expect(mock.infer).toHaveBeenCalledOnce();
  });
  it("does not translate another user's article", async () => {
    await runArticleTranslation("other-user", "c", "test");
    expect(mock.infer).not.toHaveBeenCalled();
  });
  it("marks malformed output as retryable failure rather than leaving it pending", async () => {
    mock.infer.mockResolvedValue({ response: "not JSON" });
    await expect(runArticleTranslation("u", "c", "test")).rejects.toThrow();
    expect((await db.select().from(recCandidates))[0].digestStatus).toBe(
      "failure",
    );
    expect((await db.select().from(bookmarks))[0].title).toBeNull();
  });
});
