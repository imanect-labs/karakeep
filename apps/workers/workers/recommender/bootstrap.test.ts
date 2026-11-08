import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@karakeep/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const schema = await import("@karakeep/db/schema");
  const db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "../../packages/db/drizzle" });
  return { db };
});
vi.mock("@karakeep/shared-server", () => ({
  RecommenderEmbedQueue: { enqueue: vi.fn() },
}));

import { db } from "@karakeep/db";
import {
  bookmarkLinks,
  bookmarks,
  recCandidates,
  recFeedbackEvents,
  recImpressions,
  users,
} from "@karakeep/db/schema";
import { normalizeUrl } from "@karakeep/recommender";

import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { runBootstrap } from "./bootstrap";
import { runMaintain } from "./maintain";

describe("library bootstrap synchronization", () => {
  beforeEach(async () => {
    await db.delete(recFeedbackEvents);
    await db.delete(recImpressions);
    await db.delete(recCandidates);
    await db.delete(bookmarkLinks);
    await db.delete(bookmarks);
    await db.delete(users);
    await db
      .insert(users)
      .values({ id: "u", name: "Test", email: "test@example.com" });
  });

  async function savedArticle(id: string) {
    const url = `https://example.com/${id}`;
    await db.insert(bookmarks).values({
      id,
      userId: "u",
      type: BookmarkTypes.LINK,
      createdAt: new Date("2026-11-07"),
    });
    await db.insert(bookmarkLinks).values({ id, url, title: id });
    return normalizeUrl(url)!;
  }

  it("imports later saves once using their original saved time", async () => {
    await savedArticle("new");
    await runMaintain("u", "test");
    await runMaintain("u", "test-again");
    const events = await db.select().from(recFeedbackEvents);
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt).toEqual(new Date("2026-11-07"));
    expect(events[0].eventType).toBe("saved");
  });

  it("recovers a manual save that collides with a previously shown candidate", async () => {
    const url = await savedArticle("existing");
    await db.insert(recCandidates).values({
      id: "c",
      userId: "u",
      origin: "collected",
      url: url.canonicalUrl,
      canonicalUrl: url.canonicalUrl,
      urlHash: url.urlHash,
    });
    await db
      .insert(recImpressions)
      .values({ id: "old", userId: "u", candidateId: "c", shown: true });
    await runBootstrap("u", undefined, "test");
    await runBootstrap("u", undefined, "test-again");
    expect(await db.select().from(recCandidates)).toHaveLength(1);
    const candidate = (await db.select().from(recCandidates))[0];
    expect(candidate).toMatchObject({
      bookmarkId: "existing",
      status: "promoted",
      origin: "bootstrap",
    });
    expect(await db.select().from(recFeedbackEvents)).toHaveLength(1);
    const impressions = await db.select().from(recImpressions);
    expect(impressions.filter((i) => i.source === "bootstrap")).toHaveLength(1);
  });

  it("does not turn a read-intent bookmark into a saved positive", async () => {
    const url = await savedArticle("intent");
    await db.insert(recCandidates).values({
      id: "c",
      userId: "u",
      origin: "collected",
      bookmarkId: "intent",
      url: url.canonicalUrl,
      canonicalUrl: url.canonicalUrl,
      urlHash: url.urlHash,
    });
    await db
      .insert(recImpressions)
      .values({ id: "i", userId: "u", candidateId: "c", source: "briefing" });
    await db
      .insert(recFeedbackEvents)
      .values({ impressionId: "i", userId: "u", eventType: "read_intent" });
    await runBootstrap("u", undefined, "test");
    expect(
      await db
        .select()
        .from(recFeedbackEvents)
        .where(eq(recFeedbackEvents.eventType, "saved")),
    ).toHaveLength(0);
  });
});
