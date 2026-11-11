/**
 * spec.ts — what a stitch job STORES, and the only door a client's timeline comes through.
 *
 * `studio_stitch_jobs.spec` is frozen at queue time for the reason `generation_jobs.brief` is: the
 * stitch that runs is the stitch that was asked for, even if her library changes underneath it
 * while the job sits on the queue. This module owns the shape of that frozen value, parses it out
 * of an untrusted body, and turns it back into the V6 engine's `StitchRequest` at run time.
 *
 * ─── WHY NO TARGET COMES OFF THE WIRE ───────────────────────────────────────────────────────────
 *
 * `StitchTarget` carries `videoCodec`, `preset`, `pixFmt` and `audioCodec`, and every one of them
 * reaches an ffmpeg argv (studio/video/plan.ts). That is NOT an injection: stitch() spawns with
 * `execFile`, so there is no shell, and a value like `libx264 -y /etc/passwd` stays ONE argv
 * element rather than splitting into three. But a client-chosen encoder is still a client-chosen
 * encoder, and the athlete has no business picking one — she is picking a SHAPE.
 *
 * So the wire carries a NAME from the allowlist below, and the stored spec carries the name too,
 * not the expansion. That is deliberate: a preset whose crf or preset string turns out to be wrong
 * can be corrected in one place afterwards, and every already-queued row picks the correction up.
 * Freezing the expansion would freeze the mistake into rows nobody can edit.
 *
 * ─── THE AUDIO BED IS A NAME TOO ────────────────────────────────────────────────────────────────
 *
 * 0057 reserved `bed` in this jsonb, so wiring it needed no migration — the column was left wide
 * for exactly this. It carries a NAME from studio/video/beds.ts for the same reason `target` does,
 * and it cannot be one of her assets at all: media_assets has no AUDIO media_type, and a bed is
 * licensed music belonging to the product rather than media belonging to her.
 *
 * ─── A CAPTION IS HER WORDS AND TWO NAMES ───────────────────────────────────────────────────────
 *
 * `clips[i].caption` is the one place free text enters this spec, and it goes no further than a PNG:
 * studio/video/captions.ts says what it may contain, captionRender.ts draws it, and ffmpeg is handed
 * an image path. Position and style are names, for the reason `target` is. The text is stored
 * NORMALISED, and the run renders the stored string as it stands — so the caption that was queued
 * is the caption that is burned in, which is the whole of "the stitch that runs is the stitch that
 * was asked for" as it applies to words.
 *
 * ─── A STILL IS A POSITION WITH A LENGTH ────────────────────────────────────────────────────────
 *
 * `clips[i].stillSec` says "this asset is one of her PHOTOGRAPHS, held for this many seconds". It is
 * a flag on the ordinary position rather than a second kind of entry, so a still inherits everything
 * a position already has — the clip cap and the timeline cap count it, a caption can sit on it, a
 * crossfade can join it — and the id is resolved through the photo predicate instead of the video
 * one (studio/video/materialize.ts). The runner turns it into a clip before the engine sees it
 * (studio/video/still.ts); the engine never learns a still existed.
 */
import {
  FOCUSED_MOTIONS,
  isFocusedMotion,
  isStillLook,
  STILL_LOOKS,
  STILL_MOTIONS,
  type StillLook,
} from "./still";
import { readStillMotion } from "./stillMotion";
import type {
  ClipOverlay,
  StitchClip,
  StitchRequest,
  StitchTarget,
} from "./types";
import type { TimelineEntry } from "./materialize";
import { composerEnabled } from "../config";
import { SHOT_SLOTS } from "../types";
import {
  BED_LEVELS,
  bedsReady,
  DEFAULT_BED_LEVEL,
  isBedLevelName,
  isBedName,
  listedBedNames,
  type BedLevelName,
  type BedName,
} from "./beds";
import {
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  CAPTION_COLORS,
  CAPTION_TEXT_RULE,
  DEFAULT_CAPTION_COLOR,
  isCaptionColor,
  isCaptionPosition,
  isCaptionStyle,
  normalizeCaptionText,
  type Caption,
} from "./captions";
import {
  CAPTION_FONTS,
  DEFAULT_CAPTION_FONT,
  fontCannotDraw,
  isCaptionFontId,
} from "../fonts/fonts";

/**
 * The shapes a stitch may be asked for. A name, never a resolution off the wire.
 *
 * 1080 on the short edge across all three: it is what the Studio's generated clips come back at and
 * what every destination surface takes, and mixing 1080 sources into a 720 target would spend an
 * encode throwing away pixels she paid for.
 */
