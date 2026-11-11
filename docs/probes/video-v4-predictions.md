# V4 client video half — predictions, written before the code

Base: main `9e8bb55` (V3 merged, #516). Branch `studio-video-v4`.

Written FIRST, before a line of the diff. Each prediction is what I expect the code to do when it
lands. **Anything that turns out otherwise stops and goes to Adi rather than being absorbed.**

Video is DARK: `STUDIO_VIDEO_ENABLED` defaults off (`server/studio/config.ts:884`), so nothing below
is verifiable end to end today. Every test here is hermetic, $0, and drives stubbed job rows. Claims
that need a real clip are marked **[verifiable only after flag-flip]** and are not faked green.

---

## 0. THE HARNESS BLOCKER, AND THE SHAPE IT FORCES

`jest.config.cjs`: `testMatch: ["**/*.test.ts"]` — **`.test.tsx` does not match and would not run.**
`roots` includes `client/`, but the comment there says why: *"They are pure-logic tests (.test.ts, no
renderer), so they cost seconds."*

Measured, not assumed:

- `grep -n "testing-library\|react-test-renderer\|jsdom" package.json` → **exit 1, no matches.**
- `find client server -name "*.test.tsx"` → **empty.**

So **there is no renderer in this repo** and no way to mount a hook or a component under test.

This collides with the instruction "pin tests through the real client render/watch path, not a mock
asserting a call was made." The only two ways to honour it literally both add a dependency
(`@testing-library/react-native` + `react-test-renderer`, or jsdom), and **no new dependencies
without approval** is a hard rule.

**The shape I am building instead, and the assumption I am proceeding under:** every decision moves
OUT of the hook and the component into pure functions that the real path then calls — the pattern
`threadLogic.ts` already is (pure, 1,000 lines, heavily tested) beside `CreateAnythingScreen.tsx`
(thin). The watch's bookkeeping becomes a pure reducer. The test drives **the same function the hook
calls on every tick**, with no test double standing in for it. That is not a mock asserting a call
was made; it is the real decision logic, exercised directly. What it cannot cover is the React wiring
itself (`useEffect` deps, `setInterval` lifecycle), and I will say so rather than claim coverage I
do not have.

**If you would rather have the renderer, say so and I will stop** — it is a dependency decision, not
mine to make.

---

## 1. F-AM7 — three fixes

Ledger: `docs/probes/sweep-4-ledger.md:696`. Traced in full before touching it; the trace reversed my
own recon proposal.

### 1.1 `frameChoiceNeeded` KEEPS FIRING on a video "You" chip

**Prediction: no behavioural change, and this is deliberate.** `frameChoice("edit")`
(`createAnythingLogic.ts:224`) already filters the video out of the send, so the ask is currently the
only thing standing between her and the server's `refusedOnEdit` blocking gap
(`server/studio/preview.ts:400`, traced: `mode === "edit" && person.length > 0`, no media-type
predicate anywhere on the chain). Silencing it would convert a badly-worded question into a refusal
that costs the whole preview.

Revert check **RC-AM7-a**: a test that asserts the ask still fires for `{marked photo, video "You"}`.
Shown RED against a build where `frameChoiceNeeded` takes `canvasesIn`'s motion filter — i.e. the
fix I proposed in recon and withdrew. It must fail, proving the withdrawal was right.

### 1.2 The copy SELECTION becomes media-type-aware

**Prediction:** `askCopyFor("frame_with_likeness")` (`client/lib/studio-contract.ts:1236`) hardcodes
*"added other photos of you"*, which is false when the second attachment is a clip. I build the
**branch** — the mechanism that can say something true — and a truthful placeholder sentence. I do
**not** invent final wording: the existing line and `frame_pick` beside it already carry
`⚠️ PLACEHOLDER WORDING, for the copy-review pile (Mia)`, and mine will carry the same marker.

**Prediction:** this is a signature change on `askCopyFor` (it currently takes a reason code alone),
so every existing caller must keep compiling and keep its current sentence byte-for-byte when no
video is present.

Revert check **RC-AM7-b**: every existing `askCopyFor` code returns its current string unchanged.
Shown RED by making the video branch the default arm.

