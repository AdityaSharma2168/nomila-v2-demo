# 07 · Studio — Creative Intelligence vs creative execution, audited at pinned SHAs (Agent G)

Read-only audit, written 2026-09-27. The branch manifest and the 48-row capability table are in
`14-studio-inventory.md`; this file is the narrative, the key trace, the outputs and the re-verified priors.

**Pinned refs**
- **Canonical Studio = `origin/main` `9fff9b15`.** Every Studio PR through #607 is on main (14 §A).
- **Brain stack = `3f0139f6`.** It adds the CreativeIntent/Campaign seam to Studio: `server/studio/creative/**`,
  `routes/campaignGovernance.ts`, and small lineage edits.
- **Dev Cloud Run runs image `202771d3`**, the parent of `3f0139f6`, which differs from it by 5 script/doc files.
- **Unmerged Studio work:**
  - PR #507: the acceptance harness.
  - PR #567: two classifier guard fixes plus client dev flags.

**Method**
- Three read-only sub-sweeps (models/QA/video; publish/library/lineage; planning/direction/CreativeIntent). Their key
  cites were spot-checked by hand:
  - `qa/verdict.ts:20-24`
  - `publish/eligibility.ts:103-109`
  - `generate.ts:1426-1447`
  - `creative/interpret.ts:35`
  - `direction/propose.ts:153-160,309-311`
  - `studioFlag.ts:32-36`
- Dev DB SELECTs (script `_audit_q_G_outputs.ts`, deleted).
- `gcloud run services describe nomila-v2` (read-only).

---

## 1. Summary

1. **Studio execution is broad and real on main and on dev, but has run only on test accounts.**
   - BUILT · MAIN · deployed-dev · `STUDIO_ALL_ON=true`.
   - What exists: image generate/edit (Vertex `gemini-3-pro-image`); i2v (Vertex `veo-3.1-generate-001`); b-roll t2v
     (OpenRouter `bytedance/seedance-2.0-fast`); ffmpeg stitch with captions, beds and stills-in-motion; SAM-3 masks; an
     identity pack; spend quotes and caps; a clearance state machine; Instagram Reels publish.
   - Dev DB: 548 `generation_jobs`. **498 of them belong to the Studio engineer's test athlete and 50 to Mia**
     (`select a.full_name, … count(*) from generation_jobs g join athletes a … group by …`).
2. **The athlete is Studio's only source of creative intent. Nothing Nomila decides flows into Studio's "what to make".**
   - Creative Intelligence here is MISSING · MAIN (planner inputs at `routes/studio.ts:2308`).
   - Studio planning reads four things: her sentence, an objective code from a closed list of six (`brief.ts:72-78`), her
     tagged library, and a CampaignBrief she supplies.
   - It reads no Recommendations, Objectives, Opportunities, Athlete State or Context. The only athlete fact it reads is
     `athletes.sport` (`agent/library.ts:123-125`, `direction/moment.ts:382-384`).
3. **What Creative Intelligence Studio does have is interpretation of an ask it is given, not a decision about what to make.**
   - BUILT · MAIN · `STUDIO_AGENT` / `STUDIO_BRAND_PROFILES`.
   - Concepts: `agent/concepts.ts`.
   - `propose_campaign`: `direction/propose.ts`, on `gemini-3.1-pro-preview`.
   - `research_moment`: a Google-grounded search, `direction/moment.ts:397`.
   - Brief summarise.
   - Planner asset mix: `agent/plan.ts`, GEMINI.pro, T=0.6.
   - "When" is MISSING: trend is an honest stub (`direction/trend.ts:2-6`) and fixtures return `[]`
     (`client/hooks/use-studio-pending.ts:294-297`).
4. **The CreativeIntent seam exists only on the Brain stack. Its interpretation step fails for any real athlete ask.**
   - PARTIAL · OPEN_PR #657 · `STUDIO_CREATIVE_INTENTS`.
   - `interpretCreativeIntent` passes `objective: intent.purpose`, which is her verbatim words (`creative/interpret.ts:35`).
   - `proposeCampaign.readInput` accepts only a `BRIEF_GOALS` code (`direction/propose.ts:157-160`) and otherwise returns
     `invalid_input`. The route turns that into HTTP 502 (`creative/routes.ts:36-39`).
   - The slice's end-to-end test mocks `proposeCampaign` (`server/routes/studio.creative.test.ts:18`), so this is untested.
