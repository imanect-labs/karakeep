import { eq } from "drizzle-orm";
import { getBookmarkDomain } from "network";

import { db } from "@karakeep/db";
import { bookmarkLinks, bookmarks } from "@karakeep/db/schema";
import {
  addLogFields,
  setSpanAttributes,
  ZTranslationRequest,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { InferenceClient } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";
import { constructTranslationPrompt } from "@karakeep/shared/prompts";
import { DequeuedJob } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { Bookmark } from "@karakeep/trpc/models/bookmarks";

import { buildLocalTranslator, translateChunkLocally } from "./localChunk";
import {
  cjkRatio,
  findChunkProblems,
  proseText,
  restoreCodeContent,
  stripCodeFence,
  stripPreamble,
} from "./validate";

// Void (self-closing) HTML elements that never increase nesting depth.
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Split HTML into top-level (depth-0) segments. The concatenation of the
 * returned segments is byte-for-byte identical to the input, so translating
 * each and concatenating reproduces the original document structure.
 */
function computeTopLevelSegments(html: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let segStart = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    // HTML comment
    if (html.startsWith("<!--", lt)) {
      const ce = html.indexOf("-->", lt);
      i = ce === -1 ? html.length : ce + 3;
      if (depth === 0) {
        segs.push(html.slice(segStart, i));
        segStart = i;
      }
      continue;
    }

    const gt = html.indexOf(">", lt);
    if (gt === -1) break;
    const tag = html.slice(lt, gt + 1);
    const isClose = tag[1] === "/";
    const nameMatch = /^<\/?\s*([a-zA-Z0-9-]+)/.exec(tag);
    const name = nameMatch ? nameMatch[1].toLowerCase() : "";
    const selfClose = tag.endsWith("/>") || VOID_TAGS.has(name);

    if (isClose) {
      depth = Math.max(0, depth - 1);
    } else if (!selfClose) {
      depth += 1;
    }
    i = gt + 1;
    if (depth === 0) {
      segs.push(html.slice(segStart, i));
      segStart = i;
    }
  }
  if (segStart < html.length) {
    segs.push(html.slice(segStart));
  }
  return segs.filter((s) => s.length > 0);
}

/**
 * Split an oversized segment at tag boundaries ("...>") so a tag is never cut.
 * Concatenation still reproduces the segment.
 */
function hardSplitAtTagBoundaries(seg: string, maxChars: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < seg.length) {
    let end = Math.min(start + maxChars, seg.length);
    if (end < seg.length) {
      const prevGt = seg.lastIndexOf(">", end);
      if (prevGt > start) {
        end = prevGt + 1;
      } else {
        const nextGt = seg.indexOf(">", end);
        end = nextGt === -1 ? seg.length : nextGt + 1;
      }
    }
    out.push(seg.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * Chunk HTML into pieces that each stay near maxChars, only cutting at tag
 * boundaries. concat(chunks) === html.
 */
function chunkHtml(html: string, maxChars: number): string[] {
  const segments = computeTopLevelSegments(html);
  const chunks: string[] = [];
  let cur = "";
  for (const seg of segments) {
    if (seg.length > maxChars) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      chunks.push(...hardSplitAtTagBoundaries(seg, maxChars));
      continue;
    }
    if (cur && cur.length + seg.length > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    cur += seg;
  }
  if (cur) {
    chunks.push(cur);
  }
  return chunks;
}

/**
 * Heuristic: is the text already predominantly CJK/Japanese?
 *
 * Measured over the whole document's prose with code excluded. Sampling only the
 * first 4000 characters and counting code along with it made this miss real
 * Japanese articles: a zenn post about Rust scored 28.9% against the 0.3
 * threshold because its opening is full of Rust snippets and identifiers, so it
 * was translated Japanese-to-Japanese. The same article is 76.7% by prose.
 */
function looksLikeJapanese(html: string): boolean {
  return cjkRatio(proseText(html)) > 0.3;
}

async function fetchLinkForTranslation(bookmarkId: string) {
  const bookmark = await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, bookmarkId),
    columns: { id: true, userId: true, type: true },
    with: {
      link: {
        columns: {
          htmlContent: true,
          contentAssetId: true,
          url: true,
          translatedContent: true,
          translationTotalChunks: true,
          translationDoneChunks: true,
          translationSourceOffset: true,
        },
      },
    },
  });
  if (!bookmark) {
    throw new Error(`Bookmark with id ${bookmarkId} not found`);
  }
  return bookmark;
}

