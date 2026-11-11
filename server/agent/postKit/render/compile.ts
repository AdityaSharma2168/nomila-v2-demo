/**
 * agent/postKit/render/compile.ts — the treatment plan → render COMPILER (design "Moments → post kits" §11 v2, build
 * step 9). Pure: no I/O, no clock, no model. It decides everything a preview render does, as data, and the runner
 * (worker.ts) only carries it out.
 *
 *   compileRender     a built kit + what is still in the athlete's library → a RenderPlan and its key
 *   renderKey         the plan, hashed: the same kit renders once (a re-request with an unchanged key does nothing)
 *   conformToProbes   the plan against the files' real lengths, at run time (a clip shorter than its row said)
 *   stitchRequestFor  a reel's or story's plan + the workspace's local files → the engine's StitchRequest
 *   slideRequestFor   one carousel clip slide → its own short StitchRequest
 *   renderJobSpec / readRenderJobSpec   what the stitch queue stores, and the check every stored one is read through
 *
 * The mapping, field by field (the table in §11):
 *
 *   treatmentPlan.aspect      → the frame: a reel or story is pinned to 9:16 (1080×1920), a feed post or carousel to
 *                               4:5 (1080×1350) — StitchTarget width/height
 *   treatmentPlan.cropToFill  → StitchFinishing.cropToFill (a clip), and a fill-crop of every photo before it is held
 *   treatmentPlan.order       → the positions' order (StitchClip[] for a video; the pictures' order for a carousel)
 *   treatmentPlan.trims       → StitchClip.trimStartSec / trimEndSec, kept inside the clip's known length
 *   treatmentPlan.stills      → a held photo's seconds (MIN_STILL_SEC…MAX_STILL_SEC), in a video format only
 *   treatmentPlan.overlayText → a Caption (top, boxed) drawn by captionRender.ts inside Reels' safe zones, laid over the
 *                               opening position as StitchClip.overlay — the words never reach an ffmpeg argv
 *   kit.music.selected        → the track she chose from the kit's suggestions (agent/postKit/music.ts; a licensed or
 *                               free-library track, never a non-brand-safe one under a brand post) → audioBed
 *   treatmentPlan.musicMood   → when the kit has no suggestions: studio/music/recommend.ts, the best track carrying
 *                               that mood (brand-safe only for a post that names a brand) → StitchRequest.audioBed,
 *                               brought to the reference loudness (finishing.ts) under a true-peak ceiling
 *   treatmentPlan.lookPreset  → StitchFinishing.look: one fixed colour filter (studio/video/look.ts); the same filter
 *                               on a carousel picture
 *   treatmentPlan.coverFrame  → the cover: a position and seconds into it; the runner takes one ffmpeg still there
 *   treatmentPlan.totalSec    → recomputed from the positions as the engine will lay them, capped at 30 s
 *
 * Joins are the compiler's own call (the treatment plan has no transition field): a short crossfade where both sides
 * run at least CROSSFADE_MIN_SIDE_SEC, a cut otherwise — so a very short clip is never half a dissolve.
 *
 * Nothing here names an athlete, sport, school or brand.
 */
import { createHash } from "node:crypto";
import {
  LOOK_PRESETS, POST_ASPECTS, POST_FORMATS, POST_KIT_RENDER_CONTRACT,
  type LookPreset, type PostAspect, type PostFormat, type PostKit, type RenderNote,
} from "../../../../shared/postKit";
import { recommend } from "../../../studio/music/recommend";
import { isTrackId, MUSIC_TRACKS, type TrackId, type TrackMood } from "../../../studio/music/tracks";
import { isMusicId } from "../../../studio/music/find";
import { isLibraryTrackId } from "../../../studio/music/library";
import { selectedTrackFor } from "../music";
import {
  CAPTION_MAX_CHARS, CAPTION_POSITIONS, CAPTION_STYLES, isCaptionCodePoint, normalizeCaptionText, type Caption,
} from "../../../studio/video/captions";
import { TRUE_PEAK_DBTP } from "../../../studio/video/finishing";
import { DEFAULT_STILL_SEC, MAX_CROSSFADE_SEC, MAX_STILL_SEC, MIN_STILL_SEC } from "../../../studio/video/spec";
import type { ClipOverlay, StitchFinishing, StitchRequest } from "../../../studio/video/types";
import { POST_KIT, POST_KIT_RENDER } from "../config";

