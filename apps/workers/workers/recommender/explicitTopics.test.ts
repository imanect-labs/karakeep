import { beforeEach, expect, test, vi } from "vitest";
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
import { recProfiles, users, recFeedbackEvents } from "@karakeep/db/schema";
import { EmbeddingClientFactory } from "@karakeep/shared/embedding";
import { refreshProfiles } from "./profiles";

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete(users);
  await db
    .insert(users)
    .values({ id: "u", name: "Test", email: "u@example.com" });
});
test("loads user topics without creating positive feedback and retains them during daily refresh", async () => {
  await db.insert(recProfiles).values({
    userId: "u",
    explicitTopics: ["Infrastructure", "Low-level systems"],
  });
  const generate = vi
    .fn()
    .mockResolvedValue({ embeddings: [Array(32).fill(1), Array(32).fill(2)] });
  vi.spyOn(EmbeddingClientFactory, "build").mockReturnValue({
    modelId: "test",
    generateEmbeddingFromText: generate,
  });
  const bundle = await refreshProfiles("u");
  expect(bundle.explicitTopicVectors).toHaveLength(2);
  expect(bundle.explicitTopicModelId).toBe("test");
  expect(bundle.profiles.stable).toBeNull();
  expect(generate).toHaveBeenCalledOnce();
  expect((await db.select().from(recProfiles))[0].explicitTopics).toEqual([
    "Infrastructure",
    "Low-level systems",
  ]);
  expect(await db.select().from(recFeedbackEvents)).toHaveLength(0);
});
test("keeps normal ranking available when topic embeddings fail", async () => {
  await db
    .insert(recProfiles)
    .values({ userId: "u", explicitTopics: ["Infrastructure"] });
  vi.spyOn(EmbeddingClientFactory, "build").mockReturnValue({
    modelId: "test",
    generateEmbeddingFromText: vi.fn().mockRejectedValue(new Error("offline")),
  });
  expect((await refreshProfiles("u")).explicitTopicVectors).toEqual([]);
});
test("does not call the embedding provider for users without topic preferences", async () => {
  const build = vi.spyOn(EmbeddingClientFactory, "build");
  expect((await refreshProfiles("u")).explicitTopicVectors).toEqual([]);
  expect(build).not.toHaveBeenCalled();
});
