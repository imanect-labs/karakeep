import { Readability } from "@mozilla/readability";
import { and, eq } from "drizzle-orm";
import { JSDOM, VirtualConsole } from "jsdom";

import { db } from "@karakeep/db";
import { recCandidates, recImpressions } from "@karakeep/db/schema";
import { buildUserAgent } from "@karakeep/recommender";
import serverConfig from "@karakeep/shared/config";
import type { ParsedDigest } from "@karakeep/shared/digest";
import {
  buildDigestClient,
  buildDigestUserPrompt,
  DIGEST_SYSTEM_PROMPT,
  parseDigestResponse,
} from "@karakeep/shared/digest";
import logger from "@karakeep/shared/logger";

import { DomainThrottle } from "./shared";

export interface DigestResult {
  considered: number;
  generated: number;
  cached: number;
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

    const body = await resolveBody(row, throttle, jobId);
    if (!row.title && !body) {
      result.skipped++;
      await db
        .update(recCandidates)
        .set({ digestStatus: "skipped", digestModelId: client.modelId })
        .where(eq(recCandidates.id, row.id));
      continue;
    }

    let digest: ParsedDigest | null = null;
    try {
      const raw = await client.complete(
        DIGEST_SYSTEM_PROMPT,
        buildDigestUserPrompt({ title: row.title, url: row.url, body }),
      );
      digest = parseDigestResponse(raw);
    } catch (e) {
      logger.warn(
        `[recommender][digest][${jobId}] ${row.url} failed: ${e instanceof Error ? e.message : e}`,
      );
    }

    if (!digest) {
      result.failed++;
      // 失敗を記録して次へ。UI は原題と元の要約に落ちる（NFR-09）。
      await db
        .update(recCandidates)
        .set({ digestStatus: "failure", digestModelId: client.modelId })
        .where(eq(recCandidates.id, row.id));
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
      .where(eq(recCandidates.id, row.id));
  }

  log(
    `generated ${result.generated}, cached ${result.cached}, failed ${result.failed}, skipped ${result.skipped}`,
  );
  return result;
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
