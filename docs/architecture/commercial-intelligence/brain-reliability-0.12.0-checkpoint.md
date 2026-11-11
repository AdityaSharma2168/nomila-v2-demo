# Two reliability corrections before an athlete sees a Recommendation

What changes for Mia: when Nomila decides what she should do about an Objective, it now says the move and stops there —
not the deck, not the cross-posting, not the calendar. And when one of its three answers comes out badly worded, she
still gets the other two instead of nothing at all.

Underneath: ownership of a Recommendation's `what` is read across the whole sentence rather than its first word (R20),
and a provider reply is gated Decision by Decision with the Decision-SET contract kept whole (F5). Both shipped as one
deliberate version bump to `brain-eval-spec/0.12.0-exp`. Migrations 0071–0076 are deployed to dev through the normal
workflow, and one live evaluation now survives process exit.

No new architecture. No UI. Every flag still off.

---

## 1. R20 — ownership across the whole value

The pre-0.12.0 gate read only the first word of `what`. It refused *"Design an integrated content plan…"* and allowed
*"…by cross-posting short-form video content"*, which crosses the same boundary one clause later.

The invariant, stated once in `brain/ownership.ts` and now also in the spec prose: on a `specialized_plan` the Brain
owns the STRATEGIC MOVE and the planner owns everything it takes to carry it out, unless one of those is itself
materially the subject.

Three classes of material, and only two are refused:

| class | examples | verdict |
|---|---|---|
| ARTEFACT | a deck, a brief, a plan, a calendar, a template, a reel, an asset | refused wherever it sits |
| MECHANIC | cross-posting, repurposing, batching, scheduling, a posting frequency | refused wherever it sits |
| CHANNEL | TikTok, a podcast, a newsletter, a presence | never refused |

**Allowing every channel is the design move that makes the rest honest.** "Materially the subject" is the one judgement
a deterministic reader cannot make well, and it is only ever needed for surfaces — is this decision *about* being on
TikTok, or is TikTok just where the work lands? By never refusing a surface, the gate never has to answer that. When a
channel appears instrumentally, the mechanic beside it is what gets refused, and the channel needs no verdict of its
own. The escape clause therefore has to cover only artefacts and mechanics, and it is read from the decision's own
subject — `GateContext.subjectLabels`, built from what the run actually rendered — rather than guessed. A request about
three reels may answer in reels.

Position is reported, not used as the test: material in a head clause, a `by …` clause and a purpose clause is equally
the planner's. Scoped to `specialized_plan`, because a `direct_action` IS an act and a campaign's `what` is its purpose.

**It refuses and reports; it never rewrites.** `strategicRemainder` is what a reviewer should see survive, and no
caller may write it back. A gate may reject. A planner may elaborate later. Repairing the Brain's prose into a different
Recommendation is a behaviour that would have to be designed and evaluated, not a side effect of a validator.

### Required cases

All eleven pinned in `ownership.test.ts`:

| case | verdict |
|---|---|
| "Initiate outreach to global brand CSR departments…" | valid |
| "Target premium brand partnerships within EdTech…" | valid |
| "Develop a pitch deck…" | invalid, artefact as the move |
| "Create an outreach plan…" | invalid, artefact as the move |
| "Reactivate her TikTok presence by cross-posting short-form video content…" | invalid; the move survives, the mechanic does not |
| "Decide whether to launch a podcast…" / "Commit to a named TikTok series…" | valid |
| a request about three reels, answered in reels | valid when the subject names them; invalid when it does not |

### What the corpus says

166 distinct `what` values harvested from every recorded reply in the repository
(`docs/audits/artifacts/brain-ownership-corpus/`):

| shape | values | pass | refused | a strategic move survives | nothing survives |
|---|---|---|---|---|---|
| specialized_plan | 127 | 28 | 99 | 79 | 20 |
| direct_action | 31 | 27 | 4 | 3 | 1 |
| campaign | 4 | 4 | 0 | 0 | 0 |

