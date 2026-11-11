# Video V8 — predictions, per checkpoint

Written before each checkpoint's diff. Plan: `docs/plans/video-v8-plan.md`.

---

## Checkpoint 0 — geometry + durations

Pure arithmetic plus one thin hook. **No UI changes**, nothing rendered differently, no wire change.

### What recon established that shapes this

`media_assets.duration_seconds` is written **only when the client sends one at upload**
(`routes/media.ts:356`) and is an **INTEGER** column. Every other path leaves it NULL. A parallel
card is fixing that server-side; **this client fallback stays regardless**, because it is what
covers un-probed and un-backfilled rows.

### Predictions

1. **Layout and totals must give DIFFERENT answers for an unknown duration, and making them agree
   would be the bug.** An unknown draws at a placeholder width (never zero, or the clip is
   invisible and untappable) but must still contribute **0** to `timelineTotals` — that file's
   existing, deliberate choice, because "telling her a timeline is three minutes long when we do
   not know is worse than telling her it is shorter than it is". A placeholder that leaked into the
   totals would inflate the refusal and block legal timelines.

2. **The track must subtract the crossfade, or the playhead lies about time.** Clip *i* starts at
   `previousEnd − crossfade_i`, so clips overlap by exactly the fade. That makes the track's total
   `Σduration − Σcrossfade`, which is what `timelineTotals` already computes and what `plan.ts`
   uses to place the xfade offsets. Laying clips end-to-end instead would put the playhead up to
   2 s per join away from the frame it points at.

3. **No minimum drawn width.** A minimum makes `timeAtX` piecewise and non-invertible, and every
   later piece — scrub, trim, split — leans on that inverse. Tappability comes from `hitSlop`.
   Predicted cost: a sub-second segment is genuinely hard to grab. That is a device-acceptance
   item, not a reason to lie about the geometry.

4. **Inside a crossfade two clips contain the same instant; the LATER one must win.** It is the
   clip being faded *into* and the one drawn on top. A first-match scan would resolve the playhead
   to the outgoing clip and preview the wrong frame for up to 2 s at every join.

5. **`sourceSec` is SOURCE time, not track time — this is the easiest thing here to get wrong.**
   Seeking a trimmed clip needs `trimStart + (playhead − rect.start)`. Forget the offset and every
   trimmed clip previews from the wrong frame, invisibly, because an untrimmed clip (`trimStart`
   = 0) behaves identically. The test that catches it must use a clip with `trimStart > 0`.

6. **`player.duration` is only meaningful once `status === "readyToPlay"`.** Read earlier it is 0,
   which is indistinguishable from a legitimately-unknown clip and would poison the cache with a
   zero-width entry. The hook gates on the status event and rejects anything non-positive.

7. **The measuring players must be released.** One decoder per clip, up to 12, held for the life of
   the screen is the same class of leak V4's watch was about. Release on cache-write and on
   unmount; a subscription is removed before the player goes.

8. **Measured beats wire even when wire exists**, because wire is `Math.round()`ed on the way in —
   a 7.4 s clip is stored as 7, and trim handles built on 7 cannot reach the last 0.4 s.

9. **A crossfade longer than either neighbour has nothing to fade** — clamp to
   `min(fade, previous.seconds, current.seconds)` so the layout cannot produce a negative-width or
   out-of-order rect from a spec the server would have refused anyway.

### What this checkpoint CANNOT prove

- That a real mp4's duration reads back correctly on a device. `expo-video` is mocked in jest.
- Anything about how the track looks. Nothing renders yet.

### Revert checks for this checkpoint (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC0.1 | drop the trim offset in `resolvePlayhead` (`sourceStartSec + …` → `…`) | the trimmed-clip seek test |
| RC0.2 | first-match instead of last-match in the overlap scan | the crossfade-overlap test |
| RC0.3 | lay clips end-to-end (stop subtracting the crossfade) | the total-seconds test |
| RC0.4 | let the unknown placeholder count into layout totals as a real duration | the unknown-contributes-placeholder-to-WIDTH-but-zero-to-TOTALS pair |
| RC0.5 | prefer wire over measured in the ladder | the rounded-integer test |

---

## Checkpoint 1 — the track and its ruler

The first thing that renders. **The up/down arrows stay**, and so does the `Row` list they live on:
the track is added above it, not swapped for it, so nothing she can do today stops working before
checkpoint 6 replaces the controls properly. The track is VIEW-ONLY here — tap-to-select belongs to
checkpoint 2, where there is a preview for it to drive.

### Predictions

1. **A tile on the track must be `ClipPoster`, never `ClipPlayer`.** They look similar and are
   opposites, which is why `ClipPoster.tsx` says they must stay separate components rather than one
   behind a flag — "the flag is how a strip of ten tiles ends up all playing at once". Twelve
   autoplaying decoders on a track is exactly that failure. Revert check: swapping in `ClipPlayer`
   must red.