// ─── The plan ────────────────────────────────────────────────────────────────────────────────────────────────────

export const RENDER_FPS = 30;

/** The output frame per aspect: 1080 on the short edge, what every destination surface takes. */
export const RENDER_FRAMES: Readonly<Record<PostAspect, { width: number; height: number }>> = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
};

/** The shortest position a preview shows: under this a clip reads as a glitch, not a shot. */
export const MIN_POSITION_SEC = 0.5;
/** The crossfade between two positions that both run long enough to carry one. */
export const CROSSFADE_SEC = 0.3;
export const CROSSFADE_MIN_SIDE_SEC = 1;
/** Where the overlay line sits and how it is drawn: the hook, at the top, on a plate (legible over any footage). */
export const OVERLAY_POSITION: Caption["position"] = "top";
export const OVERLAY_STYLE: Caption["style"] = "boxed";
/** One frame: the latest a cover may be taken before a position (or the cut) ends. */
const FRAME_SEC = 1 / RENDER_FPS;

export interface RenderPosition {
  assetId: string;
  kind: "clip" | "still";
  /** A clip's seconds, absolute in the source; null on a still. */
  trimStartSec: number | null;
  trimEndSec: number | null;
  /** A still's hold in a video; null on a clip, and on every carousel or feed picture. */
  holdSec: number | null;
  /** The crossfade INTO this position; null is a cut (always on the first position, and on every slide). */
  crossfadeSec: number | null;
}

/** The cover: which position, and how many seconds into it (0 on a picture). */
export interface RenderCover {
  position: number;
  offsetSec: number;
}

interface PlanBase {
  contract: typeof POST_KIT_RENDER_CONTRACT;
  format: PostFormat;
  aspect: PostAspect;
  width: number;
  height: number;
  cropToFill: boolean;
  look: LookPreset;
  positions: RenderPosition[];
  cover: RenderCover;
}

/** A reel or story: one 9:16 video. */
export interface VideoRenderPlan extends PlanBase {
  output: "video";
  overlay: Caption | null;
  /** A catalogue id (studio/music/find.ts isMusicId): a licensed track or a free-library one. */
  bed: string | null;
  totalSec: number;
}

/** A feed post or carousel: one picture per position (a clip position is a short video slide). */
export interface SlidesRenderPlan extends PlanBase {
  output: "slides";
}

export type RenderPlan = VideoRenderPlan | SlidesRenderPlan;

/** What the compiler knows of each kit asset now: whether it is still in the library, its kind, its length. */
export interface RenderSource {
  mediaType: "photo" | "clip";
  durationSec: number | null;
}

export interface CompileOptions {
  /** The post names a brand: only brand-safe tracks go under it. */
  forBrand: boolean;
  /** The licensed tracks are installed here (studio/video/beds.ts bedsReady). */
  musicReady: boolean;
  /** The free library's files are installed here (studio/music/library.ts musicLibraryReady). Absent = not. */
  libraryReady?: boolean;
}

export type CompileOutcome =
  | { ok: true; plan: RenderPlan; key: string; notes: RenderNote[] }
  | { ok: false; reason: "no_assets" | "nothing_available"; notes: RenderNote[] };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const isVideoFormat = (f: PostFormat) => f === "reel" || f === "story";
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const durOf = (p: RenderPosition) => (p.kind === "clip" ? p.trimEndSec! - p.trimStartSec! : p.holdSec ?? 0);

/**
 * A clip's seconds, inside its known length and at least MIN_POSITION_SEC; at most `maxSec`. Null when the clip itself
 * is shorter than MIN_POSITION_SEC (nothing to show).
 */
