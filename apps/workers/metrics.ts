import { prometheus } from "@hono/prometheus";
import { Counter, Histogram, Registry } from "prom-client";

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

export const recommenderEmbeddingsCounter = new Counter({
  name: "karakeep_recommender_embeddings_total",
  help: "Candidate embeddings generated, by outcome",
  labelNames: ["outcome"],
});

registry.registerMetric(workerStatsCounter);
registry.registerMetric(recommenderCandidatesCounter);
registry.registerMetric(recommenderSourceFailuresCounter);
registry.registerMetric(recommenderEmbeddingsCounter);
registry.registerMetric(crawlerStatusCodeCounter);
registry.registerMetric(bookmarkCrawlLatencyHistogram);
