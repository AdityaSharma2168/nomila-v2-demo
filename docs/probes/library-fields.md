# PR 12 — Library fields + face visibility + picker

Worktree `library-fields` · branch `studio/library-fields` · base `origin/main` = **036cc1c6**
(Merge PR #577). AUDIT2.md was pinned at `c8242e07`; `git diff --stat c8242e07..036cc1c6` touches
15 files, all objectives (`server/services/intelligence/objective/**`, `routes/objectives.ts`,
migration 0065) plus 5 lines of `shared/schema.ts` and 4 of `edit/previews.migration.test.ts`.
None of this block's cited files moved. Every cite below was re-read at the tip.

Phase R is read-only. $0 spent. No jest, no server, no DB reads or writes.

---

## Phase R — claims

| # | Claim (from the block) | Verdict | At the tip |
|---|---|---|---|
| C1a | The tagger writes 17 fields, `visionTag.ts:37-56` + `team :30` | **PARTIAL** | `AssetTags` is `lib/visionTag.ts:37-59` and holds **16** written fields: `athlete_present, subject, athlete_prominence, shot_type, description, brands_visible, aesthetic_quality, brand_safe, content_flags, setting, attire, vibe, hero_suitability, disposition, edit_note, reason`. `team` (`:30`) is a field of `AthleteProfile`, an INPUT to `promptFor` (`:72-87`), never written to a row. "17" counts an input as an output. Nothing downstream can drop `team`, because no row carries it. |
| C1b | Storage `media_assets.metadata.vision` (`schema.ts:1505`) | CONFIRMED | `metadata: jsonb("metadata")` at `shared/schema.ts:1505`. Written by `mediaEnrichment.ts:118` (`patch.vision = t`) via a whole-`metadata` update at `:159`. |
| C1c | Ingest kick `routes/media.ts:417` → `enrichNextChunk` (`mediaEnrichment.ts:233`) | CONFIRMED | `enrichNextChunk({ athleteId })` at `routes/media.ts:417`; the serialised door is `mediaEnrichment.ts:233`, the pass itself `:240`. The prompt is `promptFor(profile)` `:92-99`, temperature 0.2, JSON mime `:155`. |
| C2a | `library.ts:443-467` passes/drops exactly as F28 states | CONFIRMED | `server/studio/agent/library.ts:442-468` passes `description, shotType, athletePresent, setting, vibe, picked, brands, provenance, platform, mediaType, durationSeconds, sport, verified, beats[]`. Dropped: `subject, athlete_prominence, aesthetic_quality, brand_safe, content_flags, attire, hero_suitability, disposition, edit_note, reason` (10 row fields; `team` is not a row field, see C1a). The type that must grow is `LibraryEntry` at `agent/types.ts:178-224`. |
| C2b | The planner renders the line at `plan.ts:309-338` | CONFIRMED | `libraryLine` at `server/studio/agent/plan.ts:309-338`: `ref · [CLIP Ns] · [her pick: yes] · person_in_frame · shot · setting · vibe · brands · from · sport · shows · [beats]`, joined by ` \| `, every value through `fenced` (`:107`). Also consumed by `direction/propose.ts:225` and `scripts/studioPlanEval.ts:247`. |
| C3a | Picker reads nothing but the beats count | CONFIRMED (path corrected) | `mediaPickerLogic.ts` lives at **`client/screens/studio/`**, not `client/components/studio/`. `PickerClip.beats` `:42-43`, `rowFromWire` `:152`. Served by `mediaList.ts` `MEDIA_COLUMNS.beats` `:163-165`, `MediaClip.beats` `:246-247`, `shapeMediaRow` `:276`. `MediaPhoto` (`:228-236`) carries **no tag at all**. "no hero score" is the search comment at `:292-296`. |
| C3b | `StudioMediaPicker.tsx` / `ReferencePicker.tsx` read no tag | CONFIRMED | Grep `vision\|hero\|shot_type\|disposition\|subject` → 0 in both. The picker's modal cell is `CellImage` `:509-517` (image only); the strip draws the mount's own `renderTile` (Agent `Tile` `AgentScreen.tsx:1171-1204`, Board `StoryboardTab.tsx:1264-1283`, plus `BrandPlanStep`, `CarouselCreateScreen`, `TimelineBuilder`) — all image-only. |
| C3c | `GET /media` exposes `enriched, brand_safe, shot_type, brands_visible` (`routes/media.ts:69,92-94`) and is not the picker's source | **PARTIAL** | Lines confirmed (`:69`, `:92-94`). It is not `StudioMediaPicker`'s source (`use-studio-media.ts:63,118` → `/studio/media`). But it **is** `ReferencePicker`'s source: `ReferencePicker.tsx:118` `useMyMedia("photos", { source: "upload" })`. ReferencePicker receives `enriched/shot_type` today and ignores them. |
| C4 | `face_visib\|faceVisib` → 0; `role` absent from the tag shape | CONFIRMED | 0 hits across `server client shared`. The only `role` in `visionTag.ts` is the Gemini message role at `:151`. `docs/specs/creative-architecture.md` §6 (`:280-330`) names `role[]`, `subject{person,face,full_body}`, `quality{resolution,face_visibility}`. |
| C5a | Edit source gate reads `subject` only | CONFIRMED | `edit/source.ts:56-65` `subjectOf` reads `vision.subject`, falls back to `athlete_present === true` → `the_athlete`, else null; `sourceDecision` `:68-74`: null → `source_unverified`, `another_person` → `source_not_her`. Callers: `edit/engine.ts:252,261`, `edit/routes.ts:172`. Copy `:47-53` — `source_unverified` already reads "We're still checking who's in this photo." |
| C5b | Where a person ref is accepted for generation today | CONFIRMED (cited here) | `routes/studio.ts` `parsePreviewBody` `:440-479` validates `{assetId, role ∈ REFERENCE_ROLES (:277)}`; `resolveReferences` `:610-628` re-reads each id through `readOwnedImage` `:581-597`, which selects **`id, gcs_path` only** — its own comment `:577-579` records that `metadata` was deliberately dropped. **No tag is read at the generation person-ref door.** Second reading of `person`: the tapped frame becomes her likeness at `:1226-1228` (`frameAsLikeness`), also from `readOwnedImage`. Downstream `generate.ts:300` → `personReference` `:461-498` only resizes bytes. The Agent's caster reads `athletePresent === true` for i2v (`cast.ts:612-622`) but never a face field. |
| C6 | Backfill count query | WRITTEN, NOT RUN | Below. |

### C6 — the count (Adi runs it, pastes the two numbers; nothing else)

Athlete-scoped, aggregate only, no row data. `:athlete` is Adi's own athlete id.

```sql
SELECT
  count(*) FILTER (WHERE metadata -> 'vision' IS NULL)                                   AS no_vision,
  count(*) FILTER (WHERE metadata -> 'vision' IS NOT NULL
                     AND metadata -> 'vision' -> 'face_visibility' IS NULL)               AS vision_no_face,
  count(*) FILTER (WHERE metadata -> 'vision' IS NOT NULL
                     AND metadata -> 'vision' -> 'subject' IS NULL)                       AS vision_pre_ternary,
  count(*)                                                                                AS photos
FROM media_assets
WHERE athlete_id = :athlete
  AND status = 'stored'
  AND deleted_at IS NULL
  AND parent_media_id IS NULL
  AND origin <> 'reference'
  AND media_type IN ('IMAGE', 'CAROUSEL_ALBUM');
```

The `WHERE` is `herPhoto` (`photoPredicate.ts:51-60`) in SQL, so the count is the same population
the picker and the planner see. `vision_pre_ternary` is card F20's population (R-6 rider) — same
pass if Adi says so. **Backfill per row = one `tagAsset` call; quote per row below.**

---

## Pre-registered predictions

| id | prediction | falsified by |
|---|---|---|
| **P-drop** | After R-1, `libraryLine(entry)` for a fixture carrying every tag field renders all 10 dropped row fields (C2a list) as labelled data inside the fenced line. | Any of the 10 absent from the rendered line. |
| **P-fp** | The planner prompt's bytes **outside** the `LIBRARY_OPEN…LIBRARY_CLOSE` block are identical before and after R-1 (no rule text changes). The new fields are appended after `brands:` and before `from:`, so every existing anchor (`^a\d+ \| person_in_frame:`, `her pick: yes \| person_in_frame: yes[^\n]*brands:`) still matches. **Zero existing planner assertions move**: `plan.test.ts`, `routes/studio.agent.test.ts`, `direction/propose.test.ts` (its LIB is a literal fixture), `eval/sheet.test.ts` (literal), `direction/tripwire.test.ts` (allow-list, not words). | Any pre-existing test in those five files red at the gate; or a byte differing outside the library block. |
| **P-stable** | R-2's prompt change (two added keys) does not shift the existing 16 fields. Design: 5 dev images × {old prompt ×2, new prompt ×1} = 15 calls, in-process, **no DB write**. Old×old is the self-agreement baseline at temperature 0.2. Prediction: every categorical field (`subject, shot_type, brand_safe, disposition`, 6 `content_flags`) identical old→new on 5/5; every numeric (`athlete_prominence, aesthetic_quality, hero_suitability`) within ±0.10 on 5/5; free text (`description, setting, attire, vibe, edit_note, reason`) is **not predicted stable** and is reported as the old×old baseline vs old→new. | A categorical flip or a numeric Δ > 0.10 old→new that is NOT also present in the old×old pair. |
| **P-picker** | On a fixture of 10 photos (7 tagged with distinct `hero_suitability`, 2 untagged, 1 `disposition: reject`), `GET /studio/media?kind=photos` returns 9 rows: hero desc, recency desc within equal hero, the 2 untagged last (null hero), the reject absent — and page 2 through the cursor continues that order with no repeat and no gap. | Any adjacent pair out of order, the reject present, an untagged row above a tagged one, or a row repeated/missing across the cursor. |
| **P-gate** | A row with `vision.subject = the_athlete` and `vision.face_visibility = "none"`, sent as `role: "person"`, is refused with reason string **`likeness_no_face`** and copy "This photo doesn't show your face clearly enough to use as a likeness. Pick one where your face is visible." An untagged row sent as `person` or `product` is refused **`reference_unread`** / "We're still reading this photo. Give it a moment and try again." | Either accepted, or a different reason string. |
| **P-old** (R-3) | A row tagged before this PR (`subject = the_athlete` or `athlete_present = true`, **no** `face_visibility`, **no** `role`) sent as `person` is accepted, at both gates. | Refused for the missing field. |

Misses are honoured and reported, never patched.

---

## Rulings — how each lands (proposals; Adi decides at the go)

**R-1 library line.** `LibraryEntry` (`types.ts`) gains `subject`, `prominence`, `quality`,
`brandSafe`, `flags: string[]` (the true keys of `content_flags`), `attire`, `hero`, `disposition`,
`editNote`, `reason`. `library.ts:442-468` fills them from `row.vision`; `libraryLine` renders them
as labelled data, all through `fenced`. Numbers rendered to one decimal; absent → `unknown` (R-3).
`team` is not rendered: it is not on the row (C1a).

**R-2 tagger schema + prompt.** Proposed enums:

- `face_visibility: "none" | "partial" | "clear"` — none: no face, or the face is turned away /
  occluded / too small to identify; partial: side profile, sunglasses, helmet, motion blur, a face
  under ~5% of the frame; clear: frontal or three-quarter, sharp, unobstructed.
- `role: "identity" | "product" | "scene" | "other"` — identity: her, face clear or partial;
  product: a thing is the subject (a boot, a bottle); scene: a place with nobody or only a distant
  crowd; other: text graphics, screenshots, memes, group shots where she is not the subject.

⚠️ **Deviation from the block's suggested `style`.** The block proposes `identity|product|style|other`.
`ReferencePicker.tsx:7-16` records that "a look" was a third reference tag and was **removed** —
the model did not honour it and faces leaked. A `role: style` in the tagger's vocabulary re-enters
the word the product retired, and nothing reads it. `scene` is what `library.ts` already calls a
row without her (`AGENT_LIBRARY_WITHOUT_HER`). Adi picks at the go; the code is one string either way.

Both keys are added to the JSON shape in `promptFor` and typed optional on `AssetTags`. jsonb; no
DDL. Spend logging in `visionTag.ts`: none exists there today and none is added (R-7; PR 11's door).

**R-3 old rows.** One reader, `faceOf(vision)`: `face_visibility` when present; else
`subject === "the_athlete"` / `athlete_present === true` → treated as **`partial`** (a person is
there; nothing said about the face); else `none`. `roleOf(vision)` likewise falls back to
`subject`. No consumer refuses for a missing key.

**R-4 picker.** Server-side, because the list is cursor-paged (`mediaList.ts:180-215`) and an order
must hold across pages:
- `MEDIA_COLUMNS` gains `hero` (`(metadata->'vision'->>'hero_suitability')::float`, null when
  untagged), `subject`, `shot_type`, `disposition`, `enriched` (vision present).
- `mediaOrder` becomes `hero DESC NULLS LAST, date DESC NULLS LAST, id DESC` for **`kind=photos`
  only**; clips keep the current order (the clip lane's ranking is `verifiedFirst`, not hero).
- The cursor grows a third key `h` (`{h, k, id}`); `mediaAfter` becomes the three-column
  lexicographic "after". An old two-key cursor is refused with the existing copy
  (`400 "that cursor isn't one this list handed out"`) rather than resumed in a different order.
  Whether the client already restarts from page 1 on that 400 is **verified in B**; if not, it is
  one line in `use-studio-media.ts`.
- `mediaPredicate` excludes `disposition = 'reject'` for photos.
- `MediaPhoto` gains `subject | null`, `shotType | null`, `read: boolean`. `PickerPhoto` mirrors it;
  `rowFromWire` copies field by field (an older server → `read: true`, no labels — never "not read
  yet" on a server that simply does not send the field).
- The picker draws the label **itself**, as an overlay it wraps around `renderTile`'s output and in
  its own `CellImage` cell — one place, every mount, no change to the five mount `Tile`s. Label
  text: `subject` in her words (`You` / `Someone else` / `No one`) + `shot_type`; untagged → "Not
  read yet".

**R-5 gates.** One pure module, `server/studio/referenceGate.ts` (new, in lane):
`likenessDecision(vision, role)` → `null | "reference_unread" | "likeness_no_face"`. Called from
`edit/source.ts` (`sourceDecision` gains the face arm for the person role only) and from
`routes/studio.ts` `resolveReferences`, which needs **`metadata` back on `readOwnedImage`'s select**
(a 1-column addition to the shared helper) and a 4-line refusal hunk. `person` and `product` roles
need a tag; `object` does not (an object is a thing she pointed at; the tagger says nothing about
it). ⚠️ `routes/studio.ts` is shared with the other live lanes; the hunk is confined to
`readOwnedImage` + `resolveReferences` (`:581-628`). Adi confirms at the go whether the untagged
case is a refusal (proposed; fresh uploads tag within seconds and the ad carousel already waits) or
a wait.

**R-6 backfill.** Phase A. Count first (C6). Per-row quote below. Batches of Adi's size, each a go.
The backfill re-runs `tagAsset` on rows that already have `vision`: that is `enrichRows` with
`hasVision` true → skipped today. A backfill needs its own entry (`retagFaceFields(athleteId, ids)`
in a new `server/studio/enrich/retag.ts`) that writes **only** `face_visibility` and `role` via
`jsonb_set` on `metadata->'vision'`, never the whole object — so a re-tag cannot move the 16
fields whatever the model answers (this is what makes P-stable a property of the prompt, not of the
write). Wait for Adi's ruling on whether F20's pre-ternary rows ride: those DO want the whole
object rewritten (they have no `subject`), which is a different write.

**R-7.** No spend logging touched in `visionTag.ts`.

---

## Mutations — red by name, then green

| # | mutation (from the block) | rule it kills | test file |
|---|---|---|---|
| M1 | "planner sees a reject-disposition photo" | `assembleLibrary` never offers a search / scene / clip row whose `disposition` is `reject`; her own pick of one is offered with the label (picks are relabelled, never dropped — `library.ts:265-270`). Hard-flag rows (`hasHardSafetyFlag`) are never offered, picked or not. **Adi confirms the pick arm at the go.** | `server/studio/agent/library.test.ts` |
| M2 | "library line drops aesthetic_quality" | `libraryLine` renders every C2a field | `server/studio/agent/plan.test.ts` |
| M3 | "picker ignores hero_suitability" | `mediaOrder`/`mediaAfter` hero-first for photos, across the cursor | `server/routes/studio.media.test.ts` (PGlite; the existing list suite) |
| M4 | "picker shows a reject-disposition photo" | `mediaPredicate` excludes reject photos | `server/routes/studio.media.test.ts` |
| M5 | "an unclassified image reaches a generation call" | `resolveReferences` refuses an untagged `person`/`product` ref before any quote | `server/routes/studio.generate.test.ts` (PGlite; where reference bodies are already tested) + `server/studio/referenceGate.test.ts` (pure table) |
| M6 | "a no-face photo is accepted as a person likeness ref" | `likenessDecision` refuses `face_visibility: none` on `person`; both callers | `server/studio/referenceGate.test.ts`, `server/studio/edit/engine.test.ts` (source-gate table `:324-338`), `server/routes/studio.generate.test.ts` |
| M7 | "an old row without face_visibility is refused" | R-3 fallback: absent → `partial`, accepted | `server/studio/referenceGate.test.ts`, `server/studio/edit/engine.test.ts` |
| M8 (added) | "the tagger's prompt stops asking for face_visibility" | `promptFor` carries both new keys | `server/lib/visionTag.test.ts` |
| M9 (added) | "an unknown face_visibility value is stored as given" | parse coerces an out-of-enum answer to absent (R-3 path), like `applySubject` | `server/lib/visionTag.test.ts` |
| M10 (added) | "the picker labels an untagged row with a subject" | `rowFromWire`: `read: false` ⇒ no subject label | `client/screens/studio/mediaPickerLogic.test.ts` |

Each red is shown by name in this ledger before the fix is committed; then the green.

---

## Component map

**Lane 1 — server**

| file | change |
|---|---|
| `server/lib/visionTag.ts` | `AssetTags` +2 optional keys; `promptFor` JSON shape +2 keys; enum constants + `faceOf`/`roleOf` readers with the R-3 fallback. **Not** the spend/log lines (none exist here). |
| `server/lib/visionTag.test.ts` | M8, M9 |
| `server/studio/agent/types.ts` | `LibraryEntry` +10 fields |
| `server/studio/agent/library.ts` | fill the 10 fields; M1's offer rule |
| `server/studio/agent/library.test.ts` | M1 |
| `server/studio/agent/plan.ts` | `libraryLine` renders the 10 |
| `server/studio/agent/plan.test.ts` | M2, P-drop, P-fp |
| `server/studio/referenceGate.ts` (new) | `likenessDecision` |
| `server/studio/referenceGate.test.ts` (new) | M5–M7 pure table |
| `server/studio/edit/source.ts` | person-role face arm |
| `server/studio/edit/engine.test.ts` | M6, M7 table rows |
| `server/routes/studio.ts` | `readOwnedImage` +`metadata`; `resolveReferences` refusal — **`:581-628` only** |
| `server/routes/studio.generate.test.ts` | M5, M6 |
| `server/studio/mediaList.ts` | columns, order, cursor, predicate, `MediaPhoto` |
| `server/routes/studio.media.test.ts` | M3, M4, P-picker |
| `server/studio/enrich/retag.ts` (new, Phase A only) | `jsonb_set` backfill of the two keys, athlete-scoped, capped |
| `server/studio/config.ts` | flag `STUDIO_LIBRARY_FIELDS` (server), default off — gates R-1's extra fields, R-4's order/hide, R-5's face arm. R-2's two extra keys in the prompt are **not** gated (a tag written with two more keys is inert until read; gating the prompt would fork the tag shape). **Adi rules on that at the go.** |

**Lane 2 — client**

| file | change |
|---|---|
| `client/screens/studio/mediaPickerLogic.ts` | `WireMediaRow`/`PickerPhoto` +3 fields; `rowFromWire`; label words |
| `client/screens/studio/mediaPickerLogic.test.ts` | M10 |
| `client/components/studio/StudioMediaPicker.tsx` | label overlay around `renderTile` and in `CellImage`; "Not read yet" |
| `client/components/studio/StudioMediaPicker.test.tsx` | label render + not-read |
| `client/hooks/use-studio-media.ts` | only if the 400-on-old-cursor needs a reset (verify in B) |
| client flag | `EXPO_PUBLIC_STUDIO_LIBRARY_FIELDS` gates the labels (server-only flag would miss the client — memory `check-client-flags-too`) |

**Out of the map, deliberately:** the five mount `Tile`s (AgentScreen, StoryboardTab, BrandPlanStep,
CarouselCreateScreen, TimelineBuilder) — the picker draws the label; `ReferencePicker.tsx` (its
source is `GET /media`, non-Studio, outside the lane — flagged, not touched); `services/mediaEnrichment.ts`
(the write path is unchanged; the backfill is its own module); `subject.ts` (the stopgap heuristic,
scheduled for deletion, not extension). If a fix wants any of these, STOP and report.

---

## Spend

The photo tagger has **no price in config**: `textPriceFor` (`config.ts:707-723`) prices only
`gemini-3.1-pro-preview`; the video tagger's Flash rates live in `enrich/config.ts:92-99`
($1.50/M in, $9.00/M out, list price 22 Sep 2026). `tagAsset` runs `GEMINI.flash` = `gemini-3.5-flash`
(`models.ts:121`). Quote uses the video-enrich Flash rates as the tagger's; **Adi confirms** (or
sets `STUDIO_TEXT_PRICE_JSON` for flash so the number is config's, which R-7 leaves to PR 11).

Per call: `in = 258 × tiles + ~620 prompt`, `out ≈ 260` (JSON, 18 keys). A thumb (`gcs_thumb_path`,
≤ 1024px) is ≤ 4 tiles.

| cell | calls | in tok / call | out tok / call | USD / call | USD total |
|---|---|---|---|---|---|
| P-stable (5 images × old×2 + new×1) | 15 | ≈ 1,650 | ≈ 260 | 1,650×1.5e-6 + 260×9e-6 ≈ **0.0048** | ≈ **0.07** |
| Backfill, per row | 1 | ≈ 1,650 | ≈ 260 | ≈ 0.0048 | **N × 0.0048** (N from C6) |

Every model cell waits for Adi's explicit go per run. Artifacts to `probe-out/library-fields/`.
Nothing has been run.

---

## Decisions (pending Adi's go)

1. `role` enum: `identity|product|scene|other` (proposed) vs the block's `style`.
2. R-5 untagged: refusal (proposed) vs wait.
3. M1 pick arm: a picked reject is offered with the label (proposed) vs dropped.
4. Flag scope: prompt keys ungated (proposed), everything read gated by `STUDIO_LIBRARY_FIELDS`.
5. Tagger price for the quote: video-enrich Flash rates (proposed).
6. F20 pre-ternary rows ride the backfill (needs a whole-object write; separate switch).
7. The `routes/studio.ts` hunk (`:581-628`) in a shared file with three live lanes.

## C6 — counts (Adi ran it, 2026-09-23)

| no_vision | vision_no_face | vision_pre_ternary | photos |
|---|---|---|---|
| 0 | 385 | 381 | 385 |

Backfill quotes (ruling 6, two cells, each its own go): **(a)** face_visibility + role, 385 × 0.0048 ≈ **$1.85**;
**(b)** F20 pre-ternary, 381 × 0.0048 ≈ **$1.83**. Both `jsonb_set` on `metadata->'vision'` only.

## Phase A — P-stable (RAN 2026-09-23, Adi's go in ruling 7)

15 calls, in-process, no DB write. Actual **$0.0754** at Flash list rates (quoted 0.07). Input
1,600–1,646 tokens old / 1,770–1,816 new; output 256–311. Script `probe-out/library-fields/pstable.ts`,
raw `pstable.json` (gitignored; holds model text about her photos — never pasted here).

| image | old×old categorical | old×old max num Δ | old×old text same | old→new categorical | old→new max num Δ | old→new text same | new: face / role |
|---|---|---|---|---|---|---|---|
| b610003b | same | 0.00 | 0/6 | same | 0.10 | 3/6 | clear / identity |
| 9af22d12 | same | 0.00 | 0/6 | same | 0.10 | 0/6 | partial / identity |
| 63a68685 | same | 0.20 | 0/6 | **DIFF subject** | 0.20 | 0/6 | partial / other |
| 17273dcc | same | 0.05 | 1/6 | same | 0.10 | 2/6 | clear / identity |
| 90a5ebe7 | same | 0.10 | 0/6 | same | 0.05 | 0/6 | clear / identity |

Categorical identical old→new **4/5** (baseline old×old 5/5). Numerics within 0.10 old→new 4/5
(baseline 4/5 — the same image, 63a68685, is 0.20 in both pairs, so by the falsifier's own words that
is not a miss).

**MISS — P-stable, categorical.** 63a68685 (a `reject`, `shot_type: other`, hero 0.0 on all three
calls) answered `subject: nobody` twice under the old prompt and `another_person` under the new one,
with `face_visibility: partial`, `role: other`. Internally consistent: asked about a face, the model
found a partial one and then had to say whose. The flip does not change the row's fate (reject, hero
0, never a likeness) but it is a shift in an existing field on 1 of 5, and it was predicted not to
happen. Honoured, not patched. Free text is 0–3/6 stable even old×old, as expected.

**Noted, not a miss:** `athlete_prominence` moved DOWN on 4/5 under the new prompt (1→0.9, 0.95→0.85,
0.95→0.85, 0.95→0.9), each within 0.10, none seen in old×old. A directional drift at the edge of the
tolerance; the backfill writes only the two new keys (ruling 6), so it cannot reach stored rows.

## Phase B — built (2026-09-23)

Base moved twice mid-build. PR 9.5 (studio/clip-reads) merged as **ee357e11**: first taken in by a
merge commit (rebase was denied to the session at the time), conflicts "both added" in
`client/lib/flags.ts` and `server/studio/mediaList.ts`, both sides kept. Then PR 10
(studio/confirm-integrity) merged as **de3fc18b** and Adi approved a rebase: the branch is now
**8 linear commits + 1 on `de3fc18b`**, no merge commit. The same two conflicts reappeared on the
lane-2 commit and were resolved the same way. The rebase dropped the merge commit and with it the
`read` → **`tagged`** rename of the photo tile field (9.5 owns `read` on a clip's read state,
`MediaClip.read` / `PickerClip.read`), so the rename is re-applied as its own commit.

Anchors: 9.5's hunks in `routes/studio.ts` (`:145`, `:3255`), `cast.ts` (`:687`), `mediaList.ts`
(`:164`, `:230`, `:258`, `:292`), `mediaPickerLogic.ts` (`:42`, `:120`, `:150`) and PR 10's in
`plan.ts` (`:77` import, `:358` campaignBlock, `:439`, `:479`, `:595`, `:733`, `:866`),
`types.ts`, `edit/engine.ts` (presentEdit), `routes/studio.ts` (`:149`, `:2326`, `:2851`) are all
outside the Phase R cites. Two cites shift by the lines added above them: `plan.ts` libraryLine
(`:309-338` → +1 from PR 10's import) and the GET /studio/media handler (`:2998` → +13). The
reference-gate hunk `:581-628` did not move. The C1–C5 lines read the same at `de3fc18b`.

Third move: PR 11 (studio/join-row) merged as **02124b71**; rebased again (Adi-approved), two "both
added a flag" conflicts (`server/studio/config.ts` `qaDisplayEnabled`, `client/lib/flags.ts`
`STUDIO_QA_DISPLAY`), both kept. PR 11's `routes/studio.ts` hunks are `:146` (+1 import) and
`:3274` (+5, `registerQaRoutes`), nothing inside the cited lines; at this tip `readOwnedImage` is
`:592`, `resolveReferences` `:627`, GET /studio/media `:3038`, `libraryLine` `plan.ts:333`. Base is
now **02124b71**, 11 linear commits.

### Component map — as built

| lane | file | what |
|---|---|---|
| 1 | `server/lib/visionTag.ts` (+test) | `FaceVisibility`, `TagRole`, `FACE_ROLE_LINE` in the prompt, two keys on the JSON shape, `applyFaceRole` (out-of-enum → absent), `faceOf` / `roleOf` with the R-3 fallback |
| 1 | `server/studio/config.ts` | `libraryFieldsEnabled` — `STUDIO_LIBRARY_FIELDS`, default off |
| 1 | `server/studio/referenceGate.ts` (new, +test) | `readStateOf` (read / pending / failed / capped), `likenessDecision`, the four reason strings |
| 1 | `server/studio/agent/types.ts` | `LibraryEntry.tags?: LibraryTags` (12 fields) |
| 1 | `server/studio/agent/library.ts` | `tagsOf`, `hardFlagged`; tags filled with the flag on; a hard-flagged row never offered |
| 1 | `server/studio/agent/plan.ts` (+test) | `tagWords`; rendered after `brands:`, before `from:` |
| 1 | `server/studio/agent/cast.ts` (+test) | `fitsKind` refuses an unpicked `disposition: reject` |
| 1 | `server/routes/studio.ts` | `readOwnedImage` +`metadata`; `resolveReferences` refusal (`:581-628`) — AND a second hunk at GET /studio/media (`mediaOrderFor`, `cursorFits`, `h` on the cursor), which ruling 5 requires and ruling 9 did not foresee |
| 1 | `server/studio/edit/source.ts` (+engine.test) | `withReadState`: `source_unverified` → `source_read_failed` / `source_read_capped` with the flag on |
| 1 | `server/routes/studio.test.ts`, `studio.agent.test.ts` | the route-level gate and library-line tests |
| A | `server/studio/enrich/retag.ts` (new, +test) | the backfill door: `quoteRetag`, `retag`, `writeRetag` — jsonb_set on the keys inside vision, never the object |
| 2 | `server/studio/mediaList.ts` (+`studio.media.test`) | `PHOTO_RANK_SQL`, `rankedList`, `mediaOrderFor`, `cursorFits`, `h` on `MediaCursor`, `tagFields` on `MediaPhoto` |
| 2 | `client/lib/flags.ts` | `STUDIO_LIBRARY_FIELDS` ← `EXPO_PUBLIC_STUDIO_LIBRARY_FIELDS` |
| 2 | `client/screens/studio/mediaPickerLogic.ts` (+test) | `PickerPhoto.tagged/subject/shot/reject`, `tileLabel`, `isStaleCursor` |
| 2 | `client/components/studio/StudioMediaPicker.tsx` (+test) | `TileLabel` around `renderTile` and in the modal cell |
| 2 | `client/hooks/use-studio-media.ts` (+new test) | `StaleCursorError`; the list resets to page 1 on it |

Not touched: the five mount `Tile`s, `ReferencePicker.tsx`, `services/mediaEnrichment.ts`,
`subject.ts`, `lib/visionTag.ts`'s (non-existent) spend lines.

### Deviations from the R-report and the rulings, stated plainly

1. **Rebase → merge.** Asked for `git rebase origin/main`; the command is denied to this session.
   Merged instead; the history has one merge commit.
2. **`routes/studio.ts` has two hunks, not one.** The reference-gate hunk is `:581-628` as ruled.
   The picker's ranked order and three-key cursor (ruling 5) need the GET /studio/media handler
   to pass `kind` to the order and put `h` on the cursor — 6 changed lines at `:3027-3050`.
3. **No face arm on the edit SOURCE gate.** R-5 named `edit/source.ts` for the face rule; the source
   of an edit is the frame being changed, not a likeness, and the engine has no person-role
   reference. The face rule lives at the one door that takes a `person` role (`resolveReferences`).
   `source.ts` got ruling 2's pending / failed / capped split only. The tapped-frame-as-likeness
   path (`frameAsLikeness`, `:1226`) is outside the ruled hunk and is NOT gated — noted for Adi.
4. **`read` → `tagged`** on the photo tile (above).
5. **The clip lane's `disposition: reject`** also refuses auto-cast (fitsKind runs before the clip
   arm) — a whole-clip reject from the video tagger is never cast unpicked either.

## Phase M — mutations, red by name then green (2026-09-24)

Each mutation: the file backed up, the patch applied (`probe-out/library-fields/mut/*.py`), ONE suite run with `--runInBand --json`, the reds read off `assertionResults`, the file restored from the backup. Green = the scoped pass (16 suites, 477 tests, 0 red) and the whole-suite gate below, on the unmutated tree.

| # | mutation | suite | tests | red | red by name |
|---|---|---|---|---|---|
| 1 | planner sees a reject-disposition photo (auto-cast) | m1_reject_autocast | 79 | 1 | fitsKind — a reject-disposition row is never AUTO-cast (PR 12, ruling 3) with the flag on: |
| 2 | library line drops aesthetic_quality | m2_drop_quality | 95 | 2 | the library line carries what the tagger knows (PR 12, docs/probes/library-fields.md) with; the library line carries what the tagger knows (PR 12, docs/probes/library-fields.md) an o |
| 3 | picker ignores hero_suitability | m3_ignore_hero | 28 | 1 | GET /studio/media — PR 12: hero first, the unread, then the rejects (STUDIO_LIBRARY_FIELDS |
| 4 | picker hides or unlabels a reject-disposition photo (server) | m4_unlabel_reject | 28 | 1 | GET /studio/media — PR 12: hero first, the unread, then the rejects (STUDIO_LIBRARY_FIELDS |
| 5 | picker hides or unlabels a reject-disposition photo (client) | m4b_client_unlabel_reject | 19 | 1 | PR 12 — the tile's label, and a cursor gone stale (docs/probes/library-fields.md) a reject |
| 6 | an unclassified image reaches a generation call | m5_unread_reaches_gen | 7 | 2 | likenessDecision — the gate as a table an unread photo is not a person or product referenc; likenessDecision — the gate as a table a row with other lanes' keys beside vision — clip_r |
| 7 | a no-face photo is accepted as a person likeness ref | m6_noface_accepted | 7 | 2 | likenessDecision — the gate as a table no face, no likeness — a person reference with face; likenessDecision — the gate as a table an old row — tagged before face_visibility existed  |
| 8 | an old row without face_visibility is refused | m7_old_row_refused | 17 | 1 | face_visibility + role — PR 12's two questions (docs/probes/library-fields.md) faceOf: the |
| 9 | the tagger's prompt stops asking for face_visibility | m8_prompt_drops_face | 17 | 1 | face_visibility + role — PR 12's two questions (docs/probes/library-fields.md) asks both,  |
| 10 | an unknown face_visibility value is stored as given | m9_unknown_stored | 17 | 1 | face_visibility + role — PR 12's two questions (docs/probes/library-fields.md) keeps an an |
| 11 | the picker labels an untagged row with a subject | m10_untagged_labelled | 19 | 1 | PR 12 — the tile's label, and a cursor gone stale (docs/probes/library-fields.md) an unrea |
| 12 | stale cursor strands the picker (server: cursorFits accepts either) | m11_stale_cursor_server | 28 | 1 | GET /studio/media — PR 12: hero first, the unread, then the rejects (STUDIO_LIBRARY_FIELDS |
| 13 | stale cursor strands the picker (client: no reset) | m12_stale_cursor_client | 2 | 1 | a stale cursor on page 2 restarts the list from page 1 — the stale pages are gone, the new |
| 14 | planner sees a hard-flagged photo | m13_hard_flag_offered | 68 | 1 | POST /studio/agent/plan PR 12 — library fields a hard-flagged row is never offered, picked |
| 15 | backfill rewrites the vision object / clobbers clip_read | m14_backfill_whole_vision | 5 | 1 | cell (a) writes face_visibility and role INSIDE vision and moves nothing else — not the 16 |
| 16 | backfill runs without a cap | m15_backfill_no_cap | 5 | 1 | a batch is capped by its limit, and refuses to run without one |

Measured on the pre-rebase tree (same content as the rebased tip apart from the `tagged` rename, which the m4b/m10 anchors already carried).


## Gate #1 — whole suite on tip 5cb24227 (base 02124b71), 2026-09-24

`npm test` bare, every batch read: 19 batches, **497 suites, 9403 tests, 0 failed, exit 0**.

| batch | suites | tests | failed |
|---|---|---|---|
| client#1 | 40 | 664 | 0 |
| client#2 | 26 | 884 | 0 |
| scripts | 2 | 21 | 0 |
| server/(root) | 2 | 68 | 0 |
| server/lib | 38 | 533 | 0 |
| server/mila | 27 | 381 | 0 |
| server/routes#1 | 40 | 704 | 0 |
| server/routes#2 | 1 | 3 | 0 |
| server/scripts | 4 | 23 | 0 |
| server/services#1 | 40 | 634 | 0 |
| server/services#2 | 40 | 350 | 0 |
| server/services#3 | 22 | 315 | 0 |
| server/skills | 21 | 153 | 0 |
| server/studio#1 | 40 | 1161 | 0 |
| server/studio#2 | 40 | 858 | 0 |
| server/studio#3 | 40 | 1030 | 0 |
| server/studio#4 | 40 | 873 | 0 |
| server/voice | 29 | 703 | 0 |
| server/workflow | 5 | 45 | 0 |

The affiliationSync house flake did not fire this run.

## Ruling 24 Sep — videos ride (YOUR VIDEOS + both backfill cells)

A clip carries the same four facts as a photo (`tagged, subject, shot, reject`) off the vision
object its poster frame (or the clip lane) wrote; `tileLabel` is kind-agnostic (`TileFacts`); clips
take the ranked order and the three-key cursor; the Studio picker's clip list and every tab of the
shared library rank. `retag` candidates widen from `herPhoto` to every taggable row of hers — a
poster or a stored still, never a bare mp4 (the same rule as enrichment's UNENRICHED).

**Re-quoted with videos** (runner `probe-out/library-fields/retag.ts`, read-only until "go"):

| cell | rows | USD |
|---|---|---|
| (b) subject + athlete_present, pre-ternary | 457 | 2.19 |
| (a) face_visibility + role | 484 | 2.32 |

## Lane 3 — the shared Media library (ruling 24 Sep)

| file | change |
|---|---|
| `server/routes/media.ts` | `PHOTO_RANK` (a copy of mediaList's expression by design — Studio's file is the Studio lane's); `ranked = libraryFieldsEnabled()` on every tab; `cursor_hero` on the keyset; `shapeItems` +`tagged, subject, hero, reject, face` only with the flag on |
| `server/routes/media.test.ts` | flag-off: date order + the exact 25 item keys of today + no cursor_hero (M16); flag-on: the 10-row walk across the cursor, fields on every item, a video ranks off its poster tag |
| `client/hooks/use-media-library.ts` | `MediaItem` +5 optional fields; `cursor_hero` pass-through |
| `client/screens/mediaLibraryLogic.ts` (new, +test) | `tileFactsOf` → the picker's `tileLabel`: ONE function for both screens; a row the server sent bare says nothing even though `shot_type` is on it |
| `client/components/media/MediaLibraryView.tsx` (+new test) | the label under the grid tile, behind `STUDIO_LIBRARY_FIELDS` |
| `MediaDetailScreen.test.tsx`, `ReferencePicker.test.tsx` (new), `card/MediaPicker.test.tsx` (new) | same serialised tree with and without the fields (M18–M20) |

Not touched: `MediaDetailScreen.tsx`, `ReferencePicker.tsx`, `card/MediaPicker.tsx`, `CampaignWorkspaceScreen.tsx` (a fourth reader of GET /media; reads `thumb_url` only).

| # | mutation | suite tests | red | red by name |
|---|---|---|---|---|
| 17 | media list order changes with STUDIO_LIBRARY_FIELDS off | 15 | 1 | GET /media — PR 12 lane 3: hero first behind STUDIO_LIBRARY_FIELDS, byte-identic |
| 18 | MediaLibrary tile shows You for a subject=another_person row | 3 | 2 | her, someone else, no one — the picker's words, by the server's subject; a rejec; a video is labelled off its poster tag exactly like a photo — someone else stays |
| 19 | MediaDetail renders differently with the new fields present | 12 | 1 | renders the same tree with and without the PR 12 lane 3 fields on the row |
| 20 | ReferencePicker renders differently with the new fields present | 1 | 1 | renders the same tree with and without the PR 12 fields on its library rows |
| 21 | card editor renders differently with the new fields present | 1 | 1 | renders the same tree with and without the PR 12 fields on its library rows |
| 22 | a video row with subject=another_person shows You | 20 | 3 | rows off the wire carries a clip's fields as the timeline reads them — null dura; PR 12 — the tile's label, and a cursor gone stale (docs/probes/library-fields.md; PR 12 — the tile's label, and a cursor gone stale (docs/probes/library-fields.md |

Measured on the lane 3 tip; m21 first ran with a one-line anchor that broke the file (suite did not load — not a red by name) and was re-run with a whole-expression anchor: 3 reds by name.

## UI spot-check (Adi, 2026-09-24, before the backfill)

14 tiles in the Agent picker labelled `You · action` / `You · portrait`, all NOT her (a Chelsea
player, a pink England kit, a USA blue kit, a black training kit, a portrait of another athlete; 13
of 14 are `studio/…/0.thumb.jpg` made-here stills, 1 an upload). The label reports the stored tag;
the tags are the pre-ternary population (381 of 385 photos had no `subject`; the R-3 fallback maps
`athlete_present: true` → You) and made-here stills whose job carried no reference of her. Cell (b)
is the fix; re-check the same 14 after it runs. Ids: aea27a73, e932e245, 80ebe0f3, 655a1976,
9060b7bd, 83558feb, afb5640a, 7c087c93, 51d7f34c, b692b90a, f857e46d, e409ee9e, a518ca33, 2a0a3624,
05cc8de9, 8658ceb2, a29350d6, 110b222f.

## Gate #2 — whole suite on tip aa03f1f5 (lane 3 + videos), 2026-09-24

`npm test` bare, every batch read: 19 batches, **501 suites, 9413 tests, 0 failed, exit 0**.
client#1 40/641, client#2 30/915, scripts 2/21, server/(root) 2/68, server/lib 38/533, server/mila
27/381, server/routes#1 40/706, server/routes#2 1/3, server/scripts 4/23, server/services#1 40/634,
#2 40/350, #3 22/315, server/skills 21/153, server/studio#1 40/1161, #2 40/858, #3 40/1030, #4 40/873,
server/voice 29/703, server/workflow 5/45 — all 0 failed. (+4 suites, +10 tests over gate #1: the
four new lane 3 suites.) The ledger commits after this tip are documentation only.

## Backfill — Phase A runs (Adi's go)

| batch | cell | rows | written | skipped | failed | quoted USD |
|---|---|---|---|---|---|---|
| 1 | (b) subject | 20 | 20 | 0 | 0 | 0.096 |

Readback of batch 1 (aggregate): 18 generated images + 2 generated videos, all `the_athlete`. Not
a verdict: Adi's 14 misses are ~4% of the made-here stills, so a random 20 with none is consistent.
Batches 2 (437 rows, $2.10) and 3 (cell (a), 484 rows, $2.32) were started on "run it on
everything".

| batch | cell | rows | written | skipped | failed | quoted USD |
|---|---|---|---|---|---|---|
| 2 | (b) subject | 437 | 436 | 0 | 1 (tagger returned null; still a candidate) | 2.10 |
| 3 | (a) face_visibility + role | 484 | 484 | 0 | 0 | 2.32 |
| 4 | (b) retry of the one failed row (31bd5d98, a generated PNG; transient — cell (a) read it fine) | 1 | 1 | 0 | 0 | 0.005 |

Backfill total: 942 tagger calls, quoted **$4.52**. Every taggable row of hers now carries `subject`,
`face_visibility` and `role`; no candidate remains for either cell.

**Whole library after cell (a)** (484 rows): face `clear` 260, `partial` 188, `none` 36; role
`identity` 435, `other` 18, `product` 15, `scene` 16. face=none splits product 15, scene 16, other 4,
identity 1 — the one `none`+`identity` row is the P-gate walk's natural subject (a photo of her with
no face: refused as a likeness, accepted as a product).

**Whole library after cell (b)** (484 tagged rows): `the_athlete` **444** (360 generated images, 69
generated videos, 12 uploaded images, 3 uploaded videos), `another_person` 8, `nobody` 31, none 1.

**FINDING — the named prompt does not tell a generated stranger from her.** Of the 18 tiles Adi
flagged as not him (a Chelsea player, an England pink kit, a USA blue kit, a black training kit,
another athlete's portrait, all but one made-here), the re-tag moved **3 to `another_person`** and
left **15 at `the_athlete`**. The prompt names her and says anyone else is ANOTHER PERSON, but on a
generated still there is no second person to contrast with — one athlete, in a kit, on a pitch — and
the model answers "the athlete". Batch 1's 20/20 was the same effect, not chance. The tag cannot fix
these rows; the picker will keep saying `You` on them.

**Proposal (not built — it is a rule change, Adi's call):** a made-here still or clip whose
generation job carried NO `person` reference of her cannot be her, deterministically —
`identity_bound` (cast.ts S2, `generation_jobs.brief->'job'->'references' @> [{"role":"person"}]`)
already encodes this for the caster. Reading it at the two tile sources (`mediaList.ts` and
`routes/media.ts`) and labelling those rows `Made here · not from you` would resolve every one of
the 15 without a model call. It is one extra join on each list and one word in `tileLabel`; the
mutation would be "a made-here still with no person reference shows You".

## Follow-up PR — made here without her is not her (ruling 24 Sep, branch studio/library-fields-madehere)

**Ruling.** A made-here still or clip whose generation job carried no `person` reference of her is
labelled **"Made here · not from you"** at both tile sources and refused as a "you" reference,
keyed on the job's references exactly as the caster reads `identity_bound` — deterministic, no
model call. The likeness refusal is ONE MORE REASON inside PR 12's existing function, not a new
check site (Adi's constraint).

**⚠️ FOR PR 17 (the chooser at the reference boundary):** the one function every reference role
passes through before a quote exists is **`likenessDecision(metadata, role, made?)` at
`server/studio/referenceGate.ts:125`**. Its reasons, in order: `reference_unread` /
`reference_read_failed` / `reference_read_capped` (rule 1), `likeness_not_from_her` (rule 3,
`madeHereNotHer` `:73`), `likeness_no_face` (rule 2). The route calls it once, in `resolveReferences`
(`server/routes/studio.ts`, the `:581-628` hunk), with `{ origin, identityBound }` read off the row
via `IDENTITY_BOUND_SQL` (`referenceGate.ts:82`). Hook the chooser there; add a reason there. And
the fact PR 17's pack gate needs: **`subject = the_athlete` is unreliable on generated media by
construction** — the named prompt answered "the athlete" on 15 of 18 generated strangers and on
360 of 372 generated stills — so 17's pack gate excludes `origin = generated` for this reason.

| where | what |
|---|---|
| `referenceGate.ts` | `MadeFrom`, `madeHereNotHer`, `IDENTITY_BOUND_SQL` (a correlated subquery, athlete-scoped: NULL when no job or not hers), rule 3 in `likenessDecision`, copy `likeness_not_from_her` |
| `mediaList.ts` | `MEDIA_COLUMNS.identityBound`; `madeHereNotHer` on `MediaPhoto` / `MediaClip` via `tagFields` |
| `routes/media.ts` `shapeItems` | one athlete-scoped `generation_jobs` query per page (flag on), `madeHereNotHer` on each item |
| `routes/studio.ts` `readOwnedImage` | +`origin`, +`identityBound`; `resolveReferences` passes them to the gate |
| `mediaPickerLogic.ts` | `TileFacts.madeHereNotHer`; `tileLabel` says `Made here · not from you` before reading the tag; `MADE_HERE_NOT_HER` |
| `mediaLibraryLogic.ts`, `use-media-library.ts` | the field carried through |

| # | mutation | suite | tests | red | red by name |
|---|---|---|---|---|---|
| 23 | a made-here still with no person reference shows You | m22_madehere_shows_you | 21 | 1 | PR 12 — the tile's label, and a cursor gone stale (docs/probes/library-fields.md |
| 24 | a made-here still with no person reference is accepted as a likeness reference (gate) | m23_madehere_accepted_likeness | 10 | 2 | rule 3 — made here without her is not her (ruling 24 Sep 2026) a generated row w; rule 3 — made here without her is not her (ruling 24 Sep 2026) rule 3 outranks t |
| 25 | …the same, through POST /studio/preview | m23b_madehere_accepted_route | 94 | 1 | references — the reading gate (PR 12, STUDIO_LIBRARY_FIELDS) a made-here photo w |

Unknown is never "not from her": a generated row with no job, or whose job is another athlete's,
carries `identityBound: null` and is neither labelled nor refused by rule 3 (pinned in both list
tests). The label wins over "Not read yet" and over the tag; `· not usable` still rides on a reject.

## Rebase — studio/library-fields-madehere onto main 93ff0765 (PR 13 merged), 2026-09-24

Adi-approved `git rebase origin/main`: zero conflicts (PR 13 touched plans.ts, the plan handlers,
agentLogic and jobs.ts — none in this branch's map). Base is now **93ff0765**; the code commit is
bb7d5e04, the rest ledger only. Both typechecks green on the rebased tip. Gate #4 below is the
verdict on it; gate #3 stands as the verdict on the pre-rebase content.

## Gate #3 — whole suite on tip 1b3b0bfe (studio/library-fields-madehere), 2026-09-24

`npm test` bare, every batch read: 19 batches, **501 suites, 9421 tests, 0 failed, exit 0**.
client#1 40/641, client#2 30/917, scripts 2/21, server/(root) 2/68, server/lib 38/533, server/mila
27/381, server/routes#1 40/709, server/routes#2 1/3, server/scripts 4/23, server/services#1 40/634,
#2 40/350, #3 22/315, server/skills 21/153, server/studio#1 40/1161, #2 40/858, #3 40/1030, #4 40/876,
server/voice 29/703, server/workflow 5/45 — all 0 failed. Ledger commits after this tip are documentation only.

## Manual "not me" marks (Adi, 2026-09-24)

Six tiles still read `You` after the backfill and the made-here rule. Read off the rows: **4 were
generated by jobs that DID carry a person reference of him** (identity_bound true, one reference)
and the model drew a stranger — rule 3 cannot see these, and the tagger calls them "the athlete";
1 (80ebe0f3) has no person reference and reads `Made here · not from you` on the new code; 1 upload
already re-tagged to `another_person`. On his "flag all of these or remove them", the five rows
still at `the_athlete` were marked by hand: `vision.subject = another_person`,
`vision.athlete_present = false`, `vision.subject_source = "manual:adi:2026-09-24"` (jsonb_set, three
keys, nothing else; `probe-out/library-fields/flag-not-me.ts`). Every reader treats them as someone
else from here: `Someone else` on the tiles, out of the planner's her-room, refused as a likeness.

**Open (a card, not this PR):** a generated still made FROM a reference of her can still come out as
a stranger. No stored fact distinguishes it; only her eye does. A "not me" action on the tile that
writes exactly this mark is the product shape of what was done by hand here.

## Rank amendment — someone else below the unread (Adi, 24 Sep)

After the manual marks the strangers still led the strip: the rank never read WHO, only hero /
untagged / reject, and generated stills score high. `PHOTO_RANK_SQL` (now `referenceGate.ts`,
beside `IDENTITY_BOUND_SQL` — one expression, both lists, both cursors) gains a **-1.5** tier for
`subject = another_person` and for made-here-without-her, between the unread (-1) and the rejects
(-2); `rankOf` is the same table in TypeScript for GET /media's cursor. Both walk tests carry a
stranger and a made-here-not-her row at hero 0.99 landing after the unread.

| # | mutation | suite | tests | red | red by name |
|---|---|---|---|---|---|
| 26 | a someone-else row ranks above her rows (Studio list) | m24_stranger_ranks_above | 29 | 2 | serves 12 photos…; a pre-ternary row's subject… (the clip walk) |
| 27 | …(shared library) | m24b_stranger_ranks_above_lib | 16 | 1 | with the flag on and ?type=photos… |

Gate #4 (on 4e2dd985) was **stopped** mid-run when this amendment began — its later batches would
have loaded the edited files. Gate #5 below is the verdict on the amended tip.

## Misses

- P-stable categorical: 4/5, predicted 5/5 (above).