export const STITCH_TARGETS = {
  portrait: { width: 1080, height: 1920, fps: 30 },
  square: { width: 1080, height: 1080, fps: 30 },
  landscape: { width: 1920, height: 1080, fps: 30 },
} as const satisfies Record<
  string,
  Pick<StitchTarget, "width" | "height" | "fps">
>;

export type StitchTargetName = keyof typeof STITCH_TARGETS;

export const isTargetName = (v: unknown): v is StitchTargetName =>
  typeof v === "string" &&
  Object.prototype.hasOwnProperty.call(STITCH_TARGETS, v);

/** The latest a bed may be told to start. An hour: longer than any bed, shorter than a typo. */
export const MAX_BED_START_SEC = 3600;

/** The longest crossfade a join may use. Longer than this and the shorter clip has nothing left. */
export const MAX_CROSSFADE_SEC = 2;

/**
 * How long a photograph may be held (decided 21 Sep 2026). A second is the shortest beat that reads
 * as a picture rather than a flash; eight is a long hold on a feed that scrolls. Two is what a still
 * is given when nobody says otherwise — the client's default, served through stitchLimits() so it
 * is not a second copy of the rule.
 */
export const MIN_STILL_SEC = 1;
export const MAX_STILL_SEC = 8;
export const DEFAULT_STILL_SEC = 2;

/** "1.5" not "1.5000000000000002" — for the sentences below, which quote seconds back at her. */
const secs = (n: number) => String(Number(n.toFixed(2)));

export interface SpecClip extends TimelineEntry {
  /** Absent means a cut. Stored only when it is a crossfade, so the default stays in one place. */
  crossfadeSec?: number;
  /** Absent means no words on this position. Never an empty caption — "none" has one representation. */
  caption?: Caption;
  /** True drops this clip's OWN sound. Stored only when true — absent means it plays. */
  muted?: true;
}

/** Exactly what lands in `studio_stitch_jobs.spec`. */
export interface StitchSpec {
  clips: SpecClip[];
  target: StitchTargetName;
  /** Absent means no music. Stored only when she chose one, so "no bed" has one representation. */
  bed?: BedName;
  /**
   * One of HER OWN videos, whose sound is laid under the programme instead of a curated track.
   *
   * An ASSET ID and nothing else — never a path or a url, for the reason `clips[].assetId` is one:
   * it is resolved at run time against the athlete on the job row (studio/video/materialize.ts
   * `resolveClips`), so a stored spec cannot point at anything that is not hers. Mutually exclusive
   * with `bed`: two answers to "what plays underneath" is a request nobody can honour.
   *
   * Unlike `bed` it does NOT wait on STUDIO_STITCH_BEDS_READY. That flag says the PRODUCT's tracks
   * are installed; her own video is already in her library.
   */
  bedAssetId?: string;
  /**
   * Seconds into the sound to START from — a curated track or her own video alike. Absent means
   * the beginning; 0 is never stored. The only "crop" a bed has: it always ends when the video
   * does, so where it starts is the one thing there is to choose.
   */
  bedStartSec?: number;
  /** Absent means medium. Stored only when it is NOT, and only beside a bed. See beds.ts. */
  bedLevel?: Exclude<BedLevelName, typeof DEFAULT_BED_LEVEL>;
  /**
   * One grade across every PHOTO in the timeline (A3) — a NAME from studio/video/still.ts, each
   * photo corrected from its own pixels and then given the look. Absent means every photo exactly
   * as it is, as before. Refused on a timeline with no photo: it would silently do nothing.
   */
  look?: StillLook;
  /**
   * WHY the Board joined and dropped what it did (PR 15.1, R-4, docs/probes/composer-boundary.md) — a
   * RECORD, never an instruction: nothing in it reaches ffmpeg, and the runner does not read it.
   * Present only with STUDIO_COMPOSER on and only from the Board; absent everywhere else.
   */
  composer?: ComposerRecord;
}

// ─── The composer's record (PR 15.1) ────────────────────────────────────────────────────────────
//
// The Board's join rule (client/screens/studio/joinLogic.ts) and its dropped-slot reasons
// (storyboardLogic.ts `DroppedSlotReason`) are closed sets on the client. They are copied here as
// closed sets, and a test drives the client's `chooseJoin` through every branch and parses each
// answer, so the two lists cannot drift apart unseen. A value outside them is a 400 by field — the
// house rule for every closed set on this door (D-1) — never a silent drop.

/** client/screens/studio/joinLogic.ts `JoinReason`. */
export const JOIN_REASONS = [
  "position-0",
  "her-cut",
  "bridge-edge",
  "after-own-bridge",
  "continuation",
  "on-beat",
  "rhythm-fast",
  "rhythm-slow",
  "default-fade",
] as const;
export type JoinReason = (typeof JOIN_REASONS)[number];