export async function runTranslation(
  bookmarkId: string,
  job: DequeuedJob<ZTranslationRequest>,
  inferenceClient: InferenceClient,
) {
  const jobId = job.id;

  if (!serverConfig.translation.enableAuto) {
    logger.debug(
      `[translation][${jobId}] Skipping translation for bookmark "${bookmarkId}": disabled in config.`,
    );
    return;
  }

  const bookmarkData = await fetchLinkForTranslation(bookmarkId);
  if (bookmarkData.type !== BookmarkTypes.LINK || !bookmarkData.link) {
    logger.debug(
      `[translation][${jobId}] Bookmark "${bookmarkId}" is not a crawlable LINK. Skipping.`,
    );
    return;
  }

  const link = bookmarkData.link;
  const targetLang = serverConfig.translation.targetLang;

  setSpanAttributes({
    "user.id": bookmarkData.userId,
    "bookmark.id": bookmarkData.id,
  });
  addLogFields<"translationWorker.run">({
    "bookmark.id": bookmarkId,
    "bookmark.url": link.url,
    "bookmark.domain": getBookmarkDomain(link.url),
    "translation.target_lang": targetLang,
    "translation.model": serverConfig.inference.textModel,
  });

  const html = await Bookmark.getBookmarkHtmlContent(
    { contentAssetId: link.contentAssetId, htmlContent: link.htmlContent },
    bookmarkData.userId,
  );
  if (!html || !html.trim()) {
    logger.info(
      `[translation][${jobId}] No readable HTML content for "${bookmarkId}". Skipping.`,
    );
    return;
  }

  if (serverConfig.translation.skipIfTarget && looksLikeJapanese(html)) {
    logger.info(
      `[translation][${jobId}] Content of "${bookmarkId}" already looks like the target language. Skipping.`,
    );
    addLogFields<"translationWorker.run">({ "translation.skipped": true });
    return;
  }

  // ~3 chars/token is a conservative English-HTML estimate; keeps each chunk's
  // expected output within the model's max output tokens.
  const maxChars = Math.max(500, serverConfig.translation.chunkTokens * 3);
  const chunks = chunkHtml(html, maxChars);

  // A finished translation of this exact HTML. The crawler retries a URL and
  // enqueues a translation job per crawl, so the same content routinely arrives
  // twice; without this the second job re-pays for an identical result.
  const alreadyTranslated =
    !!link.translatedContent &&
    link.translationTotalChunks === chunks.length &&
    link.translationDoneChunks === chunks.length &&
    link.translationSourceOffset === html.length;
  if (alreadyTranslated) {
    logger.info(
      `[translation][${jobId}] "${bookmarkId}" is already translated from identical content (${chunks.length} chunks). Skipping.`,
    );
    addLogFields<"translationWorker.run">({ "translation.skipped": true });
    return;
  }

  // A retried job re-chunks the same HTML with the same config, so the chunk
  // list is identical and the already-translated prefix can be kept instead of
  // being paid for again (and instead of the reader's progress going backwards).
  const resumable =
    link.translationTotalChunks === chunks.length &&
    (link.translationDoneChunks ?? 0) > 0 &&
    (link.translationDoneChunks ?? 0) < chunks.length &&
    !!link.translatedContent;

  // Whether the reader currently has something worth looking at. If it does, the
  // new run is built up in memory and swapped in at the end: overwriting as we
  // go would replace a readable article with English for the whole run, which is
  // exactly what a reader mid-article sees. Only a bookmark with nothing (or
  // only a half-finished prefix) streams chunk by chunk.
  const hasReadableTranslation = !!link.translatedContent && !resumable;
  const translated: string[] = resumable ? [link.translatedContent!] : [];
  let doneChunks = resumable ? link.translationDoneChunks! : 0;
  // Characters of the source HTML the done chunks cover, so the reader can
  // append the not-yet-translated remainder to the partial translation.
  let sourceOffset = chunks
    .slice(0, doneChunks)
    .reduce((acc, c) => acc + c.length, 0);

  logger.info(
    `[translation][${jobId}] Translating "${bookmarkId}" into ${targetLang} in ${chunks.length} chunk(s)` +
      (resumable ? `, resuming from chunk ${doneChunks + 1}` : "") +
      (hasReadableTranslation
        ? ", keeping the existing translation visible until this run finishes"
        : "") +
      ".",
  );

  // Publish the chunk count up front so the reader can show a progress bar from
  // the first poll. translatedContent is only touched when there is nothing
  // readable to protect.
  await db
    .update(bookmarkLinks)
    .set({
      ...(hasReadableTranslation
        ? {}
        : {
            translatedContent: resumable ? link.translatedContent : null,
            translationSourceOffset: sourceOffset,
          }),
      translationTotalChunks: chunks.length,
      translationDoneChunks: doneChunks,
    })
    .where(eq(bookmarkLinks.id, bookmarkId));

  const targetIsJapanese = targetLang.trim().toLowerCase() === "japanese";
  const maxAttempts = serverConfig.translation.maxChunkAttempts;

  // ローカル経路ではモデルに HTML を見せない。構造の保存はコード側の不変条件に
  // なるので、再サンプリング（外部経路の maxAttempts）は要らない。設定が
  // 揃っていなければ黙って外部経路に落ちる。
  const localTranslator =
    serverConfig.translation.provider === "local"
      ? buildLocalTranslator()
      : null;
  if (serverConfig.translation.provider === "local" && !localTranslator) {
    logger.warn(
      `[translation][${jobId}] TRANSLATION_PROVIDER=local but no Ollama base URL is configured; falling back to the external provider.`,
    );
  }
  if (localTranslator) {
    addLogFields<"translationWorker.run">({
      "translation.model": localTranslator.modelId,
    });
  }

  let totalTokens = 0;
  let retriedChunks = 0;
  let degradedChunks = 0;
  let localSegments = 0;
  let localUntranslated = 0;
  for (const chunk of chunks.slice(doneChunks)) {
    let chunkText: string;

    if (localTranslator) {
      const { html: out, stats } = await translateChunkLocally(
        localTranslator,
        chunk,
        targetLang,
        { jobId },
      );
      localSegments += stats.segments;
      localUntranslated += stats.failed + stats.degraded;
      chunkText = out;
      if (stats.failed + stats.degraded > 0) {
        degradedChunks += 1;
        logger.warn(
          `[translation][${jobId}] Chunk ${doneChunks + 1}/${chunks.length} of "${bookmarkId}": ${stats.failed + stats.degraded}/${stats.segments} blocks kept untranslated (${stats.degraded} because the inline tags could not be restored).`,
        );
      }
    } else {
      const prompt = constructTranslationPrompt(targetLang, chunk);

      // The endpoint is unreliable per call, not per prompt: on some chunks it
      // echoes the input, prepends "以下が…翻訳したものです。", or rewrites code.
      // Sampling again clears it, so keep the cleanest attempt.
      let best: { text: string; problems: string[] } | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await inferenceClient.inferFromText(prompt, {
          schema: null,
          abortSignal: job.abortSignal,
        });
        totalTokens += result.totalTokens ?? 0;
        if (!result.response) {
          throw new Error(
            `[translation][${jobId}] Empty translation response for "${bookmarkId}".`,
          );
        }
        const text = restoreCodeContent(
          chunk,
          stripPreamble(chunk, stripCodeFence(result.response)),
        );
        const problems = findChunkProblems(chunk, text, targetIsJapanese);
        if (!best || problems.length < best.problems.length) {
          best = { text, problems };
        }
        if (problems.length === 0) {
          break;
        }
        if (attempt < maxAttempts) {
          retriedChunks += 1;
          logger.info(
            `[translation][${jobId}] Chunk ${doneChunks + 1}/${chunks.length} of "${bookmarkId}" ${problems.join("; ")}; retrying (attempt ${attempt + 1}/${maxAttempts}).`,
          );
        }
      }
      if (best!.problems.length > 0) {
        degradedChunks += 1;
        logger.warn(
          `[translation][${jobId}] Chunk ${doneChunks + 1}/${chunks.length} of "${bookmarkId}" kept with problems after ${maxAttempts} attempts: ${best!.problems.join("; ")}.`,
        );
      }
      chunkText = best!.text;
    }

    translated.push(chunkText);
    doneChunks += 1;
    sourceOffset += chunk.length;

    // Persist after every chunk so the reader renders the translation as it
    // streams in rather than only once the whole document is done. Chunks are
    // cut at top-level tag boundaries, so a prefix is still well-formed HTML.
    // When an existing translation is being replaced, only the counters move:
    // the article stays readable and the new text is swapped in below.
    await db
      .update(bookmarkLinks)
      .set({
        ...(hasReadableTranslation
          ? {}
          : {
              translatedContent: translated.join(""),
              translationSourceOffset: sourceOffset,
            }),
        translationDoneChunks: doneChunks,
      })
      .where(eq(bookmarkLinks.id, bookmarkId));
  }

  if (hasReadableTranslation) {
    await db
      .update(bookmarkLinks)
      .set({
        translatedContent: translated.join(""),
        translationSourceOffset: sourceOffset,
      })
      .where(eq(bookmarkLinks.id, bookmarkId));
  }

  addLogFields<"translationWorker.run">({
    "translation.num_chunks": chunks.length,
    "translation.total_tokens": totalTokens,
    "translation.retried_chunks": retriedChunks,
    "translation.degraded_chunks": degradedChunks,
    ...(localTranslator
      ? {
          "translation.text_nodes": localSegments,
          "translation.text_nodes_failed": localUntranslated,
        }
      : {}),
  });

  await db
    .update(bookmarks)
    .set({ modifiedAt: new Date() })
    .where(eq(bookmarks.id, bookmarkId));

  logger.info(
    `[translation][${jobId}] Translated "${bookmarkId}" (${chunks.length} chunks, ` +
      (localTranslator
        ? `${localSegments} blocks, ${localUntranslated} untranslated`
        : `${totalTokens} tokens, ${retriedChunks} retries`) +
      `, ${degradedChunks} chunks kept with problems).`,
  );
}
