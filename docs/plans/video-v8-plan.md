# Video V8 — the CapCut-style timeline editor: recon + component plan

Written before any code. Worktree `studio-video-v8` off merged main `a7349d7`, which carries both
`#521` (V5, `e3333d3`) and `#522` (V7, `a7349d7`). Nothing here is built yet.

---

## 1. What exists, and what V8 replaces vs extends

| file                                        | V8 does                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `components/studio/TimelineBuilder.tsx`     | **partly replaced** — the `Row` list + `Ico` up/down arrows go; strip, Shape, Music, CTA, totals, refusal stay |
| `screens/studio/stitchLogic.ts`             | **extended** — trim, split, effective duration. `moveItem`/`normalize`/`setCrossfade`/`toStitchBody` keep their shapes |
| `components/studio/ClipPlayer.tsx`          | **extended, additively** — the view half is extracted so a caller can own the player  |
| `components/studio/playerBox.ts`            | **reused unchanged** — `playerBox`, `ratioForTarget`, `VIDEO_FILL`, `previewKind`     |
| `components/studio/ClipPoster.tsx`          | **unchanged, and fenced** — tiles only, never the preview or the result               |
| `components/studio/VideoEntry.tsx`          | **unchanged** — still the result card                                                 |
| `screens/studio/videoEntryLogic.ts`         | **unchanged**                                                                         |
| `hooks/use-studio-stitch.ts`                | **unchanged**                                                                         |
| `screens/studio/VideoTab.tsx`               | **unchanged** — still a mount point, still nothing load-bearing                        |
| `screens/MediaDetailScreen.tsx`             | **modified** — the decorative play glyph becomes a real player (its own comment says "playback is V8's") |
| `server/**`                                 | **NOT TOUCHED.** V8 is client-only — see §3                                            |

## 2. The server already accepts everything V8 sends — V8 is a client-only card

`server/studio/video/spec.ts` `parseStitchSpec` already takes `trimStartSec` / `trimEndSec` per
clip, already refuses `trimEndSec <= trimStartSec` by field, and `toStitchRequest` already passes
both to the V6 engine. V6 measured that input-level `-ss`/`-to` are **absolute in the source
timeline**, which is exactly the semantics split needs. So:

- **Trim** is a UI for fields the wire already carries.
- **Split** is two spec entries with the same `assetId` and adjacent trim ranges. No new field.
- **Byte budget is unaffected by a split** — `assertTimelineFits` counts bytes over UNIQUE assets
  (one download) and seconds/clips over POSITIONS. A split costs one of the 12 clip slots and zero
  bytes.

No migration, no route, no server change. The one server-shaped thing V8 needs is a *duration*,
and that is §3.

## 3. ⚠️ The prerequisite nobody has: a proportional track needs durations, and we mostly don't have one

