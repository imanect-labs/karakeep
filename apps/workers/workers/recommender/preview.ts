import { Readable } from "node:stream";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { JSDOM, VirtualConsole } from "jsdom";
import { fetchWithProxy, validateUrl } from "network";

import { db } from "@karakeep/db";
import {
  recArticleCache,
  recCandidates,
  recImpressions,
} from "@karakeep/db/schema";
import { buildUserAgent } from "@karakeep/recommender";
import { RecommenderQueue } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";

import { DomainThrottle } from "./shared";

export function extractArticlePreview(html: string, url: string) {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const value =
      document
        .querySelector('meta[property="og:image"], meta[name="og:image"]')
        ?.getAttribute("content") ||
      document
        .querySelector(
          'meta[name="twitter:image"], meta[property="twitter:image"]',
        )
        ?.getAttribute("content");
    let imageUrl: string | null = null;
    if (value?.trim()) {
      try {
        const image = new URL(value.trim(), url);
        if (
          ["https:", "http:"].includes(image.protocol) &&
          !image.username &&
          !image.password
        )
          imageUrl = image.href;
      } catch {
        /* An invalid preview must not hide the article. */
      }
    }
    return {
      imageUrl,
      lang: document.documentElement.lang.trim().slice(0, 35) || null,
    };
  } finally {
    dom.window.close();
  }
}

export async function runArticlePreviews(
  userId: string,
  briefingId: string,
  jobId: string,
  signal?: AbortSignal,
) {
  const rows = await db
    .select({
      id: recCandidates.id,
      url: recCandidates.url,
      urlHash: recCandidates.urlHash,
      canonicalUrl: recCandidates.canonicalUrl,
      imageUrl: recArticleCache.imageUrl,
      fetchedAt: recArticleCache.previewFetchedAt,
    })
    .from(recImpressions)
    .innerJoin(recCandidates, eq(recCandidates.id, recImpressions.candidateId))
    .leftJoin(
      recArticleCache,
      eq(recArticleCache.urlHash, recCandidates.urlHash),
    )
    .where(
      and(
        eq(recImpressions.userId, userId),
        eq(recCandidates.userId, userId),
        eq(recImpressions.briefingId, briefingId),
        eq(recImpressions.shown, true),
        eq(recCandidates.origin, "collected"),
        or(
          isNull(recArticleCache.previewFetchedAt),
          lt(
            recArticleCache.previewFetchedAt,
            new Date(Date.now() - 7 * 86_400_000),
          ),
          and(
            isNull(recArticleCache.imageUrl),
            lt(
              recArticleCache.previewFetchedAt,
              new Date(Date.now() - 86_400_000),
            ),
          ),
        ),
      ),
    )
    .orderBy(recImpressions.rank)
    .limit(5);
  const throttle = new DomainThrottle();
  let fetched = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    const now = new Date();
    let imageUrl = row.imageUrl;
    let response: Awaited<ReturnType<typeof fetchWithProxy>> | undefined;
    try {
      await throttle.wait(new URL(row.url).hostname);
      response = await fetchWithProxy(row.url, {
        headers: {
          "User-Agent": buildUserAgent(serverConfig.recommender.contactUrl),
          Accept: "text/html",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(6000)])
          : AbortSignal.timeout(6000),
        size: 2 * 1024 * 1024,
      });
      if (
        response.ok &&
        /text\/html|application\/xhtml\+xml/.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        const preview = extractArticlePreview(
          await response.text(),
          response.url || row.url,
        );
        if (preview.imageUrl && (await validateUrl(preview.imageUrl, false)).ok)
          imageUrl = preview.imageUrl;
        if (preview.lang)
          await db
            .update(recCandidates)
            .set({ lang: preview.lang })
            .where(
              and(
                eq(recCandidates.id, row.id),
                eq(recCandidates.userId, userId),
              ),
            );
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.debug(
        `[recommender][preview][${jobId}] no preview for ${row.id}: ${String(error)}`,
      );
    } finally {
      if (response?.body instanceof Readable) response.body.destroy();
    }
    await db
      .insert(recArticleCache)
      .values({
        urlHash: row.urlHash,
        canonicalUrl: row.canonicalUrl,
        imageUrl,
        previewFetchedAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: recArticleCache.urlHash,
        set: { imageUrl, previewFetchedAt: now, lastUsedAt: now },
      });
    fetched++;
  }
  // Yield between batches so an interactive title translation is not stuck
  // behind all fifty network requests in the single recommender runner.
  if (rows.length === 5)
    await RecommenderQueue.enqueue(
      { type: "preview", userId, briefingId },
      { groupId: userId },
    );
  logger.info(
    `[recommender][preview][${jobId}] fetched ${fetched} of ${rows.length} shown article previews`,
  );
}