2. **Absolute children need the container to carry an explicit width, or the track cannot scroll.**
   A `ScrollView` sizes its scrollable extent from its content; absolutely-positioned rects
   contribute nothing to that. The inner view has to be `width: layout.totalWidth`, and getting it
   wrong fails *silently* — the track renders correctly and simply refuses to scroll past the
   viewport, which looks like a short timeline rather than a bug.

3. **The ruler's tick interval has to follow the zoom.** One tick per second is 200 pt apart at
   maximum zoom and 8 pt apart at minimum — unreadable at one end, useless at the other. A ladder
   picked so ticks are at least ~44 pt apart is the fix, and it means the interval is a function of
   zoom rather than a constant anyone can read off the design.

4. **A tick past the end of the track would lie about the length of the video.** Ticks stop at
   `totalSeconds`, so the ruler never implies footage that is not there.

5. **Later clips must paint over earlier ones**, because a crossfade means two rects genuinely
   overlap and the later one is the frame she is looking at — the same rule `resolvePlayhead`
   already follows. In React Native a later sibling paints on top, so the checkable property is
   that the track renders its rects in timeline order. A test can assert the order; paint itself is
   device acceptance.

6. **An unknown duration must not be labelled with the placeholder.** The tile is DRAWN three
   seconds wide so it can be seen, but its label says "—", the same as `Row` does today. A tile
   that reads "0:03" over a clip of unknown length would be the placeholder escaping into something
   she could believe.

7. **The hook is fed the TIMELINE, not the strip.** `useClipDurations` opens decoders, capped at
   four; the timeline is bounded at `maxClips` = 12 and the strip is not bounded at all. Feeding it
   the strip would be the cost `ClipPoster` exists to avoid, paid again.

### What this checkpoint CANNOT prove

- That the track looks right, scrolls well, or that the overlap reads as a crossfade rather than as
  a rendering fault. Device acceptance.
- Poster/decoder cost with twelve tiles on screen beside the strip's own. Flagged for the device
  pass; note the strip already mounts one `ClipPoster` per video she owns, so this is an increment
  on an existing cost rather than a new one.

### Revert checks for this checkpoint (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC1.1 | drop the explicit `width` on the scroll content | the track-is-as-wide-as-the-timeline test |
| RC1.2 | fix the ruler interval to a constant 1 s | the three ruler tests |
| RC1.3 | let ruler ticks run past `totalSeconds` | the ruler-stops-at-the-end test |
| RC1.4 | label an unknown-duration tile with its placeholder seconds | the unknown-reads-em-dash test |
| RC1.5 | render the rects in reverse order | the timeline-order test |
| RC1.6 | make a track tile a `ClipPlayer` instead of a still | the never-plays-on-the-track test |

### What writing these caught in the tests themselves

RC1.2 first red FIVE tests, two of which were the clip-LABEL tests — because at a one-second tick
interval the ruler prints `0:06` and `0:03` too, and a bare `getByText` was matching a ruler tick
rather than the clip's own label. That is the failure mode where a wrong clip label passes because
some tick happens to read the same string. Both label queries are now scoped to the clip node with
`within()`, and RC1.2 reds only the three ruler tests.

---

## Checkpoint 2 — the preview, tap-to-preview, and the result

The first checkpoint with something to look at on a device. Three pieces: a player above the track,
a tap that fills it, and the insurance that the finished stitch keeps playing the real mp4.

### The extraction, and why it is shaped this way

`ClipPlayer` owns its player (`useVideoPlayer(uri)`), which is right for a card and wrong for a
preview that has to be seeked from outside. So the VIEW half becomes `PlayerSurface`, which takes a
player; `ClipPlayer` keeps its hook and renders it. **Every existing caller stays byte-identical** —
the same "defaulted to today's value" rule V4 and V7 used. Nothing that renders a clip today
changes, which is the property that makes this safe to do underneath the result.

### Predictions

1. **`replaceAsync` then an immediate seek is racy, and the race is silent.** Setting `currentTime`
   before the new source is `readyToPlay` either no-ops or seeks the OUTGOING item. The seek has to
   be queued on the status, not issued beside the replace. Predicted symptom if wrong: previewing a
   trimmed clip starts at 0:00 the first time and at the right frame on a second tap, which reads
   as "sometimes works".

2. **A stale seek must not land on a newer source — this is the real concurrency bug here.** Tap A
   then B quickly and A's `readyToPlay` can arrive after B's replace. Without cancelling the older
   request, B gets seeked to A's in-point. The effect's cleanup is what cancels it; a `uri !== prev`
   guard does not, because it cannot tell which load finished.

3. **Re-tapping the SAME clip must restart it, so the trigger cannot be the uri.** A naive
   `source !== previous` guard makes the second tap a no-op, and "tap it again to watch it again"
   is the most obvious thing to try. The trigger is a token that changes on every request.

4. **The preview must NOT loop, where `ClipPlayer` does.** Looping is right for a few-second card
   playing unattended; on a preview it hides the out-point and will fight the playhead in
   checkpoint 3.