`media_assets.duration_seconds` is written **only when the client sends one at upload**
(`routes/media.ts:356`, from `expo-image-picker`'s `asset.duration`), and it is an **INTEGER**
column — `Math.round()`ed on the way in. Every other path (Instagram-origin, generated, anything
not through the picker) leaves it NULL. This is the same NULL that V7's `be6e9d7` had to work
around server-side.

Two consequences, and both are load-bearing for V8:

1. **A null duration is a zero-width clip.** `stitchLogic.timelineTotals` deliberately charges an
   unknown at 0 — right for a label under a picker, fatal for a track laid out proportionally.
2. **A rounded duration is the wrong length to trim against.** Trim handles that address a 7-second
   span on a 7.4-second clip cannot reach the last 0.4s, and split would produce a segment the
   engine disagrees with.

**Approach: the client measures the duration itself.** `expo-video` exposes `readonly duration:
number` and a `statusChange` event carrying `readyToPlay` (verified in
`node_modules/expo-video/build/VideoPlayer.types.d.ts`). A `useClipDurations` hook creates a player
per distinct `assetId` on the timeline, reads `duration` at `readyToPlay`, caches by assetId,
releases. The ladder is: **measured → the wire's `durationSec` → unknown**, and an unknown is drawn
at a fixed placeholder width with an explicit treatment, never as zero.

**OUT OF SCOPE, proposal only** (`CLAUDE.local.md`: Mila needs a change in shared code → write it
down, do not make it): the right fix is for the server to probe duration at upload — the runner
already ffprobes every clip — and to widen `duration_seconds` past an integer. Blast radius:
`routes/media.ts`, `shared/schema.ts`, a migration, and every consumer of the column. **Adi to raise
with Mia; V8 works around it client-side.**

## 4. Interaction architecture

### 4.1 Geometry — one pure module, the house pattern

`screens/studio/timelineGeometry.ts` + `.test.ts`, pure, no React — the same split as
`contained-stage.ts` / `use-contained-stage.ts` and `playerBox.ts` / `ClipPlayer.tsx`. It owns:

- `layout(items, durations, pxPerSec)` → a rect per item, plus the track's total width
- `timeAtX(x, …)` / `xAtTime(t, …)` — inverses, pinned by a round-trip test
- `resolve(playheadSec, …)` → `{ index, localSec }` — which clip is under the playhead and where

**Pixels-per-second with horizontal scroll and a zoom factor, NOT fit-to-width.** A 3:00 timeline
fitted to a 358 pt column draws a 4-second clip at 8 px; trim handles on that are not an
interaction. Fixed pps + scroll is what CapCut does and what the later auto-index card needs.

**No minimum drawn width.** A minimum would make `timeAtX` piecewise and non-invertible, which is
the one property every other piece leans on. Tappability comes from `hitSlop`, not from lying about
the geometry. Flagged as a device-acceptance item: a very short segment may be hard to grab.

### 4.2 Trim → spec

`TimelineItem` gains `trimStartSec?` / `trimEndSec?`, absolute in the source. A pan on an edge
handle moves one of them; the commit clamps to `[0, measuredDuration]` and enforces
`trimEnd > trimStart` **before** it can reach the wire, because the server refuses that pair by
field and a 400 she cannot see the cause of is the worst outcome.

`toStitchBody` emits each field only when set, so **an untrimmed timeline produces a byte-identical
body to today's**.

**`timelineTotals` must switch to effective duration** — `(trimEnd ?? whole) - (trimStart ?? 0)`,
matching `materialize.effectiveSeconds`. Without that change, splitting one 10 s clip in half counts
as 20 s on the client while the server counts 10 s, and the optimistic mirror refuses a timeline the
server would accept — "the worst kind of disagreement, because she would never find out she was
allowed" (that file's own words).

### 4.3 Split at the playhead

`splitAt(items, index, localSec)` → two items, same `assetId`, fresh keys:

- A: `trimStartSec = s0`, `trimEndSec = s0 + localSec`
- B: `trimStartSec = s0 + localSec`, `trimEndSec = e0`

where `s0 = trimStart ?? 0`, `e0 = trimEnd ?? measuredDuration`.

Decisions to pin:

- **A keeps the original's `crossfadeSec`; B gets none.** B follows A across a cut that was one
  continuous shot a moment ago — a fade there would invent a transition she did not ask for.
- **A split at either edge is refused**, not clamped: a zero-length segment is exactly the
  `trimEndSec <= trimStartSec` the spec parser rejects.
- **A split costs a clip slot** (`maxClips = 12`). The existing refusal line covers it once totals
  are effective-duration-aware.

### 4.4 Drag-to-reorder — web AND native, one code path

**`react-native-draggable-flatlist@4.0.3` is in `package.json` and used nowhere in the repo.** It is
list-shaped and built against reanimated 2/3; this app is on **reanimated 4.1.1 / RN 0.81**. Not
recommended — adopting an unused, likely-incompatible dependency to avoid ~80 lines is the wrong
trade.

**Recommended: hand-rolled `Gesture.Pan()` + reanimated**, which is already this repo's idiom in
three places — `MaskEditor.tsx` (`.runOnJS(true)`), `AssetViewer.tsx` and `CardDeck.tsx`
(worklet + `runOnJS(commit)`). `GestureHandlerRootView` is already mounted at `client/App.tsx:170`,
so web and native both have the root they need. No new dependency.

- **Activation: `activateAfterLongPress`.** A bare horizontal pan inside a horizontal ScrollView
  loses the gesture race on both platforms; long-press-then-drag resolves it and is also the CapCut
  interaction.
- **`.runOnJS(true)`**, MaskEditor's flavour — the index math then lives in a pure function
  `timelineGeometry` owns, rather than in a worklet nothing can test.
- **One code path for web and native.** RNGH v2's `Gesture` API has a web implementation; I am *not*
  planning separate handlers. What I have **not** verified is how that pan behaves inside a
  horizontal ScrollView in Chrome specifically — that is a named device-acceptance item, not a
  claim.

### 4.5 Multi-clip preview playback — the hard piece, and what I propose

`expo-video` gives everything the hard version needs (all verified in the installed `.d.ts`):
`replaceAsync(source)`, settable `currentTime`, `seekBy`, `statusChange`, `playToEnd`, and
`timeUpdate` on a settable `timeUpdateEventInterval`. So this is a design choice, not a capability
gap.

**Option 1 — full cross-clip playback (the hard version).** One player; on a boundary, `replaceAsync`
then seek; `playToEnd` advances. Costs: every boundary is a load + seek, so continuous playback
across clips **stalls visibly** unless a second player is pre-warmed, which doubles the controller;
`replaceAsync` → seek is racy and has to wait for `readyToPlay`; trim needs in/out enforcement in
the `timeUpdate` handler because expo-video has no in/out points. This is the single piece most
likely to balloon the card.

**Option 2 — tap-a-clip-plays-it (the simple version).** The preview plays one clip; full-timeline
preview is the stitched result. Cheap, but there is no global playhead — and the global playhead is
the thing the later auto-index card needs to exist.

**Option 3 — RECOMMENDED: global timeline, single-clip playback.**

Separate *seeking* (cheap) from *continuous playback across a boundary* (expensive), because only
the second one is hard:

- The **playhead is global** — one timeline, one ruler, one time. Scrubbing anywhere, including
  across a boundary, swaps the source and seeks. You can scrub to "2.5s into clip 3" and see that
  frame.
- **Play plays the clip under the playhead** and stops at its out-point. No auto-advance, no
  pre-warmed second player.

That delivers items 1, 2, 3 and 7 in full, and leaves exactly one behaviour out: pressing play once
and watching all twelve clips run together. That already has an answer — "Put it together" is $0 and
one ffmpeg call. **Option 1 then lands later as `onPlayToEnd → advance` on the same controller, with
no rebuild** — which is the property the card is supposed to have.

**Adi picks.** I am not committing to Option 1 silently; if you want it in V8, say so and I will cost
it as its own checkpoint.

### 4.6 The preview player, and item 7 (the result must play the real mp4)

`ClipPlayer` owns its player via `useVideoPlayer(uri)` — right for a card, wrong for a preview that
must be seeked from outside. **Additive extraction**: the view half (`playerBox` + `VideoView` +
`VIDEO_FILL` + the `#0D0B08` frame) becomes `PlayerSurface`, taking a `player`; `ClipPlayer` keeps
its hook and renders `PlayerSurface`. **Every existing caller stays byte-identical** — the same
"defaulted to today's value" rule V4 and V7 used.

`TimelinePreview` owns a player and renders `PlayerSurface` at `ratioForTarget(target)` under V7's
`MAX_PLAYER_HEIGHT` cap. The **result** path is untouched: `VideoEntry` → `ClipPlayer` → the signed
mp4 off `GET /studio/stitch/:id` (`shapeAssets` signs `gcs_path`, so it is the mp4, not a poster).

**`ClipPoster` is fenced to tiles.** A revert check makes that structural rather than a comment.

## 5. Testable vs device — the honest split

### Jest proves (pure `.test.ts`)

- clip layout rects and total width; proportionality; `timeAtX`/`xAtTime` round-trip; zoom
- effective duration with and without trim; the duration ladder (measured → wire → unknown)
- `toStitchBody` trim mapping, and that it never emits `trimEndSec <= trimStartSec`
- split: **the two segments sum exactly to the original**, same `assetId`, A-keeps-crossfade /
  B-gets-none, refusal at both edges
- reorder ordering, and `normalize` still stripping a crossfade that reaches index 0
- totals and refusals under trims and splits, against `materialize`'s own accounting rules
- `resolve(playheadSec)` → clip index + local time, at boundaries and under trims

### Jest proves (rendered `.test.tsx`) — including the gestures

I spiked this rather than assuming it. **A real `Gesture.Pan()` can be driven from jest**:
`react-native-gesture-handler/jest-utils` ships `fireGestureHandler` and `getByGestureTestId`, and
a probe in this worktree drove a real pan through a real `GestureDetector` and saw
`onUpdate` fire with the right translations. So drag, trim and scrub are pinned **through the real
gesture object**, not a mock asserting a handler was called.

- the preview and the result mount a **player** and are handed the **mp4 uri** — never a poster
  (the item-7 regression check)
- tap a clip in strip / track / library → the preview's source becomes that clip's uri
- the track renders one element per item at the computed widths
- a pan across two clip widths commits the reorder; a pan on a trim handle moves `trimEndSec`; a pan
  on the playhead moves the playhead

**⚠️ One config trap, named now because it is the class that red-CI'd V4.** RNGH needs its
`jestSetup` loaded or the suite dies at import with `'RNGestureHandlerModule' could not be found`
(reproduced). Adding `setupFiles` to the `react-native` project in `jest.config.cjs` **overrides the
preset's own**, so it must be written as *both*:

```js
setupFiles: [
  require.resolve("react-native/jest/setup.js"),          // what preset: "react-native" supplies
  require.resolve("react-native-gesture-handler/jestSetup.js"),
],
```

Listing only the RNGH one drops `__DEV__` and RN's native mocks. The `node` project is untouched, so
no server suite changes.

**And prove the key actually took effect rather than inferring it from a green run.** The
`testTimeout` bug in §7 is precisely a config key that *looked* per-project and silently did
nothing for months; `setupFiles` genuinely is per-project (the preset sets it that way), but the
discriminator is cheap — the gesture suite fails at import without it, so its passing IS the proof.
Coordinating with the peer session so we don't both edit `jest.config.cjs`.

### Device only — Adi's acceptance

- that the drag *feels* like a drag, and that long-press-to-drag does not fight the horizontal
  ScrollView **on native and in phone-width Chrome**
- that scrubbing is smooth and the seek lands where the playhead says
- that a real mp4 decodes, and whether the source-swap stall at a boundary is tolerable
- **that the stitched result plays** (the V7 symptom — see the open question below)
- the media-library player on a real asset
- that a very short segment is still grabbable with `hitSlop` and no minimum width

## 6. Checkpoints

One reorder from the brief's list: duration measurement has to come first (the track cannot be
proportional without it), and the preview lands before trim (trim handles need something to trim
*against*, and tap-to-preview is the smallest piece that proves the player plumbing).

