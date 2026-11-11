# Checkpoint 0 status and Checkpoint 1 design — athlete governance is intelligence

**What changes for Mia, in one paragraph.** Today she tells Nomila things — *"prompt me for my Adidas contract"*,
*"evaluate StartX1 first"*, a sharper rewrite of her own Objective — and Nomila stores the words and does nothing. After
Checkpoint 1, each of those becomes durable work that she can see, that Nomila can carry forward with the capability
that already owns it, and whose result changes what Nomila knows on its next pass. Nothing she didn't say is
invented, nothing consequential happens without her tap, and no button promises work nothing can do.

**Status:** Checkpoint 0's code is done and tested; its merge train is planned and awaits the authorized reviewer;
production promotion is a separate decision with a far larger consequence than 0071–0076 (§1). Checkpoint 1 is
**design only** — nothing below is implemented.

Evidence behind this review: `docs/plans/checkpoint0-merge-train.md`, `docs/plans/checkpoint1-trace-adidas-startx1.md`,
`docs/plans/checkpoint1-trace-objective-consistency-and-yuwa.md`, `docs/plans/voice-model-retirement.md`,
`docs/plans/mia-identity-anchoring.md`, and the audit (`docs/audits/nomila-end-to-end-product-intelligence-audit.md`).

---

## Principles adopted (canonical from here)

1. **ATHLETE GOVERNANCE IS INTELLIGENCE.** Accept / decline / defer / modify remain governance state. What she *says*
   while governing may emit typed facts, preferences, constraints, Intelligence Requests or athlete asks — each
   routed to the store that already owns that kind of thing. Governance itself never becomes Athlete State.
2. **MILA IS THE CONTROL LAYER OVER SPECIALIZED INTELLIGENCE AND EXECUTION.** She explains, converses, collects
   direction, presents, governs and orchestrates. She never substitutes for the Brain, a planner, research, Commercial
   or Creative Intelligence, or Studio.
3. **A STRATEGIC RECOMMENDATION DOES NOT REQUIRE EXECUTION READINESS TO BE SHOWN. AN EXECUTION CTA DOES.** Every CTA
   maps to a mounted capability in an appropriate readiness and governance state. No card domain object.
4. **No measurement-dependent numbers** (progress, value, reach, completion) until measurement backs them.
5. **Research standing rule:** new capabilities consume the canonical evidence stores; no new isolated research path
   without an explicit reason. Checkpoint 1 reads only: `athlete_asserted`, `deals` (+ `deal_periods`,
   `raw_data.contract`), `inbox_brands` via `brandIntel`, the Brain substrate, and Objective events — no new source of
   truth. §11 lists exactly where.

---

## 1. Checkpoint 0 — merge train and production path

**The train** (`checkpoint0-merge-train.md` §1–2): one linear stack of 40 PRs, **#622 → #623 → #625 → #626 … #664 →
#665 → #666**, all mergeable. Migrations enter with #654 (0071), #657 (0072), #658 (0073), #659 (0074), #661 (0075),
#662 (0076). #664 and #665 share a head, so merging #664 lands #665 (close #665 as landed-via-#664). Merge commits,
not squash (squashing breaks every descendant's ancestry). `delete_branch_on_merge` is off, so there is no automatic
retargeting — merge **top-down**: #666 into #664's branch, and so on, each PR into its own base, ending with #622 into
main — **one push to main, one dev deploy.** Not in the train: #608, #621, #624, #627, #630, #632, #633, #570 (separate
docs PRs) and #309 (separate, conflicting on `shared/schema.ts`). **Your authorized reviewer approves each merge. No
`--admin`.**

**Blocker found:** CI runs only on PRs targeting main, so **no stack PR except #622 has ever run CI**. The known red
(the 0061 parity test) is fixed in this checkpoint (§3); the full suite is re-run on this branch before the train.

**Merging to main does not touch production.** A push to main deploys dev only. The only production path is:

```
gh workflow run promote.yml --repo nomila-co/nomila-v2 --ref main -f confirm=promote
```

run by an allowed promoter, which dispatches `deploy-prod.yml`: backup → `scripts/db-migrate.sh` against
`nomila-prod-db` → image, web, landing and OTA deploy. **There is no reviewer pause** (the workflow comment saying
otherwise is stale).

