/**
 * stitchLogic — the timeline builder, as arithmetic.
 *
 * Pipeline 1 of the two videoEntryLogic.ts named: **upload → stitch → music**. Everything here is
 * a function of its arguments — no React, no navigation, no fetch — for the reason that file gives:
 * the thinking must not live in the screen, so the provisional Video tab can be deleted and this
 * moved without being rewritten.
 *
 * ─── THE CAPS ARE MIRRORED HERE, AND THE SERVER IS STILL THE AUTHORITY ──────────────────────────
 *
 * `timelineRefusal` answers the same question `assertTimelineFits` does, from the same numbers —
 * but they arrive over the wire (GET /studio/stitch/options) rather than being copied, precisely so
 * this cannot drift from the server's own arithmetic when a cap moves.
 *
 * ⚠️  IT IS AN OPTIMISTIC MIRROR AND NOTHING MORE. It exists so she is told "that is too many
 * clips" while she is building, instead of after she taps and waits. It is NOT a guard: the server
 * re-resolves every id against her athlete and re-checks every cap at the door AND again at claim
 * time, because her library can change between the two. Anything this file concludes is a courtesy;
 * anything the server concludes is the answer.
 *
 * ─── WHY BYTES ARE COUNTED OVER UNIQUE ASSETS AND SECONDS OVER POSITIONS ────────────────────────
 *
 * The same distinction the server makes, for the same reason: the same clip twice is two inputs to
 * ffmpeg and two spans of output, but one download. Getting it backwards here would refuse a legal
 * timeline in the UI while the server happily accepted it — the worst kind of disagreement, because
 * she would never find out she was allowed.
 */

/** One of her videos, as the picker knows it. Shaped from GET /media?type=videos. */
export interface ClipChoice {
  assetId: string;
  /** Signed mp4 url, or null when we hold no playable bytes. */
  videoUrl: string | null;
  posterUrl: string | null;
  /**
   * ⚠️  TWO DURATIONS, AND THE ORDER BETWEEN THEM MATTERS.
   *
   * `durationSec` is `media_assets.duration_seconds` — an INTEGER, written only when the client
   * asserted one at upload. `durationPreciseSec` is `duration_seconds_precise`, measured by ffprobe
   * on the stored bytes, and NULL when nothing has measured that row (deliberately null rather than
   * falling back to the integer, so "measured 5.0" stays distinguishable from "asserted 5").
   *
   * Prefer the precise one. Charging 8 for a clip that is really 8.033 errs in the direction that
   * lets an over-long timeline look legal.
   */
  durationSec: number | null;
  durationPreciseSec: number | null;
  /** "Uploaded" / "Instagram" / "Made here" — where it came from, for the picker's badge. */
  origin: string | null;
}

/**
 * One of her photos, as the still picker knows it. Shaped from GET /studio/stitch/stills — a list
 * the server has already filtered to what a still may be made from.
 */
export interface StillChoice {
  assetId: string;
  /** The full photo, signed — what the preview shows while it is held. */
  imageUrl: string;
  /** The thumbnail (or the photo, when none was made), signed — what a tile shows. */
  thumbUrl: string;
  /** "Uploaded" / "Instagram" / "Made here", for the picker's badge. */
  origin: string | null;
}

/**
 * Words burned onto one position. Two NAMES and her text — the names come from
 * GET /studio/stitch/options (`captions.positions` / `captions.styles`) and are never hardcoded
 * here, for the reason the limits are not: the server's set is the set.
 */
export interface TimelineCaption {
  text: string;
  position: string;
  style: string;
  /** A colour NAME. Absent means the server's default — which it never stores either. */
  color?: string;
  /** A font NAME (PR 8). Absent means the server's default, Outfit — never stored either. */
  font?: string;
}

