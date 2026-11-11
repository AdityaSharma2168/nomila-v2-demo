/**
 * timelineGeometry — the CapCut-style track, as arithmetic.
 *
 * Pure: no React, no `react-native`, no fetch. The same split as `contained-stage.ts` /
 * `use-contained-stage.ts` and `playerBox.ts` / `ClipPlayer.tsx`, and for the same reason — a
 * number that decides layout should not be reachable only by looking at a phone. The track
 * component applies what this returns; `use-clip-durations.ts` feeds it.
 *
 * ─── IT IS BUILT TO BE FED BY SOMETHING ELSE LATER ──────────────────────────────────────────────
 *
 * V8's segmentation is USER-DRIVEN: split and trim. The later video-index card produces the same
 * thing automatically — trimmed segments of one source laid on a timeline. That is why everything
 * below is a function of `TimelineItem[]`, and why a segment is nothing but an asset id plus a
 * span: automatic segmentation adds a producer, not a type.
 *
 * ─── TWO CLOCKS, AND CONFUSING THEM IS THE BUG THIS FILE EXISTS TO AVOID ────────────────────────
 *
 *   TRACK time    where a frame sits in the finished video. What the ruler shows, what the
 *                 playhead is measured in, what `totalSeconds` counts.
 *   SOURCE time   where that frame sits inside the original upload. What a player must be seeked
 *                 to, and what `trimStartSec` / `trimEndSec` are expressed in (V6 measured that
 *                 input-level `-ss`/`-to` are absolute in the source).
 *
 * They differ by the trim offset and by every crossfade before this position. Every rect below
 * carries BOTH, named, so no caller has to re-derive one from the other and get it wrong.
 */
import type { TimelineItem } from "./stitchLogic";

// ─── Zoom ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Points per second of track at rest, and the bounds a pinch may take it to.
 *
 * A LAYOUT BUDGET, not a measurement — there is no device here. 40 puts a four-second clip at
 * 160 pt, which is wide enough to grab an edge on. The track scrolls horizontally rather than
 * fitting the column, deliberately: a 3:00 timeline fitted to a 358 pt column draws a four-second
 * clip at 8 pt, and a trim handle on 8 pt is not an interaction.
 */
export const DEFAULT_PX_PER_SEC = 40;
export const MIN_PX_PER_SEC = 8;
export const MAX_PX_PER_SEC = 200;

export const clampZoom = (pxPerSec: number): number =>
  !Number.isFinite(pxPerSec) || pxPerSec <= 0
    ? DEFAULT_PX_PER_SEC
    : Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec));

// ─── px ↔ seconds ───────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️  EXACT INVERSES, AND THEY MUST STAY THAT WAY.
 *
 * Scrubbing, trimming and splitting all read a gesture's x and ask what time it is; the ruler and
 * the playhead ask the opposite. A MINIMUM CLIP WIDTH would break this — it makes the mapping
 * piecewise, so `timeAtX(xAtTime(t))` stops being `t` and every one of those three pieces starts
 * disagreeing with the picture. There is deliberately no minimum width; a short segment is kept
 * grabbable with `hitSlop` instead, which changes the touch target without lying about the
 * geometry.
 */
export const xAtTime = (seconds: number, pxPerSec: number): number =>
  seconds * pxPerSec;
export const timeAtX = (x: number, pxPerSec: number): number => x / pxPerSec;

// ─── How long is this clip, really ──────────────────────────────────────────────────────────────

/**
 *   precise   `media_assets.duration_seconds_precise` — ffprobe's measurement of the stored bytes,
 *             served as NULL rather than as a fallback when nothing has measured the row. The
 *             cheapest exact answer: it costs nothing here, because it arrived with the clip.
 *   measured  read off a decoder here on the client. Also exact, but it costs a load — so it is
 *             the rung BELOW precise and the rung ABOVE the integer. It is the only thing that can
 *             ever answer for a row the server has not probed yet.
 *   wire      `media_assets.duration_seconds`. Written ONLY when the client asserted one at upload
 *             (routes/media.ts) and stored as an INTEGER, so it is absent for most rows and
 *             ROUNDED for the rest — 7.4 seconds arrives as 7, and a trim handle built on 7 cannot
 *             reach the last 0.4.
 *   unknown   we have none of them.
 */
export type DurationSource = "precise" | "measured" | "wire" | "unknown";

export interface ClipDuration {
  seconds: number;
  source: DurationSource;
}

