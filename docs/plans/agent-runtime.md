# Agent runtime — do we adopt LangGraph and Studio?

> **Status:** decision doc, for review. Nothing implemented.
> Written in answer to: *"I am concerned we don't have an agentic system, and I want
> LangGraph Studio — it should be able to read our codebase, create the workflow, and give
> us a visual way to edit the workflow and prompts."*
>
> **Revised** after the stated goal became clearer: *giving control to a non-technical founder*,
> and better visibility into prompts and workflow — across Opportunities and Studio, both of
> which are workflow-heavy and should be agentic.
>
> The concern is right. One part of the expectation is not achievable — by LangGraph or by
> anything else. But the *goal* is achievable, and most of it does not need LangGraph at all.
> **Sequenced with the other two workstreams in [`00-roadmap.md`](./00-roadmap.md); Studio's implementation plan is §4 there.**

---

## 1 · The correction, first

**LangGraph Studio does not read a codebase and create a workflow from it.** It attaches to an
application *already written in LangGraph*. The `langgraph.json` that Studio requires has a
mandatory `graphs` key, and its value must resolve to **an instance of `CompiledStateGraph` /
`StateGraph`** — a graph object that already exists in your code:

```json
{ "dependencies": ["."], "graphs": { "agent": "./src/agent.ts:agent" }, "env": ".env" }
```

So the sequence is the reverse of the hoped-for one. You do not point Studio at
`server/mila/loop.ts` and get a graph. You rewrite `loop.ts` as a `StateGraph`, and *then*
Studio can draw it, run it, step through it and replay it.

**The Assistant Editor edits configuration, not structure.** LangChain's own framing: assistants
are *"instances of a graph with specific configurations that allow you to make rapid changes to
agent behavior **without altering the underlying graph logic**."* You can swap a prompt or a
model in the UI **only for fields the graph's author explicitly exposed** in a config/context
schema (a field marked `langgraph_type: "prompt"` gets prompt-shaped treatment in the UI).

That is a genuinely useful feature. It is not "a visual way to add to our workflow." Adding a
node is a code change, in every version of this product.

**None of this is a knock on LangGraph.** No tool on the market reads an arbitrary Express
codebase and derives an agent graph from it. If that capability existed, it would be the
headline feature of every agent framework. It's worth being precise about, because the
migration's cost lands entirely on our side of that line.

**One correction to an earlier draft of this doc.** I implied Studio was a local developer tool
requiring a dev server. That was too narrow: Studio connects to graphs **deployed to cloud or
self-hosted**, as well as locally, so a founder could open it in a browser against production.
The prerequisite that matters is unchanged — the thing it opens must be a LangGraph graph.

---

## 2 · The concern underneath it is correct

Separately from Studio: **we do not have an agentic system.** The audit in
`social-media-manager.md` §4 found exactly what that concern suspects.

- **No framework, no graph, no registry.** `server/mila/loop.ts` is a hand-rolled ReAct loop —
  eight iterations, a flat array of twelve tools, all policy living in one system prompt. No
  sub-agent, no handoff, no supervisor.
- **The "agentic team" is concrete function calls.** The deck pipeline's Strategist is a
  hardcoded array with two branches; the assembler imports Curator and Narrator directly. The
  **capability router** the roadmap promised as the pluggable seam was never built.
- **No observability at all.** Fourteen production model call sites across three SDKs, and not
  one trace. When a deck reads badly or a classification is wrong, there is no run to open.
- **No schema-validated model output anywhere.** Every JSON call is loose JSON mode plus
  defensive `JSON.parse`. Zod is used for tool *arguments* only.
- **No concurrency control.** `docs/llm-concurrency-spec.md` is still marked *proposal (not
  implemented)*.
- **Almost no evals.** Eleven golden rows for Mila; the Narrator's quality gate has **zero**
  test coverage because the one test touching that pipeline mocks it out.

So the instinct is sound. The question is only which of those gaps LangGraph actually closes.

---

## 3 · What "control for a non-technical founder" actually decomposes into

This is the real requirement, so it deserves to be taken apart precisely. There are five
distinct capabilities hiding inside it, and **four of the five need only tracing — not
LangGraph.**