| # | checkpoint                                             | brief item |
| - | ------------------------------------------------------ | ---------- |
| 0 | pure geometry + duration measurement, no UI change      | prerequisite |
| 1 | the track renders proportionally + ruler; arrows stay   | 1 |
| 2 | preview player + tap-to-preview; result plays real mp4  | 2, 3, 7 |
| 3 | playhead + scrub (global, seek-based)                   | 1 |
| 4 | trim handles                                            | 4 |
| 5 | split at playhead                                       | 5 |
| 6 | drag-to-reorder; up/down arrows removed                 | 6 |
| 7 | media-library player                                    | 8 |

## 7. Gates and traps for this branch

- Gate is bare `npm test` — **361 files / 15 batches** on this base, and `client` is one of them, so
  the component tests **do run in CI**. Jest handshake to peer sessions before any full run.
- **⚠️ Every suite in this repo has been running on jest's 5 s default, not `testTimeout: 120_000`,
  since the V4 split (`6f6bbed`).** Found by the peer session on 2026-09-19: `testTimeout` sits
  inside the `shared` object spread into `projects[]`, and jest-circus reads it off the **global**
  config only. Their fix (hoist it to top-level `module.exports`) is on
  `studio/stitch-runner-hook-timeout` @ `73d3b84`, **not yet pushed**.
  Two consequences for V8: a `.test.tsx` that mounts a renderer and constructs video players is
  exactly the suite that would trip a 5 s limit, so **until that lands, V8's component tests run
  under 5 s**; and a hook timeout here is not automatically contention, which is what two of my
  standing notes assumed.
