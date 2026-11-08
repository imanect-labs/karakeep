import { beforeEach, expect, it, vi } from "vitest";
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
import { bookmarks, bookmarkLinks, users } from "@karakeep/db/schema";
import type {
  InferenceClient,
  InferenceOptions,
} from "@karakeep/shared/inference";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import type { ZTranslationRequest } from "@karakeep/shared-server";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { runTranslation } from "./translate";

const source =
  "<p>Database transactions make concurrent changes predictable.</p><pre><code>SELECT 1;</code></pre>";
const final =
  "<p>データベースのトランザクションは同時の変更を予測可能にします。</p><pre><code>SELECT 1;</code></pre>";
const job = {
  id: "test",
  data: { bookmarkId: "b", requestedByUser: true },
  priority: 0,
  runNumber: 1,
  abortSignal: new AbortController().signal,
} satisfies DequeuedJob<ZTranslationRequest>;
beforeEach(async () => {
  await db.delete(bookmarks);
  await db.delete(users);
  await db
    .insert(users)
    .values({ id: "u", name: "Test", email: "u@example.com" });
  await db
    .insert(bookmarks)
    .values({ id: "b", userId: "u", type: BookmarkTypes.LINK });
  await db.insert(bookmarkLinks).values({
    id: "b",
    url: "https://example.com",
    htmlContent: source,
    translationStatus: "pending",
  });
});
it("publishes a draft before inference resolves without committing resumable progress", async () => {
  let finish!: () => void;
  let announced!: () => void;
  const generated = new Promise<void>((r) => {
    announced = r;
  });
  const paused = new Promise<void>((r) => {
    finish = r;
  });
  const infer = vi.fn(
    async (_prompt: string, options: Partial<InferenceOptions>) => {
      await options.onChunk?.("<p>データベースを翻訳しています");
      announced();
      await paused;
      return { response: final, totalTokens: 25 };
    },
  );
  const running = runTranslation("b", job, {
    inferFromText: infer,
  } as unknown as InferenceClient);
  await generated;
  const during = (await db.select().from(bookmarkLinks))[0];
  expect(during.translationPreview).toEqual({
    text: "データベースを翻訳しています",
    sourceEnd: source.length,
  });
  expect(during.translatedContent).toBeNull();
  expect(during.translationDoneChunks).toBe(0);
  expect(during.translationSourceOffset).toBe(0);
  finish();
  await running;
  const after = (await db.select().from(bookmarkLinks))[0];
  expect(after.translationPreview).toBeNull();
  expect(after.translatedContent).toBe(final);
  expect(after.translationDoneChunks).toBe(1);
  expect(after.translationSourceOffset).toBe(source.length);
  expect(infer).toHaveBeenCalledOnce();
});
it("keeps an existing readable translation until its replacement is complete", async () => {
  await db
    .update(bookmarkLinks)
    .set({ translatedContent: "<p>既存の訳文</p>" });
  const infer = vi.fn(
    async (_prompt: string, options: Partial<InferenceOptions>) => {
      expect(options.onChunk).toBeUndefined();
      expect((await db.select().from(bookmarkLinks))[0].translatedContent).toBe(
        "<p>既存の訳文</p>",
      );
      return { response: final, totalTokens: 25 };
    },
  );
  await runTranslation("b", job, {
    inferFromText: infer,
  } as unknown as InferenceClient);
  expect((await db.select().from(bookmarkLinks))[0].translatedContent).toBe(
    final,
  );
});