| # | What the founder wants to do | What it needs | LangGraph required? |
|---|---|---|---|
| 1 | **See what happened** on a real run — inputs, outputs, which model, latency, cost, failures | LangSmith tracing (or OTel) around existing calls | **No** |
| 2 | **Judge outputs and label examples** — "this was a deal", "this reply is wrong" | LangSmith annotation queues → datasets | **No** |
| 3 | **Compare prompt variants against a metric** — does v2 actually beat v1 | LangSmith experiments over a dataset, from the web UI | **No** |
| 4 | **Change a prompt in production** without a deploy | Prompt hub pull at runtime, or our own registry | **No** |
| 5 | **See the workflow drawn, and tweak node config** | Studio | **Yes** |

Only the last row buys the rewrite. The first four run against the code we have today.

**And we have proof the first three are the ones that matter here**, because we already did
them by hand — painfully — for the deal classifier. `docs/plans/deal-classifier-precision.md`
records the exact loop:

- **261 real production threads**, hand-labelled by one person for consistency
- precision and recall measured before and after a prompt rewrite
- **v1: 26–37% precision. v2: 69–86%.** Two to three times better, either way you count it
- a harness (`server/scripts/evalClassifier.ts`) that hashes the prompt for cache-keying,
  enforces `EVAL_MIN_PRECISION` / `EVAL_MIN_RECALL`, and exits non-zero to gate CI

That is a dataset, an experiment, and a versioned prompt — built by hand, in scripts. It is
exactly the shape LangSmith productises, and it is the single strongest argument for adopting
**LangSmith** here. Three details from that same doc make the case sharper:

- ***"real content lives in scratchpad, not committed — PII."*** The labelled set **cannot live
  in the repo**, so today it effectively lives on one person's machine. A hosted dataset solves
  that — and is also exactly where the privacy question in §4 bites hardest.
- ***"Vertex 429 rate-limits caused a handful of failed calls per run (default → NOISE), so
  exact recall carries ±2–3%."*** The missing concurrency gate is already corrupting our
  measurements. That is stage 1 work regardless of any framework.
- ***"This class needs a deterministic mechanism, not more prompt text."*** The residual false
  positives (mass creator-PR blasts) oscillate under prompt tuning. A useful counterweight to
  giving anyone a prompt box: **some problems are not prompt problems**, and a good tool should
  make that visible rather than invite more prompt edits.

**One more fact that cuts in favour of buying rather than building.** There is effectively no
admin surface today: `admin/index.html` is a single 291-line page and `server/routes/admin.ts`
exposes three routes (`/me`, `/waitlist`, promote-athlete). A founder has **zero levers** right
now. So "just build our own console" is greenfield product work competing with the roadmap —
which makes LangSmith's out-of-the-box UI more attractive than I implied in the first draft.

## 4 · Capabilities 1–3 — observability, in days, without touching the architecture

LangSmith traces non-LangChain code: a `traceable()` wrapper, a `wrapOpenAI()` client wrapper,
or plain OpenTelemetry. We are unusually well set up for this because the model calls already
funnel through a small number of chokepoints:

| Chokepoint | SDK | Instrumentation |
|---|---|---|
| `server/lib/kimi.ts` | `openai` (pointed at Vertex MaaS / Moonshot) | **`wrapOpenAI()` on the two clients — literally two lines** |
| `server/lib/models.ts` → `genai()` | `@google/genai` | wrap the shared singleton once |
| `server/mila/gemini.ts` `streamMilaModel` | `@google/genai` | `traceable()` around the loop turn |
| `server/services/narrator.ts` | Anthropic + Gemini + Kimi | one `traceable()` per generation, plus the judge |
| `server/lib/socialWebResolver.ts` | Anthropic | `traceable()` |
| `server/studio/router.ts` + adapters | HTTP | already has a cost log — emit a span alongside |

Fourteen production call sites, three SDKs, one shared client each. This is a small, contained
piece of work that would immediately answer questions we currently cannot answer at all: why did
this deck's copy come out flat, which model actually served this turn, what did the classifier
see, where is the latency in a 105-second kit rebuild.

**One thing to decide before doing it.** Tracing ships prompt and response payloads to a third
party, and ours contain **signed contract text, brand negotiation email, and athlete PII**. That
is a governance decision, not a technical one. Three options, in order of cost: mask or redact at
the wrapper for the contract and inbox paths; use OpenTelemetry pointed at our own collector so
the data stays in GCP; or accept it with a DPA in place. **Do not turn on blanket tracing over
`contractExtract` and `dealDetector` without making that call deliberately.**

