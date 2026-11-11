# Roadmap — the three workstreams, sequenced as one

> **Status:** plan, for review. Nothing implemented.
> This is the integration layer over three design docs. Each of those has its own sequence;
> they interact, and this resolves the interactions into one order.
>
> | Doc | Lines | What it settles |
> |---|---|---|
> | [`social-media-manager.md`](./social-media-manager.md) | 925 | The feature: audit, architecture, data model, compliance, build order |
> | [`agent-runtime.md`](./agent-runtime.md) | 540 | Whether we adopt LangGraph, and where (§8: Studio, now) |
> | [`services-api.md`](./services-api.md) | 212 | Exposing Nomila as APIs other applications call |
>
> **What was NOT documented until this file:** the *implementation* plan for Studio's agentic
> system. `agent-runtime.md` §8 settles the decision and sketches the shape; §3 below is the build.

---

## 1 · How the three interact

The dependencies are real and mostly one-directional. Drawn out, the order is almost forced:

```
  ┌── FOUNDATIONS ─ nothing depends on a decision, everything depends on these ──┐
  │                                                                              │
  │   concurrency gate ──┬─► trustworthy evals ──► every prompt change            │
  │                      └─► Studio graph fan-out                                 │
  │   advisory-lock rework ──────────────────────► anything resumable             │
  │   URL consolidation ─────────────────────────► a 2nd/3rd service              │
  └──────────────────────────────────────────────────────────────────────────────┘
                    │
   [PII decision] ──┴─► tracing ──► prompt registry ──► founder can steer
                                 └─► the Studio graph is observable from run #1
                    │
                    ├─► STUDIO: Agent Server + generation graph  ◄── job-shaped responses
                    │                    │                             (Studio already does this;
                    │                    │                              generalise, don't invent)
                    │                    ▼
                    └─► WEEKLY PLANNER: second graph, same runtime
                                         ▲
                          content_plan_item contract with Aditya
                          athlete_events (calendar research)
                          compliance Track A
```

Three interactions worth naming explicitly, because they are the ones that get missed:

1. **Tracing must precede the first graph node.** Retrofitting observability onto a distributed
   runtime is materially harder than switching it on in a monolith. Do it while there is one
   service.
2. **The advisory-lock rework gates Studio.** `withAdvisoryLock` pins a pooled connection for up
   to 25 minutes inside one request; that is incompatible with resumable execution, and Studio's
   generation path is the first thing we intend to make resumable.
3. **The URL consolidation gets harder with every service.** Adding the Agent Server is the moment
   the API conventions stop being cosmetic. Do the consolidation before, not after.

---

## 2 · Phase 0 — Foundations (start here; no decisions required)

Everything in this phase can start immediately. None of it waits on a meeting, a vendor, or a
scope call. Two items are bugs.

| # | Work | Size | Why it is in phase 0 |
|---|---|---|---|
| 0.1 | **Fix `athlete_snapshots.deals` persisting `[]`** — `researchAthlete.ts:642` writes an empty array after computing the real one; `fetchSocialData` inherits it. The correct version already exists in `refreshScores.ts:224` with a comment naming the bug. | XS | It feeds Commercial Capital, which is shown to athletes and brands. A wrong number is worse than a missing one. |
| 0.2 | **Fix the dead category filter** — `routes/deals.ts:360` filters on `raw_data.category`, which `buildDealRawData` never writes (it lives on `inbox_threads.classification`). Same cause makes `search.ts`'s `brand_domain` always null. | XS | `GET /deals?category=` can only return an empty list today. |
| 0.3 | **`server/lib/llm.ts` — the concurrency gate.** Build the design in `llm-concurrency-spec.md` (`kimiGate`/`geminiGate` semaphores + `withRetry` + `withTimeout`, composed as `callModel`). Wrap `lib/kimi.ts` and the Gemini path. | S | It is already corrupting measurements — the classifier eval carries ±2–3% recall error from Vertex 429s. Every later phase fans out more, not less. |
| 0.4 | **Limiter on the Gmail webhook fan-out** — `Promise.allSettled(messages.map(detectDeal))` is unbounded today. | XS | Same quota, no ceiling. Falls out of 0.3. |
| 0.5 | **Replace the session-scoped advisory lock** with a row-based one (`SELECT … FOR UPDATE` on a lock table, or an equivalent). | S | Prerequisite for Phase 2, and independently a liability: a 25-minute pinned connection out of a small pool. |
| 0.6 | **Consolidate the URL shapes** — one canonical `/api/v1/athletes/{id}/…` with a single ownership middleware; `/me` becomes an alias. Delete the ~15 hand-rolled `req.athleteId !== req.params.id` guards. Move the 46 inline routes out of `index.ts`. | S–M | Net *deletion* of code, and it only gets more expensive once a second service and a partner exist. |