export function fitClip(startSec: number, endSec: number, durationSec: number | null, maxSec: number): { startSec: number; endSec: number } | null {
  if (durationSec !== null && !(durationSec >= MIN_POSITION_SEC)) return null;
  let start = Number.isFinite(startSec) && startSec > 0 ? startSec : 0;
  let end = Number.isFinite(endSec) ? endSec : start + maxSec;
  if (durationSec !== null) {
    end = Math.min(end, durationSec);
    start = Math.min(start, durationSec);
  }
  if (end - start < MIN_POSITION_SEC) {
    start = Math.max(0, end - MIN_POSITION_SEC);
    if (end - start < MIN_POSITION_SEC) end = start + MIN_POSITION_SEC;
    if (durationSec !== null && end > durationSec) { end = durationSec; start = Math.max(0, end - MIN_POSITION_SEC); }
  }
  if (end - start > maxSec) end = start + maxSec;
  return { startSec: r3(start), endSec: r3(end) };
}

/** Each position's start on the output timeline, and the total — plan.ts's own fold (a crossfade overlaps by its length). */
export function timelineOf(positions: readonly RenderPosition[]): { starts: number[]; totalSec: number } {
  const starts: number[] = [];
  let acc = 0;
  positions.forEach((p, i) => {
    const start = i === 0 ? 0 : acc - (p.crossfadeSec ?? 0);
    starts.push(r3(start));
    acc = start + durOf(p);
  });
  return { starts, totalSec: r3(acc) };
}

/** The joins: a crossfade where both sides run at least CROSSFADE_MIN_SIDE_SEC, a cut elsewhere and on position 0. */
function withJoins(positions: RenderPosition[]): RenderPosition[] {
  return positions.map((p, i) => ({
    ...p,
    crossfadeSec: i > 0 && durOf(positions[i - 1]) >= CROSSFADE_MIN_SIDE_SEC && durOf(p) >= CROSSFADE_MIN_SIDE_SEC ? CROSSFADE_SEC : null,
  }));
}

/**
 * A video's positions inside the length cap: the later clips give up seconds first (none below MIN_POSITION_SEC), then
 * the last positions go. Joins are recomputed after every change.
 */
function capVideo(positions: RenderPosition[], maxSec: number): { positions: RenderPosition[]; capped: boolean } {
  let ps = withJoins(positions);
  let capped = false;
  for (let guard = 0; guard < 64 && timelineOf(ps).totalSec > maxSec + 1e-9; guard++) {
    capped = true;
    const over = timelineOf(ps).totalSec - maxSec;
    const i = [...ps.keys()].reverse().find((k) => ps[k].kind === "clip" && durOf(ps[k]) > MIN_POSITION_SEC + 1e-9);
    if (i !== undefined) {
      const p = ps[i];
      const give = Math.min(over, durOf(p) - MIN_POSITION_SEC);
      ps[i] = { ...p, trimEndSec: r3(p.trimEndSec! - give) };
    } else if (ps.length > 1) {
      ps = ps.slice(0, -1);
    } else {
      break;
    }
    ps = withJoins(ps);
  }
  return { positions: ps, capped };
}

/**
 * Where the cover sits: the treatment's cover asset (its first position), at its moment — else the opening position.
 * Kept clear of a crossfade at either end of the position, and inside it by one frame.
 */
function coverFor(positions: readonly RenderPosition[], want: { assetId: string; atSec: number | null } | null): RenderCover {
  const at = want ? positions.findIndex((p) => p.assetId === want.assetId) : -1;
  const position = at >= 0 ? at : 0;
  const p = positions[position];
  const dur = durOf(p);
  const fadeIn = p.crossfadeSec ?? 0;
  const fadeOut = positions[position + 1]?.crossfadeSec ?? 0;
  const hi = Math.max(fadeIn, dur - fadeOut - FRAME_SEC);
  let offset: number;
  if (p.kind === "clip") {
    offset = at >= 0 && want!.atSec !== null ? want!.atSec - p.trimStartSec! : Math.min(1, dur / 2);
  } else {
    offset = p.holdSec === null ? 0 : dur / 2;
  }
  return { position, offsetSec: r3(p.holdSec === null && p.kind === "still" ? 0 : clamp(offset, fadeIn, hi)) };
}

