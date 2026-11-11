/**
 * types.ts — the stitch engine's public contract.
 *
 * This is what V7 (the assembly UI) calls. Deliberately narrow:
 *
 *  - Sources are LOCAL PATHS ONLY. ffmpeg can stream https, but a stitch engine has
 *    nowhere to carry a bearer token, so an expired or 401'd URL would surface as a
 *    deep ffmpeg decode failure instead of a clean "fetch it first". The caller
 *    downloads (with auth) and hands us a path. Network and auth stay out of here.
 *  - No job semantics. No lease, no reaper, no DB. A stitch is a function call; whoever
 *    wires the job type owns the concurrency story.
 *  - No model calls. This module is $0 by construction.
 */
import type { VideoLook } from "./look";

/** How a clip joins the PREVIOUS clip. Ignored on clip 0. */
export type StitchTransition =
  | { kind: "cut" }
  | { kind: "crossfade"; durationSec: number };

export type StitchClip = {
  /** Local filesystem path. URLs are rejected — see the note above. */
  source: string;
  /** Seconds into the source to start. Default 0. */
  trimStartSec?: number;
  /** Seconds into the source to stop, absolute in the SOURCE timeline. Default: end of clip. */
  trimEndSec?: number;
  /** Join to the previous clip. Default { kind: "cut" }. */
  transitionIn?: StitchTransition;
  /**
   * Drop this clip's OWN sound. The picture plays; silence is laid where its audio would have been,
   * through the same path a clip with no audio track takes. Default false.
   */
  muted?: boolean;
  /**
   * A picture laid over this clip for the whole of its span — in practice a caption, already drawn
   * (studio/video/captionRender.ts). The engine is handed PIXELS AND A PLACE and knows nothing
   * about text: no words reach an argv or a filter graph, which is the point.
   */
  overlay?: ClipOverlay;
  /**
   * quality-scrappy piece 6: where the subject sits across the source, 0 (left) … 1 (right), for a fill-crop to keep in
   * view. Nothing sets it today — no clip read carries a position — so every crop is centred.
   */
  focusX?: number;
};

export type ClipOverlay = {
  /** Local path to an image with alpha, the TARGET's width. URLs are rejected like any source. */
  source: string;
  /** Where its top edge sits in the output frame, in target pixels. */
  y: number;
};

/**
 * A bed track laid under the stitched programme audio.
 * `duck` pulls the bed down while the programme is speaking, via sidechaincompress
 * keyed on the programme itself.
 */
export type AudioBed = {
  /** Local filesystem path. */
  source: string;
  /** Linear gain on the bed. Default 0.25 — a bed sits *under*, it does not compete. */
  level?: number;
  /** Omit for no ducking (bed plays at a flat `level`). */
  duck?: {
    /** Compression ratio. Default 8. */
    ratio?: number;
    /** Level the programme must exceed to duck the bed, in dBFS. Default -26. */
    thresholdDb?: number;
    /** Milliseconds. Default 20. */
    attackMs?: number;
    /** Milliseconds. Default 300. */
    releaseMs?: number;
  };
  /** Loop the bed to cover the whole timeline. Default true. */
  loop?: boolean;
  /**
   * Seconds into the bed to START from. Default 0. When the bed loops it wraps to the beginning,
   * not back to here — see plan.ts for why that is the form used, and for the measurement.
   */
  startSec?: number;
};

/** Every input is conformed to these before anything is joined. */
export type StitchTarget = {
  /** Must be even (yuv420p chroma siting). */
  width: number;
  /** Must be even. */
  height: number;
  fps: number;
  /** Default "yuv420p". */
  pixFmt?: string;
  /** Default 48000. */
  sampleRate?: number;
  /** Default 2. */
  channels?: 1 | 2;
  /** Default "libx264". */
  videoCodec?: string;
  /** Default 23. */
  crf?: number;
  /** Default "veryfast". */
  preset?: string;
  /** Default "aac". */
  audioCodec?: string;
  /** Default "128k". */
  audioBitrate?: string;
};

