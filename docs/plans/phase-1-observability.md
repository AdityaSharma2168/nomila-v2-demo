# Phase 1 — observability, and the decision behind it

> **Status:** plan, for review. Nothing implemented.
> Sequenced in [`00-roadmap.md`](./00-roadmap.md) §3. Phase 0 is complete (`ae65bff`…`ab7579b`).

---

## 1 · The decision

**Langfuse, cloud free tier, full payloads, no masking. Self-host when we go live.**

Three options were weighed properly and two were rejected for reasons worth recording, because
both looked right at some point.

### Rejected — masking at the wrapper

Would have traced timing, models, tokens, cost, errors and a prompt hash while never sending
payload text. It closes the operational gap — it would have caught the Vertex 429s distorting the
classifier eval — and forfeits the rest: no reading a bad output, no prompt playground, and **no
datasets built from production runs**, which is the workflow that would replace hand-labelling 261
threads. Phase 1 exists to give a non-engineer a lever; masking delivers a dashboard.

### Rejected — GCP-native (Cloud Trace + BigQuery + Vertex Gen AI Evaluation)

The strongest contender, and genuinely close. Vertex logs request and response bodies straight to
a BigQuery table we own, Cloud Trace reads OpenTelemetry GenAI spans, and Vertex has prompt
templates with versioning plus an evaluation service for datasets and experiments. Nothing leaves
the project, and our GCP credits pay for it.

**It fails on one requirement: we run five providers and Vertex logging sees two.**

| Provider | Where | Covered by Vertex logging |
|---|---|---|
| Gemini via `@google/genai` | 10 files | yes |
| Kimi MaaS via `getVertexClient` | `lib/kimi.ts` | yes |
| Kimi via Moonshot direct | `kimiSearch`, research pipeline | **no** |
| Anthropic | `narrator.ts` (Fable), `socialWebResolver.ts` (Haiku) | **no** |
| OpenRouter | `studio/adapters/openrouter.ts` — Seedream, Seedance, Kling | **no** |

Two of those gaps are disqualifying rather than inconvenient:

- **The Narrator is a deliberate multi-provider bake-off** — Gemini Pro, Kimi and Fable run in
  parallel and a judge ranks them. Vertex-only logging shows two candidates of three, so the one
  question the pattern exists to answer — which model wrote the line the judge picked — is
  unanswerable. Half a bake-off is worse than none.
- **Studio generates through OpenRouter**, and Studio is the phase-2 priority. The surface we are
  about to build an agentic system around would be invisible.

Choosing it would mean instrumenting twice — Vertex logging for one half, manual OTel for the
other — and stitching two UIs to read one run.

### Chosen — Langfuse

Not for its UI. **Because it is provider-agnostic by construction**: OTel-native, so one
instrumentation covers all five and one trace shows a whole Narrator bake-off or a whole Studio
generation regardless of who served it. It also carries the rest of phase 1 in the same product —
prompt management with versioning, datasets, experiments, LLM-as-judge scoring — under an
MIT-licensed core.

**Payloads go to a third party until we self-host.** That is a real, accepted exposure: 471 inbox
message bodies, 3,724 chat turns, and contract text once uploads resume. The mitigation is
sequencing, not masking — self-hosting is the same SDK and the same instrumentation, so the move
is configuration rather than rework.

**Verified, not assumed:** Langfuse TS SDK v5.11 ships a CJS build alongside ESM and declares
`node >= 20`. Our Dockerfile and CI pin Node 20 while local development runs 22 — the exact split
that would have made `p-limit` work everywhere except production. This one is safe.

### Not now — self-hosting

Six containers (web, worker, Postgres, **ClickHouse**, Redis, blob storage), around 4 cores and
16 GiB recommended. On GCP three fall away — Cloud SQL for Postgres, GCS for blobs, Memorystore
for Redis — leaving web, worker and ClickHouse, roughly one always-on VM. ClickHouse is the
always-on part; it is a database and cannot scale to zero.

Current volume is **2.4 inbox messages/day and 76 chat turns/day** — low hundreds of model calls a
day. Standing up an analytics stack sized for millions of traces to observe that would be theatre.
Revisit at launch, when trace volume is a measurement rather than a guess.

---

## 2 · Where it plugs in

The same chokepoints the concurrency gates already use. Four wrap points, five providers.

| # | Wrap point | Mechanism | Covers |
|---|---|---|---|
| 1 | `lib/kimi.ts` — both clients | `@langfuse/openai` wrapper | score, summarize, group, contract extraction, the narrator's Kimi, **and** Moonshot `kimiSearch` — both clients go through the `openai` SDK |
| 2 | `lib/models.ts` — the `genai()` singleton | Proxy + manual span | all 10 Gemini files, including `dealDetector`'s classify |
| 3 | `narrator.ts` + `socialWebResolver.ts` | `observeAnthropic()` — Proxy + manual span, in `lib/tracing.ts` | Anthropic — Fable and Haiku |
| 4 | `studio/router.ts` — the `adapter.generate` call | `traceGeneration()` | Seedream, Seedance, Kling **and Vertex** |

Three of those four differ from what this table said when it was written, and each difference was
forced by something real:

