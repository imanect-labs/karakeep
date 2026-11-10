import { prometheus } from "@hono/prometheus";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { eq, max } from "drizzle-orm";
import { db } from "@karakeep/db";
import { recBriefings } from "@karakeep/db/schema";

export const registry = new Registry();

export const { printMetrics } = prometheus({
  registry: registry,
  prefix: "karakeep_",
  collectDefaultMetrics: true,
});

export const workerStatsCounter = new Counter({
  name: "karakeep_worker_stats",
  help: "Stats for each worker",
  labelNames: ["worker_name", "status"],
});

export const crawlerStatusCodeCounter = new Counter({
  name: "karakeep_crawler_status_codes_total",
  help: "HTTP status codes encountered during crawling",
  labelNames: ["status_code", "proxy"],
});

export const bookmarkCrawlLatencyHistogram = new Histogram({
  name: "karakeep_bookmark_crawl_latency_seconds",
  help: "Latency from bookmark creation to crawl completion (excludes recrawls and imports)",
  buckets: [
    0.1, 0.25, 0.5, 1, 2.5, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300,
    600, 900, 1200,
  ],
});

// Briefing recommender (imanect-labs fork).
export const recommenderCandidatesCounter = new Counter({
  name: "karakeep_recommender_candidates_total",
  help: "Candidates entering the recommender pool, by outcome",
  labelNames: ["outcome"],
});

export const recommenderSourceFailuresCounter = new Counter({
  name: "karakeep_recommender_source_failures_total",
  help: "Source fetches that failed during collection",
});

export const recommenderBriefingsCounter = new Counter({
  name: "karakeep_recommender_briefings_total",
  help: "Briefings generated, by model version",
  labelNames: ["model_version"],
});

// Read persistent completion state on every scrape. A process counter cannot
// distinguish its first observed value of 1 from a baseline after restart.
export const recommenderLastBriefingTimestamp = new Gauge({
  name: "karakeep_recommender_last_briefing_timestamp_seconds",
  help: "Latest ready Briefing generation time from the database, or zero if none exists",
  async collect() {
    const [row] = await db
      .select({ generatedAt: max(recBriefings.generatedAt) })
      .from(recBriefings)
      .where(eq(recBriefings.status, "ready"));
    this.set(row.generatedAt ? row.generatedAt.getTime() / 1000 : 0);
  },
});

export const recommenderDomainsCounter = new Counter({
  name: "karakeep_recommender_domains_total",
  help: "Domain lifecycle transitions in the recommender",
  labelNames: ["transition"],
});

export const recommenderEmbeddingsCounter = new Counter({
  name: "karakeep_recommender_embeddings_total",
  help: "Candidate embeddings generated, by outcome",
  labelNames: ["outcome"],
});

export const recommenderDigestsCounter = new Counter({
  name: "karakeep_recommender_digests_total",
  help: "Japanese briefing digests generated, by outcome",
  labelNames: ["outcome"],
});

registry.registerMetric(workerStatsCounter);
registry.registerMetric(recommenderCandidatesCounter);
registry.registerMetric(recommenderSourceFailuresCounter);
registry.registerMetric(recommenderBriefingsCounter);
registry.registerMetric(recommenderLastBriefingTimestamp);
registry.registerMetric(recommenderDomainsCounter);
registry.registerMetric(recommenderEmbeddingsCounter);
registry.registerMetric(recommenderDigestsCounter);
registry.registerMetric(crawlerStatusCodeCounter);
registry.registerMetric(bookmarkCrawlLatencyHistogram);