5. **The out-point has to live in the player, not in the caller.** A clip with `trimEndSec` must
   stop there — `expo-video` has no in/out points, so it is enforced in the `timeUpdate` handler.
   Written NOW rather than at checkpoint 4, because the alternative is checkpoint 4 adding handles
   AND fixing the player in the same diff. ⚠️ No clip carries a trim yet, so this is exercised by
   the fake and NOT in practice until checkpoint 4.

6. **The result must never route through a poster, and a url assertion does not prove it.** This is
   the V7 symptom. Checking that the player was handed an `.mp4` still passes if something renders
   a poster *as well* — so the check is structural: `ClipPoster` mocked to a marker, and the marker
   must be absent from a ready result. Posters stay tiles-only.

7. **Tap-to-add must keep adding.** The strip's tile adds to the timeline today; making it preview
   instead would remove the primary action. It does both — the clip is added AND becomes what the
   preview shows, which is the behaviour worth having anyway.

### What needs Adi's eyes — this checkpoint is the first device pass

- **That a real mp4 decodes and plays in the preview at all.** Everything below is a fake.
- **That the stitched result plays** rather than showing the V7 placeholder. The structural check
  proves no poster is rendered; it cannot prove the mp4 decodes.
- Whether an autoplaying, AUDIBLE preview is right when she taps a strip tile to add a clip. It is
  a deliberate review surface with one player and native controls, but it is a judgement call.
- Whether the source swap on tap is fast enough to feel like a tap.
- Both surfaces: iOS Simulator and phone-width Chrome.

### Revert checks for this checkpoint (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC2.1 | render the result through `ClipPoster` instead of `ClipPlayer` | the result-plays-the-mp4-not-a-poster test |
| RC2.2 | seek beside the replace instead of on `readyToPlay` | the seek-waits-for-ready test |
| RC2.3 | drop the cancellation, so an older load can seek a newer source | the stale-seek test |
| RC2.4 | trigger the preview off the uri instead of the token | the re-tap-restarts test |
| RC2.5 | let the preview loop | the preview-does-not-loop test |
| RC2.6 | drop the out-point stop in `timeUpdate` | the stops-at-the-out-point test |

---

## Checkpoint 3 — the playhead, the scrub, and the audio toggle

### Recon answer: the preview is NOT muted today, and that matters

`TimelinePreview` sets `p.muted = false` at construction and a test asserts it. So "the preview
currently plays muted" is almost certainly **Chrome's autoplay policy**, not our code: `play()` is
called from a `replaceAsync` continuation, which is detached from the tap that caused it, and
unmuted playback started without a qualifying user gesture is blocked. The new default is right
regardless — and it has a second benefit nobody asked for, which is that **muted autoplay is always
permitted**, so defaulting muted makes the preview start reliably rather than sometimes.

### Recon answer: the toggle is preview-only, and the result already does the right thing

`PlayerSurface` is shared, but `muted` is not owned there — `ClipPlayer` takes it as a prop and
`VideoEntry` passes it through. The stitch result is **already** mounted with `muted={false}` by
`TimelineBuilder`, for V7's reason: the last stage of that pipeline is MUSIC and a bed nobody can
hear is a bed nobody reviews. So Adi's lean is already the status quo.

**Decision: the toggle lives in `TimelinePreview` and the result is not touched.** They are
different moments — reviewing source clips while building, versus watching the thing you made. A
toggle on `PlayerSurface` would have put preview state into a component whose whole job is to be a
dumb box, and would have changed the result's behaviour as a side effect.

**Custom control rather than native.** Native controls auto-hide, so the mute state is not visible
at a glance — and "am I about to make noise" is exactly the state that must be visible. They also
differ between web and iOS, which are the two surfaces being verified. And a React-owned toggle is
the only version with a seam a test can hold.

### Predictions — the scrub

1. **Scrubbing must NOT re-open the clip it is already inside.** A pan emits an update per frame;
   if each one calls `replaceAsync`, a drag inside one clip re-loads the video dozens of times.
   The same-source path has to be a bare `currentTime` write. This is the difference between a
   scrub and a slideshow.

2. **A seek and a play are different intents and the spec has to say which.** Checkpoint 2's
   preview plays whatever it is given. A scrub that played would fight the drag. So the spec
   carries `autoplay`, and a scrub explicitly PAUSES — a clip running on under a finger that is
   dragging is the same bug as not seeking at all.

3. **The playhead must not drive the seek, or playback feeds back into itself.** Playback moves the
   playhead; if the playhead's position then produced a seek, every `timeUpdate` would re-seek the
   player and the clip would stutter or stall. The split: **a seek request is only ever produced by
   a gesture or a tap**, and `timeUpdate` moves the line and nothing else.

4. **Crossing a boundary is the one place this design can disappoint.** Inside a clip a scrub is a
   seek — cheap. Across a seam it is `replaceAsync` + seek, which has to load. Predicted: a visible
   hitch at the seam, worse the first time each clip is touched. ⚠️ **Only Adi can judge whether
   that reads as a scrub or a stutter.** No debounce, deliberately — debouncing would trade a hitch
   at the seam for lag on every scrub.

