# AI Social Media Manager — audit findings & build plan

> **Status:** design, for review. Nothing implemented. Every claim below is a code read
> (`grep`, file read, schema read) against `main` @ `7df4aa7`, cited by `file:line`.
> Written in answer to the handoff spec `aisocialmediamanagerspec.md`, whose §2 and §9 asked
> for exactly this audit before any code is written.
> **Sequenced with the other two workstreams in [`00-roadmap.md`](./00-roadmap.md).**

---

## 0 · The verdict, in one page

The spec is a good spec. Four of its premises do not survive contact with the repo, and one of
its structural recommendations inverts once you look at what is actually built.

| Spec premise | Reality | Consequence |
|---|---|---|
| "ability to post on their behalf" | **No platform can publish today.** Every OAuth scope we hold is read-only (`instagram.ts:44`, `tiktok.ts:30`, `youtube.ts:25`). There is no `media_publish`, no `video.upload`, no `youtube.upload` call anywhere. | Scopes and the publish path are **owned elsewhere** (Mia on scopes + X; Aditya on generation, scheduling and publishing). This project plans for **four platforms** and hands off across a `Publisher` interface (§1.1). |
| "extend the media recommendation engine, don't duplicate" | **There is no engine.** Peer Scout, Trend Miner, Analyst, Brief Composer and Outcome Loop exist only in `docs/media-recommendation-engine-research.md`. Zero of them are in code. | There is nothing to extend. The real reuse points are different ones (§2), and the research doc becomes our *design input*, not our *substrate*. |
| Compliance Checker "validates every recommendation against contract terms" | **Most terms are not in the database.** Exclusivity is extracted but has no column (`dealContracts.ts:446`: *"exclusivity has no column at all"*). Required disclosures, hashtags, territory and usage rights are **not extracted at all**. | Split it: a **thin gate over what exists ships with v1**, a richer extraction track runs in parallel and upgrades the gate in place. Compliance must not gate the roadmap (§6). |
| Connected accounts across IG / TikTok / X / YouTube | X has no integration today — absent from the OAuth registry (`integrations/registry.ts:20`) and excluded by a DB check constraint (`schema.ts:886`). But `athletes.socials` already carries a `twitter` handle from landing capture, and X is being enabled. | **Design for four.** Widen the constraint, carry `x` in the plan vocabulary, and degrade per-platform on connection state rather than on a hardcoded list. |

And the input the feature most needs is the one input we have never touched: **the sports
calendar**. There is no game, season, fixture or league data anywhere in the repo (confirmed
across `server/` and all 43 tables). A "weekly social media manager" that does not know she
plays Saturday is a content analyst, not a manager. This is the sleeper critical path — and
it is solvable with the research pipeline we already run for athletes, off the team identity
`school` already carries (§5.3).

Three more things a second pass turned up, all of which change scope rather than direction:

- **The existing agents are a deck recipe, not a framework.** `deriveDeckPlan` — "the
  Strategist" — is a hardcoded array with two branches. `MediaKitData` *is* the pitch deck, and
  the renderers are ~6,000 lines of the same 13 card functions written four times, once per
  theme. The substrate under them (`getAthleteContext`, `searchMedia`, the Narrator's
  gate/pool/judge) is genuinely good and genuinely reusable. **Extend the substrate, write a new
  top half.** §4.
- **Names drift badly between DB, server and UI.** `school` is labelled "School / team";
  `rejected` renders as "DECLINED"; the M.I.A. Score is called the "Marketability Score" on
  screen; and one `media_kits` row answers to nine different names. Plan off the labels, not the
  columns. §1.5.
- **Much of the data model is jsonb read whole in JS** — 53 jsonb columns, nine of them ever
  queried in SQL. Mostly fine, and exactly why compliance needs real columns eventually. Seven
  are outright dead, two of which sit where someone would assume this feature's output belongs.
  §1.6. Two live bugs turned up on the way past, unrelated to this work but worth a ticket. §1.7.

**Architectural recommendation:** do **not** build a seven-node agent graph. Build a
**deterministic weekly pipeline with two LLM steps**, shaped exactly like the pipelines this
codebase already ships. Reasoning in §3, and §4 for what of the existing agents survives.

---

## 1 · What the repo actually has

### 1.1 Publishing — owned elsewhere, planned for here

| Platform | Connect | Read posts | Read analytics | Publish | Owner of the gap |
|---|---|---|---|---|---|
| Instagram | yes | yes (full history, backfilled) | yes (reach, saves, shares, watch time, demographics) | **no** | Mia — `instagram_business_content_publish` |
| TikTok | yes | yes | yes (views, shares, cadence) | **no** | Mia — Content Posting API |
| YouTube | yes | yes | yes (retention, traffic sources) | **no** | Mia — `youtube.upload` |
| X | **no** | no | no | **no** | Mia — whole integration |

Scopes held today: `instagram_business_basic, instagram_business_manage_insights,
instagram_business_manage_messages` · `user.info.*, video.list` · `youtube.readonly,
yt-analytics.readonly`. Publishing and scheduling are Aditya's lane; scopes and X are Mia's.

**What that means for this project.** Plan for four platforms from day one and do not encode
"three" anywhere. Concretely:

- **`platform` vocabulary is `instagram | tiktok | x | youtube`** in `content_plan_items`,
  independent of what is connected. A plan item for a platform she has not connected renders
  with a connect prompt — the *recommendation* is still correct.
- **Widen the analytics check constraint.** `sas_platform_check` (`schema.ts:886`) hard-codes
  three platforms; X analytics cannot land until it is widened. Small, do it early.
- **`athletes.socials.twitter` already exists** from landing capture, so some athletes have an
  X handle on file today. The public-discovery path (`platformDiscovery.ts`) accepts an `x`
  handle and nothing populates it — that is the seam Mia's work fills.
- **The handoff to Aditya is one interface, and it is the plan item.** A `content_plan_item`
  with `status = accepted` carries everything a generation-and-publish pipeline needs:
  `action_type`, asset ids or a generation brief, caption, hashtags, `send_window`, and the
  compliance verdict. Agreeing that shape with him now is the single highest-value
  coordination in this project — it is the contract between the brain and the hands.
- **Until publish lands, one implementation.** `ManualPublisher` records intent, notifies at the
  send window, and asks "did you post this?" — writing `content_posts`, a table that already
  exists with exactly the right shape (`schema.ts:1033`) and **has never been written to in
  production**. That write is what closes the outcome loop, and it is worth building whether or
  not the scopes ever land, because it is also how we learn whether the plan was any good.

### 1.2 What is genuinely built and reusable

- **Media library — real, and better than the spec assumed.** `media_assets` (`schema.ts:900`)
  holds durable GCS-rehosted copies of the athlete's whole post history, per-asset vision tags
  (`visionTag.ts:14` — `shot_type`, `vibe`, `attire`, `setting`, `brands_visible`,
  `aesthetic_quality`, `brand_safe`, `hero_suitability`) and a 1408-dim Vertex multimodal
  embedding. `searchMedia()` (`services/mediaSearch.ts`) already does text→image retrieval with
  tag filters, purpose reweighting, recency decay and diversity dedupe. **Spec §8 step 2 and §4
  node 2 (Asset Matcher) are ~80% already shipped.** Two caveats: the embedding lives in
  `metadata` jsonb with a brute-force JS cosine (`mediaEmbed.ts:62`) — fine at one athlete's
  library size, not fine cross-athlete; and the backfill is Instagram-only in practice
  (`docs/media-library-backfill.md` is still "no code yet" for TikTok/YouTube).
  **Worth knowing: pgvector is already installed.** `deploy.yml:106` runs
  `CREATE EXTENSION IF NOT EXISTS vector` on every deploy, and **no column uses the type** —
  zero `vector(...)` declarations in `shared/schema.ts` or any migration. So moving embeddings
  onto a real indexed column is a migration plus a rewrite of one scoring loop, not an
  infrastructure project. Not needed for v1; cheap when peer/trend work arrives.
