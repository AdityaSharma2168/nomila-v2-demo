# PR 14 — Carrier: the brief past the planner

Branch `studio/brief-carrier`, cut from `origin/main` @ `93ff0765` (PR 13 merged, #583) and REBASED onto
`e7e53f06` (#584, library-fields-madehere) on 2026-09-24 — zero conflicts (merge-tree forecast, then a clean
rebase). Every "main" cite below is against 93ff0765 unless marked; on e7e53f06 the only cited file #584
touched is `routes/studio.ts` (+4 net lines, all above line 642: an import at :180, `readOwnedImage` :597-606,
`resolveReferences` :642), so every `routes/studio.ts` cite past line 642 reads +4 on the new base
(e.g. `UUID_RE :966` → `:970`, the preview `input` literal `:1369` → `:1373`, `AGENT_BODY_KEYS :2144` → `:2148`,
replan `:2608` → `:2612`). Cites ≤ 642 and every other file's cites are unchanged. Planner prompt fingerprint at tip (`agent/eval/runs.ts promptFingerprint`):
**`d83f3357960a`** (the eval ledger's last cited run was `774d403e4051` on 2026-09-22; it has moved since, on
PR 10's profile line and PR 13 — not this PR).

## Phase R — claims (recon, nothing built)

### C1 — BriefInput and PreviewRequest; where each generation path builds them

- `BriefInput` — `server/studio/brief.ts:276-336`. Fields: athleteId, brandId, origin, objective, deliverable,
  mode, source, ask, lastFrame, durationSeconds, audio, shot, direction, references. **No field for campaign,
  tone, constraints, concept or reference readings.** `BriefJob` (`:366-441`) mirrors it plus `editIntent`.
  `assembleBrief` builds the job at `:917-945`, copying each optional field with the additive
  `...(x ? { x } : {})` pattern (no key when absent — the "frozen before this existed" rule, `:395-399`).
- **`PreviewRequest` is a CLIENT type**, `client/hooks/use-studio.ts:268-311` (intent, deliverable, objective,
  direction, brandId, sourceAssetId, regions, durationSeconds, audio, references[{assetId, role, label}],
  lastFrameAssetId, shot). Its server twin is `PreviewBody`, `server/routes/studio.ts:347-387`, parsed by
  `parsePreviewBody :389`. No server type is named PreviewRequest.
- Builders of `BriefInput` (non-test): the preview route `routes/studio.ts:1369-1404` (the only one the Board
  and the brand flow reach) and the edit engine `server/studio/edit/engine.ts:302-312` (R-10: do not touch).
- `generate.ts` takes a finished `CreativeBrief` (`RunStudioGenerationInput.brief :179`), builds none.
  `video/spec.ts` and `stitchJobs.ts` are the stitch side: a `StitchSpec` of clips already generated
  (`spec.ts:143`, `toStitchRequest :645`); no brief is built or read there.
- grep `campaign|concept|constraints` → `brief.ts` 4 hits, all doc-comment/enum (`:54,:70,:438,:611`);
  `generate.ts` 6, all comments (`:4-9,:526`); `preview.ts` 0; `video/spec.ts` 0; `stitchJobs.ts` 0;
  `client/screens/studio/storyboardRun.ts` 0; `createAnythingLogic.ts` 0. **Expected 0 in code: holds.**
- Spend-time replay: `videoRunner.ts inputsFor :96-110` reads `job.brief` and passes NO options — "only what
  is on the brief survives to here". So the carrier must be ON `BriefJob`, not an option (same argument as
  `durationSeconds`, `brief.ts:379-391`).

### C2 — the video templates the brand flow uses, and the compile goldens

- `video/prompts.ts` `VideoTemplateName :74-78` = `identity-static :305`, `identity-pose :317`,
  `transition-first-last :353`, `broll-no-marks :363`. Chosen in `videoPromptFor :433-467` by `ShotType`.
  **There is no product template**: a row whose reference is a product/object/brand-imagery is "not a
  person" (`video/shotType.ts:85`) and routes `broll` → `broll-no-marks`. So "i2v, broll, product, bridge"
  = identity-static/pose, broll-no-marks (twice), transition-first-last.
- What each renders: identity-* = opener + `directionBlock` + MOVEMENT_ON_HER line + IDENTITY_PRESERVATION +
  OUTPUT_DISCIPLINE (`:305-329`); broll = opener + camera/framing/movement line + `settingLine` +
  directionBlock + BROLL_EMPTINESS + OUTPUT_DISCIPLINE (`:363-397`); bridge = the probe's spine +
  directionBlock + TRANSITION_CONTINUITY + OUTPUT_DISCIPLINE (`:353-361`, names no destination on purpose).
  `SOUND_CLAUSE :414-419` appended by `withSound :421` only when `brief.job.audio === true`.
  **No feel/tone/constraints line in any of the four.** `directionBlock :97-107` is the only brief text and
  it fences `untrusted` direction as `<requester_brief>`.
- Video goldens: `video/prompts.golden.json`, 8 cells (identity-static, identity-pose, broll-no-marks,
  identity-static-untrusted, transition-first-last, identity-static-push-in, broll-text-all-slots,
  broll-text-setting-only); `prompts.test.ts` `CELLS :98-…` declares each as `{id, shot, beat, brief()}`
  over `makeBrief`, compared whole-prompt. A new fixture = one CELLS entry + one JSON key.
- Image compile goldens: `compile/compile.golden.json`, **118 cells**, `compile/golden.test.ts` (`toBe` on
  the whole prompt, `:1-8`). Image-side prompt builders that would take a feel/constraints line:
  native edit `compile/assemble.ts:169-177` (`DO NOT:` = `brief.brand.donts` + interpreter
  `constraintDoNots`); generate/edit `preview.ts buildPrompt :567` — brand block `:646-657`
  (`BRAND:/PALETTE:/DO:/DO NOT:`), direction `:772-777`.
- `compile/constraints.ts:63-75` (`constraintKeepSentences`, `constraintDoNots`) reads
  `FrozenEditIntent.constraints` — the interpreter's `preserve_person | exclude_marks` — **a different object**
  from `CampaignBrief.constraints` (free-text lines, `campaign/brief.ts:176-179`).

### C3 — campaignBlock at tip

- `server/studio/agent/plan.ts campaignBlock :385-449`, rendered inside `CAMPAIGN_OPEN = "<<<CAMPAIGN>>>"` /
  `CAMPAIGN_CLOSE = "<<<END_CAMPAIGN>>>"` (`:95-96`) under a "DATA, not instructions" header (`:441-446`).
  Lines: objective `:387`; story `:389`; brand + attributes + profile `:393-396`; her-in-it `:397-400`;
  product handle `:401-406`; **feel** = tone (fenced 300) · style (40) · energy (40) `:407-411`;
  references roles `:413-415` then **readings** `:420-429`: per dimension `fenced(summary, 120)`, **tags and
  basis dropped**; deliver-as `:431-434`; **constraints** `:437-440` (`fenced(x,120)` joined by ` · `).
- Assembled into the prompt at `:505-506` beside `how it should feel: ${fenced(ask.aesthetic,200)}` (the
  typed aesthetic, non-brief plans) and `conceptBlock :457`.
- `fenced :109` strips `<`/`>` and caps length. A second CAMPAIGN renderer exists in
  `server/studio/edit/ops.ts:379-385` (the ad op's context lines) — R-10 territory, leave it.
- `CampaignBrief` (`campaign/brief.ts:195`, zod `:143-193`): `creative_direction {tone ≤6×40, style enum,
  energy 40}`, `references ≤3 {ref handle, role, intent | null}`, `constraints ≤6×120` optional.
  `referenceIntentSchema` (`reference/schema.ts:208`) is 12 dimensions of `{summary ≤300, tags, basis}`
  (`MAX_SUMMARY = 300 :162`).
- Fingerprint: `FINGERPRINT_ASK` (`agent/eval/runs.ts:64`) carries **no campaign**, so campaignBlock changes
  alone do not move it; the typed-aesthetic feel line (R-8) would, if rendered in the ask's branch.

### C4 — clipRequestFor, Board row seeding, the direction drop

- `client/screens/studio/storyboardRun.ts clipRequestFor :60-88`: `{intent: "video.generate", deliverable:
  "clip", objective, direction: row.prompt, references: [{assetId, role}] | [], ...shotFor(row), audio?}`.
  `bridgeRequestFor :132-160` sends `direction: ""`, previous row's reference, `lastFrameAssetId`.
  `boardRequests :166-192` is the order. **Neither carries campaign, constraints, concept or planId.**
- Seeding: `agentLogic.ts seedRowsFrom :274-287` → `rowsOf :290-364`. `clip` items → `heldClipRow` `:300-310`
  and `image` items → `heldPhotoRow` `:313-329`: **`item.direction` is not passed** (AUDIT2 F23). Only
  words-only b-roll `:336-347` and i2v/product `:352-363` carry `prompt: item.direction`.
  `AgentPlanItem.direction` exists on every item (`server/studio/agent/types.ts:278`).
- The Board already knows its stored plan: `storyboardLogic.ts:386 planId`, `StoryboardTab.tsx:779
  setBoardPlanId`; and PR 10's music-suggest route reads that row by id **under her athlete id**
  (`routes/studio.ts` at `/studio/stitch/music/suggest`: `readPlan(athleteId, planId)`,
  `agent/plans.ts readPlan :68-79`). That is the tenancy-safe precedent for the carrier.

### R-6 recon — ref_N → asset

- `studio_reference_analyses` (`shared/schema.ts:2139-2170`): `athlete_id`, `source_asset_id` (nullable,
  exactly one of asset/text by CHECK `:2166`), `role`, `decomposition` jsonb.
- `ref_1` is minted client-side of the plan by the direction engine: `direction/decompose.ts:367`
  (`references: [{ ref: "ref_1", role, intent }]`), with `analysisId` on the tool result (`:86,:469`).
  The plan route validates handles for uniqueness only (`campaign/brief.ts:184-190`) and resolves the
  **product** handle by position (`routes/studio.ts:2238-2244`); `ref_N` is never resolved. The reference
  image is by design not handed to the planner (`campaign/brief.ts:25-26`).

### R-1 / R-8 recon

- POST `/studio/agent/plan` → `planFromBody(req, res, body)` `routes/studio.ts:2149-2153`; replan
  `:2608` composes a body from the stored row (`:2653 campaign: row.brief`) and calls the same function.
  `AGENT_BODY_KEYS :2144` includes `campaign`, `concept`, `confirm`. Campaign is gated `:2226` on
  `brandProfilesEnabled()` (`server/studio/config.ts:1299`), validated `:2232-2245`, passed to the planner
  `:2380` and saved `:2452`. GET `/studio/agent/plans/:id` `:2542` returns brief, concept, prompt,
  aesthetic, objective, confirm.
- Flags: `STUDIO_BRAND_PROFILES` read only at `config.ts:1300`; client `EXPO_PUBLIC_STUDIO_BRAND_PROFILES`
  at `client/lib/flags.ts:93-94`. Gates are documented in those two files' comments (no docs page lists
  them; `docs/*.md` grep for STUDIO_NATIVE_EDIT → 0). `BRIEF_CARRIER` grep across server/client/docs → 0.
  **`.env.development` is deny-listed for this session — I cannot read or edit it; that line is Adi's.**
- Concept readers downstream: grep `concept` in `agent/cast.ts`, `compile/*.ts`, `video/stitch.ts`,
  `video/plan.ts`, client `boardStitch.ts`/`stitchLogic.ts` → **0**. Stored at `studio_plans.concept`
  (`schema.ts:2192`), read by `conceptBlock` only.

### C5 — ref_N: minted, validated, never resolved

- Minted by the direction engine: `direction/decompose.ts:21` (the map) and `:367` (`references: [{ ref: "ref_1",
  role, intent }]`) — the pasted `:313-346` is `proposalFromDecomposition`'s body, where `intent =
  d.reference_intent` (`:313`). The analysis id stays server-side: `DecomposeToolResult.analysisId :86,:469`
  is never written to the wire (`direction/routes.ts answerDecomposition`: only `X-Studio-Reference-Asset-Id`
  for a stored link, `res.json(r.proposal)`). The client renders the intent and never edits it
  (`directionLogic.ts:239-249 describeReference`).
- Validated: `campaign/brief.ts:151-162` (handle, role, `intent: referenceIntentSchema.nullable()`), uniqueness
  `:184-190`; route `routes/studio.ts:2232-2245` validates, resolves the PRODUCT handle by position
  `:2238-2244`, and does nothing with `ref_N`. grep for a resolution on the plan route → **0**.
- Resolvable: `studio_reference_analyses` (`schema.ts:2139-2170`) — `athlete_id :2141`, `source_asset_id :2147`
  (nullable; one of asset/text by CHECK `:2166`), `role :2151`, `decomposition :2153` = the validated
  `{ schema, reference_intent, commercial_style }` (`reference/schema.ts:210-216`, inserted
  `reference/decompose.ts:340-354`). The brief's `intent` IS `decomposition.reference_intent`, unedited, so
  jsonb equality identifies the row: `athlete_id = hers AND role = r.role AND
  decomposition->'reference_intent' = intent::jsonb`, newest first.
- **Where resolution happens: at save, on the plan route** (preferred by the ruling; picked). The row is
  then self-contained — the preview route reads `brief.references[].assetId` off the row and runs no
  second lookup. Save-time also means a re-plan re-resolves from its own posted brief. Read-time would
  re-query on every clip quote and depend on the analyses row still existing.
- **Can the analyses row be deleted out from under it? Yes.** `source_asset_id … onDelete: "cascade"`
  (`schema.ts:2147`): her photo deleted → the reading row goes. The plan row's `assetId` then names a
  media asset that no longer exists. That is the same dangling class as `brief.product.ref` on a
  photo she later removes (handled today by the client dropping the handle, `agentLogic.ts:596-604`),
  and it is inert until something hands the asset to compile — nothing does (R-6: no slot for a style
  or composition role). Any future consumer must re-read the asset under her athlete id
  (`readOwnedImage`), as `lastFrameAssetId` does.
- The stored form: `references[i].assetId` (server-set, uuid, optional) beside `ref`. A client-posted
  `assetId` on a reference is refused at the plan route; the replan route strips it from the stored
  brief before re-posting so the child row re-resolves.

### C6 — the music-suggest precedent, verbatim

`routes/studio.ts` `POST /studio/stitch/music/suggest`:
```ts
const athleteId = req.athleteId as string;
const planId = typeof req.body?.planId === "string" && UUID_RE.test(req.body.planId) ? req.body.planId.toLowerCase() : null;
if (planId) {
  const { readPlan } = await import("../studio/agent/plans.js");
  const row = await readPlan(athleteId, planId);
  if (!row) { res.status(404).json({ error: "That plan isn't one of yours." }); return; }
  ...
```
`readPlan(athleteId, id)` (`agent/plans.ts:68-79`) filters `and(eq(id), eq(athlete_id, athleteId))`.
`UUID_RE` is `routes/studio.ts:966`. Reused as-is on the preview route.

### C7 — a non-brief plan's row after PR 13

`studio_plans` (`schema.ts:2180-2220`): `brief jsonb` null, `concept jsonb` null or `{id, angle, feeling, line}`,
`prompt text`, `aesthetic text`, `objective text`, `confirm jsonb` (`:2192-2207`). `savePlan` writes
`prompt/aesthetic/objective/confirm` from the route (`plans.ts:114-117`), so a MakeIt/Agent plan with
no campaign still remembers her typed aesthetic and the purpose. The carrier for such a row: `feel` from
`aesthetic` only (R-8), `objective`, `concept` if picked — no tone triple, no constraints, no readings.

### C8 — the concept's shape and its one line

`PlanConcept` (`agent/types.ts:155-160`): `{ id: "A"|"B"|"C", angle, feeling, line }`; validated on the plan
route by `readConcept` (`routes/studio.ts:2292-2300`) and stored verbatim (`:2454`). `conceptBlock`
(`plan.ts:457-468`) renders `concept A: angle — feeling` then `line`. On the clip request it becomes ONE
fenced line: `concept: <angle> — <feeling>: <line>` (each part through `fenced`, ≤ 60/60/200).

### C9 — pre-registered §5.0 rows

REVIVED by this PR (verdicts in the Flow closure section):
1. tone triple / style / energy → generator
2. `brief.constraints` → clip request / compile
3. reference readings: tags + basis; summaries untruncated (≤300)
4. `references[].ref` handle → asset
5. `concept` → clip request (as one fenced line)
6. `direction` on image and clip rows

Left for others: `capabilities` composition/motion (PR-D / PR 15), `editing_rhythm`/`music.onBeat` join
(PR 15), tagger fields → picker (PR-H), `face_visibility`/`role` (PR-H / PR 17), beats for a chosen clip
(PR-E), QA verdict → reader (PR-G), cost line ↔ ids (PR-G), human verdict ↔ identity (PR-I / PR 17),
reading → edit-consumable style spec (PR-J / PR 18). PR-A and PR-B rows: landed by PRs 10 and 13.

### Predictions (pre-registered)

P-feel, P-donot, P-tags, P-off (8 video + 118 image goldens byte-identical; fingerprint = d83f3357960a
with the fixture's campaign absent — see R-7 note: the fixture GAINS a campaign, so the reported
"new" fingerprint is the fixture's, and the flag-off pin is the 8+118 goldens), P-planid, P-noplan, P-ref,
P-flow (REVIVED count = 6).

## Phase B — what was built

Tip cites are against this branch (`studio/brief-carrier`); "main" cites are origin/main @ 93ff0765.

### Server

- **`server/studio/campaign/carrier.ts` (new)** — the fence pair (`CAMPAIGN_OPEN/CLOSE`) and `fenced` moved
  here from `agent/plan.ts` (plan.ts re-exports both, so `edit/ops.ts` and every test import are unchanged);
  `JobCampaign` (planId, tone, style, energy, constraints, concept line, aesthetic, objective,
  references[{ref, role, intent, assetId}]); `carrierFromPlan(row, campaignParts)` — pure, reads the plan
  row, validates the stored brief with the same strict schema, returns null for a row with nothing; and
  `carrierBlock(c, {feel})` — the render: a DATA header, the fence, `feel:` / `how it should feel:` /
  `concept:` / `constraint:` lines, every value through `fenced`. `feel: false` = constraints alone.
- **`server/studio/campaign/resolveRefs.ts` (new)** — `resolveReferenceAssets(athleteId, brief)`: one SELECT
  per reference on `studio_reference_analyses` under `athlete_id`, same `role`, `decomposition->
  'reference_intent' = intent::jsonb`, newest first → `references[i].assetId`. `stripReferenceAssets`
  (replan) and `postsReferenceAsset` (the route's refusal).
- **`campaign/brief.ts`** — `references[].assetId: uuid optional` (server-set; schema stays strict).
- **`brief.ts`** — `BriefInput.campaign?` and `BriefJob.campaign?` (`JobCampaign`); `assembleBrief` copies
  it additively (`...(input.campaign ? { campaign } : {})`), so absent is no key.
- **`config.ts`** — `briefCarrierEnabled()` ← `STUDIO_BRIEF_CARRIER`, documented beside the other gates.
- **`agent/plan.ts`** — `campaignBlock` readings: `dimension: <summary ≤300> [tags] (basis)` (R-7).
- **`agent/eval/runs.ts`** — `FINGERPRINT_ASK.campaign`: one reading with tags + basis, one constraint. The
  only file in `agent/eval` touched. **Fingerprint: d83f3357960a → `0ebb8528a218`**, pinned in
  `plan.test.ts`.
- **`video/prompts.ts`** — `carrierLines(brief, feel)` after `directionBlock` in identity-static,
  identity-pose and broll-no-marks (`feel: true`); transition-first-last takes `feel: false`.
  `prompts.golden.json`: 8 cells unmoved (git diff: 71 insertions, 0 deletions), 4 new: `broll-campaign`,
  `identity-static-campaign`, `transition-constraints-only`, `broll-feel-from-her-aesthetic`.
- **`routes/studio.ts`** — preview: `parsePreviewBody` refuses `campaign` (400 unknown field) and shapes
  `planId` (uuid); the route 400s `planId` with the flag off, else `readPlan(athleteId, planId)` → 404
  "That plan isn't one of yours." before `hasBeenScored` and before any model, then
  `carrierFromPlan(row, brandProfilesEnabled())` onto `input.campaign`. Plan route: a posted
  `references[].assetId` is a 400; `campaign = await resolveReferenceAssets(athleteId, v.brief)` before the
  planner and the save. Replan: `campaign: stripReferenceAssets(row.brief)`.
- No DDL. The carrier lives in `generation_jobs.brief` / `studio_generation_previews.brief` jsonb (`job.campaign`)
  and in `studio_plans.brief` jsonb (`references[].assetId`).
- Image compile (`compile/`, `preview.ts buildPrompt`) is untouched: an image preview never carries a
  planId today, and R-3 names the video templates. 118 image goldens: zero moves (golden.test unchanged).

### Client

- `lib/flags.ts` — `STUDIO_BRIEF_CARRIER` ← `EXPO_PUBLIC_STUDIO_BRIEF_CARRIER`.
- `hooks/use-studio.ts` — `PreviewRequest.planId?`.
- `storyboardRun.ts` — `clipRequestFor(row, objective, planId = null)`, `bridgeRequestFor(…, planId = null)`,
  `boardRequests(rows, objective, planId = null)`: `planId` rides only when given.
- `storyboardLogic.ts` — `StoryboardRow.direction?` (data; held rows only); `boardSignature(rows, objective,
  planId = null)` — the plan id is in every request, so it is in the quote key (the chip-tap rule).
- `agentLogic.ts` — `withDirection`: held photo and clip rows keep `item.direction` as `direction`.
- `StoryboardTab.tsx` — `carrierPlanId = STUDIO_BRIEF_CARRIER ? boardPlanId : null` into `boardRequests`
  and `boardSignature`. `AgentScreen.tsx` — the estimate passes `plan.answer.planId` the same way.
- **R-11 check:** the identity-pack worktree (`studio/identity-pack` @ 93ff0765) has no edits yet. The client
  files this PR touches are `storyboardRun.ts:60-92,:132-165,:166-192`, `storyboardLogic.ts` (row type + `boardSignature`),
  `agentLogic.ts:290-300` (`withDirection`), `StoryboardTab.tsx:359-370`, `AgentScreen.tsx:360-368`,
  `use-studio.ts:300-310`. If PR 17's chooser hook lands in any of these, that is the meeting line.

### Not done, and why

- `.env.development` — every read of it is deny-listed in this session; the line
  `STUDIO_BRIEF_CARRIER=false` / `EXPO_PUBLIC_STUDIO_BRIEF_CARRIER=false` is Adi's to add.
- The reference IMAGE still does not reach compile (R-6): a style/composition role has no slot. The resolved
  `assetId` is stored for PR 18.
- The 12-dimension readings ride on `job.campaign.references[].intent` but are NOT rendered in a clip prompt
  (PR 18's style spec decides how). The planner gets them in full (R-7).

## Phase M — mutations, red by name

| Mutation | Where it reds |
|---|---|
| tone triple absent from the b-roll prompt | prompts.test "P-feel …", golden `broll-campaign` |
| a brief do-not absent from the clip request | storyboardRun.test "every clip request carries planId…"; studio.generate.test "P-feel / P-donot…" |
| reading tags dropped at campaignBlock | plan.test "P-tags…"; studio.agent.test "P-ref…" (asserts the tags line) |
| constraint text reaches the model as instruction, not data | prompts.test "P-donot …" (nothing outside the fence) + "a constraint that tries to close the fence…"; carrier.test "every line sits inside the fence" + "a hostile constraint…" |
| carrier renders with STUDIO_BRIEF_CARRIER off | studio.generate.test "P-off…"; the 8 original video goldens |
| a clip request with another athlete's planId is served | studio.generate.test "P-planid…" |
| a client-posted campaign object is accepted | studio.generate.test "a client-posted campaign object is refused…" |
| ref_N handle reaches compile unresolved | resolveRefs.test "P-ref…"; studio.agent.test "P-ref…"; carrier.test "a stored reference's resolved asset rides…" |
| concept line absent from the clip request | studio.generate.test "P-feel / P-donot…" (`concept:` on the brief and in the fence); carrier.test "the concept she picked becomes one line" |
| direction dropped on an image row | agentLogic.test "keeps the planner's direction on a held photo…" |
| an image compile golden moved | compile/golden.test — 118 cells, file untouched |
| fingerprint unchanged after campaignBlock changed | plan.test "the planner fingerprint is pinned: 0ebb8528a218" |

Also pinned: "a client-posted reference assetId is stored" (studio.agent.test), "ref_N resolves to another
athlete's reading" (resolveRefs.test + studio.agent.test), the quote key moves with planId
(storyboardLogic.test).

## Flow closure — AUDIT2 §5.0 re-run against this tip

| Field / signal | Verdict | Where |
|---|---|---|
| `brief.output.{type,aspect_ratio,platform}` | REVIVED (PR 10) | `brandLogic.ts confirmedOutput`, `plan.ts:431-434` |
| `brief.product` (confirmed) | REVIVED (PR 10) | `brandLogic.ts confirmedProduct` |
| `brief.objective.goal` → `isBrandWork` | REVIVED (PR 10) | `music/suggest.ts brandWorkFor`, `plan.ts` |
| `identity_priority` maximum/standard | REVIVED (PR 10) | `directionLogic.ts` |
| `brand.profile` | REVIVED (PR 10) | `plan.ts:393-396` |
| `referenceAssetId` (brand post) | REVIVED/DELETED (PR 10) | per PR 10's ledger |
| her words / aesthetic / objective on the plan row | REVIVED (PR 13) | `schema.ts:2201-2207`, `plans.ts:114-117` |
| re-plan from the stored brief | REVIVED (PR 13) | `routes/studio.ts` replan route |
| confirm-step flags / basis | REVIVED (PR 13, stored) | `studio_plans.confirm` |
| **tone triple / style / energy → generator** | **REVIVED (this PR)** | `carrier.ts carrierFromPlan` → `brief.ts` `job.campaign` → `prompts.ts carrierLines` (identity-static/pose, broll); golden `broll-campaign` line `feel: calm, focused · documentary · energy steady` |
| **`brief.constraints` → clip request / compile** | **REVIVED (this PR)** | `storyboardRun.ts clipRequestFor/bridgeRequestFor` (planId) → `routes/studio.ts` preview (row read) → `job.campaign.constraints` → `carrierBlock` `constraint:` lines on all four templates |
| **reference readings: tags + basis; 120-char summaries** | **REVIVED (this PR)** | `plan.ts campaignBlock` readings loop: `summary ≤300 [tags] (basis)`; the full intent also rides on `job.campaign.references[].intent` |
| **`references[].ref` handle → asset** | **REVIVED (this PR)** | `resolveRefs.ts` on the plan route at save → `studio_plans.brief.references[].assetId` → `job.campaign.references[].assetId`. Not yet handed to compile (no slot for the role; PR 18) |
| **`concept` → cast/compile/stitch** | **REVIVED to the clip request (this PR)** | `carrier.ts conceptLine` → `job.campaign.concept` → `concept:` line on identity/broll. Cast and stitch readers: PR 15 |
| **`direction` on image and clip rows** | **REVIVED as data (this PR)** | `agentLogic.ts withDirection` → `StoryboardRow.direction`. Reader: PR 15 (stitch) |
| `capabilities` composition/motion; camera 5/11, movement 7/11, lighting 9/11 | still DEAD | prose only in `capabilities.ts`; owner PR 15 |
| `editing_rhythm` / `music.onBeat` → a join | still DEAD | `boardStitch.ts`/`stitchLogic.ts` (R-10); owner PR 15 |
| tagger fields (11) → planner; any tag → picker | REVIVED (PR 12, `libraryFieldsEnabled`) / picker per PR 12's ledger | `library.ts` |
| `face_visibility`, `role` | still DEAD in a reader | owner PR 17 (identity-pack) |
| beats for a chosen clip; saved plan after a read | still DEAD | owner PR-E |
| QA verdict → any reader | REVIVED (PR 11 display) | `qaDisplayEnabled` |
| cost line ↔ job/preview/asset ids | still DEAD | owner PR-G |
| human verdict ↔ identity observation; discarded edit bytes | still DEAD | owner PR 17 / PR-I |
| reading → edit-consumable style spec; style role | still DEAD | owner PR 18 (the `assetId` this PR stores is its input) |

P-flow: 6 rows REVIVED by this PR, matching C9's list.

## Gate — measured on the tip (2026-09-24)

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npx tsc --noEmit -p tsconfig.jest.json` | exit 0 (the tests type-check) |
| `npm run lint` | 74 errors in 36 files, **none in a file this PR touches**; my changed files: 0 errors |
| `npm run check:format` | red on main (~728 files); the 4 new files are prettier-clean; the 5 touched files that were clean on main were re-formatted; the 7 that were dirty on main were left as they were |
| `npm test` (bare, whole suite, one run) | every batch `N passed, N total`: **286 suites, 4618 tests, 0 red**, no FAIL line (summaries read, not `$?`) |
| Scoped, run directly with jest: `campaign/` (3 suites, 42), `prompts.test` + `plan.test` + `agent/eval` + `compile/golden.test` (9 suites, 289), `studio.generate.test` (29), `studio.agent.test` (81), the 3 client suites (agentLogic 36, storyboardRun, storyboardLogic) | all green |

Predictions: P-feel ✓ (golden `broll-campaign` + route test), P-donot ✓, P-tags ✓ (plan.test + the real plan route), P-off ✓
(8 video goldens + 118 image goldens unmoved; flag-off preview byte-identical), P-planid ✓ (404, no preview row),
P-noplan ✓, P-ref ✓ (PGlite + the real plan route; another athlete's identical reading is not resolved),
P-flow ✓ (6 rows REVIVED = C9's list).

Fingerprint: **d83f3357960a → 0ebb8528a218**, pinned in plan.test. PR 16 baselines after this PR.

Two reds on the way, both mine, both in new assertions (not in code): a forged `DIRECTION:` inside the fence
was counted as a second direction; `not.toContain("feel:")` matched "how it should feel:". Three existing
client row-shape tests (`toEqual` on held rows) gained the `direction` field they now carry — R-5, on purpose.
One real defect caught by the gate: the resolver first imported `@shared/schema`, which jest does not map;
now the relative path every `server/studio` module uses.

## UI check for Adi (quoted, $0 unless run)

1. **The compiled prompt, dumped ($0, done):** `probe-out/brief-carrier/broll-campaign.prompt.txt` and
   `transition-constraints-only.prompt.txt` — the b-roll one carries `feel: calm, focused · documentary ·
   energy steady` and `constraint: do not show a competitor's logo` inside the fence, after DIRECTION and
   before the emptiness clause.
2. **The reference-inheritance walk (live, Adi's):** flags on (`STUDIO_BRIEF_CARRIER`, `STUDIO_BRAND_PROFILES`,
   `STUDIO_AGENT` + the EXPO twins) → brand post → decompose one reference photo → confirm → plan → open the
   Board → run ONE b-roll clip. Quote: one preview ($0) + one seedance-fast b-roll at the Board's own figure
   (~$0.30–0.60 for 5 s; the Board shows the exact number before the tap). Read the clip's job row `brief.job.campaign`
   (the readings ride there) and judge by eye whether the shot carries the reading. The planner is the only
   consumer of the reading today, so the judgement is of the planner's word choice, as F29 said.

## Post-rebase gate (tip 5d1cfa49 on e7e53f06, 2026-09-24)

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` / `-p tsconfig.jest.json` | exit 0 / exit 0 |
| Scoped, direct jest: `studio.generate.test`, `studio.agent.test`, `referenceGate.test`, `campaign/` | 6 suites, 162 tests, 0 red |
| `npm test` (bare, whole suite, one run) | **286 suites, 4558 tests, 1 red**: `affiliationSync.test.ts` — the house flake (~1 in 3 on main). Re-run in isolation twice: 8/8, 8/8. Every other batch `N passed, N total`. |

## UI check — walk 1, the brief door (live, 2026-09-24)

Over HTTP against the worktree's server with the five flags on. Files in `probe-out/brief-carrier/walk1-*`
(gitignored): the confirmed brief, the plan answer, both previews, both compiled prompts, the diff, the job, the
clip and two frames.

- **propose-campaign** (one Pro call) → proposals; the confirm edits as a client would make them: tone triple
  `hushed, cobalt, unhurried`, energy `slow-burn`, one do-not `do not show any bottle label other than
  Solstice`, output video/9:16.
- **plan** → `336a66df…`: five items — two b-roll from words, three casts of her own clips. The planner's first
  b-roll direction already carries the triple in its own words ("hushed, empty city street bathed in deep
  cobalt-blue morning twilight … unhurried").
- **preview with planId** ($0): the compiled b-roll prompt = the no-planId prompt + exactly the fenced block
  (diff: 9 lines, all additions — header, fence, `feel: hushed, cobalt, unhurried · sports_campaign · energy
  slow-burn`, `how it should feel: …`, `concept: …`, `constraint: do not show any bottle label other than
  Solstice`). Quote $0.3667, seedance-2.0-fast, 4 s 720x1280 — identical on both previews (the carrier is not
  a price term).
- **generate** (Adi approved): job `975b33ef…` succeeded in ~3 min; 720x1280, 4.04 s, 1.6 MB; quotedUsd
  0.3667 (basis estimated). Frames at 0.2 s and 2 s. **Not graded here** — Adi judges by eye.
- Note for the eye: the first proposal's concept was "Playful morning balance", so the fence carries a playful
  concept line beside a hushed tone triple — as confirmed, on purpose, so the tension is visible.