5. **`resolvePlayhead` already answers "which clip", and the inverse is needed too.** Playback
   reports SOURCE seconds; the line is drawn in TRACK seconds. `trackTimeAt` is that inverse, and
   the two must round-trip or the line drifts from the frame during playback.

6. **The scrub band is the ruler, not the whole track.** A pan over the clip lane would fight
   tap-to-select now and long-press-to-drag at checkpoint 6. Putting the gesture on the ruler
   settles that conflict once instead of twice.

### Predictions — the audio toggle

7. **The mute state must live OUTSIDE the load path.** The bug to avoid is re-asserting `muted` when
   a source is swapped: she unmutes, scrubs across a boundary, and it goes quiet again. `muted` is
   its own effect keyed on its own state, and the replace path must never write it.

8. **Default muted, and that is a REVERSAL of a checkpoint 2 test.** "is audible, because a review
   surface nobody can hear is one nobody reviews" becomes "starts muted". Recording it so the flip
   reads as a decision rather than as a regression someone loosened a test to allow.

### What needs Adi's eyes

- **Does crossing a clip boundary feel like a scrub or a stutter?** The single device-critical
  question of this checkpoint.
- Whether the playhead tracks playback closely enough to look attached to it.
- Whether the mute toggle is discoverable where it sits, and whether unmuting survives scrubbing
  the way it should.
- Whether scrubbing the NATIVE control inside the clip desyncs the playhead visibly.
- Both surfaces, again: iOS Simulator and phone-width Chrome.

### Revert checks for this checkpoint (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC3.1 | `resolvePlayhead` first-match, so a boundary scrub lands on the outgoing clip | the scrub-at-the-boundary test |
| RC3.2 | drop the out-point stop | the play-stops-at-the-out-point test |
| RC3.3 | `replaceAsync` even when the source is already loaded | the scrub-does-not-reload test |
| RC3.4 | make a scrub autoplay | the scrub-pauses test |
| RC3.5 | re-assert `muted` inside the load path | the unmute-survives-a-source-swap test |
| RC3.6 | start unmuted | the starts-muted test |
| RC3.7 | let `timeUpdate` produce a seek request | the playback-does-not-re-seek test |
| RC3.8 | drop the cancellation from checkpoint 2 | the stale-seek test, still |

---

## Checkpoint 3a — the track drew every clip the same width (bug)

Found on device: two clips of different real lengths drawn identically, both labelled "—", totals
reading "0:00 of 3:00". Reported as "the measured duration reaches the player but not the layout".

### Diagnosis: there was no measurement at all, and the player was never evidence of one

**The player does not consume a duration.** `TimelinePreview` contains no reference to `duration`,
and `endSec` is `null` for every position today because nothing produces a trim until checkpoint 4.
So the preview plays the file to its end WITHOUT knowing how long it is. Correct playback and a
correct duration are independent facts, and the first cannot be used to infer the second.

**The evidence that no rung had a value** is on screen: a clip only reads "—" when
`durationSource === "unknown"`, and only an unknown contributes 0 to `timelineTotals`. Both were
true, so `measured` was empty AND the wire's `duration_seconds` was null.

**Root cause — `createVideoPlayer` measures nothing on web.** `expo-video`'s web `VideoPlayer` is a
controller over a SET OF MOUNTED `<video>` ELEMENTS, not an owner of the asset:

- `get duration()` returns `[...this._mountedVideos][0]?.duration ?? 0` — **0** when none is mounted.
- `status` becomes `readyToPlay` only inside `video.oncanplay`, and that handler is attached by
  `_addListeners(video)`, which runs only from `mountVideoView(video)` — i.e. only when a
  `VideoView` renders that player.

`useClipDurations` creates a player and deliberately never renders a view for it. So in Chrome the
status event never fires, the duration is always 0, and `settle()` is never called. **The hook was a
no-op**, and a second defect follows from it: an unsettled probe never released its concurrency
slot, so after four clips nothing further was even attempted.

This is my error, not the library's. The native players own their asset; I generalised from that to
a platform where the player is a view controller.

### Predictions for the fix

1. **The real discriminator is "is there a DOM", not `Platform.OS`.** Keying on the platform would
   be a guess about which runtime has `document`; asking for `document` is the actual condition, and
   it is the one a test can drive both sides of.

2. **On web, measure with a bare `HTMLVideoElement` and `preload="metadata"`.** Metadata is all a
   duration needs — pulling the whole file to learn its length would make the track expensive to
   draw. The element is never attached to the document and never played.

3. **An unsettled probe must release its slot.** Independent of this bug: any probe that cannot
   answer — a dead url, a codec the browser will not open, a network stall — would otherwise hold
   one of four slots for the life of the screen. A timeout that resolves to "unknown" is the fix,
   and "unknown" is already a state the ladder renders honestly.