5. **Contradiction with `00-control.md`: `STUDIO_CREATIVE_INTENTS` and `STUDIO_CAMPAIGN_GOVERNANCE` are effectively ON on dev.**
   - Both flags read through `studioFlag()` (`server/studio/config.ts:1080-1082` [stack]). That helper turns a flag on
     under `STUDIO_ALL_ON=true` unless the flag's own line says `"false"` (`studioFlag.ts:32-36`).
   - The live dev service has `STUDIO_ALL_ON=true` and no line for either flag (gcloud describe; `gcp/cloud-run-dev.yaml:425-426`).
   - So the Mila tool `request_creative` is declared (`mila/registry.ts:52`), `/studio/creative/*` is live, and
     `/campaigns/*` governance is live.
   - Meanwhile Brain readiness reads the raw `=== "true"` and reports governance as off (`executionReadiness.ts:56,68`).
   - None of it has been exercised: `creative_intents`, `creative_interpretations` and `campaigns` all have 0 rows.
6. **No Recommendation reaches Studio in data, only as provenance, and only through an operator script.**
   - The path: `routeGoverned` → `createCampaignFromOrigin` (`services/brainLoopDurable.ts:86-104`, called only from
     `server/scripts/intelligence/brainLoopDurable.ts:108`, behind `BRAIN_SUBSTRATE_LOOP`) → spec approval route →
     `materializeCreativeIntents` (`campaign/materialize.ts:26-48`).
   - The client has no UI for campaigns or creative intents (grep of `client/` finds no `creativeIntent` and no
     `/campaigns`). Contract works; the product cannot execute it from the app.
7. **QA is measured but never enforced.**
   - BUILT · MAIN · observation-only.
   - `qa/verdict.ts:20-24` says "IT GATES NOTHING", and `generate.ts:1428-1446` calls `succeedJob` whatever the verdict.
   - Dev holds 245 verdicts in `media_assets.metadata.creative_qa`:
     - the test athlete: 198 pass, 17 fail, 14 flag;
     - Mia: 14 pass, 1 fail, 1 flag.
8. **Publish works end to end but is off, video-only, and immediate.**
   - BUILT · MAIN · `STUDIO_PUBLISH_MODE` unset on dev and prod.
   - One live Reel was published on 2026-09-25 from the test account. `studio_publish_jobs` holds 1 `live/succeeded` and
     1 `dry/succeeded` row; `content_posts` holds 1 row. The post was later deleted (`docs/probes/ship.md`, commit
     `84ce1d8f`).
   - There is no post scheduling (`publish/routes.ts:306-332`) and no image or carousel publish
     (`publish/eligibility.ts:108`).
9. **Outcome read-back for Studio posts is absent on main.**
   - On the stack it is EXPERIMENTAL · unmounted: `published_asset_identities` (0 rows) + `observationsForAsset`, and
     `attribution.ts:2` calls itself "experimental and unmounted".
10. **The deal → deliverable → asset link has no writer.**
    - PARTIAL · MAIN. `deal_deliverables` has 0 rows. `media_assets.deal_deliverable_id` is marked "NO CODE WRITES THIS YET"
      (`shared/schema.ts:1521`). A plan-row `deal_deliverable_id` never reaches the job or the asset.
11. **Brief fidelity is lossy past the planner.**
    - PARTIAL · MAIN, measured by the engineer's own flow census (`docs/probes/flow-eval.md` §0, §2.1).
    - Past the planner, only tone/style/energy/aesthetic/concept/constraints survive, and only into **video** prompts
      under `STUDIO_BRIEF_CARRIER`.
    - Image generate still receives no campaign or constraints: there is no `campaign` or `carrier` reference in
      `compile/image.ts`.
