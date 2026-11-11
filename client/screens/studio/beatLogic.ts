/**
 * beatLogic — a stills edit cut to the music: every photo held for whole beats, every cut on one.
 *
 * Pure, like every Board module. It takes the positions boardStitch built and the track's grid (the
 * server measured it once per bed — studio/video/beatGrid.ts — and serves it with the bed), and
 * returns the same positions with each still's hold moved so the still ENDS on a beat.
 *
 * ─── ⚠️  CUT POINTS SNAP, NOT HOLDS ─────────────────────────────────────────────────────────────
 *
 * Snapping each hold to a whole number of beats drifts: a beat is 0.706 s at 85 BPM, never a whole
 * number of frames, so ten photos of "three beats" each would round ten times and end a third of a
 * second off the music. So the END of each still is put on the grid line nearest to where her
 * chosen hold would end, rounded to a frame there, and the hold is the difference. Every cut is
 * then within half a frame of a beat, however long the edit.
 *
 * ─── A JOIN BESIDE A STILL IS A CUT ────────────────────────────────────────────────────────────
 *
 * A crossfade has no single instant, so it cannot land on a beat. On the beat, the fades into and
 * out of every still are dropped; a join between two of her clips keeps its fade (and the maths
 * below subtracts it, as the engine does).
 *
 * ─── WHAT CANNOT BE KNOWN IS NOT CLAIMED ───────────────────────────────────────────────────────
 *
 * A generated shot's length is the model's until it is made, so every position after one has an
 * unknown start: its hold is left as she chose it and it is not called "on the beat".
 */
import type { TimelineItem } from "./stitchLogic";

export interface BeatGrid {
  bpm: number;
  /** Seconds into the track of beat 0. The Board starts the track at 0, so this is the programme's. */
  firstBeatSec: number;
}

export interface BeatPlan {
  grid: BeatGrid;
  /** The target's frame rate — cut times are rounded to its frames. */
  fps: number;
  /** The server's hold bounds (stitchLimits): a snapped hold stays inside them. */
  minStillSec: number;
  maxStillSec: number;
}

/**
 * Below this tempo one beat is nearly a second, and a photo held for one reads as a flicker rather
 * than a cut (Adi, 22 Sep 2026). On a slow track a photo is held for the fewest beats that make
 * SLOW_MIN_HOLD_SEC. At 63 BPM the server's 1 s floor already forces two beats; the rule is what
 * holds at 60 BPM, where one beat is exactly the server's second.
 */
export const SLOW_BPM = 70;
export const SLOW_MIN_HOLD_SEC = 1.5;

export interface SnappedPosition {
  item: TimelineItem;
  /** Where it starts in the programme, or null when something before it has no known length. */
  startSec: number | null;
  /** Its start is within half a frame of a beat. */
  onBeat: boolean;
  /** A still's hold in beats, once snapped; null for anything else or an unknown start. */
  beats: number | null;
}

/** The length a non-still position plays, when the Board knows it. */
function knownLength(item: TimelineItem): number | null {
  if (item.trimEndSec !== undefined)
    return item.trimEndSec - (item.trimStartSec ?? 0);
  if (item.durationSec !== null && item.durationSec !== undefined)
    return item.durationSec - (item.trimStartSec ?? 0);
  return null;
}

export function snapToBeat(
  items: TimelineItem[],
  plan: BeatPlan,
): SnappedPosition[] {
  const { grid, fps } = plan;
  const P = 60 / grid.bpm;
  const nearestBeat = (t: number) => Math.round((t - grid.firstBeatSec) / P);
  const beatTime = (k: number) => grid.firstBeatSec + k * P;
  const isStill = (it: TimelineItem | undefined) => it?.stillSec !== undefined;

  // Joins beside a still are cuts (see the header).
  const cut: TimelineItem[] = items.map((it, i) => {
    if (
      it.crossfadeSec === undefined ||
      !(isStill(it) || isStill(items[i - 1]))
    )
      return it;
    const { crossfadeSec: _drop, ...rest } = it;
    return rest;
  });

  // Time is carried in WHOLE FRAMES, so a hold is (end frame − start frame) / fps — an exact
  // number of frames with no difference-of-roundings left over (4.2333… − 2.1333… is not 2.1).
  const toFrame = (t: number) => Math.round(t * fps);
  const out: SnappedPosition[] = [];
  let startF: number | null = 0;
  for (const [i, it] of cut.entries()) {
    const fade = i > 0 ? (it.crossfadeSec ?? 0) : 0;
    if (startF !== null && fade > 0) startF = toFrame(startF / fps - fade);
    const start = startF === null ? null : startF / fps;
    const onBeat =
      start !== null &&
      Math.abs(start - beatTime(nearestBeat(start))) <= 0.5 / fps + 1e-9;

    if (isStill(it) && startF !== null && start !== null) {
      // Her hold says where she wants it to end; the nearest beat there is where it does. The
      // server encodes the hold to six decimals and ffmpeg rounds `-t` to the NEAREST frame
      // (measured, 9.0.1: 2.14 s → 64 frames, 2.15 s → 65), so whole frames arrive as whole frames;
      // still.test.ts holds the cut frames exactly through the real engine.
      let k = nearestBeat(start + (it.stillSec as number));
      const framesFor = (kk: number) =>
        toFrame(beatTime(kk)) - (startF as number);
      const floorSec =
        grid.bpm < SLOW_BPM
          ? Math.max(plan.minStillSec, SLOW_MIN_HOLD_SEC)
          : plan.minStillSec;
      while (framesFor(k) < floorSec * fps - 1e-9) k++;
      while (
        framesFor(k) > plan.maxStillSec * fps + 1e-9 &&
        framesFor(k - 1) >= floorSec * fps - 1e-9
      )
        k--;
      const frames = framesFor(k);
      out.push({
        item: { ...it, stillSec: frames / fps },
        startSec: start,
        onBeat,
        beats: k - nearestBeat(start),
      });
      startF += frames;
      continue;
    }

    out.push({ item: it, startSec: start, onBeat, beats: null });
    if (startF !== null) {
      const len = isStill(it) ? (it.stillSec as number) : knownLength(it);
      startF = len === null ? null : toFrame(startF / fps + len);
    }
  }
  return out;
}
