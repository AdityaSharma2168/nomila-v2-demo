# Identity pack + profile, per-athlete calibration, drift — PR 17 ledger

- Branch `studio/identity-pack`, worktree `/Users/adi/nomila-v2-worktrees/identity-pack`
- Base at R: `93ff0765` (#583). **Rebased 2026-09-24 onto `e7e53f06` (#584)** clean, then **onto `e2950e5a` (#585 brief-carrier, PR 14)** — two tail-append conflicts (`client/lib/flags.ts`, `server/studio/config.ts`: both sides added flag helpers; both kept). Branch content verified identical to pre-rebase outside the four files PR 14 also touched. Commits re-hashed (§8).
- AUDIT2.md was pinned at `c8242e07`; PRs 9.5, 10, 11, 12, 13 merged since. Every cite below is re-verdicted at the tip.
- Phase R was read-only: $0, no jest, no server, no DB write. Phase B GO from Adi 2026-09-24 with rulings 1–7 (§6).

## 1. Claims (Phase R)

| # | Claim (as briefed) | Verdict | At the tip |
|---|---|---|---|
| C1.a | identity.ts asserts no threshold (header :4-7) | CONFIRMED | `qa/identity.ts:4-8` — header runs one line longer |
| C1.b | status is flag\|pass, never fail (:173) | STALE line, CONFIRMED substance | `qa/identity.ts:175` `const status = band === "above" ? "flag" : "pass"` |
| C1.c | SAME_PERSON_BAND 0.1588–0.5282, 28 pairs, 2026-09-09 (:59-65); env MIN/MAX (:60-61) | CONFIRMED | `qa/identity.ts:59-65`, `STUDIO_QA_IDENTITY_BAND_MIN/MAX` at `:60-61` |
| C1.d | position() reads the global const (:69-73) | STALE line, CONFIRMED substance | `qa/identity.ts:87-92`, module-private, takes only `d` |
| C1.e | stranger control failed, 0.3584 inside 0.3158–0.4186 (:199-206); DEAD_RULER_CAVEAT (:217-218) | CONFIRMED | `qa/identity.ts:199-206`, `:217-218` |
| C1.f | propagation: inspect.ts:300-301, verdict.ts:174-178, videoClip.ts:21-28 and :284, identitySet.ts:12-14 | PARTIAL (one line moved) | `qa/inspect.ts:320-321` (was :300), `qa/verdict.ts:173-179`, `qa/videoClip.ts:16-30` and `:284`, `qa/identitySet.ts:12-14` |
| C1.g | sourceFace.sizeFrac (identity.ts:94-96) | STALE line, CONFIRMED substance | declared `qa/identity.ts:83`, written `:159-163`; computed `qa/face.ts:185` (`max(rect.width, rect.height)`), `small` below `SMALL_FACE_FRAC = 0.06` (`face.ts:72`) |
| C1.h | no face template kept (identity.ts:212-214) | CONFIRMED | `qa/identity.ts:213-215` |
| C1.i | NEW: `observeGenerateIdentity` (the generate path) never calls `position()`; the band is applied only by `checkIdentity` (edit root, and clip frame-vs-anchor) | CONFIRMED | `qa/identity.ts:286-375` has no `band` field; `:145` is the only call |
| C2.a | identitySet.ts:98-124 held-out construction; IDENTITY_SET_SIZE 4; MIN_PROMINENCE 0.5; nothing stored (:47-50) | CONFIRMED | `qa/identitySet.ts:98-120` query, `:122-131` return; `:51` = 4; `:54` = 0.5; `:46-50` |
| C2.b | labeledSet.ts:741-759 IDENTITY_REFERENCES = 9; single-athlete :7 | STALE line, CONFIRMED substance | `qa/labeledSet.ts:759-814` (9 entries: 36 pairs = C(9,2), header :30); `:7` "resolves them to rows under ONE athlete" |
| C3.a | qa/embed.ts + lib/mediaEmbed.ts: embedImageBytes / embeddingDistance | CONFIRMED | `qa/embed.ts:79-126`, `:135-137`; `cosine` imported from `lib/mediaEmbed.ts:126`; `:2,27-30` header; ⚠️ `lib/mediaEmbed.ts` builds a GCS `Storage` client at module load — every importer of `qa/embed` must be reached by a DYNAMIC import (`videoRunner.ts:506-521` states why) |
| C3.b | the embed price is in config | WRONG (location) | not in `studio/config.ts` — `qa/cost.ts:46` `STUDIO_QA_USD_PER_EMBED ?? 0.0001` per call; face-box vision at `qa/cost.ts:35-40` ($0.3/M in, $2.5/M out) |
| C3.c | faceCrop in qa/face.ts | CONFIRMED | `qa/face.ts:119-203`; margin 0.25 `:69`; Gemini flash box, not SAM (`:35-47`) |
| C4.a | likeness refs: ReferencePicker → request → routes/studio.ts resolveReferences :610-628 → readOwnedImage | STALE lines, PARTIAL substance | TWO client flows, one wire: (1) `CampaignWorkspaceScreen.tsx:160` `toStudioReferences(references)`; (2) Create Anything `use-studio-pending.ts:470` `previewRequestFor` → `studio-contract.ts:524-579` `toEngineReferences` (cap 6, `:489`). Both POST through `use-studio.ts:562-578` `usePreviewGeneration` → `routes/studio.ts` `parsePreviewBody :447-488` → `resolveReferences :627-652` → `readOwnedImage :592-610` → PR 12 `likenessDecision` (`studio/referenceGate.ts:86-96`) |
| C4.b | the single seam for a chooser, outside PR 14's files | CONFIRMED — named | `client/hooks/use-studio.ts:562-578` `usePreviewGeneration`'s `mutationFn`, before `fetch`. Both flows pass through it; PR 14's `storyboardRun.ts` does NOT call it (grep: only `CampaignWorkspaceScreen.tsx:114` and `use-studio-pending.ts:408`). Server unchanged: pack refs travel as ordinary `{assetId, role:"person"}`; `CHARACTER_CAP = 3` (`studio/config.ts:830`) bounds them and the PR 12 gate re-checks each. ⚠️ Adi's heads-up (24 Sep): `studio/library-fields-madehere` edits `likenessDecision` only. This PR IMPORTS that function (pack gate) and never edits it — no file overlap; merge order is free |
| C5.a | inspectClip.ts:181: one frame or several | STALE line | strip at `qa/inspectClip.ts:160` (dense `fps` plan, `frames.ts:63` 4/s), curve `:162`, `selectFrames :163` → ≤3 frames (anchor/peak/last, `frames.ts:349-360`); paid checks `:165-171`; strip disposed `:214`. Per non-anchor frame today: 2 face boxes + 2 embeds vs anchor (`videoClip.ts` checkFrame) |
| C5.b | 9.5's beat grabs exist as frames | WRONG | PR 9.5 = `studio/enrich/clipRead.ts`: the mp4 goes to Gemini inline; it writes `metadata.vision.beats[{start_s,end_s,…}]` (`enrich/videoTag.ts:110`). NO frames are grabbed or stored. The only clip pixels are the poster (`gcs_thumb_path`, one frame) and inspectClip's in-flight strip. Drift therefore reads beat TIMES off `vision.beats` and picks the nearest strip frames INSIDE the existing `try` (`:161-215`) — no second ffmpeg pass |
| C5.c | per-frame embed cost | CONFIRMED | 1 face box + 1 embed per frame; formula in §5 |
| C6 | PR 11's chip and wording | CONFIRMED | wire `qa/routes.ts:41` `QaWording = "pass" \| "flag"`, `:51-54` `identityObservation: {caption: "Observation only, not a check", caveat}`, built `:90-95`; `QaChip.tsx:112-116` renders `Identity: observation only, not a check`; hook type `use-studio-qa.ts:23`. A drift line fits as a SECOND field of the same `{caption, …}` shape; the control caption replaces the caveat text when `control_passed` — the wording enum does not move. Existing mutation "identity observation shown as pass/fail" (QaChip.test) stays red-able |
| C7 | roster strangers | SELECT written, §4 — Adi runs it; aggregates only | PR 12's backfill was athlete-scoped (`docs/probes/library-fields.md:136-138`, `enrich/retag.ts`), so strangers have no `face_visibility`; selection is `subject = the_athlete` + prominence ≥ 0.5; the tag pass is quoted in §5 at `RETAG_USD_PER_ROW = 0.0048` (`retag.ts:49`) |
| C8.a | 0066 latest on main | CONFIRMED | `migrations/0066_studio_plan_memory.sql`; `scripts/db-migrate.sh:167-168` list; `:22` and `:131` say "0031–0066" (two comment lines to bump) |
| C8.b | no 0067 anywhere | CONFIRMED | `git ls-tree` over every `refs/heads/*` and `refs/remotes/*` for `migrations/*0067*`: none |
| C8.c | parity-test pattern | CONFIRMED | new-table shape: `agent/plans.migration.test.ts` (0061: same OID on re-run, revert leaves no orphan, equals a schema.ts push incl. constraints, listed once after the previous); ADD COLUMN shape: `agent/planMemory.migration.test.ts` (0066). 0067 is a new table → 0061's harness |

Flags at the tip: `STUDIO_IDENTITY_*` does not exist anywhere (server, client, docs). Client flags live in `client/lib/flags.ts`; server helpers in `studio/config.ts` (pattern `:1676-1698`). `.env.development` is deny-ruled for this session (read blocked) — see §7.

## 2. Predictions (pre-registered, falsifiable)

| # | Prediction | Falsified if |
|---|---|---|
| P-pack | the pack gate refuses (a) `origin = generated`, (b) `face_visibility = none`, (c) `subject = another_person`, each with its own named reason, and (d) `disposition = reject` | any of the four is accepted, or two share a reason |
| P-chooser | same pack + same request → the same three ids, in the same order, on two calls (order: sizeFrac desc, prominence desc, `clear` before `partial`, id asc) | the two calls differ |
| P-explicit | three explicit `person` refs → zero pack refs on the request; and `packPolicy: "just-these"` → zero pack refs at any count | a pack id appears |
| P-band | her band_max on a 12-photo pack (66 pairs) lands ABOVE the global 0.5282 — more pairs push the max out, and the global 28 came from 9 photos | band_max ≤ 0.5282 |
| P-control | control FAILS on multimodalembedding@001: at least one stranger distance lands ≤ her band_max (the 2026-09-15 stranger sat at 0.3584, mid-band) | every stranger distance > band_max |
| P-drift | on the clip Adi names as morphing, the frame-to-frame delta at the morph beat is ≥ 2.0 × the clip's median delta | the ratio is < 2.0 |
| P-off | both flags off: the preview request bytes, the QA wire, the chip render, the clip verdict jsonb and every route table are identical to the tip's | any pinned snapshot moves |

Misses are honored and reported, never patched.

## 3. Mutations red-by-name → test file

| Mutation | Test file |
|---|---|
| pack accepts a photo with no face | `server/studio/identity/packGate.test.ts` |
| pack accepts a generated photo | `server/studio/identity/packGate.test.ts` |
| pack accepts someone else | `server/studio/identity/packGate.test.ts` |
| best-3 picks a small face | `client/lib/identityPack.test.ts` |
| pack overrides an explicit user reference | `client/lib/identityPack.test.ts` |
| pack competes with a product reference | `client/lib/identityPack.test.ts` |
| a threshold is asserted before the stranger control passes | `server/studio/identity/calibrate.test.ts` |
| position() reads the profile row when control failed | `server/studio/qa/identity.test.ts` (extended) |
| drift shown as pass/fail | `server/studio/qa/routes.test.ts` + `client/components/studio/QaChip.test.tsx` |
| is-it-her shown for an athlete whose control failed | `server/studio/qa/drift.test.ts` |
| pack surface renders with STUDIO_IDENTITY_PACK off | `client/components/studio/IdentityPackSheet.test.tsx` |
| migration and schema disagree | `server/studio/identity/identityProfile.migration.test.ts` |

## 4. Component map

**Lane 0 — DDL (commit 1, alone)**
- `migrations/0067_identity_profile.sql` — `CREATE TABLE IF NOT EXISTS identity_profiles`
- `shared/schema.ts` — `identityProfiles` table (after `objectiveEvents`)
- `scripts/db-migrate.sh` — `0067_identity_profile \` after 0066; the two "0031–0066" comment lines
- `server/studio/identity/identityProfile.migration.test.ts` — 0061's harness

R-1 call: `pack` is **jsonb**, `[{ assetId, faceSizeFrac, prominence, faceVisibility }]`. Reason: R-3 says the chooser makes no model call, and `sizeFrac` only exists after a face box — so it is measured once at pack time and kept as a NUMBER beside its id. Ids and numbers only; never a vector, crop or box. Columns exactly as ruled: `id, athlete_id (unique, CASCADE), pack jsonb, band_min numeric, band_max numeric, band_pairs int, band_measured_at timestamptz, control_passed boolean null, control_measured_at timestamptz, embedder text, created_at, updated_at`.

**Lane 1 — server**
- `server/studio/identity/profile.ts` (+test) — read/upsert the row under `athleteId`; `bandFor(athleteId)` → profile band only when `control_passed === true`
- `server/studio/identity/packGate.ts` (+test) — pure; imports PR 12 `likenessDecision` (never edits it); adds origin / subject / disposition / `clear`-only arms
- `server/studio/identity/calibrate.ts` (+test) — her-vs-her pairs, stranger distances, `control_passed`; contact sheet to `probe-out/identity-pack/`; dynamic-imports `qa/embed`
- `server/studio/identity/routes.ts` (+test) — `GET/PUT /studio/identity/pack`, `POST /studio/identity/pack/calibrate`; 404 with `STUDIO_IDENTITY_PACK` off
- `server/routes/studio.ts` — one import + one `registerIdentityRoutes(router, studioGate)` line beside `:3433`
- `server/studio/config.ts` — `identityPackEnabled`, `identityDriftEnabled` (the flag-helper convention)
- `server/studio/qa/identity.ts` — `position(d, band)`; `checkIdentity(pair, band?)`; global const stays the default
- `server/studio/qa/inspect.ts`, `qa/inspectClip.ts`, `qa/videoClip.ts` — pass the athlete's band through; inspectClip hooks drift inside its `try`
- `server/studio/qa/drift.ts` (+test) — R-6a self-consistency series; R-6b only when `control_passed`
- `server/studio/qa/verdict.ts` — optional `driftObservation` on `CreativeQaVerdict` (type only)
- `server/studio/qa/routes.ts` — drift line + control caption on the wire
- `server/studio/video/reroll.ts` — may cite drift; `acted: false` unchanged

**Lane 2 — client**
- `client/lib/flags.ts` — `STUDIO_IDENTITY_PACK`, `STUDIO_IDENTITY_DRIFT`
- `client/lib/identityPack.ts` (+test) — pure best-3 chooser + `withPackReferences(request, pack, policy)`
- `client/hooks/use-identity-pack.ts` — GET/PUT/calibrate
- `client/hooks/use-studio.ts` — `usePreviewGeneration`: the one chooser hook (variables gain optional `packPolicy`, stripped before send)
- `client/screens/CampaignWorkspaceScreen.tsx:114,160` and `client/hooks/use-studio-pending.ts:408` — pass `packPolicy`
- `client/components/studio/ReferencePicker.tsx`, `client/screens/studio/AttachSheet.tsx` — the "just these" toggle, flag-gated
- `client/components/studio/IdentityPackSheet.tsx` (+test) — the upload/select surface; entry: one flag-gated row on `client/screens/studio/StudioHomeScreen.tsx`
- `client/components/studio/QaChip.tsx`, `client/hooks/use-studio-qa.ts` — drift line + caption
- `.env.development` — two `EXPO_PUBLIC_STUDIO_IDENTITY_*=` lines (blocked for me this session, §7)
- `docs/probes/identity-pack.md` — this ledger

Out of the map, by ruling: plan route, `brief.ts`, `compile/`, `generate.ts`, `classify.ts`, `interpret/`, `edit/ops`, `storyboardRun.ts`, `agentLogic.ts`, `video/prompts.ts`, `referenceGate.ts` (imported only).

### Roster SELECT (C7 — Adi runs; aggregates only, no names)

```sql
SELECT athlete_id,
       count(*)                                                                    AS photos,
       count(*) FILTER (WHERE metadata->'vision'->>'face_visibility' = 'clear')     AS face_clear,
       count(*) FILTER (WHERE metadata->'vision'->'face_visibility' IS NULL)        AS face_untagged
FROM media_assets
WHERE media_type = 'IMAGE' AND status = 'stored' AND deleted_at IS NULL AND gcs_path IS NOT NULL
  AND origin <> 'generated'
  AND (metadata->'vision'->>'subject' = 'the_athlete'
       OR (metadata->'vision'->'subject' IS NULL AND metadata->'vision'->'athlete_present' = 'true'::jsonb))
  AND jsonb_typeof(metadata->'vision'->'athlete_prominence') = 'number'
  AND (metadata->'vision'->>'athlete_prominence')::float8 >= 0.5
  AND athlete_id <> '<HER athlete id>'
GROUP BY athlete_id
HAVING count(*) >= 5
ORDER BY photos DESC;
```

The two strangers are the top two rows; their sample = 5 most-prominent rows each. Rows lacking `face_visibility` get the tag pass (§5) before any distance is measured, so the stranger sample is held to the same `clear` standard as her pack.

## 5. Spend cells (quoted; every cell is Adi's go per run)

Unit prices at the tip, all `estimated` basis:
- face box = one Gemini flash vision call: `qa/cost.ts:35-40` $0.30/M in, $2.50/M out. Probe-scaled image ≈ 1,300 input tokens + ≈ 60 output → ≈ $0.00054 (`qa/face.ts:41` "roughly a tenth of a cent" agrees in order)
- embed = `qa/cost.ts:46` $0.0001 per call
- per photo/frame measured = face box + embed ≈ **$0.00064**
- tag pass per row = `enrich/retag.ts:49` **$0.0048**

| Cell | Formula | Quote |
|---|---|---|
| A. Calibration, her pack | N = 12 photos × $0.00064; 66 pairwise distances are arithmetic | $0.0077 |
| A. Strangers, distances | 2 strangers × M = 5 samples × $0.00064 | $0.0064 |
| A. Strangers, tag pass | 10 rows × $0.0048 | $0.048 |
| **A total** | | **≈ $0.062** |
| B. Drift, self-consistency | 2 clips × ≤ 8 beat-boundary frames × $0.00064 | ≤ $0.0102 |
| B. Drift, is-it-her | runs ONLY if control passed (predicted not to): 2 clips × (4 pack anchors re-embedded + 8 frames) × $0.00064 | ≤ $0.0154 |
| **B total** | | **≤ $0.026** |
| **R + B, worst case** | | **≈ $0.088** |

Nothing about her face is stored between runs (R-1, legal), so every run re-pays the pack's face boxes and embeds. Contact sheets are sharp-only, $0.

## 6. Decisions
- R-1: `pack` is jsonb (ids + measured numbers), see §4.
- C4: the chooser hook is `usePreviewGeneration` on the client; the server reference path is untouched.
- C5: drift reads beat times from `vision.beats` and picks nearest frames from inspectClip's existing strip; no second ffmpeg pass; when a row has no beats it falls back to the strip's own sampled frames.
- Chooser applies only to `intent: "generate"`, still deliverables, no `sourceAssetId` — a person ref on an edit is refused today (`refusedOnEdit`) and a clip is built from one frame.

## 7. Things to know
- **R-3 amended by the walk (Adi, 24 Sep 2026): shot_type now enters the chooser.** Her row read portrait 0.38, portrait 0.32, action 0.212, lifestyle 0.182, then six more (five portrait, one action); `rankPack` attached portrait/portrait/action and the generate lost her build. New rule (`client/lib/identityPack.ts chooseBest`): slot 1 = largest CLEAR face by rank; slot 2 = a body-bearing shot (action / lifestyle / full-body by `shot_type`) when the pack has one, else next by rank; slot 3 = next by rank; when `shot.framing` is wide or medium the body shot leads. Still deterministic, still no model call, still face-anchored. The pack entry now carries the tagger's `shot_type` WORD beside `faceVisibility` (a word, not a number — the row still holds no vector). On save with no body-bearing shot the server answers a non-blocking `nudge` ("add a full-length photo so your build carries too") and the sheet shows it. Mutations by name: "best-3 picks three close-ups from a mixed pack", "slot 1 is not the largest clear face", "body slot ignored when shot.framing is wide", "pack saves silently with no body shot".
- **Walk finding (Adi, 24 Sep): a generate with pack refs preserved the face well, body proportions not.** From the code, the likely cause is the chooser itself: `rankPack` orders by `faceSizeFrac` DESC, then prominence, then clear-before-partial, then id — and consults nothing else. The largest measured face in a frame is, by construction, the tightest crop, so a pack of mixed shots yields three close-ups whenever three exist; the request's shot (`shot.framing`) is not read, contrary to R-3's "the request's shot when present". Three head-and-shoulders anchors give the model no evidence about her build. The three ids it chose are on her profile row (SELECT below, Adi runs). Proposed fix, not built: rank the top slot by face size and fill the remaining two for shot DIVERSITY (at least one non-portrait `shot_type`, i.e. action/lifestyle, when the pack has one), and when `shot.framing` is `wide`/`medium` prefer a non-portrait first. Deterministic, still no model call; a new mutation "best-3 picks three close-ups from a mixed pack" would hold it.
- **Roster: ONE stranger, not two.** Adi's SELECT (24 Sep) found one other athlete with ≥5 qualifying photos (9 photos, 0 face-tagged, 9 untagged). R-4 asked for two. The runner takes N strangers; cell A runs with one unless a second is named. The control is weaker with one — reported, not padded.
- **Ruling 1 vs the UI check.** "One generation with zero explicit refs gets three pack refs" now needs her sentence to name her ("me", "my", "I…") — a bare "the stadium at sunset" with no refs is not a likeness ask and gets zero. Test with a first-person line.
- **"Just these" reach.** The chip is on the Campaign picker and on Make it (both flows' request boundaries). `ThreadMakeIt` (sessions) has no chip yet and defaults to top-up.
- **Calibration spend is not on the cost log.** `LoggedTask` (studio/costLog.ts) is a closed union outside this lane; the route answers the figure and logs it, the ledger cites it.
- **`.env.development` is deny-ruled for me.** Two `EXPO_PUBLIC_STUDIO_IDENTITY_*` lines are Adi's to add.
- `observeGenerateIdentity` untouched (ruling 4): her band reaches edit-root and clip-vs-anchor comparisons only.
- `reroll.ts` untouched: it may cite drift later; nothing cites it now, and `acted: false` is unchanged.

## 7a. Things to know (R)
- `.env.development` is deny-ruled for this session (both `cat` and `grep` refused). The two flag lines will need Adi's hand or an approved append.
- The generate path never applied a band; per-athlete `position()` reaches only `checkIdentity` (edit root, clip-vs-anchor). Reported, not widened.
- Working tree carries the known `blind-eval-2026-09-14.zip` gitattributes dirt; never staged.

## 8. Build (Phase B)

Commits on `studio/identity-pack` (base `e2950e5a` after the second rebase; earlier hashes 49260721… and dbfa13a1… are superseded), unpushed:

1. `426dbe21` — 0067 DDL alone: migration + schema.ts + db-migrate.sh line + parity test.
2. `8926f3b5` — server: `server/studio/identity/{types,profile,packGate,calibrate,routes}.ts`, band through
   `qa/identity.ts → verdict/inspect/videoClip/inspectClip`, `qa/drift.ts`, wire fields in `qa/routes.ts`,
   two flag helpers in `studio/config.ts`, one import + one register line in `routes/studio.ts`.
3. `b4a5ff72` (client) + `2c27b6b8` (format drift.ts) + `45a2c90f` (after #584) + `5f1c9d41` (Add photos) — `client/lib/{flags,identityPack}.ts`, `client/hooks/use-identity-pack.ts`, the chooser hook inside
   `usePreviewGeneration` (`client/hooks/use-studio.ts`), `packPolicy` through `use-studio-pending.ts`, the
   "Just these photos" chip on `MakeItScreen` (route-gated) and `ReferencePicker` (Campaign-gated),
   `IdentityPackSheet.tsx` + its door on `StudioHomeScreen`, the drift line on `QaChip.tsx`; the runner
   this ledger. The runner `probe-out/identity-pack/control.ts` lives in the gitignored `probe-out/` (as library-fields' did) — it stays in the worktree, uncommitted.

**Flags** (server / client, default off, not yet in `.env.development` — §7):
`STUDIO_IDENTITY_PACK` / `EXPO_PUBLIC_STUDIO_IDENTITY_PACK`; `STUDIO_IDENTITY_DRIFT` / `EXPO_PUBLIC_STUDIO_IDENTITY_DRIFT`.

**0067 apply (Adi, by hand, dev)** — the same shape PR 13 used:

```bash
psql "$(grep -m1 '^DATABASE_URL=' /Users/adi/nomila-v2/.env | cut -d= -f2-)" -v ON_ERROR_STOP=1 -f migrations/0067_identity_profile.sql
psql "$(grep -m1 '^DATABASE_URL=' /Users/adi/nomila-v2/.env | cut -d= -f2-)" -c "\d identity_profiles"
```

**Stranger control (Adi runs; cell A):**

```bash
# dry run — quote only
npx tsx --require dotenv/config probe-out/identity-pack/control.ts --athlete <her id> --strangers <id> --sample 5
# after "go A"
npx tsx --require dotenv/config probe-out/identity-pack/control.ts --athlete <her id> --strangers <id> --sample 5 --go
```

Order of operations for cell A: apply 0067 → flags on → she saves a 12-photo pack on the sheet → **Measure**
(POST calibrate, her band on record) → the runner (tag pass, strangers, `control_passed`).

### After #584 (post-rebase edits, commit 5)
- `referenceGate.ts` moved: `likenessDecision(metadata, role, made?)` now at `:159-171`, `ReferenceRefusal` gained `likeness_not_from_her` (`:45`), `madeHereNotHer :73`, `rankOf :109`. The pack gate still calls it without `made`: its own `origin === "generated"` arm runs first and refuses every render, so "made here without her" is a strict subset — covered by construction, never reached. Test added by name: "pack accepts a made-here-without-her still" (reds with the origin-arm mutation).
- `PACK_REFUSAL_COPY` gained the `likeness_not_from_her` key (the union carries it; the copy must be total).
- Candidates are now sorted in #584's tiers for the sheet: usable → partial fill-ins → unread → someone-else / made-here → rejects. UI check: expect strangers below unread.

### Add photos (Adi, 24 Sep): the pack sheet uploads
One "Add photos" pill on the sheet: `pickFromCameraRoll("photo", { multiple: true })` → `useUploadMediaBatch` → refetch
candidates. The rights attestation is the SAME `RightsAckPanel` the library upload and the reference picker use,
answered inline when the server asks. An upload lands in the list as "Still reading" and is never auto-picked; she
picks it once the tagger has read it. Mutations by name: "an uploaded photo is auto-picked into the pack",
"an unread upload can be picked".

### Mutations, red by name (each restored; hash-checked)

| Mutation | Suite | Red test (by name) |
|---|---|---|
| migration and schema disagree | identityProfile.migration | "produces the same table as a schema.ts push — columns, indexes AND constraints" (band_pairs integer→text) |
| pack accepts a photo with no face | identity/packGate | "pack accepts a photo with no face — REFUSED, likeness_no_face" (+1) |
| pack accepts a generated photo | identity/packGate | "pack accepts a generated photo — REFUSED, generated" (+1) |
| pack accepts someone else | identity/packGate | "pack accepts someone else — REFUSED, not_you" (+1) |
| a threshold is asserted before the stranger control passes | identity/calibrate; identity/profile | "no strangers measured is NOT a pass"; "null while the control has not run" (+1) |
| position() reads the profile row when control failed | identity/profile | "null when the control failed" (+1) |
| drift shown as pass/fail | qa/routes | "the line is a time and a count, captioned as an observation" |
| is-it-her shown for an athlete whose control failed | qa/drift | "ABSENT unless anchors are handed" (+1) |
| pack surface renders with STUDIO_IDENTITY_PACK off (server) | identity/routes | "every door answers 404" |
| best-3 picks a small face | client/lib/identityPack | "the largest measured faces come first, unmeasured last" (+4) |
| pack overrides an explicit user reference | client/lib/identityPack | "her picks stay first and untouched; the pack only fills what is left" (+2) |
| pack competes with a product reference | client/lib/identityPack | "a product ref is neither counted nor moved; the pack fills person slots only" (+1) |
| pack attaches to a product-only still (ruling 1) | client/lib/identityPack | "no person intent → the request is returned as-is" |
| pack attaches with the flag off (P-off) | client/lib/identityPack | "off, the body is the variables minus packPolicy, byte-identical" |
| pack surface renders with STUDIO_IDENTITY_PACK off (client) | IdentityPackSheet | "renders nothing and mounts no hook" |
| an uploaded photo is auto-picked into the pack | IdentityPackSheet | "it lands in the list as 'Still reading' and is NOT picked" |
| an unread upload can be picked | IdentityPackSheet | "pressing a 'Still reading' tile does nothing" (+1) |
| drift shown as pass/fail (client) | QaChip | "the line is captioned as an observation and carries the server's sentence only" |
| best-3 picks three close-ups from a mixed pack | client/lib/identityPack | "slot 2 is the best body shot, not the third portrait" (+2) |
| slot 1 is not the largest clear face | client/lib/identityPack | "a larger PARTIAL face never leads" (+1) |
| body slot ignored when shot.framing is wide | client/lib/identityPack | "wide or medium framing puts the body shot first" (+1) |
| pack saves silently with no body shot | identity/packGate + identity/routes | "a pack of close-ups saves AND says so"; "a close-up-only pack saves with the nudge" |

### Scoped runs (post-rebase onto e2950e5a)
- identity 5 suites / 57 / 0 · qa 18 / 240 / 0 · referenceGate 1 / 10 / 0 · routes/studio 13 / 498 / 0 · client area 72 / 1597 / 3 → the three were test-side (two `toBe` against a fresh object; one regex reading style opacities as text), fixed in `50fa591c`; identityPack 18 / 0 and IdentityPackSheet 9 / 0 after.
- Earlier, pre-rebase: the exact-equality wire test caught `driftObservation: null` appearing on old wires — the key is now absent unless the record carries one (P-off held).
- Whole-suite gate: _see §10_.

## 10. Whole-suite gate (bare `npm test`, tip 50fa591c on e2950e5a, 2026-09-24)

| Batch | Suites | Tests | Failed |
|---|---|---|---|
| client#1 | 40 | 547 | 0 |
| client#2 | 32 | 1050 | 0 |
| scripts | 2 | 21 | 0 |
| server/(root) | 2 | 70 | 0 |
| server/lib | 38 | 533 | 0 |
| server/mila | 27 | 381 | 0 |
| server/routes#1 | 40 | 727 | 0 |
| server/routes#2 | 1 | 3 | 0 |
| server/scripts | 4 | 23 | 0 |
| server/services#1 | 40 | 634 | **1** |
| server/services#2 | 40 | 350 | 0 |
| server/services#3 | 22 | 315 | 0 |
| server/skills | 21 | 153 | 0 |
| server/studio#1 | 40 | 1137 | 0 |
| server/studio#2 | 40 | 806 | 0 |
| server/studio#3 | 40 | 1048 | 0 |
| server/studio#4 | 40 | 892 | 0 |
| server/studio#5 | 9 | 152 | 0 |
| server/voice | 29 | 703 | 0 |
| server/workflow | 5 | 45 | 0 |
| **Total** | **512** | **9590** | **1** |

The one red: `server/services/intelligence/research/affiliationSync.test.ts` "a year-only from/to (registry v2 allows YYYY)" — the documented house flake (~1 run in 3 on main), untouched by this branch. In isolation: red once, then 8/8 green. `tsc -p tsconfig.jest.json`: 0 errors at the tip.

## 9. Spend lines (actual)
_(none yet — cells A and B await "go A" / "go B")_
