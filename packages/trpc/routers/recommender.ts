import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import {
  recBriefings,
  recCandidates,
  recClusters,
  recDomainDiscoveries,
  recDomains,
  recFeedbackEvents,
  recImpressions,
  recSources,
} from "@karakeep/db/schema";
import { SEED_SOURCES } from "@karakeep/recommender";
import { RecommenderQueue } from "@karakeep/shared-server";

import type { AuthedContext } from "../index";
import { createScopedAuthedProcedure, router } from "../index";

const recommenderProcedure = createScopedAuthedProcedure("recommender");

// UI から直接送れるイベント。`read_abandoned` は派生イベントで
// `runRewardJoin` だけが書くので、ここには入れない。
const zEventType = z.enum([
  "viewed",
  "clicked",
  "saved",
  "liked",
  "dismissed",
  "read_intent",
]);

const zDismissReason = z.enum([
  "off_topic",
  "already_read",
  "weak_source",
  "shallow",
]);

const zBriefingItem = z.object({
  impressionId: z.string(),
  candidateId: z.string(),
  rank: z.number().nullable(),
  arm: z.string().nullable(),
  url: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  // 日本語ダイジェスト（FR-U-13）。生成前・失敗時は null で、UI は原題に落ちる。
  titleJa: z.string().nullable(),
  summaryJa: z.string().nullable(),
  domain: z.string().nullable(),
  domainStatus: z.string().nullable(),
  isTrialDomain: z.boolean(),
  publishedAt: z.date().nullable(),
  score: z.number().nullable(),
  reason: z.string(),
  clusterLabel: z.string().nullable(),
  bookmarkId: z.string().nullable(),
  events: z.array(z.string()),
});

const zBriefing = z.object({
  id: z.string().nullable(),
  briefingDate: z.string(),
  status: z.string(),
  modelVersion: z.string().nullable(),
  observationState: z.string(),
  itemCount: z.number(),
  items: z.array(zBriefingItem),
});

/**
 * Briefing ページ用の tRPC ルータ（imanect-labs fork）。
 *
 * 学習に使う値（`examined`、観測状態、propensity）はここで確定する。
 * **後から復元できない**ので、UI 側の都合で省略しないこと。
 */