4. **A duration of exactly 0 is still not a duration.** `HTMLMediaElement.duration` is `NaN` before
   metadata and can be `Infinity` for a stream. The existing guard (finite and positive) already
   covers all three, and it is why the broken web path degraded to the placeholder rather than
   drawing zero-width clips.

### Revert checks (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC3a.1 | draw every clip at a constant width, ignoring its duration | the width-is-proportional-to-measured-duration test |
| RC3a.2 | accept a non-positive / non-finite reading as a duration | the rejects-NaN-and-zero test |
| RC3a.3 | drop the DOM branch, so web falls back to the player that cannot measure | the measures-through-the-DOM test |
| RC3a.4 | never time out, so a silent probe holds its slot forever | the stuck-probe-releases-its-slot test |

---

## Checkpoint 4 — trim

Where `trimStartSec` / `trimEndSec` finally get produced, where they first reach the wire, and where
the out-point stop shipped at checkpoint 2 runs for real for the first time.

### Predictions

1. **A clip whose duration is UNKNOWN must not be trimmable at all.** The placeholder is three
   seconds; the clip might be sixty. Dragging a handle on one would write `trimEndSec: 3` onto a
   minute of footage and silently throw away 95% of it. No handles on an unknown clip — the UI
   cannot honestly address a span it does not know the size of. This is the sharpest new hazard in
   the checkpoint and it only exists because the placeholder is deliberately plausible.

2. **An untrimmed clip must still produce a byte-identical body.** "Absent means the whole clip" is
   the spec's own rule, so dragging a handle to the very edge has to DELETE the field rather than
   write `trimStartSec: 0`. Otherwise every timeline that was never trimmed starts sending two new
   fields, and the one representation of "whole clip" becomes two.

3. **The client must refuse what the server would refuse, before sending it.** `parseStitchSpec`
   rejects `trimEndSec <= trimStartSec` BY FIELD, so a drag that crosses over produces a 400 she
   cannot see the cause of. A minimum segment enforced in the drag is the fix; clamping at the
   point of the gesture rather than validating at the end also means the handle simply stops
   instead of snapping back.

4. **Trimming must not be allowed past the end of the source.** The server cannot check this — it
   has no duration at parse time — so nothing would refuse it, and ffmpeg would be asked for frames
   that do not exist.

5. **⚠️ `timelineTotals` BECOMES WRONG THE MOMENT TRIM SHIPS, so its fix is pulled forward from
   checkpoint 5.** It sums the clip's whole duration; a trimmed clip would be charged for footage it
   no longer plays. The client would then refuse timelines the server accepts — "the worst kind of
   disagreement, because she would never find out she was allowed", in that file's own words.
   Shipping trim without this would be knowingly shipping that bug, so it lands here. The split's
   own arithmetic still belongs to checkpoint 5.

6. **The out-point stop stops being theoretical.** It has been in the preview since checkpoint 2
   and has never run against a real trim, because nothing produced one. Its checkpoint-2 test drives
   a fake; this is the first time a device can show it working.

7. **Dragging a handle should show the frame at that edge.** Trimming blind is guessing. The drag
   reuses the scrub path — seek, do not play — so the edge is visible as it moves.

### What needs Adi's eyes

- **Does trimming actually shorten playback?** Trim a clip, then play it: it must start at the new
  in-point and STOP at the new out-point rather than running on.
- Whether the handles are grabbable without fighting tap-to-select on the same clip — they are
  children of the pressable, so this is the first place two gestures compete on one element.
- Whether a handle on a short clip is reachable at all, given there is deliberately no minimum clip
  width.
- Whether the frame shown while dragging keeps up with the handle.

### Revert checks (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC4.1 | let an unknown-duration clip be trimmed | the no-handles-on-an-unknown-clip test |
| RC4.2 | write `trimStartSec: 0` instead of deleting the field | the untrimmed-body-is-unchanged test |
| RC4.3 | drop the minimum segment, so the edges can cross | the cannot-invert-the-window test |
| RC4.4 | allow a trim past the end of the source | ⚠️ **UNEXERCISABLE — see below** |
| RC4.5 | leave `timelineTotals` charging the whole duration | the totals-count-the-trimmed-span test |
| RC4.6 | stop emitting trim in `toStitchBody` | the trim-reaches-the-wire test |

### Two revert checks that did not red first time, and what each meant

**RC4.3 was a real hole in the TEST.** The assertions compared against `MIN_SEGMENT_SEC` itself, so
mutating the constant to 0 relaxed the assertion in lockstep and the test passed under its own
revert check. Re-stated against the SERVER's rule instead — `trimEndSec` strictly after
`trimStartSec`, which is what `parseStitchSpec` refuses by field — it reds. A test that moves with
the thing it is testing proves nothing; assert the external invariant, never the local constant.