/** client/screens/studio/storyboardLogic.ts `DroppedSlotReason`. */
export const DROPPED_SLOT_REASONS = [
  "photo-decides",
  "in-her-sentence",
  "nothing-filmed",
] as const;
export type DroppedSlotReason = (typeof DROPPED_SLOT_REASONS)[number];

type SlotName = keyof typeof SHOT_SLOTS;

export interface ComposerRecord {
  /** `joins[i]` is the join INTO `clips[i]` — the index is the join key. `key` is the Board's position key. */
  joins: { key: string; kind: "cut" | "fade"; reason: JoinReason }[];
  /** Every slot a Board row could not carry, with why. `row` is the Board row key (`agent:<nonce>:<item>`). */
  dropped: {
    row: string;
    slot: SlotName;
    value: string;
    reason: DroppedSlotReason;
  }[];
  /** The plan the Board came from — checked as hers by the route before a row exists. */
  planId?: string;
}

/**
 * A Board key: `agent:<uuid>:<n>:clip`, `text:<ms>:still`, `passthrough:<uuid>` and the like. Bounded
 * and closed, because it is stored.
 */
const RECORD_KEY_RE = /^[A-Za-z0-9:_-]{1,160}$/;
/** More than a Board can drop: MAX_ROWS rows × six slots, with room. */
const MAX_DROPPED = 120;

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

/** The record off the wire, rebuilt from known fields, or which field is wrong. */
function parseComposerRecord(
  raw: unknown,
  clipCount: number,
): ComposerRecord | SpecRefusal {
  const at = "composer";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: "The composer's record is an object", field: at };
  const r = raw as Record<string, unknown>;

  // ⚠️ ONE PER POSITION, OR THE INDEX IS NOT A JOIN KEY. A record that is short or long cannot be
  // lined up with `clips`, and a record that cannot be lined up is not a record.
  if (!Array.isArray(r.joins) || r.joins.length !== clipCount)
    return {
      error: `The composer's record needs one join per clip (${clipCount})`,
      field: `${at}.joins`,
    };
  const joins: ComposerRecord["joins"] = [];
  for (const [i, j] of r.joins.entries()) {
    const f = `${at}.joins[${i}]`;
    const o = (j ?? {}) as Record<string, unknown>;
    if (typeof o.key !== "string" || !RECORD_KEY_RE.test(o.key))
      return { error: "That isn't a Board position", field: `${f}.key` };
    if (o.kind !== "cut" && o.kind !== "fade")
      return { error: "A join is a cut or a fade", field: `${f}.kind` };
    // ⚠️ MUTATION (spec.test): accept any string here — "a join reason outside the closed set is
    // stored" reds by name.
    if (!isOneOf(JOIN_REASONS, o.reason))
      return {
        error: `A join's reason is one of: ${JOIN_REASONS.join(", ")}`,
        field: `${f}.reason`,
      };
    joins.push({ key: o.key, kind: o.kind, reason: o.reason });
  }

  if (!Array.isArray(r.dropped) || r.dropped.length > MAX_DROPPED)
    return {
      error: `The composer's dropped slots are a list of up to ${MAX_DROPPED}`,
      field: `${at}.dropped`,
    };
  const dropped: ComposerRecord["dropped"] = [];
  for (const [i, d] of r.dropped.entries()) {
    const f = `${at}.dropped[${i}]`;
    const o = (d ?? {}) as Record<string, unknown>;
    if (typeof o.row !== "string" || !RECORD_KEY_RE.test(o.row))
      return { error: "That isn't a Board row", field: `${f}.row` };
    if (!isOneOf(Object.keys(SHOT_SLOTS) as SlotName[], o.slot))
      return {
        error: `A slot is one of: ${Object.keys(SHOT_SLOTS).join(", ")}`,
        field: `${f}.slot`,
      };
    const values = SHOT_SLOTS[o.slot] as readonly string[];
    if (!isOneOf(values, o.value))
      return {
        error: `A ${o.slot} is one of: ${values.join(", ")}`,
        field: `${f}.value`,
      };
    if (!isOneOf(DROPPED_SLOT_REASONS, o.reason))
      return {
        error: `A dropped slot's reason is one of: ${DROPPED_SLOT_REASONS.join(", ")}`,
        field: `${f}.reason`,
      };
    dropped.push({
      row: o.row,
      slot: o.slot,
      value: o.value,
      reason: o.reason,
    });
  }

  if (r.planId !== undefined && r.planId !== null) {
    if (typeof r.planId !== "string" || !UUID_RE.test(r.planId))
      return { error: "That isn't a plan", field: `${at}.planId` };
    return { joins, dropped, planId: r.planId.toLowerCase() };
  }
  return { joins, dropped };
}