**78% of recorded specialized_plan values fail the corrected boundary.** The most frequent material is `plan` (33),
`cross-posting` (25), `pitch deck` (18), `proposal` (14), `posting frequency` (13), `deck` (12). That is not a gate
being harsh; it is the measure of how much the head-anchored rule was letting through. It is also why the prose had to
move with the gate: refusing the Brain for something it was never told is not enforcement, it is a trap.

One deliberate conservatism: the old head-anchored production-verb check is KEPT alongside the new one. Nothing that
was refused before is allowed now. The one value the two disagree about is a bare "Design …" whose object is strategic
("Design a specialized outreach campaign targeting…"), which the verb check still refuses. Loosening that would be a
separate, reviewable decision.

## 2. F5 — Decision-level gating, with the set kept whole

Before: three Decisions, one invalid, nothing survives — not the two good Decisions, not the BrainRun.

`brain/decisionGate.ts` draws the line the problem actually needs:

- **Decision-local validity** — is this one Decision well formed and grounded? Scoped. A failure rejects that Decision
  and records it as audit information.
- **Set validity** — does the reply answer the set of questions asked, once each? Not scoped. A failure refuses the
  whole run, because a reply that answered the wrong set of questions cannot be trusted Decision by Decision.

Two consequences are deliberate, and they are why the boundary holds:

1. **Coverage is measured over CANDIDATES, not accepted Decisions.** The Brain answering badly about an Objective is not
   the Brain going silent about it. Measuring coverage over accepted Decisions would let a local rejection manufacture a
   coverage violation and refuse the whole run through the back door, which is the bug restated.
2. **Every set-level violation still refuses the whole run, duplicates included.** This is the answer to the worry in
   case F: independently valid Decisions cannot slip past cross-Decision coordination.

### Required cases

All ten pinned in `decisionGate.test.ts`:

| case | result |
|---|---|
| A. 3 valid | 3 accepted |
| B. 2 valid + 1 structural failure | 2 accepted, 1 rejected; the pre-F5 verdict on the same reply loses all three |
| C. 2 valid + 1 grounding failure | 2 accepted, 1 rejected |
| D. all invalid | 0 accepted, 3 rejected, run not refused for that reason alone |
| E. malformed top level | whole run refused, no candidates |
| F. duplicate on one Objective | every candidate locally valid, run still REFUSED |
| F. a missing answer | run refused — silence is a judgment |
| F. an answer nobody asked for | run refused |

## 3. BrainRun representation — no redesign needed

The existing record represents all six things honestly, with three additions to a jsonb column and no schema change:

| needed | where it lives |
|---|---|
| raw reply | `rawText` and `parsed`, unchanged |
| candidate Decisions | `parsed.decisions` / `.deferred` / `.requested` |
| accepted Decisions | `accepted` (new) and, typed, `output` |
| rejected Decisions | `rejectedCandidates` (new) |
| rejection problems | `rejectedCandidates[].structural` and `.grounding` |
| set-level problems | `setProblems` (new) |

**A rejected candidate is audit information, never a Recommendation.** `decisionsFromRun` now reads the accepted set
through `acceptedReplyFrom`, so a rejected candidate cannot become a Recommendation on any path — proved on the durable
one. Runs recorded before 0.12.0-exp have no `accepted` set and were gated whole, so for those the raw reply IS the
accepted set, and old artifacts replay unchanged.

## 4. What Decision-level gating recovers from the refused live attempts

No provider call. The two recorded replies from the previous checkpoint, re-gated under 0.12.0-exp
(`regated-under-0.12.0.json`):

**Attempt 2, which produced nothing at all.** 4 candidates. Under per-Decision gating: run stands, 3 accepted, 1
rejected, no set violation. The Yuwa and EdTech Recommendations plus the deferred entry would all have survived. The
rejected one is *"Design an integrated content plan to reactivate her dormant TikTok channel and increase her Instagram
posting frequency by repurposing existing assets"* — five ownership problems across three clauses, and **nothing
strategic survives it**: the decision has to be retaken, not trimmed.

