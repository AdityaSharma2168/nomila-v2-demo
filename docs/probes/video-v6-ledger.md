# VIDEO V6 — STITCH ENGINE — LEDGER

> **$0 and model-free.** This card spawns `ffmpeg` and `ffprobe` and nothing else. No model call, no
> adapter, no network, no DB, no job row. It does not depend on the V2 bake-off verdict and nothing it
> produces feeds back into that probe. Recon is `docs/probes/video-scope-audit.md` §0.5 and PR 5.
>
> **Dead code on merge.** Nothing imports `server/studio/video/**` yet — V7 (assembly UI) is what wires
> it. That is the whole reversibility answer, and it is why there is no feature flag: there is no
> runtime surface to put one in front of.

Before this card there was **no concat, no xfade, no filter_complex and no ffprobe anywhere in the
repo** (audit §0.5). The only ffmpeg precedent is `server/services/videoPoster.ts`, whose spawn idiom
(`execFile`, `-y -nostdin`, an explicit timeout and `maxBuffer`) this module matches.

---

## The contract V7 calls

```ts
stitch({ clips, audioBed?, outputPath, target, timeoutMs? }) => Promise<StitchManifest>
```

A typed function, callable from the server without a shell. `clips` is ordered, each with an optional
trim (`trimStartSec`/`trimEndSec`) and an optional `transitionIn` (`cut` | `crossfade`). The manifest
returns, per clip, the encode params ffprobe actually found, the trim applied, the effective duration,
and which normalization steps fired — plus the probed params of the file written, and the argv and
filter graph that produced it.

**Sources are local paths, not URLs.** ffmpeg would stream https happily, but this module has nowhere
to carry a bearer token, so a signed URL that has expired becomes an obscure decode failure deep inside
ffmpeg instead of a clean, actionable error. V7 downloads with auth and hands over a path. Network and
auth stay out of the engine entirely.

---

## Why normalization is the load-bearing part, measured

Clips from different models do not share encode params, and **both** of ffmpeg's joining mechanisms
punish that. Measured on four deliberately mismatched clips (three resolutions, four frame rates, two
pixel formats, one anamorphic at SAR 2:1, two with no audio track):

| Path                              | Result                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| concat **demuxer** + `-c copy`    | **exit 0 — and silently corrupt.** Every frame relabelled with the first clip's dimensions; 3.023s where 3.000s was asked for. It looks like success. |
| concat **filter**, unnormalized   | exit **234** — `Input link parameters (720x1280) do not match`                                                                                        |
| concat filter, clip with no audio | exit **234** — `Stream specifier ':a' matches no streams`                                                                                             |
| **conform, then concat**          | **5.500000s, 165 frames = 5.5 × 30 exactly**, SAR 1:1, yuv420p, 48k stereo                                                                            |

The silent-corruption row is the reason this module never uses the demuxer. A stitch that exits 0 and
writes a broken reel is worse than one that fails.

---

## Two constraints that broke a prediction during the build

Both were predicted to be non-issues and were not. Recorded because a later reader will otherwise
"simplify" them back out.

### V6-L1 · The concat filter and `xfade` do not share a timebase

`concat` emits timebase `1/1000000`. A clip that has been through `fps=N` carries `1/N`. `xfade`
**rejects inputs whose timebases differ**:

```
[Parsed_xfade_25] First input link main timebase (1/1000000) do not match
                  the corresponding second input link xfade timebase (1/30)
```

So a **cut immediately followed by a crossfade** is a hard failure (exit 234), while cut-only and
crossfade-only both pass. Every node is therefore pinned to one fine timebase (`settb`/`asettb`
at `1/90000` — fine so non-integer rates like 29.97 need no rounding, uniform so no node pair can
disagree). With the pin, the mixed chain is exact: **4.000000s, 120 frames**.

This is the failure mode a narrow test misses, which is why `stitch.test.ts` carries a dedicated
mixed-transition case rather than testing cuts and crossfades separately.

### V6-L2 · `scale` works on storage dimensions, so anamorphic clips conform squeezed

A clip stored 640x480 with SAR 2:1 is **1280x480 (8:3) on screen**. Into a 640x360 box it should
letterbox to 640x240. Conformed naively it pillarboxes to **480x360** — the picture silently squeezed,
and the output file's width/height are identical either way, so no dimension assertion can see it.

Measured, fitting that clip into the box with no pad:

| chain                                                | result      |                               |
| ---------------------------------------------------- | ----------- | ----------------------------- |
| `scale=640:360:force_original_aspect_ratio=decrease` | **480x360** | wrong — pillarboxed, squeezed |
| `scale=iw*sar:ih,setsar=1,` then the same            | **640x240** | right — letterboxed           |

The squaring prefix is emitted **conditionally**, only when the probe reports a non-1:1 SAR, so
`sarCorrected` in the manifest corresponds to a filter that was actually added.

The test for this needs a fixture it can measure: `testsrc2` fills the frame edge to edge, so
`cropdetect` sees no bars and cannot tell the two apart. Fixture `clipD` is therefore **solid white**,
which makes the black padding measurable and the squeeze visible from the output file.

---

## Ducking can only be measured on the bed's own frequency band

The first attempt measured the mixed signal and **read backwards**: the window holding the loud
programme is louder overall precisely _because_ the programme is in it, which swamps the bed's
attenuation. Since the fixtures are pure tones an octave apart (bed 220 Hz, programme 440 Hz),
band-passing the bed's frequency isolates it:

| render       | bed, programme LOUD | bed, programme SILENT | Δ                     |
| ------------ | ------------------- | --------------------- | --------------------- |
| duck **on**  | −37.9 dB            | −34.8 dB              | **3.1 dB of ducking** |
| duck **off** | −34.4 dB            | −34.6 dB              | 0.2 dB (flat control) |

The flat control is what makes the ducked row mean something. Measured on the mix instead of the band,
the same two renders differ by 0.7 dB — inside encoder noise, and an assertion built on it would pass
on a coincidence.

---

## Revert checks

Every check is a one-line mutation to the source, and each must be shown to go red **by the named
test**. A mutation that leaves the suite green means the test never exercised the thing it names.

| #    | Mutation                                        | Named test                                                             | Result |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| RC1  | drop `scale`/`pad` from the conform chain       | `stitches four heterogeneous clips into one conformed file`            | RED    |
| RC2  | drop the conditional `scale=iw*sar:ih` squaring | `letterboxes an anamorphic clip instead of squeezing it`               | RED    |
| RC3  | drop `fps=` from the conform chain              | `conforms mixed frame rates`                                           | RED    |
| RC4  | drop silence synthesis (`anullsrc`)             | `gives a clip with no audio track a silent stretch instead of failing` | RED\*  |
| RC5  | drop `settb`/`asettb` after the concat node     | `joins a cut and a crossfade in one chain`                             | RED    |
| RC6  | crossfade accumulator forgets `- d`             | `a crossfade shortens the timeline by its own duration`                | RED    |
| RC7  | drop `sidechaincompress` from the bed chain     | `ducks the bed under programme audio`                                  | RED    |
| RC8  | drop the crossfade-fits validation              | `rejects a crossfade longer than its clips before spawning ffmpeg`     | RED    |
| RC9  | drop `setpts=PTS-STARTPTS`                      | `rebases timestamps after a trim`                                      | RED\*  |
| RC10 | drop the URL rejection in `assertLocalPath`     | `rejects a URL source with an actionable error`                        | RED    |
| RC11 | `amix duration=first` -> `duration=longest`     | `a long bed does not extend the timeline`                              | RED\*  |

**11/11 red by name.** Three of them (\*) were **green on the first pass** and only went red after the
test was strengthened. Each was a test that could not fail, which is worth more than the eight that
passed first time.

### RC4 - the assertions were all blind to the thing they named

`silenceSynthesized` is computed from the _probe_ (`hasAudio && !probes[i].hasAudio`), not from the
silence machinery, so it stays `true` with that machinery deleted. `hasAudio` and the duration stayed
correct too - because ffmpeg does not reject the dangling `[undefined:a]` label the mutation produces.
It quietly binds it to whatever audio stream it can find, so **clipB's stretch plays clipA's tone** and
every assertion still reads right.

Measured: the mute stretch is **-91.0 dB** (digital silence) with synthesis on, and **-24.2 dB**
(clipA's tone) with it off. The test now measures the stretch. 67 dB of separation.

### RC9 - a substring trap, and the step is structural rather than load-bearing

`toContain("setpts=PTS-STARTPTS")` is satisfied by the audio chain's `asetpts=PTS-STARTPTS`, so it
passed with the video step deleted. Now anchored to `format=yuv420p,setpts=PTS-STARTPTS`.

Stated plainly: **no fixture in this set makes `setpts` behaviorally load-bearing.** Dropping it left
all 37 tests green, and a clip built with `start_time=5.0s` still crossfades to exactly 90 frames with
it and without it - ffmpeg's buffer source already rebases. It is kept because it is the canonical
idiom before `xfade` and guards input paths these fixtures don't cover (VFR, concat-demuxer sources),
but RC9 proves the step is **emitted**, not that removing it breaks a stitch. Worth knowing before
anyone treats that check as behavioral cover.

### RC11 - the manifest's duration cannot see a runaway audio tail

`output.durationSec` is the **video** stream's duration - the right number for timeline arithmetic, and
blind here. With `duration=longest` the same call writes a **3.5s video stream beside an 8566-second
audio stream** (the looped bed running on for 2.4 hours) and the manifest still reports 3.5s. The test
now reads the container duration instead.

_Two lessons about the harness rather than the code: the first RC11 run replaced only the **first** of
three `duration=first` occurrences, leaving the non-duck `amix` - the exact path the test exercises -
unmutated. A revert check that reports green because the mutation never reached the code under test is
indistinguishable from a real pass until you read the diff. And RC4's first failure was diagnosed only
by dumping the mutated filter graph and finding `[undefined:a]` in it._

---

## Deliberately not here

| Thing                                     | Why                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `content.ts:152` `origin = 'generated'`   | The audit's blocking gap for assembly, but it is **shared code — Mia's**. Flagged, not touched.        |
| Shot-level index (scenes, keyframes)      | Audit PR 5: refusing to invent that table before assembly's access pattern is known still holds.       |
| Job row, lease, reaper                    | A stitch is minutes of CPU and needs them — they belong to whoever wires the job type, not the engine. |
| Generation, model adapters, the V2 probe  | Out of scope. This module imports none of them.                                                        |
| Per-frame QA (V8), Kling transitions (V9) | Their own cards.                                                                                       |
| A new dependency                          | ffmpeg is already in the container (`Dockerfile:29-31`). Kept that way.                                |
