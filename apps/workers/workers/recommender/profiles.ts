import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  recCandidates,
  recClusters,
  recFeedbackEvents,
  recImpressions,
  recProfiles,
} from "@karakeep/db/schema";
import type { Profiles, ProfileSample } from "@karakeep/recommender";
import {
  buildProfiles,
  clusterPreferenceScore,
  deserializeVector,
  profileHash,
  serializeVector,
} from "@karakeep/recommender";

import { chunk, IN_CLAUSE_CHUNK } from "./shared";

/** 正例とみなすイベント（§6.2 の `P_b`）。 */
const POSITIVE_EVENTS = [
  "saved",
  "liked",
  "favourited",
  "highlighted",
  "read_full",
] as const;

/** 直近プロフィールの窓。半減期 7 日なので 60 日より前は寄与がほぼ 0。 */
const PROFILE_WINDOW_DAYS = 180;

export interface ProfileBundle {
  profiles: Profiles;
  hash: string;
  /** クラスタ id → 選好スコア。 */
  clusterPreferences: Record<string, number>;
  /** クラスタ id → 直近 7 日の提示回数。 */
  clusterRecentImpressions: Record<string, number>;
  /** 既存ブックマーク（＝ブートストラップ候補）の埋め込み。新規性の計算に使う。 */
  libraryVectors: Float32Array[];
}

/**
 * 4 種のプロフィールを組み立てて `recProfiles` に保存する。
 *
 * 正例の埋め込みは `recCandidates` から引く。ブートストラップした既存
 * ブックマークも同じテーブルに `origin='bootstrap'` で入っているので、
 * 「候補由来の正例」と「既存ブックマーク」を 1 本のクエリで扱える。
 */
export async function refreshProfiles(userId: string): Promise<ProfileBundle> {
  const now = new Date();
  const since = new Date(now.getTime() - PROFILE_WINDOW_DAYS * 86_400_000);

  const positives = await loadSamples(userId, since, "positive");
  const negatives = await loadSamples(userId, since, "negative");
  const profiles = buildProfiles(positives, negatives, now);
  const hash = profileHash(profiles);

  const clusterPreferences = await loadClusterPreferences(userId);
  const clusterRecentImpressions = await loadClusterImpressions(userId, now);
  const libraryVectors = await loadLibraryVectors(userId);

  await db
    .insert(recProfiles)
    .values({
      userId,
      stableEmbedding: profiles.stable
        ? serializeVector(profiles.stable)
        : null,
      recentEmbedding: profiles.recent
        ? serializeVector(profiles.recent)
        : null,
      negativeEmbedding: profiles.negative
        ? serializeVector(profiles.negative)
        : null,
      clusterPreferences,
      profileHash: hash,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: recProfiles.userId,
      set: {
        stableEmbedding: profiles.stable
          ? serializeVector(profiles.stable)
          : null,
        recentEmbedding: profiles.recent
          ? serializeVector(profiles.recent)
          : null,
        negativeEmbedding: profiles.negative
          ? serializeVector(profiles.negative)
          : null,
        clusterPreferences,
        profileHash: hash,
        updatedAt: now,
      },
    });

  return {
    profiles,
    hash,
    clusterPreferences,
    clusterRecentImpressions,
    libraryVectors,
  };
}

async function loadSamples(
  userId: string,
  since: Date,
  kind: "positive" | "negative",
): Promise<ProfileSample[]> {
  const rows = await db
    .select({
      embedding: recCandidates.embedding,
      occurredAt: recFeedbackEvents.occurredAt,
      eventType: recFeedbackEvents.eventType,
    })
    .from(recFeedbackEvents)
    .innerJoin(
      recImpressions,
      eq(recImpressions.id, recFeedbackEvents.impressionId),
    )
    .innerJoin(recCandidates, eq(recCandidates.id, recImpressions.candidateId))
    .where(
      and(
        eq(recFeedbackEvents.userId, userId),
        gte(recFeedbackEvents.occurredAt, since),
        isNotNull(recCandidates.embedding),
        kind === "positive"
          ? inArray(recFeedbackEvents.eventType, [...POSITIVE_EVENTS])
          : eq(recFeedbackEvents.eventType, "dismissed"),
      ),
    );

  return rows.map((row) => ({
    vector: deserializeVector(row.embedding!),
    occurredAt: row.occurredAt,
    // 保存は最も強い明示的正例（§6.1 の重み）。
    weight: row.eventType === "saved" ? 1.2 : 1,
  }));
}

/**
 * ブートストラップ候補（＝既存ブックマーク）の埋め込み。
 *
 * 新規性の特徴量（1 − 既存ブックマークとの最大コサイン）に使う。5,000 件を
 * 超えると総当たりが重くなるので、新しい順に切る。
 */
async function loadLibraryVectors(userId: string): Promise<Float32Array[]> {
  const rows = await db
    .select({ embedding: recCandidates.embedding })
    .from(recCandidates)
    .where(
      and(
        eq(recCandidates.userId, userId),
        eq(recCandidates.origin, "bootstrap"),
        isNotNull(recCandidates.embedding),
      ),
    )
    .limit(5000);
  return rows.map((row) => deserializeVector(row.embedding!));
}

async function loadClusterPreferences(
  userId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      id: recClusters.id,
      positiveCount: recClusters.positiveCount,
      negativeCount: recClusters.negativeCount,
    })
    .from(recClusters)
    .where(eq(recClusters.userId, userId));

  const preferences: Record<string, number> = {};
  for (const row of rows) {
    preferences[row.id] = clusterPreferenceScore(
      row.positiveCount,
      row.positiveCount + row.negativeCount,
    );
  }

  // 保存した値も更新しておく。UI の「興味の現在地」が同じ数字を出せるように。
  for (const batch of chunk(rows, IN_CLAUSE_CHUNK)) {
    for (const row of batch) {
      await db
        .update(recClusters)
        .set({ preferenceScore: preferences[row.id] })
        .where(eq(recClusters.id, row.id));
    }
  }
  return preferences;
}

async function loadClusterImpressions(
  userId: string,
  now: Date,
): Promise<Record<string, number>> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db
    .select({
      clusterId: recCandidates.clusterId,
      count: sql<number>`count(*)`,
    })
    .from(recImpressions)
    .innerJoin(recCandidates, eq(recCandidates.id, recImpressions.candidateId))
    .where(
      and(
        eq(recImpressions.userId, userId),
        eq(recImpressions.shown, true),
        gte(recImpressions.createdAt, since),
        isNotNull(recCandidates.clusterId),
      ),
    )
    .groupBy(recCandidates.clusterId);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.clusterId) {
      counts[row.clusterId] = row.count;
    }
  }
  return counts;
}
