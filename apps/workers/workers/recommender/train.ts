import { createId } from "@paralleldrive/cuid2";
import { and, eq, ne } from "drizzle-orm";

import { db } from "@karakeep/db";
import {
  recBriefings,
  recFeedbackEvents,
  recImpressions,
  recModels,
} from "@karakeep/db/schema";
import type { RewardEvent, TrainingItem } from "@karakeep/recommender";
import {
  evaluatePairwise,
  fitPairwise,
  isStrongPositive,
  makeTrainingPairs,
  PAIRWISE_FEATURES,
  selectRegularization,
  trainingVector,
} from "@karakeep/recommender";
import logger from "@karakeep/shared/logger";

export async function runTrain(userId: string, jobId: string) {
  const log = (message: string) =>
    logger.info(`[recommender][train][${jobId}] ${message}`);
  // A row per event; collapse events before counting positives or making pairs.
  const rows = await db
    .select({
      id: recImpressions.id,
      candidateId: recImpressions.candidateId,
      briefingId: recImpressions.briefingId,
      date: recBriefings.briefingDate,
      features: recImpressions.features,
      event: recFeedbackEvents.eventType,
    })
    .from(recImpressions)
    .innerJoin(recBriefings, eq(recBriefings.id, recImpressions.briefingId))
    .leftJoin(
      recFeedbackEvents,
      eq(recFeedbackEvents.impressionId, recImpressions.id),
    )
    .where(
      and(
        eq(recImpressions.userId, userId),
        eq(recImpressions.source, "briefing"),
        eq(recImpressions.shown, true),
        eq(recImpressions.examined, true),
        eq(recImpressions.rewardFinalized, true),
        eq(recImpressions.featureSchemaVersion, "heuristic-v1"),
        ne(recBriefings.observationState, "unobserved"),
      ),
    );
  const byId = new Map<string, TrainingItem>();
  const candidates = new Map<string, string>();
  for (const row of rows) {
    if (!row.briefingId || !row.features || !trainingVector(row.features))
      continue;
    const item = byId.get(row.id) ?? {
      id: row.id,
      briefingId: row.briefingId,
      date: row.date,
      features: row.features,
      events: [] as RewardEvent[],
    };
    if (row.event && !item.events.includes(row.event))
      item.events.push(row.event);
    byId.set(row.id, item);
    candidates.set(row.id, row.candidateId);
  }
  const items = [...byId.values()];
  const positives = new Set(
    items
      .filter((item) => isStrongPositive(item.events))
      .map((item) => candidates.get(item.id)),
  ).size;
  const days = new Set(items.map((item) => item.date)).size;
  const pairs = makeTrainingPairs(items);
  log(
    `eligible examined=${items.length}, distinct positives=${positives}, days=${days}, pairs=${pairs.length}`,
  );
  if (items.length < 100 || positives < 20 || days < 5 || pairs.length < 100) {
    log(
      "skipped: shadow learning needs 100 examined, 20 distinct strong positives, 5 observed days and 100 pairs; unseen and unfinalized impressions are excluded",
    );
    return;
  }
  const selectedLambda = selectRegularization(items);
  const lambda = selectedLambda ?? 1;
  if (selectedLambda === null) {
    log(
      "no usable expanding-window folds: using prespecified strong L2 regularization (lambda=1) for shadow learning only",
    );
  }
  const weights = fitPairwise(pairs, lambda);
  if (!weights.every(Number.isFinite))
    throw new Error("Non-finite pairwise model weights");
  const latest = items
    .map((item) => item.date)
    .sort()
    .at(-1)!;
  const cutoff = new Date(Date.parse(latest) - 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const trainingCutoff = new Date(Date.parse(cutoff) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const past = items.filter((item) => item.date < trainingCutoff);
  const heldOut = items.filter((item) => item.date >= cutoff);
  const validationWeights = fitPairwise(
    makeTrainingPairs(past),
    selectRegularization(past) ?? 1,
  );
  const validation = evaluatePairwise(heldOut, validationWeights);
  const heuristic = evaluatePairwise(
    heldOut,
    PAIRWISE_FEATURES.map((key) => (key === "rank" ? 0 : 1)),
  );
  const version = `logreg-v1-${createId()}`;
  await db.insert(recModels).values({
    version,
    userId,
    kind: "logreg",
    status: "shadow",
    params: { weights, lambda, trainingThrough: latest },
    featureSchema: [...PAIRWISE_FEATURES],
    featureSchemaVersion: "heuristic-v1",
    trainedAt: new Date(),
    trainSampleCount: items.length,
    positiveCount: positives,
    metrics: {
      pairs: pairs.length,
      observedDays: days,
      regularizationCrossValidated: selectedLambda === null ? 0 : 1,
      validationPairs: validation.pairs,
      validationBriefings: validation.briefings,
      validationPairAccuracy: validation.pairAccuracy,
      validationNdcg20: validation.ndcg20,
      heuristicPairAccuracy: heuristic.pairAccuracy,
      heuristicNdcg20: heuristic.ndcg20,
    },
  });
  log(
    `trained ${version} in shadow mode: ${JSON.stringify(validation)}; heuristic=${JSON.stringify(heuristic)}; serving remains heuristic pending prospective evaluation`,
  );
}