/** One position on the timeline she is building. */
export interface TimelineItem {
  /** Stable across reorders, and NOT the asset id — the same clip may appear twice. */
  key: string;
  assetId: string;
  /**
   * The clip's WHOLE length as the wire reported it, or null.
   *
   * ⚠️  NOT what this position plays once it is trimmed, and not to be trusted for layout:
   * `media_assets.duration_seconds` is written only when the client sent one at upload and is an
   * INTEGER column, so it is null for most rows and rounded for the rest. `timelineGeometry`
   * prefers a measured duration and falls back to this. See `resolveDuration`.
   */
  durationSec: number | null;
  /** ffprobe's answer for this asset, or null. Beats `durationSec`; see `ClipChoice`. */
  durationPreciseSec: number | null;
  /**
   * The window of the SOURCE this position plays. Absent means the whole clip.
   *
   * ⚠️  ABSOLUTE IN THE SOURCE, not relative to anything on the track — the same semantics
   * `server/studio/video/spec.ts` parses and V6 measured for ffmpeg's input-level `-ss`/`-to`.
   * That is what lets a SPLIT be two positions sharing one asset id with adjacent windows.
   */
  trimStartSec?: number;
  trimEndSec?: number;
  /** Absent is a cut. The first position can never carry one. */
  crossfadeSec?: number;
  /**
   * She has ASKED for a generated bridge into this position — and nothing has been generated or
   * billed yet.
   *
   * ─── ⚠️  A REQUEST, NOT A TRANSITION, AND THE DIFFERENCE IS THE WHOLE DESIGN ────────────────
   *
   * `cut` and `crossfade` are ffmpeg filter choices the stitch engine makes for free. A bridge is a
   * CLIP that Kling has to generate, at roughly $0.42 — so it is not a third `StitchTransition`
   * kind, and deliberately so: `stitchRunner.test.ts` asserts the stitch runner's import graph
   * reaches NOTHING that can spend, and the same suite pins that stitching has its own endpoint and
   * its own lock key so the free queue is never serialised behind the money path. Making the engine
   * able to buy a clip would red that guard or need cross-queue coordination and a second approval.
   *
   * So a bridge is generated on the ORDINARY video path and lands as an ordinary clip in this list.
   * It then inherits the poster, the real duration, QA and the whole timeline for nothing, because
   * by then it IS just a clip.
   *
   * ⚠️ THIS FIELD NEVER REACHES THE WIRE. `toStitchBody` does not emit it — see the note there.
   * It is the UI's record that a join is waiting on a generation she has not paid for yet.
   */
  bridgeRequested?: boolean;
  /**
   * Absent means no words. Never an empty caption — `setCaption` clears rather than storing blank
   * text, so "none" has the one representation the server's parser has.
   *
   * It belongs to the POSITION and travels with it: through a reorder, and through a SPLIT onto
   * BOTH halves. The halves were one continuous shot a moment ago; a caption that vanished halfway
   * through it would be a mystery, and removing it from one half is a single tap.
   */
  caption?: TimelineCaption;
  /**
   * True drops this clip's OWN sound from the finished video. Absent means it plays — `false` is
   * never stored, the way the server never stores it.
   *
   * It belongs to the POSITION, like the caption, and travels the same way: through a reorder, and
   * onto BOTH halves of a split (half a shot going silent on its own would be a mystery).
   */
  muted?: true;
  /**
   * Present when this position is one of her PHOTOS, held for this many seconds — a still. The
   * `assetId` is then the photo's. Absent means a clip, as it always did.
   *
   * ⚠️ A FLAG ON THE POSITION, NOT A SECOND KIND OF ITEM — the server's own shape (spec.ts). So a
   * still reorders, captions, fades and counts toward the caps like any position, for nothing. It
   * has no footage to trim, no sound to mute and no frame to bridge from: the setters below refuse
   * those and `normalize` strips them, because the server refuses them by field.
   */
  stillSec?: number;
  /**
   * How a still MOVES over its hold — "dolly", a slow push-in (D2; "pan" until PR 6); "zoom", "sweep" or "punch", a move
   * toward a point (A1) — or absent for dead still. The server's own field (spec.ts), refused on a
   * clip; only a still row ever carries it here.
   */
  stillMotion?: StillMotionName;
  /**
   * Where a zoom, sweep or punch heads — her tapped point, fractions 0..1 of the upright photo — or
   * absent for the server's framing prior (the upper middle). Only beside a focused motion:
   * the server refuses it anywhere else (spec.ts), so `setStillMotion` drops it on the way out.
   */
  stillFocus?: { x: number; y: number };
}

/** The server's motions (studio/video/still.ts STILL_MOTIONS), in the order a row offers them. */
export const STILL_MOTION_NAMES = ["dolly", "zoom", "sweep", "punch"] as const;
export type StillMotionName = (typeof STILL_MOTION_NAMES)[number];
/** The motions that head for a point, and so take one (still.ts FOCUSED_MOTIONS). */
export const takesFocus = (m: StillMotionName | null | undefined): boolean =>
  m === "zoom" || m === "sweep" || m === "punch";

/** Whether a position is one of her photos, held — rather than a clip. */
export const isStill = (item: TimelineItem | undefined): boolean =>
  item?.stillSec !== undefined;

/**
 * Every field of a position, and whether it goes on the wire.
 *
 * ─── ⚠️  THIS IS THE #538 GUARD, AND THE `satisfies` IS THE LOAD-BEARING PART ───────────────────
 *
 * #538 was a field added to a request and not to the thing that detects the request changed. The
 * stitch tab's version of that mistake is a field added to `TimelineItem` that `toStitchBody` never
 * emits — she sets it, sees it, queues, and gets a video without it, with no error anywhere.
 *
 * `satisfies Record<keyof TimelineItem, …>` makes that impossible to do quietly: a new field that is
 * not classified here does not COMPILE. And `stitchLogic.test.ts` walks this table against a fully
 * populated position, so "wire" means it arrives and "local" means it does not — the classification
 * cannot be a lie either. `timelineSignature` is built from the same table, so a wire field is
 * also, by construction, a field that makes a finished result stale.
 */
