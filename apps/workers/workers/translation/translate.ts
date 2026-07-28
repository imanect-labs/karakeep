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

/** Strip a ```html ... ``` code fence the model may add despite instructions. */
function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = /^```(?:html)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1] : t;
}

/** Visible text of an HTML fragment, whitespace collapsed. */
function toPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Last `chars` characters of the visible text, or null when disabled/empty.
 * Only the tail of the markup is scanned (tags inflate it several-fold) so this
 * stays cheap even when called once per chunk on a growing document.
 */
function contextTail(html: string, chars: number): string | null {
  if (chars <= 0 || !html) {
    return null;
  }
  const text = toPlainText(html.slice(-chars * 6));
  return text ? text.slice(-chars) : null;
}

/** Heuristic: is the text already predominantly CJK/Japanese? */
function looksLikeJapanese(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, " ").slice(0, 4000);
  const jp = text.match(/[぀-ヿ一-鿿]/g)?.length ?? 0;
  const nonSpace = text.match(/\S/g)?.length ?? 0;
  return nonSpace > 0 && jp / nonSpace > 0.3;
}

async function fetchLinkForTranslation(bookmarkId: string) {
  const bookmark = await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, bookmarkId),
    columns: { id: true, userId: true, type: true, title: true },
    with: {
      link: {
        columns: {
          htmlContent: true,
          contentAssetId: true,
          url: true,
          title: true,
          translatedContent: true,
          translationTotalChunks: true,
          translationDoneChunks: true,
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

  // A retried job re-chunks the same HTML with the same config, so the chunk
  // list is identical and the already-translated prefix can be kept instead of
  // being paid for again (and instead of the reader's progress going backwards).
  const resumable =
    link.translationTotalChunks === chunks.length &&
    (link.translationDoneChunks ?? 0) > 0 &&
    (link.translationDoneChunks ?? 0) < chunks.length &&
    !!link.translatedContent;
  const translated: string[] = resumable ? [link.translatedContent!] : [];
  let doneChunks = resumable ? link.translationDoneChunks! : 0;
  // Characters of the source HTML the done chunks cover, so the reader can
  // append the not-yet-translated remainder to the partial translation.
  let sourceOffset = chunks
    .slice(0, doneChunks)
    .reduce((acc, c) => acc + c.length, 0);

  logger.info(
    `[translation][${jobId}] Translating "${bookmarkId}" into ${targetLang} in ${chunks.length} chunk(s)` +
      (resumable ? `, resuming from chunk ${doneChunks + 1}.` : "."),
  );

  // Publish the chunk count up front so the reader can show a progress bar from
  // the first poll, and reset any stale partial output when not resuming.
  await db
    .update(bookmarkLinks)
    .set({
      translatedContent: resumable ? link.translatedContent : null,
      translationTotalChunks: chunks.length,
      translationDoneChunks: doneChunks,
      translationSourceOffset: sourceOffset,
    })
    .where(eq(bookmarkLinks.id, bookmarkId));

  // Chunks are translated independently, which on its own makes terminology and
  // style drift between them and strands sentences split across a boundary. Hand
  // the model the tail of what came just before (source + its translation) as
  // reference-only context so it can continue rather than restart.
  const contextChars = serverConfig.translation.contextChars;
  const title = bookmarkData.title ?? link.title ?? null;

  let totalTokens = 0;
  for (const chunk of chunks.slice(doneChunks)) {
    const prompt = constructTranslationPrompt(targetLang, chunk, {
      title,
      previousSource: contextTail(
        html.slice(Math.max(0, sourceOffset - contextChars * 6), sourceOffset),
        contextChars,
      ),
      previousTranslation: contextTail(translated.join(""), contextChars),
      style: serverConfig.translation.style,
    });
    const result = await inferenceClient.inferFromText(prompt, {
      schema: null,
      abortSignal: job.abortSignal,
    });
    if (!result.response) {
      throw new Error(
        `[translation][${jobId}] Empty translation response for "${bookmarkId}".`,
      );
    }
    const translatedChunk = stripCodeFence(result.response);

    // Dropped or summarized content is the one failure mode that silently
    // changes meaning, and it always shows up as a much shorter chunk. Japanese
    // is denser than English so some shrinkage is expected; only shout when the
    // visible text almost vanished.
    const srcLen = toPlainText(chunk).length;
    const outLen = toPlainText(translatedChunk).length;
    if (srcLen > 200 && outLen < srcLen * 0.2) {
      logger.warn(
        `[translation][${jobId}] Chunk ${doneChunks + 1}/${chunks.length} of "${bookmarkId}" shrank from ${srcLen} to ${outLen} visible chars; content may have been dropped.`,
      );
    }

    translated.push(translatedChunk);
    totalTokens += result.totalTokens ?? 0;
    doneChunks += 1;
    sourceOffset += chunk.length;

    // Persist after every chunk so the reader renders the translation as it
    // streams in rather than only once the whole document is done. Chunks are
    // cut at top-level tag boundaries, so a prefix is still well-formed HTML.
    await db
      .update(bookmarkLinks)
      .set({
        translatedContent: translated.join(""),
        translationDoneChunks: doneChunks,
        translationSourceOffset: sourceOffset,
      })
      .where(eq(bookmarkLinks.id, bookmarkId));
  }

  addLogFields<"translationWorker.run">({
    "translation.num_chunks": chunks.length,
    "translation.total_tokens": totalTokens,
  });

  await db
    .update(bookmarks)
    .set({ modifiedAt: new Date() })
    .where(eq(bookmarks.id, bookmarkId));

  logger.info(
    `[translation][${jobId}] Translated "${bookmarkId}" (${chunks.length} chunks, ${totalTokens} tokens).`,
  );
}