**RC4.4 is genuinely UNEXERCISABLE, and that is a fact about the design rather than a gap.** The
clamp it mutates is redundant: an end at or past `whole` DROPS `trimEndSec`, and absent already
means "to the end of the source". So an un-clamped 99 on a ten-second clip produces byte-identical
output to a clamped 10, and no assertion can tell them apart. The property itself is still covered —
RC4.2, which stops the fields being dropped, reds four tests including this one. The clamp stays as
belt-and-braces so that changing the drop rule cannot quietly re-open the hole, and the code says
so at the line.

---

## Parked, deliberately — not defects, not forgotten

**The default-controls spinner during a source swap.** Chrome draws a large spinner while a source
loads (`VideoView` renders `controls={nativeControls ?? true}`), so it flashes at the seam when a
scrub crosses a clip boundary. Device verdict on the swap itself: **smooth — the frame tracks across
the seam, no stutter, freeze or blank.** So the timing is fine and this is cosmetic.

Not fixed, and the reason is worth recording: **holding the outgoing frame is not reachable cheaply,
because `replaceAsync` calls `video.load()`, which blanks the element before anything could show
it.** Keeping it needs either a canvas capture through the view's `nativeRef` — web-only, requiring
`crossOrigin` plus CORS headers on the bucket, and it would break loading outright if they are
absent — or a second player, which is the pre-warm. A plain cover in the frame's colour hides the
spinner but does not hold the frame, and that is cosmetic spend on a preview surface. Adi's call:
parked.

**Auto-advance (Option 1) is parked with it**, and for a dependent reason: every automatic
transition would show the same spinner, and a spinner arriving on its own at each cut reads as a
fault rather than as loading. "Watch the whole thing" already has an answer — the stitched result.
The machinery for it is small and unchanged: `playToEnd` plus the out-point already in the preview,
guarded on the player actually playing so a scrub to the end does not advance.

⚠️ One thing learned while measuring these that outlives them: **a cold boundary crossing cannot be
produced through the normal flow.** Adding a clip from the strip also previews it, so every clip on
the timeline has already been loaded by the act of being added. To test a genuinely cold swap, use
DevTools → Network → **Disable cache** (and throttle). Any "the swap is fast" reading taken without
that is a warm-cache reading.

---

## Checkpoint 5 — split at the playhead

### It is a button, not a gesture

Tapping a clip already selects it and fills the preview; making the same tap also cut it would make
selection destructive. So split is an explicit control, enabled only when the playhead sits at a
legal cut inside the selected clip. **No new gesture, so no jest setup change** — the RNGH wiring
from checkpoint 3 is untouched.

### Predictions

1. **The cut is in SOURCE seconds, not track seconds, and `resolvePlayhead` already returns it.**
   A clip trimmed to 2–6 and cut at the 4s mark becomes 2–4 and 4–6, never 0–4 and 4–8. Using track
   time would be right only for the first untrimmed clip on the timeline and wrong for every one
   after it — the failure appears the moment there is a second clip, which is always.

2. **The two segments must sum EXACTLY to what the original played**, because the totals are now
   effective-duration based (pulled forward at checkpoint 4). A split that re-inflated would charge
   the cap twice for footage she still has once.

3. **A split costs a CLIP SLOT and no bytes.** `assertTimelineFits` counts clips and seconds over
   POSITIONS but bytes over UNIQUE ASSETS, and both segments carry the same `assetId` — so twelve
   is the real ceiling on splitting, and the byte budget does not move at all.

4. **Segment A keeps the crossfade; segment B gets none.** B follows A across what was one
   continuous shot a moment ago, and a fade there would invent a transition she never asked for.
   A also keeps the original's KEY, so the selection survives the cut rather than silently jumping.

5. **Refuse a cut that leaves a sliver.** The same `MIN_SEGMENT_SEC` the trim handles use, rather
   than merely "non-positive": a 0.05s segment is legal to the server's parser but is not a clip,
   and allowing it here while the handles refuse it would be two rules for one thing.

6. **Refuse a cut on a clip of unknown duration** — the same hazard as the trim handles. The
   playhead's position within a placeholder-width clip means nothing, so the cut point would be
   fiction.

### Revert checks (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC5.1 | cut at the track second instead of the source second | the split-respects-existing-trim test |
| RC5.2 | give segment B the whole clip's end instead of the original's out-point | the segments-sum-to-the-original test |
| RC5.3 | allow a zero-length segment | the refuse-a-sliver test |
| RC5.4 | allow a split on an unknown-duration clip | the refuse-on-unknown-duration test |
| RC5.5 | let segment B inherit the crossfade | the B-gets-no-crossfade test |
| RC5.6 | count the split clip's whole length again in the totals | the no-double-count test |

---

## Checkpoint 6 — drag to reorder

### The three-way on one clip, and why it resolves without gesture refs

A clip now wants to answer three different touches. They are separated by **what the finger does**,
not by arbitration plumbing:

| touch | wins | why it cannot be taken by the others |
| --- | --- | --- |
| tap | select | neither pan ever activates — one needs movement, the other a 250 ms hold |
| drag an edge | trim | the handle's pan activates on the FIRST movement; reorder is still waiting out its hold |
| hold, then drag | reorder | the handle was not touched, and the hold has elapsed |

