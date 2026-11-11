/**
 * plan.ts — pure. Turns (clips + their probes + a target) into the exact ffmpeg argv
 * and filter graph that will produce the stitch. No I/O, no spawning, no clock.
 *
 * Why normalization is the load-bearing part: clips from different models do not share
 * encode params, and ffmpeg's two joining mechanisms both punish that.
 *   - The concat DEMUXER with `-c copy` accepts mismatched inputs, exits 0, and writes a
 *     SILENTLY CORRUPT file (every frame relabelled with the first clip's dimensions).
 *   - The concat FILTER refuses them outright: "Input link parameters do not match".
 * So every input is conformed first — resolution, pixel aspect, frame rate, pixel format,
 * timestamps and timebase — and only then joined.
 *
 * Two constraints that are not obvious and are easy to regress:
 *
 *  1. TIMEBASE. The concat filter emits timebase 1/1000000; a clip that has been through
 *     `fps=N` carries 1/N. `xfade` rejects inputs whose timebases differ. A cut followed
 *     by a crossfade therefore fails unless every node is pinned to one timebase, which is
 *     what the `settb`/`asettb` calls below are for. Dropping them breaks ONLY the mixed
 *     cut+crossfade case, which is exactly the case a narrow test misses.
 *
 *  2. ANAMORPHIC SOURCES. `scale` works on storage dimensions, so a clip with SAR 2:1
 *     conforms to the wrong shape unless its pixels are squared first. 640x480 SAR 2:1 is
 *     1280x480 on screen; into a 640x360 box it should letterbox to 640x240, but scaled
 *     naively it pillarboxes to 480x360 — the picture silently squeezed. Hence the
 *     conditional `scale=iw*sar:ih` prefix.
 *
 * The timeline accumulator below is the single source of truth for BOTH the crossfade
 * offsets and `expectedDurationSec`. That is deliberate: if the predicted duration came
 * from its own formula, comparing it against the probed output would validate a bug
 * against a parallel copy of the same mistake and pass while both were wrong.
 */
import type {
  AudioBed,
  ClipManifest,
  ClipNormalization,
  ClipProbe,
  StitchClip,
  StitchFinishing,
  StitchManifest,
  StitchTarget,
  StitchTransition,
} from "./types";
import { lookFilter } from "./look";

/**
 * One fine timebase for every node in the graph. Fine rather than 1/fps so that
 * non-integer rates (29.97) don't have to round, and uniform so xfade never sees a
 * mismatch no matter which node feeds it.
 */
export const TIMEBASE = "1/90000";

export const DEFAULT_TARGET = {
  pixFmt: "yuv420p",
  sampleRate: 48_000,
  channels: 2 as const,
  videoCodec: "libx264",
  crf: 23,
  preset: "veryfast",
  audioCodec: "aac",
  audioBitrate: "128k",
};

export const DEFAULT_BED = {
  level: 0.25,
  loop: true,
  duck: { ratio: 8, thresholdDb: -26, attackMs: 20, releaseMs: 300 },
};

/**
 * The gain the bed's LEVEL applies, after it was (or was not) brought to the reference loudness.
 *
 * ─── A BED WITH NOTHING TO SIT UNDER IS THE PROGRAMME ───────────────────────────────────────────────────────────
 *
 * A level is how far UNDER her own sound the music sits: Medium (DEFAULT_BED.level, 0.25 = −12 dB) is a level for music
 * under speech. Applied to a timeline where no clip sounds — stills, silent or muted clips: music only — it put the
 * whole output 12 LU under the reference (a normalized bed at −14 LUFS came out at about −26). So when the bed was
 * normalized (finishing's bedGainDb) and there is no sound to sit under, the level is read RELATIVE TO MEDIUM and
 * CLAMPED AT THE REFERENCE: gain = min(level / Medium, 1). Medium and Loud both land the music at BED_REFERENCE_LUFS
 * (−14 LUFS; the true-peak limiter then holds −1 dBTP) — nothing is pushed past the platform's target, where it would
 * only be turned down again; Quiet sits its offset under it.
 *
 * Under sound, or with a bed that was never measured (no finishing, or a file ffmpeg could not meter: its loudness is
 * unknown, so nothing is raised), the level is applied as it always was.
 */
