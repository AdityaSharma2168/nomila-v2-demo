# The stitch audio bed — installing the placeholder

**One file, one upload, one env var. Nothing in this repo can do it for you**, and that is
deliberate: putting an object in the media bucket is a write to live infrastructure.

---

## What is already built

| piece                                              | where                                          |
| -------------------------------------------------- | ---------------------------------------------- |
| the allowlist (name → object path)                 | `server/studio/video/beds.ts`                  |
| the parser (a NAME travels, never a path)          | `server/studio/video/spec.ts`                  |
| the download, into the same workspace as the clips | `server/studio/video/materialize.ts`           |
| the hand-off to ffmpeg, as a LOCAL path            | `server/studio/stitchRunner.ts`                |
| the picker, and the honest line when no bed exists | `client/components/studio/TimelineBuilder.tsx` |
| tests, against a bed served from a stub            | `server/studio/stitchRunner.test.ts`           |

Until the object is installed, `bedsReady()` is false: the picker says "No music available yet —
timelines are put together without it", the route refuses a bed by name with a 400 at the door, and
a timeline without one works exactly as it does now. Nothing fails at run time over a missing file.

## Step 1 — the file

Already generated at **`/tmp/claude-501/-Users-adi-nomila-v2/bb9a3d43-1d52-4567-982d-cd6b862bb7ba/scratchpad/placeholder-loop.m4a`**
(12.0 s, AAC 128 kbps, 48 kHz stereo, 191 KB). Regenerate it anywhere with:

```bash
ffmpeg -y \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=12" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=12" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=12" \
  -filter_complex "[0:a]volume=0.5[a];[1:a]volume=0.28[b];[2:a]volume=0.16[c];\
[a][b][c]amix=inputs=3:normalize=0[m];\
[m]tremolo=f=0.25:d=0.35,afade=t=in:st=0:d=1.5,afade=t=out:st=10.5:d=1.5,\
aformat=channel_layouts=stereo[out]" \
  -map "[out]" -c:a aac -b:a 128k -movflags +faststart placeholder-loop.m4a
```

**It is CC0 by construction** — a root and two harmonics from ffmpeg's own `lavfi` generator, with
a slow tremolo and fades top and tail. Nobody's recording, nobody's composition, no licence to
clear. It is a TONE, not music: it exists to prove the audio path, and it should be replaced by
something licensed before anyone sees it.

Twelve seconds is enough because V6 loops the bed (`plan.ts DEFAULT_BED.loop`), so it covers a
three-minute timeline as readily as a twelve-second one.

## Step 2 — the upload (yours to run)

```bash
gsutil cp placeholder-loop.m4a gs://nomila-v2-athlete-media/studio/beds/placeholder-loop.m4a
```

The path must match `STITCH_BEDS.placeholder.gcsPath` exactly. Prod uses its own `MEDIA_BUCKET`, so
installing it there is a second, separate upload.

## Step 3 — the flag

```bash
gcloud run services update nomila-v2 --region=us-central1 \
  --update-env-vars STUDIO_STITCH_BEDS_READY=true
```

Land it in `gcp/cloud-run-dev.yaml` too, or the next deploy re-applies the file and turns it back
off — the same caveat `MILA_VOICE_WEB` carries.

## What to check once it is on

1. `GET /api/v1/me/studio/stitch/options` answers `"ready": true` and lists the bed.
2. Queue a two-clip timeline with `bed: "placeholder"`.
3. The runner's `stitch complete` log line carries `bed: "placeholder"` — it is null when the bed
   was skipped, which is how a silent downgrade is told apart from a bed that played.
4. The result plays WITH SOUND in the Video tab. `ClipPlayer` is muted by default everywhere else;
   the stitch result passes `muted={false}` precisely so the bed can be reviewed.
5. The bed should sit UNDER the clips' own audio, not over it.
   ⚠️ **CORRECTED (captions + music card).** This step used to say `sidechaincompress` ducks the
   bed while the programme is speaking. It does not: `plan.ts` ducks only when `audioBed.duck` is
   set, and the runner has never set it — the bed is mixed **flat** (ledger **D4**,
   `docs/probes/video-prompt-quality-ledger.md`). Inaudible while every clip is silent, which they
   are. If a bed drowns a clip today the only control is its level: `bedLevel` (low / medium / high,
   `beds.ts` `BED_LEVELS`). Ducking is D4's fix and is not built.