export const recommenderAppRouter = router({
  getBriefing: recommenderProcedure
    .input(z.object({ date: z.string().optional() }))
    .output(zBriefing)
    .query(async ({ input, ctx }) => {
      const briefing = input.date
        ? await ctx.db.query.recBriefings.findFirst({
            where: and(
              eq(recBriefings.userId, ctx.user.id),
              eq(recBriefings.briefingDate, input.date),
            ),
          })
        : await ctx.db.query.recBriefings.findFirst({
            where: eq(recBriefings.userId, ctx.user.id),
            orderBy: desc(recBriefings.briefingDate),
          });

      if (!briefing) {
        // ワーカーがまだ走っていない、または候補が 1 件も無い（NFR-09）。
        return {
          id: null,
          briefingDate: input.date ?? "",
          status: "missing",
          modelVersion: null,
          observationState: "unobserved",
          itemCount: 0,
          items: [],
        };
      }

      const rows = await ctx.db
        .select({
          impressionId: recImpressions.id,
          candidateId: recCandidates.id,
          rank: recImpressions.rank,
          arm: recImpressions.arm,
          score: recImpressions.score,
          features: recImpressions.features,
          url: recCandidates.url,
          title: recCandidates.title,
          summary: recCandidates.summary,
          titleJa: recCandidates.titleJa,
          summaryJa: recCandidates.summaryJa,
          publishedAt: recCandidates.publishedAt,
          bookmarkId: recCandidates.bookmarkId,
          domain: recDomains.domain,
          domainStatus: recImpressions.domainStatusAtImpression,
          clusterLabel: recClusters.label,
        })
        .from(recImpressions)
        .innerJoin(
          recCandidates,
          eq(recCandidates.id, recImpressions.candidateId),
        )
        .leftJoin(recDomains, eq(recDomains.id, recImpressions.domainId))
        .leftJoin(recClusters, eq(recClusters.id, recCandidates.clusterId))
        .where(
          and(
            eq(recImpressions.briefingId, briefing.id),
            eq(recImpressions.shown, true),
          ),
        )
        .orderBy(recImpressions.rank);

      const events = new Map<string, string[]>();
      if (rows.length > 0) {
        const eventRows = await ctx.db
          .select({
            impressionId: recFeedbackEvents.impressionId,
            eventType: recFeedbackEvents.eventType,
          })
          .from(recFeedbackEvents)
          .where(
            inArray(
              recFeedbackEvents.impressionId,
              rows.map((r) => r.impressionId),
            ),
          );
        for (const row of eventRows) {
          const list = events.get(row.impressionId);
          if (list) {
            list.push(row.eventType);
          } else {
            events.set(row.impressionId, [row.eventType]);
          }
        }
      }

      return {
        id: briefing.id,
        briefingDate: briefing.briefingDate,
        status: briefing.status,
        modelVersion: briefing.modelVersion,
        observationState: briefing.observationState,
        itemCount: briefing.itemCount,
        items: rows.map((row) => ({
          impressionId: row.impressionId,
          candidateId: row.candidateId,
          rank: row.rank,
          arm: row.arm,
          url: row.url,
          title: row.title,
          summary: row.summary,
          titleJa: row.titleJa,
          summaryJa: row.summaryJa,
          domain: row.domain,
          domainStatus: row.domainStatus,
          isTrialDomain: row.domainStatus === "trial",
          publishedAt: row.publishedAt,
          score: row.score,
          reason: explainFeatures(row.features),
          clusterLabel: row.clusterLabel,
          bookmarkId: row.bookmarkId,
          events: events.get(row.impressionId) ?? [],
        })),
      };
    }),

  /**
   * 推薦を有効にしているか（FR-U-15）。
   *
   * 判定は `recommenderUserIds()`（`apps/workers/.../shared.ts`）と**同じ
   * 述語**にする。ずれると UI が「登録済み」と言っているのに cron が
   * そのユーザーを列挙しない、という無症状の状態が生まれる。
   */
  getEnrollment: recommenderProcedure
    .output(
      z.object({
        enrolled: z.boolean(),
        sourceCount: z.number(),
        /** 一度でも Briefing が生成されたか。準備中の表示を出すかの判断。 */
        hasEverHadBriefing: z.boolean(),
      }),
    )
    .query(async ({ ctx }) => {
      const [sources] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(recSources)
        .where(eq(recSources.userId, ctx.user.id));
      const [briefings] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(recBriefings)
        .where(eq(recBriefings.userId, ctx.user.id));
      const sourceCount = sources?.count ?? 0;
      return {
        enrolled: sourceCount > 0,
        sourceCount,
        hasEverHadBriefing: (briefings?.count ?? 0) > 0,
      };
    }),

  /**
   * 推薦を自分で有効にする（FR-U-15）。
   *
   * 共通のシード収集元を登録し、初回パイプラインを 1 ジョブで投入する。
   * 冪等 ── 既に収集元を持っているユーザーには何もしない。
   */
  enroll: recommenderProcedure
    .output(
      z.object({
        /** false は「既に登録済みで何もしなかった」。エラーではない。 */
        enrolled: z.boolean(),
        sourcesCreated: z.number(),
      }),
    )
    .mutation(async ({ ctx }) => {
      const existing = await ctx.db
        .select({ name: recSources.name })
        .from(recSources)
        .where(eq(recSources.userId, ctx.user.id));
      if (existing.length > 0) {
        return { enrolled: false, sourcesCreated: 0 };
      }

      // 同期的に入れる。150 行あまりの insert は数ミリ秒で、ここでやると次の
      // refetch で UI がボタン → 準備中へ一度で切り替わる。ワーカーに
      // 回すと、その間ボタンが押せる状態のまま残る。
      //
      // ここは**初回だけ**。一覧が増えたぶんを既存ユーザーへ配るのは
      // `runMaintain` の `syncSeedSources`（この mutation は上で早期 return
      // するので届かない）。
      await ctx.db.insert(recSources).values(
        SEED_SOURCES.map((source) => ({
          userId: ctx.user.id,
          // domainId は付けない。供給層は全員共通で、議席にも試用枠にも
          // 載せない（FR-C-08）。
          name: source.name,
          kind: source.kind,
          config: source.config as Record<string, unknown>,
          profileIndependent: source.profileIndependent ?? false,
        })),
      );

      await RecommenderQueue.enqueue(
        { type: "enroll", userId: ctx.user.id },
        {
          groupId: ctx.user.id,
          // 日付を含めない。走っている間の二度押しを握り潰す。
          idempotencyKey: `rec:enroll:${ctx.user.id}`,
        },
      );

      return { enrolled: true, sourcesCreated: SEED_SOURCES.length };
    }),

  /** 過去の Briefing を日付で遡る（FR-U-07）。 */
  listBriefingDates: recommenderProcedure
    .input(z.object({ limit: z.number().min(1).max(120).default(30) }))
    .output(
      z.array(
        z.object({
          briefingDate: z.string(),
          itemCount: z.number(),
          observationState: z.string(),
        }),
      ),
    )
    .query(async ({ input, ctx }) => {
      return await ctx.db
        .select({
          briefingDate: recBriefings.briefingDate,
          itemCount: recBriefings.itemCount,
          observationState: recBriefings.observationState,
        })
        .from(recBriefings)
        .where(eq(recBriefings.userId, ctx.user.id))
        .orderBy(desc(recBriefings.briefingDate))
        .limit(input.limit);
    }),

  /**
   * Briefing を開いた（FR-U-11）。観測状態の判定の起点になる。
   * これが無い Briefing は `unobserved` のまま学習から外れる。
   */
  markOpened: recommenderProcedure
    .input(z.object({ briefingId: z.string() }))
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(recBriefings)
        .set({
          openedAt: sql`coalesce(${recBriefings.openedAt}, unixepoch())`,
          // 開いた時点では partial。最下部まで到達したら observed に上がる。
          observationState: sql`case when ${recBriefings.observationState} = 'unobserved' then 'partial' else ${recBriefings.observationState} end`,
        })
        .where(
          and(
            eq(recBriefings.id, input.briefingId),
            eq(recBriefings.userId, ctx.user.id),
          ),
        );
    }),

  /**
   * カードが画面に入った（FR-U-08）。
   *
   * `examined` はここでは立てない。**より下位のカードが見られていれば
   * 通過証明で `examined` になる**ので、日次ジョブがまとめて確定させる
   * （FR-F-06）。ここでやるのは `viewed` イベントの記録と、最深到達順位の
   * 更新だけ。
   */
  markViewed: recommenderProcedure
    .input(
      z.object({
        briefingId: z.string(),
        impressionIds: z.array(z.string()).min(1).max(100),
      }),
    )
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      const impressions = await ctx.db
        .select({ id: recImpressions.id, rank: recImpressions.rank })
        .from(recImpressions)
        .where(
          and(
            eq(recImpressions.userId, ctx.user.id),
            eq(recImpressions.briefingId, input.briefingId),
            inArray(recImpressions.id, input.impressionIds),
          ),
        );
      if (impressions.length === 0) {
        return;
      }

      await ctx.db
        .insert(recFeedbackEvents)
        .values(
          impressions.map((impression) => ({
            impressionId: impression.id,
            userId: ctx.user.id,
            eventType: "viewed" as const,
          })),
        )
        .onConflictDoNothing();

      const deepest = Math.max(...impressions.map((i) => i.rank ?? 0));
      await ctx.db
        .update(recBriefings)
        .set({
          deepestViewedRank: sql`max(coalesce(${recBriefings.deepestViewedRank}, 0), ${deepest})`,
          observationState: sql`case
            when ${deepest} >= ${recBriefings.itemCount} then 'observed'
            when ${recBriefings.observationState} = 'unobserved' then 'partial'
            else ${recBriefings.observationState} end`,
        })
        .where(
          and(
            eq(recBriefings.id, input.briefingId),
            eq(recBriefings.userId, ctx.user.id),
          ),
        );
    }),

  /**
   * 即時イベントの記録（FR-F-01）。イベントは削除せず、取り消しも新しい
   * イベントとして追記する。
   */
  recordEvent: recommenderProcedure
    .input(
      z.object({
        impressionId: z.string(),
        eventType: zEventType,
        reason: zDismissReason.optional(),
        /** 「保存」で作られたブックマーク。impression に紐づける（FR-U-04）。 */
        bookmarkId: z.string().optional(),
      }),
    )
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      const impression = await ctx.db.query.recImpressions.findFirst({
        where: and(
          eq(recImpressions.id, input.impressionId),
          eq(recImpressions.userId, ctx.user.id),
        ),
      });
      if (!impression) {
        return;
      }

      await ctx.db
        .insert(recFeedbackEvents)
        .values({
          impressionId: input.impressionId,
          userId: ctx.user.id,
          eventType: input.eventType,
          reason: input.reason,
        })
        .onConflictDoNothing();

      if (input.bookmarkId) {
        await ctx.db
          .update(recCandidates)
          .set({ bookmarkId: input.bookmarkId, status: "promoted" })
          .where(eq(recCandidates.id, impression.candidateId));
      }
    }),

  /** 「今日の新しい発見」ブロック（FR-U-10）。 */
  listDiscoveries: recommenderProcedure
    .input(z.object({ limit: z.number().min(1).max(20).default(5) }))
    .output(
      z.array(
        z.object({
          domainId: z.string(),
          domain: z.string(),
          status: z.string(),
          channel: z.string(),
          evidence: z.string().nullable(),
        }),
      ),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select({
          domainId: recDomains.id,
          domain: recDomains.domain,
          status: recDomains.status,
          channel: recDomainDiscoveries.channel,
          evidence: recDomainDiscoveries.evidenceLabel,
          weight: recDomainDiscoveries.weight,
        })
        .from(recDomains)
        .innerJoin(
          recDomainDiscoveries,
          eq(recDomainDiscoveries.domainId, recDomains.id),
        )
        .where(
          and(
            eq(recDomains.userId, ctx.user.id),
            inArray(recDomains.status, ["discovered", "screened", "trial"]),
          ),
        )
        .orderBy(desc(recDomainDiscoveries.weight))
        .limit(input.limit * 4);

      // 同じドメインが複数チャネルから見つかっていることがある。代表 1 件に絞る。
      const seen = new Set<string>();
      const unique = [];
      for (const row of rows) {
        if (seen.has(row.domainId)) {
          continue;
        }
        seen.add(row.domainId);
        unique.push(row);
        if (unique.length >= input.limit) {
          break;
        }
      }
      return unique;
    }),

  /**
   * ドメインの手動判断（FR-D-17 / FR-U-10）。
   * 人間の一発判断はどんなモデルより安く正確なので、試用判定を待たずに
   * ショートカットできる。
   */
  decideDomain: recommenderProcedure
    .input(
      z.object({
        domainId: z.string(),
        decision: z.enum(["subscribe", "reject"]),
      }),
    )
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(recDomains)
        .set({
          manualDecision: input.decision,
          // 却下は即時に反映する。購読は discoverWorker が席の状況を見て
          // 決めるので、ここでは意思表示だけ残す。
          ...(input.decision === "reject"
            ? { status: "rejected" as const, blockedReason: "manual" }
            : {}),
        })
        .where(
          and(
            eq(recDomains.id, input.domainId),
            eq(recDomains.userId, ctx.user.id),
          ),
        );
    }),

  /** 「興味の現在地」パネル（FR-U-06）。 */
  getInterestState: recommenderProcedure
    .output(
      z.object({
        topClusters: z.array(
          z.object({
            id: z.string(),
            label: z.string().nullable(),
            score: z.number(),
            size: z.number(),
          }),
        ),
        negativeClusters: z.array(
          z.object({
            id: z.string(),
            label: z.string().nullable(),
            score: z.number(),
          }),
        ),
        trialDomains: z.array(z.object({ domain: z.string() })),
        recentlyPromoted: z.array(z.object({ domain: z.string() })),
        observationRate: z.number(),
        candidatePoolSize: z.number(),
      }),
    )
    .query(async ({ ctx }) => {
      const clusters = await ctx.db
        .select({
          id: recClusters.id,
          label: recClusters.label,
          score: recClusters.preferenceScore,
          size: recClusters.size,
        })
        .from(recClusters)
        .where(
          and(
            eq(recClusters.userId, ctx.user.id),
            sql`${recClusters.size} > 0`,
          ),
        )
        .orderBy(desc(recClusters.preferenceScore));

      const [trialDomains, recentlyPromoted] = await Promise.all([
        ctx.db
          .select({ domain: recDomains.domain })
          .from(recDomains)
          .where(
            and(
              eq(recDomains.userId, ctx.user.id),
              eq(recDomains.status, "trial"),
            ),
          ),
        ctx.db
          .select({ domain: recDomains.domain })
          .from(recDomains)
          .where(
            and(
              eq(recDomains.userId, ctx.user.id),
              eq(recDomains.status, "subscribed"),
              isNotNull(recDomains.promotedAt),
              gte(
                recDomains.promotedAt,
                new Date(Date.now() - 30 * 86_400_000),
              ),
            ),
          )
          .orderBy(desc(recDomains.promotedAt))
          .limit(5),
      ]);

      return {
        topClusters: clusters.slice(0, 5),
        negativeClusters: clusters
          .filter((c) => c.score < 0.1)
          .slice(-3)
          .map(({ id, label, score }) => ({ id, label, score })),
        trialDomains,
        recentlyPromoted,
        observationRate: await observationRate(ctx.db, ctx.user.id),
        candidatePoolSize: await candidatePoolSize(ctx.db, ctx.user.id),
      };
    }),
});