- **Athlete context assembly.** `services/athleteContext.ts` is the canonical read-model:
  identity, tier, capitals, rate card, achievements ranked, audience demographics, top-post
  insights, and a tri-state `commercialState` that distinguishes confirmed partners from
  inferred ones. This is the Strategist's context layer, already written.
- **A brief assembler with a gap model.** `studio/brief.ts:488` `assembleBrief()` builds a
  typed `CreativeBrief` from athlete + brand + intent as a **pure read, no model call**, and
  emits `gaps: BriefGap[]` with `severity: "blocking" | "degraded"` (`brief.ts:254`). That is
  precisely the shape a compliance flag wants, and it is precedent for "the pipeline reports
  what it could not satisfy rather than throwing."
- **A spend/approval gate.** `previewGeneration()` → single-use `consumePreview()`
  (`previewStore.ts:146`) → `runGeneration()` → `approval.ts` (`draft→approved`), enforced in
  code *and* by Postgres triggers (`studio/sql/generationGuards.sql`). Copy this posture
  wholesale for anything the manager proposes.
- **Multi-model + judge.** The Narrator runs Gemini Pro, Kimi and Fable in parallel, pools and
  gates the options, and an independent judge *ranks* (never rewrites) to pick a default the
  athlete can override (`services/narrator.ts`, roadmap §9). Use exactly this for captions.
- **Cron.** `server/skills/*.ts` + `POST /api/internal/*-cron` + `cronSecretValid()`
  (`index.ts:110`) + `scripts/provision-schedulers.sh`. A weekly job drops straight in.
- **Anthropic is already wired.** `@anthropic-ai/sdk` with two live call sites —
  `claude-fable-5` in the Narrator, `claude-haiku-4-5` in `socialWebResolver.ts` (chosen
  because Gemini and Kimi fabricated follower counts and Claude did not). No new dependency.

### 1.3 What is missing, ranked by how much it hurts

1. **Sports calendar.** Nothing. Not a table, not a feed, not a field. §5.3.
2. **Compliance terms as data.** §6.
3. **Publishing and X.** Owned by Mia and Aditya, not by this project — but this plan assumes
   four platforms throughout, so the constraint widening in step 01 is ours. §1.1.
4. **Peer / trend corpus.** `trends.ts` is Google Trends on the athlete's *own name*;
   `gdelt.ts` is press mentions of her name. Neither is a peer corpus, and Business Discovery
   (the corpus source the research doc assumes) is still blocked on Meta Advanced Access.
5. **`brand_voice` has never been written** (`athlete-data-inventory.md:36`) — the one column
   named for "write in her voice" is empty on every row.
6. **No schema-validated LLM output anywhere.** Every JSON call in the repo is loose JSON mode
   plus defensive `JSON.parse`. Zod is used only for tool *arguments*. A structured weekly
   brief needs validated output; that is new infrastructure regardless of design.
7. **No LLM concurrency gate.** `docs/llm-concurrency-spec.md` is marked "proposal (not
   implemented)"; `server/lib/llm.ts` does not exist. Any design that fans out concurrent model
   calls is fanning them into an unguarded quota shared with the inbox pipeline.
8. **Web search is flag-off and thinly budgeted.** Gemini grounding behind `MILA_WEB_SEARCH`
   (default off), rate-limited to 10 calls / 60s **in memory, per Cloud Run instance**
   (`webSearchLimiter.ts`) — so the real budget is `10 × instance count`, and it is shared with
   the Tavily voice-search route (Nov 2026: that route now uses OpenAI web search, not Tavily). Not a foundation for weekly trend mining across athletes.

### 1.4 Operational facts that will bite this build

- **Migrations do not ship through drizzle.** `migrations/meta/_journal.json` stops at 0011, so
  every file from 0012 on is unjournaled and `drizzle-kit migrate` skips it. The executor is a
  chain of `psql -f` steps in `.github/workflows/deploy.yml`. A new table for this feature is
  *not* live until it is added there. Do **not** `db:push`.