---

## 5 · Capability 4 — prompts as data, not constants

Today **fourteen** prompts live as module-level string constants — `dealDetector.ts`'s
`CLASSIFY_SYSTEM` and `SCORE_SYSTEM`, `threadSummarizer.ts`'s `SYSTEM`, `contractExtract.ts`'s
`SYSTEM`, `narrator.ts`, `shotList.ts`, `visionTag.ts`, `brandImage.ts`, both research skills,
`brandNarration.ts`, `conversations.ts`, `chat.ts`, and `mila/prompt.ts`'s `buildSystemPrompt`.
Changing any of them is a deploy.

**We already treat one of them as a versioned artifact.** `server/scripts/evalClassifier.ts:119`
hashes `CLASSIFY_SYSTEM` with SHA-1 and uses the digest as the eval cache key — i.e. the harness
already understands "a prompt has a version and results belong to that version." A registry
formalises what that script assumes.

**We already solved this exact problem for models.** `lib/models.ts` exists precisely so *"a bad
model rollout is a config flip (Cloud Run env), not a redeploy — and any single model can be
rolled back independently."* Prompts deserve the same treatment, and doing it our way is both
cheaper and more idiomatic than routing prompts through a third-party hub at runtime:

```
prompts            key · version · body · status(draft|active) · created_by · created_at
prompt_runs        which version served which run   ← joins to the trace
```

Resolution order: DB active version → env override → the in-code constant as the last-resort
default. Nothing breaks if the table is empty, which is the same posture `lib/models.ts` takes.

**Two guardrails, and they are not optional.**

1. **Not every prompt should be hot-editable.** `contractExtract`'s system prompt is the one that
   decides whether an exclusivity clause is read as `null` or `false` — the distinction its own
   header calls out as *"the safe-looking answer being the dangerous one."* Prompts that gate
   money or compliance get review-and-version, never a live edit box.
2. **A prompt change needs a test to change against.** We would be handing people a lever with no
   feedback. That is why evals belong in the same piece of work, and why the Narrator's untested
   gate is the first thing to cover.

**Build or buy?** LangSmith's prompt hub is the hosted alternative: the app calls
`pullPrompt()` at runtime, backed by an in-memory LRU cache (default TTL ~300s) so it is not a
network round-trip per inference, and a tag move propagates to running instances in roughly five
minutes. That is genuinely workable — and it is also a **runtime dependency on a third party in
the hot path of deal classification**, with a five-minute window where instances disagree about
which prompt is live.

My lean: **our own table for the prompts that gate money or compliance** (classifier, scorer,
contract extractor — the ones where a bad edit costs a real deal), and the hosted hub is fine for
copy-shaped prompts (narrator, vision tagging) if the founder prefers one place. Either way the
same two guardrails above apply, and either way this is small work.

---

## 6 · Capability 5 — should we adopt LangGraph?

**Not as the first move. Genuinely on the table as the third.**

**What it would really give us**, and these are real: durable checkpointing so a long run
resumes instead of restarting; first-class `interrupt()` for human-in-the-loop, which is exactly
the shape of the weekly plan's approve/dismiss step; time-travel replay; and a drawn graph that
makes the system legible to people who don't read TypeScript. That last one is worth more than
engineers usually admit.

**What it would really cost us:**

- **A rewrite before any benefit.** Studio shows nothing until a pipeline is a `StateGraph`.
  Mila's loop is the obvious first candidate and it is load-bearing, with tenancy injection,
  per-tool timeouts, error containment and SSE streaming all currently hand-managed.
- **A second runtime.** Studio and the platform run a LangGraph API server (`langgraphjs dev`
  locally, a container in production). Today we are one Express service on Cloud Run,
  `minScale 1 / maxScale 3`, with DDL applied by a `psql` chain in `deploy.yml`. That becomes two
  services, two deploy paths, two scaling stories — and our advisory-lock and
  cron-overlap reasoning is written for the current shape.