/**
 * Briefing 観測率。**すべての完了条件と中止基準の基準値**なので、
 * UI にも常時出す。
 */
type RecommenderDb = AuthedContext["db"];

async function observationRate(
  db: RecommenderDb,
  userId: string,
): Promise<number> {
  const since = new Date(Date.now() - 28 * 86_400_000);
  const rows = await db
    .select({
      total: sql<number>`count(*)`,
      observed: sql<number>`sum(case when ${recBriefings.observationState} != 'unobserved' then 1 else 0 end)`,
    })
    .from(recBriefings)
    .where(
      and(
        eq(recBriefings.userId, userId),
        gte(recBriefings.createdAt, since),
        eq(recBriefings.status, "ready"),
        // 当日の Briefing はまだ見られていなくて当然なので除く。
        lt(recBriefings.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  const total = rows[0]?.total ?? 0;
  return total === 0 ? 1 : (rows[0]?.observed ?? 0) / total;
}

async function candidatePoolSize(
  db: RecommenderDb,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(recCandidates)
    .where(
      and(
        eq(recCandidates.userId, userId),
        eq(recCandidates.status, "active"),
        eq(recCandidates.origin, "collected"),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * 特徴量スナップショットから選定理由の自然文を作る（FR-U-02）。
 *
 * `packages/recommender` の `explainScore` と同じ語彙にしてある。
 * ワーカー側の実装を import すると web バンドルにワーカー依存が入るので、
 * 表示に必要な部分だけをここに持つ。
 */
function explainFeatures(features: Record<string, number> | null): string {
  if (!features) {
    return "候補プールから選ばれた";
  }
  const labels: Record<string, [string, string]> = {
    stable: ["これまで反応した記事群と意味的に近い", "これまでの関心から遠い"],
    recent: ["直近よく読んでいるテーマに近い", "直近の関心からは外れている"],
    negative: ["", "「興味なし」にした記事に似ている"],
    clusterPreference: [
      "反応の良いトピックに属している",
      "反応の薄いトピックに属している",
    ],
    freshness: ["公開されたばかり", "公開からしばらく経っている"],
    repetition: ["", "同じテーマの提示が続いているため減点"],
    domain: ["よく読んでいる情報源", "まだ実績の少ない情報源"],
    novelty: ["手持ちのブックマークにない切り口", "既に持っている記事と近い"],
  };

  const phrases = Object.entries(features)
    .filter(([key]) => key in labels)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 2)
    .map(([key, value]) => labels[key][value >= 0 ? 0 : 1])
    .filter((phrase) => phrase !== "");

  return phrases.length > 0 ? phrases.join("。") : "候補プールから選ばれた";
}