/**
 * The overlay line as the caption font can draw it: emoji and other scripts removed (the font has no glyph for them),
 * whitespace folded, cut at a word to CAPTION_MAX_CHARS — or null when nothing drawable is left.
 */
export function drawableOverlay(text: string | null): string | null {
  if (!text) return null;
  const kept = Array.from(text.normalize("NFC").replace(/\s+/g, " "))
    .filter((ch) => ch === " " || isCaptionCodePoint(ch.codePointAt(0)!))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!kept) return null;
  const points = Array.from(kept);
  let out = kept;
  if (points.length > CAPTION_MAX_CHARS) {
    const head = points.slice(0, CAPTION_MAX_CHARS).join("");
    const cut = head.lastIndexOf(" ");
    out = (cut > CAPTION_MAX_CHARS / 2 ? head.slice(0, cut) : head).trim();
  }
  return normalizeCaptionText(out);
}

/** The best track that carries the mood — a brand-safe one for brand work — or null when none does. */
export function trackForMood(mood: string, forBrand: boolean): TrackId | null {
  for (const r of recommend({ feel: [mood], forBrand })) {
    if (isTrackId(r.id) && (MUSIC_TRACKS[r.id].moods as readonly string[]).includes(mood as TrackMood)) return r.id;
  }
  return null;
}