- **It cuts against the house grain.** This codebase deliberately keeps SDKs out of its seams —
  `mila/registry.ts` states that *"nothing here imports @google/genai"* and hand-writes its
  Zod→Gemini schema converter to keep it that way. LangGraph is a framework you build inside,
  not a library you hold at arm's length. That is a legitimate trade, but it should be a chosen
  one.
- **TypeScript is the smaller half of the ecosystem.** `@langchain/langgraph` and
  `@langchain/langgraph-cli` are real and Studio supports JS — but Python leads, and JS support
  arrived later and behind.

**The case *for* doing it eventually is strongest exactly where the weekly planner is heading.**
If a plan run grows to span minutes, fan out across athletes, pause for athlete approval, and
need to resume after a failure — that is a workflow engine's job, and hand-rolling durable
resumption is how you end up writing a worse LangGraph.

---

## 7 · The Opportunities / deal pipeline — audited for convertibility

This was the right thing to ask about, and it changes the answer in a useful direction.
**A refinement of what I said first:** the deal pipeline is the most *staged* thing we have, but
staged is not the same as graph-shaped, and on a full read it is **a decision tree, not a
workflow graph.**

### 7.1 What it actually is

`detectDeal()` is ~670 lines of logic inside a 1,935-line file, running top to bottom,
synchronously, in one process, in one request. Roughly fifteen gates in sequence:

```
pre-filter (regex) → idempotency → RFC Message-ID echo → Gmail labels → preserved-thread lookup
  → self-sender → structural non-deal → sender-memory mute → CLASSIFY (Gemini Flash)
  → confidence gate (0.6) → brand resolve → sender upsert → thread upsert → message insert (race)
  → SUMMARIZE (Kimi) → scoreable? → SCORE (Kimi + deterministic grid) → deal upsert (race)
  → GROUP (Kimi) → auto-demote / auto-file
```

Six LLM call sites feed it: classify, score, summarize, group, brand research (detached), and
reply drafting. Every fork is a guard clause that either short-circuits with
`return { skipped: true }` or falls through. **There are no cycles, no fan-out/fan-in, no
re-entrant states, no branch that later merges with another.**

### 7.2 Three things that make it *more* portable than expected

- **No database transaction ever spans an LLM call.** Zero `db.transaction(...)` in the entire
  pipeline. Consistency comes from insert-and-check-rowcount races where the loser re-reads and
  adopts the winner. That is normally the number-one blocker for any checkpointed execution
  model, and we already don't have it.
- **The LLM is a feature extractor, not a decision-maker.** The 1–10 deal score is *not* model
  output — `scoreDealGrid` computes it deterministically from Kimi-supplied components crossed
  against the athlete's rate card, and the model's own recommendation is then reconciled against
  the grid rather than trusted. That discipline survives any migration and is worth protecting.
- **Human-in-the-loop is already the checkpoint pattern.** `pending_actions` is a status column
  that a later, independent request reads and acts on — functionally the same thing a graph
  engine's checkpointer gives you, hand-written. Nothing in this codebase suspends a process
  waiting for a human, and nothing needs to.

### 7.3 Two things that would genuinely hurt

- **The session-scoped advisory lock.** `withAdvisoryLock` checks a client out of the pool and
  **pins that physical connection for up to 25 minutes** inside a single Express request, because
  the unlock must run on the same session. That is fundamentally incompatible with any engine
  that persists and resumes work across process boundaries — which is the whole point of one.
  It has to become a row-based lock first. **This is true regardless of which engine we pick**,
  and it is the single biggest structural liability for any future distributed execution.
- **SSE draft streaming.** `generateDealDraft` takes an `onToken` callback wired straight to
  `res.write()`. A node that returns when it's done breaks the token-by-token UX. Solvable —
  keep the SSE relay outside the graph — but it has to be designed, not inherited.

Plus a third, quieter cost: **the race-recovery logic assumes single-process synchronous
execution.** Every "re-read the deal id fresh" comment is reasoning about one process. Under
checkpoint-and-resume, where a node can be retried independently after a crash, all of it needs
re-verifying. That is where the "moderate, not small" estimate comes from.

### 7.4 The verdict, and why it points the same way as everything else

**Converting the deal pipeline would mostly buy observability and a formalised retry model —
not capability the code doesn't already have.** Retries, timeouts, idempotency, dead-lettering
and race safety are hand-rolled and *working*. This is not a fragile pipeline straining against
`if`/`return`; it is a durable one built on lower-level primitives than a graph engine's
checkpoint store.

