import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ run: vi.fn(), infer: vi.fn() }));
vi.mock("./translate", () => ({ runTranslation: mock.run }));
vi.mock("@karakeep/shared/inference", () => ({
  InferenceClientFactory: { build: mock.infer },
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
import { users, bookmarks, bookmarkLinks } from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import type { ZTranslationRequest } from "@karakeep/shared-server";
import { runTranslationJob } from "./translationWorker";
const job = (requestedByUser?: boolean) =>
  ({
    id: "test",
    data: { bookmarkId: "body", requestedByUser },
    priority: 0,
    runNumber: 1,
    abortSignal: new AbortController().signal,
  }) satisfies DequeuedJob<ZTranslationRequest>;
beforeEach(async () => {
  await db.delete(bookmarks);
  await db.delete(users);
  await db
    .insert(users)
    .values({ id: "u", name: "Test", email: "test@example.com" });
  await db
    .insert(bookmarks)
    .values({ id: "body", userId: "u", type: BookmarkTypes.LINK });
  await db.insert(bookmarkLinks).values({
    id: "body",
    url: "https://example.com",
    translationStatus: "pending",
  });
  serverConfig.translation.enableAuto = false;
  mock.run.mockReset().mockResolvedValue(undefined);
  mock.infer.mockReset().mockReturnValue({});
});
it("skips old automatic jobs without inference or a success result", async () => {
  expect(await runTranslationJob(job())).toBe(false);
  expect(mock.infer).not.toHaveBeenCalled();
  expect(mock.run).not.toHaveBeenCalled();
  expect(
    (await db.select().from(bookmarkLinks))[0].translationStatus,
  ).toBeNull();
});
it("runs a user request even with automatic translation disabled", async () => {
  await db.update(bookmarkLinks).set({ translationStatus: null });
  expect(await runTranslationJob(job(true))).toBe(true);
  expect(mock.run).toHaveBeenCalledOnce();
  expect((await db.select().from(bookmarkLinks))[0].translationStatus).toBe(
    "pending",
  );
});
it("does not mark unconfigured inference as a successful translation", async () => {
  mock.infer.mockReturnValue(null);
  await expect(runTranslationJob(job(true))).rejects.toThrow("not configured");
});
