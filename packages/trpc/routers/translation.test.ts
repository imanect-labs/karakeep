import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { bookmarks, bookmarkLinks, users } from "@karakeep/db/schema";
import { InferenceClientFactory } from "@karakeep/shared/inference";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));
beforeEach<CustomTestContext>(async ({ db }) => {
  const [u] = await db.select().from(users);
  await db
    .insert(bookmarks)
    .values({ id: "body", userId: u.id, type: BookmarkTypes.LINK });
  await db.insert(bookmarkLinks).values({
    id: "body",
    url: "https://example.com",
    htmlContent: "<p>English article</p>",
  });
  const { TranslationQueue } = await import("@karakeep/shared-server");
  vi.mocked(TranslationQueue.enqueue).mockReset().mockResolvedValue(undefined);
  vi.spyOn(InferenceClientFactory, "build").mockReturnValue(
    {} as ReturnType<typeof InferenceClientFactory.build>,
  );
});
afterEach(() => vi.restoreAllMocks());

test<CustomTestContext>("explicit requests queue once and retain partial translation for resume", async ({
  db,
  apiCallers,
}) => {
  await db.update(bookmarkLinks).set({
    translationStatus: "failure",
    translatedContent: "<p>途中</p>",
    translationDoneChunks: 1,
  });
  await apiCallers[0].bookmarks.translateBookmark({ bookmarkId: "body" });
  await apiCallers[0].bookmarks.translateBookmark({ bookmarkId: "body" });
  const { TranslationQueue } = await import("@karakeep/shared-server");
  expect(TranslationQueue.enqueue).toHaveBeenCalledOnce();
  expect(TranslationQueue.enqueue).toHaveBeenCalledWith(
    { bookmarkId: "body", requestedByUser: true },
    expect.any(Object),
  );
  expect((await db.select().from(bookmarkLinks))[0]).toMatchObject({
    translationStatus: "pending",
    translationDoneChunks: 1,
    translatedContent: "<p>途中</p>",
  });
});
test<CustomTestContext>("another user cannot spend inference on an owned bookmark", async ({
  apiCallers,
}) => {
  await expect(
    apiCallers[1].bookmarks.translateBookmark({ bookmarkId: "body" }),
  ).rejects.toThrow();
  const { TranslationQueue } = await import("@karakeep/shared-server");
  expect(TranslationQueue.enqueue).not.toHaveBeenCalled();
});
test<CustomTestContext>("missing source content cannot start a job", async ({
  db,
  apiCallers,
}) => {
  await db.update(bookmarkLinks).set({ htmlContent: null });
  await expect(
    apiCallers[0].bookmarks.translateBookmark({ bookmarkId: "body" }),
  ).rejects.toThrow("本文の取得後");
});
test<CustomTestContext>("enqueue failure leaves a retryable state", async ({
  db,
  apiCallers,
}) => {
  const { TranslationQueue } = await import("@karakeep/shared-server");
  vi.mocked(TranslationQueue.enqueue).mockRejectedValue(new Error("offline"));
  await expect(
    apiCallers[0].bookmarks.translateBookmark({ bookmarkId: "body" }),
  ).rejects.toThrow("offline");
  expect((await db.select().from(bookmarkLinks))[0].translationStatus).toBe(
    "failure",
  );
});
test<CustomTestContext>("complete translations are reused without paying again", async ({
  db,
  apiCallers,
}) => {
  await db
    .update(bookmarkLinks)
    .set({ translationStatus: "success", translatedContent: "<p>日本語</p>" });
  await apiCallers[0].bookmarks.translateBookmark({ bookmarkId: "body" });
  const { TranslationQueue } = await import("@karakeep/shared-server");
  expect(TranslationQueue.enqueue).not.toHaveBeenCalled();
});