/** The kit's seconds for a clip: its trim, else its own clip range, else its opening. */
function trimOf(kit: PostKit, assetId: string): { startSec: number; endSec: number } {
  const t = kit.treatmentPlan.trims.find((x) => x.assetId === assetId);
  if (t) return { startSec: t.startSec, endSec: t.endSec };
  const c = kit.assets.find((a) => a.assetId === assetId)?.clip;
  if (c) return { startSec: c.startSec, endSec: c.endSec };
  return { startSec: 0, endSec: POST_KIT.MAX_CLIP_SEC };
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export function compileRender(kit: PostKit, sources: ReadonlyMap<string, RenderSource>, opts: CompileOptions): CompileOutcome {
  const tp = kit.treatmentPlan;
  const notes: RenderNote[] = [];
  if (!tp.order.length || !kit.assets.length) return { ok: false, reason: "no_assets", notes };
  const format = kit.idea.format;
  const video = isVideoFormat(format);
  // Pinned by format, whatever the treatment says: a reel or story is 9:16, a feed post or carousel 4:5.
  const aspect: PostAspect = video ? "9:16" : "4:5";
  const frame = RENDER_FRAMES[aspect];
  const maxSec = POST_KIT_RENDER.MAX_SEC;

  let positions: RenderPosition[] = [];
  for (const assetId of uniq(tp.order)) {
    const src = sources.get(assetId);
    if (!src) { notes.push("asset_missing"); continue; }
    if (src.mediaType === "clip") {
      const want = trimOf(kit, assetId);
      const fitted = fitClip(want.startSec, want.endSec, src.durationSec, maxSec);
      if (!fitted) { notes.push("clip_too_short"); continue; }
      positions.push({ assetId, kind: "clip", trimStartSec: fitted.startSec, trimEndSec: fitted.endSec, holdSec: null, crossfadeSec: null });
    } else {
      const hold = video ? clamp(tp.stills.find((s) => s.assetId === assetId)?.holdSec ?? DEFAULT_STILL_SEC, MIN_STILL_SEC, MAX_STILL_SEC) : null;
      positions.push({ assetId, kind: "still", trimStartSec: null, trimEndSec: null, holdSec: hold, crossfadeSec: null });
    }
  }
  // A feed post is one picture.
  if (format === "feed") positions = positions.slice(0, 1);
  if (!positions.length) return { ok: false, reason: "nothing_available", notes: uniq(notes) };

  const look: LookPreset = (LOOK_PRESETS as readonly string[]).includes(tp.lookPreset) ? tp.lookPreset : "natural";
  const base = { contract: POST_KIT_RENDER_CONTRACT, format, aspect, width: frame.width, height: frame.height, cropToFill: tp.cropToFill !== false, look };

  if (!video) {
    const plan: SlidesRenderPlan = { ...base, output: "slides", positions, cover: coverFor(positions, tp.coverFrame) };
    return { ok: true, plan, key: renderKey(plan), notes: uniq(notes) };
  }

  const capped = capVideo(positions, maxSec);
  if (capped.capped) notes.push("over_length");
  positions = capped.positions;

  const text = drawableOverlay(tp.overlayText);
  if (tp.overlayText && !text) notes.push("overlay_not_drawable");
  let bed: string | null = null;
  const chosen = selectedTrackFor(kit, opts.forBrand);
  if (chosen !== undefined) {
    // Her pick from the kit's suggestions (or none). Brand-safety was checked by selectedTrackFor.
    if (chosen !== null) {
      // A free-library track has its own install gate (STUDIO_MUSIC_LIBRARY_READY); a licensed one, the beds'.
      if (!(isLibraryTrackId(chosen) ? opts.libraryReady === true : opts.musicReady)) notes.push("music_not_installed");
      else bed = chosen;
    }
  } else if (tp.musicMood) {
    if (!opts.musicReady) notes.push("music_not_installed");
    else {
      bed = trackForMood(tp.musicMood, opts.forBrand);
      if (!bed) notes.push("no_track_for_mood");
    }
  }
  const plan: VideoRenderPlan = {
    ...base,
    output: "video",
    positions,
    cover: coverFor(positions, tp.coverFrame),
    overlay: text ? { text, position: OVERLAY_POSITION, style: OVERLAY_STYLE } : null,
    bed,
    totalSec: timelineOf(positions).totalSec,
  };
  return { ok: true, plan, key: renderKey(plan), notes: uniq(notes) };
}

// ─── The key ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** JSON with every object's keys sorted: the same plan always hashes the same, whatever order it was built in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The plan's identity: 32 hex characters of its canonical JSON's SHA-256. */
export function renderKey(plan: RenderPlan): string {
  return createHash("sha256").update(canonical(plan)).digest("hex").slice(0, 32);
}

// ─── What it makes ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ExpectedOutput {
  kind: "video" | "image";
  sourceAssetId: string;
}

/** The files a plan renders, in order: one video for a reel or story; a picture (or a clip slide's video) per slide. */
export function expectedOutputs(plan: RenderPlan): ExpectedOutput[] {
  if (plan.output === "video") return [{ kind: "video", sourceAssetId: plan.positions[0].assetId }];
  return plan.positions.map((p) => ({ kind: p.kind === "clip" ? "video" : "image", sourceAssetId: p.assetId }));
}

/**
 * Which of a render's outputs carries the cover: the video itself, or the slide cut from the cover's asset — found by
 * its source, so it holds for what was actually published (a slide the run left out shifts the rest).
 */
export function coverAssetFor(plan: RenderPlan, outputs: ReadonlyArray<{ assetId: string; sourceAssetId: string }>): string | null {
  if (!outputs.length) return null;
  if (plan.output === "video") return outputs[0].assetId;
  const source = plan.positions[plan.cover.position]?.assetId;
  return (outputs.find((o) => o.sourceAssetId === source) ?? outputs[0]).assetId;
}

/** Every output of one kit's render for one key lives under this prefix, in the athlete's own space. */
export function renderKeyPrefix(athleteId: string, decisionId: string, key: string): string {
  return `athletes/${athleteId}/studio/post-kit/${decisionId}/${key}/`;
}

/**
 * Where one output is stored: `<prefix><index>-of-<count>.mp4|jpg`. The count is what the run actually published (a
 * run may leave out a clip shorter than its row said), so a set read back is complete exactly when every index of
 * one count is there — no other record needed.
 */