- **Baseline: 361 suites / 6724 tests / 0 failed, 15/15 batches green** — the peer's full run with
  the hoist in. That is *cleaner* than the baseline on record (`run-tests.ts`'s header names
  `composite.test.ts` and `voice/dealRoutes.test.ts` as known reds, and `affiliationSync` flakes
  ~1 in 3). I have asked whether those were specifically checked. **If it holds, any red in a V8
  gate run is V8's** — no known-red subtraction.
- **Both** `tsc -p tsconfig.json` and `tsc -p tsconfig.jest.json` (the V4 config gap).
- **`client/screens/MediaDetailScreen.tsx` is NOT prettier-clean on this merge base** — the only one
  of the ten files V8 touches that isn't. Checkpoint 7 edits it surgically; a save-on-format would
  reformat the whole file and bury the diff. Base-vs-now check on every touched file.
- `server/scripts/calibration/runs/blind-eval/*.zip` shows modified without being touched — known
  born-dirty. Never `git add -A`.
- Merge commit only. No push helper is ever invoked — `bash -n` only.

## 8. Open questions for Adi

1. **Option 3 vs Option 1 for preview playback** (§4.5). I recommend 3.
2. **The V7 "blue placeholder" on the result — where was it seen?** I could not reproduce it from
   source, and it does not come from our palette: the light theme has no blue, and the result path
   is `VideoEntry → ClipPlayer → the signed mp4`, with `ClipPoster` nowhere near it. Meanwhile the
   merged V7 tip carries three display fixes (`da5ea3d` player size, `1388ace` poster, `2edb6bb` the
   `<video>`-never-sized-itself fix) that post-date most of the V7 build. **Was the blue placeholder
   seen on merged `a7349d7`, or before those landed?** If it survives on `a7349d7` I need the
   platform (iOS vs Chrome) to chase it; either way the revert check in §4.6 ships.
3. **The `duration_seconds` proposal** (§3) — yours to take to Mia, or park?