export const TIMELINE_ITEM_FIELDS = {
  assetId: "wire",
  trimStartSec: "wire",
  trimEndSec: "wire",
  crossfadeSec: "wire",
  caption: "wire",
  muted: "wire",
  stillSec: "wire",
  stillMotion: "wire",
  stillFocus: "wire",
  // The list's own key, the two durations the server re-measures for itself, and an intent that
  // is deliberately not a transition (see `bridgeRequested`).
  key: "local",
  durationSec: "local",
  durationPreciseSec: "local",
  bridgeRequested: "local",
} as const satisfies Record<keyof TimelineItem, "wire" | "local">;

const WIRE_FIELDS = (
  Object.keys(TIMELINE_ITEM_FIELDS) as (keyof TimelineItem)[]
).filter((k) => TIMELINE_ITEM_FIELDS[k] === "wire");

/** What the server told us a timeline may be. Never hardcoded here — see the header. */
export interface StitchLimits {
  maxClips: number;
  maxSourceBytes: number;
  maxTimelineSeconds: number;
  maxClipBytes: number;
  /** How long a photo may be held, and what it is held for when she has not chosen. */
  minStillSec: number;
  maxStillSec: number;
  defaultStillSec: number;
}

export const MAX_CROSSFADE_SEC = 2;

/**
 * The crossfade a free join gets — the timeline's "Fade" pill, and what the Board's "Crossfade ·
 * free" promises for every join she did not ask to bridge. ONE value, so the two surfaces cannot
 * fade differently. Provisional: one value, not a slider.
 */
export const DEFAULT_CROSSFADE_SEC = 0.5;

/**
 * The shortest a trimmed position may be.
 *
 * ⚠️  NOT A TASTE DECISION — it is what keeps a drag from producing a body the server refuses.
 * `parseStitchSpec` rejects `trimEndSec <= trimStartSec` BY FIELD, so two handles that cross over
 * become a 400 she cannot see the cause of. Clamping inside the gesture means the handle simply
 * stops moving, which is also the better feel.
 */
export const MIN_SEGMENT_SEC = 0.2;

let seq = 0;
/** A key that survives reordering and duplication. Monotonic, never reused within a session. */
export const itemKey = () => `t${++seq}`;

export function addClip(
  items: TimelineItem[],
  choice: ClipChoice,
): TimelineItem[] {
  return [
    ...items,
    {
      key: itemKey(),
      assetId: choice.assetId,
      durationSec: choice.durationSec,
      durationPreciseSec: choice.durationPreciseSec,
    },
  ];
}

/**
 * Put one of her photos on the end of the timeline, held for `stillSec` — the server's default
 * (`limits.defaultStillSec`) when she has not chosen. No durations: a photo has none of its own,
 * and the hold is the whole of its length.
 */
export function addStill(
  items: TimelineItem[],
  choice: StillChoice,
  stillSec: number,
): TimelineItem[] {
  return [
    ...items,
    {
      key: itemKey(),
      assetId: choice.assetId,
      durationSec: null,
      durationPreciseSec: null,
      stillSec,
    },
  ];
}

/**
 * How long one still is held — clamped to the server's bounds, so a chip or a stepper can never
 * produce a hold the parser refuses. A no-op on a clip: a clip's length is its trim.
 */
export function setStillSec(
  items: TimelineItem[],
  index: number,
  seconds: number,
  limits: Pick<StitchLimits, "minStillSec" | "maxStillSec">,
): TimelineItem[] {
  if (!Number.isFinite(seconds)) return items;
  return items.map((item, i) =>
    i !== index || !isStill(item)
      ? item
      : {
          ...item,
          stillSec: Math.min(
            limits.maxStillSec,
            Math.max(limits.minStillSec, seconds),
          ),
        },
  );
}

/**
 * The timeline she lands on from the Board's "Fine-tune in Video": the video the Board just stitched,
 * as the one clip on it — or null while there is nothing to do yet.
 *
 * Null while the clip list does not hold it (still loading, or not listed yet): the caller waits for
 * the list, and never seeds an empty timeline in its place. Null over a timeline that already has
 * anything on it: a handoff never replaces her work — the rule the Board's own seed keeps.
 */
export function fineTuneTimeline(
  current: TimelineItem[],
  clips: ClipChoice[] | undefined,
  assetId: string,
): TimelineItem[] | null {
  if (current.length > 0) return null;
  const clip = clips?.find((c) => c.assetId === assetId);
  return clip ? addClip([], clip) : null;
}