12. **Mia's real use is edit-and-generate on her photos, not planned content.**
    - 50 jobs. Asks include "change the background of this to a soccer stadium", "Change this outfit to be wearing a
      pantsuit", "create a photo of mia playing soccer in a game that can be used an an adidas ad".
    - Every Mia job has `origin 'system'` and `objective 'grow-following'`.
    - Mia has 0 `studio_plans`, 1 session, 0 identity profile, and 0 published assets.
13. **Two classifier safety fixes are not on main.**
    - UNMERGED_BRANCH · PR #567 OPEN.
    - `70343d0d` stops an ask on her photo from routing to generate; "make her look older" produced an aged rendering.
    - `b4a7d764` stops body modifications and skin-tone "looks" routing around the guard: "remove my scar"; "make her
      look darker skinned".
    - `git grep SKIN_WORDS 9fff9b15` finds nothing.
14. **Prod: Studio is off (`STUDIO_ENABLED="false"`, `gcp/cloud-run-prod.yaml:338-339`), but prod already has the Studio schema.**
    - Per the engineer's ledger, 11 Studio migrations (0054–0067) were applied to prod by hand on 2026-09-25
      (`docs/runbooks/studio-flip.md` §1; `docs/probes/ship.md` ADI-S20-STEP9). CANNOT VERIFY (prod not touched).
    - The flip is waiting on Mia's decision (`studio-flip.md` §2).

---

## 2. The Studio system as built (status · location · flag)

Full table with cites: `14-studio-inventory.md` §C, rows 1–48.

**Models and providers actually called** (`server/studio/**`)

| Use | Model | Cite |
|---|---|---|
| Image generate and edit | `gemini-3-pro-image` via Vertex; an OpenRouter path also exists | `adapters/vertex.ts:184`, `openrouter.ts:123` |
| i2v | `veo-3.1-generate-001` | `vertex.ts:283` |
| b-roll t2v | `bytedance/seedance-2.0-fast` | `openrouter.ts:285` |
| Transition | `kwaivgi/kling-v3.0-std`, only when `lastFrame` is set | `config.ts:206-219` |
| Masks | `fal-ai/sam-3/image` | `fal.ts:207` |
| Crop | `local/sharp-crop` | — |
| Embeddings | `multimodalembedding@001` | `qa/embed.ts:45-48` |
| Planner and `propose_campaign` | `gemini-3.1-pro-preview` | — |
| Interpreter, reference decomposition, summarise, auto-mask, all vision QA, clip QA, video tagging, edit recommend | `gemini-3.5-flash` | — |

Dev DB confirms the models that actually ran:
- `vertex/gemini-3-pro-image` (+ `local/sharp-crop`)
- `vertex/veo-3.1-generate-001`
- `openrouter/bytedance/seedance-2.0-fast`
- `openrouter/kwaivgi/kling-v3.0-std` (2 Mia rows, failed/canceled)

Not used anywhere: OpenAI, Kimi, WaveSpeed, Imagen (grep of `server/studio`; Imagen is documented as retired at
`autoMask.ts:16-18`).

**Entry points**

| Entry point | Gate |
|---|---|
| Studio tab: Now · Made · Video · Board | `StudioHomeScreen.tsx:159-176` |
| Create Anything threads | `STUDIO_SESSIONS` |
| Agent door | `EXPO_PUBLIC_STUDIO_AGENT` |
| Brand post with direction doors | `STUDIO_AGENT` + `STUDIO_BRAND_PROFILES` (`directionLogic.ts:509-523`) |
| Carousel | — |
| Mila `request_creative` | stack; flag-gated |

**Object chain**

1. `CampaignBrief` (`campaign-brief/1`)
2. `BriefProposal` (`direction/envelope.ts`)
3. `studio_plans` (items / look / music / gaps, plus concept and confirm)
4. `BriefInput` / `CreativeBrief` (frozen onto `studio_generation_previews` and `generation_jobs.brief`)
5. `ShotSpec` (`types.ts:213-231`, compile-time)
6. model call
7. `media_assets` (`origin 'generated'`, `approval_status`)
8. `studio_publish_jobs` / `content_posts`

EditSpec does not exist; edits carry `FrozenEditIntent`/`StudioEditOp`.