**The consequence is much larger than 0071–0076.** Production is at `db76dc2f` (14 Sep), **~1,149 commits behind main
before this train**, and its `db-migrate.sh` stops at 0053. Promotion would ship all of that plus the train, apply
**0055, 0063, 0065, 0068–0070 and 0071–0076**, and re-run the Studio set that Studio's ledger says was hand-applied to
prod on 25 Sep (unverified). All the new flags are unset on prod and read off.

0071–0076 themselves are clean (§4 of the plan): additive, idempotent, no BEGIN/COMMIT, no table rewrites, CHECK lists
match `schema.ts`. **0074 and 0075 depend on 0073**, so a strict one-file BEGIN…ROLLBACK can't rehearse them in
isolation.

**Recommendation — two separate approvals:**
1. *Merge the train to main* (dev only). Reviewer approvals; I prepare the retargets and watch CI and the dev deploy.
2. *Promote to production* — **not now.** When you choose to, the plan's safe route is: read-only prod SELECTs P1–P8,
   a **clone rehearsal** (`gcloud sql instances clone nomila-prod-db nomila-prod-rehearsal-<date>`, then the real
   `db-migrate.sh` on the clone, then delete it), then the promote command above. Each step names its command for your
   explicit approval. Nothing touching production has been run.

## 2. Studio flag fix — done

`STUDIO_CREATIVE_INTENTS` and `STUDIO_CAMPAIGN_GOVERNANCE` are now **governance flags**: on only when their own
variable is exactly `"true"`; `STUDIO_ALL_ON` never opens them (`server/studio/studioFlag.ts` `studioGovernanceFlag`,
`server/studio/config.ts`). That matches the Brain's readiness projection, so the two can no longer disagree. On dev
this closes the creative-intent routes, the `/campaigns` routes and Mila's `request_creative` tool until someone sets
the flag deliberately.

**Correction to my earlier regressions:** `studioFlag.test.ts` had been **failing on the stack** — its census allows
exactly 28 flags through the master, and our stack added two. I twice wrote that failure off as environmental. It
was ours. It now passes (319 tests), with new rows pinning that a governance flag never moves under the master and
reads only through the strict helper.

**For Aditya** (suggested note — this touches his flag helper): *"We added `studioGovernanceFlag` beside
`studioFlag`. Two flags from the Brain stack (creative intents, campaign governance) now read strictly — the master
doesn't open them. Your 28 are untouched; the census test pins both lists."*

## 3. CreativeIntent 502 — root cause, fix, unmocked regression

**Root cause:** `interpretCreativeIntent` passed the intent's `purpose` — for an athlete ask, her verbatim sentence —
as `propose_campaign`'s `objective`, which must be one of Studio's six codes. Every real ask failed `invalid_input`,
the route answered 502. The slice test mocked `proposeCampaign` whole and even **asserted the bug** (it expected her
sentence as the objective).

**Why the obvious fix was wrong:** `propose_campaign` records the objective on every proposal as her **literal**
words (`basis: "literal", quote: <code>`). Defaulting a code like `concept` would make Studio claim she said something
she didn't.

**Fix:** the code is a parameter of the interpretation *request*, chosen by her (`POST …/interpret {objective}`);
without it the route answers **400 `needs_objective` with the six choices** — a question, not a failure. Her words now
actually reach the proposer, as context lines attributed to `creative_intent` (before, even a valid code would have
sent none of her words). The CreativeIntent contract is untouched (the intent still carries no objective).

**Regression** (`server/studio/creative/interpret.regression.test.ts`, 7 tests): real door → real
`interpretCreativeIntent` → real `proposeCampaign` (validation, instruction, reply gates) → persisted interpretation,
on PGlite. Only the model transport and the embedding-backed library read are stubbed. It pins the old failure, the
question-not-failure path, and that her words appear in the instruction the model would receive.

**Also fixed in Checkpoint 0 — schema drift in our own 0072.** Correcting the 0061 parity test (it now layers every
later file that alters `studio_plans`, as it already did for 0066) exposed that 0072 creates two partial indexes and
two foreign keys that `shared/schema.ts` never declared. The deploy's drift gate only checks missing columns, so it
never noticed. Now declared, with the constraint names Postgres actually gave them on every deployed database — no
migration, no change to anything deployed.