**Long-press activation is doing double duty**: it is what stops the reorder pan losing the race to
the horizontal ScrollView the track lives in, AND what stops it stealing from the trim handles. One
mechanism, two conflicts.

The remaining collision is a long-press ON a handle. It is narrow — the handle's pan still fires on
the first movement — and closing it properly needs `blocksExternalGesture` with refs across two
components. Not built; **flagged for the device pass** rather than guessed at.

### Predictions

1. **The drop index is "how many other clips have their centre left of mine".** That number is
   already the index AFTER the dragged clip is removed, which is exactly what `moveItem`'s `to`
   means — so no ±1 correction is needed anywhere, and adding one would be the bug.

2. **Reorder cannot change the totals.** The sum is order-independent, and `moveItem` splices
   rather than copies, so a double-count would mean the array grew. Worth pinning because an
   off-by-one in a splice is exactly how a clip gets duplicated rather than moved.

3. **Trims travel with their clip**, because a position IS its trim — `moveItem` moves the whole
   object. The way this breaks is a reorder implemented by moving asset ids rather than items.

4. **⚠️ SPLIT HALVES CAN BE SEPARATED, AND THAT IS CORRECT — my call, flagged.** After a split the
   two segments are ordinary positions that happen to share an `assetId` and hold adjacent windows.
   Dragging one away breaks nothing: the spec stays valid (two entries, same asset, non-overlapping
   ranges, any order), the engine still downloads once and extracts two spans, and "show the end of
   the shot, then the start" is a real edit. Adding machinery to keep them glued would be inventing
   a constraint the format does not have. They are two independent clips the moment the cut is made.

5. **`normalize` still has to run after every drop.** A clip carrying a crossfade dragged to the
   front would otherwise keep a fade with nothing to fade from — which the server refuses by field.
   This is the pre-existing rule the arrows already obeyed; the drag must not be the path that
   forgets it.

6. **Removing the arrows is safe only because the drag covers every case they did**, including
   moving the first clip and the last. If the drag has an edge case, the timeline is left with no
   reorder at all — so the arrows come out in the SAME commit that proves the drag works, not
   before.

### What jest pins vs what only the device can answer

**Jest (pure):** the drop-index arithmetic at every position, including both ends and the no-move
case; trims surviving a move; totals unchanged by order; `normalize` still stripping a crossfade
that lands at the front.

**Jest (rendered, through the REAL gesture):** that a long-press-then-drag commits a reorder with
the right index, via `fireGestureHandler` on the actual `Gesture.Pan` — not a mock asserting a
handler was called.

