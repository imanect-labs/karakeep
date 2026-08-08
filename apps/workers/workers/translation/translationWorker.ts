import { eq } from "drizzle-orm";
import { workerStatsCounter } from "metrics";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import type { ZTranslationRequest } from "@karakeep/shared-server";
import { db } from "@karakeep/db";
import { bookmarkLinks } from "@karakeep/db/schema";
import {
  TranslationQueue,
  zTranslationRequestSchema,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { InferenceClientFactory } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";
import { DequeuedJob, getQueueClient } from "@karakeep/shared/queueing";

import { runTranslation } from "./translate";

async function attemptMarkStatus(
  jobData: object | undefined,
  status: "success" | "failure",
) {
  if (!jobData) {
    return;
  }
  try {
    const request = zTranslationRequestSchema.parse(jobData);
    await db
      .update(bookmarkLinks)
      .set({ translationStatus: status })
      .where(eq(bookmarkLinks.id, request.bookmarkId));
  } catch (e) {
    logger.error(
      `Something went wrong when marking the translation status: ${e}`,
    );
  }
}

export class TranslationWorker {
  static async build() {
    logger.info("Starting translation worker ...");
    const worker = (await getQueueClient())!.createRunner<ZTranslationRequest>(
      TranslationQueue,
      {
        run: withWorkerTracing(
          "translationWorker.run",
          withWorkerEventLog("translationWorker.run", runTranslationJob),
        ),
        onComplete: async (job) => {
          workerStatsCounter.labels("translation", "completed").inc();
          logger.info(`[translation][${job.id}] Completed successfully`);
          await attemptMarkStatus(job.data, "success");
        },
        onError: async (job) => {
          workerStatsCounter.labels("translation", "failed").inc();
          logger.error(
            `[translation][${job.id}] translation job failed: ${job.error}\n${job.error.stack}`,
          );
          if (job.numRetriesLeft == 0) {
            workerStatsCounter.labels("translation", "failed_permanent").inc();
            await attemptMarkStatus(job?.data, "failure");
          }
        },
      },
      {
        concurrency: serverConfig.translation.numWorkers,
        pollIntervalMs: 1000,
        timeoutSecs: serverConfig.translation.jobTimeoutSec,
      },
    );

    return worker;
  }
}

async function runTranslationJob(job: DequeuedJob<ZTranslationRequest>) {
  const jobId = job.id;

  const inferenceClient = InferenceClientFactory.build();
  if (!inferenceClient) {
    logger.debug(
      `[translation][${jobId}] No inference client configured, nothing to do now`,
    );
    return;
  }

  const request = zTranslationRequestSchema.safeParse(job.data);
  if (!request.success) {
    throw new Error(
      `[translation][${jobId}] Got malformed job request: ${request.error.toString()}`,
    );
  }

  await runTranslation(request.data.bookmarkId, job, inferenceClient);
}