- **Widening a CHECK constraint is a known-hazardous operation here.** It compiles to
  `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, and two merges 14 seconds apart once raced a
  DROP against its own ADD and broke the deploy — which is why `deploy.yml:21` sets
  `cancel-in-progress: false`. Batch every widening this feature needs into **one** deploy.
- **The constraints this feature must widen**, all in `shared/schema.ts`:

  | Constraint | Line | Today | Needs |
  |---|---|---|---|
  | `sas_platform_check` | 886 | instagram, tiktok, youtube | `+ x` |
  | `tasks_type_check` | 530 | research, deal_enrich, media_kit, brand_stories, delta_refresh | `+ weekly_plan`, if plan runs are tracked as tasks |
  | `pending_actions_kind_check` | 1361 | `send_reply` only | `+` a plan-item kind, if the approval spine is reused |
  | `agent_actions_action_check` | 1410 | file, auto_decline, reclassify, mute_sender, reopen, auto_archive | `+` any action the manager takes on her behalf |
  | `notif_type_check` | 546 | already includes `weekly_brief` | nothing — it was reserved for exactly this |

- **The Strategist needs a different kind of eval than we have.** `evals/mila/golden.jsonl` is
  eleven rows of *prompt → expected tools → substring assertions* against one seeded athlete.
  That shape cannot test a plan: correctness here is **structural** — does every item carry
  provenance, does the gate block what it must, is the slate within cadence bounds — not
  textual. The right precedent is `mediaKitService.golden.test.ts`, which stubs the model and
  snapshots the whole output. Budget for that, and note the trap that file already documents:
  a snapshot that stubs the model makes changes to *what the model is told* invisible, so the
  Strategist's **prompt** has to be snapshotted too.
- **Where it lives in the app.** Five tabs: Brand, Opportunities, SearchAsk, Studio, Profile
  (`client/navigation/MainTabNavigator.tsx:389`). The weekly plan belongs in the **Studio**
  stack, beside Pitches, Media Library and the workspace. **Naming hazard:** that stack already
  has a route called `CampaignWorkspace`, which is the single-asset generation screen, not a
  campaign plan. Do not call the weekly plan a "campaign" in code — see §1.5.

### 1.5 Names drift between layers — audit the label, not the column

A column name is not what the product calls the thing, and in several places it is actively
misleading. Anyone planning off `shared/schema.ts` alone will get this wrong.

**Onboarding is not in `client/`.** It is `landing/index.html`, a single-page vanilla-JS flow.
`client/` has no onboarding screens at all — `WaitlistScreen` only shows the post-signup state.

**`school` is labelled "School / team" to the athlete.** `landing/index.html:542`, with the
validation message *"School / team is required."* (`:1049`). So the overload in §5.3 is not just
tolerated internally — it is what we ask for. And the plumbing is already downstream:
`researchAthlete.ts:559` passes `team: athleteRow.school` into platform discovery with the
comment *"school OR club OR pro team"*, and `socialWebResolver.ts:44` carries the same `team`
field. Schedule research inherits a path that already exists.

**But `division` and `conference` are never asked for.** Onboarding collects name, sport,
school/team, goals and socials — nothing else. Both are populated only by the research
pipeline. That matters more than it looks: `segment` is a **generated column derived from
`division`**, so *"is this a college athlete or a pro"* is an **inferred** fact, not a stated
one. Any schedule researcher that branches on `segment` is branching on enrichment output.
(A comment in `voice/athleteProfile.ts:24` claims conference is "athlete-typed at onboarding."
It is not.)

**The score is not called what the code calls it.** Server-side it is the *M.I.A. Score*
(`scoringService.ts:2`, and it is even injected into a prompt as `M.I.A. Score:` in
`dealDetector.ts:1231`). The athlete sees **"Marketability Score"** and **"Dynamic Marketability
Index"** (`BrandScreen.tsx:230-243`). `internal_score` reaches no UI at all.

**Deal vocabulary drifts three ways.** DB → UI: `detected` renders as **"NEW"**, `rejected` as
**"DECLINED"**, `settled` as **"Paid in full"**, `payment_requested` as **"Invoice sent"**, and
source `twitter` as **"X"**. Separately there are *three* overlapping answers to "what kind of
deal is this" that do not round-trip: `deals.deal_type` (`social_post`/`appearance`/…, never
shown), `classification.category` (`PAID`/`GIFTING`/`SCHOOL_NIL`/…, shown as chips), and the
rate card's own keys (`appearance`/`ambassador`/`autograph`/`licensing`).

**And one concept has nine names.** The `media_kits` row is called: *media kit* · *Nomi Card* ·
*pitch* · *deck* · *card* · *Brand cards* · *Pitches* · and stored across `media_kits` /
`card_shares`. One UI sentence uses two of them at once — `DealDetailScreen.tsx:909`:
*"A pitch deck built from your media kit, matched to this deal."* — and the rights panel lists
*"my Nomi Card, media kits, and brand shares"* as if they were three different things.

**What this costs us, concretely.**

- **Name the new thing once, and not "campaign."** The Studio stack already has a
  `CampaignWorkspace` route that is the *single-asset generation screen*. A weekly plan called a
  campaign would be the tenth name in the same neighbourhood. Pick one noun for the DB, the
  server and the UI, and write it down before the first table lands.
- **The spoken layer (§7) is where drift becomes a bug, not a nuisance.** Mila reading
  "rejected" or "detected" aloud when the screen says "Declined" and "New" is a trust failure.
  The spoken templates must map through the *UI* vocabulary, so the label maps in
  `DealCard.tsx:183-198` are a dependency of the voice work, not a front-end detail.
- **Compliance strings must be checked against label maps too.** A gate that flags "competitor
  brand named in caption" needs the brand's *display* name, and brand naming has its own
  resolution layer (`brandResolver`) — not the raw column.

---

### 1.6 Much of the real data model lives in jsonb

**53 jsonb columns. Nine are queried in SQL. The rest are opaque blobs that only whichever
TypeScript module happens to know their shape can interpret.** That is often the right call —
the shapes are model output and they move, and `0018_voice_memory.sql` argues the case well —
but it has consequences for a planner that wants to *query* rather than *load*.

**The nine that behave like real columns:** `media_assets.metadata -> 'vision'` / `-> 'embedding'`
/ `->> 'poster_error'`, `media_assets.insights ->> 'video_views'`,
`inbox_threads.classification ->> 'category'`, `inbox_threads.score ||`,
`athlete_snapshots.score ||`, `agent_actions.payload ->> 'external_message_id'` / `'sender_email'`,
`deals.raw_data ->> 'brand_domain'`, and `athletes.socials ||`.

Everything else — `athletes_current.capitals` / `rate_card` / `pav`, `athlete_snapshots.research`
/ `social` / `deals`, `social_analytics_snapshots.raw_metrics`, `media_kits.data`,
`inbox_threads.conversation_state`, `generation_jobs.brief` — is loaded whole and picked apart
in TypeScript, usually as `any`.

**What that means for this build:**

1. **Compliance Track A will be the first production path to query into `deals.raw_data`.**
   Reading `raw_data -> 'contract' ->> 'exclusivity'` is valid Postgres and nothing does it
   today. At current volume an unindexed scan is irrelevant — but it is the clearest argument
   for Track B promoting exclusivity to a column: a gate that runs on every item every week
   should not re-parse a contract blob to answer a yes/no.
2. **`deriveOccasions` wants analytics deltas that are not stored.** The 7d/30d trends are
   computed **on request** in `routes/analytics.ts` and never persisted. Recomputing the same way
   is fine and cheaper to build — just know it is not a column lookup.
3. **`media_assets.metadata` is shared by three background workers**, each doing a whole-object
   read-modify-write: the enrichment cron (`vision`, `embedding`), the top-post enricher
   (`insights_enriched_at`), and the video-poster worker (`poster_error`, `original_gcs_path`).
   There is no per-key `jsonb_set`. Two workers racing on one row silently drop each other's
   patch. If the plan pipeline writes anything to this column, it becomes the fourth — **don't**;
   put plan state on the plan tables.
4. **`athletes_current.rate_card` is the most-read jsonb column in the schema and has no type.**
   Nine-plus files read it as `any` and each re-derives its sub-shapes locally. Any pricing
   the planner surfaces inherits that. Not ours to fix, but worth one shared type if we touch it.

**Dead shapes to not accidentally claim.** Written by nothing, read by nothing:
`athletes_current.brand_stories` · `athletes_current.insights` · `deals.pending_action` (its own
schema comment says the `pending_actions` table superseded it) · `onboarding_sessions.*` (the
whole table) · `brand_api_keys.permissions` (whole table) · `payments.metadata` ·
`content_posts.insights`. Two of those — `insights` and `content_posts.insights` — sit exactly
where someone will assume this feature's output belongs. Decide deliberately, and if claiming
one, write the generator.

**Write-only:** `tasks.result` (nothing reads it — the LISTEN/NOTIFY progress infrastructure is
largely unused capacity), `generation_jobs.brief` (stripped before every API response),
`athlete_snapshots.sources` (only a debug script reads it, and its real shape has drifted well
past the declared `SnapshotSources` type).

### 1.7 Two live bugs found on the way past — not ours, but you should know

Both are incidental to this audit and both are confirmed by reading the code, not inferred.

**1. Two of three snapshot writers persist an empty deals array.**
`athlete_snapshots.deals` feeds Commercial Capital in `scoringService.ts`, which reads it across
historical snapshots. `researchAthlete.ts` computes the real value for the in-memory scoring
snapshot and then writes **`deals: []`** literally on insert (`researchAthlete.ts:642`).
`fetchSocialData.ts` inherits the previous row's value, which is usually that same `[]`.
Only `refreshScores.ts` gets it right — and it carries a comment naming the exact failure:
*"Re-read rather than inherit: copying the previous snapshot forward is how an empty array
survived every refresh."* So the bug was diagnosed and fixed in one of three call sites.
Effect: an athlete's deal history under-reports in the Capital Score until a `scheduled_refresh`
happens to overwrite it.

**2. Two reads look for keys that are never written.**
`buildDealRawData` (`dealDetector.ts`) writes `thread_id, gmail_thread_id, summary,
contact_name, contact_email, deadline, deliverables` — no `category`, no `brand_domain`. Those
two actually live on `inbox_threads.classification`. But:
- `routes/deals.ts:360` filters the deals list on `(r.raw_data as any)?.category === …`, so
  **`GET /deals?category=…` can only ever return an empty list.**
- `routes/search.ts:36` selects `raw_data->>'brand_domain'`, so **that column is always NULL.**

Both are the failure mode a real column would have turned into a compile error. Worth a ticket
independent of this project; the second one also matters to us, because a compliance check that
wants a brand's domain must not read it from there.

---

## 2 · Answering the spec's §9 open questions

> **Does the current agent graph support adding new node types cleanly?**

There is no agent graph. `server/mila/loop.ts:91` is a hand-rolled ReAct loop — up to 8
iterations of *stream from Gemini → collect `functionCall` parts → run tools in `Promise.all`
→ append results*. Tools are a flat array (`registry.ts:24`, 12 of them); all policy lives in
one system prompt (`prompt.ts:37`). There is no sub-agent, no handoff, no supervisor, no graph
library — LangGraph and LangChain appear nowhere in `package.json` or in any source file.

Adding a *tool* to Mila is clean and well-trodden. Adding a *node graph* is net-new
infrastructure and would be the most complex thing in the repo.

> **What's the current state of the media library?**

Built. See §1.2. Instagram-only in practice; embeddings sit in jsonb though pgvector is installed.

> **What's the current contract/deal data schema?**

Structured: `deals.term_start` / `term_end` (dates, `migrations/0029`), `deal_periods`
(per-year cash/product, `guaranteed`, `condition`, verbatim `source_quote`),
`deal_installments` (due dates). Everything else is a jsonb blob or absent. See §6.

> **Confirm Composio integration status.**

Composio is **gone**. It was the v1 design and was removed; tokens are now stored directly on
`connected_accounts` (`schema.ts:713`: *"Tokens stored directly — no Composio intermediary"*).
The only remaining traces are two secret names in `scripts/setup-dev-env.sh` that nothing
reads, and comments describing what replaced it. Do not plan around it.

---

## 3 · Architecture — a pipeline, not a graph

**Recommendation: build `server/skills/weeklyPlan.ts` — a deterministic weekly pipeline with
exactly two LLM calls — not a seven-agent graph.**

The spec's seven roles map onto this cleanly. Five of them are not agents at all:

| Spec node | What it actually is here |
|---|---|
| Strategist | **1 LLM call.** Ranks and shapes a slate from a deterministically-assembled candidate set. |
| Asset Matcher | **Deterministic.** `searchMedia()` already exists. No model needed. |
| Creator (captions) | **1 LLM call**, multi-model + judge, reusing the Narrator pattern. |
| Audio Recommender | **Interface stub.** Per the spec, out of scope this phase. |
| Compliance Checker | **Deterministic code over structured columns.** §6 — this must *not* be a model. |
| Brief Composer | **Deterministic assembly.** Bind facts into a typed record. |
| Outcome Loop | **A cron job + a SQL join.** Not an agent. |

### Why not a graph

1. **Nothing to build it on.** No graph framework, no structured output, no concurrency gate.
   All three would have to be built before the first useful output exists.
2. **It fans out into an unguarded quota.** Seven nodes × N posts × M athletes of concurrent
   Gemini/Kimi calls, sharing quota with the real-time inbox classifier, with no semaphore
   (§1.3.7). The first busy Monday morning is a 429 cascade in the deal pipeline.
3. **It puts non-determinism where the repo forbids it.** The house law is *derive, don't
   emit*: deterministic code computes every number, and the LLM emits only categorical
   judgments (`dealScoreGrid.ts`, `athlete-data-inventory.md:73`). The spec itself says
   compliance false negatives are the highest-cost failure in the system. A model node that
   *decides* whether a post violates an exclusivity clause is the single worst place in this
   design to put a language model.
4. **Weekly cadence buys nothing from a graph.** A graph earns its keep on unbounded,
   branch-heavy, interactive work. This job runs once a week, on a fixed input set, to a fixed
   output shape. That is a pipeline.

### The shape

```
weeklyPlan(athleteId, weekOf)                      server/skills/weeklyPlan.ts

  1. assembleContext(athleteId)                    PURE READ, no model
       athleteContext.getAthleteContext            identity, tier, capitals, voice, goals
       + open deals + deliverables due this week
       + last-4-weeks analytics deltas             social_analytics_snapshots
       + top/bottom own posts                      media_assets + insights
       + confirmed calendar events                 §5.3 (new)
       + confirmed athlete memories                §8 (new)

  2. deriveOccasions(context)                      DETERMINISTIC — the spine
       every reason-to-post the data can justify:
       game day · deal deliverable due · post-game
       · milestone · cadence gap · format gap
       each with a date window and a provenance tag

  3. STRATEGIST                                    ← LLM CALL 1 (schema-validated)
       given occasions + context, return a ranked
       slate: which occasions to act on, platform,
       format, angle, rationale, confidence.
       It SELECTS and SHAPES. It never invents an
       occasion and never computes a number.

  4. matchAssets(slate)                            DETERMINISTIC — searchMedia()
       per item: existing asset / shot list / generate

  5. complianceGate(slate, deals)                  DETERMINISTIC — §6
       FAIL CLOSED. Unknown exclusivity blocks.
       Emits flags, never silently drops.

  6. CREATOR                                       ← LLM CALL 2 (multi-model + judge)
       captions + tiered hashtags per surviving
       item, voice-grounded, gated like the
       Narrator (deterministic gate drops options
       that repeat a fact or overflow length)

  7. compose + persist                             DETERMINISTIC
       content_plans + content_plan_items
       → notification_log (type 'weekly_brief',
         already in the CHECK constraint, schema.ts:546)
