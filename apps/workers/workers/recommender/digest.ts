import { Readability } from "@mozilla/readability";
import { and, eq } from "drizzle-orm";
import { JSDOM, VirtualConsole } from "jsdom";

import { db } from "@karakeep/db";
import { recCandidates, recImpressions } from "@karakeep/db/schema";
import { buildUserAgent } from "@karakeep/recommender";
import serverConfig from "@karakeep/shared/config";
import type { ParsedDigest } from "@karakeep/shared/digest";
import type { DigestClient } from "@karakeep/shared/digest";
import {
  buildBatchDigestUserPrompt,
  buildDigestClient,
  buildDigestUserPrompt,
  DIGEST_BATCH_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  parseBatchDigestResponse,
  parseDigestResponse,
} from "@karakeep/shared/digest";
import logger from "@karakeep/shared/logger";

import {
  isDigestCacheHit,
  loadArticleCache,
  putDigest,
  touchArticleCache,
} from "./articleCache";
import { DomainThrottle } from "./shared";

export interface DigestResult {
  considered: number;
  generated: number;
  /** 同じユーザーが以前生成したもの。候補の行にそのまま残っている。 */
  cached: number;
  /** 別ユーザーが生成したものを共有キャッシュから貰った件数。 */
  shared: number;
  failed: number;
  skipped: number;
}

/**
 * 表示が確定した候補にだけ日本語の訳題と要約を付ける（FR-U-13）。
 *
 * **rank の後に別ジョブとして走らせる。** Briefing は 05:30 に原文のまま
 * 出て、日本語は後から埋まる。ここを rank の中で待つと、ローカル LLM が
 * 遅い日や落ちている日に Briefing そのものが出なくなる。
 *
 * 生成対象は 1 日 30 件（`briefingSize`）。取り込みは 800 件/日あるので、
 * 候補プール全体に掛けるのに比べて呼び出しが 96% 減る。結果は候補側に
 * キャッシュするので、同じ記事が翌日も選ばれたら生成しない。
 */