/**
 * What to DRAW an unknown clip as.
 *
 * ⚠️  THIS IS A WIDTH, NEVER A DURATION. An unknown contributes this many seconds to the LAYOUT so
 * the clip is visible and tappable, and it must keep contributing ZERO to `timelineTotals` — which
 * is that file's existing, deliberate posture, because telling her a timeline is three minutes long
 * when we do not know is worse than telling her it is shorter than it is. Letting this number reach
 * the totals would inflate the refusal and block timelines the server would happily accept.
 */
export const UNKNOWN_PLACEHOLDER_SEC = 3;

const usable = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The ladder: precise → measured → wire → unknown.
 *
 * ⚠️  BOTH EXACT SOURCES SIT ABOVE THE INTEGER, and the order between them is about COST, not
 * accuracy. `precise` and `measured` are both real measurements of the same bytes; precise simply
 * arrived with the clip and measured costs a load. The integer is last of the three because it is
 * rounded, and rounding down is the direction that makes an over-long timeline look legal.
 */
export function resolveDuration(
  precise: number | null | undefined,
  measured: number | null | undefined,
  wire: number | null | undefined,
): ClipDuration {
  if (usable(precise)) return { seconds: precise, source: "precise" };
  if (usable(measured)) return { seconds: measured, source: "measured" };
  if (usable(wire)) return { seconds: wire, source: "wire" };
  return { seconds: UNKNOWN_PLACEHOLDER_SEC, source: "unknown" };
}

// ─── The span of the source this position actually plays ────────────────────────────────────────

/** A window into the SOURCE. `seconds` is `materialize.effectiveSeconds` by another name. */
export interface SourceSpan {
  startSec: number;
  endSec: number;
  seconds: number;
}

/**
 * The same arithmetic `server/studio/video/materialize.ts effectiveSeconds` does, and deliberately
 * so: an absent trim means the whole clip, and the two must never disagree about how long a
 * position runs or the client's optimistic mirror refuses timelines the server accepts.
 */
export function spanOf(
  item: Pick<TimelineItem, "trimStartSec" | "trimEndSec">,
  whole: number,
): SourceSpan {
  const startSec = Math.max(0, item.trimStartSec ?? 0);
  const endSec = item.trimEndSec ?? whole;
  return { startSec, endSec, seconds: Math.max(0, endSec - startSec) };
}

// ─── The track ──────────────────────────────────────────────────────────────────────────────────

export interface TrackRect {
  /** `TimelineItem.key` — stable across reorders, and NOT the asset id (a clip may appear twice). */
  key: string;
  assetId: string;
  /** Where to draw it. `x` is the LEFT edge; overlapping neighbours are a crossfade, not a bug. */
  x: number;
  width: number;
  /** TRACK time — where this position sits in the finished video. */
  startSec: number;
  endSec: number;
  /** SOURCE time — where in the original upload those frames are. What a player is seeked to. */
  sourceStartSec: number;
  sourceEndSec: number;
  /** So the track can say out loud that it is drawing a guess. */
  durationSource: DurationSource;
  /**
   * Whether this position fades in from the one before it.
   *
   * Carried on the RECT rather than left for the caller to look up, so a track can be drawn from a
   * layout alone. That is what lets the layout be computed once, by whoever also needs to resolve
   * the playhead against it, instead of twice from the same inputs with a chance to disagree.
   */
  hasCrossfade: boolean;
  /**
   * The WHOLE length of the source, not of this position.
   *
   * ⚠️  What a trim handle must be clamped against — and deliberately carried so no caller has to
   * re-run the ladder to find it. For an unknown clip this is the PLACEHOLDER, which is why
   * `durationSource` travels beside it: trimming against a plausible three seconds would throw
   * away most of a minute-long clip.
   */
  wholeSec: number;
  /**
   * This position is one of her photos, held. Its length is the hold, so there is nothing to trim:
   * the track offers no handles on it. Absent on a clip — one spelling of "not a still".
   */
  still?: true;
}

export interface TrackLayout {
  rects: TrackRect[];
  totalWidth: number;
  /** `Σ effective − Σ crossfade`, which is what the finished video will run to. */
  totalSeconds: number;
}

/**
 * Lay the timeline out.
 *
 * ⚠️  CROSSFADES ARE SUBTRACTED, so consecutive rects OVERLAP by exactly the fade. That is not a
 * drawing flourish — it is the only way the ruler tells the truth. A two-second crossfade makes
 * the output two seconds shorter than the sum of its parts (the accumulator `timelineTotals` and
 * `plan.ts` both use), so clips laid end-to-end would put the playhead up to two seconds per join
 * away from the frame it points at.
 *
 * The fade is clamped to both neighbours: a fade longer than either has nothing left to fade, and
 * clamping here means a spec the server would have refused still cannot produce a backwards rect.
 */