export function renderOutputPath(athleteId: string, decisionId: string, key: string, index: number, count: number, kind: "video" | "image"): string {
  return `${renderKeyPrefix(athleteId, decisionId, key)}${index}-of-${count}.${kind === "video" ? "mp4" : "jpg"}`;
}

/** The cover still of a video output (its poster), beside it. */
export function renderCoverPath(athleteId: string, decisionId: string, key: string, index: number, count: number): string {
  return `${renderKeyPrefix(athleteId, decisionId, key)}${index}-of-${count}.cover.jpg`;
}

/** An output path's index, count and kind — null for anything else under the prefix (a cover, a stray). */
export function parseRenderOutputPath(path: string): { index: number; count: number; kind: "video" | "image" } | null {
  const m = /\/(\d+)-of-(\d+)\.(mp4|jpg)$/.exec(path);
  if (!m) return null;
  const index = Number(m[1]);
  const count = Number(m[2]);
  return index < count ? { index, count, kind: m[3] === "mp4" ? "video" : "image" } : null;
}

// ─── At run time: the files' real lengths ────────────────────────────────────────────────────────────────────────

/**
 * The plan against what ffprobe read off the downloaded files: each clip kept inside its real length (a row's duration
 * is a claim; the file is the fact), a clip too short to show dropped, the joins, length cap, cover and total recomputed.
 * Null when nothing is left to render.
 */
export function conformToProbes(plan: RenderPlan, probedSec: ReadonlyMap<string, number>): { plan: RenderPlan; notes: RenderNote[] } | null {
  const notes: RenderNote[] = [];
  const coverAsset = plan.positions[plan.cover.position]?.assetId ?? null;
  const coverWant = coverAsset ? { assetId: coverAsset, offsetSec: plan.cover.offsetSec } : null;
  const maxSec = POST_KIT_RENDER.MAX_SEC;
  let positions: RenderPosition[] = [];
  for (const p of plan.positions) {
    if (p.kind === "still") { positions.push(p); continue; }
    const real = probedSec.get(p.assetId);
    const fitted = fitClip(p.trimStartSec!, p.trimEndSec!, real ?? null, maxSec);
    if (!fitted) { notes.push("clip_too_short"); continue; }
    positions.push({ ...p, trimStartSec: fitted.startSec, trimEndSec: fitted.endSec });
  }
  if (!positions.length) return null;
  const toCover = (ps: RenderPosition[]): RenderCover => {
    const at = coverWant ? ps.findIndex((p) => p.assetId === coverWant.assetId) : -1;
    const want = at >= 0 ? { assetId: coverWant!.assetId, atSec: ps[at].kind === "clip" ? ps[at].trimStartSec! + coverWant!.offsetSec : null } : null;
    return coverFor(ps, want);
  };
  if (plan.output === "slides") return { plan: { ...plan, positions, cover: toCover(positions) }, notes };
  const capped = capVideo(positions, maxSec);
  if (capped.capped) notes.push("over_length");
  positions = capped.positions;
  return { plan: { ...plan, positions, cover: toCover(positions), totalSec: timelineOf(positions).totalSec }, notes };
}

// ─── To the engine ───────────────────────────────────────────────────────────────────────────────────────────────

/** The finishing a preview always asks for: the treatment's crop, a true-peak ceiling, the bed's gain, the look. */
function finishingFor(plan: RenderPlan, bedGainDb: number | null): StitchFinishing {
  return {
    cropToFill: plan.cropToFill,
    truePeakDbtp: TRUE_PEAK_DBTP,
    ...(bedGainDb !== null ? { bedGainDb } : {}),
    ...(plan.look !== "natural" ? { look: plan.look } : {}),
  };
}

/**
 * A reel's or story's plan + the workspace's LOCAL files → the engine's request. `sources[i]` is position i's file: the
 * clip as downloaded, or the still already encoded to a clip (studio/video/still.ts). Paths come from the workspace,
 * never from the plan, which holds asset ids only.
 */
