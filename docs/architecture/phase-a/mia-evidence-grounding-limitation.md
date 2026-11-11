# M.I.A. evidence grounding: a limitation of the evaluator spec

**Status: FOR ITS OWN DESIGN REVIEW.** This note records a limitation and proposes no change. The evaluator spec, prompt and digest are frozen. Changing any of them means a new validation run (ADR-017), which is a decision of its own, separate from #706.

## In plain words

M.I.A. researches an athlete with Google Search and returns a list of sources, each with a claim and a URL, that its scores rely on. Google separately reports what it actually retrieved. That report ties retrieved pages only to M.I.A.'s *written summary*. It never ties them to the source list M.I.A. scores from.

So the provider's own metadata cannot show which retrieved page stands behind which cited source. The strongest honest statement available is "a page from that **site** was retrieved". A URL on a site that nothing was retrieved from was written by the model and not retrieved.

#706 records this per citation (`lineage`) and makes sure no reader treats a site-only match as a directly retrieved source. It cannot remove the limitation, because the limitation comes from how the evaluator is asked to answer.

## What happens underneath

- The evaluator (`server/services/marketabilityBeta1Evaluator.ts`) runs Gemini under `googleSearch` grounding. It answers in prose plus one fenced JSON document containing `evidence[]` (id, claim, `source_url`, `source_type`) and 44 signals that cite `evidence_ids`.
- The run stores `raw.native`:
  - `groundingChunks`: each is a `vertexaisearch.cloud.google.com/grounding-api-redirect/…` URI plus `web.domain` and `web.title`. There is no final URL.
  - `groundingSupports`: answer spans, as index ranges into `raw.text`, mapped to chunk indices.
  - `webSearchQueries`.
- The supports annotate the prose. None of them covers the JSON `evidence[]` entries. This means:
  1. The research path's deterministic binder (`directLineage.bindGeminiFinding`) can never bind an evidence claim to a chunk. `native_supported` is structurally unreachable for M.I.A.'s scored citations.
  2. Chunk URIs are redirects, so a cited URL can only be compared by domain. That is `native_retrieved`, `match: "domain"`, shown as "weaker lineage: site retrieved, page unproven".

## The case: Mia, run `c26f7c1a…` (29 Sep 2026, dev)

This is the evaluation run behind the only unsuperseded marketability ASSESSMENT for Mia (ledger row `2928bc56…`).

| | Count |
|---|---|
| Grounding chunks | 7 (all redirect URIs; domains: gostanford.com, unionprogress.com, stanford.edu, trailblazehersinsports.org, lebomag.com, hercollegenetworth.com, businessofcollegesports.com) |
| Grounding supports | 16, all inside the prose (the highest end index is 23372 in a 25809-character response). None covers an `evidence[]` claim |
| Web search queries | 7 |
| Cited evidence items | 6 (5 web, 1 Nomila social block) |

| Cited | URL domain | Retrieved chunk from that domain? | Lineage (#706 rules) |
|---|---|---|---|
| E1 official | gostanford.com | yes (chunk 0); page unproven | site only (weaker lineage) |
| E2 secondary | en.wikipedia.org | **no** | asserted_only |
| E3 major_media | girlssoccernetwork.com | **no** | asserted_only |
| E4 major_media | lebomag.com | yes (chunk 4); page unproven | site only (weaker lineage) |
| E5 secondary | trailblazehersinsports.org | yes (chunk 3); page unproven | site only (weaker lineage) |
| E6 platform | `platform_discovery` (not a URL) | n/a | nomila_supplied: restates 21,925 / 15,481 / 16,019 / 7.12% / 73.06% from the snapshot's social block |

Result: 0 of 5 web citations can be grounded. 3 match by site only, and 2 were not retrieved at all. E2 and E3 carry weight in her assessment: signals cite them 11 and 7 times, and E2 appears in 4 of the 8 findings. Four chunks were retrieved but never cited: unionprogress, stanford.edu, hercollegenetworth, businessofcollegesports.

Not established: whether the Wikipedia and GSN pages exist or say what is claimed (no network calls were made). Whether earlier runs show the same pattern is also open; the first run, `db103a49`, has 0 grounding chunks.

## Questions for the design review

1. Should the evaluator be asked for evidence in a form the supports can cover? For example, each evidence claim could also be stated once in the prose, so the existing binder can tie it to a chunk. This changes the prompt and needs a new validation run.
2. Should a cited source with no retrieved domain (`asserted_only`) affect the signals that cite it? Today #706 only labels it, and the score is unchanged.
3. Is resolving redirect URIs to final URLs at run time (one fetch per chunk) worth the cost and the retention questions? It would turn "site only" into a page-level match.
4. What should the Concept 0.4 evidence UI say to the athlete for a site-only source?