**Device only — Adi's:** whether the 250 ms hold feels right; whether the drag fights the
horizontal scroll **on native and in Chrome separately**; whether a long-press starting on a trim
handle does something sensible; whether releasing after a drag also fires the tap (it should not —
gesture activation cancels the press, but that is RNGH's behaviour, not mine); and whether the
dragged clip reads as picked up.

### Revert checks (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC6.1 | off-by-one the drop index | the drop-lands-at-the-right-index test |
| RC6.2 | reorder by asset id instead of by item | the trim-survives-a-reorder test |
| RC6.3 | drop `normalize` after the move | the crossfade-stripped-at-the-front test |
| RC6.4 | remove the long-press activation | the reorder-needs-a-hold test |
| RC6.5 | count the dragged clip itself among those to its left | the no-move-stays-put test |

---

## Checkpoint 6a — the arrows come back, permanently

Not a retreat from the drag, which works. Two inputs want two affordances: a 250 ms
press-hold-then-drag is natural on touch and awkward with a trackpad, where a pair of buttons is
both discoverable and exact. They stay side by side.

### Predictions

1. **"Shared path" has to be structural, or it is only a claim.** Two call sites that happen to do
   the same thing today will drift the first time one is edited. So the array mutation moves into
   ONE function — `reorderTo(items, key, toIndex)` — and both the arrow and the drop call it through
   the same handler. A mutation to that function must red both kinds of test, which is what makes
   "they cannot diverge" a fact rather than a sentence in a commit message.

2. **The arrow's target index is just an index, which is the whole reason this is cheap.** The drop
   already computes one from geometry; an arrow computes one from arithmetic. Downstream neither
   knows nor cares which it was — so `normalize`, trims travelling with their clip, and
   order-independent totals all come along for free rather than being re-implemented.

3. **The ends are no-ops by construction, not by a guard on the button.** `moveItem` already
   refuses an out-of-range target, so up on the first clip and down on the last do nothing even if
   the disabled state is ever wrong. Disabling them is the visible half; the arithmetic is the real
   half, and it is the one that is tested.

4. **A no-op must return the SAME array**, not an equal one. `normalize` maps, so it builds a new
   array even when nothing changed — and handing React a fresh array on every disabled press would
   re-render the timeline and churn the layout for no reason.

### Revert checks (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC6a.1 | move the clip the wrong way | the arrow-up and arrow-down order tests |
| RC6a.2 | reorder by asset id, dropping the window | the arrow-preserves-trim test |
| RC6a.3 | drop `normalize` from the shared path | the crossfade-stripped test AND the drag-equivalence test |
| RC6a.4 | let an out-of-range target through | the first-up and last-down no-op tests |
| RC6a.5 | give the arrow its own mutation instead of the shared one | the arrow-and-drag-agree test |

---

## Checkpoint 6b — the preview was lagging, and the loop was never tied to playback

Reported on device: the player feels laggy. Two causes, both ours to fix, and the first is a leak
rather than a slowdown.

### What `timeUpdateEventInterval` actually does on web

```js
set timeUpdateEventInterval(value) {
  if (this._timeUpdateLoop) clearInterval(this._timeUpdateLoop);
  if (value > 0) { … this._timeUpdateLoop = setInterval(…, value * 1000); }
}
```

⚠️ **It is a plain `setInterval` and it is not tied to playback at all** — it fires every 200 ms
whether the video is playing, paused, or has no source. Worse, `VideoPlayerWeb extends SharedObject`
and **defines no `release()`**, so the only thing that ever clears that loop is setting the interval
again. Releasing the player does not.

**So every mount of the preview leaked a 200 ms interval for the life of the page**, and each leaked
interval also retains the player object and its media elements against garbage collection. A tab
switch, a navigation or a Fast Refresh each added one.

### Predictions

1. **Setting the interval to 0 on unmount is the whole fix for the leak**, because the setter's own
   `clearInterval` is the only path that stops the loop. Not a workaround — it is the documented
   surface doing the only thing it can.

2. **The active lag is a separate problem from the leak.** Five progress events a second each call
   `setPlayheadSec`, which re-renders the WHOLE builder: the strip of a dozen-odd tiles (some of
   which mount decoders), the track and every clip on it, and the row list. None of those depend on
   the playhead. Memoising them is what makes 5 Hz affordable rather than lowering the rate, which
   would only make the playhead stutter instead.

3. **React already bails when paused**, because `currentTime` does not change and `setPlayheadSec`
   is called with an identical value — so this is a playback-time cost, not an idle one. That is
   why it reads as "the player lags" rather than "the page is slow".

### Revert checks (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC6b.1 | leave the interval running on unmount | the stops-the-progress-loop-on-unmount test |

---

## Checkpoint 7 — the media library plays its videos

### Recon answers

**The glyph is still there and still lying.** V7 did not delete it — `MediaDetailScreen` renders
`<View style={styles.playBtn}><Feather name="play" /></View>` with no `onPress`, above a comment
saying "playback is V8's and the play glyph below is still decorative". So this checkpoint wires the
button that has been there all along rather than adding one back.

**It does NOT inherit a mute toggle, and that was deliberate at checkpoint 3.** `PlayerSurface` is a
dumb box on purpose: putting mute state there would have changed the stitch result's behaviour as a
side effect of changing the preview's. What IS shared is the default — `ClipPlayer` takes `muted` as
a prop and defaults to muted — so consistency with the preview costs only the toggle itself.

**My call: share the toggle's markup, keep its state local.** The control moves to a small
`MuteToggle` beside `PlayerSurface`, used by both surfaces, so the two review surfaces look and
behave identically and cannot drift. Each screen keeps its own `muted` state, because mute is a
decision about *this* viewing, not a global mode.

### Predictions

1. **Press-to-play, not an inline player** — V7's own prediction 5, still right. This box is also
   the IMAGE preview, and mounting a player for every asset would decode a video on a screen that
   is usually showing a photo.

2. **The revert check has to be the BEHAVIOUR, not the rendering.** A decorative glyph and a wired
   one render identically — that is exactly how this shipped broken for months. So the decision
   moves into a pure seam (`libraryPreview`) and the button's effect is asserted through a render,
   not by looking at the markup.

3. **The poster stays the still, and playback is the mp4** — the same structural rule as the stitch
   result. A poster and a player must never both be showing, or "it plays" becomes unfalsifiable.

4. **⚠️ There is no aspect ratio on this wire.** `MediaItem` carries `url`, `thumb_url`,
   `video_url`, `duration_seconds` — and no width or height, though `media_assets` stores both. So
   the player cannot be shaped to the clip. A SQUARE box serves a library holding both orientations
   better than the portrait default, because `contentFit: "contain"` then letterboxes either one
   rather than reducing a landscape clip to a 180 pt strip. Exposing the dimensions is a server
   change and out of this lane — written down, not made.

### Revert checks (must go RED by name)

| # | mutation | must red |
| - | -------- | -------- |
| RC7.1 | put the decorative `View` back in place of the pressable | the tapping-play-starts-the-player test |
| RC7.2 | route playback through the poster instead of the mp4 | the plays-the-mp4-not-the-poster test |
| RC7.3 | start the library player unmuted | the starts-muted-like-the-preview test |
| RC7.4 | let an image become a player when play is requested | the only-a-video-can-play test |