export function stitchRequestFor(
  plan: VideoRenderPlan,
  files: { sources: readonly string[]; overlay: ClipOverlay | null; bedPath: string | null; bedGainDb: number | null },
  outputPath: string,
  timeoutMs: number,
): StitchRequest {
  if (files.sources.length !== plan.positions.length) throw new Error(`${plan.positions.length} positions, ${files.sources.length} files`);
  if (plan.overlay && !files.overlay) throw new Error("The overlay line was not drawn");
  return {
    clips: plan.positions.map((p, i) => ({
      source: files.sources[i],
      ...(p.kind === "clip" ? { trimStartSec: p.trimStartSec!, trimEndSec: p.trimEndSec! } : {}),
      transitionIn: p.crossfadeSec === null ? { kind: "cut" as const } : { kind: "crossfade" as const, durationSec: p.crossfadeSec },
      ...(i === 0 && plan.overlay && files.overlay ? { overlay: files.overlay } : {}),
    })),
    ...(files.bedPath ? { audioBed: { source: files.bedPath, duck: {} } } : {}),
    outputPath,
    target: { width: plan.width, height: plan.height, fps: RENDER_FPS },
    timeoutMs,
    finishing: finishingFor(plan, files.bedPath ? files.bedGainDb : null),
  };
}

/** One carousel clip slide → its own short video, at the slide frame, with its own sound and the post's look. */
export function slideRequestFor(plan: SlidesRenderPlan, index: number, source: string, outputPath: string, timeoutMs: number): StitchRequest {
  const p = plan.positions[index];
  if (!p || p.kind !== "clip") throw new Error(`Slide ${index} is not a clip`);
  return {
    clips: [{ source, trimStartSec: p.trimStartSec!, trimEndSec: p.trimEndSec!, transitionIn: { kind: "cut" } }],
    outputPath,
    target: { width: plan.width, height: plan.height, fps: RENDER_FPS },
    timeoutMs,
    finishing: finishingFor(plan, null),
  };
}

// ─── What the stitch queue stores ────────────────────────────────────────────────────────────────────────────────

export const RENDER_JOB_KIND = "post_kit_render" as const;

/**
 * studio_stitch_jobs.spec for a preview render. Asset ids and names only — no path, no url, no free number off a wire.
 * `clips` repeats the positions' ids in the shape every stitch row carries, so the readers that trace a stitch's output
 * back to its sources (services/intelligence/creative/store.ts) see a render's sources the same way.
 */
export interface RenderJobSpec {
  kind: typeof RENDER_JOB_KIND;
  contract: typeof POST_KIT_RENDER_CONTRACT;
  decisionId: string;
  key: string;
  plan: RenderPlan;
  clips: Array<{ assetId: string }>;
}

export function renderJobSpec(decisionId: string, plan: RenderPlan, key: string): RenderJobSpec {
  return { kind: RENDER_JOB_KIND, contract: POST_KIT_RENDER_CONTRACT, decisionId, key, plan, clips: plan.positions.map((p) => ({ assetId: p.assetId })) };
}

/** Whether a stitch row is a preview render (the runner's dispatch). A client's stitch spec can never carry `kind`. */
export const isRenderJobSpec = (spec: unknown): boolean =>
  !!spec && typeof spec === "object" && (spec as { kind?: unknown }).kind === RENDER_JOB_KIND;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sec = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const oneOf = (list: readonly string[], v: unknown): boolean => typeof v === "string" && list.includes(v);