**Attempt 3, which was accepted under 0.11.0.** Under 0.12.0 the whole-reply verdict flips to REFUSED on the
cross-posting clause. With per-Decision gating it yields 2 accepted and 1 rejected.

That pairing is the case for shipping both together: **R20 alone would have turned the one successful live run into
another empty one.** R20 plus F5 turns two refused runs and one accepted run into two, three and two usable
Recommendations respectively.

The provider-call implication is the one worth keeping: a refused run cost exactly as much as an accepted one, and the
previous checkpoint burned three calls to get one set of Recommendations. Under per-Decision gating each of those three
calls would have produced usable work.

## 5. R20 and F5 on the accepted run — and why nothing was normalised

The TikTok Recommendation from the accepted run **is** rejected under R20. Its strategic move survives cleanly, and the
gate reports it for review:

> Reactivate her dormant TikTok channel to expand her digital reach and reverse the cooling audience trajectory.

It was not written back. Normalising it would mean a deterministic parser silently replacing the Brain's Recommendation
with a different one, which is exactly the behaviour §5 of the brief rules out. The path taken instead was the other
one available: the prose now states the rule, so the next run can produce a clean value itself. It did — see §7.

## 6. Execution readiness

`brain/executionReadiness.ts`, reusing the router's own domain derivation (`plannerDomainFor`, exported rather than
duplicated) so the two cannot disagree. Derived, never stored — capabilities come and go with deploys and flags.

`available` or `unavailable`, with a reason and a chaseable reference: `flag[NAME]` for something mounted but off,
`capability[…]` for something unbuilt. The capability set is injected, so a test states the world it means; the default
reads the real flags in one place.

Three rules, and they are the whole contract:

1. It never alters a Recommendation.
2. Execution availability is NOT part of strategic validity. A Recommendation whose executor does not exist is still a
   correct Recommendation.
3. It is product-readiness metadata.

The gap it fills is real: the router returns a well-formed `specialized_plan` handoff for a planning domain that has no
planner at all.

## 7. The final live run — durable on dev

Migrations first. `deploy-dev.yml` dispatched on this branch through the normal workflow (run 36356955934, green,
including the `scripts/db-migrate.sh` step). No DDL was hand-applied. Verified afterwards on dev:

| table | state |
|---|---|
| `brain_runs`, `recommendations`, `recommendation_events` | present, 12 / 22 / 9 columns |
| `campaigns`, `campaign_specs`, `campaign_deliverables` | present |
| `creative_intents`, `creative_interpretations` | present |
| `outreach_plans`, `published_asset_identities` | present |

0074's constraint reads exactly the Amendment-3 three-state list, and `recommendation_events_seq_unique` exists.

Then one live evaluation: `brain-eval-spec/0.12.0-exp`, digest `56202020…`, model `gemini-3.5-flash`, store `database`.

```
Mia Bhuta · live 3 · deferred 1 · declined 1 · map 6 opps · work 8 · context 7
run f9e00c6f-87b3-46be-82d9-a01300f4d4c1
candidates 4 · accepted 4 · rejected 0 · set problems 0
created 3 · reconsidered 0 · withdrawn 0
```

**R20 did not recur.** Three clean strategic moves, all `specialized_plan`, all `new_work`, nothing rejected, no set
violation, no valid Decision lost to another:

**Yuwa** — `rec_2507ecb0723f9dd8` · *Target global brand and corporate social responsibility partnerships that align
with her philanthropic leadership at the Yuwa girls empowerment program.*
Cites the Objective, `findings[mia.narrative_power]`, `opportunity[amplify-yuwa-philanthropic-work]`. Not seen: a CSR
contact list, Yuwa's own sponsorship guidelines.
Readiness: **unavailable** — no planner owns the impact domain today · `capability[planner:impact]`.

**Academic and technology** — `rec_40c8ca0b0d70dc72` · *Target brand partnerships and ambassador roles within the
EdTech, STEM, and technology venture sectors that align with her academic positioning.*
Cites the Objective, `findings[mia.narrative_power]`, `opportunity[grow-academic-tech-partnerships]`.
Readiness: **unavailable** — the outreach planner is mounted but frozen off · `flag[OUTREACH_PLANNER_ENABLED]`.