**Parallel, owned elsewhere, not blocking:** posting scopes and the X integration (Mia); the
generation-and-publish pipeline (Aditya).

**The one decision to make during phase 0, because it gates phase 1:** where trace data lives
(§6.1).

---

## 3 · Phase 1 — Visibility (the founder-control phase)

| # | Work | Size | Notes |
|---|---|---|---|
| 1.1 | **Tracing** across the 14 model call sites | S | `lib/kimi.ts` is two lines (`wrapOpenAI`); the Gemini singleton in `lib/models.ts` is one wrap; the rest are `traceable()` around existing functions. Gated on the PII decision. |
| 1.2 | **Narrator gate tests** | S | The generate-N → deterministic gate → judge pattern has **zero** coverage — the only test touching it mocks the narrator out. We plan to reuse the gate for captions; test it before we do. |
| 1.3 | **Prompt registry** — `prompts(key, version, body, status)` + `prompt_runs` joining to the trace. Resolution: DB active → env override → in-code constant. | M | 14 prompts are module constants today. `evalClassifier.ts:119` already SHA-1 hashes `CLASSIFY_SYSTEM` to key its cache — the registry formalises what that script assumes. **Money-and-compliance prompts (classifier, scorer, contract extractor) stay review-and-version, never a live edit box.** |
| 1.4 | **Datasets + experiments** — move the classifier's labelled set off one person's laptop into a hosted dataset; wire `evalClassifier`'s precision/recall as an experiment | M | This is the loop already run by hand (261 threads, 26–37% → 69–86%). Productising it is what "the founder can steer" actually means. |
| 1.5 | **Cursor pagination convention** on list endpoints | S | Today lists silently truncate at hand-picked caps (100/50/30/20/8) with no way to fetch the rest. Invisible in the UI, a correctness bug in an API. |

**Exit criterion for phase 1:** the founder can open a real run, see the prompt that produced it,
change that prompt, and watch a metric move — without a deploy and without an engineer.

---

## 4 · Phase 2 — Studio becomes the first agentic system

This is the part that was decided but not planned. `agent-runtime.md` §8 settles *why*; this is
*how*.

### 4.1 What we are replacing, and what we are not

**Today:** `runStudioGeneration` executes inline in the HTTP request —
re-derive verdict → refuse if blocked → open job row → **consume the approval (atomic)** → claim →
router → store → record asset (draft) → close job. `video.generate` is **refused outright** by
`assertRunnableInline`, because a ten-minute Veo poll cannot hold a POST open.

**Replacing:** the execution model — inline-in-request becomes a queued, checkpointed run.

**Not replacing, and this list is load-bearing:**

- `previewGeneration` — the deterministic $0 gate. Stays a pure function called by a node.
- `consumePreview` — the atomic single-use claim on the *approval*. **The engine's exactly-once is
  about runs; ours is about money, and `createGenerationJob` inserts a fresh row per tap.** Stays
  exactly where it is, immediately before the billable step.
- `generationGuards.sql` — the Postgres triggers that refuse to publish or embed an unapproved
  asset. Belt and braces; the engine is the belt.
- `generation_jobs` — stays the **business** record (cost, lineage, approval, provenance). The
  graph's checkpoint is the **execution** record. Two records answering two questions; do not
  merge them.
- Cost logging and the router/adapter split — unchanged.

### 4.2 The graph

```
   prepare          deterministic · re-derive the verdict from the STORED brief
      ↓             (never trust a client "I previewed")
   ⏸ approveSpend   INTERRUPT — durable. Survives a restart, which is the point.
      ↓
   claim            consumePreview (OURS, atomic) + createGenerationJob
      ↓             ← the last thing before anything billable
   generate         router → vertex/openrouter. The long node. Checkpointed, so a
      ↓             ten-minute Veo poll is a resumable run, not a held-open POST.
   persist          saveBuffer/rehost → recordGeneratedAsset(approval_status='draft')
      ↓
   ⏸ approveAsset   INTERRUPT — draft → approved
      ↓
   finalize         embed / publish / close the job row
```