```

Two model calls per athlete per week. At current scale that is trivially schedulable; at 1,000
athletes it is 2,000 calls a week, which still does not need a graph — it needs the
`p-limit` gate from `docs/llm-concurrency-spec.md`, which should be built first regardless.

### Step 2 is the actual product

`deriveOccasions` is where the "personal social media manager" lives, and it is code, not a
model. A human manager's value is not prose — it is *knowing that Saturday is the rivalry
game, that the gorjana post is due the 14th, and that she has not posted a carousel in three
weeks*. Each of those is a deterministic query. The model's job is judgment over that set:
what to lead with, what to skip, what angle. Let it do only that.

This is also what makes the output defensible. Every item carries a provenance tag naming the
row that justified it — a deal id, a calendar event id, an analytics delta. An item with no
provenance is a hallucination and can be dropped by construction.

---

## 4 · The existing agents — what survives, what doesn't

The Strategist, Narrator, Curator and Assembler exist. They were built fast for one thing —
a brand pitch deck — and the honest read is that **the substrate generalizes and the
composition layer does not.** This is not a config change away from serving a second content
type, and it is also not a from-scratch rewrite. The line falls in a specific place.

### 4.1 The line

| Component | Lines | Verdict |
|---|---|---|
| `athleteContext.getAthleteContext` | 291 | **Reuse as-is.** Already deck-agnostic *by explicit design* — its header says "Nothing here is deck-specific." Built by extracting three drifting inline copies, and its own comment names generation as "the fourth consumer." |
| `mediaSearch.searchMedia` | 121 | **Reuse as-is.** Zero card/deck/brand concepts in the file. Its header already names the intended consumers: *"the Nomi Card Curator, post generation, proactive ads."* Built for this. |
| `mediaEnrichment`, `brandIntel` | 81 / 226 | **Reuse as-is.** Generic tagging/embedding and brand research. |
| Narrator's **gate · pool · judge** | ~130 of 479 | **Reuse behind a small refactor.** Purpose-agnostic over `{card, slots}`. Two things block a direct call: the `SYSTEM` prompt is module-level pitch-deck voice, not a parameter, and `NarratorContext` requires a `commercial` field that only the `mix` card needs. |
| `narrator.defaultCardBriefs` | ~65 | **Deck-only.** A literal enumeration of the 12 deck cards. Don't touch it; write our own briefs. |
| `curator.curateAthleteMedia` | 71 | **Light rewrite.** A thin wrapper making four hardcoded named slot calls (`cover`/`fit`/`audience`/`video`). The engine underneath is fine; the wrapper isn't. |
| `shotList.deriveDeckPlan` — "the Strategist" | 196 | **Rewrite.** See below. |
| `mediaKitService.assembleMediaKit` + `MediaKitData` | 398 | **Rewrite.** The type *is* the deck: a closed union of 13 card shapes, assembled by ~280 lines of inline `cards.push({id:"cover", …})`, one hand-written block per card. There is no seam; a caller would have to fabricate a fake brand and deck. |
| `kitRenderer` + `themes/*` | **~6,000** | **Not our problem — but know the cost.** Four near-duplicate implementations of the same ~13 card renderers, one per theme, no shared abstraction. A new content type means new render functions written by hand, four times. This dominates the cost of *any* new card-shaped output, and is the strongest argument for the weekly plan **not** being deck-shaped. |

### 4.2 The Strategist is not what its name says

`deriveDeckPlan` is named for the roadmap's "Director" — described there as
`f(tier, capitals-shape, goal_archetype, segment, trajectory, confidence)`. What shipped is a
**hardcoded array with two branches**:

```ts
const order = ["cover", brandMode ? "whyFits" : null, brandMode ? "campaignConcept" : null,
               "index","mix","audience","content","video",
               brandMode ? "activationPlan" : null, "rates",
               signals.hasRate ? "payments" : null, ...];
```

The composition decision is 100% deterministic literal code. The only model call is
`deriveShotList`, and its output is bound to a closed five-member union of deck card ids.

That is not a criticism of the code — a fixed recipe is the right answer for one deck, and it
is honest about being one. It *is* a correction to the assumption that a Strategist exists to
extend. **What exists is a deck recipe wearing a Strategist's name.**

### 4.3 Two ideas inside it are worth more than the code around them

Both are trapped in a deck file and should be lifted out:

- **Facets.** `deriveShotList` asks the model to name "the sides of who she is — competitor ·
  national-team · the person · the creator," mirroring the logo's rings. That is a **content
  pillar** by another name, and it is exactly what a weekly planner needs to balance a slate.
  Today it is recomputed per deck, inside one LLM call, and never persisted — so a deck's
  facets and a plan's pillars would give two different answers to "who is she." That is
  precisely the drift `getAthleteContext` was created to end. **Promote facets to a persisted,
  athlete-level concept that both consumers read.**
- **The image brief.** `ImageBrief { role, facet, mood, beat, searchQuery }` with `searchQuery`
  feeding `searchMedia` is already the shot-list-and-asset-match seam my §5.1 `action_type`
  needs. Generalize the shape, drop the `PhotoCard` union.

### 4.4 Two things to know before relying on any of it

- **The capability router does not exist.** `docs/brand-engine-roadmap.md` §3/§7 promises it as
  the Phase-0 seam through which new content types would plug in — features calling `narrate`,
  `selectImages`, `generateImage` interfaces with the model behind each set by config. **Nothing
  like it is in code.** Every consumer imports concrete functions. The only registry in the
  system is a theme lookup table, which selects *presentation*, not capability. Plan as if it
  isn't there, because it isn't.
- **The Narrator's gate has no test coverage.** The generate-N → deterministic gate → judge
  pattern is the quality-control backbone the specs lean on, and the one test that touches the
  pipeline (`mediaKitService.golden.test.ts`) **mocks the narrator out entirely**. So the gate
  is unproven in CI. If we reuse it for captions — and we should, it's a good pattern — write
  its tests first. `deckRates.test.ts` is the one genuinely behavioural unit test in this area
  and is the model to copy; the golden snapshots are refactor-safety, not correctness.

### 4.5 What this means for the plan

Nothing in §3 changes — the pipeline shape was already "deterministic steps around two model
calls," and that is now better supported: the deterministic steps map onto `getAthleteContext`
and `searchMedia`, which exist and are clean, and the two model calls need their own prompts
regardless. What changes is the **estimate and the framing**: this is a *sibling* of the deck
engine sharing its substrate, not an extension of it. Anyone who plans it as "add a card type"
will be wrong by about six thousand lines.

---

## 5 · Data model

### 5.1 The plan (the spec's §5 output contract, formalized)

Two new tables. `content_plans` is the weekly brief; `content_plan_items` is the Post
Recommendation. Both athlete-scoped, both joining the existing spine rather than paralleling it.

```
content_plans
  id uuid pk · athlete_id · week_of date · status (draft|delivered|archived)
  generated_at · model_run jsonb (models, prompt version, token cost — auditability)

content_plan_items
  id uuid pk · plan_id · seq
  occasion_kind    text   -- closed vocab: game_day | deal_deliverable | post_game
                          --   | milestone | cadence_gap | format_gap | trend | personal
  occasion_ref     jsonb  -- PROVENANCE: {deal_id} | {event_id} | {metric, delta} — required
  platform         text   -- instagram | tiktok | x | youtube — the full vocabulary,
                          --   independent of what is connected today (§1.1)
  format           text   -- reel | carousel | story | single_post | short
  action_type      text   -- use_existing_asset | shot_list | generate
  asset_ids        uuid[] -- → media_assets, when action_type = use_existing_asset
  shot_list        jsonb  -- when action_type = shot_list
  generation_brief jsonb  -- when action_type = generate → feeds studio/brief.ts
  caption          text
  caption_alts     jsonb  -- the judge's losers, for the athlete to pick (Narrator pattern)
  hashtags         jsonb  -- {broad[], niche[], sponsor_required[]}
  audio_ref        jsonb  -- STUB this phase (§5.4)
  compliance       jsonb  -- {flags:[{code, severity, deal_id, note}], verdict}
  send_window      tstzrange
  event_id         uuid   -- → athlete_events, when the occasion is a game or appearance.
                          --   Carries confirmed_at through, so copy can branch on whether
                          --   the date is researched or athlete-confirmed (§5.3).
  confidence       text   -- closed vocab, Kent-style: likely | possible | speculative
  rationale        text   -- ONE short templated clause. This one is SPOKEN (§7), so it is
                          --   derived from structure, never a free model sentence.
  notes            text   -- the model's fuller reasoning. Screen only, never spoken.
  status           text   -- proposed | accepted | dismissed | published
  content_post_id  uuid   -- → content_posts, set on publish. THE OUTCOME LOOP JOIN.
```

Three deliberate choices:

- **`confidence` is a closed vocabulary, not a float.** The research doc's Part 4 is right:
  LLM-emitted probabilities are overconfident and uncalibrated. A three-word vocabulary is
  honest and is the same posture as `commercialState`'s tri-state and `ContractExtract`'s `Tri`.
- **`occasion_ref` is required.** No provenance, no item. This is the anti-hallucination
  constraint, enforced in the writer.
- **`content_post_id` is the whole outcome loop.** Recommendation → post → realized metrics
  becomes one join, and it lands on a table that already exists. Build the writer for
  `content_posts` as part of this work (§1.1) — it is currently dead.

### 5.2 What we do *not* add

No new brand table, no new asset table, no parallel media store. The spine in
`docs/opportunity-pitch-content-model.md` already models everything else; a plan item points
into it by id.

### 5.3 Calendar — research first, athlete confirms (`athlete_events`)

A weekly plan without game days is a newsletter. **We already run the pipeline that solves
this.** `researchAthlete.ts` is Gemini grounding across parallel searches → Kimi extraction
into a fixed JSON schema → snapshot. A schedule is public, published information — school
athletics sites, conference sites, league pages — and it is exactly the shape that pipeline
already handles.

**Correction to an earlier read of this doc: `school` already holds the team.** There is no
`team` column, but the overload is deliberate, documented, and *asked for in those words* —
the onboarding field is labelled **"School / team"** (`landing/index.html:542`), and
`athleteContext.ts:237` says it outright: *"`school` holds the club/team for pros
(segment='pro'); college → school."* There is even a normalizing accessor:
`AthleteContext.org` is `schoolShort(school)`, and `identityLine` is built from
`sport · org · marquee`. So we are further along than "we do not know her team."

What is still missing is smaller and sharper:

- **The overload is not queryable, and the thing that disambiguates it is inferred.** Nothing
  can ask "which athletes are on this team" or "is this a school or a club" — both live in one
  text column, and the only hint is `segment`, which is a **generated column derived from
  `division`**. Onboarding never asks for `division` (§1.5); it is filled by the research
  pipeline. So a schedule researcher branching on `segment` is branching on enrichment output,
  and for a brand-new athlete it will read `unknown`.
- **College needs one more hop.** For a pro, `school` *is* the searchable entity ("Portland
  Thorns"). For a college athlete it is the institution, and the searchable entity is
  *school + sport + division* ("Stanford women's soccer"). Two different resolutions behind
  one column.
- **The formatting layer assumes college.** `schoolShort()` strips a trailing
  "University|College" — harmless on a club name, but a reminder that the column's assumed
  shape is educational.

There is also more precedent than expected: `researchAthlete.ts:559` already passes
`team: athleteRow.school` into platform discovery ("school OR club OR pro team"), and
`socialWebResolver` carries the same `team` field. The path exists; schedule research extends it.

So `researchSchedule` does not need to invent team identity from nothing; it needs to
**resolve `school` into a searchable competitive entity** and store that resolution
(`team_ref`, `team_kind`, `confidence`) so the next run and every other consumer can reuse it.
Evidence-gated, per `socialWebResolver`: no evidence → null, never a guess, because a wrong
team returns a plausible wrong season.

**The pipeline:**

```
researchSchedule(athleteId)                 server/skills/researchSchedule.ts
  1. resolve team          sport + school + division + conference → team identity
                           evidence-gated, like socialWebResolver: no evidence → null,
                           never a guess. A wrong team returns a plausible wrong season.
  2. ground               parallel searches: team schedule, conference calendar,
                           postseason format, the athlete's own competition entries
  3. extract              fixed JSON schema, Kimi → {date, opponent, home, kind, source_url}
                           every row carries the URL it came from. No URL, no row.
  4. upsert               athlete_events, source='research', confirmed_at NULL
```

```
athlete_events
  id · athlete_id
  kind (game|meet|travel|appearance|media_day|signing|rest|other)
  starts_on date · ends_on date · opponent text · home boolean · title text
  source (research|athlete|chat|feed) · source_url · confidence
  confirmed_at timestamptz          -- NULL until she says yes
```

**The confirmation is the product, not a chore.** This is what the answer to the audience
question asked for: *Mila comes to the weekly check-in prepared.* She opens with what she
already found — "you're at Cal Saturday, then home for two weeks" — and the athlete confirms,
corrects, or adds. That is exactly how a human manager works, and it is the same
propose-then-confirm posture as `commercialState`'s `undisclosed → active` flip and
`profileExtraction`'s candidate list: research may **inform**, only the athlete **confirms**.

Two rules that keep it honest:

- **An unconfirmed event may shape a suggestion, never a claim.** The plan can say "if you're
  at Cal Saturday, this is the post" — it may not say "Saturday at Cal" as fact in a caption.
  Carry `confirmed_at` through to the item and let the copy layer branch on it.
- **Research decays.** Schedules change. Re-run weekly alongside the plan, diff against
  confirmed rows, and surface only the diff for confirmation — never re-ask about a settled week.

A paid sports feed becomes a fourth `source` value later if coverage demands it. Nothing else
in the pipeline changes.

### 5.4 Audio — interface only, per the spec

```ts
interface AudioRecommender {
  suggest(item: PlanItemDraft): Promise<AudioSuggestion[]>;  // {trackRef, platform, licenseNote}
}
```
One implementation this phase: `NoAudioRecommender` returning `[]`. Do not stub *data* — an
empty array is honest; a fake track name is not. Note that `connected_accounts` already
supports Spotify (no app credentials yet) — that is a taste signal, **not** a licensing source,
and must never be conflated with one.

---

## 6 · Compliance — one interface, growing coverage

The spec calls this non-negotiable and says false negatives are the highest-cost failure. It is
right, and today it is unbuildable: the data is not there.

### 6.1 What exists

| Fact | Where | Queryable? |
|---|---|---|
| Term window | `deals.term_start` / `term_end` (date) | **yes** |
| Cash/product per period | `deal_periods` | **yes** |
| Payment due dates | `deal_installments.due_on` | **yes** |
| Deal type | `deals.deal_type` (enum) | **yes** |
| **Exclusivity** | `ContractExtract.exclusivity {exists: Tri, scope: string}` — extracted, **no column**, lives in `deals.raw_data.contract` | **no** |
| **Deliverables** | `ContractExtract.deliverables[] {what, count, per}` — extracted, no table, no per-deliverable due date | **no** |
| **Required disclosures / hashtags / tags** | *not extracted, no field, no column* | **absent** |
| **Usage rights** | *not extracted* — appears only as prose in negotiation prompts | **absent** |
| **Territory** | *not extracted* | **absent** |
| **Content restrictions** (category bans, competitor-in-frame) | *not extracted* | **absent** |

### 6.2 Two tracks, so compliance never blocks the roadmap

The steer is explicit: compliance matters, but it must not slow the rest down or overshadow it.
That is achievable, because the gate and the data are separable. Build a gate whose *interface*
is final and whose *coverage* grows.

**Track A — the thin gate, ships with v1 (small).** It checks only what is queryable today,
and it is honest about the rest:

| Check | Source | Available now |
|---|---|---|
| Deal is in-term for the send window | `deals.term_start` / `term_end` | yes |
| A deliverable is due this week | `deal_installments.due_on`, `deal_periods` | yes |
| Item names a brand that competes with a confirmed partner | `athleteContext.confirmedPartners` + `inbox_brands.category` | yes |
| Exclusivity exists on any live deal | read `deals.raw_data.contract.exclusivity` at gate time | yes — jsonb read, no migration |
| Everything else | — | **reported as `unknown`, not as `pass`** |

That last row is the whole trick. The gate returns `pass | flag | block | unknown`, and
`unknown` surfaces to the athlete as *"check your gorjana agreement before this one"* rather
than as silence. It is a smaller promise, honestly made, and it ships in days.

**Track B — the extraction upgrade, runs in parallel (large, not blocking).** Extend
`ContractExtract` with `disclosures {required_tags[], required_hashtags[], ftc_language}`,
`usage_rights {media[], territory, duration_months}`, `restrictions {prohibited_categories[],
competitor_in_frame, approval_required}`, and per-deliverable `due_on`. Then promote to
`deal_exclusivities` and `deal_obligations`. Follow the existing prompt discipline exactly —
untrusted-data fencing, `Tri` for every boolean where silence is not "no", a verbatim
`source_quote` per field, and the two-read reconciliation in `reconcileExtracts()` (which exists
because three reads of one contract returned four, ten and six periods).

Every field Track B lands moves a row in that table from `unknown` to a real check, with **no
change to the gate's interface and no change to anything downstream**. The deal co-pilot wants
this data anyway, so it is worth doing on its own merits — just not on this project's critical path.

**On re-extracting existing contracts.** Track B changes what we *ask* the model to pull out of a
PDF. Contracts already uploaded were read by the old prompt, so they have no disclosure or
territory fields — they would keep reading as `unknown` forever unless we re-run extraction over
them. **Recommendation: do not pay for a backfill.** Extract the new fields on new uploads, and
re-extract an old contract lazily the first time a plan actually touches its deal. At current
volume that is a handful of documents, spread out, only where it matters — and Track A already
degrades gracefully to `unknown` in the meantime.

### 6.3 Why the gate must be code, not a model

Because the spec says false negatives are the highest cost, and because `dealScoreGrid.ts`
already established the house answer to exactly this question: the LLM emits categorical
judgments, deterministic code derives the verdict. A model may *read the contract* (extraction,
reviewed, with verbatim quotes). A model may not *decide whether posting is allowed*.

---

## 7 · The brief has two layers, because one of them is spoken

A late but load-bearing requirement: the brief is **summarized, drillable, and consumable by
voice as well as read**. That is not a rendering detail — it constrains the data model, and the
constraint is already written down in this repo.

`server/voice/speakable.ts` is a **shape** gate (single line, bounded, no markup), and its header
is explicit about what it is not: *"neither one for prose — see the narration path for why a
paragraph gets summarized rather than filtered."* `voiceSeed.ts` says the same thing from the
other side: *"Every sentence below is written HERE, by template, from ids, enums and booleans.
Nothing is quoted from `chat_messages`, from a tool result, or from a model."*

So a generated caption **cannot be read aloud by passing it through a filter.** Filtering prose
is the failure mode both files were built to prevent.

**The design that follows.** Every plan item carries two representations, and the spoken one is
composed, never quoted:

| Layer | Content | How it is produced | Where it goes |
|---|---|---|---|
| **Spoken** | occasion kind, platform, format, day, confidence, compliance verdict, brand name | **App-authored template over the closed vocabulary** in `content_plan_items` — enums, dates and ids. Brand names pass `speakable()`; one that fails degrades to a count, per `voiceSeed`'s precedent. | Mila's weekly voice session |
| **Read** | full caption, alternates, hashtags, shot list, generation brief, model notes | Model output, rendered as text, never spoken | The brief screen, and Aditya's pipeline |

Because `occasion_kind`, `platform`, `format`, `action_type` and `confidence` are already closed
vocabularies in §5.1, the spoken layer is a pure function of the row — the same shape as
`voiceSeed`, and testable without a database or a model.

**What she hears vs. what she reads.** Spoken: *"Four this week. Saturday's the Cal game — a
reel the morning after. The gorjana post is due Thursday and it needs their tag. Two more when
you want them."* Read: the captions, the assets matched, the alternates, the flags. Voice is the
**index**; the screen is the **document**. That is also the right answer for the
athlete-vs-agency question — same `plan_items`, two renderers, and the agency view is a third
renderer over the identical rows, not a second pipeline.

**One consequence for the Creator step.** Because the caption is never spoken, it does not need
a speech gate — but the *rationale* line is spoken, so it must be written as one short templated
clause from structure, not as a free-text model sentence. Keep `rationale` short and derived;
put the model's reasoning in a separate `notes` field that only the screen shows.

---

## 8 · Weekly chat → memory

The spec proposes extracting prose memories ("mood: recovering from ankle injury, downplay
training content this week"). **`voice_context` cannot hold this**, by explicit design:
`migrations/0018` states its three jsonb columns *"must contain ONLY ids, closed-vocabulary
enums and timestamps — never prose, never a brand-authored string, never a model sentence"*,
because voice state is read aloud by TTS and is prompt-delimiter-blind. Do not widen it.

**Recommendation: a new `athlete_memories` table, with a split contract.**

```
athlete_memories
  id · athlete_id · conversation_id
  kind        text  -- closed vocab: availability | injury | embargo | preference
                    --   | upcoming_event | mood | brand_sentiment
  subject_ref jsonb -- ids only: {deal_id} | {brand_id} | {event_id}
  valid_from date · valid_until date   -- memories EXPIRE. "recovering from an ankle" is
                                       -- true for three weeks, not forever.
  note        text  -- free text, ALWAYS fenced as untrusted when it reaches a prompt,
                    -- NEVER routed to TTS or to a brand-facing surface
  confidence · source (chat|voice|athlete)
  confirmed_at timestamptz            -- null until she confirms. See below.
```

Three rules that make this safe:

- **`kind` steers; `note` colours.** The pipeline branches on the enum only. `note` is context
  for the caption writer, fenced like every other untrusted string (`brief.ts:146`'s
  `untrusted` flag is the precedent — carry the property, so a prompt builder cannot forget).
- **Propose, don't write.** `mila/profileExtraction.ts` already establishes the pattern: extract
  candidates, re-validate them through the same validators the write endpoint uses, surface
  them for an explicit confirm tap, never write directly. A memory that steers a public post is
  at least as consequential as a profile edit.
- **Memories expire.** A `valid_until` is required for `injury`, `embargo` and `mood`. Stale
  memory is worse than no memory — it makes the manager sound like it has not been paying
  attention, which is the exact failure the feature exists to prevent.

**Where the extraction runs:** a structured-output step at the end of the session, not a
separate agent. One call, on a bounded input, producing a validated candidate list.

---

## 9 · Build sequence

Revised against the answers. Compliance comes **off** the critical path as a thin gate that
ships alongside the brief, with the extraction upgrade running in parallel. The calendar moves
up, because it is now a research job we know how to write. Step 3 is the first thing worth
showing anyone.

| # | Step | Why here | Size |
|---|---|---|---|
| 00 | **`server/lib/llm.ts`** — the concurrency gate from `docs/llm-concurrency-spec.md` | Needed before any new fan-out. Independently overdue. | S |
| 01 | **Agree `content_plan_item` with Aditya**, widen `sas_platform_check` for X, and **fix the name once** across DB, server and UI | Pure coordination + one migration. The contract between the brain and the hands. Naming belongs here because it is free now and expensive later (§1.5) — and "campaign" is already taken. | S |
| 02 | **`researchSchedule` + `athlete_events`** — team resolution, grounded search, extraction, athlete confirmation in the weekly check-in | The plan's spine. Reuses the `researchAthlete` pipeline; team resolution is the new part. | M–L |
| 03 | **First end-to-end weekly brief** — plan tables, `deriveOccasions`, Strategist, composer. No assets, no captions. | Get the planning logic right on its own, as the spec argues | L |
| 04 | **Compliance Track A** — the thin gate: term windows, due deliverables, competitor-of-a-confirmed-partner, exclusivity read from jsonb, everything else `unknown` | Ships *with* the brief, not before it. Days, not weeks. | S |
| 05 | **Asset matching** via `searchMedia()`, and **lift `facets` out of the deck** into a persisted athlete-level concept both consumers read | Mostly wiring — the engine exists. Facets are the deck's best idea and the planner needs them as content pillars (§4.3) | S–M |
| 06 | **Creator** — captions + tiered hashtags, multi-model + judge + deterministic gate. **Write the gate's tests first** — it has none today (§4.4), and parameterize the Narrator's `SYSTEM` prompt out of module scope | Reuses the Narrator's machinery, not its deck briefs | M |
| 07 | **The spoken layer** — templated narration over the plan's closed vocabulary, wired into the weekly voice session | §6. Pure function of the row; testable without a DB or a model | M |
| 08 | **`content_posts` writer** + "did you post this?" | Closes the loop, revives a dead table, and is the input Aditya's publisher replaces later | S |
| 09 | **`athlete_memories`** + end-of-session extraction | Enriches the plan; not load-bearing for v1 | M |
| 10 | **Outcome loop** — join realized metrics back onto plan items | Needs volume from 08 first | M |
| ∥ | **Compliance Track B** — extraction upgrade + `deal_exclusivities` / `deal_obligations` | Runs alongside from any point. Upgrades Track A in place, changes no interface. The deal co-pilot wants it too. | L |
| — | *Audio* | Interface stub only, per the spec | XS |
| — | *Peer / trend corpus* | Blocked on Meta Advanced Access; revisit after | — |

---

## 10 · Decisions — resolved

| Question | Answer | What changed in this plan |
|---|---|---|
| **Publishing** | Plan-and-remind for v1. Generation, scheduling and publishing are Aditya's lane; posting scopes and X are Mia's. **All four platforms in scope now.** | §1.1 rewritten: four-platform vocabulary, widen the analytics constraint, and the `content_plan_item` becomes an explicit hand-off contract (step 01). |
| **Calendar** | Research it from the web and free sources off the sport and team we capture at onboarding; the athlete confirms and adds in the weekly check-in, with Mila arriving prepared. | §5.3 rewritten as a `researchSchedule` skill on the `researchAthlete` pattern, plus a correction: `school` **already holds the club/team for pros** by documented design (`athleteContext.ts:237`), so the work is resolving that column into a searchable competitive entity, not inventing team identity. |
| **Audience** | The athlete now, a team's social media manager later. Compliance must not slow things down or overshadow. The brief is **summarized with drill-down**, consumable **by voice or read**. | §6 split into a thin gate that ships now and a parallel extraction track. New §7: the brief has a spoken layer composed from closed vocabulary and a read layer carrying prose — because `speakable.ts` forbids filtering prose into speech. Agency view is a third renderer, not a second pipeline. |
| **Re-extraction** | *(the question was unclear — here is what it was asking)* Track B changes what we ask the model to pull out of a contract PDF. Documents already uploaded were read by the old prompt, so they hold no disclosure or territory fields and would read as `unknown` forever unless re-run. | **Recommendation: no backfill.** New fields on new uploads; re-extract an old contract lazily the first time a plan touches its deal. Track A degrades to `unknown` in the meantime, which is the honest answer anyway. Detail in §6.2. |

---

## Appendix · Evidence index

| Claim | Evidence |
|---|---|
| No publish scope, any platform | `server/lib/integrations/instagram.ts:44`, `tiktok.ts:30`, `youtube.ts:25`; no `media_publish`/`video.upload`/`videos.insert` call in repo |
| No X integration | `server/lib/integrations/registry.ts:20`; `shared/schema.ts:886` platform CHECK excludes it |
| Composio removed | `shared/schema.ts:713`, `server/routes/connections.ts:2`; only dead secret names remain in `scripts/setup-dev-env.sh` |
| No LangGraph/LangChain | absent from `package.json`; zero source hits |
| Mila is a hand-rolled tool loop | `server/mila/loop.ts:91`, `registry.ts:24`, `config.ts:108` (`MAX_TOOL_ITERATIONS: 8`) |
| Recommendation engine is doc-only | `docs/media-recommendation-engine-research.md` line 3 ("Research deliverable"); no peer-scout / trend-miner / RICE / bandit symbol in `server/` |
| Exclusivity has no column | `server/routes/dealContracts.ts:446`; `server/services/contractExtract.ts:157` |
| Disclosures/territory/usage-rights not extracted | no field in `ContractExtract` (`contractExtract.ts:125-172`); zero repo hits |
| `content_posts` never written in prod | `shared/schema.ts:1033`; inserts appear only in `studio/approval.test.ts`, `routes/studio.test.ts` |
| Media library + embeddings + search built | `shared/schema.ts:900`, `lib/visionTag.ts:14`, `lib/mediaEmbed.ts`, `services/mediaSearch.ts` |
| Embeddings not in pgvector | `lib/mediaEmbed.ts:62` (JS cosine over jsonb); contradicts `docs/durable-media-rehosting.md:134` |
| `brand_voice` never written | `docs/athlete-data-inventory.md:36` |
| No sports calendar data | no game/season/fixture table or feed across `server/` and all 43 tables |
| LLM concurrency gate unimplemented | `docs/llm-concurrency-spec.md` ("proposal (not implemented)"); `server/lib/llm.ts` absent |
| Web search flag-off, per-instance limit | `server/mila/config.ts:24`, `server/mila/webSearchLimiter.ts` |
| Voice memory forbids prose | `migrations/0018_voice_memory.sql` |
| Propose→confirm memory pattern | `server/mila/profileExtraction.ts` |
| Derive-don't-emit is house law | `server/services/dealScoreGrid.ts`; `docs/athlete-data-inventory.md:73` |
| `weekly_brief` notification type reserved | `shared/schema.ts:546` |
| Cron pattern | `server/index.ts:110` (`cronSecretValid`), `scripts/provision-schedulers.sh` |
| Anthropic already wired | `server/services/narrator.ts` (`claude-fable-5`), `server/lib/socialWebResolver.ts` (`claude-haiku-4-5`) |
| `school` doubles as the club/team for pros, by design | `server/services/athleteContext.ts:237-239` — and `AthleteContext.org` already normalizes it |
| An X handle is already captured at signup | `shared/schema.ts:96` — `socials` is `{ instagram?, tiktok?, youtube?, twitter? }` |
| Prose must never be filtered into speech | `server/voice/speakable.ts:20` ("neither one for prose"); `server/voice/voiceSeed.ts:8-13` |
| Grounded-research → extraction pipeline exists | `server/skills/researchAthlete.ts` (Gemini grounding × N → Kimi extraction → snapshot) |
| Evidence-gated resolution precedent | `server/lib/socialWebResolver.ts` — fail-safe null rather than a guess |
| Onboarding lives in `landing/`, not `client/` | `landing/index.html` — the only signup form; `client/screens/WaitlistScreen.tsx` is post-signup only |
| The onboarding field is labelled "School / team" | `landing/index.html:542`, validation at `:1049` |
| `division` / `conference` are never asked at onboarding | `landing/index.html` collects name, sport, school/team, goals, socials only — both filled by `researchAthlete` |
| `team` is already threaded into research | `server/skills/researchAthlete.ts:559` — `team: athleteRow.school, // school OR club OR pro team` |
| The score is "Marketability Score" in the UI, M.I.A. in the code | `client/screens/BrandScreen.tsx:230-243` vs `server/services/scoringService.ts:2` |
| Deal statuses relabel in the UI | `client/components/deals/DealCard.tsx:183-198` — `detected`→NEW, `rejected`→DECLINED, `twitter`→X |
| Nine names for the `media_kits` row | `DealDetailScreen.tsx:909`, `RightsAckPanel.tsx:36`, `services/pitches.ts:1-13`, `client/components/card*/` |
| pgvector installed, no column uses it | `.github/workflows/deploy.yml:106`; zero `vector(...)` declarations in schema or migrations |
| CHECK-constraint widening broke the deploy | `.github/workflows/deploy.yml:14-23` — why `cancel-in-progress: false` |
| Capability router is doc-only | `docs/brand-engine-roadmap.md` §3/§7 propose it; no registry or shared interface exists in `server/services/` |
| The Narrator's gate has no test coverage | `mediaKitService.golden.test.ts` mocks `narrateKit` and friends; no `narrator.test.ts` exists |
| `deriveDeckPlan` composition is a literal array | `server/services/shotList.ts:168-179` |
| `searchMedia` was built to be shared | `server/services/mediaSearch.ts:7-8` — "the Nomi Card Curator, post generation, proactive ads" |
| 53 jsonb columns, 9 SQL-queried | `shared/schema.ts`, read in full; SQL fragments across `server/` |
| Dead jsonb: `brand_stories`, `insights`, `pending_action`, `onboarding_sessions.*`, `brand_api_keys.permissions`, `payments.metadata`, `content_posts.insights` | no writer and no reader in non-test code |
| Snapshot deals bug | `server/skills/researchAthlete.ts:642` writes `deals: []`; `server/skills/refreshScores.ts:224` re-reads with a comment naming the failure |
| `raw_data.category` / `brand_domain` are read but never written | writer `dealDetector.ts` `buildDealRawData`; readers `routes/deals.ts:360`, `routes/search.ts:36`; the keys live on `inbox_threads.classification` |
| `media_assets.metadata` shared by three workers, whole-object RMW | `mediaEnrichment.ts:43`, `enrichTopPostInsights.ts:51`, `videoPoster.ts` |