And there is an argument here that matters specifically for the founder-control goal, which cuts
against my own instinct: **a graph diagram of `detectDeal` would draw a nearly straight line
through fifteen guard clauses.** That is not an illuminating picture. What a founder actually
wants to see is *one message's journey* — the classify prompt, the JSON it returned, the
confidence that gated it, the score components, the grid arithmetic that turned them into a 7.
**That is a trace, not a diagram**, and it is available today without touching a line of this
pipeline.

### 7.5 What *is* worth converting, when we get there

Three genuinely workflow-shaped things, none of them `detectDeal`:

1. **`sendThreadReply`** is internally a workflow: resolve inbox → recover threading metadata →
   send → insert the outbound row → delete the mirrored Gmail draft with three retries → flip
   turn state → re-summarize. Seven steps, each with its own failure mode, currently one function.
2. **`pending_actions` approve/dismiss**, where an engine's native HITL primitive would replace
   conventions that are currently implicit — 409 on double-approve, the `expires_at` check,
   at-most-once via an early status flip.
3. **The unwired 24-hour hold.** `held_until` is written by `writeAgentAction` and **nothing sets
   it and nothing acts on it** — the enforcement loop does not exist (`ISSUES.md` §2 says so).
   A durable timer with a delayed resume is exactly a workflow engine's job, and it is the one
   place where we are missing a capability rather than hand-rolling one we have.

### 7.6 One finding that belongs in stage 1 regardless

The Gmail webhook fans out with **`Promise.allSettled(messages.map(detectDeal))` and no limiter**
— unbounded parallel LLM calls, bounded only by how many messages one Pub/Sub history delta
happens to carry. That is the same missing concurrency gate that is already costing us ±2–3% of
recall in the classifier eval. It wants fixing whether or not we ever adopt a graph.

---

## 8 · Scoped to Nomila Studio — and this is where the answer flips

> **A naming warning first, because we already have nine names for one thing.** In this section
> **Studio** means *Nomila's creator workspace* (`server/studio/**`, the Studio tab). **LangGraph
> Studio** is always written in full. They are unrelated products and confusing them in a design
> doc would be expensive.

Scope changed: Opportunities and the inbox are out for now (not live, still in development), and
the goal is a **solid agentic system for Nomila Studio from the start**. That is a different
question from the one §7 answered, and it gets a different answer.

**For Studio, adopt the workflow engine now.** Not because the general argument changed, but
because Studio is the one place where all three conditions hold at once: the code needs a
capability it does not have, it has no legacy to unpick, and it is pre-live — so this is the
cheapest this decision will ever be.

### 8.1 Studio's own code already asks for exactly what a workflow engine provides

This is not inference. It is written in the repo, twice, by whoever built it.

**`server/studio/generate.ts:30-44`** — on why video generation is refused today:

> *"`videoPoll()` already allows a Veo job to be polled for up to ten minutes, and a blocking POST
> holding a connection open that long with no bytes flowing is exactly the shape Google's load
> balancer drops… **this is the single call site that becomes a detached job with a lease and a
> reaper.**"*

**`shared/schema.ts` on `generation_jobs`** — on why there is no background runner:

> *"⚠️ NO LEASING — READ BEFORE ADDING A POLLER… Add a background runner without building leasing
> first and, with three instances, two of them will claim the same row and **BOTH WILL SPEND —
> real money, twice.**"*

So: **video generation is blocked on a durable job queue with leasing that nobody has built.**
LangGraph Platform's queue is precisely that — runs are distributed across instances with
exactly-once execution enforced through Postgres MVCC, *"without ever executing the same run more
than once."* That is the reaper and the lease, bought rather than built.

Everything else about Studio points the same way: generation is long-running and getting longer
(video), it has two genuine human-in-the-loop gates (approve the spend, then approve the asset),
it is about to grow a multi-asset campaign layer, and every run costs real money at a paid
provider. That is a workflow, not a decision tree.

### 8.2 What scale actually buys you — and what it doesn't

The claim *"with LangGraph and LangSmith it will run at scale with multiple users and concurrent
requests"* is **mostly right, with three corrections that matter.**