export async function runDigest(
  userId: string,
  briefingId: string,
  jobId: string,
): Promise<DigestResult> {
  const cfg = serverConfig.recommender.digest;
  const log = (msg: string) =>
    logger.info(`[recommender][digest][${jobId}] ${msg}`);
  const empty: DigestResult = {
    considered: 0,
    generated: 0,
    cached: 0,
    shared: 0,
    failed: 0,
    skipped: 0,
  };

  if (cfg.provider === "off") {
    log("RECOMMENDER_DIGEST_PROVIDER is off, nothing to do");
    return empty;
  }

  const client = buildDigestClient();
  if (!client) {
    // 生成できないだけで Briefing は出ている。ジョブは失敗させない。
    logger.warn(
      `[recommender][digest][${jobId}] no digest client configured (provider=${cfg.provider}), skipping`,
    );
    return empty;
  }

  const rows = await db
    .select({
      id: recCandidates.id,
      url: recCandidates.url,
      urlHash: recCandidates.urlHash,
      canonicalUrl: recCandidates.canonicalUrl,
      title: recCandidates.title,
      summary: recCandidates.summary,
      contentExcerpt: recCandidates.contentExcerpt,
      digestStatus: recCandidates.digestStatus,
      digestModelId: recCandidates.digestModelId,
    })
    .from(recImpressions)
    .innerJoin(recCandidates, eq(recCandidates.id, recImpressions.candidateId))
    .where(
      and(
        eq(recImpressions.briefingId, briefingId),
        eq(recImpressions.userId, userId),
        eq(recImpressions.shown, true),
      ),
    )
    .orderBy(recImpressions.rank);

  log(`${rows.length} shown candidates, model=${client.modelId}`);

  const result: DigestResult = { ...empty, considered: rows.length };
  const throttle = new DomainThrottle();
  const now = new Date();

  // 記事単位の共有キャッシュ（FR-S-06）。別ユーザーが既に訳していれば貰う。
  // ここは `shown` になった候補だけを見ており、`loadRankableCandidates` が
  // `origin='collected'` で絞っているので、bootstrap 由来（本人のブックマーク）
  // が共有キャッシュへ書かれる経路は無い。
  const cached = await loadArticleCache(rows.map((r) => r.urlHash));
  const sharedHashes: string[] = [];

  // 生成が要る候補を先に確定させる。バッチで投げるには本文まで揃っている
  // 必要があるので、キャッシュ判定と本文取得をここで済ませてしまう。
  const pending: PendingDigest[] = [];

  for (const row of rows) {
    // モデルを替えたら作り直す。プロンプトを変えたときは
    // RECOMMENDER_DIGEST_MODEL に別名を付けるか、列を消して再生成する。
    if (
      row.digestStatus === "success" &&
      row.digestModelId === client.modelId
    ) {
      result.cached++;
      continue;
    }

    // 候補側のガードの**後**に置く。同一ユーザーが翌日も同じ記事を選んだ
    // ときはクエリ 0 のまま抜ける。
    const hit = cached.get(row.urlHash);
    if (isDigestCacheHit(hit, client.modelId)) {
      result.shared++;
      sharedHashes.push(row.urlHash);
      await db
        .update(recCandidates)
        .set({
          titleJa: hit!.titleJa,
          summaryJa: hit!.summaryJa,
          digestStatus: "success",
          digestModelId: client.modelId,
        })
        .where(eq(recCandidates.id, row.id));
      continue;
    }

    const body = await resolveBody(row, throttle, jobId);
    if (!row.title && !body) {
      result.skipped++;
      await db
        .update(recCandidates)
        .set({ digestStatus: "skipped", digestModelId: client.modelId })
        .where(eq(recCandidates.id, row.id));
      continue;
    }

    pending.push({ row, body });
  }

  // バッチはプロバイダが対応しているときだけ。`completeBatch` を持たない
  // ローカル Ollama では 1 件ずつに落ちる。
  const completeBatch = client.completeBatch?.bind(client);
  const batchSize = completeBatch ? Math.max(1, cfg.batchSize) : 1;
  if (pending.length > 0) {
    log(`${pending.length} to generate, batch size ${batchSize}`);
  }
  // バッチが欠けて単発に落ちた件数。バッチが機能しているかはこれで見る。
  let fellBack = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const group = pending.slice(i, i + batchSize);
    const batched =
      group.length > 1 && completeBatch
        ? await generateBatch(completeBatch, group, jobId)
        : new Map<number, ParsedDigest>();

    for (const [index, item] of group.entries()) {
      // バッチの ID は group 内の 1 始まりの位置（`buildBatchDigestUserPrompt`）。
      let digest = batched.get(index + 1) ?? null;
      if (!digest) {
        if (group.length > 1) {
          fellBack++;
        }
        digest = await generateSingle(client, item, jobId);
      }

      if (!digest) {
        result.failed++;
        // 失敗を記録して次へ。UI は原題と元の要約に落ちる（NFR-09）。
        //
        // **共有キャッシュには書かない。** digest の失敗はたいてい本文取得の
        // 一時的な問題で、全ユーザーに配ると再試行の経路が消える。skipped も同じ。
        await db
          .update(recCandidates)
          .set({ digestStatus: "failure", digestModelId: client.modelId })
          .where(eq(recCandidates.id, item.row.id));
        continue;
      }

      result.generated++;
      await db
        .update(recCandidates)
        .set({
          titleJa: digest.titleJa,
          summaryJa: digest.summaryJa,
          digestStatus: "success",
          digestModelId: client.modelId,
        })
        .where(eq(recCandidates.id, item.row.id));
      await putDigest({
        urlHash: item.row.urlHash,
        canonicalUrl: item.row.canonicalUrl,
        titleJa: digest.titleJa,
        summaryJa: digest.summaryJa,
        modelId: client.modelId,
        now,
      });
    }
  }

  await touchArticleCache(sharedHashes, now);

  log(
    `generated ${result.generated}, cached ${result.cached}, shared ${result.shared}, failed ${result.failed}, skipped ${result.skipped}` +
      (batchSize > 1 ? `, single-call fallbacks ${fellBack}` : ""),
  );
  return result;
}

interface PendingDigest {
  row: {
    id: string;
    url: string;
    urlHash: string;
    canonicalUrl: string;
    title: string | null;
  };
  body: string;
}

const toDigestInput = (item: PendingDigest) => ({
  title: item.row.title,
  url: item.row.url,
  body: item.body,
});