- **Wrap point 2 is a Proxy, not `GoogleGenAIInstrumentor`.** No such first-party JS instrumentor
  exists; the nearest third-party package targets `@google-cloud/vertexai`, a different library.
- **Wrap point 3 lives in `lib/tracing.ts`, not beside its callers**, because two clients need it,
  and Langfuse ships no Anthropic wrapper for JS — `@langfuse/openai` is OpenAI-only.
- **Wrap point 4 moved up to the router.** At the adapter it would have missed Vertex, which serves
  most video; at the provider's `fetch` it would have been worse than useless, because
  `generateVideo` polls a job to completion and one generation would arrive as dozens of identical
  poll spans.

`lib/models.ts` is the right home for the OTel span processor for the same reason it owns model
ids: one file, env-flippable, no call-site changes.

**A trace should answer a question we cannot answer today.** Two worth designing for:

- *"Why did this message classify as NOISE?"* — one trace: the pre-filter verdict, the classify
  call with its prompt and response, the confidence, the gate decision.
- *"Which model wrote this tagline?"* — one trace: three parallel generations, the gate's
  rejections, the judge's ranking, the pick.

The second is only possible because the tracing is provider-agnostic.

---

## 3 · Order

| # | Step | Size | Notes |
|---|---|---|---|
| 1.0 | **Account and keys** — create the Langfuse project; put `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in Secret Manager, then add them to `setup-dev-env.sh` and `cloud-run-v2.yaml` | S | **Blocked on the founder** — I cannot create the account |
| 1.1 | ✅ **Wrap points 1 and 2**, behind a flag, default off | S | Gemini plus both Kimi paths — the large majority of calls. Verified live: a real Gemini call landed with model, prompt, completion, token counts and system instruction |
| 1.2 | ✅ **Trace roots, then wrap points 3 and 4** | S | Roots first — see §4; without them the Kimi spans from 1.1 were being dropped. Then Anthropic and Studio, which completes the Narrator trace |
| 1.3 | ✅ **Narrator gate tests** | S | 14 tests. `applyGate` direct (it is pure); pool and judge through `narrateKit`, so the ORDER — gate, then pool, then judge — is what is actually pinned. **For captions:** `buildUserPrompt` reads `signalHighlights` and `brandFitTags` unguarded, so a leaner context throws during prompt construction |
| 1.4 | **Prompt registry** — `prompts` and `prompt_runs`; resolution order DB → env → in-code constant | M | 14 module-level constants today. `evalClassifier.ts:119` already SHA-1 hashes `CLASSIFY_SYSTEM` for its cache key, so the versioning idea is already assumed. Money-and-compliance prompts — classifier, scorer, contract extractor — stay review-and-version, never a live edit box |
| 1.5 | **Datasets and experiments** — move the classifier's labelled set off one laptop; wire `evalClassifier`'s precision and recall as an experiment | M | The loop already run by hand: 261 threads, 26–37% → 69–86% |
| 1.6 | **Cursor pagination** on list endpoints | S | Lists silently truncate at hand-picked caps today |

**Feature-flagged and default-off, following the house pattern** (`MILA_WEB_SEARCH`,
`STUDIO_ENABLED`): tracing that cannot be switched off during an incident is a liability, and the
kill switch should be a Cloud Run env flip rather than a deploy.

**Exit criterion:** the founder opens a real run, sees the prompt behind it, changes that prompt,
and watches a metric move — without a deploy and without an engineer.

---

## 4 · Trace roots — the rule, learned the hard way

**A span with no parent is not reliably a trace.** Verified against the live project: an
`observeOpenAI` span emitted outside any active observation exports without error and Langfuse v4
then drops it. Nothing fails; the data is simply never there. Every Kimi call in the codebase was
invisible for exactly this reason, and it went unnoticed because the Gemini path self-roots via
`startObservation` and looked fine.

So the rule: **every unit of work gets a root**, via `traceUnit()`.

| Root | Unit | Why |
|---|---|---|
| `detectDeal` | one inbound message | Required — classify/summarize/score are `observeOpenAI` spans and vanish without it |
| `narrateKit` | one kit's copy | Not required for survival; required for MEANING — a bake-off split across three traces cannot say which model wrote a line |

The distinction is worth keeping straight: hand-rolled spans (Gemini, Anthropic, Studio) self-root
and survive alone. Only the `observeOpenAI` path depends on an ancestor. Rooting the rest buys
grouping, not visibility.

`detectDeal` is wrapped by splitting the body into `detectDealInner`, because the function has two
dozen early returns and wrapping the call traces all of them without editing one.

---

## 5 · Two things to watch

- **Sampling.** Trace volume is billed, and the obvious economy — keep a fraction — throws away
  failures, which are rare and are the whole point. Sample successes; keep every error, refusal
  and retry.
- **The gates and the tracer wrap the same calls.** Order matters: the span must cover the model
  call and not the wait for a slot, or every queued burst reads as latency. Same reasoning that
  put `kimiGate.run()` inside `withTimeout` rather than around it. **Checked, and it is correct by
  construction:** the gate is `kimiGate.run(() => client.…create(…))`, so the slot is granted
  before the traced method is ever entered and the span cannot include the queue wait. Worth
  re-checking if anyone moves a gate.