**True:**
- A task queue with **exactly-once run execution** across instances (Postgres MVCC). This is the
  leasing `generation_jobs` warns is missing.
- **Horizontal scaling** — each worker runs up to `N_JOBS_PER_WORKER` concurrent runs (default 10),
  and throughput grows roughly linearly with instances.
- **Durable checkpointing**, so a run survives a restart or a deploy instead of dying with the
  request — which is what makes a ten-minute Veo poll safe.
- **Per-thread isolation**, so concurrent athletes are a first-class concept rather than a
  convention.

**Three corrections:**

1. **It does not create model quota.** Vertex 429s are *already* costing us ±2–3% of recall in an
   offline eval, at eval volume. Thirty concurrent generation runs do not get more Vertex capacity
   — they fail in parallel instead of in series. We still need the shared concurrency gate, and it
   has to cover **both** the graph and the non-graph paths, because they draw on the same Vertex
   project.
2. **It does not give us database transactions.** The engine's checkpoint store is not our
   application database. Every app-level consistency guarantee we have — the race patterns, the
   `ON CONFLICT` handling, `consumePreview` — is still ours to keep correct.
3. **LangSmith does not run anything.** It is observability. It changes what we can *see* at
   scale, not what we can *serve*.

**And one thing we must not delegate.** `previewStore.consumePreview()` is an atomic single-use
claim on the *approval*, deliberately placed **before** the billable call so that a double-tap's
loser never reaches the router. The engine's exactly-once is about **runs**; ours is about
**money**, and they are not the same guarantee — `createGenerationJob` INSERTs a fresh row per
tap, so two taps are two runs and the queue would happily execute both. **`consumePreview` survives
the migration untouched.**

### 8.3 The shape to build

Nodes are thin; the thinking stays in the functions that already exist.

```
  assembleBrief            deterministic, pure read — already exists, unchanged
        ↓
  previewGeneration        deterministic gate, $0, no network — already exists
        ↓
  ⏸ interrupt              APPROVE THE SPEND — durable, survives a restart
        ↓
  consumePreview           OUR atomic claim. Not the engine's. Before anything billable.
        ↓
  generate                 router → vertex/openrouter adapter. The long one. Checkpointed,
                           so a ten-minute Veo poll is a resumable run, not a held-open POST.
        ↓
  store + recordAsset      approval_status = 'draft'
        ↓
  ⏸ interrupt              APPROVE THE ASSET — draft → approved
        ↓
  embed / publish
```

Above it, a campaign-level graph fans out per asset — which is where the weekly planner
(`social-media-manager.md` §3) plugs in as a sibling, sharing the same runtime instead of
inventing a second one.

**Five rules carried over from the existing design, none of which the engine replaces:**

1. **The Postgres trigger guards stay** (`studio/sql/generationGuards.sql`). Nothing publishes or
   embeds from an unapproved asset, enforced in the database. A workflow engine is a belt; that
   is the braces, and it holds even if a node is buggy.
2. **Derive, don't emit.** Cost estimation, route resolution, blockers and the compliance verdict
   stay deterministic functions called *by* nodes. No model decides whether money is spent.
3. **Tenancy is injected server-side.** `athleteId` comes from the authenticated request, never
   from graph state a client can shape — the same rule `mila/loop.ts` enforces for tool args.
4. **Untrusted text stays fenced.** `BriefDirection.untrusted` already distinguishes the athlete's
   own words from an inbound brand ask. That property must travel through the graph state, not be
   flattened away.
5. **A failed job is failed.** Today re-running is a NEW row with its own cost line, deliberately.
   Do not switch on the engine's automatic retries for the billable node without deciding that
   explicitly — a retry loop on a paid generator is a way to spend money in a circle.

### 8.4 The one real fork to decide

**LangGraph the library, or LangGraph Platform / Agent Server?** They are different commitments:

| | Library only (`@langchain/langgraph` + Postgres checkpointer, inside our Express app) | Agent Server (Platform, cloud or self-hosted) |
|---|---|---|
| Graph structure, `interrupt()`, checkpointing | yes | yes |
| Durable queue, leasing, exactly-once across instances | **no — we build the reaper ourselves** | **yes** |
| **LangGraph Studio (the visual tool)** | **no** | **yes — it requires the Agent Server protocol** |
| Second service to run and deploy | no | yes |