A campaign-level graph fans out over this one per asset. That is where the weekly planner
(Phase 3) attaches as a sibling rather than a second runtime.

### 4.3 Build order inside phase 2

| # | Work | Size |
|---|---|---|
| 2.1 | **Decide: Agent Server, not the library alone.** The library gives structure and interrupts but leaves us building the lease and reaper by hand — which is precisely what `generate.ts` is blocked on — and gives **no visual tool**. | decision |
| 2.2 | **Stand up the Agent Server** as an internal-tier service. Its own Postgres for checkpoints. Never public — our API fronts it (`services-api.md` §8). | M |
| 2.3 | **Port the image path** to the graph above, behind a flag, with the existing inline path still live. | M |
| 2.4 | **Job-shaped API response** — `POST /studio/generate` returns `202` + run id; `GET /studio/jobs/:id` already exists and becomes the status read. **Studio already polls**, so the client barely changes. | S |
| 2.5 | **Unblock video** — delete `assertRunnableInline`'s refusal once the graph makes a long run safe. This is the first *new capability* the migration buys. | S |
| 2.6 | **Propagate trace context** from the API through the Agent Server so one run is one trace across two services. | S |

### 4.4 Tests that must exist before the flag flips

The golden-snapshot pattern (`mediaKitService.golden.test.ts`) carries over for output shape. Three
new ones are specific to the execution change and are the reason to do this carefully:

1. **Double-tap spends once.** Two concurrent generate calls against one approval → one router
   call, one charge, one asset. This is what `consumePreview` guarantees today; prove the graph
   did not weaken it.
2. **Crash-and-resume spends once.** Kill the worker mid-`generate` and let the run resume → still
   one charge. This is the guarantee we are buying; test it explicitly.
3. **Unapproved cannot publish.** The Postgres guard still refuses an embed of a `draft` asset when
   the call comes from a graph node rather than an Express handler.

---

## 5 · Phase 3 — The weekly planner, as the second graph

Unchanged in shape from `social-media-manager.md` §9; what changes is that it now lands on a
runtime that already exists.

| # | Work | Size | Blocking? |
|---|---|---|---|
| 3.1 | **Agree `content_plan_item` with Aditya** — the contract between the brain and the hands. Also: name the thing once across DB/server/UI, and not "campaign" (already a Studio route). | S | Do this in phase 0 — it is a conversation, and everything downstream assumes it |
| 3.2 | **`researchSchedule` + `athlete_events`** — resolve `school` (which already holds the club/team for pros) into a searchable competitive entity, grounded search, extraction, athlete confirmation in the weekly check-in | M–L | Blocks 3.3 |
| 3.3 | **First end-to-end weekly brief** — plan tables, `deriveOccasions`, Strategist, composer. No assets, no captions. | L | — |
| 3.4 | **Compliance Track A** — the thin gate: term windows, due deliverables, competitor-of-a-confirmed-partner, exclusivity read from jsonb. Everything else reports `unknown`, honestly. | S | Ships *with* 3.3, not before |
| 3.5 | **Asset matching** via `searchMedia`, and **lift `facets` out of the deck** into a persisted athlete-level concept both consumers read | S–M | — |
| 3.6 | **Captions** — multi-model + judge, reusing the Narrator's machinery (not its deck briefs) | M | Needs 1.2 |
| 3.7 | **`content_posts` writer** + "did you post this?" | S | Closes the outcome loop; revives a dead table |
| ∥ | **Compliance Track B** — extraction upgrade, `deal_exclusivities` / `deal_obligations` | L | Runs alongside from any point; upgrades Track A in place |

---

## 6 · Decisions

### 6.1 Open — and 6.1 blocks phase 1

