# Explicit interests and infrastructure / low-level supply

- Date: 2026-11-09 JST
- Branch: feat/explicit-interest-recommendations
- Trigger: infrastructure and low-level articles were rare in Briefing.

## Findings

A read-only audit of the requesting user's current production data found 190
sources (34 disabled). LWN, Kubernetes, Cloudflare, Chips and Cheese and Grafana
were enabled and fetching successfully; several individual systems blogs had
no recent candidates. A title/summary keyword check found 167 active, embedded,
nonduplicate candidates matching infrastructure/low-level terms. This is an
approximate audit, not a semantic relevance metric. The newest 50-item briefing
contained four matches. Existing positive feedback was concentrated elsewhere.
The explicitTopics storage column existed but was unused by ranking and the UI.

## Change

- Add an owner-scoped, bounded explicit-topics setting to the interest panel.
  Empty topics clear the preference; changes apply to the next generated set.
- Embed each topic separately with the configured article embedding client and
  dimensions. Add 1.5 times the best nonnegative compatible cosine similarity.
  Do not merge these vectors into behavioral centroids or synthesize events.
- Log the extra contribution and distinguish the policy as
  `heuristic-v1+explicit-topics`. Keep the original eight contributions and rank
  as the unchanged heuristic-v1 pairwise feature schema. Shadow predictions still
  evaluate those behavioral features, independently of the fixed manual prior.
  Include effective topic vectors in the profile hash.
- Topic embedding failure falls back to behavioral scoring. Skip incompatible
  model IDs/dimensions. Users with no topics make no extra embedding calls.
- Add Phoronix, Collabora, Tailscale and Fly.io as general seed sources. They
  inherit existing collection budgets and URL deduplication; no source gets
  artificial positive feedback or guaranteed ranking seats.

## Verification

- Recommender: 321 tests; workers: 134 tests; recommender router: 9 tests.
- Full preflight: all 67 tasks passed before the final worker-test addition;
  the commit hook repeats required checks on the final tree.
- All four feeds returned HTTP 200 and ten parseable articles using rssAdapter
  on 2026-11-09. Python XML parsing alone was not used as acceptance evidence.
- A read-only calculation on 150 previously logged production candidates with
  the actual 768-dimensional embedding model moved systems articles upward.
  This is a counterfactual sample, not evidence of improved user satisfaction.
- Production rollout, setting the requesting user's topics, seed synchronization
  and verifying the resulting new briefing remain deployment steps. Preserve
  existing observed sets and their immutable feature/feedback history.
