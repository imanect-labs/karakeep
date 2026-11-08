import { and, eq, isNull } from "drizzle-orm";

import { db } from "@karakeep/db";
import { bookmarks, recCandidates } from "@karakeep/db/schema";
import {
  articleTranslationPrompt,
  articleTranslationSchema,
  parseArticleTranslation,
} from "@karakeep/shared/briefing";
import serverConfig from "@karakeep/shared/config";
import { InferenceClientFactory } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";

export async function runArticleTranslation(
  userId: string,
  candidateId: string,
  jobId: string,
  signal?: AbortSignal,
) {
  const candidate = await db.query.recCandidates.findFirst({
    where: and(
      eq(recCandidates.id, candidateId),
      eq(recCandidates.userId, userId),
    ),
  });
  if (!candidate || candidate.titleJa) return;
  try {
    const client = InferenceClientFactory.build();
    if (!client) throw new Error("Translation provider is not configured");
    const result = await client.inferFromText(
      articleTranslationPrompt(candidate.title, candidate.summary),
      {
        schema: articleTranslationSchema,
        abortSignal: signal,
        sessionId: `karakeep-briefing-translation-${candidateId}`,
      },
    );
    const translated = parseArticleTranslation(result.response);
    await db
      .update(recCandidates)
      .set({
        ...translated,
        digestStatus: "success",
        digestModelId: `translation/${serverConfig.inference.textModel}`,
      })
      .where(
        and(
          eq(recCandidates.id, candidateId),
          eq(recCandidates.userId, userId),
        ),
      );
    // Keep the source title intact, and preserve titles the user already edited.
    // The reader uses the bookmark's display title as well as the Briefing card.
    if (candidate.bookmarkId) {
      await db
        .update(bookmarks)
        .set({ title: translated.titleJa })
        .where(
          and(
            eq(bookmarks.id, candidate.bookmarkId),
            eq(bookmarks.userId, userId),
            isNull(bookmarks.title),
          ),
        );
    }
    logger.info(
      `[recommender][translate][${jobId}] translated title and excerpt for ${candidateId}`,
    );
  } catch (error) {
    await db
      .update(recCandidates)
      .set({ digestStatus: "failure" })
      .where(
        and(
          eq(recCandidates.id, candidateId),
          eq(recCandidates.userId, userId),
        ),
      );
    throw error;
  }
}