### 1.3 The real defect — `canvasesIn` and `ENGINE_ROLE` disagree

**Prediction:** this is the bug under F-AM7 and it is a contradiction between two files:

- `createAnythingLogic.ts:270` `canvasesIn` — a VIDEO/REELS asset is **never** a canvas.
- `studio-contract.ts:396` `ENGINE_ROLE["source-frame"] = "person"` — a VIDEO asset is **always** an
  identity anchor, with no media-type filter at any hop (verified through `toEngineReferences:480`,
  `REFERENCE_ROLES:210`, `resolveReferences:489`, `readOwnedImage:457` — which despite its name has
  no `media_type` predicate).

`frameChoice("edit")` papers over it. **Prediction: the fix is that a motion asset never travels as a
`person` reference on an EDIT**, stated once where both readings can see it, rather than relied upon
as a side effect of a tray filter.

Revert check **RC-AM7-c**: an edit whose tray holds a video "You" chip sends zero `person`
references. Shown RED on current main's logic, where it sends one — the ref that trips
`refusedOnEdit`.

**Registered, NOT built — for the engine-reference owner (Mia):** the **"new" arm** sends that same
video as a `person` reference into a *generate*, where `refusedOnEdit` does not fire. Whether Vertex
accepts a clip in a person slot is untested, and it may burn a `CHARACTER_CAP` slot for nothing. I
have no evidence either way and am not guessing.

---

## 2. The reaper — the settle-every-3s leak

**The leak, precisely:** `useRunWatch`'s `tick()` (`client/hooks/use-studio-sessions.ts:398`) has no
per-key memory. It iterates `current.current` and calls `settle.current(...)` on **every** tick whose
outcome is not `continue`. Today that is survivable only because `CreateAnythingScreen`'s callback
always changes state in a way that removes the watch from the `watches` memo — the watch self-ends by
a round-trip through React, not by any termination condition of its own. A caller that does not
complete that round-trip is re-notified **every 3 seconds, forever, for the life of the mount**.

**Prediction:** a pure watch registry with three rules:

1. **Terminal status** (`succeeded` / `failed` / `canceled`) or **404** ends the watch.
2. A **kind-derived finite wall clock** ends it otherwise — longer for video than the image
   `STALL_AFTER_MS` (10 min), because the server's own per-tick budget `videoPoll().maxMs` is
   *exactly* 600,000 ms and a lease handoff adds another tick on top. Finite, always.
3. **No key is ever settled twice**, and the key is **pruned on every exit path** — including the
   `startedAt` map, which today grows unbounded (`use-studio-sessions.ts:383`).

Revert check **RC-REAP-a** — **THE one to show red.** A watch whose caller never removes it: tick it
repeatedly past settlement and assert `settle` is emitted **exactly once**. Shown RED against the
current every-tick behaviour, where the count climbs with the tick count.

Revert check **RC-REAP-b**: the `startedAt` map is empty after every watch has ended. Shown RED
against today's never-pruned map.

**Not covered, and I will not claim it is:** the `useEffect`/`setInterval` lifecycle itself. No
renderer (§0).

## 2.1 The `running → queued` back-edge — a video going backwards is HEALTHY

The reaper on the server returns a lapsed job to `queued` **keeping** `provider_operation_name`
(`server/studio/videoJobs.ts`, `reapExpiredLeases` step 3) so the next runner resumes polling work
already paid for. The client will therefore observe `running → queued`, possibly more than once.

**Predictions, all three explicitly:**

- It renders as **"still working"** — the same continuing state, not a regression, not an error.
- It does **NOT** trip the reaper. The wall clock does not restart and does not fire early.
- It does **NOT** settle the watch. No `onSettle`, no terminal outcome, no overlay written.

Revert check **RC-BACK-a**: drive `running → queued → running → succeeded` across ticks; assert the
watch stays live across the back-edge, settles exactly once, and settles on `made`. Shown RED against
a build that treats any non-`running` status as terminal (a watch that terminates on the back-edge)
**and** against one whose clock restarts or fires on it (a false stall). Both are the leak.