export function trackLayout(
  items: TimelineItem[],
  /** Measured seconds by asset id — what `use-clip-durations` has learned so far. */
  measured: Map<string, number>,
  pxPerSec: number = DEFAULT_PX_PER_SEC,
): TrackLayout {
  const zoom = clampZoom(pxPerSec);
  const rects: TrackRect[] = [];
  let cursor = 0;
  let previousSeconds = 0;

  for (const [i, item] of items.entries()) {
    // A still's length is its hold — exact, known, and never measured off a decoder.
    const whole = resolveDuration(
      item.stillSec ?? item.durationPreciseSec,
      measured.get(item.assetId),
      item.durationSec,
    );
    const span = spanOf(item, whole.seconds);

    // Position 0 has nothing to fade FROM — stitchLogic.normalize guarantees it carries none, and
    // this agrees rather than trusting it.
    const asked = i === 0 ? 0 : (item.crossfadeSec ?? 0);
    const fade = Math.max(0, Math.min(asked, previousSeconds, span.seconds));

    const startSec = Math.max(0, cursor - fade);
    const endSec = startSec + span.seconds;

    rects.push({
      key: item.key,
      assetId: item.assetId,
      x: xAtTime(startSec, zoom),
      width: xAtTime(span.seconds, zoom),
      startSec,
      endSec,
      sourceStartSec: span.startSec,
      sourceEndSec: span.startSec + span.seconds,
      durationSource: whole.source,
      hasCrossfade: fade > 0,
      wholeSec: whole.seconds,
      ...(item.stillSec !== undefined ? { still: true as const } : {}),
    });

    cursor = endSec;
    previousSeconds = span.seconds;
  }

  const totalSeconds = rects.length ? rects[rects.length - 1].endSec : 0;
  return { rects, totalWidth: xAtTime(totalSeconds, zoom), totalSeconds };
}

// ─── Where the playhead is pointing ─────────────────────────────────────────────────────────────

export interface PlayheadAt {
  /** Index into `layout.rects`, which is index into `items` — they are built in step. */
  index: number;
  /** ⚠️  SOURCE time. Seek a player to THIS, never to the track time that produced it. */
  sourceSec: number;
}

/**
 * Which clip is under the playhead, and where in its source.
 *
 * ⚠️  INSIDE A CROSSFADE TWO CLIPS CONTAIN THE SAME INSTANT, AND THE LATER ONE WINS. It is the
 * clip being faded INTO and the one drawn on top, so it is the frame she is looking at. A
 * first-match scan would answer with the outgoing clip and preview the wrong thing for up to two
 * seconds at every join.
 *
 * Outside the track it clamps rather than returning null: a playhead dragged past the end still
 * has to show something, and the last frame is the honest answer. Null is reserved for a timeline
 * with no clips at all.
 */
export function resolvePlayhead(
  trackSec: number,
  layout: TrackLayout,
): PlayheadAt | null {
  const { rects } = layout;
  if (rects.length === 0) return null;

  if (!Number.isFinite(trackSec) || trackSec <= rects[0].startSec) {
    return { index: 0, sourceSec: rects[0].sourceStartSec };
  }

  let found = -1;
  // Forward, keeping the LAST match — see the header. Written as a scan rather than a reverse
  // find because the rects are not sorted by end time once fades overlap them.
  for (let i = 0; i < rects.length; i++) {
    if (trackSec >= rects[i].startSec && trackSec < rects[i].endSec) found = i;
  }

  if (found === -1) {
    const last = rects[rects.length - 1];
    return { index: rects.length - 1, sourceSec: last.sourceEndSec };
  }

  const rect = rects[found];
  const sourceSec = rect.sourceStartSec + (trackSec - rect.startSec);
  return {
    index: found,
    // Clamped: floating-point drift at a boundary must not seek past the trim's out-point.
    sourceSec: Math.min(
      Math.max(sourceSec, rect.sourceStartSec),
      rect.sourceEndSec,
    ),
  };
}

// ─── The ruler ──────────────────────────────────────────────────────────────────────────────────

/**
 * The closest two labelled ticks may sit, in points.
 *
 * A LAYOUT BUDGET again, not a measurement: "0:00" at 11 pt is about 26 pt wide, so 44 leaves the
 * labels visibly apart rather than merely not overlapping.
 */
export const RULER_MIN_TICK_PX = 44;

/**
 * The intervals a ruler is allowed to use, in seconds.
 *
 * Whole seconds only, because the labels are rendered with `clock()` — which rounds — so a
 * half-second ladder would print two ticks with the same text and look broken rather than precise.
 */