export type StitchRequest = {
  clips: StitchClip[];
  audioBed?: AudioBed;
  /** Local path to write. Its directory must already exist. */
  outputPath: string;
  target: StitchTarget;
  /** Hard kill for the ffmpeg process. Default scales with output length. */
  timeoutMs?: number;
  /** quality-scrappy piece 6 (STUDIO_FINISHING). Absent: the stitch it always was, argv byte for byte. */
  finishing?: StitchFinishing;
};

/** The finishing pass's asks of the engine (studio/video/finishing.ts). Each absent key is today's behaviour. */
export type StitchFinishing = {
  /** dB applied to the bed BEFORE its level gain, bringing it to the reference loudness (R3). */
  bedGainDb?: number;
  /** A true-peak ceiling (dBTP) for the final mix, when the output has audio. */
  truePeakDbtp?: number;
  /** A source of another shape is cropped to fill the target instead of padded. */
  cropToFill?: boolean;
  /**
   * A look by NAME (studio/video/look.ts) laid on every position after its conform and before its caption. Absent, or
   * "natural": no filter, the chain byte for byte. Set by the post-kit preview render (agent/postKit/render).
   */
  look?: VideoLook;
};

/** What ffprobe actually found in a file — the "in" side of the manifest. */
export type ClipProbe = {
  width: number;
  height: number;
  fps: number;
  pixFmt: string;
  /** e.g. "1:1". Normalized to "1:1" when the container reports N/A. */
  sampleAspectRatio: string;
  durationSec: number;
  videoCodec: string;
  hasAudio: boolean;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
};

/** Which conformance steps actually did something to this clip. */
export type ClipNormalization = {
  scaled: boolean;
  padded: boolean;
  sarCorrected: boolean;
  fpsChanged: boolean;
  pixFmtChanged: boolean;
  /** True when the clip had no audio track and we generated silence for it. */
  silenceSynthesized: boolean;
  /** quality-scrappy piece 6: present, and true, only when a fill-crop replaced the pad. */
  cropped?: true;
};

export type ClipManifest = {
  index: number;
  source: string;
  probed: ClipProbe;
  trim: { startSec: number; endSec: number } | null;
  /** Duration this clip contributes BEFORE any crossfade overlap is subtracted. */
  effectiveDurationSec: number;
  transitionIn: StitchTransition;
  normalization: ClipNormalization;
  /** Present only when something was laid over this clip — absent is the one spelling of "nothing". */
  overlay?: { source: string; y: number };
};

export type StitchManifest = {
  outputPath: string;
  clips: ClipManifest[];
  audioBed: {
    source: string;
    /**
     * The level gain actually applied (plan.ts bedLevelGain): the asked level, except music-only on a normalized bed,
     * where it is read relative to Medium and clamped at the reference (min(level / 0.25, 1)).
     */
    level: number;
    ducked: boolean;
    looped: boolean;
    /** Where in the bed it started. ABSENT when she did not move it — one spelling of "from the top". */
    startSec?: number;
    /** Timeline length the bed was asked to cover. */
    coversSec: number;
    /**
     * PRESENT only when the finishing pass ran and the bed could not be brought to the reference loudness (its
     * measurement failed, or it is silent): it was mixed at its master's level. A degraded step, not a failure.
     */
    unlevelled?: true;
  } | null;
  /**
   * Predicted output length, taken from the SAME accumulator that produces the xfade
   * offsets (see plan.ts). Not a parallel formula — if it disagreed with the offsets,
   * comparing it against the probed output would just be validating a bug against
   * its own arithmetic.
   */
  expectedDurationSec: number;
  /** ffprobe of the file we actually wrote, plus its size. */
  output: ClipProbe & { sizeBytes: number };
  ffmpeg: {
    args: string[];
    filterGraph: string;
    durationMs: number;
  };
};