**Dormant channel** — `rec_454fd683b5faeac4` · *Reactivate her dormant TikTok channel to engage short-form video
audiences and expand her platform reach.*
Cites the Objective, `contentPerformance[tiktok]`, `findings[mia.audience_scale]`, `opportunity[unlock-tiktok-channel]`.
Readiness: **unavailable** — no planner owns the content domain today · `capability[planner:content]`.

Compare that last one with the same decision a version earlier: *"…by cross-posting short-form video content"*. Same
judgment, ownership intact.

Existing Work affected nothing: eight open negotiations rendered, all `negotiating`, and all three decisions are
`new_work`, correctly — none of them touches any of the eight.

It survived process exit. On dev: one `brain_runs` row, three `recommendations` (response `none`, authorization `none`,
none closed), three `recommendation_events`, and the gating result recorded on the run. Nothing governed, nothing
routed, no Campaign, no planner work.

## 8. The athlete governance rule, recorded

**Strategic response and execution authorization are separate.**

She may accept, decline, defer or modify a Recommendation whose executor does not exist. That is her judgment about the
strategy, and it is the signal the system has never had — adoption read `unknown` in production until the substrate
mounted, and it stays `unknown` until a real answer is recorded.

Preparation may only be OFFERED where the execution path is actually mounted and available, because offering it
otherwise promises work that cannot start. Stated in code as `mayRespond()` and `mayOfferPrepareAuthorization()` so no
surface has to infer it. For all three live Recommendations today, the first is true and the second is false.

No UI here.

## 9. Is the Brain ready to show Recommendations to an athlete?

Ready to SHOW, not ready to ACT.

What is now true: the ownership boundary is enforced across the whole value and the Brain is told the rule it is held
to; a badly worded Decision no longer destroys its siblings; the set contract still refuses a reply that answered the
wrong questions; runs and Recommendations are durable on dev; every Recommendation can say whether anything can carry
it out, and nothing can offer preparation that would not start.

What is not: no planner owns the impact or content domains, and the outreach planner is frozen off, so every current
Recommendation is `unavailable`. One live run is one sample — the stochastic refusal measured last checkpoint was
measured under the old whole-reply rule, and the per-Decision rule has not yet been observed across enough live runs to
put a number on it.

---

## Artifacts

- `docs/audits/artifacts/brain-ownership-corpus/` — `corpus.json` (166 harvested values), `regated.json` (every verdict
  and surviving move)
- `docs/audits/artifacts/brain-substrate-live/regated-under-0.12.0.json` — the two recorded replies re-gated
- `docs/audits/artifacts/brain-substrate-live/final-live.json` — the final live reply, recorded before the gates
- `docs/audits/artifacts/brain-substrate-live/ledger-from-dev.json` — the audit ledger exported from dev

## Provider spend

One call, `gemini-3.5-flash`. Every other result in this checkpoint came from recorded replies.

## The ceremony

amend → bump (`0.11.0-exp` → `0.12.0-exp`) → unpin → parity → exact-text review → repin
`56202020ad9b01f99f2a5bc2cc8b0b4db52b6ce4b95701e5a534d48afeeff30f`, 22,075 chars. Every earlier version's prose
assertion still passes, so nothing was traded away for the new text. The added prose:

> On a specialized_plan you own the STRATEGIC MOVE, and the planner owns everything it takes to carry it out. The WHOLE
> `what` is read, not its first word. An execution artefact — a deck, a brief, a plan, a calendar, a template, a reel,
> an asset — and an execution mechanic — cross-posting, repurposing, batching, scheduling, a posting frequency — belong
> to the planner wherever they appear in the sentence: as the move itself, inside a `by …` clause, or inside a purpose
> clause. Either one will be refused. Name the outcome you want and stop there.
> A surface is not a mechanic. Deciding to be on TikTok, to start a podcast, to hold a named channel strategy is yours
> to decide; only the machinery for doing it is not.