export interface SpecRefusal {
  error: string;
  field: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A finite, non-negative number — rejects NaN, Infinity, "3", null and every other near-miss. */
const isSeconds = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * One caption off the wire, or which of its fields is wrong.
 *
 * Exported because TWO doors take a caption — the queue, and the preview that draws it for her
 * before she queues — and they must agree exactly: a caption the preview will draw and the queue
 * will refuse (or the reverse) is the worst kind of disagreement, because she only finds out after
 * she has committed to it. One function, so there is one rule.
 */
export function parseCaption(raw: unknown, at: string): Caption | SpecRefusal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: CAPTION_TEXT_RULE, field: at };
  }
  const cap = raw as Record<string, unknown>;
  // Names first: an unknown one is refused by name and NEVER defaulted. A caption that lands in
  // some position she did not pick looks like it worked.
  if (!isCaptionPosition(cap.position)) {
    return {
      error: `A caption sits at one of: ${Object.keys(CAPTION_POSITIONS).join(", ")}`,
      field: `${at}.position`,
    };
  }
  if (!isCaptionStyle(cap.style)) {
    return {
      error: `A caption's style is one of: ${Object.keys(CAPTION_STYLES).join(", ")}`,
      field: `${at}.style`,
    };
  }
  const text = normalizeCaptionText(cap.text);
  if (text === null) {
    return { error: CAPTION_TEXT_RULE, field: `${at}.text` };
  }
  // null is "the default", the same as absent. Anything else has to be one of the names.
  if (
    cap.color !== undefined &&
    cap.color !== null &&
    !isCaptionColor(cap.color)
  ) {
    return {
      error: `A caption's colour is one of: ${Object.keys(CAPTION_COLORS).join(", ")}`,
      field: `${at}.color`,
    };
  }
  // The font (PR 8): a name or nothing, and never defaulted from a wrong one.
  if (
    cap.font !== undefined &&
    cap.font !== null &&
    !isCaptionFontId(cap.font)
  ) {
    return {
      error: `A caption's font is one of: ${Object.keys(CAPTION_FONTS).join(", ")}`,
      field: `${at}.font`,
    };
  }
  const font = isCaptionFontId(cap.font) ? cap.font : DEFAULT_CAPTION_FONT;
  // Her words in THIS font: a character it would draw as a box is refused by name.
  const missing = fontCannotDraw(font, text);
  if (missing.length > 0) {
    return {
      error: `${CAPTION_FONTS[font].family} can't draw ${missing.join(" ")} — change ${missing.length === 1 ? "it" : "them"} or pick another font`,
      field: `${at}.text`,
    };
  }
  // Rebuilt from the known fields, so nothing else a body put inside `caption` is stored.
  const caption: Caption = { text, position: cap.position, style: cap.style };
  // White is never stored: absent already means it.
  if (isCaptionColor(cap.color) && cap.color !== DEFAULT_CAPTION_COLOR) {
    caption.color = cap.color;
  }
  // Nor is Outfit.
  if (font !== DEFAULT_CAPTION_FONT) caption.font = font;
  return caption;
}

/**
 * Parse an untrusted body into a spec, or say which field is wrong.
 *
 * Deliberately NOT a schema library: the repo has no runtime validator and adding one is a
 * dependency decision that is not this build's to make. Every refusal names a field, because the
 * assembly UI has to be able to point at the clip that is wrong.
 *
 * What this does NOT check: whether the ids exist, whether they are hers, whether they are videos,
 * or whether the timeline fits the memory budget. All four need the database and all four live in
 * studio/video/materialize.ts, which the route calls next with the athlete off the request.
 */