export function bedLevelGain(level: number, ctx: { normalized: boolean; underSound: boolean }): number {
  if (!ctx.normalized || ctx.underSound) return level;
  return Math.round(Math.min(level / DEFAULT_BED.level, 1) * 1e6) / 1e6;
}

export type StitchPlan = {
  args: string[];
  filterGraph: string;
  clips: ClipManifest[];
  expectedDurationSec: number;
  audioBed: StitchManifest["audioBed"];
  hasAudio: boolean;
};

/** Trailing-zero-free decimal, so offsets read "1.5" and never "1.5000000000000002". */
export function fmt(n: number): string {
  return String(Number(n.toFixed(6)));
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Sources are local paths. ffmpeg would happily stream https, but this module has nowhere
 * to carry a bearer token, so a signed URL that has expired becomes an obscure decode
 * failure deep in ffmpeg instead of a clean, actionable error. The caller fetches first.
 */
export function assertLocalPath(source: string, label: string): void {
  if (URL_LIKE.test(source)) {
    throw new Error(
      `${label} must be a local file path, got a URL (${source.slice(0, 60)}). ` +
        `Download it first — the stitch engine carries no auth.`,
    );
  }
  if (!source.trim()) throw new Error(`${label} is empty`);
}

function ratio(sar: string): number {
  const [n, d] = sar.split(":").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 1;
  return n / d;
}

/** The conform chain for one clip. Emitted per clip because the SAR step is conditional. */
function videoNormalizeChain(
  probe: ClipProbe,
  t: Required<Pick<StitchTarget, "width" | "height" | "fps">> & {
    pixFmt: string;
  },
  /**
   * quality-scrappy piece 6 (STUDIO_FINISHING): fill the target by CROPPING a source of another shape, at `focusX`
   * (0 left … 1 right) or centred, instead of padding it. Absent — every caller before the finishing pass — the chain
   * is the pad it always was, byte for byte.
   */
  fill?: { focusX?: number },
  /**
   * A look's colour filter (studio/video/look.ts), after the frame rate is set and before the pixel format — so it runs
   * on the conformed picture and before any caption is laid over it. Absent: the chain byte for byte.
   */
  look?: string,
): {
  chain: string;
  normalization: Omit<ClipNormalization, "silenceSynthesized">;
} {
  const sarNeedsFix = probe.sampleAspectRatio !== "1:1";
  const steps: string[] = [];

  // Square the pixels BEFORE fitting, or an anamorphic clip conforms to the wrong shape.
  if (sarNeedsFix) steps.push("scale=iw*sar:ih", "setsar=1");

  const displayAr =
    (probe.width * ratio(probe.sampleAspectRatio)) / probe.height;
  const targetAr = t.width / t.height;
  const cropped = !!fill && Math.abs(displayAr - targetAr) > 1e-3;

  steps.push(
    ...(cropped
      ? [
          // Scale UP until both edges cover the target, then cut the overhang: nothing black is ever added. The
          // x offset maps focusX linearly across the overhang (0.5, and absent, is centred), so it cannot leave it.
          `scale=${t.width}:${t.height}:force_original_aspect_ratio=increase`,
          `crop=${t.width}:${t.height}:(iw-ow)*${fmt(fill!.focusX ?? 0.5)}:(ih-oh)/2`,
        ]
      : [
          `scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease`,
          `pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        ]),
    "setsar=1",
    `fps=${fmt(t.fps)}`,
    ...(look ? [look] : []),
    `format=${t.pixFmt}`,
    // Rebase timestamps — required after an input-level seek, or the trimmed clip carries
    // its original PTS into the join and lands in the wrong place on the timeline.
    "setpts=PTS-STARTPTS",
    `settb=${TIMEBASE}`,
  );

  return {
    chain: steps.join(","),
    normalization: {
      scaled: probe.width !== t.width || probe.height !== t.height,
      padded: !cropped && Math.abs(displayAr - targetAr) > 1e-3,
      ...(cropped ? { cropped: true as const } : {}),
      sarCorrected: sarNeedsFix,
      fpsChanged: Math.abs(probe.fps - t.fps) > 1e-3,
      pixFmtChanged: probe.pixFmt !== t.pixFmt,
    },
  };
}

export function planStitch(input: {
  clips: StitchClip[];
  probes: ClipProbe[];
  audioBed?: AudioBed;
  outputPath: string;
  target: StitchTarget;
  /** quality-scrappy piece 6 (STUDIO_FINISHING). Absent: the plan, and its argv, exactly as before. */
  finishing?: StitchFinishing;
}): StitchPlan {
  const { clips, probes, outputPath } = input;
  const finishing = input.finishing;

  if (clips.length === 0) throw new Error("stitch needs at least one clip");
  if (probes.length !== clips.length) {
    throw new Error(
      `probe count (${probes.length}) does not match clip count (${clips.length})`,
    );
  }
  assertLocalPath(outputPath, "outputPath");

  const target = { ...DEFAULT_TARGET, ...input.target };
  if (
    !Number.isInteger(target.width) ||
    !Number.isInteger(target.height) ||
    target.width <= 0 ||
    target.height <= 0
  ) {
    throw new Error(
      `target dimensions must be positive integers, got ${target.width}x${target.height}`,
    );
  }
  if (target.width % 2 !== 0 || target.height % 2 !== 0) {
    // yuv420p subsamples chroma 2x2; an odd dimension is not encodable.
    throw new Error(
      `target dimensions must be even for ${target.pixFmt}, got ${target.width}x${target.height}`,
    );
  }
  if (!(target.fps > 0))
    throw new Error(`target fps must be positive, got ${target.fps}`);

  const layout = target.channels === 1 ? "mono" : "stereo";
  const bed = input.audioBed
    ? {
        ...input.audioBed,
        level: input.audioBed.level ?? DEFAULT_BED.level,
        loop: input.audioBed.loop ?? DEFAULT_BED.loop,
      }
    : null;
  if (bed) assertLocalPath(bed.source, "audioBed.source");
  const bedStartSec = bed?.startSec ?? 0;
  if (!Number.isFinite(bedStartSec) || bedStartSec < 0) {
    throw new Error(`audioBed.startSec must be >= 0, got ${bedStartSec}`);
  }

  // ── resolve trims into effective durations ─────────────────────────────────────────
  const effective: number[] = [];
  const trims: ClipManifest["trim"][] = [];
  clips.forEach((clip, i) => {
    assertLocalPath(clip.source, `clips[${i}].source`);
    const probe = probes[i];
    const start = clip.trimStartSec ?? 0;
    const end = Math.min(
      clip.trimEndSec ?? probe.durationSec,
      probe.durationSec,
    );
    if (start < 0)
      throw new Error(`clips[${i}] trimStartSec must be >= 0, got ${start}`);
    const dur = end - start;
    if (!(dur > 0)) {
      throw new Error(
        `clips[${i}] has no duration after trim (start ${start}s, end ${end}s, source is ${probe.durationSec}s)`,
      );
    }
    effective.push(dur);
    trims.push(
      clip.trimStartSec === undefined && clip.trimEndSec === undefined
        ? null
        : { startSec: start, endSec: end },
    );
  });

  // A clip SOUNDS if its file has an audio track and she has not muted it. A muted clip is, to
  // everything below, a clip with no audio: it takes the synthesized-silence path that already
  // exists for mute files — no second mechanism, and the join stays well-formed.
  const sounds = clips.map((clip, i) => probes[i].hasAudio && !clip.muted);

  // Output carries audio if any clip sounds, or if a bed is laid under it. When it does,
  // clips that do NOT sound get synthesized silence — the concat filter binds by
  // stream specifier and fails outright ("matches no streams") on a mute clip otherwise.
  const hasAudio = bed !== null || sounds.some(Boolean);
  const silentClips = hasAudio
    ? clips.map((_, i) => i).filter((i) => !sounds[i])
    : [];

  // ── input args; index order is load-bearing for the graph's stream specifiers ───────
  const args: string[] = ["-y", "-nostdin"];
  clips.forEach((clip, i) => {
    // Input-level -ss/-to: both absolute in the SOURCE timeline, and they seek rather than
    // decode-and-discard, which matters on long sources.
    if (clip.trimStartSec !== undefined)
      args.push("-ss", fmt(clip.trimStartSec));
    if (trims[i]) args.push("-to", fmt(trims[i]!.endSec));
    args.push("-i", clip.source);
  });

  const silenceInputIndex = new Map<number, number>();
  silentClips.forEach((clipIndex) => {
    silenceInputIndex.set(clipIndex, clips.length + silenceInputIndex.size);
    args.push(
      "-f",
      "lavfi",
      "-t",
      fmt(effective[clipIndex]),
      "-i",
      `anullsrc=channel_layout=${layout}:sample_rate=${target.sampleRate}`,
    );
  });

  let bedInputIndex = -1;
  if (bed) {
    bedInputIndex = clips.length + silentClips.length;
    // Seekable local file, so -stream_loop is safe; it covers a timeline longer than the bed.
    if (bed.loop) args.push("-stream_loop", "-1");
    args.push("-i", bed.source);
  }

  // Overlay images go LAST, after every input that existed before there were overlays. That is
  // what keeps the argv of a timeline without one byte-for-byte what it was: no index moves.
  //
  // No `-loop 1`: a still is ONE frame, and `overlay` repeats its second input's last frame for as
  // long as the main input runs (eof_action=repeat, the default). Looping it would make an
  // infinite input that has to be cut off again with `shortest`, for nothing.
  const overlayInputIndex = new Map<number, number>();
  clips.forEach((clip, i) => {
    if (!clip.overlay) return;
    assertLocalPath(clip.overlay.source, `clips[${i}].overlay.source`);
    if (!Number.isInteger(clip.overlay.y) || clip.overlay.y < 0) {
      throw new Error(
        `clips[${i}] overlay y must be a non-negative integer, got ${clip.overlay.y}`,
      );
    }
    overlayInputIndex.set(
      i,
      clips.length +
        silentClips.length +
        (bed ? 1 : 0) +
        overlayInputIndex.size,
    );
    args.push("-i", clip.overlay.source);
  });

  // ── per-clip conform ───────────────────────────────────────────────────────────────
  // The look is a NAME expanded from a closed table (look.ts) — null for natural and for no look at all.
  const lookChain = finishing?.look ? lookFilter(finishing.look) : null;
  const nodes: string[] = [];
  const manifests: ClipManifest[] = [];
  const audioFormat = `aformat=sample_fmts=fltp:sample_rates=${target.sampleRate}:channel_layouts=${layout},asetpts=PTS-STARTPTS`;

  clips.forEach((clip, i) => {
    const { chain, normalization } = videoNormalizeChain(
      probes[i],
      {
        width: target.width,
        height: target.height,
        fps: target.fps,
        pixFmt: target.pixFmt,
      },
      finishing?.cropToFill
        ? clip.focusX === undefined
          ? {}
          : { focusX: clip.focusX }
        : undefined,
      lookChain ?? undefined,
    );
    const overlayAt = overlayInputIndex.get(i);
    if (overlayAt === undefined) {
      nodes.push(`[${i}:v]${chain}[v${i}]`);
    } else {
      // Laid over the clip AFTER it is conformed and BEFORE it is joined: the picture is placed in
      // target pixels, and it then belongs to the clip — it is cut with it and crossfades with it,
      // with no offset arithmetic against the timeline at all.
      //
      // `format=auto` keeps the main input's pixel format, so a captioned clip and a bare one still
      // match at the join.
      //
      // ⚠️  NO `settb` AFTER IT, AND THAT WAS MEASURED RATHER THAN FORGOTTEN. The header's
      // constraint 1 made a re-pin here look obligatory, so one was written — and then removed by
      // revert check: with it deleted, 0 of 45 tests went red on ffmpeg 9.0.1, including the
      // cut-then-crossfade stitch with every clip captioned, which is the exact case a timebase
      // mismatch breaks. overlay keeps the main input's 1/90000. A line that no test can tell is
      // there is the kind of line that ends up described by a comment that is not true.
      //
      // What is NOT measured: the deployed image's ffmpeg (Debian's 5.1). That stitch test is the
      // guard — it reds on any build that does need the re-pin — and the dev-acceptance list in
      // docs/probes/video-captions-music-ledger.md carries the one environment no suite runs on.
      nodes.push(`[${i}:v]${chain}[vb${i}]`);
      nodes.push(
        `[vb${i}][${overlayAt}:v]overlay=0:${clip.overlay!.y}:format=auto[v${i}]`,
      );
    }

    if (hasAudio) {
      const src = sounds[i] ? i : silenceInputIndex.get(i)!;
      nodes.push(`[${src}:a]${audioFormat}[a${i}]`);
    }

    manifests.push({
      index: i,
      source: clip.source,
      probed: probes[i],
      trim: trims[i],
      effectiveDurationSec: effective[i],
      transitionIn:
        i === 0 ? { kind: "cut" } : (clip.transitionIn ?? { kind: "cut" }),
      normalization: {
        ...normalization,
        silenceSynthesized: hasAudio && !sounds[i],
      },
      ...(clip.overlay
        ? { overlay: { source: clip.overlay.source, y: clip.overlay.y } }
        : {}),
    });
  });

  // ── the timeline fold: ONE accumulator drives both the offsets and the total ───────
  let accumulated = effective[0];
  let vPrev = "v0";
  let aPrev = "a0";

  for (let k = 1; k < clips.length; k++) {
    const transition: StitchTransition = manifests[k].transitionIn;

    if (transition.kind === "crossfade") {
      const d = transition.durationSec;
      if (!(d > 0))
        throw new Error(
          `clips[${k}] crossfade durationSec must be > 0, got ${d}`,
        );
      // The fade has to fit inside BOTH sides: the timeline built so far, and the incoming
      // clip. Otherwise xfade reads past an edge and the join is garbage.
      if (d >= accumulated || d >= effective[k]) {
        throw new Error(
          `clips[${k}] crossfade of ${d}s does not fit — timeline so far is ${fmt(accumulated)}s ` +
            `and the incoming clip is ${fmt(effective[k])}s; the fade must be shorter than both`,
        );
      }
      const offset = accumulated - d;
      nodes.push(
        `[${vPrev}][v${k}]xfade=transition=fade:duration=${fmt(d)}:offset=${fmt(offset)}[vx${k}]`,
      );
      if (hasAudio)
        nodes.push(`[${aPrev}][a${k}]acrossfade=d=${fmt(d)}[ax${k}]`);
      // A crossfade OVERLAPS: the pair occupies d seconds less than their sum.
      accumulated = accumulated + effective[k] - d;
    } else {
      nodes.push(`[${vPrev}][v${k}]concat=n=2:v=1:a=0[vc${k}]`);
      // concat emits 1/1000000; pin it back or a following xfade refuses the input.
      nodes.push(`[vc${k}]settb=${TIMEBASE}[vx${k}]`);
      if (hasAudio) {
        nodes.push(`[${aPrev}][a${k}]concat=n=2:v=0:a=1[ac${k}]`);
        nodes.push(`[ac${k}]asettb=${TIMEBASE}[ax${k}]`);
      }
      accumulated = accumulated + effective[k];
    }

    vPrev = `vx${k}`;
    aPrev = `ax${k}`;
  }

  const expectedDurationSec = accumulated;

  // ── audio bed ─────────────────────────────────────────────────────────────────────
  let audioOut = aPrev;
  let bedManifest: StitchManifest["audioBed"] = null;

  if (bed) {
    // ─── WHERE THE BED STARTS IS A FILTER, NOT AN INPUT SEEK ─────────────────────────────────
    //
    // The obvious form is `-ss X` on the bed's input, the way clips are trimmed. What that DOES
    // with `-stream_loop -1` turned out to depend on where you ask (measured 2026-09-20, ffmpeg
    // 9.0.1, a bed whose pitch steps 300/600/1200 Hz every 2s, started 3s in):
    //
    //   straight to an encoder, no filter graph   600,1200,1200,600,1200 — every loop RE-SEEKS to
    //                                             X, so the track's opening never plays again
    //   inside THIS filter graph                  600,1200, 300,600,1200 — it wraps to the top
    //
    // `atrim` after the loop gives the second answer in both, because it is defined by the filter
    // rather than by how the demuxer happens to combine a seek with a loop. That is the reason it
    // is used: the two forms are INDISTINGUISHABLE in this graph on this build (a revert check
    // swapped them and the real-ffmpeg test stayed green), but a behaviour that already differs by
    // context on one version is not one to bet on across versions — and the deployed image runs a
    // different ffmpeg. Emitted only when she moved it, so an unmoved bed's graph is unchanged.
    const bedTrim =
      bedStartSec > 0
        ? `atrim=start=${fmt(bedStartSec)},asetpts=PTS-STARTPTS,`
        : "";
    // quality-scrappy piece 6 (R3): the bed brought to the reference loudness FIRST, so her level is an offset from a
    // known point rather than from whatever the master was. Absent — no finishing, or a bed that could not be measured
    // — the chain is what it was.
    const bedGain =
      finishing?.bedGainDb !== undefined
        ? `volume=${fmt(finishing.bedGainDb)}dB,`
        : "";
    const appliedLevel = bedLevelGain(bed.level, { normalized: finishing?.bedGainDb !== undefined, underSound: sounds.some(Boolean) });
    nodes.push(
      `[${bedInputIndex}:a]${bedTrim}${audioFormat},${bedGain}volume=${fmt(appliedLevel)}[bed]`,
    );
    // ─── DUCKED ONLY UNDER A CLIP THAT ACTUALLY SOUNDS ───────────────────────────────────────
    //
    // The request may always ask (spec.ts does, ledger D4); whether there is anything to duck
    // UNDER is known only here, where the probes are. With every clip silent or muted the
    // sidechain would be fed synthesized silence and never cross its threshold — a no-op that
    // still rewrites the graph. So it is not emitted, and a silent-clip stitch keeps the flat
    // graph it has always had, byte for byte. The manifest reports what was DONE, not what was asked.
    const duckNow = bed.duck && sounds.some(Boolean) ? bed.duck : null;
    if (duckNow) {
      const duck = { ...DEFAULT_BED.duck, ...duckNow };
      // sidechaincompress takes a LINEAR threshold; the contract exposes dBFS.
      const threshold = Math.pow(10, duck.thresholdDb / 20);
      nodes.push(`[${aPrev}]asplit=2[prog][sc]`);
      nodes.push(
        `[bed][sc]sidechaincompress=threshold=${fmt(threshold)}:ratio=${fmt(duck.ratio)}:` +
          `attack=${fmt(duck.attackMs)}:release=${fmt(duck.releaseMs)}[bedduck]`,
      );
      // duration=first clamps to the programme, so a long or looped bed can't extend the
      // output. normalize=0 keeps the programme at unity instead of halving it.
      nodes.push(
        `[prog][bedduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
      );
    } else {
      nodes.push(
        `[${aPrev}][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
      );
    }
    audioOut = "aout";
    bedManifest = {
      source: bed.source,
      // The gain the level actually applied (bedLevelGain) — what was DONE, as the rest of the manifest reports.
      level: appliedLevel,
      ducked: Boolean(duckNow),
      looped: bed.loop,
      ...(bedStartSec > 0 ? { startSec: bedStartSec } : {}),
      coversSec: expectedDurationSec,
      // The finishing pass ran but had no loudness to level the bed by (finishing.ts measureLoudness failed or found
      // silence): a degraded step, reported, not hidden. Absent without finishing — nothing was asked.
      ...(finishing && finishing.bedGainDb === undefined ? { unlevelled: true as const } : {}),
    };
  }

  // ─── THE TRUE-PEAK LIMITER (quality-scrappy piece 6, R3) ────────────────────────────────────────
  //
  // On the final mix, when there is one. Four-times oversampled so a sample-peak limiter holds the INTER-sample peaks
  // too (the beds' own masters measure up to +5.6 dBTP — ledger), then back to the target rate. `level=false`: the
  // limiter's auto-level would otherwise raise the whole mix to meet the ceiling, which is loudnorm by another name
  // and exactly what R3 rules out. No `latency` compensation: the option is newer than the deployed ffmpeg, and the
  // lookahead it would compensate is ~5 ms, under a frame.
  if (hasAudio && finishing?.truePeakDbtp !== undefined) {
    nodes.push(
      `[${audioOut}]aresample=192000,alimiter=limit=${fmt(Math.pow(10, finishing.truePeakDbtp / 20))}:level=false,aresample=${target.sampleRate}[afin]`,
    );
    audioOut = "afin";
  }

  const filterGraph = nodes.join(";");

  args.push("-filter_complex", filterGraph, "-map", `[${vPrev}]`);
  if (hasAudio) args.push("-map", `[${audioOut}]`);
  args.push(
    "-c:v",
    target.videoCodec,
    "-crf",
    String(target.crf),
    "-preset",
    target.preset,
    "-pix_fmt",
    target.pixFmt,
  );
  if (hasAudio) {
    args.push(
      "-c:a",
      target.audioCodec,
      "-b:a",
      target.audioBitrate,
      "-ar",
      String(target.sampleRate),
      "-ac",
      String(target.channels),
    );
  }
  // ─── BORN POSTABLE ──────────────────────────────────────────────────────────────────────────
  //
  // Instagram's Reels spec for an uploaded file is "MOV or MP4, NO EDIT LISTS, moov atom at the
  // front". +faststart is the second half. The first half is not the default: ffmpeg's mp4 muxer
  // writes an `edts` box on EVERY track — one for the AAC encoder's priming samples, one for
  // x264's B-frame delay.
  //
  // ⚠️  IT TAKES BOTH FLAGS, AND THE OBVIOUS ONE ALONE IS A SYNC BUG. Measured on this encode
  // (libx264 crf 23 veryfast + aac, 3.5 s, ffmpeg 9.0.1):
  //
  //   flags                                         edts  video start  audio start  bytes
  //   (default)                                       2     0.000        0.000       85847
  //   -use_editlist 0                                 0     0.0667       0.000       85783   ← audio leads by 2 frames
  //   -use_editlist 0 +negative_cts_offsets           0     0.000        0.000       85779   ← THIS
  //   +negative_cts_offsets alone                     2     0.000        0.000       85851
  //   -use_editlist 0 -bf 0                           0     0.000        0.000      102416   (+19%)
  //
  // Without an edit list ffmpeg has to put the B-frame delay somewhere, and by default it puts it
  // in the VIDEO track's start time — only the video's, so the picture lands 67 ms behind the
  // sound. `negative_cts_offsets` writes a version-1 `ctts` instead (ISO BMFF; signed composition
  // offsets), which lets the first frame present at zero with no edit list at all. What is left is
  // the AAC priming (1024 samples at 48 kHz ≈ 21 ms) played rather than skipped — under one frame.
  // The CONTAINER reads longer than the programme by that much on ffmpeg 9, and by ~63 ms on CI's
  // older ffmpeg, which counts the video track's length in DTS (two reorder frames past the last
  // PTS). Bookkeeping, not sync: both streams start at exactly zero on both.
  //
  // Set HERE rather than by remuxing at post time, so every stitch is postable the moment it
  // exists and there is no second pipeline to keep in step with this one. A stitch made BEFORE
  // this line still carries edit lists; if Instagram refuses one, the publish path tells her to
  // put it together again (studio/publish/instagram.ts, code `restitch`).
  // server/studio/video/stitch.test.ts "INSTAGRAM: …" fails if either flag is lost.
  args.push(
    "-use_editlist",
    "0",
    "-movflags",
    "+faststart+negative_cts_offsets",
    outputPath,
  );

  return {
    args,
    filterGraph,
    clips: manifests,
    expectedDurationSec,
    audioBed: bedManifest,
    hasAudio,
  };
}
