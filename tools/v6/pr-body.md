The stitch engine (audit §0.5 / PR 5's first half): takes an ordered list of local clips and
produces one stitched output. Concat, per-clip trim, crossfade, and an audio bed with level and
ducking. A typed function V7 calls from the server — no shell, no job row, no lease, no model call.

**Nothing imports it yet.** V7 is what wires it up, so this is dead code the moment it merges.
That is the whole reversibility answer and the reason there is no feature flag — there is no
runtime surface to put one in front of. Zero model calls were made building it; ffmpeg and ffprobe
are the only processes it spawns, and ffmpeg is already in the container, so **no new dependency**.

## Why normalization is the load-bearing part

Clips from different models don't share encode params, and **both** of ffmpeg's joins punish that.
Measured on four deliberately mismatched clips (three resolutions, four frame rates, two pixel
formats, one anamorphic at SAR 2:1, two with no audio track):

| path                              | result                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| concat **demuxer** + `-c copy`    | **exit 0 — and silently corrupt.** Every frame relabelled with the first clip's dimensions; 3.023s where 3.000s was asked for. It looks like success. |
| concat **filter**, unnormalized   | exit **234**, `Input link parameters do not match`                                                                                                    |
| concat filter, clip with no audio | exit **234**, `Stream specifier ':a' matches no streams`                                                                                              |
| **conform, then concat**          | **5.500000s, 165 frames = 5.5 × 30 exactly**, SAR 1:1, yuv420p, 48k stereo                                                                            |

The first row is why this never uses the demuxer. A stitch that exits 0 and writes a broken reel is
worse than one that fails.

## Two constraints that aren't obvious

**Timebase.** `concat` emits `1/1000000`; a clip through `fps=N` carries `1/N`; `xfade` refuses a
mismatch. So a **cut followed by a crossfade** fails while cut-only and crossfade-only both pass —
the case a narrow test misses. Every node is pinned to one fine timebase (`1/90000`).

**Anamorphic sources.** `scale` works on storage dimensions, so a clip stored 640x480 at SAR 2:1
(1280x480 on screen) conforms to 480x360 pillarboxed and squeezed instead of 640x240 letterboxed.
Output dimensions are identical either way, so no assertion on width or height can see it. The
squaring prefix is emitted only when the probe reports a non-1:1 SAR.

## Contract notes

`expectedDurationSec` is the final value of the **same accumulator** that emits each `xfade` offset,
not a second formula — otherwise comparing it against the probed output would validate a bug against
a parallel copy of the same arithmetic.

Sources are **local paths**; URLs are rejected with an actionable error. ffmpeg would stream https
happily, but this module has nowhere to carry a bearer token, so an expired signed URL becomes an
obscure decode failure deep in ffmpeg instead of "fetch it first". V7 downloads with auth.

## Tests

Real ffmpeg on real files, fixtures generated from lavfi — hermetic and $0. A stitch tested against a
stubbed binary asserting command strings proves only that we built the string we meant to.

**11/11 revert checks red by name.** Three were **green on the first pass** and only went red once the
test was strengthened; those are in the ledger and are the ones worth reading:

- **RC4** asserted `silenceSynthesized`, computed from the _probe_ rather than the silence machinery,
  so it stayed true with that machinery deleted — and ffmpeg doesn't reject the dangling
  `[undefined:a]` the mutation produces, it binds it to whatever audio it can find, so the mute clip
  played the previous clip's tone while every assertion still read correct. Now measured: −91.0 dB
  (digital silence) against −24.2 dB (tone).
- **RC9** was a substring trap — `toContain("setpts=PTS-STARTPTS")` is satisfied by the audio chain's
  `asetpts=PTS-STARTPTS`. Recorded plainly in the ledger: **no fixture here makes `setpts`
  behaviorally load-bearing**; it's kept as the canonical idiom before `xfade`, but RC9 proves the
  step is emitted, not that removing it breaks a stitch.
- **RC11** couldn't fail because `output.durationSec` is the _video_ stream's duration. With
  `duration=longest` the same call writes a 3.5s video stream beside an **8566-second** audio stream
  and the manifest still reports 3.5s.

Gate: bare `npm test` — **343 suites, 6373 tests, 0 failed**. Not a chosen scope.

## Out of scope, deliberately

`content.ts:152`'s `origin = 'generated'` filter is the audit's blocking gap for assembly, but it is
shared code and Mia's — flagged, not touched. Also not here: shot-level indexing, the job row / lease
/ reaper a real stitch needs, generation and model adapters, the V2 probe, per-frame QA (V8), Kling
transitions (V9), and the assembly UI (V7).

Ledger: `docs/probes/video-v6-ledger.md`.