---

## 3. The queued state

**Prediction:** `pollOutcome` (`threadLogic.ts:974`) currently has no `queued` branch — it falls
through to `continue`, correct by accident, and nothing downstream can tell queued from running. The
client has **zero** occurrences of the string (`grep -rn "queued" client/` → one unrelated hit in
`AddContractSheet.tsx`), and it does not read the `queued: true` flag the generate response carries
(`server/studio/generate.ts:1257`).

**Prediction:** `pollOutcome` gains a status-aware answer so `queued` is **distinguishable** from
`running` without becoming terminal. `LoadingTile`'s blind pulse (`ThreadCards.tsx:189`, fixed copy
"Making it…", no input but its own animation) is not what a video entry renders; the video entry
renders the actual state.

**Prediction:** `useRunWatch`'s **loop shape does not change**. It gains a progress callback. It stays
tab-agnostic — the thread may pass nothing and behave exactly as it does today.

Revert check **RC-Q-a**: a `queued` read is progress, never settlement. Shown RED against a build
where `queued` is terminal.
Revert check **RC-Q-b**: with no progress callback supplied, every existing `pollOutcome` verdict is
byte-identical to today's. Shown RED by changing one existing arm.

---

## 4. In-tab playback

**Prediction: no new dependency.** `expo-video` (`useVideoPlayer`, `VideoView`) is already in
`package.json:99` at `~3.0.16` and already used in `client/screens/StudioScreen.tsx:264` and three
`card-native/VideoCard.tsx` variants.

**Prediction:** today a clip **bounces out of Studio**. `ThreadCards.tsx:222`
(`if (output.mediaType !== "IMAGE")`) renders a film-icon "Open it" that navigates to `MediaDetail`;
`MadeShelf.tsx:63` does the same for any non-`IMAGE` tile; and `AssetViewer.tsx` (448 lines) contains
**zero** occurrences of video/VIDEO/mediaType. The only player is the library screen.

**Prediction: render from the mp4 url, never from a thumbnail.** `videoRunner.ts:168` writes the
asset with no thumb, and posters are produced by a **cron worker**
(`POST /api/internal/media-poster-cron` → `processPosterBatch`, `videoPoster.ts`). A freshly
succeeded clip has `gcs_thumb_path` NULL. `GET /studio/jobs/:jobId` returns `url` and no `thumbUrl`
at all (`shapeAssets`, `routes/studio.ts:792`), so there is nothing to design around.

**[verifiable only after flag-flip]** — that a real Veo mp4 actually decodes in `VideoView` on device.
Playback of a real clip cannot be proven with the flag off, and I will not write a test that pretends
otherwise. Device acceptance is Adi's.

---

## 5. Placement

**Prediction:** a new **provisional** Video tab in `StudioHomeScreen.tsx` (today `StudioTab = "now" |
"made"`, :38). An isolation surface, a throwaway observation harness — not the eventual home.

**Prediction:** the renderer, the watch wiring, the reaper and the player are built as **decoupled,
tab-agnostic components** that the tab merely mounts. Moving them into `MadeShelf`/`ThreadCards`
later must be a **re-mount, not a rewrite**. Nothing they contain may import the tab, and nothing may
reach for tab-local state.

The tab → existing-surface migration is recorded as a **V7-era task**.

---

## 6. Gates

- **`npm test` bare** — the full suite, never a chosen scope (a chosen scope red-mained three times).
  Announced to peer sessions first.
- **This PR's CI green before merge**, not local-green (local-green/CI-red red-mained twice).
- Every revert check above shown **RED by name** before its fix.
- Pre-push review scope: the whole client studio surface (`client/screens/studio` + `client/lib`),
  not hand-picked.
- Merge commit only. I never push; Adi reviews and runs it.

## 7. Registered, not built

| finding | owner | why it is not V4's |
|---|---|---|
| `runState()` (`server/studio/sessions.ts:754`) has the same stall-clock defect — the server history card false-stalls on a multi-tick video | server / Mia | server-side, outside the client half |
| Poster is a cron worker, so a fresh clip has a NULL thumb until it runs | server / Mia | not a bug, a cadence; V4 renders from the mp4 url |
| The "new" arm sends a video as a `person` ref into a generate — untested engine behaviour, possible wasted `CHARACTER_CAP` slot | engine references / Mia | untested, and inventing a fix would be guessing at the engine |