export function parseStitchSpec(
  body: unknown,
  /**
   * Whether a bed must be INSTALLED for this spec to be acceptable.
   *
   * ⚠️  TRUE AT THE DOOR, FALSE FOR A STORED ROW, and the difference is not a nicety. Availability
   * is a fact about the world at this instant, not a property of the spec: a timeline queued while
   * music was available is still a perfectly valid timeline after the bed object is pulled. If the
   * run-time re-parse applied this check, that job would FAIL on its soundtrack — and the runner's
   * downgrade to a silent clip, which is the correct answer, would be unreachable.
   *
   * The SHAPE check is identical in both directions, which is the property that matters: a row
   * that could not be queued today still cannot be run today.
   */
  requireBedAvailable = true,
  /**
   * Whether the composer's record is read (PR 15.1, D-3). OFF — STUDIO_COMPOSER off — it is ignored
   * exactly as any unknown key always was, so the stored spec is byte-identical to before. The runner's
   * re-parse passes false: it never reads the record, and a record must never fail a job she waits on.
   * ⚠️ MUTATION (composerBoundary.test): parse it regardless — "composer changes an artifact with
   * STUDIO_COMPOSER off" reds by name.
   */
  composer: boolean = composerEnabled(),
): StitchSpec | SpecRefusal {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isTargetName(b.target)) {
    return {
      error: `A stitch needs a shape: ${Object.keys(STITCH_TARGETS).join(", ")}`,
      field: "target",
    };
  }
  if (!Array.isArray(b.clips) || b.clips.length === 0) {
    return { error: "A stitch needs at least one clip", field: "clips" };
  }

  const clips: SpecClip[] = [];
  for (const [i, raw] of b.clips.entries()) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const at = `clips[${i}]`;

    if (typeof c.assetId !== "string" || !UUID_RE.test(c.assetId)) {
      return { error: "That isn't a clip we can join", field: `${at}.assetId` };
    }

    const clip: SpecClip = { assetId: c.assetId };

    if (c.trimStartSec !== undefined) {
      if (!isSeconds(c.trimStartSec)) {
        return {
          error: "A trim has to be a number of seconds",
          field: `${at}.trimStartSec`,
        };
      }
      clip.trimStartSec = c.trimStartSec;
    }
    if (c.trimEndSec !== undefined) {
      if (!isSeconds(c.trimEndSec)) {
        return {
          error: "A trim has to be a number of seconds",
          field: `${at}.trimEndSec`,
        };
      }
      clip.trimEndSec = c.trimEndSec;
    }
    // Checked as a PAIR, after both are known to be numbers — an end at or before its start is a
    // zero-or-negative span, which reaches ffmpeg as a filter graph that cannot be built.
    if (
      clip.trimEndSec !== undefined &&
      clip.trimEndSec <= (clip.trimStartSec ?? 0)
    ) {
      return {
        error: "A clip has to end after it starts",
        field: `${at}.trimEndSec`,
      };
    }

    if (c.crossfadeSec !== undefined) {
      // A crossfade on clip 0 has nothing to fade FROM. V6 ignores transitionIn there; refusing it
      // here instead means the stored spec never contains an instruction that silently does nothing.
      if (i === 0) {
        return {
          error: "The first clip has nothing to fade from",
          field: `${at}.crossfadeSec`,
        };
      }
      if (
        !isSeconds(c.crossfadeSec) ||
        c.crossfadeSec <= 0 ||
        c.crossfadeSec > MAX_CROSSFADE_SEC
      ) {
        return {
          error: `A crossfade has to be between 0 and ${MAX_CROSSFADE_SEC} seconds`,
          field: `${at}.crossfadeSec`,
        };
      }
      clip.crossfadeSec = c.crossfadeSec;
    }

    // A boolean and nothing else. `false` and absent are the same thing and only `true` is stored;
    // "yes"/1/"true" are refused rather than coerced — a control that mutes on a string it was
    // never meant to get is a control that mutes by accident.
    if (c.muted !== undefined && c.muted !== null) {
      if (typeof c.muted !== "boolean") {
        return {
          error: "Muting a clip is on or off",
          field: `${at}.muted`,
        };
      }
      if (c.muted) clip.muted = true;
    }

    // null is "no caption", the same as absent — the client clears one by dropping it, and a body
    // that spells the absence out is not an error.
    if (c.caption !== undefined && c.caption !== null) {
      const caption = parseCaption(c.caption, `${at}.caption`);
      if ("error" in caption) return caption;
      clip.caption = caption;
    }

    // A STILL: the id is a photograph, held for this long. null is "not a still", like absent.
    if (c.stillSec !== undefined && c.stillSec !== null) {
      if (
        !isSeconds(c.stillSec) ||
        c.stillSec < MIN_STILL_SEC ||
        c.stillSec > MAX_STILL_SEC
      ) {
        return {
          error: `A photo can be held for ${MIN_STILL_SEC} to ${MAX_STILL_SEC} seconds`,
          field: `${at}.stillSec`,
        };
      }
      // Instructions that would silently do nothing are refused, never stored — the rule a crossfade
      // on clip 0 and a volume with no music already follow. A photo has no footage to trim and no
      // sound to mute; how long it is held IS its length.
      if (clip.trimStartSec !== undefined || clip.trimEndSec !== undefined) {
        return {
          error:
            "A photo has no footage to trim — choose how long it's held instead",
          field: `${at}.${clip.trimStartSec !== undefined ? "trimStartSec" : "trimEndSec"}`,
        };
      }
      if (clip.muted) {
        return { error: "A photo has no sound to mute", field: `${at}.muted` };
      }
      clip.stillSec = c.stillSec;
    }

    // HOW A STILL MOVES (D2, A1, PR 6's names): dolly | zoom | sweep | punch — a stored or older "pan"
    // is read as dolly (./stillMotion) — and only on a still — a clip has its own
    // motion, so a push-in on one is an instruction that would silently do nothing, refused like a
    // trim on a photo. null is "dead still", the same as absent.
    if (c.stillMotion !== undefined && c.stillMotion !== null) {
      if (clip.stillSec === undefined) {
        return {
          error:
            "Only a held photo can be pushed into — a clip has its own motion",
          field: `${at}.stillMotion`,
        };
      }
      const motion = readStillMotion(c.stillMotion);
      if (motion === null) {
        return {
          error: `A photo can move one of these ways: ${STILL_MOTIONS.join(", ")}`,
          field: `${at}.stillMotion`,
        };
      }
      clip.stillMotion = motion;
    }

    // WHERE A MOVE HEADS (A1): a point in the upright photo, fractions 0..1 — only beside a motion
    // that goes somewhere (zoom, sweep, punch). Beside a push-in or a dead still it would silently do
    // nothing, so it is refused like a trim on a photo. null is "the photo's own point", like absent.
    if (c.stillFocus !== undefined && c.stillFocus !== null) {
      if (!isFocusedMotion(clip.stillMotion)) {
        return {
          error: `Only a photo that moves toward something has a point to move to — ${FOCUSED_MOTIONS.join(", ")}`,
          field: `${at}.stillFocus`,
        };
      }
      const f = c.stillFocus as Record<string, unknown>;
      const frac = (v: unknown): v is number => isSeconds(v) && v <= 1;
      if (
        typeof c.stillFocus !== "object" ||
        Array.isArray(c.stillFocus) ||
        !frac(f.x) ||
        !frac(f.y)
      ) {
        return {
          error: "A point on a photo is two fractions, x and y, from 0 to 1",
          field: `${at}.stillFocus`,
        };
      }
      // Rebuilt from the two numbers, so nothing else a body put inside it is stored.
      clip.stillFocus = { x: f.x, y: f.y };
    }

    clips.push(clip);
  }

  // ─── A STILL NEEDS A MOMENT OF ITS OWN ─────────────────────────────────────────────────────────
  //
  // The fades on either side of a still both eat into it. Checked HERE because a still's length is
  // known at the door, where a clip's is not: the engine throws on a fade at least as long as the
  // segment it enters (plan.ts, "does not fit"), and that throw reaches her as the runner's generic
  // "couldn't put that timeline together". Requiring the two fades to add up to LESS than the hold
  // covers both of the engine's conditions for a still and one it does not check — a photo that
  // fades in and straight back out is never on screen alone.
  for (const [i, clip] of clips.entries()) {
    if (clip.stillSec === undefined) continue;
    const fadeIn = clip.crossfadeSec ?? 0;
    const fadeOut = clips[i + 1]?.crossfadeSec ?? 0;
    if (fadeIn + fadeOut >= clip.stillSec) {
      return {
        error: `This photo is held for ${secs(clip.stillSec)}s and its fades take ${secs(fadeIn + fadeOut)}s — hold it longer or shorten a fade`,
        field:
          fadeOut > 0
            ? `clips[${i + 1}].crossfadeSec`
            : `clips[${i}].crossfadeSec`,
      };
    }
  }

  // THE LOOK (A3): a name, only when there is a photo for it to apply to.
  let look: StillLook | undefined;
  if (b.look !== undefined && b.look !== null) {
    if (!isStillLook(b.look)) {
      return {
        error: `A look is one of: ${STILL_LOOKS.join(", ")}`,
        field: "look",
      };
    }
    if (!clips.some((c) => c.stillSec !== undefined)) {
      return {
        error: "A look is laid over photos — this timeline has none",
        field: "look",
      };
    }
    look = b.look;
  }
  // THE COMPOSER'S RECORD (PR 15.1): read only with the flag, checked against `clips` it lines up with.
  let record: ComposerRecord | undefined;
  if (composer && b.composer !== undefined && b.composer !== null) {
    const parsed = parseComposerRecord(b.composer, clips.length);
    if ("error" in parsed) return parsed;
    record = parsed;
  }
  const withLook = <T extends StitchSpec>(spec: T): T => ({
    ...spec,
    ...(look ? { look } : {}),
    ...(record ? { composer: record } : {}),
  });

  const hasTrack = b.bed !== undefined && b.bed !== null;
  const hasOwnSound = b.bedAssetId !== undefined && b.bedAssetId !== null;

  // ONE thing plays underneath. Refused rather than resolved by picking one: whichever we picked,
  // the video she gets back would not be the one she asked for, and she could not tell why.
  if (hasTrack && hasOwnSound) {
    return {
      error: "Choose a track or the sound from one of your videos — not both",
      field: "bedAssetId",
    };
  }
  if (hasOwnSound) {
    if (typeof b.bedAssetId !== "string" || !UUID_RE.test(b.bedAssetId)) {
      return {
        error: "That isn't a video we can take the sound from",
        field: "bedAssetId",
      };
    }
  }

  // Where the sound starts. A NUMBER, like a trim — it is her intent about time, not an encoder
  // parameter — and bounded like one: finite, not negative, and not past the hour (no bed is longer,
  // and an absurd value is a typo or a probe, not a choice).
  if (b.bedStartSec !== undefined && b.bedStartSec !== null) {
    if (!isSeconds(b.bedStartSec) || b.bedStartSec > MAX_BED_START_SEC) {
      return {
        error: "Where the music starts has to be a number of seconds",
        field: "bedStartSec",
      };
    }
    if (!hasTrack && !hasOwnSound) {
      return {
        error: "There's no music on this one to choose a start for",
        field: "bedStartSec",
      };
    }
  }

  // A level is a NAME, checked whether or not there is music for it to apply to — an unknown one is
  // refused by name and never defaulted, the same as every other closed set here.
  if (b.bedLevel !== undefined && b.bedLevel !== null) {
    if (!isBedLevelName(b.bedLevel)) {
      return {
        error: `Music can be one of: ${Object.keys(BED_LEVELS).join(", ")}`,
        field: "bedLevel",
      };
    }
    if (!hasTrack && !hasOwnSound) {
      // A volume for music she did not choose is an instruction that silently does nothing — the
      // same reason a crossfade on clip 0 is refused rather than stored.
      return {
        error: "There's no music on this one to set the volume of",
        field: "bedLevel",
      };
    }
  }

  if (b.bed !== undefined && b.bed !== null) {
    if (!isBedName(b.bed)) {
      return {
        // The names she can PICK — an unlisted bed still parses, and is not something to offer.
        error: `That isn't one of the tracks we have: ${listedBedNames().join(", ")}`,
        field: "bed",
      };
    }
    // Refused AT THE DOOR rather than three minutes into a job she is waiting on. The bytes are
    // installed by hand (see beds.ts), so until they are, asking for a bed is a 400 and not a
    // stitch that fails late with a 404 from storage.
    //
    // NOT applied to a stored row — see `requireBedAvailable`. Availability is a fact about now,
    // not about the spec, and checking it on the re-parse would fail a queued job over its
    // soundtrack instead of letting the runner downgrade to a silent clip.
    if (requireBedAvailable && !bedsReady()) {
      return {
        error:
          "Music isn't available yet — this one will be put together without it.",
        field: "bed",
      };
    }
    const spec: StitchSpec = { clips, target: b.target, bed: b.bed };
    // Medium is never stored: absent already means it, and two spellings of the default is how a
    // later reader ends up checking for one and missing the other.
    if (isBedLevelName(b.bedLevel) && b.bedLevel !== DEFAULT_BED_LEVEL) {
      spec.bedLevel = b.bedLevel;
    }
    // Zero is never stored: absent already means "from the beginning".
    if (isSeconds(b.bedStartSec) && b.bedStartSec > 0) {
      spec.bedStartSec = b.bedStartSec;
    }
    return withLook(spec);
  }

  if (hasOwnSound) {
    // Whether it EXISTS, is HERS, is a video and has any sound are all questions for the database
    // and the file — materialize.ts and the runner — exactly as they are for a clip.
    const spec: StitchSpec = {
      clips,
      target: b.target,
      bedAssetId: b.bedAssetId as string,
    };
    if (isBedLevelName(b.bedLevel) && b.bedLevel !== DEFAULT_BED_LEVEL) {
      spec.bedLevel = b.bedLevel;
    }
    // Zero is never stored: absent already means "from the beginning".
    if (isSeconds(b.bedStartSec) && b.bedStartSec > 0) {
      spec.bedStartSec = b.bedStartSec;
    }
    return withLook(spec);
  }

  return withLook({ clips, target: b.target });
}