**Gates that exist, in order:**
1. `STUDIO_ENABLED` + auth + athlete
2. Priced single-use preview (`previewStore.ts:57,263-278`)
3. Fresh requote and caps (`spendCaps.ts:160-200`): per-job $30 on dev, $5 on prod, $10 default; rolling day $25 default
4. Clearance (`approval.ts:47-145`)
5. Publish: mode × row mode, IG scope, approved asset (`publish/eligibility.ts`, `runner.ts:355-376`)

QA is not a gate.

---

## 3. Creative Intelligence vs creative execution — scored

| Question CI must answer | What exists | Side / status |
|---|---|---|
| **What** should she make? | Only what she types. Concepts and `propose_campaign` generate 2–3 *interpretations* of her ask or objective code. | CI-interpretation BUILT · MAIN. CI-decision MISSING |
| **Why** (which Objective or Campaign)? | Studio's "objective" is a closed code she picks: announce, showcase-product, grow-following, concept, recap, thank-partner (`brief.ts:72-78`). No Brain Objective is read. On the stack, a CreativeIntent can carry `lineage.recommendationId/campaignId` (ids only, `resolve.ts:57-61`). | MISSING on main; SEAM (ids only) on the stack |
| **For whom** (audience)? | `athleteContext.audience` reaches the *image* prompt as `AUDIENCE:` at generation time (`compile/image.ts:122-123`, `brief.ts:858-890`), after the idea is fixed. It is not an input to planning. | EXEC-context BUILT; CI MISSING |
| **When** (moment, fixtures, trend)? | `research_moment` does an ad hoc web search when she asks. There are no fixtures (stub `[]`) and no trend (stub). There is no scheduling. | PARTIAL (ad hoc) / MISSING |
| **Connected to what context**? | No read of Context Intelligence, State, Opportunity. | MISSING |
| Asset mix within one idea | The planner (`agent/plan.ts`, 9 doctrine rules), blind-scored (§5) | BUILT · MAIN |
| Given a brief/reference, make it | Everything in 14 §C rows 14–35 | EXEC BUILT · MAIN |

**How much of each exists.** Execution is roughly 25 of 29 execution capabilities BUILT on main (14 §C tally). Creative
Intelligence splits in two:
- **Interpretation / asset-mix: BUILT.** Five capabilities, all of which need the athlete to supply the idea.
- **Strategic CI: MISSING in Studio.** This means deciding what, why, for whom and when from Objectives, Campaigns and
  context.

The stack's CreativeIntent is the designed entry for strategic CI. It is a contract and lineage, not an engine, and its
interpretation call is broken in code (§1 item 4).

