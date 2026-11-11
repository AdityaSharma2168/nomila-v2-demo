# P6 — epistemic gap versus strategic Opportunity: the Opportunity / knowledge boundary, 27 Sep 2026

**Controls:** `opportunity-eval-spec/1.1.0` (frozen, digest `b6883c24…`), `opportunity-map/1.1.0`; Objective `objective-eval-spec/1.0.2` and its knowledge-boundary checkpoint; #640 (pass-2 acceptance), #638, #608. No provider call, no bump, no code change. Audit over **23 recorded Opportunity artifacts** (four 1.0.0 runs × four athletes, the six-athlete cohort, the 1.1.0 treatment) and every Objective artifact that consumed them.

**In plain words.** When Nomila says "there is an opportunity here", it should mean something in her world could be better. For months the evaluator has also been saying it about something in *Nomila's* world: "connect your Instagram", "send us the Adidas contract", "tell us which gymnast you are". Those are things Nomila needs to know, not things worth doing for her. Nomila now has a proper way to ask for what it needs to know — an Intelligence Request, raised by a decision that is actually blocked. So the Opportunity layer can stop pretending that its own blind spots are her openings.

---

## 1. Every historical `domain: evidence` Opportunity — 35 of 35 are Nomila-world

| athlete | run(s) | key(s) | kind | what would satisfy it | changes |
|---|---|---|---|---|---|
| Mia | run, run-b, run-c, run-d, treatment | `unlock-adidas-nil-metrics` · `unlock-adidas-nil-campaign-data` · `unlock-private-performance-evidence` · `unlock-adidas-historical-performance-data` (×2) · `unlock-social-retention-metrics` · `unlock-social-engagement-metrics` | UNLOCK ×7 | her agent shares Adidas wrap reports / contract terms; she authenticates her accounts | **Nomila's knowledge** only — "eliminate 'assumed' metrics in her profile" |
| LeBron | run, run-b, run-c, run-d | `unlock-private-platform-metrics` · `unlock-historical-commercial-data` · `unlock-private-audience-metrics` · `unlock-commercial-records` · `unlock-private-audience-data` · `unlock-private-instagram-logs` · **`fix-commercial-portfolio-records`** (run-d, filed as evidence) | UNLOCK ×6, FIX ×1 | his team grants read access; his lawyers supply contract terms; **an administrative update to Nomila's backend, "requiring zero effort from the athlete"** | Nomila's knowledge only |
| Lilia | run, run-b, run-c, run-d | `unlock-social-audience-metrics` · `unlock-nil-historical-data` · `resolve-social-audience-gaps` · `verify-nil-and-commercial-history` · `integrate-hudl-and-family-platform-metrics` · `resolve-missing-digital-and-commercial-evidence` | UNLOCK ×3, GROW ×3 | she or her guardians connect accounts, disclose local deals, "or confirm that she has not yet engaged in any" | Nomila's knowledge only |
| Riya | run, run-b, run-c, run-d | `unlock-social-and-audience-analytics` · `unlock-commercial-history` · `unlock-social-and-demographic-data` · `resolve-identity-ambiguity` · `verify-digital-footprint` · `resolve-athlete-identity-alignment` | UNLOCK ×4, GROW ×2 | connect accounts; an onboarding interview; **confirm which of two gymnasts she is** (Nomila's own conflation) | Nomila's knowledge only |
| Okpara | cohort | `unlock-audience-metrics` · **`evidence-track-transfer-commitment`** | UNLOCK, GROW | authenticate accounts; "establish a regular communication cadence … regarding his final transfer list" — Nomila *tracking* a world event, not the event | Nomila's knowledge only |
| Ronaldo | cohort | `unlock-private-engagement-metrics` | UNLOCK | his digital team authenticates his platforms | Nomila's knowledge only |
| Flau'jae | cohort | `unlock-private-performance-metrics` | UNLOCK | one-time authentication | Nomila's knowledge only |
| Maher | cohort | `unlock-private-audience-engagement` · `grow-commercial-contract-registry` | UNLOCK, GROW | connect accounts; "her management team … supply past contracts" — for deals M.I.A. already shows she holds | Nomila's knowledge only |
| Ledecky | cohort | `unlock-private-engagement-metrics` · `unlock-active-commercial-contracts` | UNLOCK ×2 | read-only access; "logging these existing agreements" | Nomila's knowledge only |
| Street | cohort | `unlock-private-audience-metrics` | UNLOCK | OAuth connection | Nomila's knowledge only |

Every one rests on `materialGaps[n]` and/or a finding whose direction is UNKNOWN / imputed, plus Nomila's own zero counts (`closedDeals`, `activeRelationships`). Every rationale names Nomila as the beneficiary ("resolves our blind spot", "eliminates reliance on assumed values", "Nomila cannot currently see"). Not one names a condition of the athlete's world that would be different afterwards. **In no case does the underlying condition fail to exist in the athlete's world already**: LeBron's partnerships, Ledecky's contracts, Mia's Adidas terms, Maher's deals all exist; Nomila has not seen them.

**Downstream:** before the Objective 1.0.2 boundary, **25 of these were carried into Objective proposals** (`objective-1.0.0-run`, `-run-b`, `-1.0.1-run`, `-1.0.1-run-c`, the 1.0.1 cohort) with desired states such as "Nomila's analytics engine maintains a complete and structurally accurate record…", "Nomila possesses direct, continuous integration with the athlete's private social media analytics" — Nomila as the grammatical subject of an athlete's Objective. Under 1.0.2 the cohort refused **10 of 10** as `not_carried` ("information acquisition, not an outcome"); Mia's own review had already declined the Adidas one as "a task, not an outcome".

## 2. The same failure outside the `evidence` domain

Read semantically (keyword-flagged, then each read in full), three openings are Nomila-world under another domain, and seven flagged ones are genuinely athlete-world:

| athlete · run | key | filed as | actually | tell |
|---|---|---|---|---|
| Flau'jae · cohort | `fix-missing-commercial-records` | FIX · **commercial** | Nomila-world | "reconcile and record … within Nomila's transactional database"; the "cost paid today" is Nomila's matching engine not seeing her history. 1.0.2 caught it downstream ("internal database reconciliation and information acquisition") |
| LeBron · run-c | `fix-commercial-portfolio-records` | FIX · **commercial** | Nomila-world | "Reconcile Nomila's commercial position database"; "an administrative audit to log contract metadata already verified in findings" |
| LeBron · run-d | `fix-commercial-portfolio-records` | FIX · **evidence** | Nomila-world | the same opening, domain changed between runs — the domain label is not where the failure lives |
| genuine (7) | Ronaldo YouTube AMPLIFY · Maher docuseries AMPLIFY · LeBron durability MAINTAIN ×2 · Mia cadence GROW · Mia Yuwa AMPLIFY · Mia partnerships GROW / negotiation-pipeline GROW | — | athlete-world | each names a change in her world (programming, narrative, availability, cadence, partnerships) |

**Answer to the A/B question: B — a general Opportunity knowledge-boundary problem, not an `evidence`-domain problem.** The domain is where the failure *usually* lands (35 of 38) because the domain is *defined* as "what Nomila cannot currently see about this athlete" — the definition invites it. But the same content was filed under `commercial` three times, and 1.0.2's history shows the evaluator will relabel rather than drop when only a label is refused.

## 3. The tell, tested — and refined

> **Would satisfying this condition change the athlete's world or business, or only Nomila's knowledge of it?**

Held on all 38. Three refinements the corpus forced, borrowed from Objective 1.0.2 where they already exist and made Opportunity-shaped:
1. **Consent is not a change.** "Requires her to authenticate", "requires her team to share" — her tap is needed and nothing in her world moves (Objective 1.0.2: "even when the athlete's consent or action is required").
2. **Tracking a world event is not the event.** Okpara's transfer commitment is a world fact; "capture and track it" is Nomila's need (the item that looked closest to athlete-world).
3. **Nomila's counts are Nomila's records.** `closedDeals 0` beside `commercial_proof 94.3` (LeBron) is a discrepancy *in Nomila*; the evaluator read it as a condition to FIX. The opening rests on the count as if it were the athlete's fact — the cohort's §3.3 pattern, one layer up.

## 4. Relationship to Objective 1.0.2

| | Objective 1.0.2 | Opportunity (this checkpoint) |
|---|---|---|
| rule | an Objective's desired state is a change in her world; a state reached because Nomila learned/received/connected/recorded is information acquisition | an Opportunity is a strategic condition of *her* world worth acting on; a condition that exists only in Nomila's knowledge is a material gap, not an opening |
| what is reused conceptually | the tell; "consent does not promote it"; "you do not rephrase it into outcome language"; "Nomila's count is legitimate only where the world changes too" | all four, reworded for openings (§11) |
| what is not copied | "evidence is an opportunity domain, never an objective domain… accounted for as `not_carried`" — 1.0.2 *relies* on the domain existing upstream as the place these gaps are parked | Opportunity cannot park its own gaps in a domain it is removing; the gaps are already parked upstream in **State's `materialGaps[]`** and in UNKNOWN findings — that is where they live; the Opportunity layer leaves them there |
| enforcement | semantic block (primary) + one structural refusal of `domain: evidence` (backstop) | the same shape (§10) |
| verified | 10 of 10 refused, zero disguised replacements, 15 of 15 world outcomes kept | to be verified the same way after a bump (§14) |

Both layers reject a condition whose only effect is improving Nomila's knowledge; they differ in what they *are* (a strategic condition vs. a governed outcome), so the Opportunity wording says "condition", never "outcome", and says where the gap already lives.

## 5. Does `evidence` remain a valid Opportunity domain? — **C, staged**

| option | against the corpus |
|---|---|
| A · keep unchanged + semantic rule | leaves a domain whose *definition* ("what Nomila cannot currently see") is the failure; every one of its 35 members is epistemic; the rule would contradict the domain description in the same prompt |
| B · keep, narrow to athlete-world proof/validation | **no historical member qualifies** — zero legitimate athlete-world evidence openings in 23 artifacts. And the genuine proof-building opening (§7) is not "evidence" at all: building a track record is `commercial` GROW; getting measurable outcomes is `content`/`commercial` GROW; external validation is `positioning`/`career`. B would keep an empty domain and invite the relabelling of §2 |
| **C · remove `evidence` from the Opportunity domains; genuine proof conditions map to the domain of the thing being proven** | fits every case; the only cost is a taxonomy ripple (§12): the shared enum is read by the Objective contract, the Objective 1.0.2 backstop and the athlete-created-Objective route. Awkward classification check: "build demonstrable commercial proof" → commercial GROW (weak but buildable); "establish measurable campaign performance" → content/commercial GROW; "obtain externally meaningful validation" (an award, a selection) → athletic/positioning — none is awkward, each is where a representative would file it |

**Recommendation: C, as an Opportunity-spec taxonomy change, staged so Objective 1.0.2 keeps working** — the domain string stays in the shared enum for Objective's structural refusal and for older maps, and the Opportunity evaluator's vocabulary and gate no longer admit it (§12). The prompt's "EVIDENCE IS A REAL STRATEGIC DOMAIN" paragraph is the sentence the corpus refutes: seeing an athlete better is Nomila's job, done through material gaps and Intelligence Requests, not an opening in her enterprise.

## 6. The Adidas forcing case, exactly

| question | answer (run-d / treatment, `unlock-adidas-historical-performance-data`) |
|---|---|
| what does it claim? | "Acquire her historical Adidas partnership metrics and financial terms to convert assumed value ratings into high-confidence commercial pricing power" (UNLOCK · evidence) |
| what State supports it? | `materialGaps[0]`, `[1]` (Nomila cannot see the Adidas terms / campaign metrics), `findings[mia.commercial_proof]` (UNKNOWN direction); in the treatment `materialGaps[0..2]` only |
| what would make the condition cease? | Nomila receiving the terms and metrics — the gap closes in State; nothing else |
| would uploading/finding/verifying satisfy it? | **yes, entirely** — the feasibility claim says so: "her agent … securely share historical campaign wrap reports and contract details" |
| did anything about the athlete change? | **no.** The Adidas partnership happened; its terms exist; her pricing power is whatever it is. Only Nomila's confidence moves ("eliminate 'assumed' metrics in her profile") |
| was there a blocked Decision that needed it? | **yes — and the Brain already owned it correctly.** Cell B0 (a Northlight ambassador term-sheet decision) requested, class `connected`: "Mia's historic multi-year Adidas partnership contract terms and campaign ROI metrics establish an active market valuation for her ambassador rate", citing the term sheet, her floors, both material gaps **and `opportunity[unlock-adidas-historical-performance-data]`**. Cell D3 requested, class `connected`, whether her Adidas contract carries exclusivity that conflicts with a partner. Under 0.8.0 these carry typed needs (`demonstrated_valuation` [provisional], `existing_constraints`) |
| which Decision should own the request? | the Decision it blocks — "advance, counter or accept this term sheet" (subject `deal[…]`), with need `demonstrated_valuation` or `existing_constraints`. Not the Opportunity layer, which has no blocked Decision; not an Objective (Mia declined exactly that, and 1.0.2 refuses it) |
| what happened instead | the opening was carried into an Objective proposal in four Objective runs ("Her historical Adidas partnership terms … are documented and accessible to her team"), declined by Mia on 25 Sep, and it still sits on every Mia map — carried by key stabilization in the treatment as the "sole qualifying continuation" of itself |

The boundary, concrete: **the Adidas gap is a `materialGaps[n]` entry (State), a REQUEST_INTELLIGENCE when a Decision is blocked by it (Brain), an Intelligence Request with a typed need (0.8.x), and nothing in the Opportunity Map.**

## 7. A genuine proof-building positive control — none in the corpus; one synthetic, labelled

No recorded opening asserts that an athlete *lacks* commercial proof in the world and that building it would change her position: every "proof" opening is about Nomila seeing proof that exists. The nearest real items are world-shaped and filed elsewhere already (Lilia's "no public social presence" is an `audience` GROW; Mia's "one active relationship" is a `commercial` GROW). So no historical member validates the domain, and none is invented to.

**Synthetic positive control (for testing the rule only, clearly not evidence for the domain):** an onboarded athlete with connected, verified accounts, a commercial registry her team has marked complete, one closed deal with no post-campaign reporting, and a stated ambition to work with national brands. The condition "brands evaluating her have no measurable campaign outcome to look at" is athlete-world (partners *cannot* evaluate her, not just Nomila), it is affirmatively established (registry complete, not merely unconnected), building it changes her position, and it files as **`commercial` GROW** — "establish a measurable outcome record with her current partner". It never needs `evidence`. Under the rule of §11 it passes; under MISSING ≠ NONE it passes only because completeness is established (§8).

## 8. Missing versus absent — the implication

MISSING ≠ NONE is what makes §7 rare. A missing proof field in Nomila does not establish that the athlete lacks proof in reality; for public, unconnected athletes (LeBron, Ledecky, Maher, Ronaldo) the evaluator repeatedly read Nomila's `closedDeals 0` beside M.I.A.'s high commercial proof and filed the *discrepancy* as a FIX or UNLOCK — the discrepancy is Nomila's. Therefore an athlete-world "build proof" opening needs **affirmative** evidence that the strategic proof condition exists: a source whose contract establishes completeness (a registry marked complete; connected, verified accounts; a declared "no prior deals") — never `materialGaps`, never an UNKNOWN finding, never a zero count. Today no State source declares completeness, which is why the positive control is synthetic; the rule must say this rather than rely on it being rare.

## 9. Rejected candidates trigger nothing — by design

A knowledge-gap candidate → **not an Opportunity.** Nothing else. The gap already exists upstream as `materialGaps[n]` / an UNKNOWN finding, which is where State keeps it; the Opportunity evaluator's `notes[]` may say a domain yielded nothing "because what is missing is Nomila's knowledge, not her opening" (informative, no artifact). An Intelligence Request has identity Decision + need and belongs to a blocked Decision; the Opportunity evaluator has no Decision at evaluation time, and the repo provides none (the map is judged from State alone; B0/D3 show the Brain raising the request when a real Decision is blocked). No auto-creation, no "gap ledger" beside State, no lifecycle.

## 10. Where enforcement belongs

| layer | rule | detectable? |
|---|---|---|
| **evaluator semantic instruction (primary)** | the knowledge boundary (§11) replacing the "EVIDENCE IS A REAL STRATEGIC DOMAIN" paragraph; the domain removed from the domain list | no — it is judgment, exactly as at Objective 1.0.2 |
| **structural gate (narrow backstop)** | `domain: evidence` refused: "a change in what Nomila knows is a material gap, not an opening" — the unambiguous case only, mirroring Objective 1.0.2 §3b | yes |
| grounding gate | unchanged; a citation of `materialGaps[n]` remains legitimate as *context* for a genuine opening ("Nomila cannot see X" can bear on feasibility) — refusing it would punish honesty | — |
| normaliser / key stabilization | unchanged; note that carry-forward will happily carry an epistemic opening (it did) — the gate must stop it before normalisation | — |
| **no keyword regex** | "verify", "upload", "connect" are not lexically separable from world outcomes ("connect with local brands"); the relabelled `commercial` FIXes are the evaluator's responsibility under the semantic block, verified by rerun, as 1.0.2 did | — |

## 11. Proposed contract wording (for the candidate bump; not applied)

Replace, in `OPPORTUNITY_DOMAINS_BLOCK`, the `evidence` line and the "EVIDENCE IS A REAL STRATEGIC DOMAIN…" paragraph with:

> THE BOUNDARY WITH NOMILA'S OWN KNOWLEDGE
>
> An opportunity is a condition of the athlete's world or business worth acting on. A condition that exists only in what Nomila knows — an account not connected, a contract not shared, deals not recorded, metrics Nomila cannot see, an identity Nomila has not resolved — is a material gap, not an opening. It is already recorded in the state as a material gap or an unknown finding, and a later decision that cannot be made without it will ask for it. You do not carry it, under any domain, and you do not rephrase it: "her contracts are documented" and "her metrics are verified" describe Nomila learning something while nothing in her world moved. Her consent or her tap being required does not make it hers. Nomila tracking a real event is not the event.
>
> Nomila's own counts are Nomila's records. Zero closed deals beside strong commercial proof is a gap in what Nomila has recorded, not a cost the athlete is paying; it is never a FIX.
>
> A condition of her world that concerns proof — a track record partners can evaluate, measurable outcomes, external validation — is a genuine opening in the domain of the thing being proven (commercial, content, positioning, athletic, career), and only where the state affirmatively shows the condition exists: a missing field in Nomila is not evidence that the proof is missing in the world.

And in the domain table, remove `evidence`; in the output contract, remove it from `domain`; `notes[]` keeps "why a domain yielded nothing" and may say "what is missing here is Nomila's knowledge".

## 12. Version recommendation — `opportunity-eval-spec/1.2.0` + `opportunity-map/1.2.0`, not applied now

This is a **taxonomy change** (a domain leaves the Opportunity vocabulary), not a semantic correction, so 1.2.0, not 1.1.1. 1.1.0 stays frozen. Ripple to prepare before the ceremony, sequenced so Objective 1.0.2 is untouched: `OPPORTUNITY_DOMAINS` is shared with `contracts/objective.ts` (`domain: OpportunityDomain`), `routes/objectives.ts` (athlete-created Objective validation) and the Objective 1.0.2 structural refusal — keep the shared enum whole, introduce the Opportunity vocabulary as the enum minus `evidence` for the prompt and the Opportunity gate, so a 1.0.0/1.1.0 map with an evidence opening still types and Objective's refusal still fires. Older recorded maps stay valid under their own specs; the regate script would show the 35 refusals as the intended change, not drift.

## 13. Tests needed (when the ceremony runs)

Parity phrases for §11; the domain list excludes `evidence` in the canonical text and the structural gate refuses it (with the exact reason); the Objective 1.0.2 refusal still fires and the Objective contract still types older maps; key stabilization is unaffected; grounding still resolves `materialGaps[n]`; `opportunityRegate.ts` on the 23 artifacts reports exactly the 35 evidence-domain refusals and nothing else; the synthetic positive control (§7) passes structurally as `commercial` GROW; a disguised-replacement check after the forcing run (§14), proposal by proposal, as the cohort did.

## 14. Is a provider call necessary?

Not for this determination — the corpus decides it. **One** call is warranted after the 1.2.0 ceremony, as the forcing experiment: Mia's run-d State (recorded block verbatim) under 1.2.0, compared with run-d and the treatment. The question is the one 1.0.2 answered downstream: does the evaluator **drop** the Adidas and social-metrics openings rather than **re-dress** them under `commercial`/`audience`, while every genuine opening (cadence, TikTok, academic-tech, StartX1 demand, Yuwa) remains? One sample; the reading is proposal-by-proposal, not a count.

## 15. Not done

No provider call. No bump (1.1.0 frozen). No code change. No automatic Intelligence Request creation. No Opportunity lifecycle. No mounting. No Objective 1.0.3 work. No Deals, Rate, Recommendation, Campaign/Studio or brand-relationship change. No repeatability matrix. #640 is the pass-2 acceptance; #638 the Context checkpoint; #608 unchanged; #570 untouched.

## 16. Review outcome (27 Sep 2026) — accepted

**Architectural invariant adopted:** *A deficiency in Nomila's knowledge, records, observation or verification is not a Strategic Opportunity for the athlete.* An Opportunity describes a strategic condition of the athlete or her business whose change would alter her world/business. If satisfying the candidate merely causes Nomila to know, verify, connect, record, reconcile, count correctly, obtain an existing contract, observe an existing relationship, or resolve its own identity/data error, it is not an Opportunity — regardless of domain (the three `commercial` FIX cases are why this is semantic, never `domain === evidence → reject`).

**Three refinements preserved:** athlete participation (consent, tap, upload, answer, connect) does not transform the ontology; recording/observing/tracking an event is not the event; Nomila's counts describe Nomila's records — for incomplete sources `0 recorded` ≠ `0 exists`; MISSING ≠ NONE controls.

**Rejected candidates trigger nothing** (no automatic Intelligence Request; no blocked Decision exists at Opportunity evaluation; the gap stays visible upstream as a State material gap; only a real Decision → REQUEST_INTELLIGENCE → Intelligence Request → acquisition). **Adidas is the canonical forcing example**: material gap valid; Intelligence Request when a Decision requires the terms valid; Strategic Opportunity invalid; Objective invalid; the Brain path already demonstrates the route.

**Domain decision: C adopted for Opportunity 1.2.0** — `evidence` removed from the Opportunity evaluator's allowed strategic domains (not narrowed); genuine proof-building belongs in the domain whose condition changes (commercial proof → commercial; audience proof → audience; athletic validation → athletic); the shared enum stays intact for older contracts and Objective compatibility — an evaluator taxonomy change, not a global enum deletion.

**Positive-control refinement:** affirmative completeness alone is not sufficient. Two independent conditions must hold — (1) *epistemic validity*: affirmative evidence establishes that the athlete-world condition really exists (a complete source may establish that she genuinely lacks demonstrated outcomes; prevents MISSING → NONE); (2) *strategic validity*: the evaluator must still establish why changing that condition would alter her strategic position — a complete zero is evidence, not automatically a deficiency; the candidate must independently satisfy FIX / GROW / UNLOCK / AMPLIFY / MAINTAIN. The synthetic control passes because both hold, not because completeness is declared.

Next: the 1.2.0 ceremony and one forcing call on the #640 treatment input (`docs/audits/opportunity-1.2.0-knowledge-boundary-forcing.md`).

## 17. Ceremony and forcing call (27 Sep 2026)

`opportunity-eval-spec/1.2.0` (digest `7416ff47…`) and `opportunity-map/1.2.0` by ceremony; the shared enum intact; the narrow structural refusal of `domain: evidence`; the two-condition proof rule in the text. Re-gate: all 23 recorded artifacts refuse structurally — 35 refusals, exactly the 35 historical evidence-domain openings, grounding unchanged. One forcing call on the #640 treatment input — `docs/audits/opportunity-1.2.0-knowledge-boundary-forcing.md`: the Adidas UNLOCK eliminated, nothing re-dressed (zero hits for connect / share contract / verify / reconcile / cannot-see / material gap across the complete output), three State-grounded athlete-world openings remain (cadence carried at 0.75; gorjana with `ctx[5]` as support and no urgency; academic-tech positioning as a re-read UNLOCK), 9/9 citations resolved, both gates 0. All eight acceptance conditions met; semantic-instruction success, backstop not needed. **P6 is supported at the experimental architecture level.**

## 18. Closure (27 Sep 2026, reviewed) — Opportunity 1.2.0 / P6 closed at the experimental architecture level

**The resulting architecture, recorded.**
- **Strategic Opportunity:** an athlete-world strategic condition worth FIX / GROW / UNLOCK / AMPLIFY / MAINTAIN; State-grounded; Context and responsive evidence may support the interpretation.
- **Nomila-world knowledge gap:** a deficiency in Nomila's knowledge, records, observation or verification is not an Opportunity regardless of domain; athlete participation does not transform it; recording an event is not the event; Nomila's counts describe Nomila's records unless completeness is affirmatively established.
- **Genuine proof-building:** requires both epistemic validity (affirmative evidence establishes the athlete-world condition) and strategic validity (changing it independently satisfies normal Opportunity semantics); completeness alone does not manufacture a deficiency.
- **Routing:** rejected epistemic candidates create nothing; if a Decision later requires the information: Decision → REQUEST_INTELLIGENCE → Intelligence Request.
- **Taxonomy:** `evidence` is no longer an allowed Opportunity 1.2.0 strategic domain; the shared historical enum stays intact for compatibility.
- **Identity:** the map remains a snapshot; key stabilization remains conservative adjacent-snapshot normalization, not durable identity; no lifecycle or governance.

**The forcing experiment, accepted.** The strongest evidence is not that the structural gate can reject `domain: evidence`; it is that the live 1.2.0 evaluator itself stopped producing the epistemic Adidas opening and did not re-dress it under another domain — the semantic contract did the intended work. No further Opportunity provider calls now.

**Recorded, not acted on:** (1) the unindexed `commercialPosition.inbound` citation — citation/grounding precision pressure (backlog R11); (2) **Opportunity feasibility must not become an execution recommendation** — an Opportunity may explain why a condition is feasible or supported, never prescribe the next execution step (replying to a specific inbound); Opportunity = what strategic condition exists, Brain = what Nomila should do about it now (backlog R12; watch for recurrence; 1.2.0 not amended).

**Stopped:** no 1.2.1, no second call, no repeatability matrix, no lifecycle, no mounting, no automatic Intelligence Requests. **Opportunity 1.2.0 is frozen.**