export const isRefusal = (v: StitchSpec | SpecRefusal): v is SpecRefusal =>
  "error" in v;

/**
 * Re-read a spec off a job row.
 *
 * A stored row is not trusted any more than a request body: it is jsonb, it is old, and the parser
 * it went in through may have been a different one. Same function, so a row whose SHAPE could not
 * be queued today cannot be run today either.
 *
 * The one difference is bed AVAILABILITY, and it is deliberate — see `requireBedAvailable` above.
 * Whether the bytes are installed right now says nothing about whether this timeline is valid, and
 * treating it as a validity question turns a missing soundtrack into a failed job.
 */
export function readStoredSpec(spec: unknown): StitchSpec | SpecRefusal {
  return parseStitchSpec(spec, false, false);
}

/**
 * Spec + materialized workspace → the V6 engine's request.
 *
 * The paths come from the WORKSPACE MAP, keyed by asset id — never from anything in the spec. That
 * is the whole reason the spec stores ids: a path in a job row would be a durable file-read
 * primitive pointed at whatever a client once wrote there.
 */
export function toStitchRequest(
  spec: StitchSpec,
  paths: Map<string, string>,
  outputPath: string,
  timeoutMs?: number,
  /** The bed's LOCAL path, from the workspace — never anything off the spec. */
  bedPath?: string | null,
  /**
   * Each captioned position's drawn band, keyed by POSITION — not by asset id, because the same
   * clip may sit on the timeline twice with different words on it.
   */
  overlays?: ReadonlyMap<number, ClipOverlay>,
  /**
   * Each still position's ENCODED CLIP, keyed by position — never the photo, and never anything off
   * the spec. The runner makes these (studio/video/still.ts) before the engine runs, so to the
   * engine a still is one more local mp4.
   */
  stills?: ReadonlyMap<number, string>,
): StitchRequest {
  if (spec.bedAssetId && !bedPath) {
    // HER pick, so its absence is never a quiet downgrade. A curated track that went missing is
    // ours to apologise for and the stitch goes ahead without it (see the runner); a video she
    // chose for its sound and did not get is a different video from the one she asked for,
    // delivered as a success. The same rule a missing clip and a missing caption follow.
    throw new Error(
      "No sound file for the video this timeline takes its sound from",
    );
  }

  const clips: StitchClip[] = spec.clips.map((c, i) => {
    const source =
      c.stillSec === undefined ? paths.get(c.assetId) : stills?.get(i);
    if (!source) {
      // Unreachable through the runner, which materializes every id in the spec first and encodes
      // every still. A throw rather than a skip: a stitch that silently drops a clip is worse than
      // one that refuses — and a PHOTO's path is never looked up as a clip's, or the engine would
      // be handed a JPEG to probe for a duration it does not have.
      throw new Error(
        c.stillSec === undefined
          ? `No materialized file for clip ${c.assetId}`
          : `No encoded still for position ${i}`,
      );
    }
    const overlay = overlays?.get(i);
    if (c.caption && !overlay) {
      // The same rule as the clip above, for the same reason. The spec she queued says these words
      // are on this clip; a stitch that comes back without them is a DIFFERENT video from the one
      // she asked for, delivered as a success. Refusing is the only honest outcome.
      throw new Error(`No drawn caption for clip ${i}, which has one`);
    }
    return {
      source,
      ...(c.trimStartSec === undefined ? {} : { trimStartSec: c.trimStartSec }),
      ...(c.trimEndSec === undefined ? {} : { trimEndSec: c.trimEndSec }),
      transitionIn:
        c.crossfadeSec === undefined
          ? { kind: "cut" }
          : { kind: "crossfade", durationSec: c.crossfadeSec },
      ...(c.muted ? { muted: true } : {}),
      // Only for a position whose SPEC has a caption. An overlay handed in for one that does not is
      // ignored: the frozen spec decides what is on the video, and nothing else can add to it.
      ...(c.caption && overlay ? { overlay } : {}),
    };
  });

  return {
    clips,
    outputPath,
    target: { ...STITCH_TARGETS[spec.target] },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    // The level is a NAME off the spec, expanded here (beds.ts BED_LEVELS) — and OMITTED for
    // medium, so the engine's own default (plan.ts DEFAULT_BED.level, 0.25) still decides it.
    //
    // `duck: {}` ASKS for the engine's default duck (plan.ts DEFAULT_BED.duck), always. This used
    // to pass none, so the bed was mixed FLAT over whatever a clip said (ledger D4) — inaudible only
    // while every clip was silent. plan.ts emits the sidechain only when a clip actually SOUNDS, so
    // a stitch of silent clips is the same graph it was before this line existed.
    ...(bedPath
      ? {
          audioBed: {
            source: bedPath,
            duck: {},
            ...(spec.bedLevel ? { level: BED_LEVELS[spec.bedLevel].gain } : {}),
            ...(spec.bedStartSec ? { startSec: spec.bedStartSec } : {}),
          },
        }
      : {}),
  };
}
