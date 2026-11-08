import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  recSources,
  recCandidates,
  recBriefings,
  recImpressions,
  recArticleCache,
  recFeedbackEvents,
  users,
  bookmarks,
} from "@karakeep/db/schema";
import { SEED_SOURCES } from "@karakeep/recommender";
import { InferenceClientFactory } from "@karakeep/shared/inference";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

/**
 * `vi.mock` は `defaultBeforeEach` の中で登録されるので、この**ファイルの
 * 静的 import は素のモジュールを掴む**（巻き上げの対象外）。モックされた
 * 側を見るには動的 import で取り直す必要がある。
 */
async function enqueueSpy() {
  const { RecommenderQueue } = await import("@karakeep/shared-server");
  return vi.mocked(RecommenderQueue.enqueue);
}

// 呼び出し回数はモジュール単位で溜まる。テスト間で持ち越さない。
beforeEach(async () => {
  (await enqueueSpy()).mockClear().mockResolvedValue(undefined);
});

describe("Briefing previews and translation", () => {
  async function candidate(db: CustomTestContext["db"]) {
    const [owner] = await db.select().from(users);
    await db.insert(recCandidates).values({
      id: "candidate",
      userId: owner.id,
      url: "https://example.com/article",
      canonicalUrl: "https://example.com/article",
      urlHash: "hash",
      title: "PostgreSQL concurrency control",
      lang: "en",
    });
    return owner;
  }

  test<CustomTestContext>("returns cached OGP images without recreating impressions", async ({
    db,
    apiCallers,
  }) => {
    const owner = await candidate(db);
    await db.insert(recBriefings).values({
      id: "briefing",
      userId: owner.id,
      briefingDate: "2026-11-09",
      status: "ready",
    });
    await db.insert(recImpressions).values({
      id: "impression",
      userId: owner.id,
      briefingId: "briefing",
      candidateId: "candidate",
      rank: 1,
      shown: true,
    });
    await db.insert(recArticleCache).values({
      urlHash: "hash",
      canonicalUrl: "https://example.com/article",
      imageUrl: "https://example.com/og.png",
      previewFetchedAt: new Date(),
    });
    const briefing = await apiCallers[0].recommender.getBriefing({});
    expect(briefing.items[0]).toMatchObject({
      impressionId: "impression",
      imageUrl: "https://example.com/og.png",
      previewPending: false,
      lang: "en",
    });
    expect(await db.select().from(recImpressions)).toHaveLength(1);
  });

  test<CustomTestContext>("queues requested title translation once without creating positive feedback", async ({
    db,
    apiCallers,
  }) => {
    await candidate(db);
    const client = vi
      .spyOn(InferenceClientFactory, "build")
      .mockReturnValue({} as ReturnType<typeof InferenceClientFactory.build>);
    try {
      await apiCallers[0].recommender.translateArticle({
        candidateId: "candidate",
      });
      await apiCallers[0].recommender.translateArticle({
        candidateId: "candidate",
      });
      expect(await enqueueSpy()).toHaveBeenCalledTimes(1);
      expect(await enqueueSpy()).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "translate",
          candidateId: "candidate",
        }),
        expect.any(Object),
      );
      expect(await db.select().from(recFeedbackEvents)).toHaveLength(0);
    } finally {
      client.mockRestore();
    }
  });

  test<CustomTestContext>("rejects translation and bookmark associations belonging to other users", async ({
    db,
    apiCallers,
  }) => {
    const owner = await candidate(db);
    await expect(
      apiCallers[1].recommender.translateArticle({ candidateId: "candidate" }),
    ).rejects.toThrow();
    const [, other] = await db.select().from(users);
    await db.insert(bookmarks).values({
      id: "other-bookmark",
      userId: other.id,
      type: BookmarkTypes.LINK,
    });
    await db
      .insert(recImpressions)
      .values({ id: "impression", userId: owner.id, candidateId: "candidate" });
    await expect(
      apiCallers[0].recommender.recordEvent({
        impressionId: "impression",
        eventType: "read_intent",
        bookmarkId: "other-bookmark",
      }),
    ).rejects.toThrow();
    expect(await db.select().from(recFeedbackEvents)).toHaveLength(0);
  });

  test<CustomTestContext>("allows retrying a stale pending request", async ({
    db,
    apiCallers,
  }) => {
    await candidate(db);
    await db
      .update(recCandidates)
      .set({ digestStatus: "pending", translationRequestedAt: new Date(0) });
    const client = vi
      .spyOn(InferenceClientFactory, "build")
      .mockReturnValue({} as ReturnType<typeof InferenceClientFactory.build>);
    try {
      await apiCallers[0].recommender.translateArticle({
        candidateId: "candidate",
      });
      expect(await enqueueSpy()).toHaveBeenCalledOnce();
    } finally {
      client.mockRestore();
    }
  });

  test<CustomTestContext>("reuses cached titles in the reader while preserving user-edited titles", async ({
    db,
    apiCallers,
  }) => {
    const owner = await candidate(db);
    await db
      .insert(bookmarks)
      .values({ id: "b", userId: owner.id, type: BookmarkTypes.LINK });
    await db
      .update(recCandidates)
      .set({ bookmarkId: "b", titleJa: "並行性の制御" });
    await apiCallers[0].recommender.translateArticle({
      candidateId: "candidate",
    });
    expect((await db.select().from(bookmarks))[0].title).toBe("並行性の制御");
    await db.update(bookmarks).set({ title: "自分で付けたタイトル" });
    await apiCallers[0].recommender.translateArticle({
      candidateId: "candidate",
    });
    expect((await db.select().from(bookmarks))[0].title).toBe(
      "自分で付けたタイトル",
    );
    expect(await enqueueSpy()).not.toHaveBeenCalled();
  });
});

