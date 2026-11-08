# Explain explicit topics in the displayed selection reason

- Date: 2026-11-09 JST
- Production verification confirmed topic contributions on all 50 selected
  articles and preserved 13,775 historical Briefing impression snapshots.
  The owner-scoped getBriefing response still omitted the explicit-topic reason.
- Cause: the API has its own contribution label dictionary, separate from the
  worker-side explainScore helper updated by PR #36.
- Add the explicitTopics label to that dictionary. Leave ranking and historical
  features unchanged; the existing API projects stored contributions into text.
- Add a router regression test for the displayed reason, including the filtering
  of shadow scores and rank from the explanation.
- Validate targeted router tests and all required precommit/CI checks. Deploy the
  resulting image, then repeat the owner-scoped production API assertion.
