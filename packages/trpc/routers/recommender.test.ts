import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { recSources } from "@karakeep/db/schema";
import { SEED_SOURCES } from "@karakeep/recommender";

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
  (await enqueueSpy()).mockClear();
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