/** Why a plan is not one compileRender could have written, or null. */
function planProblem(p: Record<string, any>): string | null {
  if (p.contract !== POST_KIT_RENDER_CONTRACT) return "contract";
  if (p.output !== "video" && p.output !== "slides") return "output";
  if (!oneOf(POST_FORMATS, p.format) || isVideoFormat(p.format) !== (p.output === "video")) return "format";
  if (!oneOf(POST_ASPECTS, p.aspect) || p.aspect !== (p.output === "video" ? "9:16" : "4:5")) return "aspect";
  const frame = RENDER_FRAMES[p.aspect as PostAspect];
  if (p.width !== frame.width || p.height !== frame.height) return "frame";
  if (typeof p.cropToFill !== "boolean") return "cropToFill";
  if (!oneOf(LOOK_PRESETS, p.look)) return "look";
  if (!Array.isArray(p.positions) || p.positions.length < 1 || p.positions.length > POST_KIT.MAX_ASSETS) return "positions";
  for (const [i, q] of (p.positions as Array<Record<string, any>>).entries()) {
    if (!q || typeof q !== "object" || typeof q.assetId !== "string" || !UUID_RE.test(q.assetId)) return `positions[${i}].assetId`;
    if (q.kind === "clip") {
      if (!sec(q.trimStartSec) || !sec(q.trimEndSec) || q.trimEndSec - q.trimStartSec < MIN_POSITION_SEC - 1e-9 || q.trimEndSec - q.trimStartSec > POST_KIT_RENDER.MAX_SEC + 1e-9) return `positions[${i}].trim`;
      if (q.holdSec !== null) return `positions[${i}].holdSec`;
    } else if (q.kind === "still") {
      if (q.trimStartSec !== null || q.trimEndSec !== null) return `positions[${i}].trim`;
      if (p.output === "video" ? !(sec(q.holdSec) && q.holdSec >= MIN_STILL_SEC && q.holdSec <= MAX_STILL_SEC) : q.holdSec !== null) return `positions[${i}].holdSec`;
    } else return `positions[${i}].kind`;
    if (q.crossfadeSec !== null && (p.output !== "video" || i === 0 || !(sec(q.crossfadeSec) && q.crossfadeSec > 0 && q.crossfadeSec <= MAX_CROSSFADE_SEC))) return `positions[${i}].crossfadeSec`;
  }
  const c = p.cover;
  if (!c || !Number.isInteger(c.position) || c.position < 0 || c.position >= p.positions.length || !sec(c.offsetSec)) return "cover";
  if (p.output === "video") {
    if (p.overlay !== null) {
      const o = p.overlay;
      if (!o || typeof o.text !== "string" || normalizeCaptionText(o.text) !== o.text) return "overlay";
      if (!Object.prototype.hasOwnProperty.call(CAPTION_POSITIONS, o.position) || !Object.prototype.hasOwnProperty.call(CAPTION_STYLES, o.style)) return "overlay";
      if (Object.keys(o).some((k) => !["text", "position", "style"].includes(k))) return "overlay";
    }
    if (p.bed !== null && !isMusicId(p.bed)) return "bed";
    if (!sec(p.totalSec) || p.totalSec > POST_KIT_RENDER.MAX_SEC + 1e-9) return "totalSec";
    if (Math.abs(timelineOf(p.positions as RenderPosition[]).totalSec - p.totalSec) > 1e-6) return "totalSec";
  }
  return null;
}

/**
 * A stored render spec, checked. A row is jsonb and is not trusted any more than a body: every id is a uuid, every name
 * is from its closed set, every number is bounded, and the key must be the plan's own hash — a plan edited on the row
 * after it was queued is refused, not run.
 */
export function readRenderJobSpec(spec: unknown): RenderJobSpec | { error: string } {
  if (!isRenderJobSpec(spec)) return { error: "not a post kit render" };
  const s = spec as Record<string, any>;
  if (s.contract !== POST_KIT_RENDER_CONTRACT) return { error: "contract" };
  if (typeof s.decisionId !== "string" || !UUID_RE.test(s.decisionId)) return { error: "decisionId" };
  if (typeof s.key !== "string" || !/^[0-9a-f]{32}$/.test(s.key)) return { error: "key" };
  if (!s.plan || typeof s.plan !== "object") return { error: "plan" };
  const problem = planProblem(s.plan);
  if (problem) return { error: `plan.${problem}` };
  if (renderKey(s.plan as RenderPlan) !== s.key) return { error: "key does not match the plan" };
  return renderJobSpec(s.decisionId, s.plan as RenderPlan, s.key);
}