## 4. The athlete-utterance routing model

A routing mechanism, **not a new ontology and not a new table.** One athlete turn — a chat message or the `said` on a
governance act — may produce **zero, one or many** typed outputs, each landing in the store that already owns its kind:

| what she said | typed output | owner store (exists?) | who carries it forward |
|---|---|---|---|
| a correction of fact | asserted fact (typed field) | `athlete_asserted` (exists) | State reads it by field **type**, not name regex |
| a preference / constraint / "never" | asserted preference / constraint (typed, optional `valid_until`) | `athlete_asserted` (exists) | State `preferences` / `constraints` |
| an aspiration | Objective candidate | Objective proposal queue — `POST /me/objectives` (exists, unused) | her governance |
| an edit to an Objective | governed Objective modification | Objective entity (exists; §6 changes what modify may carry) | the Brain reads the coherent Objective |
| "find out / evaluate / know more about X" | Intelligence Request, `sourceClass` external | **request store (new table, §9)** | the capability that owns the need (`brandIntel` for a counterparty) |
| "ask me / remind me / prompt me for X" | Intelligence Request, `sourceClass` athlete, mechanism `document_request` or `athlete_question` | request store + a parked `await_human` step (§10) | her, through the existing flow that captures X |
| a question to Nomila | none | — | Mila answers by **reading** owned capabilities (`get_brand`, State) |