**Since the goal is founder-visible workflow and the missing capability is the queue, the Agent
Server is the option that actually delivers both.** The library alone gets us structure and
interrupts but leaves us building the lease and the reaper by hand — which is the work
`generate.ts` is currently blocked on. Worth stating plainly so nobody picks the library expecting
a visual tool.

### 8.5 What this changes in the recommendation

Steps 01–04 of `nomila-recommendations` are unchanged and still come first — the two bugs, the
concurrency gate, tracing, and the prompt registry are all things we want *more* under a graph,
not less, and tracing especially should be on before the first node runs. What changes is step 06:
**the LangGraph trial is no longer "later, on the weekly planner" — it is "now, on Studio's
generation path," with the weekly planner joining it as the second graph.**

The advisory-lock rework (§7.3) stays a prerequisite for anything resumable, and Studio's
generation path is the first thing that will be resumable.

---

## 9 · Recommendation

A staged path. Each stage is independently worth doing, each one makes the next decision better
informed, and **nothing here forecloses adopting LangGraph** — stages 1 and 2 are things we would
want *even after* adopting it.

| Stage | What | Size | Why now |
|---|---|---|---|
| **1** | **Tracing** across the fourteen call sites, after the PII decision in §4 | S | Closes the biggest real gap. No framework, no rewrite. We stop debugging blind. |
| **2** | **Prompt registry + the evals to change against**, starting with the Narrator's untested gate | M | Delivers most of what "edit prompts visually" actually means, on our own terms, with our own review rules |
| **2.5** | **Replace the session-scoped advisory lock with a row-based one**, and put a limiter on the Gmail webhook's fan-out | S | Both are liabilities today, and the lock blocks *any* future resumable execution model regardless of engine (§7.3) |
| **3** | **Adopt LangGraph for Nomila Studio's generation path** (§8) — Agent Server, not the library alone. Then the weekly planner as the second graph. | L | Studio needs a durable queue with leasing that its own code says is missing and is currently blocking video; it is pre-live, so this is the cheapest this decision will ever be. `detectDeal` stays out — §7 says converting it buys observability we can get for far less. |

**Why the weekly planner is the right trial.** It is the only pipeline we are building from
scratch; it has the human-in-the-loop step that LangGraph is genuinely good at; it runs weekly
rather than per-request, so a second runtime's latency and cold starts don't matter; and if the
trial fails, we delete one new file instead of unpicking Mila.

**What would make me say yes to LangGraph sooner:** wiring the 24-hour hold (§7.5) — a durable
timer with a delayed resume is the one capability we are actually missing rather than
hand-rolling; a second and third pipeline needing durable resumption; or the visual graph
proving load-bearing for people outside engineering. That last one is a real benefit and hard to
price in advance, so if the team wants it, say so explicitly rather than justifying it on
engineering grounds alone — but note §7.4: for `detectDeal` specifically, the diagram is a
straight line and the *trace* is the thing worth looking at.

**What would make me say no for longer:** if stage 1 shows our failures are prompt-quality and
data-quality problems rather than orchestration problems. I suspect it will. Most of what the
audit found — an untested gate, unvalidated JSON, an ungated quota, eleven eval rows — is not
fixed by a graph.

---

## 10 · What this changes in the social-media-manager plan

Very little, which is itself a useful signal. That plan is *"deterministic steps around two model
calls."* Under LangGraph those become nodes; under a plain skill they become function calls. The
step boundaries, the output contract and the fail-closed compliance gate are identical either
way — which is why step 03 there can be built without settling this question first, and why it
makes a good trial when we do.

The one thing to do now, regardless: **stage 1 tracing before the planner's first model call
lands**, so we can see the Strategist's runs from day one rather than retrofitting.

---

## Sources

- LangGraph CLI / `langgraph.json` — the required `graphs` key must resolve to a
  `CompiledStateGraph` or `StateGraph` instance
- Assistant Editor — *"instances of a graph with specific configurations… without altering the
  underlying graph logic"*; prompt fields exposed via config schema, `langgraph_type: "prompt"`
- LangGraph.js — `@langchain/langgraph-cli`, `langgraphjs dev`, Studio support for JS
- LangSmith tracing without LangChain — `traceable()`, `wrapOpenAI()`, OpenTelemetry export
