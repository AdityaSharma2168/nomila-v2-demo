# PR 15 — Composer intelligence — ledger

Worktree `composer`, branch `studio/composer` off origin/main **639d8d44** (PR #586 identity-pack merged).
AUDIT2.md was pinned at c8242e07; since then #577 … #586 merged, including **PR 14 (#585, e2950e5a) and
PR 17 (#586, 639d8d44) — both are already under this branch**, so Phase R runs against a tip that carries
the carrier and the reading. No rebase onto PR 14 is pending; a rebase is only needed if main moves.
Artifacts (none yet) go under gitignored `probe-out/composer/`. Phase R: read-only, $0, no jest, no
server, no DB.

`git status` at cut: only `server/scripts/calibration/runs/blind-eval/blind-eval-2026-09-14.zip` dirty —
the known gitattributes quirk; never staged.

## Phase R — claims

Verdicts: CONFIRMED / STALE (behaviour holds, line moved) / WRONG / PARTIAL. Every cite re-read at 639d8d44.

| # | Claim (block) | Verdict | At the tip |
|---|---|---|---|
| C1a | Position 0 is a cut: video/plan.ts:346-347, spec.ts:342-347 | **CONFIRMED** | `transitionIn: i === 0 ? {kind:"cut"} : (clip.transitionIn ?? {kind:"cut"})` video/plan.ts:346-347; spec.ts:341-348 refuses `clips[0].crossfadeSec` by field ("The first clip has nothing to fade from"); spec.ts:699-702 maps `crossfadeSec` → `{kind:"crossfade"}` else cut. |
| C1b | The fold: xfade vs concat, video/plan.ts:346-390 | **CONFIRMED** | Fold video/plan.ts:363-397: `crossfade` → `xfade=transition=fade:duration=d:offset=acc−d` :382 (+ `acrossfade` :385), must fit both sides :375-379; else `concat=n=2` :389 + `settb` :391. Only two join kinds exist on the wire: cut and crossfade (`StitchTransition`). |
| C1c | Default join is `DEFAULT_CROSSFADE_SEC` 0.5 s, stitchLogic.ts:240 | **STALE (−3), value CONFIRMED** | `export const DEFAULT_CROSSFADE_SEC = 0.5` stitchLogic.ts:237; `MAX_CROSSFADE_SEC = 2` :229 and spec.ts:118. |
| C1d | boardStitch decides joins at :136-138, :158-160, :184-190, :214-221 | **STALE (+4/+6/0/−2), behaviour CONFIRMED** | Still row: `items.length > 0 && !row.cutIn ? {crossfadeSec}` boardStitch.ts:140-142. Own clip row: :164-166. Generated piece: `fades = items.length>0 && kind==="clip" && bridgedRow !== key && !row.cutIn` :184-188, `bridgedRow` set :196. Passthrough: every join a fade :208. On-beat: :212-221 → beatLogic `snapToBeat`. |
| C1e | Every place a join is decided (not in block; the full list) | **new fact** | (1) boardStitch.ts:140-142/:164-166/:184-194/:208 — the Board's four sites; (2) beatLogic.ts:83-91 drops the fade on any join beside a still when on-beat; (3) stitchLogic.ts:390-401 `setCrossfade` — her Fade/Cut pill on the Video tab (TimelineBuilder.tsx:876-879), clip-to-clip; :487-496 `normalize` strips position 0; (4) storyboardLogic.ts:923-940 `cutAllowed`/`setCut` — the Board's Cut pill exists **only beside a held row** (still or clip); :965-979 `normalizeBoard` strips a Cut left elsewhere; (5) server: spec.ts:341-360 validates, :474-485 refuses a still shorter than its two fades, video/plan.ts:346-347 forces position 0. **Nothing reads a beat type, the music toggle (except for stills), or a reading.** |
| C2a | Ordering: plan.items → cast.ts:957 → agentLogic.ts:281 → boardStitch.ts:128 → video/plan.ts:300,346 | **STALE at cast (+14), rest CONFIRMED** | Pass 1 `plan.items.forEach` cast.ts:934; pass 2 `for (const [i, item] of plan.items.entries())` :971 → `items[]` in plan order; `seedRowsFrom` `items.flatMap((item, i) => rowsOf(...))` agentLogic.ts:281-286 (index-keyed `agent:<nonce>:<i>`); `for (const row of rows)` boardStitch.ts:128; `clips.forEach` video/plan.ts:299 conform, :346 transition, fold :363 in index order. No sort anywhere on the path. |
| C2b | As-is videos appended last: boardStitch.ts:202-208, storyboardLogic.ts:328-357 | **STALE (storyboardLogic +6), CONFIRMED** | boardStitch.ts:201-210 `for (const clip of passthrough)` after the row walk; `PassthroughClip` storyboardLogic.ts:338-341, `asIsVideos` :366-369 ("joins the stitch at the END, decided 21 Sep 2026" :335-336). A picked video WITH beats and `cut: true` instead travels to the planner and comes back as `clip` items at their planned position (:343-363). |
| C2c | Her manual reorder: stitchLogic.ts:372-380 `reorderTo` | **CONFIRMED** | stitchLogic.ts:372-381, `normalize` after; Board side `moveRow` storyboardLogic.ts:982 + `normalizeBoard`. Both strip a join at position 0. |
| C3a | CAPABILITY_LISTS :41-101 = 11/11/11/7/8 | **CONFIRMED** | capabilities.ts:41-100. camera 11, movement 11, lighting 11, composition 7, motion 8. |
| C3b | FRAMING_OF 6/11, MOVEMENT_OF 4/11, LIGHTING_OF 2/11 (:161-183) | **CONFIRMED** | :161-170 (wide, medium_wide, medium, close_up, extreme_close_up, macro), :171-178 (static, push_in, tracking, orbit), :179-184 (golden_hour, stadium). |
| C3c | composition and motion never slot; `toShotSpec` :191-204 | **CONFIRMED** | :192-204 reads camera/movement/lighting only. `ShotSpec` (types.ts:146-151, block says :141-146 → STALE +5) has framing · movement · lighting · environment; no composition, no motion. |
| C3d | Unmapped values ride as prose, `capabilityProse` :224-243 → cast.ts:960-961 | **STALE (−2 / +14), CONFIRMED** | `capabilityProse` capabilities.ts:222-237 emits `"<Axis>: <words>."` for every set value with no slot; cast.ts:974-979 `direction: prose ? \`${item.direction} ${prose}\` : item.direction` (and on a swap :1082). The client never sees `capabilities` — `AgentPlanItem` (use-studio.ts:680-766) carries `shot` only; the prose is already glued into `direction` → `row.prompt` (agentLogic.ts:358,:376) → `clipRequestFor.direction` (storyboardRun.ts:84) → `brief.job.direction` → `DIRECTION:` line in every template (prompts.ts:104). |
| C3e | "low_angle reaches the prompt and wide does not" | **PARTIAL** | True on an i2v / product row: `wide` → framing slot → dropped by the photo-row filter (C3f) and never phrased; `low_angle` → prose → prompt. **False on a photo-less b-roll row**: `wide` survives (`slotsAllowed` gives all four) and is phrased by `FRAMING_ON_SCENE` prompts.ts:400-402. |
| C3f | Photo-row slot filter storyboardLogic.ts:411-416 drops framing and lighting | **STALE (+12), PARTIAL (understated)** | `slotsAllowed` storyboardLogic.ts:423-428: a HELD row (still / own clip) keeps **nothing**; a photo row keeps **movement only** (drops framing, lighting **and environment**); a photo-less row keeps all four. Applied at seed `withPlannedShot` agentLogic.ts:387-399 (silent — the dropped slots vanish, no reason kept) and again at send `shotFor` storyboardRun.ts:110-118. Mirrors `slotRefusal` prompts.ts:285-304. |
| C3g | The unmapped table (per R-2) | **new fact** | camera 5 unmapped: pov, over_the_shoulder, low_angle, high_angle, overhead → prose "Camera: …". movement 7 unmapped: pull_out, dolly, crane, pan, tilt, handheld, whip_pan → prose "Camera movement: …". lighting 9 unmapped: natural, studio, hard_light, soft_light, rim_light, backlight, neon, low_key, high_key → prose "Light: …". composition 7/7 unmapped → prose "Composition: …". motion 8/8 unmapped → prose "Motion: …". **36 of 48 members leak as prose today; 12 slot.** Every leaked value reaches the prompt on every generated kind (i2v, product, b-roll) via the DIRECTION line — including a photo row, where the same value AS A SLOT would be refused (a `low_angle` reaches an i2v's prompt as prose while `wide` cannot as a slot: the leak path bypasses `slotRefusal`). |
| C3h | *(not in block)* Growing ShotSpec is not a types.ts-only change | **new fact — R-2 vs R-8 conflict** | `MOVEMENT_ON_HER`, `MOVEMENT_ON_SCENE`, `FRAMING_ON_SCENE`, `LIGHTING` are `Record<ShotX, string>` in **video/prompts.ts:225-254** — a new union member fails `tsc` there until it is phrased; `slotRefusal` :285-304 and `setSlots` :273-276 name the four slots; the client mirrors the vocabulary in `SHOT_SLOT_VALUES` use-studio.ts:252-264 (rendered as chips StoryboardTab.tsx:2034) and `slotsAllowed`. The route validates generically off `SHOT_SLOTS` (routes/studio.ts:537-547) — no route change. **prompts.ts is on R-8's do-not-touch list.** Decision needed (see D-1). |
| C4 | Where editing_rhythm arrives after PR 14 | **CONFIRMED as a NON-arrival — the seam does not exist** | The reading (`ReferenceIntent.editing_rhythm`, reference/schema.ts:127-140; "cut pace and transitions", prompt.ts:56-57; **no tag vocabulary** — `DIMENSION_VOCAB` :154-160 has no entry, so tags are `[]` always; a free summary ≤ 300 chars + basis) reaches exactly one consumer: the **planner prompt**, `campaignBlock` plan.ts:413-421 as prose. PR 14's carrier (`JobCampaign` campaign/carrier.ts:80-93, `references[].intent` :59-63) is frozen on the **generation brief** (brief.ts:346, :432) server-side per clip job — it never reaches the client, the Board row, or the stitch. `grep editing_rhythm client/ → 0`. The client DOES hold the reading elsewhere: on a fresh plan the Agent screen holds the confirmed `campaign` it posted (AgentScreen.tsx:447 `fromBrief?.campaign`); on a re-opened plan `GET /studio/agent/plans/:id` answers `brief: row.brief` (routes/studio.ts:2629) which `inheritFromStoredPlan` reads (agentLogic.ts:571-572). The POST plan answer carries **no** brief (:2529-2540). So the seam for R-1 is client-side: `campaign.references[].intent.editing_rhythm.summary` → a pure rule → `BoardSeed.rhythm` beside `music` (storyboardLogic.ts:397). |
| C5a | music.onBeat seeds a toggle only: agentLogic.ts:671, storyboardLogic.ts:398 | **STALE (+65 / −1), CONFIRMED** | `planSeedExtras` agentLogic.ts:730-739 → `BoardSeed.music.onBeat` storyboardLogic.ts:397 → `seededMusic` :408-411 (`touched: true`; a plan with no music leaves `onBeat: true, touched: false`) → StoryboardTab `music` state :307-309, pill :1415-1421, → `boardStitch(..., {bed, grid, onBeat})` :872-877. Planner asks for it plan.ts:578-579. |
| C5b | What on-beat snapping does: boardStitch.ts:184-190 | **WRONG cite, behaviour lives in beatLogic** | boardStitch.ts:184-190 is the generated-piece fade rule. Snapping is :212-221 → `snapToBeat` beatLogic.ts:72-142: **only when** a bed with a trusted grid (`firstBeatSec` non-null, tracks.ts:72) is chosen AND `holdLimits` are read; it (a) drops the crossfade on every join beside a still :83-91 (a clip-to-clip join keeps its fade), (b) moves each still's END to the nearest beat in whole frames :106-132, (c) marks `onBeat` per position; a position after a generated clip of unknown length is never called on the beat :135-139. Four beds, all with trusted grids (84 / 89.99 / 114.99 / 120 BPM). **It never chooses a join between two clips.** |
| C6 | B-roll construction (Audit B) | **new fact, see §B-roll below** | Planner rule 9 (plan.ts:260-263 — block's :271-274 is `NO_PRODUCT_RULE`, STALE) asks two/three sentences + all five capabilities; `capabilityBlock` :519 lists the entry (capabilityEntries.ts:376-400); parse nulls off-list values; cast glues unslotted prose (C3d); `toShotSpec` gives framing/movement/lighting where mapped; row → `clipRequestFor` direction + shot (b-roll keeps all four) → `broll-no-marks` prompts.ts:382-413: camera line (`FRAMING_ON_SCENE` + "One continuous take, no cut." + `MOVEMENT_ON_SCENE`) → `settingLine` (environment, lighting) → `DIRECTION:` → carrier → `BROLL_EMPTINESS` :190-192 → `OUTPUT_DISCIPLINE`. |
| C7a | Captions: closed vocab captions.ts, burn stitchRunner.ts:150-166 | **CONFIRMED** | `CAPTION_POSITIONS` :44-48, styles, colors, `CAPTION_MAX_CHARS = 60` :152, `CAPTION_MAX_LINES = 2` :153, `normalizeCaptionText` :233-254 (NFC, ≤2 lines, ≤60 code points, allowlisted ranges :182-193 minus holes :207-211), `captionCatalog` :257-291; `drawCaptions` stitchRunner.ts:150-167 (satori PNG → overlay). |
| C7b | Client editor stitchLogic.ts:71, :412-424 | **CONFIRMED (±2)** | `TimelineCaption` :71-79, `setCaption` :410-431. **The editor is `CaptionEditor` in TimelineBuilder.tsx:1649, mounted :828-840 — the VIDEO tab.** |
| C7c | R-5's four files: module beside music/suggest.ts, route beside music/suggest, hook beside use-studio-stitch.ts:377-407, chip in StoryboardTab's caption editor | **PARTIAL — the fourth file is WRONG** | suggest.ts is 140 lines, pure (:110-140); route `POST /studio/stitch/music/suggest` routes/studio.ts:3058-3065 (AUDIT2's :2850 is stale); hook `useMusicSuggestion` use-studio-stitch.ts:395-420. **StoryboardTab has no caption editor** — `grep caption StoryboardTab.tsx` → three `caption=` label props (:1545, :1743, :2106). Board rows carry no caption field (`StoryboardRow` storyboardLogic.ts:79-183) and `boardStitch` emits none. Captions exist only on the Video tab's `TimelineItem`. So the chip goes in **TimelineBuilder.tsx's `CaptionEditor`**, and a "row's sentences" input must come from the timeline items — which carry no sentence (assetId + trims only). See D-3. |
| C8 | Doctrine's current state: expected 0 | **WRONG — it is built, merged and tripwired** | `DOCTRINE_RULES` plan.ts:211-264, nine rules, merged in **#558** (d3e9a8c3, "doctrine, Half B", 22 Sep) from docs/plans/studio-plan-doctrine.md. The four Sept-21 rules map: (i) i2v reserved for simple beats = **rule 1** :213-215 ("ONE simple moment"); (ii) a real photo held when it carries the beat = **rule 2** :216-219 ("already IS the beat"); (iii) a real clip kept as-is = **rule 3** :220-228 ("Real footage first… as it is, or cut to that beat"); (iv) generated media deprioritised = **rule 5** :238-240 ('over "from: made here"… a last resort'), plus the grounding line :171-172 and cast.ts `fitsKind` S1 (a made-here still is never an i2v ref). Tripwires: plan.test.ts:477-527 one `it` holding all nine phrases (`PHRASES` :479-489) + v2 phrases; per-rule deletion reds **by phrase inside one test**, not by a test name per rule. Rule-3's own clause has a named test :996 and :1177. |
| C9 | Fingerprint baseline as of PR 14's report | **CONFIRMED** | `promptFingerprint()` = **0ebb8528a218** (was d83f3357960a), pinned plan.test.ts:1518-1520; `FINGERPRINT_ASK` runs.ts:64-114 carries one reading + one constraint. With R-3 needing no prompt change (C8), **this PR predicts the fingerprint unmoved.** |
| C10 | Flag pair does not exist yet | **CONFIRMED** | `grep STUDIO_COMPOSER` → 0. Server flags live in server/studio/config.ts (`qaDisplayEnabled` :1685 pattern) and enrich/config.ts; client twins in client/lib/flags.ts (:123-124 pattern); dev values in `.env.development` (EXPO_PUBLIC_* :4-13). Gates are documented per-PR in docs/probes/*.md (clip-reads.md, join-row.md), not in one index. |

## Phase R — the join rules at tip, as one table (C1e)

| Join into … | Today | Decided by |
|---|---|---|
| position 0 | cut | video/plan.ts:346-347; spec.ts:343-348 refuses a fade; normalize/normalizeBoard strip it client-side |
| a still row | 0.5 s fade, or cut if `cutIn` | boardStitch.ts:140-142; her Cut pill (only here and beside a clip row) |
| her own clip row | 0.5 s fade, or cut if `cutIn` | boardStitch.ts:164-166 |
| a generated clip after its own bridge | cut | boardStitch.ts:187 (`bridgedRow`) |
| a generated bridge itself | cut | boardStitch.ts:185 (`kind === "clip"` only fades) |
| a generated clip, otherwise | 0.5 s fade, or cut if `cutIn` (only possible beside a held row) | boardStitch.ts:184-188 |
| an as-is video (appended last) | 0.5 s fade, always | boardStitch.ts:208 — no Cut is possible here |
| any join beside a still, on the beat | fade dropped → cut | beatLogic.ts:83-91, only with a trusted grid + limits |
| Video tab, any position > 0 | her pill: Fade (0.5) / Cut / Bridge | stitchLogic.ts:390-401, TimelineBuilder.tsx:876-879 |

## B-roll — Audit B, ranked improvement list (evidence for Adi, nothing built here)

How a b-roll direction is built today: planner rule 9 + `capabilityBlock` → JSON `direction` (≤ 400 chars,
plan.ts:587) + `capabilities` (closed; off-list nulled + logged) → cast.ts:974-979 glues every unslotted
value as `"Axis: words."` onto the direction → row.prompt → `clipRequestFor` (direction + shot: framing,
movement, lighting, environment all allowed on a photo-less row) → `broll-no-marks` (prompts.ts:382-413).

1. **Composition and motion never reach the model as structure** (C3g): 15 members, all prose, appended
   AFTER her sentence — the template's own header says camera→scene→action→details is the order that
   holds and puts the camera line first; the prose lands last, after `DIRECTION:`. Evidence: prompts.ts:386-398
   vs cast.ts:979. Fix belongs to R-2 (slots) — after it, nothing composition/motion rides as prose.
2. **Nine lighting members have no slot** (natural, studio, hard/soft/rim/back-light, neon, low/high key):
   the planner writes `neon` and the prompt gets "Light: neon." as a trailing clause rather than the
   `settingLine` "The light is …" sentence. Same fix.
3. **The environment slot has no capability axis**: the planner cannot ask for `stadium` / `gym` as
   structure; `capabilities.ts:8-9` says environment is "deliberately NOT here — the doctrine PR's to add".
   A b-roll's place therefore comes only from its sentence. Not in this PR's rulings; candidate for a card.
4. **Rule 9's "all five axes" is measured at 6 of 94 items compliant** (plan.ts:196, pre-doctrine) —
   no post-doctrine rate is in the ledgers. The plan eval (PR 16) should measure it; a low rate means
   R-2's slots are wired to values the planner rarely writes.
5. **Nobody has looked at a b-roll frame from seedance-2.0-fast under this template** (prompts.ts:185-188:
   "guidance applied, not a result"; six bake-off clips 401'd). The C6 evidence stops at the prompt string.
6. **B-roll after a photo row gets a bridge-less hard scene change**: `bridgeable` needs a photo on both
   sides (storyboardLogic.ts:910-916), so b-roll ↔ i2v joins are always the flat 0.5 s fade. R-1 makes the
   join carry intent (beat start → cut); nothing else in this PR changes that.

## Predictions (pre-registered, falsifiable)

- **P-join** — on a plan seeded with a rhythm reading whose summary names a fast pace, and on-beat on,
  at least one non-still join that is a 0.5 s fade today becomes a cut, and every item in the stitch body
  has a recorded reason (`joins[key].reason` non-empty, one of a closed set). Falsifier: the body is
  byte-identical to today's with the flag on, or any join lacks a reason.
- **P-cut** — with `cutIn` set on a row, the join into it is a cut whatever the beat type, the toggle or
  the reading say; and (the inverse) a rule-chosen cut never appears where she chose Fade on the Video
  tab. Falsifier: any `crossfadeSec` on a `cutIn` row.
- **P-slots** — after R-2, `toShotSpec` maps 11/11 camera, 11/11 movement, 11/11 lighting, and composition
  + motion each map to a slot of their own; `capabilityProse` returns "" for every member of every axis
  (**predicted prose-only count: 0** — the leak path is then deleted). Falsifier: any member for which
  `capabilityProse({[axis]: m}) !== ""`. Pre-condition: D-1 resolved (prompts.ts phrasing).
- **P-doctrine** — **will MISS as written**: the four rules already exist (C8), so "one mutation per rule
  goes red when its prompt line is removed" is already true by phrase inside one test. Narrowed form:
  four tests, one per Sept-21 rule, each named, each red on deleting that rule alone. Falsifier: deleting
  rule k reds a test other than its own, or none.
- **P-off** — with `STUDIO_COMPOSER` unset: boardStitch's body, `toShotSpec`/`capabilityProse` output,
  the planner prompt and every golden (prompts.golden.json 8 video, the 118 image goldens) are
  byte-identical to 639d8d44, and `promptFingerprint()` = 0ebb8528a218. **Predicted with the flag ON
  too: the fingerprint is unmoved** (no prompt line changes in this PR). Falsifier: any diff.
- **P-caption** — the suggestion is a pure function of (row sentences, objective): same input → same
  string across 100 calls; every output passes `normalizeCaptionText` (≤ 60 code points, ≤ 2 lines,
  allowlisted chars) or is null. Falsifier: a non-null output that `normalizeCaptionText` rejects.
- **P-rhythm-null** (new) — with no reading, or a reading whose summary names no pace word, the rhythm
  input is null and the join choice equals today's except where a beat type or the toggle decides.
  Falsifier: a join changes on a plan with no reference.

## Decisions needed before Phase B (STOP points)

- **D-1 · R-2 needs video/prompts.ts** (C3h). Growing `ShotSpec` fails `tsc` in prompts.ts until each new
  member has a phrase, and composition/motion slots need two new phrasing tables + `slotRefusal`/`setSlots`
  updates there. prompts.ts is on R-8's do-not-touch list (PR 14's lane), but PR 14 has merged. Options:
  (a) lift the fence for the four tables + `slotRefusal` + `setSlots` only, goldens pinned byte-identical
  with no slot set (prompts.ts:201-202 already promises that); (b) keep ShotSpec closed and map only where
  meaning exists (today) — then R-2's "nothing unmapped rides as prose" cannot hold; (c) map the 24
  missing camera/movement/lighting members onto the EXISTING slots by nearest meaning (e.g. pov → close,
  crane → tracking, neon → stadium) — lossy, a wrong phrase in the prompt. **Recommend (a)**; also touches
  use-studio.ts `SHOT_SLOT_VALUES` (:252-264, not the preview mutation) and `SLOT_LABELS`.
- **D-2 · The reading's seam is client-side** (C4). The rhythm rule reads
  `campaign.references[].intent.editing_rhythm.summary` — free prose, no tags — with a deterministic
  keyword match (pace words → fast / slow / null), in a pure client module, riding `BoardSeed.rhythm`.
  No server change, no R-8 file. Alternative: derive it in the plan route and answer it beside `music` —
  touches the plan route (R-8). **Recommend client-side.**
- **D-3 · Captions live on the Video tab, not the Board** (C7c). The chip goes in `TimelineBuilder`'s
  `CaptionEditor`; the "row's sentences" input is empty there (timeline items carry no sentence). Proposed
  input: the Board's row sentences + objective when the timeline was handed over by the Board (StoryboardTab
  → Video tab handoff already carries the stitched video), else the objective alone → a suggestion of the
  objective's own words, or null. The chip never fires a request for nothing.
- **D-4 · Where the join reason lives.** Proposed: `BoardStitch.joins: Record<itemKey, {kind, reason}>`
  beside `beat` (boardStitch.ts:75-78) — never a `TimelineItem` field (the #538 `satisfies` table would
  have to classify it "local" and it would sit beside wire fields for no reason). For the ledger dump the
  Board, flag on, logs one line `[composer] joins <json>` in `__DEV__` only; Adi copies it beside the mp4.
- **D-5 · R-3 has nothing to build in the prompt** (C8). What remains: four named tripwire tests (one per
  Sept-21 rule) in plan.test.ts, and the ledger writes each rule's exact prompt text. Fingerprint unmoved.

## Component map (Phase B) — per lane

Server lane (no DDL; no R-8 file unless D-1 lifts prompts.ts):
- `server/studio/agent/capabilities.ts` — complete FRAMING_OF / MOVEMENT_OF / LIGHTING_OF; add
  COMPOSITION_OF / MOTION_OF; `toShotSpec` fills five slots; `capabilityProse` deleted if P-slots holds
  (else reports what remains) — behind `composerEnabled()`; flag off = today's tables byte-identical.
- `server/studio/agent/capabilities.test.ts` — mutations 6, 7.
- `server/studio/types.ts` — `SHOT_COMPOSITIONS`, `SHOT_MOTIONS`, ShotSpec gains `composition?`, `motion?`;
  `SHOT_SLOTS` grows (the route's check follows by construction).
- `server/studio/video/prompts.ts` — **only with D-1(a)**: phrasing tables for the new members, two new
  tables, `slotRefusal`/`setSlots` name six slots. + `prompts.test.ts` golden pin (no slot → identical).
- `server/studio/config.ts` — `composerEnabled = () => process.env.STUDIO_COMPOSER === "true"`.
- `server/studio/video/captionSuggest.ts` (new, beside music/suggest.ts) + `.test.ts` — pure, $0,
  bounded by `CAPTION_MAX_CHARS` / `normalizeCaptionText`. Mutation 14.
- `server/routes/studio.ts` — `POST /studio/stitch/caption/suggest` beside music/suggest (:3058), behind
  studioGate + `composerEnabled()` (off: 404). + `server/routes/studio.caption.test.ts` (new). Mutation 13
  (route half).
- `server/studio/agent/plan.test.ts` — four named tripwires (mutations 9-12). No plan.ts change.
- `docs/probes/composer.md` — this ledger.

Client lane:
- `client/lib/flags.ts` — `STUDIO_COMPOSER`.
- `client/screens/studio/joinLogic.ts` (new) + `.test.ts` — the rule: `chooseJoin(input) → {kind, reason}`
  with precedence cutIn > beat type > onBeat (track chosen) > rhythm > default; position 0 cut; bridge
  edges cut. Mutations 1-5.
- `client/screens/studio/rhythmLogic.ts` (new) + `.test.ts` — `rhythmFrom(campaign) → "fast"|"slow"|null`
  deterministic; P-rhythm-null.
- `client/screens/studio/boardStitch.ts` + `.test.ts` — calls `chooseJoin` per item when the flag is on;
  `BoardStitch.joins`; flag off = today's body byte-identical (mutation 13, client half).
- `client/screens/studio/storyboardLogic.ts` + `.test.ts` — `BoardSeed.rhythm`; `slotsAllowed` grows to
  six slots; `droppedSlots` named reasons on `withPlannedShot`'s output (row field, display-only, never in
  a signature). Mutation 8.
- `client/screens/studio/agentLogic.ts` + `.test.ts` — `withPlannedShot` returns the dropped slots with
  a reason; `planSeedExtras` carries rhythm.
- `client/screens/studio/AgentScreen.tsx` — passes `fromBrief.campaign` into the seed's rhythm (one line).
- `client/screens/studio/StoryboardTab.tsx` — on-beat + rhythm into the `boardStitch` call (:866-881);
  `__DEV__` join log; nothing else visible.
- `client/hooks/use-studio.ts` — `SHOT_SLOT_VALUES` only (:252-264; **not** the preview mutation).
- `client/hooks/use-studio-stitch.ts` — `useCaptionSuggestion` beside `useMusicSuggestion` (:395).
- `client/components/studio/TimelineBuilder.tsx` — one chip in `CaptionEditor` (:1649) calling `setCaption`.
- `.env.development` — `STUDIO_COMPOSER=true` / `EXPO_PUBLIC_STUDIO_COMPOSER=true` — **Adi writes it.**

Not touched (R-8): brief.ts, compile/, plan.ts (incl. campaignBlock), video/prompts.ts unless D-1(a),
storyboardRun.ts, the plan/preview routes, qa/, identity/, identityPack.ts, use-studio.ts's preview
mutation, classify.ts, interpret/, edit/, library.ts, visionTag.ts, the pickers, agent/eval/*.

## Mutations (Phase M) — red-by-name, and where each lives

| # | Mutation | Test file |
|---|---|---|
| 1 | "editing_rhythm never chooses a join" | client/screens/studio/joinLogic.test.ts + boardStitch.test.ts |
| 2 | "on-beat toggle ignored at a cut" | joinLogic.test.ts |
| 3 | "her explicit Cut is overridden" | joinLogic.test.ts + boardStitch.test.ts |
| 4 | "position 0 gets a crossfade" | joinLogic.test.ts + boardStitch.test.ts |
| 5 | "a generated bridge's join is overridden" | joinLogic.test.ts + boardStitch.test.ts |
| 6 | "composition capability leaks as prose" | server/studio/agent/capabilities.test.ts |
| 7 | "an unmapped movement value reaches the prompt" | capabilities.test.ts (+ cast.test.ts: direction carries no "Camera movement:") |
| 8 | "a photo row silently drops framing" | client/screens/studio/agentLogic.test.ts (droppedSlots names framing + reason) |
| 9 | "i2v used for a beat the doctrine reserves" | server/studio/agent/plan.test.ts — named tripwire on rule 1 |
| 10 | "a real clip is regenerated instead of kept as-is" | plan.test.ts — named tripwire on rule 3 |
| 11 | "a real photo that carries the beat is not held as a still" | plan.test.ts — named tripwire on rule 2 |
| 12 | "generated media is used as a planner reference at full weight" | plan.test.ts — named tripwire on rule 5 + the grounding line :171-172 |
| 13 | "composer renders with STUDIO_COMPOSER off" | boardStitch.test.ts (body identical) + capabilities.test.ts (tables identical) + routes/studio.caption.test.ts (404) |
| 14 | "a caption suggestion exceeds CAPTION_MAX_CHARS" | server/studio/video/captionSuggest.test.ts |

Mutations 9-12 are prompt DELETION tripwires (the doctrine is prompt, not code — plan.ts:206-209: "taste
rules get prompt"); whether the model obeys is the plan eval's (PR 16).

## Spend cells (each needs Adi's explicit go per run; artifacts → probe-out/composer/)

Formulas from server/studio/config.ts: planner `gemini-3.1-pro-preview` $2/M in, $12/M out (thinking
billed as output; measured mean **$0.0751 per call** after S1b, ingest-flip.md); Veo i2v $0.20/s, $0.40/s
with sound; seedance-2.0-fast b-roll ≈ $0.0914/s at 720p (`w×h×frames/1024 × $0.0000042`); Kling bridge
$0.084/s; a still, an own clip, a stitch, a caption suggestion, a join decision: **$0**. Default clip 4 s
(preview.ts:257); PAN_HOLD 4 s. The reference reading is already on the brief ($0 here).

| Cell | What | Formula | Quote |
|---|---|---|---|
| S-0 | Every unit test, golden, revert check, flag-off pin | CPU only | $0 |
| S-1 | UI check 1: two assembled videos from one brief (same plan, two stitches: flag off / flag on) | 1 plan ($0.075) + N generated clips once (say 3 × 4 s Veo silent $0.80 + 1 × 4 s b-roll $0.37) + 2 stitches ($0) | ≈ $1.25 (clips reused for both stitches) |
| S-2 | UI check 2: on-beat vs flat-crossfade pair of the same board | 0 new clips (same board as S-1), 2 stitches | $0 |
| S-3 | UI check 3: a plan mixing a held still, a kept-as-is clip and an i2v beat | 1 plan ($0.075) + 1 × 4 s Veo i2v ($0.80 silent / $1.60 with sound) + 1 stitch | ≈ $0.90 – $1.70 |
| S-4 (optional) | A second plan on a brief with a fast-pace reading, if S-1's brief has none | 1 plan | $0.075 |
| **Total** | | | **≈ $2.25 – $3.10**, day cap $25 untouched |

No model cell grades its own output: cut coherence is judged by Adi on the device; the join-reason list
beside each mp4 is code's record of what it decided.

## Misses honoured

- P-doctrine as written cannot be tested as a build — the rules already exist (C8). Reported, not patched.
- The block's C6/C8 premises ("rule 9 at :271-274", "expected 0", "lives in no PR") are stale/wrong at tip.
- R-5's fourth file (StoryboardTab caption editor) does not exist (C7c).
- R-2 cannot be completed inside the component map without prompts.ts (C3h) — STOP, D-1.

## Adi's rulings on D-1 … D-5 (go for Phase B, 24 Sep)

- D-1 lifted for video/prompts.ts, narrowly: the phrasing tables, two new tables (composition, motion),
  and slotRefusal. No template text. Every golden pinned with no slot set.
- D-2 client-side pure rule on the reading's summary; conservative — fires only on unambiguous
  language, else null and today's default stands; matched phrases listed here. **Card for PR 18:**
  "editing_rhythm as a tag vocabulary" (reading dimensions become values in the reference work).
- D-3 the Board's sentences when it handed the timeline over, else the objective alone; when neither,
  no chip — never a generic caption.
- D-4 a joins map on the BoardStitch result plus a dev-only log line behind the flag; reasons short
  and stable enough to diff between two stitches.
- D-5 four named tripwires; P-doctrine's miss stands as written.
- Spend: **approved for all cells** ("approved spend for all actually"), none to run before the
  mutations are green. S-2 is $0.
- Addition to the map: report whether R-1 makes the Cut pill reachable at clip-to-clip boundaries;
  if not, card it.

## Phase B — what was built (commit 376b7cb6 on a6fba341, base 639d8d44)

### The join rule (R-1) — client/screens/studio/joinLogic.ts
`chooseJoin(input) → { kind: "cut" | "fade", reason }`, one pure function, precedence in one place:

| order | input | join | reason |
|---|---|---|---|
| 1 | position 0 | cut | `position-0` |
| 2 | her Cut tap (`cutIn`) | cut | `her-cut` |
| 3 | a bridge's own edges | cut | `bridge-edge` |
| 4 | the clip after its own bridge | cut | `after-own-bridge` |
| 5 | a continuation — same source asset on both sides | cut | `continuation` |
| 6 | on the beat — a track with a measured grid chosen AND the toggle on | cut | `on-beat` |
| 7 | the reading's rhythm | fast → cut / slow → fade | `rhythm-fast` / `rhythm-slow` |
| 8 | default | fade (0.5 s, unchanged) | `default-fade` |

"Beat type" is read structurally: a boundary is a *continuation* when the incoming position's source
asset equals the previous position's (two beats cut from one clip; a photo held and then its own
animation) — the frames already match, and a fade between matching frames is a smear. Every other
boundary is a beat start and falls through to the music, the reading, then the default. On-beat for
a JOIN needs only a chosen bed with a trusted grid and the toggle; the hold limits are what still
SNAPPING needs (beatLogic, unchanged, runs after the rule). boardStitch records `joins[itemKey]` per
position; with `composer` null the four legacy sites decide exactly as before and `joins` is `{}`.

### The reading's rhythm (D-2) — client/screens/studio/rhythmLogic.ts
`rhythmFrom(campaign) → { pace, matched, ref } | null` over `references[].intent.editing_rhythm.summary`
(lower-cased, hyphens → spaces, word-bounded). Both fast and slow language in one brief → null.

FAST phrases: fast cuts · quick cuts · rapid cuts · hard cuts · punchy cuts · fast paced · fast pace ·
quick fire · rapid fire · jump cuts · rapid editing · quick editing · fast editing · cuts quickly ·
cut quickly · cuts fast · snappy · staccato · frenetic.
SLOW phrases: slow cuts · long takes · long take · single take · one continuous take · continuous take ·
held shots · long holds · slow paced · slow pace · slow editing · cuts slowly · cut slowly · slow
dissolves · gentle dissolves · lingering · unhurried · languid · meditative.

Rides `BoardSeed.rhythm` beside `music` (`planSeedExtras(answer, dealLinked, campaign)`): the Agent
screen passes the confirmed brief (`fromBrief.campaign`) or the inherited plan's; BrandPlanStep the
proposal's brief; a re-opened plan its stored `brief` (GET). The POST plan answer carries no brief
(routes/studio.ts:2529-2540), so the fresh-plan path reads the campaign the client already holds.

### Slots (R-2)
- studio/types.ts: framing 3 → 8, movement 4 → 11, lighting 4 → 13; new `SHOT_COMPOSITIONS` (7) and
  `SHOT_MOTIONS` (8); `ShotSpec` and `SHOT_SLOTS` gain `composition`, `motion`. The route's check
  (routes/studio.ts:537-547) follows by construction.
- capabilities.ts: LEGACY tables (today's) + COMPLETE tables (`Record`, not `Partial` — a member left
  out does not compile). `toShotSpec(caps, composer = composerEnabled())`; `capabilityProse` returns
  `""` with the composer on. **Prose-only count after R-2: 0** (P-slots held; the leak path stays for
  the flag-off byte-identity and is deleted when the flag is).
- prompts.ts (D-1 scope): phrases for every new member in `MOVEMENT_ON_HER`, `MOVEMENT_ON_SCENE`,
  `FRAMING_ON_SCENE`, `LIGHTING`; new `COMPOSITION` and `MOTION` tables; both ride the existing
  `settingLine` helper (the one slot-built line of the b-roll template, so no template text moved);
  `slotRefusal` refuses composition on a photo as it refuses framing, and refuses the action slot on a
  photo in its own words ("what she does is in your sentence"). Goldens: 8 video + 118 image
  byte-identical with no slot set (prompts.test + compile/golden.test green).
- The photo-row filter names what it drops: `droppedSlotReason` → `photo-decides` (framing, lighting,
  environment, composition), `in-her-sentence` (motion), ~~`nothing-filmed` (a held row); written on the
  row as `droppedSlots` by `withPlannedShot` with the composer on~~; display and ledger only, in no
  request and no signature. `slotsAllowed(row, composer)` gives six on a photo-less row; `shotSlotValues`
  offers the legacy subset with the flag off (client/lib/shotSlotValues.ts, a pure module the hook
  file re-exports — storyboardLogic could not value-import the hook file without dragging
  react-native into the pure suites).
- **Consequence with the flag on:** on a shot from a photo, the planner's composition/motion/angle/
  light asks no longer reach the prompt at all (they used to leak as prose past `slotRefusal`); they
  are named on the row instead. ~~On b-roll all six slots are phrased structurally.~~

> **⚠️ CORRECTION — 24 Sep 2026, PR 15.1 (`docs/probes/composer-boundary.md`). The two struck
> sentences above were wrong at merge.** They describe what each side of the Board did alone, not
> what reached a prompt.
>
> - *"On b-roll all six slots are phrased structurally."* Not through the Board. `withPlannedShot`
>   set composition and action on a photo-less row at seed, and `shotFor` stripped both before the clip
>   request — it called `slotsAllowed(row)` with no composer flag (storyboardRun.ts:111), which defaults
>   to off. A Board b-roll clip phrased four of six slots; all six only by a direct API call. **15 of the
>   48 capability members (composition 7, motion 8) never reached a Board prompt** — measured 33/48 at
>   487053e2. And with the flag on those asks reached the prompt in *no* form: `capabilityProse` is
>   `""` with the composer on, so the prose path that carried them with the flag off was gone too
>   (`probe-out/composer-boundary/broll-flag-on.BEFORE-pr15-merged.prompt.txt`).
> - *"`nothing-filmed` (a held row); written on the row … by `withPlannedShot`."* `rowsOf` never called
>   `withPlannedShot` for a held photo or her own clip (agentLogic.ts:315-354 at 487053e2), so the
>   cast item's slots were dropped there with no record and `nothing-filmed` was never produced.
>   Also: `brandBoardSeed` derived the composer from `campaign !== null` (agentLogic.ts:754) rather than
>   reading the flag, and the join reasons and dropped slots never left the client except by a
>   `__DEV__` console log.
> - **Found by PR 16's flow census** (docs/probes/flow-eval.md §0.3, §2.3, cards K3–K6), not by this
>   PR's tests. **Why none of this PR's fourteen mutations caught it:** each lived wholly on one side of
>   the client/server boundary — the join rule and the seed in client suites, the tables and the
>   doctrine in server suites. No test drove a planned capability through the seeded row into the
>   request, or a stitch body into the stored spec, so a value lost *between* them was invisible.
>   PR 15.1 adds four mutations that cross the boundary in a single test (a join reason and a dropped
>   slot reaching the stored stitch spec from the Board; all 48 members from capability to compiled
>   prompt; the flag-off byte-identity across both sides).
> - **What the code does now (PR 15.1):** a Board b-roll clip phrases all six slots — 48/48 members
>   render, three camera members sharing another's framing phrase; `rowSignature` carries composition
>   and action so a chip tap re-quotes; a held row names every planned slot as `nothing-filmed`;
>   `brandBoardSeed` reads `STUDIO_COMPOSER`; and every join's reason and every dropped slot ride the
>   stitch body onto `studio_stitch_jobs.spec.composer`. Rows from her photo still render movement only
>   (10 of 48 for a shot of her, 11 for a product), by ruling.

### Doctrine (R-3 / D-5)
No prompt change. Four named tripwires in plan.test.ts, one per Sept-21 rule (rules 1, 2, 3, 5), each
red on deleting that rule alone. Fingerprint **0ebb8528a218, unmoved** (pinned test green).

### Captions (R-5 / D-3)
- server/studio/video/captionSuggest.ts: `captionFrom(sentence)` = the first sentence's leading
  clause (before `.!?`, ` — `, `;`, `: `, `, `), capitalised, cut at a word boundary to
  `CAPTION_MAX_CHARS` with an ellipsis, judged by `normalizeCaptionText`; two words or fewer is a
  label, not a caption → null. `suggestCaption({feel, objective})`: the first non-empty sentence; no
  sentence → null. **The objective never becomes words** (a generic caption is exactly what D-3
  forbids), so the "objective alone" leg answers null — a deviation from D-3's letter, stated.
- `POST /studio/stitch/caption/suggest` beside music/suggest, studioGate + `composerEnabled()` (404 off).
- Client: `useCaptionSuggestion` beside `useMusicSuggestion`; the Board's "Fine-tune in Video" now
  hands `{ feel: feelFromRows(rows), objective }` with the asset id (StoryboardTab → StudioHomeScreen →
  VideoTab → TimelineBuilder, two pass-through props outside the map, reported); one `Use “…”` chip in
  `CaptionEditor` that fills the box through the same path a keystroke takes.

### Flags (R-6)
`composerEnabled()` server/studio/config.ts (`STUDIO_COMPOSER`), `STUDIO_COMPOSER` client/lib/flags.ts
(`EXPO_PUBLIC_STUDIO_COMPOSER`), both default off. `.env.development` lines for Adi to write:

    STUDIO_COMPOSER=true
    EXPO_PUBLIC_STUDIO_COMPOSER=true

### Outside the component map (two, both reported)
1. `client/lib/identityPack.ts:52` — `Framing` widened from the three original values to
   `StudioShotSpec["framing"]`. Growing the framing vocabulary broke its compile; `chooseBest` compares
   only wide and medium, so no value old or new changes behaviour. One type line in an R-8 file.
2. `client/screens/studio/StudioHomeScreen.tsx` and `client/screens/studio/VideoTab.tsx` — one optional
   prop each, carrying the Board's words to the caption editor.

## Phase M — mutations, red by name (each applied alone, its suites run, restored from a backup)

| # | Mutation | Named red | Also red | Tests |
|---|---|---|---|---|
| 1 | editing_rhythm never chooses a join (drop the two rhythm lines) | joinLogic.test + boardStitch.test | 3 composer tests | 37 / 5 red |
| 2 | on-beat toggle ignored at a cut (drop the onBeat line) | joinLogic.test + boardStitch.test | — | 37 / 2 |
| 3 | her explicit Cut is overridden (move `cutIn` below rhythm) | joinLogic.test + boardStitch.test | — | 37 / 2 |
| 4 | position 0 gets a crossfade (drop the index-0 line) | joinLogic.test + boardStitch.test | 4 | 37 / 6 |
| 5 | a generated bridge's join is overridden (drop both bridge lines) | joinLogic.test + boardStitch.test | — | 37 / 2 |
| 6 | composition capability leaks as prose (prose with the composer on) | capabilities.test | 1 | 11 / 2 |
| 7 | an unmapped movement value reaches the prompt (legacy table with composer on) | capabilities.test | 1 | 11 / 2 |
| 8 | a photo row silently drops framing (`droppedSlotReason` → null on a photo) | storyboardLogic.test + agentLogic.test | — | 145 / 2 |
| 9 | i2v used for a beat the doctrine reserves (delete rule 1) | plan.test | 7 (nine-rules tests, fingerprint) | 106 / 8 |
| 10 | a real clip is regenerated instead of kept as-is (delete rule 3's clause) | plan.test | 2 | 106 / 3 |
| 11 | a real photo that carries the beat is not held as a still (delete rule 2) | plan.test | 7 | 106 / 8 |
| 12 | generated media is used as a planner reference at full weight (delete rule 5) | plan.test | 7 | 106 / 8 |
| 13 | composer renders with STUDIO_COMPOSER off — client (rule with composer null) / server (route flag check dropped + tables default on) | boardStitch.test / capabilities.test + studio.caption.test | 0 / 1 | 29 / 1 · 15 / 3 |
| 14 | a caption suggestion exceeds CAPTION_MAX_CHARS (skip the cut) | captionSuggest.test | — | 9 / 1 |

Tree clean after every mutation (`git status` empty but the known zip). Scoped green before Phase M:
20 suites, 915 tests, 0 red (the touched suites plus cast.test, captions.test, studio.music.test,
compile/golden.test). `tsc` on tsconfig.json and tsconfig.jest.json: clean. eslint on every touched
file: 0 errors (the caption route test carries the same import-order warnings as the music route test
it mirrors). Prettier: every touched file that was clean on main was formatted; the four dirty-on-main
files (use-studio-stitch.ts, StudioHomeScreen.tsx, routes/studio.ts, plan.test.ts) were left as they
were, my hunks pre-formatted by hand; routes/studio.ts's new route is written in that file's own long-line
style, as the music route beside it is.

## Predictions — verdicts

- P-join **held** in code (boardStitch.test "P-join": a fast reading turns 3 fades into cuts, each with a
  reason). Live: see the spend cells below.
- P-cut **held** (joinLogic.test + boardStitch.test).
- P-slots **held: prose-only count 0** (capabilities.test walks every member of every axis).
- P-doctrine **MISSED as written**, honoured: the rules already existed; the narrowed form (four named
  tests, each red on its own rule) held.
- P-off **held**: goldens byte-identical, fingerprint 0ebb8528a218 unmoved (flag on and off — no prompt
  line changed), boardStitch's body byte-identical with `composer` null.
- P-caption **held** (100-call determinism; every non-null answer passes `normalizeCaptionText`).
- P-rhythm-null **held** (rhythmLogic.test).

## The Cut pill at clip-to-clip boundaries (Adi's addition) — CARD, not built here

R-1 does **not** make the pill reachable there. `cutAllowed` (storyboardLogic.ts:923) still offers Cut
only beside a held row, and an appended as-is video has no pill at all; the composer chooses cuts at
those boundaries by rule, so she can now get a cut she cannot ask for and cannot undo. The inverse
gap too: where the rule fades (a slow reading, the default) she cannot force a cut, and where it cuts
(on-beat, fast) she cannot force a fade. **Card:** "her join override at every boundary — Cut / Fade on
any join, the rule's choice shown as the default"; the rule's precedence already puts `her-cut` first,
so the card is UI (a `cutIn`/`fadeIn` pair on every row and on the passthrough list), not rule work.

## Cards
- PR 18: editing_rhythm as a tag vocabulary (D-2).
- Her join override at every boundary (above).
- Delete `capabilityProse` and the legacy tables when STUDIO_COMPOSER flips (P-slots: nothing is left
  for them to carry).
- B-roll Audit B items 3–5 (environment as a capability axis; rule-9 compliance rate in PR 16's eval;
  a b-roll frame from seedance under this template has still never been looked at).

## Gates and spend — see below

## Gate 1 — at the hold (tip 376b7cb6, `npm test` bare, every batch read)

20 batches, **516 suites, 9657 tests, 1 failed**: `server/services#1` →
`affiliationSync.test.ts` "a year-only from/to (registry v2 allows YYYY)…" — the house flake, re-run in
isolation twice: 1 red, then 8/8 green. Every other batch 0 failed (client#1 554, client#2 1082, lib 533,
mila 381, routes 729+5, services 634+350+315, skills 153, studio 1144+810+1048+846+211, voice 703,
workflow 45, scripts 21+23, root 70). `npm test` exit 1 (the flake); not read as a verdict.
Gate 2 (after a rebase onto main): **not needed — origin/main has not moved** (`git fetch`, behind by 0).

## Spend cells — RUN 24 Sep (Adi: "approved spend for all"), through the real product path in-process

Harness: scratchpad `composer-cells.ts` — the real Express router (auth stubbed to her athlete id via a
module-load hook, nothing else patched), the Board's own pure seeding (`seedRowsFrom`, `planSeedExtras`,
`boardRequests`, `boardStitch`), the preview/generate routes, `videoTick`, the stitch route and
`stitchTick`, bytes read back from the store. Artifacts under `probe-out/composer/<cell>/` (gitignored):
`plan.json` (urls redacted), `quotes.json`, `<variant>.joins.json` (body + joins + reasons + rhythm +
dropped slots) and `<variant>.mp4`.

| cell | what ran | spend |
|---|---|---|
| S-1 dry | 1 plan call (harness check) | $0.075 (measured mean) |
| S-1 | 1 plan call; **0 generated pieces** — the planner answered 5 `clip` beats from her camera (two source clips, windows 0–2, 9.5–11.5, 20.5–22.5, 40–42.5, 5–6 s); 4 stitches | $0.075 |
| S-2 | 2 more stitches on the same stored plan (`--plan`), reading removed | $0 |
| S-3 | 1 plan call; **0 generated pieces** — `image` (held still), `clip`, `clip`; 1 stitch | $0.075 |
| **total** | 3 plan calls, 7 stitches, 0 clips | **≈ $0.23** |

The i2v leg of S-1/S-3 never happened: on both briefs the doctrine chose real footage over a generated
shot (rule 3) and a held photo over an i2v (rule 2) — which is the doctrine working, and which leaves
**no live generated-clip join in this PR's evidence** (joinLogic/boardStitch tests cover `clip` and
`bridge` pieces; P-join's live half is on own-clip boundaries only). A cell that forces an i2v (a brief
her clips cannot cover) is a further ~$0.9 and needs a separate go.

### S-1 · plan abbece80… (reading: `fast cuts` → fast) — the same board, four ways
| variant | wire (join into each position) | joins |
|---|---|---|
| flag-off | cut, 0.5, 0.5, 0.5, 0.5 | `{}` (legacy path; today's body) |
| flag-on | cut, cut, cut, cut, cut | position-0 · rhythm-fast · continuation · continuation · rhythm-fast |
| on-beat (walking-around, 84 BPM) | cut ×5 | position-0 · on-beat · continuation · continuation · on-beat |
| flat-crossfade (toggle off, reading on) | cut ×5 | position-0 · rhythm-fast · continuation · continuation · rhythm-fast |

**P-join held live**: 3 of 4 free joins moved from 0.5 s fades to cuts, each with its reason. Rows 2→3 and
3→4 are `continuation` (two windows of one source clip). Note for the eye: with a fast reading the toggle
cannot make a difference (rhythm sits below on-beat, and both cut) — so the S-2 pair below is the one to
judge on-beat against.

### S-2 · same plan, reading removed — the toggle alone
| variant | wire | joins |
|---|---|---|
| on-beat-noread | cut ×5 | position-0 · on-beat · continuation · continuation · on-beat |
| flat-noread | cut, 0.5, cut, cut, 0.5 | position-0 · default-fade · continuation · continuation · default-fade |

Files: `S1/on-beat-noread.mp4` vs `S1/flat-noread.mp4`.

### S-3 · plan 34aa1e6d… (no reading) — a held still, then two of her clips
| variant | wire | joins |
|---|---|---|
| flag-on | cut, 0.5, 0.5 | position-0 · default-fade · default-fade |

With no reading and no track, the composer's answer equals today's (P-rhythm-null, live). The prompt
asked for "one shot of me smiling to close" as well; the planner covered it with a clip beat, not an i2v.

## What is left for Adi
- Review the diff (25 files + 8 new; two outside the map, stated above).
- Write the two `.env.development` lines.
- The UI check on the device: `probe-out/composer/S1/*.mp4` (cut coherence: flag-off vs flag-on;
  on-beat-noread vs flat-noread), `S3/flag-on.mp4` (a still into her clips), each beside its
  `.joins.json`. The dev log line is in place for boards stitched from the app.
- Decide the i2v cell (further spend) or accept the code-only evidence for generated-clip joins.
- Merge `--no-ff`.

## Item 5 — how often the planner asks for a slot a photo row cannot hold (24 Sep, Adi's question)

S1 and S3 cannot answer it: every row there is a held clip or still, and the planner writes
capabilities only on generated kinds — **0 of 0**. So the count was taken over every stored plan on
Adi's own athlete row (aggregate only, `studio_plans.plan` jsonb, 29 plans):

- Photo rows (i2v/product cast to an asset): **19**. With capabilities: 19/19 — camera 19, lighting 19,
  composition 19, movement 19, motion 14. **Frequent by construction**: rule 9 tells the planner every
  generated direction "carries ALL FIVE capabilities", so the raw count is the prompt, not a want.
- The signal that matters is DISAGREEMENT — the asked camera value against the photo's own
  `metadata.vision.shot_type` (the `shot:` label on the library line, PR 12):

  | tagged shot_type → asked camera | rows |
  |---|---|
  | action → wide | 5 |
  | action → medium | 5 |
  | action → medium_wide | 1 |
  | portrait → medium | 2 |
  | other (product photos) → close_up | 6 |

  **No angle ask at all** (0 pov / over_the_shoulder / low_angle / high_angle / overhead on a photo row),
  and every ask is consistent with the tag: action → wide/medium, portrait → medium, a product → close.
  The planner is restating the framing it can read off the line, not wanting a shot it isn't holding.

Verdict: **not a PR 19 signal on this corpus** — no evidence the planner wants a reframe/angle/crop on a
held still. Carded lightly ("PR 19: watch camera-vs-shot_type disagreement in PR 16's eval; a
reframe/crop op on a held still only if it appears"). On PR 12's `shot_type`: it IS steering — the asks
match it — but it is coarse (action / portrait / other), so "medium vs wide on an action photo" is a
guess the tag cannot confirm or refute; a finer shot-size tag from the tagger would let casting and this
check both read the same value. Note for PR 16's eval: with the composer on these camera/light/
composition asks on a photo row are dropped BY NAME (`droppedSlots`) instead of leaking as prose, so the
drop rate becomes countable per plan from the row itself.

## Adi's rulings on item 5 (24 Sep) — accepted, cards fixed

- No PR 19 work: rule 9 makes the raw count meaningless; the tag-agreement join is the instrument.
- Card 1 (PR 16 eval): watch camera-vs-shot_type disagreement per plan.
- Card 2 (PR 12 follow-up): a finer shot-size tag from the tagger — close / medium / wide beside
  action / portrait / other — so casting and this check read one value.
- Card 3 (PR 16 eval, beside card 1): the drop-rate-per-plan count from `droppedSlots`.
- The i2v cell: skipped; carded for the next composer walk where a brief produces one naturally.
- Adi watches S1/S3 and the on-beat-noread vs flat-noread pair, then pushes and merges `--no-ff`.