/**
 * まとめて 1 回で作る。**部分的な成功を許す。** 読めた ID だけ返し、
 * 欠けたぶんは呼び出し側が単発で作り直す。1 件の取りこぼしで group 全体を
 * 落とすと、バッチにした瞬間に失敗率が跳ね上がる。
 */
async function generateBatch(
  completeBatch: NonNullable<DigestClient["completeBatch"]>,
  group: PendingDigest[],
  jobId: string,
): Promise<Map<number, ParsedDigest>> {
  try {
    const raw = await completeBatch(
      DIGEST_BATCH_SYSTEM_PROMPT,
      buildBatchDigestUserPrompt(group.map(toDigestInput)),
    );
    const parsed = parseBatchDigestResponse(raw);
    if (parsed.size < group.length) {
      logger.warn(
        `[recommender][digest][${jobId}] batch returned ${parsed.size}/${group.length}, falling back to single calls for the rest`,
      );
    }
    return parsed;
  } catch (e) {
    logger.warn(
      `[recommender][digest][${jobId}] batch of ${group.length} failed: ${e instanceof Error ? e.message : e}`,
    );
    return new Map();
  }
}

async function generateSingle(
  client: DigestClient,
  item: PendingDigest,
  jobId: string,
): Promise<ParsedDigest | null> {
  try {
    const raw = await client.complete(
      DIGEST_SYSTEM_PROMPT,
      buildDigestUserPrompt(toDigestInput(item)),
    );
    return parseDigestResponse(raw);
  } catch (e) {
    logger.warn(
      `[recommender][digest][${jobId}] ${item.row.url} failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 本文の取得
 * ------------------------------------------------------------------ */

/** 本文取得のレスポンス上限。JSDOM に流すので、大きいページは諦める。 */
const MAX_ARTICLE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

interface BodySource {
  url: string;
  summary: string | null;
  contentExcerpt: string | null;
}

async function resolveBody(
  candidate: BodySource,
  throttle: DomainThrottle,
  jobId: string,
): Promise<string> {
  const cfg = serverConfig.recommender.digest;
  const local = pickLocalBody(candidate, cfg.bodyChars);
  if (!cfg.fetchBody || local.length >= cfg.bodyChars) {
    return local;
  }

  // RSS の description は 1〜2 文しか無いことが多く、そこから作った要約は
  // 元の要約を訳しただけのものになる。実測で Briefing 30 件中 10 件が
  // 200 字未満だったので、足りない分だけ本文を取りに行く。
  try {
    const fetched = await fetchArticleText(candidate.url, throttle);
    if (fetched.length > local.length) {
      return fetched.slice(0, cfg.bodyChars);
    }
  } catch (e) {
    logger.debug(
      `[recommender][digest][${jobId}] body fetch failed for ${candidate.url}: ${e instanceof Error ? e.message : e}`,
    );
  }
  return local;
}

export function pickLocalBody(candidate: BodySource, limit: number): string {
  const excerpt = candidate.contentExcerpt?.trim() ?? "";
  const summary = candidate.summary?.trim() ?? "";
  return (excerpt.length >= summary.length ? excerpt : summary).slice(0, limit);
}

async function fetchArticleText(
  url: string,
  throttle: DomainThrottle,
): Promise<string> {
  await throttle.wait(new URL(url).hostname);

  const response = await fetch(url, {
    headers: {
      "User-Agent": buildUserAgent(serverConfig.recommender.contactUrl),
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    throw new Error(`not html (${contentType})`);
  }
  const html = (await response.text()).slice(0, MAX_ARTICLE_BYTES);
  return extractArticleText(html, url);
}

/**
 * Readability で本文だけ抜いて素テキストにする。
 *
 * クローラは同じことを別プロセスでやっているが（`parseHtmlSubprocess`）、
 * あちらは任意のページを相手にするのでメモリ上限が要る。こちらは 1 日
 * 30 件・2MB 上限なので、プロセスを起こすコストのほうが高い。
 */
export function extractArticleText(html: string, url: string): string {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url, virtualConsole });
  try {
    const article = new Readability(dom.window.document).parse();
    const text = article?.textContent ?? "";
    return text.replace(/\s+/g, " ").trim();
  } finally {
    dom.window.close();
  }
}