const TICK_LADDER = [1, 2, 5, 10, 15, 30, 60, 120, 300] as const;

export interface RulerTick {
  sec: number;
  x: number;
}

/**
 * How far apart the ticks go at this zoom.
 *
 * ⚠️  A FUNCTION OF THE ZOOM, never a constant. One tick per second is 200 pt apart at maximum
 * zoom and 8 pt apart at minimum: unreadable at one end and useless at the other. The first rung
 * of the ladder wide enough at this zoom wins, and the coarsest rung is the floor for a timeline
 * zoomed further out than the ladder anticipated.
 */
export function tickIntervalSec(pxPerSec: number): number {
  const zoom = clampZoom(pxPerSec);
  return (
    TICK_LADDER.find((sec) => sec * zoom >= RULER_MIN_TICK_PX) ??
    TICK_LADDER[TICK_LADDER.length - 1]
  );
}

/**
 * Where to draw the ruler's marks.
 *
 * ⚠️  THE LAST TICK NEVER EXCEEDS `totalSeconds`. A ruler that runs past the end of the track
 * implies footage that is not there, which is the one thing a ruler must not do.
 */
export function rulerTicks(
  totalSeconds: number,
  pxPerSec: number = DEFAULT_PX_PER_SEC,
): RulerTick[] {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return [];
  const zoom = clampZoom(pxPerSec);
  const interval = tickIntervalSec(zoom);
  const ticks: RulerTick[] = [];
  for (let sec = 0; sec <= totalSeconds; sec += interval) {
    ticks.push({ sec, x: xAtTime(sec, zoom) });
  }
  return ticks;
}

/**
 * The inverse of `resolvePlayhead` — where on the TRACK a source second is showing.
 *
 * ⚠️  NEEDED BECAUSE PLAYBACK REPORTS THE WRONG CLOCK. `timeUpdate` gives a position inside the
 * loaded file; the playhead is drawn in output time. Without this the line would sit still while
 * the video ran, or drift from it by the trim offset and every crossfade before this position.
 *
 * Null for an index that is not on the track, which is what a stale progress event from a clip that
 * has since been removed looks like.
 */
export function trackTimeAt(
  index: number,
  sourceSec: number,
  layout: TrackLayout,
): number | null {
  const rect = layout.rects[index];
  if (!rect) return null;
  const clamped = Math.min(
    Math.max(sourceSec, rect.sourceStartSec),
    rect.sourceEndSec,
  );
  return rect.startSec + (clamped - rect.sourceStartSec);
}

/** Keep a scrubbed second on the track. A drag runs past both ends of it constantly. */
export const clampToTrack = (sec: number, layout: TrackLayout): number =>
  !Number.isFinite(sec)
    ? 0
    : Math.min(Math.max(sec, 0), Math.max(0, layout.totalSeconds));

// ─── Where a dragged clip should land ───────────────────────────────────────────────────────────

/**
 * How long a finger must rest on a clip before a drag starts reordering it, in milliseconds.
 *
 * ⚠️  THIS NUMBER RESOLVES TWO CONFLICTS AT ONCE, which is why it is not merely a feel setting.
 * The track lives inside a horizontal ScrollView, so a reorder that activated on the first movement
 * would lose the race to the scroll — or win it, and make the track unscrollable. And the selected
 * clip carries trim handles whose own pan activates immediately; the hold is what keeps a reorder
 * from stealing an edge drag.
 */
export const REORDER_HOLD_MS = 250;

/**
 * The index a dragged clip should take, given where its centre has been dragged to.
 *
 * ⚠️  "HOW MANY OTHERS HAVE THEIR CENTRE LEFT OF MINE" IS ALREADY THE ANSWER, with no ±1 anywhere.
 * That count is the index the clip would occupy once it has been removed from the array — which is
 * exactly what `moveItem`'s `to` means, because it splices the item out before splicing it back in.
 * Correcting it by one in either direction is the bug this comment exists to prevent.
 *
 * The dragged clip is skipped rather than compared against itself: counting it would shift every
 * answer by one the moment it moved right of its own centre, and a clip dropped where it started
 * would jump.
 */
export function dropIndexFor(
  centreX: number,
  layout: TrackLayout,
  from: number,
): number {
  if (!Number.isFinite(centreX)) return from;
  let index = 0;
  for (const [i, rect] of layout.rects.entries()) {
    if (i === from) continue;
    if (rect.x + rect.width / 2 < centreX) index++;
  }
  return index;
}