| # | Decision | Who | Why it matters |
|---|---|---|---|
| D1 | **Where trace data lives.** Payloads contain signed contract text, brand negotiation email, athlete PII. Options: mask at the wrapper · OpenTelemetry to our own collector in GCP · accept with a DPA. | Founder | Blocks 1.1. Note the labelled classifier set already cannot be committed for exactly this reason. |
| D2 | **Does the drawn workflow matter on its own** — i.e. is founder-legible visual workflow a real driver, or a nice-to-have? | Founder | If real, it justifies the Agent Server on its own terms rather than only on the queue. |
| D3 | **Contract re-extraction** — backfill every uploaded contract with the new fields, or extract-new-and-backfill-lazily? *(Recommendation: lazily.)* | Eng | Only bites in Track B |
| D4 | **Sports feed** — athlete-entered + researched only, or budget a paid feed? | Founder | Only bites if research coverage proves thin |

### 6.1a Known upcoming change — scoring weights

**The v7.0.0 scoring weights need optimisation and will be re-tuned.** Not now, but planned, and
it touches three things already in flight:

- **`server/skills/__fixtures__/scoringWeights.v7.json`** is a frozen copy of the active config,
  used by `emptyDealsChangesProfile.test.ts` so the test needs no database. A re-tune will not
  fail that test — every assertion is about the profile *switch* or an inequality, never a
  number — but the fixture will silently drift from the active row. Refresh it when the version
  changes; the filename carries the version so the drift is visible.
- **Every score in `athletes_current` is recomputed** on the next refresh after a weights write,
  and the rate card is derived from the score in the same pass. So a re-tune moves displayed
  scores, tiers, PAV and rate cards together. Worth a dry run (`refreshAllScores({dryRun:true})`)
  before activating a new version — it reports before/after per athlete and writes nothing.
- **`scoring_weights` is versioned with one active row**, which is the right shape for this: a
  re-tune is a new row promoted to `active`, and rolling back is promoting the old one. Keep it
  that way rather than editing the active config in place, so a bad tune is reversible without
  a deploy.

Related, and worth deciding at the same time: the cold-start profiles are selected by presence
tests (`hasSocial`, `hasResearch`, `hasDeals`) that treat "we have no data" and "there is none"
as the same input. Commit `875014b` fixed the case where that was caused by a persistence bug;
the underlying conflation is still there and is a scoring-design question, not a bug.

### 6.2 Settled

- **Publishing:** plan-and-remind for v1; scopes + X owned by Mia, generation/scheduling/publishing by Aditya. Plan for **four** platforms regardless of what is connected.
- **Architecture of the planner:** a deterministic pipeline with two model calls, not a seven-node graph. Compliance is deterministic code, never a model.
- **The existing agents:** extend the substrate (`getAthleteContext`, `searchMedia`, the Narrator's gate/pool/judge), write a new top half. Do not bend `deriveDeckPlan`/`assembleMediaKit`/the renderers to serve two content types.
- **The deal pipeline:** not converting. It is a decision tree; conversion buys observability we can get for a twentieth of the cost.
- **LangGraph:** yes, for Studio, now — Agent Server, not the library alone. Second graph is the planner.
- **The Agent Server is internal.** Partners talk to our API; LangGraph stays an implementation detail we can replace.

---

## 7 · Start here

**One PR, this week: `0.1 + 0.2 + 0.3 + 0.4`.**

Two bug fixes, the concurrency gate, and the webhook limiter. Reasons, in order:

1. **No decision required from anyone.** Every other track waits on D1, on a conversation with
   Aditya, or on a vendor.
2. **0.1 is a live correctness bug** in a number shown to athletes and brands, and the fix already
   exists in a sibling file with a comment naming the failure.
3. **0.3 is a prerequisite for measuring anything.** The classifier eval currently carries ±2–3%
   recall error from Vertex 429s — so today we cannot fully trust the one metric we have. Every
   later phase fans out more concurrent model calls, not fewer.
4. It is small enough to land and prove the loop before anything architectural starts.

**Immediately after, in parallel:**
- **D1** (the founder call) so tracing can start.
- **3.1** — the half-hour conversation with Aditya about `content_plan_item`. It costs nothing now
  and constrains everything later.
- **0.5 + 0.6** — the advisory lock and the URL consolidation, both of which get more expensive the
  moment a second service exists.

**Then 1.1 (tracing), and only then Phase 2.** The order is not arbitrary: we want the Studio graph
observable from its first run, not instrumented afterwards.