describe("recommender enrollment", () => {
  test<CustomTestContext>("registers the seed sources and queues the first run", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].recommender;

    expect(await api.getEnrollment()).toMatchObject({
      enrolled: false,
      sourceCount: 0,
      hasEverHadBriefing: false,
    });

    const result = await api.enroll();
    expect(result.enrolled).toBe(true);
    expect(result.sourcesCreated).toBe(SEED_SOURCES.length);

    const rows = await db.select().from(recSources);
    expect(rows).toHaveLength(SEED_SOURCES.length);
    // 供給層は議席にも試用枠にも載せない (FR-C-08)。domainId が付くと
    // ドメインのライフサイクルに載って、人ごとに収集元が削られてしまう。
    expect(rows.every((r) => r.domainId === null)).toBe(true);
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(rows.some((r) => r.profileIndependent)).toBe(true);

    const enqueue = await enqueueSpy();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      { type: "enroll", userId: expect.any(String) },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );

    expect(await api.getEnrollment()).toMatchObject({
      enrolled: true,
      sourceCount: SEED_SOURCES.length,
      hasEverHadBriefing: false,
    });
  });

  test<CustomTestContext>("is idempotent on a second press", async ({
    apiCallers,
    db,
  }) => {
    // ボタンの二度押しと、UI が「未登録」を掴んだまま古くなっていた場合。
    const api = apiCallers[0].recommender;
    await api.enroll();

    const second = await api.enroll();
    expect(second).toEqual({ enrolled: false, sourcesCreated: 0 });

    const rows = await db.select().from(recSources);
    expect(rows).toHaveLength(SEED_SOURCES.length);
    expect(await enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  test<CustomTestContext>("does not touch another user's sources", async ({
    apiCallers,
    db,
  }) => {
    await apiCallers[0].recommender.enroll();

    expect(await apiCallers[1].recommender.getEnrollment()).toMatchObject({
      enrolled: false,
      sourceCount: 0,
    });

    const [{ userId }] = await db
      .select({ userId: recSources.userId })
      .from(recSources)
      .limit(1);
    const otherUsers = await db
      .select()
      .from(recSources)
      .where(eq(recSources.userId, userId));
    expect(otherUsers).toHaveLength(SEED_SOURCES.length);

    // 2 人目も登録できて、双方が自分の分だけ持つ。
    await apiCallers[1].recommender.enroll();
    expect(await db.select().from(recSources)).toHaveLength(
      SEED_SOURCES.length * 2,
    );
  });
});
