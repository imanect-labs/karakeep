# Persistent Briefing generation health

- Production incident: KarakeepRecommenderNoBriefing fired despite both users'
  ready 50-item briefings being generated at 2026-11-10 05:30 JST. Workers were
  enabled and healthy, with no restarts since the previous deployment.
- Both model-version counter series first appeared with value 1. Prometheus
  increase over 36h returned 0 because the initial increment was not observed.
- Export the latest ready Briefing generatedAt from SQLite as epoch seconds on
  each scrape. Retain the process counter for throughput, not freshness alerts.
- Failed/generating rows do not advance health. No completed rows exports zero;
  database failures fail the scrape instead of exporting a fabricated fresh time.
- Regression tests cover persisted state without counter increments, repeated
  scrapes reflecting DB updates, ignoring incomplete sets and an empty history.
- Deployment follow-up: switch monitoring to time() minus this gauge after the
  image is deployed, verify the latest DB generation time and resolved alert.
  Do not regenerate existing briefings or synthesize increments for recovery.