**Who reads the utterance:** the existing `server/mila/profileExtraction.ts` pattern — *propose typed outputs, the
athlete confirms on a card, only then write* — extended from chat to the `said` of governance acts. Not a new agent:
it is the one extractor Nomila already has, given two more output kinds (request, Objective candidate). Mila asks for
confirmation when an output is **material and ambiguous**; an unambiguous request she explicitly made ("prompt me for
my contract") is confirmed by the act itself and shown back to her.

**What it must never do:** turn every comment into a task; invent a fact she didn't state; create an Objective from a
passing remark; route a counterparty question to Mila's web search.

## 5. Multi-intent pressure tests

| # | athlete turn | outputs (0 / 1 / many) |
|---|---|---|
| 1 | Adidas decline: *"This is important and I should be prompted to provide my Adidas contract and available performance data, but collecting evidence is an action… not an objective itself."* | **governance** decline · **request** (athlete, `document_request`: contract + performance data) · **0 facts** (her Adidas relationship is already asserted) → 2 |
| 2 | StartX1 defer: *"I don't know enough about StartX1 yet… Evaluate the opportunity first."* | **governance** defer(information) · **request** (external, `counterparty_profile`: StartX1) → 2 |
| 3 | Positioning modify: *"…athletics, technology, AI, innovation and entrepreneurship…"* | **governance** modify · **consistency prompt** on `success` (§6) · **ambiguous** aspiration: does "entrepreneurship" mean a venture of her own? → ask, don't infer → 2–3 |
| 4 | *"I have a personal contract with adidas not nike. Nike is through stanford"* | **fact** (personal relationship: Adidas) · **fact** (Nike: institutional, via Stanford) · *optional suggestion* to add the contract — offered, not created → 2 |
| 5 | *"Don't ever post about my injury."* | **constraint** (`never_post: injury`) → 1 |
| 6 | On the Yuwa Recommendation: *"Love it, let's do it."* | **governance** accept only; "let's do it" is **not** execution authorization unless readiness is available and she authorizes explicitly → 1 |
| 7 | *"Yes, but focus on girls' football programs in India, and ask Yuwa what they need first."* | **governance** modify (Recommendation) · **preference** (focus) · **request** (athlete-mediated: Yuwa's needs) → 3 |
| 8 | *"Not now, I'm in exams until December."* | **governance** defer(time) · **constraint** availability with `valid_until` — an athlete-stated window, still an assertion, not Context → 2 |
| 9 | *"What's StartX1 anyway?"* | **0** durable outputs; Mila reads `get_brand` — and must caveat it, because the stored profile is probably the wrong company (§ StartX1 below) |
| 10 | *"ok"* with two pending decisions on screen | **0** — ambiguous; Mila asks which |

Tests 6, 9 and 10 matter most: they are where a naive extractor would over-produce.

## 6. Objective modification — exact consistency semantics

**Invariant:** *an athlete modification must not leave a governed Objective internally inconsistent.*

**What exists** (trace §A1–A2): the modify path carries only `desiredState` and `horizon`; the entity contract marks
the whole of `success` immutable (`objectiveEntity.ts:108`) and `fromRow` reads it from the creation snapshot — stricter
than the design, whose immutability table never lists `success.observableCondition`. Reconciliation is forbidden from
reshaping live Objectives (`reconcile.ts:12-15`), and evaluator 1.0.4 must stay closed. **So the fix belongs in
governance — not reconciliation, not the evaluator.**

**Proposed semantics (G1 — an entity-contract bump `objective/1.1.0 → 1.2.0`, no semantic spec):**

1. Her wording becomes the authoritative `desiredState`; the original proposal stays as provenance (`modifiedFrom`,
   immutable lineage).
2. On modify, a **deterministic materiality hint** compares scope terms (platforms, sectors, named organisations) in
   her new wording against `success` and `horizon.why`. It never edits; it decides only whether to ask.
3. If material, the modify sheet shows `success` (and `horizon.why`) beside her words and asks per field: *still
   right* · *change it (her words)* · *this is a different goal* (→ the design's existing **supersede** door, which the
   screen lacks today).
4. `success.observableCondition` becomes modifiable through modify; `success.quantified` stays immutable (changing
   what is measured is a new Objective).
5. `horizon` re-derives **only** if she changes it or the hint finds it contradicted. Unrelated fields are never touched.
6. The persisted Objective is coherent; the Brain reads it as-is.

**Optional later (G2):** Nomila *drafts* the repaired `success` for her to confirm. That needs its own versioned
semantic spec (`objective-restatement/0.1.0-exp`, digest ceremony, acceptance cases). Not proposed for the first slice.

**Independent, no spec bump:** the Brain's Objective render (digest-excluded evidence) labels `success`/`currentState`
as *"Nomila's wording before her restatement — not re-confirmed by her"* when she modified and never re-confirmed.
Needs an experiment arm because it changes Brain behaviour.

**The four pressure cases** (trace §A3): semantic expansion (positioning) → **ask**; scope expansion (audience) →
**ask**; framing change without scope change (Yuwa: commercialise → impact and visibility) → **soft prompt**, keeping
as-is is a valid recorded answer; non-material rewording (first person, typo) → **no prompt** — a check that fires
here is a false positive and a test failure.

## 7. Mia's positioning Objective, three states

| field | 1 · proposal | 2 · her edit, before repair (dev now) | 3 · after governed repair — **DRAFT, not written anywhere** |
|---|---|---|---|
| desiredState | She is established as an active commercial partner or ambassador for brands in the STEM, EdTech, or tech venture sectors. | **Build my positioning at the intersection of athletics, technology, AI, innovation and entrepreneurship, and secure partnerships that align with that identity.** | *(unchanged — hers)* |
| success | She has signed at least one brand partnership or ambassador role with a company in the EdTech, STEM, or tech venture sectors. | *(same as 1 — the contradiction)* | She has signed at least one partnership, ambassador or advisory role with a company or programme in technology, AI or entrepreneurship that presents her as an athlete at that intersection — not only as a sports endorser. *(Must not name StartX1 — she deferred it.)* |
| horizon | next_12_months | *(same)* | next_12_months — building a recognised position across athletics, AI and entrepreneurship takes a sequence of visible partnerships |
| open question | — | — | *"Does 'entrepreneurship' include founding something of your own?"* — yes → supersede into an `owned_venture` Objective |

## 8. Mia's audience Objective, three states

| field | 1 · proposal | 2 · her edit, before repair (dev now) | 3 · after governed repair — **DRAFT** |
|---|---|---|---|
| desiredState | Her social media audience is growing across both Instagram and TikTok, supported by active posting channels on both platforms. | **Grow my audience and build a stronger, more consistent presence across Instagram and TikTok.** | *(unchanged — hers)* |
| success | Her TikTok account has been reactivated with recent content, and her audience trajectory on primary platforms is no longer classified as cooling. | *(same as 1 — Instagram absent)* | Both her Instagram and her TikTok show recent posts on a regular cadence she has chosen (neither dormant), and her audience trajectory is no longer classified as cooling. |
| horizon | null | null | null — not materially affected; *this_season* may be offered, not imposed |

**The Brain experiment on these** (once the design is accepted and its spend approved — about **$0.03 per call**, 3–4
arms): rebuild her inputs in memory, replace her three Objectives by id with the DRAFT-repaired copies marked
CONTROLLED, set the stale 1.0.0 map to null (the 1.2.0 map is unsafe as a substitute: it drops Yuwa and rests on the
StartX1 inbound she deferred), evaluate into an **ephemeral** store only. Arms: current rows (control) · repaired
success · repaired + no map · repaired + render label. Measure whether the `what` carries AI/innovation/
entrepreneurship, Instagram *and* TikTok, and Yuwa's impact framing; then R13/R20 and grounding. **Her real rows
change only through her own confirmation.**

## 9. Where durable Intelligence Requests live

**One new table, `intelligence_requests`, beside `recommendations` in the Brain substrate** — the only genuinely new
store in Checkpoint 1. It persists the **existing** `IntelligenceRequest` shape (`brain/intelligenceRequest.ts`, today
file-backed in scripts): key, Decision identity (the Objective or Recommendation it blocks), need, proposition,
`sourceClass`, acquisition reference, evidence references, `reconsideredInRun`, events; status stays **derived**.

Producers: (a) the durable Brain loop, which today **drops** deferred REQUEST_INTELLIGENCE entries
(`brain/decisions.ts:23-35`) — map them via the existing `requestFromDeferredEntry`; (b) the governance reader (§4),
for requests she makes in her own words. Consumers: the capability that owns the need; the Brain's `research[n]`
block via the existing `evidencedRequestAsResearchBlock`; reconsideration (`brain/reconsideration.ts`, pure, mounted
here).

## 10. Where durable athlete Actions live

**No universal Action table.** "What Nomila is asking her to do" is a **projection over the stores that already own
each kind of ask**:

| kind of ask | owner store |
|---|---|
| provide information or a document | an athlete-sourced Intelligence Request + a parked `await_human` step in the existing `intelligence_acquisition` workflow, extended with a `document_request` mechanism |
| decide on a Recommendation | `recommendations.response` / `authz` |
| review a proposed Objective | the Objective review queue |
| approve something to send | `pending_actions` (tap-to-send) |
| approve a campaign spec / plan | Campaign spec approval · `outreach_plans` reviewed |

Mila's *"waiting on you"* is that projection, read-only — the future Home "Needs you" is the same read.

**Adidas, arrow by arrow** (`checkpoint1-trace-adidas-startx1.md` Trace 1):

| arrow | today | Checkpoint 1 |
|---|---|---|
| her statement stored | ✅ `objective_events.said` | — |
| → durable ask | ❌ no store | athlete request (`document_request`) + parked step |
| → shown to her | ❌ | Mila `list_tasks_threads` reads parked steps; `navigate` gains `add_contract` |
| → upload + extraction + review | ✅ `AddContractSheet` → `POST /deals/contract` → `contractExtract` (read twice) → her review | unchanged; request id recorded on the deal |
| → deal record | ⚠️ endorsement maps to `ambassador`; exclusivity and deliverables only in `raw_data` | unchanged schema; her review step confirms exclusivity |
| → Athlete State | ⚠️ money and relationship yes; **exclusivity never**; her asserted note dropped | `constraintsFrom` reads contract exclusivity; the asserted note links to the deal (said → proven, mirroring affiliations) |
| → Brain / reconsideration | ❌ nothing fires | the next scheduled durable run reads the changed State |

**Two cautions from the trace:** dev holds **no** Adidas contract (her six "adidas" threads are marketing newsletters
that minted **six junk `detected` deals** — a deal-classifier precision issue on this path); and *performance data* has
no place to land anywhere — the first slice captures it as a document on the deal and adds no metrics table.

**StartX1, arrow by arrow** (Trace 2): statement stored ✅ · Brain renders the condition ✅ · Brain emits
REQUEST_INTELLIGENCE ✅ · durable request ❌ (§9) · research ⚠️ `researchBrand` owns counterparties but is only called on
detection, keeps no sources and checks no domain · evidence ⚠️ brand findings aren't an `EvidenceRef` store ·
completion and reconsideration ⚠️ pure, unmounted · shown to her ❌ a re-surfaced Objective looks identical to a new
one.

⚠️ **Probable misidentification (unverified, no web call made).** Dev's brand record for StartX1 (`startx1.com`)
describes **StartX, the Stanford accelerator**, while the inbound subjects ("x1.new", "we'll pay you to test") look
like a paid-testing sender. `researchBrand` searches by name with no domain check. So the research step must verify
identity (domain ↔ findings) before anything counts as evidence — and Mila must not relay today's profile as fact.
Mia's own "I don't know enough" is the right stance.

## 11. How governance-derived intelligence reaches State and the Brain without governance becoming State

- **Governance stays governance:** `objective_events`, `recommendation_events`, `recommendations.response`. The Brain
  reads governance as governance (live / deferred / declined blocks) — and from now on the **declined block carries
  her `said`**, and the Objective evaluator is told about declines instead of relying on the store to suppress
  re-proposals.
- **What she said becomes evidence only through the reader, with her confirmation**, landing in `athlete_asserted`
  (typed fields; State reads by type — fixing the name-regex drop of `note`, `never_post`, `cadence`,
  `brands_causes`, `hobbies`) or the request store (acquisition → evidence → State or `research[n]`).
- **Every derived item carries a receipt** back to the governance event or chat message it came from, so "why does
  Nomila think this?" always has an answer.

## 12. Minimal Mila / Recommendation read-and-respond surface

Routes: `GET /me/objectives` (live, not only the review queue), `GET /me/recommendations` (with readiness),
`POST /me/recommendations/:id/response` (accept · modify · decline · defer, with `said`),
`POST /me/recommendations/:id/prepare` (only when `mayOfferPrepareAuthorization`). Mila tools: `list_objectives`,
`list_recommendations`, `respond_to_recommendation`, `waiting_on_you` (the §10 projection), `navigate:add_contract`.
The Recommendation object is the same one Home/Plan will later project.

**The honesty test, per object:**

| object | Nomila tells her | CTA | pressing it invokes | Nomila does on its own | her authorization | durable result |
|---|---|---|---|---|---|---|
| Adidas ask | "You asked me to prompt you for your Adidas agreement. Adding it lets me understand your obligations and exclusivity." | **Add contract** | the existing AddContractSheet | extract (twice), propose the terms | she reviews and saves; confirms exclusivity | a contract deal linked to her request; State gains the relationship and exclusivity |
| StartX1 request | "You asked me to find out more about StartX1 before deciding." | **Research it** — *only once identity-checked research is mounted*; until then **none** ("I'll look into it") | request-driven `brandIntel` research | research with sources, verify the domain | none to research; she decides the deferred Objective | findings with sources on the request; her Objective returns *marked* "you asked — here's what we found" |
| Yuwa Recommendation | "Pursue global brand and CSR partnerships around your work with Yuwa." (the move and why only) | respond: **Accept · Change · Not now · No**. **Work on it** — *not offered until the outreach planner is mounted* | response route | nothing | her response | recorded response = the adoption signal |
| Positioning Objective with a stale success | "Your wording goes further than how we'd measure it — AI, innovation and entrepreneurship aren't in it. Update it?" | **Review** | the modify sheet with success shown | the materiality hint | she edits or keeps | a coherent Objective |
| Audience Recommendation | the move and why | respond only | response route | nothing | her response | recorded response |

No row shows progress, value, reach or completion numbers.

## 13. What remains frozen

Brain semantics (0.12.0-exp), Opportunity (1.2.0), Objective **evaluator** (1.0.4), the Recommendation contract,
Campaign (#570 + A1–A3), CreativeIntent's contract, Outcome Intelligence, Measure → Learn, Deals, Rate, State semantics
(K5), the ingest gap. The Objective **entity** contract (`objective/1.1.0 → 1.2.0`: `observableCondition` modifiable)
is the one versioned contract Checkpoint 1 proposes to change, through the ceremony.

## 14. Smallest implementation slice after this review

Four slices, each its own reviewed PR:

1. **Adidas loop** — the `intelligence_requests` table + substrate store; governance reader v0 on decline/defer
   `said` (with her confirmation); `document_request` acquisition step; Mila `waiting_on_you` + `navigate:add_contract`;
   request id on the contract deal; State reads contract exclusivity and the typed asserted fields; declined `said`
   rendered. **Test: Mia uploads her Adidas agreement from the ask; State shows the relationship and exclusivity; the
   next Brain run reads it.**
2. **StartX1 loop** — request-driven `brandIntel` research with sources and a domain identity check; brand findings as
   an evidence store; reconsideration mounted for evidenced requests; the review screen marks a returning Objective.
   **Test: the request resolves with sourced, identity-checked findings (or honestly fails the identity check), and
   her deferred Objective returns with them.**
3. **Objective consistency + the listening test** — G1 entity bump through the ceremony; modify sheet with the
   materiality hint and the supersede door; the Brain render label; then the ephemeral Brain experiment (§8, spend to
   approve), and only then her three Recommendations shown to her through the respond surface (§12).
4. **Yuwa "Work on it"** — readiness maps impact → the outreach planner; a domain guard; the ledger passed so her
   deferrals are excluded; response/authorize routes; a `specialized_plan` branch in `routeGoverned` that plans outside
   and persists in one transaction; `OUTREACH_PLANNER_ENABLED` on dev only; a plan read surface; `markOutreachReviewed`
   as her approval. Sending stays out of scope (no outbound store, no CSR contacts, no thread-less send, no deck
   executor — each its own design).

---

## Parallel tracks — both need your approval before any spend

**Voice** (`docs/plans/voice-model-retirement.md`). **Correction to the audit:** the voice model
(`gemini-live-2.5-flash-native-audio` on Vertex) retires **13 December 2026**, not 16 October — that date belongs to the
text Gemini 2.5 models. Recommended replacement `gemini-3.8-live` (GA on Vertex since 24 Sep, same audio pricing), but
the swap is **code, not config**: the pinned LiveKit Google plugin (1.6.2) doesn't know 3.8; the newest (1.9.1) supports
it only on the Gemini API, not Vertex, and omits tool-reply ids that 3.8 requires; the worker's local patches must be
re-applied; 3.8 runs tools in the background by default. An already-built Grok voice path switches on by flag.
**Proposed test:** current model vs 3.8 on a test athlete, 240 minutes each, **about $15–25 expected, $48 worst case,
cap $100.** Not urgent before November.

**M.I.A. identity** (`docs/plans/mia-identity-anchoring.md`). Worse than the audit said: the wrong-person evaluation
had the athlete's own OAuth Instagram handle in its input and cited it — and still scored a namesake goalkeeper; his
own "Basketball" answer never reached `athletes.sport`. `identityConfidence` is read by no code and was HIGH for 36 of
37 cohort athletes. **Proposal:** first a code-only fix (her own sport answer overrides the column — no ceremony);
then one `blind-eval-spec/0.3.0` bump adding an identity-anchor block and a gate that refuses a result whose evidence
contradicts the anchor. **Re-validation: 67 calls, about $14, cap $20**, holding Spearman ≥ 0.86, median error ≤ 60,
zero HIGH wrong-person results, zero false blocks; you also confirm the 28 drafted cohort anchors. On dev today: 1
confirmed wrong person, 7 unverifiable.

## Decisions I need from you

1. Approve the merge train to main (reviewer approvals); production promotion deferred as a separate decision.
2. Accept the routing model (§4) and the no-universal-Action stance (§10).
3. Choose G1 (her edit, entity bump) for Objective consistency, with G2 (Nomila drafts) deferred.
4. Approve slice order 1 → 4.
5. Spend: the §8 Brain experiment (~$0.12), and separately the voice test (≤ $100) and the M.I.A. re-validation (≤ $20)
   — each only when you choose.
6. Send Aditya the flag note (§2).