---

# ADDENDUM — F-AM7's sheet-path half (written before the code, after the first diff)

The first diff closed F-AM7 on the **composer** path and left the **sheet** path open. Stated
plainly at the time rather than discovered later: `previewRequestFor` is called twice, and only the
composer's call got `mediaTypes`. The real send builds its request in `use-studio-pending.ts:470`.

## Reachability, measured before choosing

| call site | has the map? | |
|---|---|---|
| `ThreadMakeIt.tsx:63` | **yes** | mounted by `CreateAnythingScreen:1477`, which holds it at `:401` |
| `MakeItScreen.tsx:78` | **no** | `params` arrive through the navigator; nothing in the screen can reach a map |

`MakeItScreen` would need the map lifted into navigation params — `MainTabNavigator.tsx:205`, plus
both navigate sites (`CreateAnythingScreen:671`, which has it; `SetupScreen:77`, which does not).

## Why the map is not the thing to thread

`SetupScreen` does not lack the media type. It **throws it away**. Both mint sites are the same
`MediaLibraryView.onPick` and both hold `m.media_type`:

```
CreateAnythingScreen:1462   setMediaTypes(t => ({ ...t, [m.asset_id]: m.media_type }));  ← a side map
CreateAnythingScreen:1463   addAttachment({ id, role, name, uri, assetId: m.asset_id }); ← not on the attachment
SetupScreen:226             add(role,      { id, role, name, uri, assetId: m.asset_id }); ← discarded
```

⚠️ **THE DECIDING PROPERTY IS THE DIRECTION OF FAILURE.** A parallel map keyed by asset id travels
separately from the tray it describes, so it can arrive partial or stale — and a **missing key reads
as "not motion"**. That fails OPEN: the clip travels, `refusedOnEdit` fires, the preview is blocked.
A guard whose absent case is the harm it exists to prevent is the bug reintroducing itself quietly.
The tray carrying its own truth has no absent case to get wrong.

## Predictions

| # | prediction |
|---|---|
| B1 | `Attachment` gains an optional `mediaType`, set at the two mint sites that already hold it. Navigation params carry it for free — it is a string on a type they already serialize. |
| B2 | `isMotion` reads **the attachment first, the map second** (`a.mediaType ?? mediaTypes[a.assetId]`). Not belt-and-braces for its own sake: an attachment rehydrated from a thread's stored material, or minted before this field existed, has no `mediaType`, and in `CreateAnythingScreen` the map still knows. Attachment-only would have re-opened the fail-open hole for exactly those trays. |
| B3 | `MakeItScreen` needs **no new navigation param**, and `MainTabNavigator.tsx` is not touched. |
| B4 | `SetupScreen` gains protection it never had, without building anything — its attachments now carry the fact it was discarding. |
| B5 | The map survives where it is honestly needed: `livePlanView` (`threadLogic.ts:827`) reads media types for **outputs**, which were never in the tray. It shrinks to that job rather than being deleted. |
| B6 | The composer path does not move. `frameChoice("edit")` still drops the clip before the sheet builds anything, so every composer test stays byte-identical and **RC-AM7-c keeps passing unchanged**. |
| B7 | No server change, no flag change, no new query, no migration. Still client-only. |

## Revert check

**RC-AM7-d — the sheet path.** A tray holding a marked photo and a video "You" chip, driven through
the request builder `useGenerationPlan` actually calls, sends **zero** `person` references and
reports `droppedMotionOnEdit: 1`. Shown **RED** first against today's build, where it sends one —
the reference that trips `refusedOnEdit` and blocks the whole preview.

## Gates

**BOTH** type-checks, every time: `tsc -p tsconfig.json` AND `tsc -p tsconfig.jest.json`. Running
only the second is what let the `.test.tsx` CI failure through — the app config and the test config
fail independently and CI runs them as two separate steps. Then bare `npm test`.
