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
- CI recovery: no Actions run was created for the initial PR event or reopening,
  despite the CI workflow being active. Add workflow_dispatch so the same five
  checks can be explicitly triggered on the branch without changing job logic.

## GitHub Actions execution blocker

- No Actions run/check suite was created for PR #38 or after closing/reopening it.
- `gh workflow run ci.yml --repo imanect-labs/karakeep --ref
  fix/briefing-generation-health-metric` returns HTTP 422:
  `Actions has been disabled for this repository.`
- Repository Actions permissions report enabled=true/allowed_actions=all.
  Reapplying those same settings and enabling the workflow both succeed but do
  not resolve dispatch rejection. No allowed-actions policy was broadened.
- Reading the organization's Actions policy returns HTTP 403 and requires org
  administration/Actions policy permission (the current OAuth token lacks
  admin:org). The underlying organization/account restriction is not identified.

Administrator follow-up:

1. Open https://github.com/imanect-labs/karakeep/actions and repository Actions
   settings. Inspect any disabled-workflows or account restriction notice.
2. If repository settings are already enabled, check organization Actions policy
   and any account/billing restrictions with an organization administrator.
   Keep the existing security policy; restore execution for this repository.
3. Retry the dispatch command above. Confirm an actual run appears for the PR's
   latest SHA and all five existing checks complete successfully.
4. Only then merge/build the app and add its immutable image tag to giken-ops
   PR #221. Deploy the timestamp metric before switching the monitoring rule.
5. Compare the live gauge with SQLite's latest ready generatedAt and confirm
   the alert clears. Existing briefings and feedback must remain unchanged.

The service itself is healthy; today's 05:30 JST generation was verified.
The monitoring fix has not been deployed while Actions remains unavailable.