export const removeAt = (
  items: TimelineItem[],
  index: number,
): TimelineItem[] => items.filter((_, i) => i !== index);

/**
 * Move one position. Out-of-range is a NO-OP rather than an error: the only caller is a button
 * that should be disabled at the ends, and a crash is a worse answer to a double-tap than nothing.
 */
export function moveItem(
  items: TimelineItem[],
  from: number,
  to: number,
): TimelineItem[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Move one position to an index — THE one place a reorder happens.
 *
 * ⚠️  BOTH REORDER AFFORDANCES COME THROUGH HERE, and that is the point rather than a tidiness
 * preference. Dragging a clip and pressing an arrow are two ways of choosing a target index and
 * nothing else; letting each own its own mutation is how they drift the first time one is edited.
 * With one function, a change to the rules — `normalize` after every move, trims travelling with
 * their clip — cannot reach one path and miss the other.
 *
 * Keyed on the KEY because the caller knows which CLIP it moved, not which slot: after a split the
 * same asset holds several adjacent positions, and after a reorder an index is stale immediately.
 *
 * ⚠️  A NO-OP RETURNS THE SAME ARRAY, not an equal one. `normalize` maps, so it would build a fresh
 * array even when nothing moved — and handing React a new array on every press of a disabled arrow
 * re-renders the timeline and churns the layout for nothing.
 */
export function reorderTo(
  items: TimelineItem[],
  key: string,
  toIndex: number,
): TimelineItem[] {
  const from = items.findIndex((i) => i.key === key);
  if (from < 0 || toIndex === from) return items;
  if (toIndex < 0 || toIndex >= items.length) return items;
  return normalize(moveItem(items, from, toIndex));
}

/**
 * Set or clear the crossfade on one position.
 *
 * ⚠️  POSITION 0 CAN NEVER CARRY ONE — it has nothing to fade from, and the server refuses it by
 * field (`clips[0].crossfadeSec`). Clearing it here rather than rejecting keeps that impossible
 * state from surviving a reorder: a clip with a crossfade dragged to the front loses it, silently
 * and correctly, instead of becoming a 400 she cannot see the cause of.
 */
export function setCrossfade(
  items: TimelineItem[],
  index: number,
  seconds: number | null,
): TimelineItem[] {
  return items.map((item, i) => {
    if (i !== index) return item;
    const { crossfadeSec: _drop, ...rest } = item;
    if (i === 0 || seconds === null || seconds <= 0) return rest;
    return { ...rest, crossfadeSec: Math.min(seconds, MAX_CROSSFADE_SEC) };
  });
}

/**
 * Put words on one position, change them, or take them off.
 *
 * Blank text CLEARS: there is no such thing as an empty caption, here or in the server's spec. The
 * text is trimmed at the ends and otherwise left exactly as typed — what may be IN it is the
 * server's rule (studio/video/captions.ts) and its refusal is shown as written, because a second
 * copy of that rule here would be a second rule.
 */
export function setCaption(
  items: TimelineItem[],
  index: number,
  caption: TimelineCaption | null,
): TimelineItem[] {
  return items.map((item, i) => {
    if (i !== index) return item;
    const { caption: _drop, ...rest } = item;
    const text = caption?.text.trim() ?? "";
    if (!caption || text === "") return rest;
    return {
      ...rest,
      caption: {
        text,
        position: caption.position,
        style: caption.style,
        ...(caption.color ? { color: caption.color } : {}),
        ...(caption.font ? { font: caption.font } : {}),
      },
    };
  });
}

/** Mute or unmute one position's own sound. Off is ABSENT, never `false`. */
export function setClipMuted(
  items: TimelineItem[],
  index: number,
  muted: boolean,
): TimelineItem[] {
  return items.map((item, i) => {
    // A photo has no sound of its own to mute — the server refuses the instruction by field.
    if (i !== index || isStill(item)) return item;
    const { muted: _drop, ...rest } = item;
    return muted ? { ...rest, muted: true } : rest;
  });
}

/**
 * Ask for — or withdraw — a generated bridge into one position.
 *
 * ⚠️ IT SPENDS NOTHING. It records an intent; the generation is its own explicitly-confirmed action
 * on the money path, because a control that bills on tap is not a toggle. Same reason
 * CampaignWorkspaceScreen keeps Generate as the one button on the screen that spends.
 *
 * ⚠️ A BRIDGE AND A CROSSFADE ARE MUTUALLY EXCLUSIVE, and asking for one clears the other. They are
 * two answers to the same question — what happens between these two clips — and a join carrying both
 * would be a request to fade into a clip that is itself the transition. Position 0 can hold neither,
 * for the reason it can hold no crossfade: there is nothing before it to come from.
 */
export function setBridgeRequested(
  items: TimelineItem[],
  index: number,
  wanted: boolean,
): TimelineItem[] {
  return items.map((item, i) => {
    if (i !== index) return item;
    // A bridge is generated from one frame to the next; a still on either side is not offered one
    // in this version, so asking for it next to a photo leaves the join as it was.
    if (i === 0 || !wanted || isStill(item) || isStill(items[i - 1])) {
      const { bridgeRequested: _drop, ...rest } = item;
      return rest;
    }
    const { crossfadeSec: _fade, ...rest } = item;
    return { ...rest, bridgeRequested: true };
  });
}

/**
 * Applied after EVERY reorder, so position 0 never keeps a join it was moved into.
 *
 * ⚠️ IT STRIPS BOTH, and the bridge half is not decoration. A clip dragged to the front with a
 * crossfade would carry an impossible state the server rejects by field; one dragged to the front
 * with a bridge REQUEST would carry an impossible state the server never sees at all — the request
 * lives only here — and the UI would offer to generate a transition into the first clip, from
 * nothing. Silently wrong is worse than refused, so it is cleared on the same pass.
 */
export const normalize = (items: TimelineItem[]): TimelineItem[] =>
  items.map((item, i) => {
    let next = item;
    if (
      i === 0 &&
      (next.crossfadeSec !== undefined || next.bridgeRequested !== undefined)
    ) {
      const { crossfadeSec: _fade, bridgeRequested: _bridge, ...rest } = next;
      next = rest;
    }
    // A STILL carries none of what a clip's footage allows — the server refuses each by field, so
    // one that reached a still some other way is cleared here rather than sent.
    if (
      isStill(next) &&
      (next.trimStartSec !== undefined ||
        next.trimEndSec !== undefined ||
        next.muted !== undefined)
    ) {
      const { trimStartSec: _s, trimEndSec: _e, muted: _m, ...rest } = next;
      next = rest;
    }
    // And no bridge ask touches a still — reordering can put one on either side of a join.
    if (
      next.bridgeRequested !== undefined &&
      (isStill(next) || isStill(items[i - 1]))
    ) {
      const { bridgeRequested: _b, ...rest } = next;
      next = rest;
    }
    return next;
  });

/**
 * How many seconds this position actually PLAYS — `materialize.effectiveSeconds` by another name,
 * minus the byte estimate the server falls back to and the client deliberately does not.
 *
 * ⚠️  THE WHOLE DURATION IS NOT THE ANSWER ONCE A CLIP CAN BE TRIMMED. Charging a trimmed clip for
 * footage it no longer plays would make this mirror refuse timelines the server accepts — the worst
 * kind of disagreement, because she would never find out she was allowed.
 *
 * An unknown clip still contributes 0, which is this file's documented disagreement with the
 * server: a label under a picker must not claim a length nobody knows. That stays consistent
 * because an unknown clip cannot be trimmed at all (see `setTrim`).
 */
export function playedSeconds(item: TimelineItem): number {
  // A still plays exactly as long as it is held.
  if (item.stillSec !== undefined) return item.stillSec;
  const whole = item.durationPreciseSec ?? item.durationSec ?? 0;
  const start = item.trimStartSec ?? 0;
  const end = item.trimEndSec ?? whole;
  return Math.max(0, end - start);
}

/** Which edge of a clip a drag is moving. */
export type TrimEdge = "start" | "end";

/**
 * Move one edge of one position's window into its source.
 *
 * ⚠️  `whole` IS THE REAL LENGTH OF THE SOURCE, and passing a placeholder here is the mistake this
 * signature exists to make visible. A clip of unknown duration is drawn at a plausible three
 * seconds; trimming against that would write `trimEndSec: 3` onto a minute of footage and throw
 * away the rest. Callers pass 0 (or anything non-positive) for an unknown clip and get the items
 * back UNCHANGED — refusing, rather than guessing.
 *
 * Both edges are clamped to the source and kept `MIN_SEGMENT_SEC` apart, so a drag can never
 * produce the `trimEndSec <= trimStartSec` the server refuses by field.
 *
 * A window that covers the whole source DROPS both fields rather than writing them, because
 * "absent means the whole clip" is the spec's one representation of that and an untrimmed timeline
 * must keep producing a byte-identical body.
 */
export function setTrim(
  items: TimelineItem[],
  index: number,
  edge: TrimEdge,
  seconds: number,
  whole: number,
): TimelineItem[] {
  if (index < 0 || index >= items.length) return items;
  // A photo has no footage to trim: how long it is held IS its length (`setStillSec`).
  if (isStill(items[index])) return items;
  if (!Number.isFinite(whole) || whole <= 0) return items;
  if (!Number.isFinite(seconds)) return items;

  return items.map((item, i) => {
    if (i !== index) return item;

    const from = item.trimStartSec ?? 0;
    const to = item.trimEndSec ?? whole;

    /*
     * ⚠️  THE OUTER CLAMPS HERE ARE BELT-AND-BRACES, NOT THE MECHANISM — worth knowing before
     * anyone writes a test expecting them to be load-bearing.
     *
     * What actually stops a trim reaching past either end of the source is the pair of conditions
     * below: a start at or before 0 drops `trimStartSec`, and an end at or after `whole` drops
     * `trimEndSec`, and "absent" means exactly "from the beginning" / "to the end". So an
     * un-clamped 99 on a ten-second clip produces the same output as a clamped 10 — which is why a
     * mutation removing `Math.min(seconds, whole)` cannot be made to fail a test. Kept anyway, so
     * that changing the drop rule cannot quietly re-open the hole.
     *
     * `MIN_SEGMENT_SEC` is different: it IS load-bearing, because it is the only thing keeping the
     * two edges from crossing into the `trimEndSec <= trimStartSec` the server refuses by field.
     */
    const start =
      edge === "start"
        ? Math.min(Math.max(seconds, 0), to - MIN_SEGMENT_SEC)
        : from;
    const end =
      edge === "end"
        ? Math.max(Math.min(seconds, whole), from + MIN_SEGMENT_SEC)
        : to;

    const { trimStartSec: _s, trimEndSec: _e, ...rest } = item;
    return {
      ...rest,
      ...(start > 0 ? { trimStartSec: start } : {}),
      ...(end < whole ? { trimEndSec: end } : {}),
    };
  });
}

/**
 * Cut one position in two at a point inside it.
 *
 * ⚠️  `atSourceSec` IS IN SOURCE SECONDS — where the cut lands inside the ORIGINAL upload, which is
 * what `resolvePlayhead` returns. Track seconds would be right only for the first untrimmed
 * position and wrong for every one after it, because the two clocks differ by this clip's trim
 * offset and by every crossfade before it. A clip trimmed to 2–6 cut at 4 becomes 2–4 and 4–6,
 * never 0–4 and 4–8.
 *
 * The two segments carry the SAME asset id and adjacent windows, which is the whole trick: to
 * `assertTimelineFits` that is two positions (two clip slots, two spans of output) but still ONE
 * download, because bytes are counted over unique assets. So twelve is the real ceiling on
 * splitting and the byte budget does not move.
 *
 * Refused — items returned unchanged — when the clip's length is unknown (the playhead's position
 * inside a placeholder-width clip is fiction, the same hazard `setTrim` refuses) or when either
 * side would be shorter than `MIN_SEGMENT_SEC`. Not merely "non-positive": a 0.05s segment passes
 * the server's parser and is not a clip, and allowing it here while the trim handles refuse it
 * would be two rules for one thing.
 */
export function splitAt(
  items: TimelineItem[],
  index: number,
  atSourceSec: number,
  whole: number,
): TimelineItem[] {
  if (index < 0 || index >= items.length) return items;
  // Nothing to cut in a photo — two halves of a hold is just a longer hold.
  if (isStill(items[index])) return items;
  if (!Number.isFinite(whole) || whole <= 0) return items;
  if (!Number.isFinite(atSourceSec)) return items;

  const item = items[index];
  const from = item.trimStartSec ?? 0;
  const to = item.trimEndSec ?? whole;

  // Both sides measured against THIS position's window, not against the source.
  if (atSourceSec - from < MIN_SEGMENT_SEC) return items;
  if (to - atSourceSec < MIN_SEGMENT_SEC) return items;

  /*
   * Both segments are the ORIGINAL with one edge moved, which is why each is a spread of it with a
   * single override. Re-stating the other edge conditionally would be dead code: the spread already
   * carries whatever the original had, and "absent" already means the source's own edge. (Two
   * revert checks proved exactly that by mutating those lines and changing nothing.)
   */
  const head: TimelineItem = { ...item, trimEndSec: atSourceSec };

  const { crossfadeSec: _dropped, ...rest } = item;
  const tail: TimelineItem = {
    ...rest,
    key: itemKey(),
    trimStartSec: atSourceSec,
  };

  /*
   * ⚠️  THE HEAD KEEPS THE CROSSFADE AND THE KEY; THE TAIL GETS NEITHER.
   *
   * The tail follows the head across what was one continuous shot a moment ago — a fade there
   * would invent a transition she never asked for. And keeping the key on the head means her
   * selection survives the cut instead of silently jumping to something else.
   */
  return [...items.slice(0, index), head, tail, ...items.slice(index + 1)];
}

export interface TimelineTotals {
  clips: number;
  seconds: number;
  /** Unique assets — what would actually be downloaded. */
  downloads: number;
}

/**
 * What the timeline comes to.
 *
 * Crossfades are SUBTRACTED, because a two-second crossfade makes the output two seconds shorter
 * than the sum of its parts — the same accumulator `plan.ts` uses to place the xfade offsets. A
 * total that ignored them would over-state the length and refuse timelines the server accepts.
 *
 * A clip of unknown duration contributes 0 here, NOT a ceiling — and that is the one place this
 * file deliberately disagrees with the server's posture. The server charges an unknown at its
 * ceiling because guessing low there risks an OOM; this is a label under a picker, and telling her
 * a timeline is three minutes long when we do not know is worse than telling her it is shorter
 * than it is. The server still refuses at the door if the real number does not fit.
 */
export function timelineTotals(items: TimelineItem[]): TimelineTotals {
  /*
   * ⚠️  THE SAME TWO RUNGS THE SERVER USES, IN THE SAME ORDER, AND DELIBERATELY NOT THE CLIENT'S
   * OWN MEASUREMENT.
   *
   * `resolveClips` charges `duration_seconds_precise ?? duration_seconds` before falling through to
   * its byte estimate. Mirroring those two keeps this label agreeing with the authority. Adding the
   * decoded duration — which is MORE accurate — would be the wrong move here: the server cannot see
   * it, so the two would disagree about which timelines are legal with no way to reconcile them.
   * The decoder exists to draw the track honestly, not to argue with the cap.
   */
  const seconds = items.reduce(
    (sum, item, i) =>
      sum + playedSeconds(item) - (i === 0 ? 0 : (item.crossfadeSec ?? 0)),
    0,
  );
  return {
    clips: items.length,
    seconds: Math.max(0, seconds),
    downloads: new Set(items.map((i) => i.assetId)).size,
  };
}

/** "2:04" — the same clock the server's refusals use, so the two read as one voice. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Why this timeline cannot be made yet, or null.
 *
 * One sentence, naming the cap she hit — NOT all three. That is a deliberate difference from the
 * server, which names the whole shape because its message may be the only thing she ever reads.
 * Here the caps are already on screen beside the totals, so repeating them in the refusal is noise.
 */
export function timelineRefusal(
  items: TimelineItem[],
  limits: StitchLimits | null,
): string | null {
  if (items.length === 0) return "Add a clip to get started.";
  // The server's rule for a still (spec.ts), mirrored: its fades in and out both eat into the hold,
  // and together they must leave it a moment of its own. Needs no limits — it is arithmetic on the
  // timeline alone — so it is answered even before the options arrive.
  for (const [i, item] of items.entries()) {
    if (item.stillSec === undefined) continue;
    const fades =
      (i === 0 ? 0 : (item.crossfadeSec ?? 0)) +
      (items[i + 1]?.crossfadeSec ?? 0);
    if (fades >= item.stillSec) {
      return `The photo at ${i + 1} is held for ${item.stillSec}s and its fades take ${Number(fades.toFixed(2))}s — hold it longer or shorten a fade.`;
    }
  }
  if (!limits) return null; // options not loaded — the server is still the authority
  const totals = timelineTotals(items);
  if (totals.clips > limits.maxClips) {
    return `That's ${totals.clips} clips — the most we can join is ${limits.maxClips}.`;
  }
  if (totals.seconds > limits.maxTimelineSeconds) {
    return `That's ${clock(totals.seconds)} — the longest we can make is ${clock(limits.maxTimelineSeconds)}.`;
  }
  return null;
}

export type StitchTargetName = "portrait" | "square" | "landscape";

/**
 * The POST body. Only what the server's parser accepts, so a shape error is impossible from here.
 *
 * Built FROM `TIMELINE_ITEM_FIELDS`: a position's wire fields are emitted when set and omitted when
 * not ("absent means the whole clip / a cut / no words" is the spec's one representation of each —
 * writing `trimStartSec: 0` would make it two). A local field cannot be emitted at all.
 *
 * ⚠️ `bridgeRequested` IS LOCAL ON PURPOSE. The stitch spec has two transition kinds and gains no
 * third: a bridge is a generated CLIP that arrives in `clips` like any other, not a join the engine
 * knows how to buy. Emitting it would be sending the free queue a field whose only honest handling
 * is to spend.
 */
/** Where the sound starts is chosen to a tenth of a second — finer than a thumb, coarser than noise. */
const SOUND_START_STEP_SEC = 0.1;

/**
 * Where the sound starts after she drags its tile.
 *
 * ⚠️  DRAGGING LEFT STARTS IT LATER. The tile IS the sound, laid against the clips above it; pull it
 * left and its beginning slides off the front of the video, so what plays at 0:00 is further into
 * the track. That is the direction every editor uses, and the opposite sign here would feel broken
 * without looking broken.
 *
 * Clamped to the sound's own length (null when unknown — her video before it has been measured —
 * in which case the server's hour is the bound, and a start past the real end just wraps).
 */
export function soundStartAfterDrag(
  startSec: number,
  dxPx: number,
  pxPerSec: number,
  soundSeconds: number | null,
): number {
  if (!Number.isFinite(dxPx) || !Number.isFinite(pxPerSec) || pxPerSec <= 0) {
    return startSec;
  }
  // Leave a little of the sound to play: starting AT the end is starting at the top again.
  const max = Math.max(0, (soundSeconds ?? 3600) - 1);
  const moved = startSec - dxPx / pxPerSec;
  const stepped =
    Math.round(moved / SOUND_START_STEP_SEC) * SOUND_START_STEP_SEC;
  return Number(Math.min(max, Math.max(0, stepped)).toFixed(1));
}

/**
 * Where in the SOUND the preview should be, for a moment on the timeline.
 *
 * The finished video starts the sound `bedStartSec` in and, when the sound runs out, wraps to its
 * top (server/studio/video/plan.ts — `atrim` after the loop). This is that same rule, so what she
 * hears while previewing is what the stitch will lay under that moment. With the length unknown
 * there is nothing to wrap by, and the plain sum is the best honest answer.
 */
export function soundOffsetAt(
  bedStartSec: number,
  trackSec: number,
  soundSeconds: number | null,
): number {
  const at = Math.max(0, bedStartSec) + Math.max(0, trackSec);
  if (!soundSeconds || !Number.isFinite(soundSeconds) || soundSeconds <= 0) {
    return at;
  }
  return at % soundSeconds;
}

/**
 * The rest of what plays underneath, beyond a curated track's name.
 *
 * `bedAssetId` is one of HER videos, whose sound is used instead of a track. `bedStartSec` is how
 * far into the sound to start — for either kind.
 */
export interface StitchSound {
  bedAssetId?: string | null;
  bedStartSec?: number | null;
}

export function toStitchBody(
  items: TimelineItem[],
  target: StitchTargetName,
  bed: string | null,
  /** A level NAME, or null for the server's default. Ignored without a bed — see below. */
  bedLevel: string | null = null,
  sound: StitchSound = {},
  /**
   * One look over every photo (server/studio/video/still.ts STILL_LOOKS), by name, or null for the
   * photos as they are. Sent only beside a photo — the server refuses a look with none to fall on.
   */
  look: string | null = null,
): Record<string, unknown> {
  // ONE thing plays underneath, and the server refuses a body that names two. The picker clears
  // one when she chooses the other; this is the second lock on the same door, so that no state the
  // UI could get into can produce a 400 she has no way to understand. A track wins, only because
  // something has to: the picker never lets both be set.
  const ownSound = !bed && sound.bedAssetId ? sound.bedAssetId : null;
  const hasSound = !!bed || !!ownSound;
  return {
    clips: items.map((item) =>
      Object.fromEntries(
        WIRE_FIELDS.filter((k) => item[k] !== undefined).map((k) => [
          k,
          item[k],
        ]),
      ),
    ),
    target,
    ...(bed ? { bed } : {}),
    ...(ownSound ? { bedAssetId: ownSound } : {}),
    // Only beside a sound: the server refuses a volume, or a start, for music she did not choose —
    // and she may well have set either and then picked "None". Zero is "from the top" and is never
    // sent, the way the server never stores it.
    ...(hasSound && bedLevel ? { bedLevel } : {}),
    ...(hasSound && sound.bedStartSec && sound.bedStartSec > 0
      ? { bedStartSec: sound.bedStartSec }
      : {}),
    ...(look && items.some(isStill) ? { look } : {}),
  };
}

/**
 * What a finished result was made FROM, as one comparable string.
 *
 * ─── WHY THE TAB NEEDS ONE ──────────────────────────────────────────────────────────────────────
 *
 * The result card stays on screen after a stitch, under a timeline she can keep editing. Without
 * this, she changes a caption, looks down, and sees a video captioned the OLD way with nothing to
 * say it is no longer what is above it. (The tab used to snapshot only the shape — `resultTarget`.)
 *
 * It IS the request body, serialised. Not a hand-picked list of fields that matter — that list is
 * exactly what #538 forgot to extend — but the same value `toStitchBody` sends, so anything that
 * changes what the server would make changes this, by construction.
 */
export const timelineSignature = (
  items: TimelineItem[],
  target: StitchTargetName,
  bed: string | null,
  bedLevel: string | null = null,
  sound: StitchSound = {},
): string => JSON.stringify(toStitchBody(items, target, bed, bedLevel, sound));