**Nothing on an unmerged branch changes this.** The only unmerged Studio work is the acceptance harness (#507) and two
classifier guard fixes (#567); neither touches CI.

---

## 4. THE KEY TRACE — "Nomila decides Mia should create piece X tomorrow"

Legend: **FLOWS** = a code path moves the data today · **CONTRACT** = a type, table or adapter exists, but no live path
carries data (or it is unmounted/off) · **NONE** = neither exists.

| # | Handoff | Status · location · flag | Does data flow? | Evidence |
|---|---|---|---|---|
| 1 | Recommendation / context → content planning | CONTRACT · OPEN_PR · `BRAIN_SUBSTRATE_LOOP` + operator script | **No content flows.** Only a campaign-shaped Recommendation becomes a Campaign row (ids + purpose), via `routeGoverned`. A single-post Recommendation has no route to Studio. The content planner is deliberately not productionised. | `services/brainLoopDurable.ts:86-104`; `scripts/intelligence/brainLoopDurable.ts:108`; dev: 0 campaigns |
| 2 | Content planning → creative strategy | NONE | No content planner exists in production. Campaign → CreativeIntent[] fires only on spec approval. | `campaign/materialize.ts:26-48` [stack]; `routes/campaignGovernance.ts:53-59` [stack] |
| 3 | Creative strategy → concept | CONTRACT (stack) / FLOWS only from her own ask (main) | On the stack, `interpretCreativeIntent` → `proposeCampaign` **fails `invalid_input` for free-text purpose**. On main, concepts/proposals run only from her typed ask plus a picked objective code. | `creative/interpret.ts:35`; `propose.ts:157-160`; `agent/concepts.ts:156` |
| 4 | Concept → CreativeIntent | CONTRACT · OPEN_PR · `STUDIO_CREATIVE_INTENTS` (effectively on on dev) | The door exists (Mila tool + HTTP), but there is no client UI and 0 rows. The order is intent → concept, not concept → intent. | `creative/door.ts:31-41` [stack]; `mila/registry.ts:52` [stack] |
| 5 | CreativeIntent → brief | CONTRACT · OPEN_PR | `resolveCreativeIntentForBrief` builds `BriefInput` from a *confirmed* interpretation, which can't be produced (see #3). Tested only with the mock. | `creative/resolve.ts:38-63` [stack]; `studio.creative.test.ts:18` |
| 6 | Brief → references | FLOWS · MAIN · `STUDIO_BRIEF_CARRIER` / `STUDIO_STYLE_SPEC` | Her references and decomposed style reach the plan. Past the planner, only the video templates render them; `references[].assetId` and `jobCampaign.objective` are carried and read by nothing. | `campaign/carrier.ts:65-69,196-217`; flow-eval census DEAD rows |
| 7 | → Athlete identity / media | FLOWS · MAIN · `STUDIO_IDENTITY_PACK`, `STUDIO_LIBRARY_FIELDS` | Library assembly and casting are real. Mia has **0** identity pack; the only one is the test athlete's. | `agent/library.ts:291`; `agent/cast.ts:368`; dev: `identity_profiles` = 1 row |
| 8 | → Product / brand assets | PARTIAL · MAIN | Product photos and brand marks flow. Brand research reaches only the flag-off single-photo path and the ad interpreter; Board/carousel send the brand *name* only. `studio_brand_profiles` has no writer. | `brief.ts:899-931`; `interpret/ad.ts:193-215`; flow-eval §2.10 |
| 9 | → Generation plan | FLOWS · MAIN · `STUDIO_AGENT` | The planner makes ≤6 items with capabilities, and the caster maps them onto her assets. | `agent/plan.ts:479-520`; `routes/studio.ts:2574-2593` |
| 10 | → Model selection | FLOWS · MAIN | By task and shot type: identity → Veo, b-roll → Seedance, image → Nano Banana Pro. The job row pins provider and model. | `config.ts:121-221`; `video/shotType.ts:81-89`; `videoRunner.ts:194-239` |
| 11 | → Generation / edit | FLOWS · MAIN · deployed-dev | 548 jobs on dev (all `origin 'system'`, 0 with `creative_intent_id`). | dev DB `generation_jobs` |
| 12 | → QA | FLOWS (observation) · MAIN · `STUDIO_CREATIVE_QA` | Verdicts are written and shown (`STUDIO_QA_DISPLAY`) and **gate nothing**. `clip.reroll` has no reader. | `qa/verdict.ts:20-24`; `generate.ts:1428-1446`; flow-eval §2.11 |
| 13 | → Approval | FLOWS · MAIN | Spend approval (priced preview) plus asset clearance. There is no athlete approval of *what to make* (that stage lives only in the stack's confirm step, which is unreachable per #3). | `previewStore.ts:263-278`; `approval.ts:47-145` |
| 14 | → Schedule / publish | Publish FLOWS · MAIN but **off** (`STUDIO_PUBLISH_MODE` unset); schedule **NONE** | Immediate Reels-only publish, proven once on the test account. There is no "tomorrow": no `scheduled_at`, and fixtures are a stub. | `publish/routes.ts:306-332`; `eligibility.ts:108`; `use-studio-pending.ts:294-297` |
| 15 | → Analytics | CONTRACT · OPEN_PR (unmounted) | `recordPublishedIdentity` is written on a real post (stack); the attribution reader is unmounted. 0 rows. Main has nothing. | `publish/runner.ts:141-146` [stack]; `attribution.ts:2` [stack] |

**Answer.** Of the 15 handoffs:
- **The execution half (#6–#13) is real code that moves data today, on main and deployed to dev.**
- **Publish (#14) is real but switched off, and there is no scheduling.**
- **Everything upstream of the brief (#1–#5) is contract only.** It lives on an open PR stack, has no client UI and no
  rows, and its one live interpretation call rejects real athlete asks.
- **Analytics (#15) is an unmounted contract.**

So: if Nomila decided tonight that Mia should post X tomorrow, nothing in the codebase would carry that decision into
Studio. It would take Mia opening Studio and typing X herself. From there, a finished, spend-capped, clearance-gated
asset is real. A same-day Instagram Reel is possible only after `STUDIO_PUBLISH_MODE=live` is set. Scheduling for
tomorrow is not possible.

---

## 5. Actual outputs and their quality evidence

Dev DB, read-only, queried 2026-09-27.

**Volume**

| Thing | Studio engineer's test athlete | Mia | Other |
|---|---|---|---|
| `generation_jobs` | 498 | 50 | — |
| Generated `media_assets` | 381 draft images, 110 draft videos, 4 approved images, 2 approved videos, 1 rejected | 18 draft images, 8 draft videos, 1 rejected | none posted from generation |
| `studio_plans` | 93 | 0 | — |
| `studio_stitch_jobs` (all succeeded) | 47 | 0 | — |
| `studio_sessions` | 68 | 1 | — |

- `generation_jobs` objective: `grow-following` 513, `showcase-product` 30, `recap` 4, `announce` 1.
- `generation_jobs` brand: 544 with none; 4 `adidas`.
- Estimated spend: ≈ $56.54 + $19.87 + $48.00 + … by the quote (`cost_estimated_usd`). Billed `cost_usd` was recorded on
  only two groups ($2.52, $0.67), because video jobs never write `cost_usd`.

**Mia's outputs**
- 50 jobs, 2026-08-31 → 2026-09-21. Mostly edits of her photos (background → stadium, uniform recolours, earrings →
  "these gold hoops", "remove all the nike signs from this") and a few generates.
- Veo/Seedance clips on 2026-09-21.
- QA on her assets: 14 pass, 1 fail, 1 flag.
- None cleared or published.
- The 2026-08-31 ask was "create a photo of mia playing soccer in a game that can be used an an adidas ad" (deliverable
  `ad`).

**gorjana concept work**
- No Mia job references gorjana (`brief::text ilike '%gorjana%'` → 0 for Mia; 1 row overall, not Mia's).
- The "Laws of Layering" VTO / athlete-ad pipeline is **not in this repo**: no WaveSpeed/qwen/flux reference in `server/`,
  `client/`, `scripts/`.
- The seam checkpoint (§15) records "no LoRA/VTO in v2". The only gorjana artefacts in v2 are client copy/fixtures
  (`StudioContentStrip.tsx:5`, `AssetViewer.tsx:77`).

**Evals (the engineer's ledgers; run files live in gitignored `probe-out/`, so only the markdown aggregates are verifiable here)**

- **Flow census** (`docs/probes/flow-eval.md`, generated block): 432 rows.
  - Flags on: 320 CONSUMED/DECIDES, 81 DISPLAY, 13 DELIBERATE-DEAD, 18 DEAD.
  - Flags off: 87 DEAD.
  - All `qaVerdict` rows (34) are DISPLAY or DEAD.
- **S-1 concept eval** (13 briefs, 26 planner calls, ceiling $1.95). The engineer's blind medians against the registered
  predictions:

  | Criterion | Median | Registered | Result |
  |---|---|---|---|
  | relevance | 5 | ≥ 4 | held |
  | groundable | 3 | ≥ 3 | held |
  | non-generic | 4 | 3 | "MISS" |
  | deterministic distinctness | 39/39 | ≥ 80% | held |

- **S-2 plan eval** (12 briefs × 3, 42 calls, $3.15 revised quote). Pooled means:

  | Criterion | Mean |
  |---|---|
  | i2v_reserved | 3.47 |
  | stills_where_carried | 3.78 |
  | real_clips_used | 4.83 |
  | broll_earned | 4.31 |
  | product_rules | 4.47 |
  | overall_mix | 4.75 |
  | relevance | 3.67 |

  - Weakest criterion: 16 of 22 cast i2v (73%) were placed on a made-here still (`flow-eval.md` S-2, K40).
  - The briefs are the engineer's fixtures, run under the engineer's athlete id. None is a Nomila-originated brief.
- **Enrich eval** (`docs/probes/enrich-eval.md`): a video-tagging quality grid with fix passes 1–2. It measures tagging,
  not creative output.
- **Live publish proof:** 1 Reel on the test account on 2026-09-25, later deleted (`ship.md`, commit `84ce1d8f`).

No output anywhere was produced from a Nomila-originated idea: 0 rows with `creative_intent_id`, and 0 `origin 'athlete'`
or `'inbound'` jobs.

---

## 6. Prior findings re-verified

| Prior finding | Source | Verdict | Evidence |
|---|---|---|---|
| Slice is "Behind `STUDIO_CREATIVE_INTENTS` (off everywhere)" | `creative-intent-slice.md` header, §15 | **SUPERSEDED on dev** | Read via `studioFlag` + dev `STUDIO_ALL_ON=true`, no explicit false (`config.ts:1080` [stack]; gcloud describe) |
| "Does the direct athlete path work end to end through preview? **Yes.**" | slice §12 | **PARTIALLY SUPERSEDED** | True only with `proposeCampaign` mocked (`studio.creative.test.ts:18`). The real `readInput` rejects free-text `objective` (`propose.ts:157-160`; `interpret.ts:35`) |
| No server-side Context reader yields fixtures; moment is null | slice §3, §13 | STILL TRUE | `use-studio-pending.ts:294-297`; `door.ts` passes `moment ?? null` |
| `studio_plans.confirm` is record-only | slice §13, forcing §12.3, seam §7 | STILL TRUE | flow-eval census DEAD row `studioPlans:confirm` (written `plans.ts:117`, read by nothing) |
| `BriefOrigin` lacks `athlete` | forcing §9.1, seam §15 | SUPERSEDED on the stack / STILL TRUE on main | `brief.ts:66` [stack] |
| `written`/`other` have no Studio executor | forcing §9.2, slice §10 | STILL TRUE | 422 path in the preview route [stack] |
| Nothing in Studio reads a Recommendation | seam §12 | STILL TRUE | §3 above; no reader in `server/studio/agent/*`, `direction/*` |
| `deal_deliverables` has zero writer | seam §15 | STILL TRUE | 0 rows; `schema.ts:1521` |
| No LoRA/VTO in v2 | seam §15 | STILL TRUE | no WaveSpeed/qwen/flux reference in `server/ client/ scripts/` |
| `ShotSpec` at `studio/types.ts:213`; no `EditSpec`/`AssetSpec` | seam §7, §10–11 | STILL TRUE | `types.ts:213-231` |
| No FK joins a job to its plan | seam §16 | STILL TRUE on main; stack adds `creative_intent_id` only | `schema.ts:1675-1749` |
| Publish needs `approved` + row `live` + `STUDIO_PUBLISH_MODE=live` | seam §12 | STILL TRUE | `runner.ts:355-376`; `eligibility.ts` |
| First CI output = `BriefProposal` from direction tools behind `brandProfilesEnabled()` | seam §7, §15 | STILL TRUE (shape); the path from an intent is broken (§1 item 4) | `direction/envelope.ts`; `propose.ts:308` |
| Brand text reaches the image model unfenced (K1) | `flow-eval.md` §0.1 | SUPERSEDED | `compile/image.ts:160-167` and `compile/assemble.ts:217-223` fence it |
| Recommend puts brief lines unfenced (K2) | `flow-eval.md` §0.2 | PARTIALLY SUPERSEDED | Fenced only with `STUDIO_STYLE_SPEC` on (`edit/recommend.ts:72`); on under ALL_ON on dev, off by default elsewhere |
| Composer slots stripped on the Board (K3) | `flow-eval.md` §0.3 | SUPERSEDED | `storyboardRun.ts:112-122` passes `composer` (PR 15.1 #589) |
| Generated image never runs the classifier | `flow-eval.md` §0.4 | STILL TRUE | preview classify is gated on `parsed.intent === "image.edit"` (`routes/studio.ts:1272-1277`) |
| Her brief/constraints never reach image generate | `flow-eval.md` §0.5–0.6 | STILL TRUE at `9fff9b15` | no `campaign`/`carrier` reference in `compile/image.ts` or the preview image path. The R5 ruling assigned it to image-parity (#594); not found in code |
| QA is display-only and gates nothing | `flow-eval.md` §2.11 | STILL TRUE | `qa/verdict.ts:20-24`; `generate.ts:1446` |
| Generated assets fall off the library after page 1 (null `posted_at`) | `flow-eval.md` §0.10 | STILL TRUE | `routes/media.ts:176-183` ("null-posted_at tail is a v1 simplification") |
| "There is no `getAthleteContext()`" | `docs/studio-inventory-findings.md` TL;DR 4 (2026-08-27) | SUPERSEDED | `server/services/athleteContext.ts`, read by `brief.ts:36` |
| `content_posts` = 0 rows | same, TL;DR 3 | SUPERSEDED | 1 row (the live test Reel) |
| Planner on GEMINI.pro at T=0.6 | `docs/plans/studio-plan-doctrine.md` §0 | STILL TRUE | `agent/config.ts:25-26`; `plan.ts:847` |
| Athlete Ad Studio / gorjana VTO pipeline (WaveSpeed, nano-banana) | project memory notes | CANNOT VERIFY at this manifest | Not in this repo (grep empty); said to live in another repo |
| Studio migrations applied to prod by hand | `docs/probes/ship.md` ADI-S20-STEP9; `studio-flip.md` §1 | CANNOT VERIFY at this manifest | Prod is out of bounds for this audit |

---

## 7. UNKNOWNs

- **Whether `/studio/creative/*` and `/campaigns/*` actually answer on dev.**
  - The code and live env imply ON (§1 item 5).
  - To settle: an authenticated GET `/api/v1/me/studio/creative/intents/<uuid>` on dev. A 404 "Not found" means off; any
    other 404 or 200 means on. The probe is read-only but needs an athlete token.
- **Whether `STUDIO_PUBLISH_MODE` was set on dev at the 2026-09-25 live post.**
  - It is absent now, from both yaml and the live env.
  - To settle: Cloud Run revision history for 2026-09-25, or `ship.md`'s raw step-8 log.
- **Whether PR #300's extra commit (`4ae27fdf`) was re-landed.**
  - To settle: a content diff against `compile/image.ts`.
- **Real billed cost of Studio on dev.**
  - `cost_usd` is null on video and on most images; the JSONL cost log is local to wherever the server ran.
  - To settle: the Vertex/OpenRouter billing export.
- **S-1/S-2 per-cell run files.**
  - Only the aggregates are committed, since `probe-out/` is gitignored.
  - To settle: the engineer's `probe-out/flow-eval/runs/` and the blind-score workbook.
- **Whether Studio tables exist on prod.**
  - To settle: the ledger claim, checked read-only by someone authorised on prod.

## 8. Open questions for the founder

1. **Which door should strategic creative work come through first?**
   - Options: a Brain Recommendation (single piece, not campaign-shaped), the Campaign spec, or Mia's own ask.
   - Today only a campaign-shaped Recommendation has even a contract path, via an operator script. A "post X tomorrow"
     Recommendation has none.
2. **Should `STUDIO_CREATIVE_INTENTS` / `STUDIO_CAMPAIGN_GOVERNANCE` be exempt from the `STUDIO_ALL_ON` master?**
   - They are Brain-stack gates, and today they are silently on in dev.
   - Their `studioFlag` reading contradicts the "off everywhere" comments (`config.ts:1079-1081` [stack]) and the Brain
     readiness reader.
3. **Should QA verdicts ever gate clearance or publish, or stay advisory?**
   - The code deliberately defers this to "a later flag at a DIFFERENT call site" (`qa/verdict.ts:23-24`).
4. **Is post scheduling in scope for Studio or for the planner?**
   - Studio has client time-slot logic that waits on a fixtures feed that does not exist.
5. **PR #567 carries the two classifier guard fixes (skin tone, body modification, ask-on-photo-never-generate). Should
   they land before any prod flip?**
