/**
 * storyboardLogic — a board of stills, as arithmetic and rules.
 *
 * ─── WHAT A BOARD IS ────────────────────────────────────────────────────────────────────────────
 *
 * An ordered list of her photographs, each with a sentence and a SHOT KIND. Every row becomes one
 * generated clip; consecutive clips are joined by a free crossfade unless she asks for a generated
 * bridge. The clips then land in the same pool the Video tab reads, and the timeline takes over.
 *
 * ⚠️ IT OWNS NO TRANSITIONS. Cut / Fade / Bridge already exist per join on the timeline (video V10
 * card 2), so a board's job ends at "here are the clips, in this order, with these joins asked for".
 * Building a second transition model here would be two places that can disagree about what happens
 * between two clips.
 *
 * ─── WHY THIS IS PURE ───────────────────────────────────────────────────────────────────────────
 *
 * Everything is a function of its arguments. No React, no fetch, no server, and — the one that
 * matters — NO PRICE TABLE. Same reason `videoEntryLogic` and `stitchLogic` are pure: jest's roots
 * include client/ but only for suites with no renderer, so the rules that decide what she is charged
 * are only testable if they never arrive through react-native.
 *
 * ─── ⚠️  IT NEVER COMPUTES A PRICE. IT SUMS QUOTES IT IS HANDED. ────────────────────────────────
 *
 * Pricing lives in `server/studio/config.ts`, and the only honest per-row figure is the one that
 * model's own preview returned. A price table on this side would be a SECOND SOURCE OF TRUTH FOR
 * MONEY, and the first time it drifted she would approve one number and be billed another. The same
 * rule `StitchLimits` states for the timeline: what the server told us, never hardcoded here.
 */
import type {
  StudioObjective,
  StudioShotSlot,
  StudioShotSpec,
} from "../../hooks/use-studio";
import {
  LEGACY_SHOT_SLOT_VALUES,
  SHOT_SLOT_VALUES,
} from "../../lib/shotSlotValues";
import { takesFocus, type StillMotionName } from "./stitchLogic";

/**
 * What KIND of shot a row is — her words, not ours and not a model's.
 *
 * ⚠️ THIS IS NOT A MODEL PICKER, and `shotType.ts`'s decision is intact. It says a user picker is
 * wrong because "she is choosing a SHOT, not a model; `seedance-2.0-fast` is not a decision anybody
 * outside this repo should have to make". Both of these are shots. The router still resolves the
 * model from the references and the last frame, exactly as it did; a row's kind decides what the
 * clip IS, and the routing follows from that rather than being named by her.
 *
 *   broll    a scene with nobody in it, made from WORDS — no photo (b-roll t2v, 21 Sep 2026)
 *   motion   her, moving slightly — "slight movements" on the surface
 *   product  her product — or any object, nobody in it — from its photo, brought to life. The
 *            image-to-video object shot: the same request a photo-bearing b-roll row used to make
 *            (role `object`, seedance), under its own name, because "B-roll" now means words. Found
 *            on device 22 Sep 2026: a product pick seeded as "B-roll" with a photo attached, which
 *            post-t2v is a contradiction on the row.
 *   still    one of her photos, HELD for a few seconds — nothing is generated. It costs $0, is never
 *            quoted or admitted, and joins the stitch at its row (C1b). It is in this union rather
 *            than a flag on the row so that every `Record<ShotKind, …>` in the surface has to say
 *            what it does with one — the compiler finds the sites, not a reviewer.
 *   clip     one of her own VIDEOS, used as it is or cut to one of its beats — nothing is generated
 *            (C2 Half B). $0 like a still, never quoted or admitted, and it joins the stitch at its
 *            row as an ordinary video position with a trim window. Its sound is its OWN: `audio`
 *            on a clip row keeps it, absent mutes it, free either way. In the union for the same
 *            reason as `still` — the compiler walks the sites.
 */
export type ShotKind = "broll" | "motion" | "product" | "still" | "clip";

/** A row that generates nothing — one of her photos, held. */
export const isStillRow = (row: StoryboardRow | undefined): boolean =>
  row?.kind === "still";

/** A row that generates nothing — one of her own clips, placed. */
export const isClipRow = (row: StoryboardRow | undefined): boolean =>
  row?.kind === "clip";

/**
 * A row that asks for nothing: a still or a clip. Everything downstream of a request — the quote,
 * admission, the run, the redo — reads this, so a new $0 kind lands in one place.
 */
export const isHeldRow = (row: StoryboardRow | undefined): boolean =>
  isStillRow(row) || isClipRow(row);

export interface StoryboardRow {
  /** Stable across reorder and edits. Never the asset id — one still may appear twice. */
  key: string;
  /**
   * ⚠️ NULL IS A REAL ROW, NOT AN UNFINISHED ONE — a shot with no photograph, made from her sentence
   * alone. Text-to-video: no references travel, `shotTypeFor` sees none, and it routes to seedance
   * at the same price as an i2v b-roll (seedance bills `w x h x frames / 1024`, and an input image
   * is not a term in that — measured, and pinned by a test that asserts the two are equal).
   */
  assetId: string | null;
  thumbUrl: string | null;
  /** Her sentence for this shot. Empty is incomplete, not an error — see `boardGaps`. */
  prompt: string;
  kind: ShotKind;
  /**
   * This still carries HER.
   *
   * Passed in rather than derived: the tray knows what she tagged, and this module must not start
   * guessing at a photograph. It is the input to the one guard below that can refuse a kind.
   *
   * Meaningless on an image-less row, where there is no photograph to carry anyone.
   */
  hasPerson: boolean;
  /**
   * She asked for a GENERATED bridge into this row, and nothing has been generated or billed.
   *
   * Same field name, same meaning and the same invariant as `stitchLogic.TimelineItem`, so the
   * handoff to the timeline renames nothing: a bridge arrives AT a position, and position 0 can
   * never hold one because there is nothing before it to come from.
   */
  bridgeRequested?: boolean;
  /**
   * The shot slots she set on this row — chips, not words. Absent when none is set; never `{}`.
   *
   * Only slots `slotsAllowed` permits for this row can be here: `setShotSlot` refuses the rest, and
   * `clipRequestFor` filters again before anything travels.
   */
  shot?: StudioShotSpec;
  /**
   * Sound on this shot. `true` or ABSENT — never `false`, so "off" and "made before this existed"
   * are the same row, exactly as `bridgeRequested` is.
   *
   * ⚠️ IT IS A PRICE ON A PERSON ROW. That shot is Veo, whose audio SKU is DOUBLE the silent rate,
   * so it has to be picked before the quote she approves — which is why it is in `rowSignature`
   * below. On a b-roll row it is free: seedance is token-priced with no audio arm at all.
   */
  audio?: true;
  /**
   * How long a `still` row is held, in seconds — present on a still row and on no other. Bounded by
   * the server (`stitchLimits().minStillSec … maxStillSec`, 1–8 s), and clamped to those bounds by
   * `setStillSec`. It travels ONLY in the stitch body (`TimelineItem.stillSec`), never in a preview
   * request, which is why it is out of `rowSignature` and in `boardWorkSignature`.
   */
  stillSec?: number;
  /**
   * A `still` row's push-in — "dolly", a slow zoom over its hold (server/studio/video/still.ts) — or
   * absent for dead still. $0 like the hold, and travels exactly as the hold does: only in the
   * stitch body (`TimelineItem.stillMotion`), never in a request, so out of `rowSignature` and in
   * `boardWorkSignature`. On a still row and no other (`setStillMotion`).
   */
  stillMotion?: StillMotionName;
  /**
   * Where a `still` row's zoom, sweep or punch heads — her tap on the photo, fractions 0..1 of it as
   * she sees it — or absent for the server's framing prior (the upper middle). Travels like
   * the motion: only in the stitch body, so out of `rowSignature` and in `boardWorkSignature`. Only
   * beside a motion that `takesFocus`; `setStillMotion` drops it when the motion changes to one that
   * does not, because the server refuses a point it would ignore.
   */
  stillFocus?: { x: number; y: number };
  /**
   * A `clip` row's window of its source, in seconds — present on a clip row cut to a beat, absent
   * for the whole clip, and on no other kind. Absolute in the source (stitchLogic `TimelineItem`).
   * Never in a request, so out of `rowSignature`; an edit, so in `boardWorkSignature`.
   */
  clipTrim?: { startSec: number; endSec: number };
  /** A `clip` row's measured length, or absent when unmeasured. Display and the stitch's own arithmetic. */
  clipSec?: number;
  /**
   * A `clip` row's mp4, signed, so the row can PLAY its window on the Board (enrichment fixes,
   * 22 Sep 2026). Display only: in neither signature — no request reads it and it is not an edit.
   * Absent on a row seeded before it existed, and the row then shows its poster and cannot play.
   */
  videoUrl?: string;
  /**
   * The join INTO this row is a CUT rather than the free crossfade. `true` or ABSENT, like
   * `bridgeRequested`, and meaningful only beside a still (this row or the one before it) — the
   * only joins the Board lets her choose Cut on, because a still is never bridged. `normalizeBoard`
   * strips it anywhere else. Never in a request, so never in `rowSignature`; it is an edit, so it is
   * in `boardWorkSignature`.
   */
  cutIn?: true;
  /**
   * Why the plan put this row here, in her words (agentLogic `reasonWords`, PR 6) — shown behind the
   * row's WHY chip. Display only: in no request and in neither signature, so it never re-quotes and
   * never counts as her work. Absent on a row she added by hand.
   */
  why?: string;
  /**
   * The planner's direction for a HELD row — a photo or her own clip — carried as DATA (PR 14, R-5).
   * No request reads it (a held row asks for nothing, so it stays out of `boardSignature`); it is here
   * so the stitch (PR 15) can read what the planner meant by this row. A shot row's direction is its
   * `prompt`, as before.
   */
  direction?: string;
  /**
   * The planner's slots this row could NOT carry, each with the reason it was dropped (PR 15, R-2) —
   * so a dropped ask is named rather than silent. Written at seed (agentLogic `withPlannedShot`, held
   * rows included since PR 15.1), only with the composer on. In no clip request and in neither
   * signature; it rides the STITCH body's `composer` record (boardStitch) and is stored on the spec.
   */
  droppedSlots?: DroppedSlot[];
}

/** Why a planned slot did not ride the row. A closed set, so the ledger can count them. */
export type DroppedSlotReason =
  /** A row with a photograph: the photo already decides it (prompts.ts `slotRefusal`). */
  | "photo-decides"
  /** A shot of her from a photo: what she does is her sentence's, not a chip's. */
  | "in-her-sentence"
  /** A held still or her own clip: nothing is filmed, so there is no camera to direct. */
  | "nothing-filmed";

export interface DroppedSlot {
  slot: StudioShotSlot;
  value: string;
  reason: DroppedSlotReason;
}

/**
 * One of her photos as a row that will be HELD, not animated. Empty prompt on purpose: there is
 * nothing to direct, and `boardGaps` never asks a still for a line.
 */
export const heldPhotoRow = (
  key: string,
  assetId: string,
  thumbUrl: string | null,
  stillSec: number,
  /** How it moves over the hold (D2, A1), or null / absent for dead still. */
  motion: StillMotionName | null = null,
): StoryboardRow => ({
  key,
  assetId,
  thumbUrl,
  prompt: "",
  kind: "still",
  hasPerson: false,
  stillSec,
  ...(motion ? { stillMotion: motion } : {}),
});

/**
 * How a still moves over its hold — a push-in, a move toward a point, or dead still. A no-op on any
 * row that is not a still, like `setStillSec`; null clears it so "still" has one representation
 * (absent). Her point survives a change between the moves that take one — zoom to punch keeps where
 * she tapped — and is dropped on a change to one that does not.
 */
export function setStillMotion(
  rows: StoryboardRow[],
  index: number,
  motion: StillMotionName | null,
): StoryboardRow[] {
  return rows.map((row, i) => {
    if (i !== index || !isStillRow(row)) return row;
    const { stillMotion: _dropped, stillFocus, ...rest } = row;
    if (!motion) return rest;
    return takesFocus(motion) && stillFocus
      ? { ...rest, stillMotion: motion, stillFocus }
      : { ...rest, stillMotion: motion };
  });
}

/**
 * A tap on the contained photo → a point on the photo, as fractions of it — or null when the tap
 * landed in the letterbox around it. `drawn` is where the photo sits inside its stage
 * (hooks/contained-stage `containedRect`), so the fraction is of the PHOTO, never of the stage.
 */
export function focusFromTap(
  tap: { x: number; y: number },
  drawn: { x: number; y: number; w: number; h: number } | null,
): { x: number; y: number } | null {
  if (!drawn || drawn.w <= 0 || drawn.h <= 0) return null;
  const x = (tap.x - drawn.x) / drawn.w;
  const y = (tap.y - drawn.y) / drawn.h;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x, y };
}

/**
 * Where a still's move heads — her tap, as fractions of the photo, clamped to it — or null for the
 * photo's own point. A no-op unless the row is a still whose motion takes a point: a point beside a
 * push-in would be refused by the server as an instruction that does nothing.
 */
export function setStillFocus(
  rows: StoryboardRow[],
  index: number,
  focus: { x: number; y: number } | null,
): StoryboardRow[] {
  const frac = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return rows.map((row, i) => {
    if (i !== index || !isStillRow(row) || !takesFocus(row.stillMotion))
      return row;
    const { stillFocus: _dropped, ...rest } = row;
    return focus && Number.isFinite(focus.x) && Number.isFinite(focus.y)
      ? { ...rest, stillFocus: { x: frac(focus.x), y: frac(focus.y) } }
      : rest;
  });
}

/**
 * One of her own clips as a row that is PLACED, not made (C2 Half B). Empty prompt: nothing is
 * directed. `trim` is the beat it is cut to, or null for the whole clip; `keepSound` seeds `audio`,
 * which on a clip means "keep its own sound" and costs nothing.
 */
export const heldClipRow = (
  key: string,
  assetId: string,
  thumbUrl: string | null,
  trim: { startSec: number; endSec: number } | null,
  clipSec: number | null,
  keepSound: boolean,
  videoUrl: string | null = null,
): StoryboardRow => ({
  key,
  assetId,
  thumbUrl,
  prompt: "",
  kind: "clip",
  hasPerson: false,
  ...(trim ? { clipTrim: trim } : {}),
  ...(clipSec !== null ? { clipSec } : {}),
  ...(keepSound ? { audio: true as const } : {}),
  ...(videoUrl ? { videoUrl } : {}),
});

/** Use the whole clip: drop a clip row's window. A no-op on any other row. */
export const clearClipTrim = (
  rows: StoryboardRow[],
  index: number,
): StoryboardRow[] =>
  rows.map((row, i) => {
    if (i !== index || !isClipRow(row)) return row;
    const { clipTrim: _drop, ...rest } = row;
    return rest;
  });

/** What a clip row plays, in seconds — its window, else its measured length, else null. */
export const clipPlays = (row: StoryboardRow): number | null =>
  row.clipTrim
    ? Math.round((row.clipTrim.endSec - row.clipTrim.startSec) * 10) / 10
    : (row.clipSec ?? null);

/**
 * How long one still is held — clamped to the server's bounds, exactly as the timeline's
 * `setStillSec` is, so a chip can never produce a hold the stitch door refuses. A no-op on any
 * row that is not a still.
 */
export function setStillSec(
  rows: StoryboardRow[],
  index: number,
  seconds: number,
  limits: { minStillSec: number; maxStillSec: number },
): StoryboardRow[] {
  if (!Number.isFinite(seconds)) return rows;
  return rows.map((row, i) =>
    i !== index || !isStillRow(row)
      ? row
      : {
          ...row,
          stillSec: Math.min(
            limits.maxStillSec,
            Math.max(limits.minStillSec, seconds),
          ),
        },
  );
}

/**
 * A video she added to an Agent plan to be placed AS IT IS — never quoted, never admitted, never
 * generated. It joins the stitch at the END, in the order she picked it (decided 21 Sep 2026).
 */
export interface PassthroughClip {
  assetId: string;
  posterUrl: string | null;
}

/**
 * A video she picked on the Agent form. With BEATS it is CUT into the plan by default — it travels
 * to the planner among her picks, and its beats come back as clip items — and she can flip it to
 * AS IS, which is today's passthrough (enrichment fixes, 22 Sep 2026). Without beats there is
 * nothing to cut, so it is always passthrough and shows no choice.
 */
export interface PickedVideo extends PassthroughClip {
  /** How many beats the clip lane found — 0 when it has not been read as a clip. */
  beats: number;
  /** Her choice for a video WITH beats; ignored (always as-is) without. */
  cut: boolean;
  /**
   * Where its clip read stands (PR 9.5) — what the tray's "Read this clip" pill renders. Null when
   * the server did not say (an older server, or a row picked before the field existed).
   */
  read?: import("./clipReadLogic").ClipRead | null;
}

/** Which of her picked videos go to the planner to be cut. */
export const cutVideos = (videos: readonly PickedVideo[]): PickedVideo[] =>
  videos.filter((v) => v.beats > 0 && v.cut);

/** Which stay passthrough — appended as they are, at the end. */
export const asIsVideos = (videos: readonly PickedVideo[]): PassthroughClip[] =>
  videos
    .filter((v) => !(v.beats > 0 && v.cut))
    .map(({ assetId, posterUrl }) => ({ assetId, posterUrl }));

/**
 * A board handed over by the Agent screen.
 *
 * ⚠️ IN ROUTE PARAMS, IN MEMORY — nothing is stored (docs/studio-agent-open-cards.md card 4). The
 * Board applies a seed once, by `nonce`, and then clears it; a seed it has already applied is never
 * applied again on a re-render.
 *
 * `rows` are the SAME rows the Agent screen priced its estimate from (agentLogic `seedRowsFrom`), so
 * the estimate and the Board's own quote are built by one piece of code from one set of rows.
 * `objective` travels with them because it is in every request the Board makes.
 */
export interface BoardSeed {
  nonce: string;
  objective: StudioObjective;
  rows: StoryboardRow[];
  passthrough: PassthroughClip[];
  /**
   * The stored plan these rows came from (PR 6, 6a3; server/studio/agent/plans.ts), or null/absent
   * when it was not saved. The rows still travel here; the id is what re-opens the plan without a
   * re-plan (`openStoredPlan`). A seed with a plan id and NO rows is exactly that: the Board opens
   * the stored plan and seeds from it (6d).
   */
  planId?: string | null;
  /** The plan's look over every held photo (PR 6, 6d), or null/absent for as-is. */
  look?: string | null;
  /** The plan's track or bed and whether cuts land on its beat (PR 6, 6d), or null/absent for none chosen. */
  music?: { bed: string; onBeat: boolean } | null;
  /**
   * The reference reading's editing rhythm, read on the client from the brief the plan was made from
   * (PR 15, D-2; rhythmLogic) — or null/absent when there is no reading, it names no pace, or the
   * composer is off. One input to the join rule, below her Cut, the beat type and the music's beat.
   */
  rhythm?: import("./rhythmLogic").RhythmReading | null;
  /** The board is for a deal deliverable (PR 6, 6d decision 4) — the linkage lives on the plan row. */
  dealLinked?: boolean;
}

/**
 * The Board's music once a seed is applied (PR 6, 6d). A plan that chose music hands it over AS HER
 * PICK — `touched`, so the server's suggestion never re-asserts over it; a plan that chose none leaves
 * the Board as a fresh one (untouched: the suggestion, fail-closed on a brand objective, stands). The
 * last board's pick never carries over — that was the pre-PR-6 applySeed's leak.
 */
export const seededMusic = (seed: Pick<BoardSeed, "music">) =>
  seed.music
    ? { bed: seed.music.bed, onBeat: seed.music.onBeat, touched: true }
    : { bed: null, onBeat: true, touched: false };

/** The reading's rhythm a seed carries (PR 15), or null — a hand-built board has none. */
export const seededRhythm = (seed: Pick<BoardSeed, "rhythm">) =>
  seed.rhythm ?? null;

/**
 * Which slots this row can take — THE SERVER'S RULE, mirrored so the surface greys what would be
 * refused instead of letting her find out from a blocker.
 *
 * A row with a photograph already HAS a framing, a light and a place: they are in the pixels, and
 * the video templates tell the model to leave them alone. Asking for "close, golden hour, in a gym"
 * on top of a wide overcast photo of a field is a prompt that disagrees with its frame. So a photo
 * row takes camera MOVEMENT only, and a row with no photo — text-to-video — takes all four.
 * (server/studio/video/prompts.ts `slotRefusal` is the authority; this is the convenience.)
 */
export const slotsAllowed = (
  row: StoryboardRow,
  /** The composer (PR 15, R-2): a photo-less row takes composition and action too. */
  composer = false,
): StudioShotSlot[] =>
  isHeldRow(row)
    ? [] // nothing is filmed, so there is no camera to direct
    : row.assetId
      ? ["movement"]
      : composer
        ? [
            "framing",
            "movement",
            "lighting",
            "environment",
            "composition",
            "motion",
          ]
        : ["framing", "movement", "lighting", "environment"];

/**
 * Why a slot the planner set does not ride this row — the named half of the filter (PR 15, R-2).
 * A photo row refuses composition as it refuses framing (the photo decides it) and refuses action in
 * its own words (her sentence carries it); a held row films nothing.
 * ⚠️ MUTATION (agentLogic.test): return null for a photo row's framing — "a photo row silently drops
 * framing" reds by name.
 */
export const droppedSlotReason = (
  row: StoryboardRow,
  slot: StudioShotSlot,
): DroppedSlotReason | null => {
  if (isHeldRow(row)) return "nothing-filmed";
  if (!row.assetId) return null;
  if (slot === "movement") return null;
  return slot === "motion" ? "in-her-sentence" : "photo-decides";
};

/** The values a slot's chips offer: the full vocabulary with the composer on, the original set off. */
export const shotSlotValues = (
  slot: StudioShotSlot,
  composer = false,
): readonly string[] =>
  composer ? SHOT_SLOT_VALUES[slot] : LEGACY_SHOT_SLOT_VALUES[slot];

/**
 * Everything about the board that changes what it would ASK FOR — the key the re-quote effect
 * watches. A change here must fetch fresh previews; a re-render that changes nothing here must not.
 *
 * ⚠️ EVERY FIELD `clipRequestFor` READS HAS TO BE IN HERE, OR SHE SPENDS AGAINST A STALE PREVIEW.
 * "Make the board" runs the previewIds the last quote stored. If a field travels in the request but
 * is missing from this signature, changing it re-quotes nothing: the stored previewId still points
 * at a brief frozen BEFORE the change, and that is the brief that runs. Nothing errors — the quote
 * matches the run perfectly, and both are for a clip she is no longer looking at.
 *
 * This shipped broken for one commit: it lived inline in StoryboardTab as
 * `[key, assetId, prompt, kind, bridgeRequested]`, the shot slots were added to the row and to the
 * request, and not to this. She tapped Tracking, the board did not re-quote, and the job ran on a
 * brief with no `shot` key at all (found on the first real run, by reading the job row). It lives
 * here now so a test can hold it.
 *
 * ⚠️ AND NOTHING ELSE IS. `stillSec` is deliberately NOT here: no request reads it (a still is never
 * previewed), so a hold change re-quoting the board would fetch the same previews again for nothing.
 * It is in `boardWorkSignature` instead, which answers a different question. Two signatures, on
 * purpose — do not unify them.
 */
export const rowSignature = (rows: StoryboardRow[]): string =>
  JSON.stringify(
    rows.map((r) => [
      r.key,
      r.assetId,
      r.prompt,
      r.kind,
      r.bridgeRequested,
      // Sound is a PRICE on a person row (Veo's audio SKU is double), so leaving it out of here
      // would be the shot-slot incident again, in the one term that changes what she is charged.
      // On a CLIP it is its own sound, read by the stitch and by no request — out of here, into
      // `boardWorkSignature`, exactly as a hold is (ruling 1).
      isClipRow(r) ? null : r.audio,
      // Canonical slot order, so the same spec built in a different tap order is the same string.
      // ⚠️ COMPOSITION AND ACTION TRAVEL WITH THE COMPOSER ON (PR 15.1, R-1), SO THEY ARE HERE — and
      // only when one is set, so a board with the flag off (where nothing can set either: `setShotSlot`
      // refuses, the seed strips) keys exactly as it always did. Found in PR 15.1's Phase R: the
      // request began sending them, and a composition tap would otherwise have re-quoted nothing.
      // ⚠️ MUTATION (storyboardRun.test): back to the four — "a composition change does not
      // re-quote the board" reds by name.
      r.shot
        ? [
            ...(
              ["framing", "movement", "lighting", "environment"] as const
            ).map((slot) => r.shot?.[slot] ?? null),
            ...(r.shot.composition !== undefined || r.shot.motion !== undefined
              ? [r.shot.composition ?? null, r.shot.motion ?? null]
              : []),
          ]
        : null,
    ]),
  );

/**
 * The Board's QUOTE KEY: what it would ask for, AND what for.
 *
 * ⚠️ THE OBJECTIVE IS IN EVERY REQUEST (`boardRequests(rows, objective)`), so it is in the key the
 * quote is fired on and stamped with — the #538 rule again: a field that travels in the request and
 * is missing from the key means she spends against a quote for something else. A board seeded from
 * an Agent plan built as "showcase-product" would otherwise be priced, and run, as "grow-following".
 *
 * A hand-built board's objective never changes, so for it this changes nothing but the string.
 */
export const boardSignature = (
  rows: StoryboardRow[],
  objective: StudioObjective,
  /** In every request when the carrier is on (PR 14), so in the key — a plan id that changes re-quotes. */
  planId: string | null = null,
): string => JSON.stringify([objective, rowSignature(rows), planId]);

/**
 * "Did she do anything to this board she would mind losing?" — the key `backToPlan` compares against
 * the seed's, NOT the quote key.
 *
 * ⚠️ A DIFFERENT QUESTION FROM `boardSignature`, SO A DIFFERENT KEY. The quote key holds what a
 * request READS (re-quote when it changes, and only then); this holds what she EDITED. The one field
 * that splits them today is a still's hold: no request reads it, so it must stay out of the quote
 * key — but changing a hold changes the video she will stitch, and popping the board would lose it.
 * Keep them two: folding this into `boardSignature` would re-quote on a hold change for nothing, and
 * folding `boardSignature` into this would let a hold change go unnoticed by the confirm.
 */
export const boardWorkSignature = (
  rows: StoryboardRow[],
  objective: StudioObjective,
): string =>
  JSON.stringify([
    boardSignature(rows, objective),
    // A clip's window is an edit like a hold: no request reads it, the stitch does (ruling 1).
    rows.map((r) => [
      r.stillSec ?? null,
      // A push-in is an edit like a hold: no request reads it, the stitch does (D2) — and so is
      // where a move heads (A1).
      r.stillMotion ?? null,
      r.stillFocus ? [r.stillFocus.x, r.stillFocus.y] : null,
      r.cutIn ?? null,
      r.clipTrim ? [r.clipTrim.startSec, r.clipTrim.endSec] : null,
      isClipRow(r) ? (r.audio ?? null) : null,
    ]),
  ]);

/**
 * What the Board does with a seed that has just arrived.
 *
 *   wait    a run is in progress — the seed stays pending, the banner says so, and it is offered
 *           again once the run settles (or she dismisses it). Replacing a board mid-run would strand
 *           the pieces it is still spending on.
 *   apply   the board is empty — nothing of hers to lose, so no question.
 *   ask     the board holds her work — Replace or Keep mine, inline. Never a native alert: on web
 *           it cannot offer two buttons, and Chrome is one of the two surfaces this is checked on.
 */
export type SeedDecision = "wait" | "apply" | "ask";
export const seedDecision = (
  rowsOnBoard: number,
  running: boolean,
): SeedDecision => (running ? "wait" : rowsOnBoard === 0 ? "apply" : "ask");

/**
 * "‹ Back to the plan" — what a tap on it does, or whether it is drawn at all.
 *
 * ⚠️ BACK IS A POP, AND A POP ENDS THIS BOARD. The seeded Board sits ABOVE the Agent screen: every
 * "Put it on the board" pushes a fresh StudioHome (React Navigation 7's navigate() pushes a screen it
 * is not already on), so the only way back to the plan she left is to pop this one — which takes its
 * edits and its on-board results with it (what was made stays in her library). "Put it on the board"
 * then seeds a fresh one. So:
 *
 *   hidden    not a board seeded here with the Agent screen under it — or ANYTHING is running: a
 *             board popped mid-run keeps spending, out of sight, in a loop nothing is watching
 *   go        the board is exactly as the plan left it — nothing to lose
 *   confirm   it holds work since the seed (an edit, or something made) — say so, inline, first
 */
export type BackToPlan = "hidden" | "go" | "confirm";
export const backToPlan = (p: {
  /** Seeded in this board, with the Agent screen directly beneath it. */
  available: boolean;
  /** The board, or any one row, is running. */
  running: boolean;
  /** Edited since the seed, or anything made on it. */
  holdsWork: boolean;
}): BackToPlan =>
  !p.available || p.running ? "hidden" : p.holdsWork ? "confirm" : "go";

/** The inline confirm's words, when the board holds work. Never a native alert (web cannot offer two buttons). */
export const BACK_TO_PLAN_NOTE =
  "Going back leaves this board. What you made stays in your library.";

/** What the panel says while the board is being re-priced after an edit. */
export const STALE_QUOTE_NOTE =
  "Updating the price for your change — one moment.";

/**
 * Why "Make the board" cannot be tapped right now — or null when it can.
 *
 * ─── ⚠️  THE QUOTE MUST BE FOR THE BOARD ON HER SCREEN ─────────────────────────────────────────
 *
 * `quotedFor` is the `rowSignature` the stored quotes were MADE for; `signature` is the board's now.
 * They differ from the moment she edits until the re-quote lands — the debounce, then one preview per
 * piece — and for that whole window the stored previewIds authorise the board she HAD. The button
 * used to stay live through it: tap during the window and the run spent the old previews — a clip
 * for a sentence she had already changed, a kind she had already switched, sound she had already
 * turned off. The quote matched the run exactly, and neither matched her screen or what she meant.
 *
 * So a quote made for another board blocks approval, the same way a refusal does, until the quote
 * catches up. An untouched board is unaffected: its quote was made for exactly this signature.
 *
 * Order: an unfinished board first (the panel lists the gaps themselves), then a refusal about money,
 * then a quote that is out of date.
 */
export function approvalBlock(
  gaps: string[],
  refusal: string | null,
  quotedFor: string | null,
  signature: string,
): string | null {
  if (gaps.length > 0) return gaps[0];
  if (refusal !== null) return refusal;
  if (quotedFor !== signature) return STALE_QUOTE_NOTE;
  return null;
}

/** What each slot is called on the surface. Her words, never the field name ("Setting", not "environment"). */
export const SLOT_LABELS: Record<StudioShotSlot, string> = {
  framing: "Framing",
  movement: "Camera",
  lighting: "Light",
  environment: "Setting",
  composition: "Composition",
  motion: "Action",
};

/** "golden-hour" → "Golden hour". The wire value is a name; this is what she reads. */
export const slotValueLabel = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");

/**
 * The one line a photo row shows in place of the slots it cannot take — explained, never hidden.
 * Null on a row that takes everything.
 */
export const slotsNote = (
  row: StoryboardRow,
  composer = false,
): string | null =>
  row.assetId
    ? composer
      ? "Framing, light, setting and composition come from the photo; what you do is in your sentence."
      : "Framing, light and setting come from the photo."
    : null;

/**
 * Whether THIS row is the kind of shot whose sound costs money.
 *
 * A photo row tagged `motion` sends its reference as `person`, which makes it an identity shot on
 * Veo — and Veo's audio SKU is double its silent one. Every other row is b-roll on seedance, which
 * is priced per video token with no audio arm: `video_tokens_without_audio` equals `video_tokens`,
 * so sound there is free and a warning about it would be noise.
 */
export const audioCostsMore = (row: StoryboardRow): boolean =>
  Boolean(row.assetId) && row.kind === "motion";

/**
 * ⚠️ A SIBLING OF `slotsNote` RATHER THAN A SECOND CLAUSE INSIDE IT, because the two do not fire on
 * the same rows. `slotsNote` speaks for any row with a photo; this speaks only for a photo row that
 * is a PERSON. A b-roll row with a photo needs the first sentence and must not get this one.
 *
 * No figure in the copy on purpose: the dollar delta is the clip's length times Veo's rate, and the
 * board does not choose a length — the server's default does. A literal here would be a number that
 * silently stops being true the day that default moves or the length becomes hers to pick.
 */
export const audioNote = (row: StoryboardRow): string | null =>
  audioCostsMore(row) ? "Sound doubles what this shot costs." : null;

/**
 * Set one slot on one row, or clear it (`null`, or tapping the value it already has).
 *
 * ⚠️ A REFUSAL IS A NO-OP, NEVER A CLAMP — `setKind`'s rule, for its reason. A slot this row cannot
 * take leaves the board exactly as it was.
 */
export function setShotSlot<K extends StudioShotSlot>(
  rows: StoryboardRow[],
  index: number,
  slot: K,
  value: NonNullable<StudioShotSpec[K]> | null,
  composer = false,
): StoryboardRow[] {
  const row = rows[index];
  if (!row || !slotsAllowed(row, composer).includes(slot)) return rows;
  const next: StudioShotSpec = { ...(row.shot ?? {}) };
  if (value === null || next[slot] === value) delete next[slot];
  else next[slot] = value;
  return rows.map((r, i) => {
    if (i !== index) return r;
    const { shot: _drop, ...rest } = r;
    return Object.keys(next).length ? { ...rest, shot: next } : rest;
  });
}

/**
 * What the server told us a board may cost. Never hardcoded here — see the header.
 *
 * It arrives on POST /studio/plan/admit's 200 (`maxJobUsd`, read from the server's own config), asked
 * after every quote. Until that answer lands the board has NO limits — `null` — and `boardQuote`
 * refuses rather than guessing: the placeholder that stood here for a commit was exactly the kind of
 * second source of truth for money this module exists not to hold.
 */
export interface BoardLimits {
  /**
   * ⚠️ APPLIED TO THE BOARD TOTAL, WHICH IS STRICTER THAN THE SERVER.
   *
   * `spendCaps` applies this per JOB, and a board is N jobs, so five rows each under the cap are
   * five legal generations the server would run without complaint. It is applied to the whole board
   * anyway, because a board is ONE decision to her however many jobs it is underneath, and the
   * number she is agreeing to is the total.
   */
  maxJobUsd: number;
}

/**
 * One row's quote, as the server returned it.
 *
 * ⚠️ TWO FIGURES, AND THEY ARE DIFFERENT NUMBERS ON PURPOSE. The probes' posture, kept: the adapter
 * quotes the audio arm for a model that has one, so an unverified `generate_audio` flag can never
 * under-quote. `ceilingUsd` is what may be spent and what every refusal is measured against;
 * `expectedUsd` is what the invoice has actually come back as. Showing only the ceiling reads as a
 * price rise; showing only the expected one is a promise the quote does not make.
 */
export interface RowQuote {
  key: string;
  ceilingUsd: number;
  expectedUsd: number;
  /** No price configured for that model. NEVER treat as $0 — see `boardQuote`. */
  unpriced?: boolean;
  /**
   * ⚠️ THE SERVER SAYS THIS CANNOT RUN AT ALL, in her words — `PreviewResponse.unavailable`.
   *
   * A capability WE are missing rather than a gap in her material: video switched off, most often.
   * It outranks every other refusal below, because a board whose pieces cannot run is not an
   * expensive board or an unpriced one — it is one that will not happen, and saying anything else
   * first would bury the only fact that matters.
   */
  unavailable?: string;
}

/** A row's own line in the itemised quote. */
export interface QuotedRow {
  key: string;
  clip: RowQuote | null;
  /** The bridge INTO this row, when she asked for one. Null on row 0 and on any join she left free. */
  bridge: RowQuote | null;
  /**
   * The hold, in seconds, when this row is a still — its whole line item: "$0 · held Ns". Null on a
   * shot. A still has no `clip` quote and never will, and that is not a missing quote.
   */
  held: number | null;
  /**
   * Her own footage, when this row is a clip — its whole line item: "$0 · Ns of yours", with the
   * seconds it plays or null when unmeasured. Null on any other row. Like `held`, never a missing
   * quote: nothing is made.
   */
  own: { seconds: number | null } | null;
}

export interface BoardQuote {
  perRow: QuotedRow[];
  ceilingUsd: number;
  expectedUsd: number;
  /**
   * ⚠️ WHETHER THE TWO FIGURES ABOVE MEAN ANYTHING. False when a line has no quote yet or the server
   * priced one as `unpriced`, and a surface MUST NOT SHOW A NUMBER while it is false.
   *
   * It exists because the refusal alone was not enough. The panel rendered "Still working out what
   * this board costs" and, three lines above it, "$0.00 — usually about $0.00" beside two real
   * shots: the refusal was correct and the headline was a lie, and the lie is the part she reads
   * first. A sum of nothing is 0 and looks exactly like free.
   *
   * An EMPTY board is priced and genuinely costs nothing — that is the one case where $0.00 is true.
   */
  priced: boolean;
  /**
   * Why this board cannot run, in her words — or null.
   *
   * ⚠️ A REFUSAL, NOT A WARNING. It is computed before anything is called and the button is dead
   * while it is set, which is the whole point of quoting the board up front: the money is counted
   * before anything that can throw.
   */
  refusal: string | null;
}

/** The most stills one board may hold. A board is a storyboard, not a film. */
export const MAX_ROWS = 8;

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Why `broll` cannot be chosen for this row — or null when it can.
 *
 * ⚠️ THE ONE RULE THAT CAN REFUSE A KIND, AND IT IS NOT A PREFERENCE. B-roll routes to seedance, and
 * seedance REFUSES real-person image-to-video: six of six V2b cells came back
 * `InputImageSensitiveContentDetected.PrivacyInformation`, a stated BytePlus policy, both tiers, all
 * three frames. So offering b-roll on a photograph of her is offering a refusal she waits for and
 * pays nothing for, having already spent the only thing that matters — the time between asking and
 * finding out.
 *
 * It is REPORTED rather than hidden so the surface can grey the option and say why. An option that
 * silently vanishes teaches her nothing about why the product works the way it does.
 */
export function brollRefusal(row: StoryboardRow): string | null {
  // ⚠️ IMAGE-LESS ROWS ARE B-ROLL BY DEFINITION and the guard must stay quiet on them — its sentence
  // says "this photo", and there is no photo. A row made from a sentence alone has no subject to be
  // careful about.
  if (!row.assetId) return null;
  // B-ROLL IS MADE FROM WORDS (22 Sep 2026). A row with a photo is `motion` (her) or `product` (an
  // object); "b-roll" on it would be the old photo-bearing object shot under a name that now means
  // text-to-video. The person guard stays first so a photo of her still gets its own sentence.
  return row.hasPerson
    ? "B-roll is a shot with nobody in it — this photo has you in it."
    : "B-roll is made from words — for this photo, pick Your product.";
}

/**
 * Why `product` cannot be chosen — or null. A product is an OBJECT from its photo: it needs the
 * photo, and it must not be her (seedance refuses a real person 6 of 6 — `brollRefusal`'s reason).
 */
export function productRefusal(row: StoryboardRow): string | null {
  if (!row.assetId) return "Your product needs its photo — add one.";
  return row.hasPerson
    ? "Your product is a shot with nobody in it — this photo has you in it."
    : null;
}

/**
 * Why `motion` cannot be chosen — or null.
 *
 * ⚠️ MOVEMENT OF WHAT? "Slight movement" is a beat performed BY a subject in a frame she supplied;
 * with no frame there is nothing to move, and the clip would be an invention rather than her
 * photograph in motion. So an image-less row is b-roll and only b-roll, and the pill says why
 * rather than vanishing.
 */
export function motionRefusal(row: StoryboardRow): string | null {
  return row.assetId
    ? null
    : "Slight movement needs a photo to move — add one, or leave this as b-roll.";
}

/**
 * Why `still` cannot be this row — or null. A held photo needs a photo; that is the whole rule.
 * (A still is never CHOSEN on a row, see `setKind` — this exists so `boardGaps` can judge a row
 * that arrived as one.)
 */
export const stillRefusal = (row: StoryboardRow): string | null =>
  row.assetId ? null : "A held photo needs a photo.";

/** Why `clip` cannot be this row — or null. One of her clips needs the clip; never chosen, like a still. */
export const clipRefusal = (row: StoryboardRow): string | null =>
  row.assetId ? null : "One of your clips needs the clip.";

/** Whether a kind may be set on a row at all. */
export const kindAllowed = (row: StoryboardRow, kind: ShotKind): boolean =>
  (kind === "broll"
    ? brollRefusal(row)
    : kind === "motion"
      ? motionRefusal(row)
      : kind === "product"
        ? productRefusal(row)
        : kind === "still"
          ? stillRefusal(row)
          : clipRefusal(row)) === null;

/**
 * Set a row's kind, or leave the board exactly as it was.
 *
 * ⚠️ A REFUSAL IS A NO-OP, NEVER A CLAMP. Quietly rewriting `broll` to `motion` would generate a
 * different board from the one on her screen, at a different price, and she would have no way to
 * know it happened. The surface greys what cannot be chosen; this is the second lock on the same
 * door, for a caller that did not look.
 */
export function setKind(
  rows: StoryboardRow[],
  index: number,
  kind: ShotKind,
): StoryboardRow[] {
  const row = rows[index];
  if (!row || !kindAllowed(row, kind)) return rows;
  // ⚠️ A STILL IS MADE, NEVER RE-KINDED. A row becomes a still by being added as one
  // (`heldPhotoRow`), and a still never becomes a shot: the two carry different fields (a hold vs
  // a line, sound and a camera), and re-kinding would leave one set stranded on the row. The
  // surface offers neither pill; this is the second lock. A clip is the same: placed, never chosen.
  if (isHeldRow(row) || kind === "still" || kind === "clip") return rows;
  return rows.map((r, i) => (i === index ? { ...r, kind } : r));
}

/** Her sentence for one row. */
export const setPrompt = (
  rows: StoryboardRow[],
  index: number,
  prompt: string,
): StoryboardRow[] =>
  // A still or a clip has nothing to direct: its prompt stays "", whatever a caller sends.
  rows.map((r, i) => (i === index && !isHeldRow(r) ? { ...r, prompt } : r));

/**
 * Ask for — or withdraw — a generated bridge into one row.
 *
 * ⚠️ IT SPENDS NOTHING, and a bridge is never on by default. Four joins left alone cost $0; four
 * bridges are four choices she made, or one deliberate "bridge all". The alternative — bridges by
 * omission — is a board that quietly costs 4 x $0.42 more than the one she thought she built.
 */
/**
 * Turn sound on or off for one row. `setBridge`'s shape, for `setBridge`'s reason: OFF deletes the
 * key rather than writing `false`, so a row that never wanted sound and a row that turned it off are
 * the same object — and therefore the same `rowSignature`, and therefore not a needless re-quote.
 */
export function setAudio(
  rows: StoryboardRow[],
  index: number,
  wanted: boolean,
): StoryboardRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    if (!wanted) {
      const { audio: _drop, ...rest } = row;
      return rest;
    }
    // Nothing is filmed on a still, so there is nothing to sound.
    if (isStillRow(row)) return row;
    return { ...row, audio: true as const };
  });
}

/**
 * Whether the join into row `index` can be a generated bridge at all.
 *
 * ⚠️ A BRIDGE NEEDS A PHOTO ON BOTH SIDES. It is generated from the previous row's still to this
 * one's (storyboardRun `bridgeRequestFor`), so next to a photo-less row — t2v b-roll, made from words
 * — there is no request to build, and so no quote ever arrives. An ask held there left the board on
 * "Still working out what this board costs" FOREVER (boardQuote counts it missing), unapprovable, with
 * nothing on screen saying why. Row 0 has nothing before it, for the same reason as ever.
 *
 * ⚠️ AND NEVER A STILL ON EITHER SIDE. A still HAS a photo, so the asset check alone would let a
 * bridge be generated into or out of a held photo — but a still is not a shot: the C1 rule is that
 * no bridge touches a still (the timeline refuses it too), and its joins are Cut or Fade only.
 */
export const bridgeable = (rows: StoryboardRow[], index: number): boolean =>
  index > 0 &&
  !!rows[index]?.assetId &&
  !!rows[index - 1]?.assetId &&
  // Nor a clip: a bridge is generated from a frame to a frame, and a placed clip is neither.
  !isHeldRow(rows[index]) &&
  !isHeldRow(rows[index - 1]);

/**
 * Whether the join into row `index` may be a Cut — only beside a still. Every other join is the free
 * crossfade or a bridge, as the Board has always said; a still's joins are Cut or Fade and never a
 * bridge (C1's rule, `bridgeable`), so this is the choice that replaces the bridge pill there.
 */
export const cutAllowed = (rows: StoryboardRow[], index: number): boolean =>
  index > 0 && (isHeldRow(rows[index]) || isHeldRow(rows[index - 1]));

/** Cut (true) or Fade (false) into one row. Refused where no still is beside the join. */
export function setCut(
  rows: StoryboardRow[],
  index: number,
  wanted: boolean,
): StoryboardRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    if (!wanted || !cutAllowed(rows, i)) {
      const { cutIn: _drop, ...rest } = row;
      return rest;
    }
    return { ...row, cutIn: true as const };
  });
}

export function setBridge(
  rows: StoryboardRow[],
  index: number,
  wanted: boolean,
): StoryboardRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    // Refused where no bridge can be built — see `bridgeable`. Withdrawing always works.
    if (!wanted || !bridgeable(rows, i)) {
      const { bridgeRequested: _drop, ...rest } = row;
      return rest;
    }
    return { ...row, bridgeRequested: true };
  });
}

/**
 * Applied after EVERY reorder and removal, so row 0 never keeps a bridge it inherited.
 *
 * The same job `stitchLogic.normalize` does, for the same reason and with one extra path: a board
 * row can reach position 0 by being dragged there OR by the row above it being deleted. Both leave
 * a bridge into the first clip, which is a bridge from nothing.
 */
export const normalizeBoard = (rows: StoryboardRow[]): StoryboardRow[] =>
  rows.map((row, i) => {
    let out = row;
    // Row 0, and any join a reorder or a seed left beside a photo-less row — see `bridgeable`.
    if (out.bridgeRequested !== undefined && !bridgeable(rows, i)) {
      const { bridgeRequested: _drop, ...rest } = out;
      out = rest;
    }
    // A Cut that a reorder or a removal left with no still beside it — see `cutAllowed`.
    if (out.cutIn !== undefined && !cutAllowed(rows, i)) {
      const { cutIn: _drop, ...rest } = out;
      out = rest;
    }
    return out;
  });

/** Move a row to a new index, normalising after. */
export function moveRow(
  rows: StoryboardRow[],
  from: number,
  to: number,
): StoryboardRow[] {
  if (from === to || from < 0 || from >= rows.length) return rows;
  const clamped = Math.max(0, Math.min(rows.length - 1, to));
  const next = rows.slice();
  const [row] = next.splice(from, 1);
  next.splice(clamped, 0, row);
  return normalizeBoard(next);
}

/** Drop a row, normalising after — the row that inherits position 0 loses its ask. */
export const removeRow = (
  rows: StoryboardRow[],
  index: number,
): StoryboardRow[] => normalizeBoard(rows.filter((_, i) => i !== index));

/**
 * What is stopping this board being quoted at all, in her words. Empty means it is ready to price.
 *
 * Separate from `BoardQuote.refusal`, which is about MONEY: these are about the board being
 * finished. The split matters because they want different UI — a gap is something to go and fix, a
 * refusal is a wall.
 */
export function boardGaps(rows: StoryboardRow[]): string[] {
  const gaps: string[] = [];
  if (rows.length === 0) gaps.push("Add a photo to start the board.");
  if (rows.length > MAX_ROWS)
    gaps.push(`${rows.length} shots — a board holds up to ${MAX_ROWS}.`);
  // A still or a clip needs no line — nothing is directed; it is shown. Both count toward MAX_ROWS.
  const blank = rows.filter((r) => !isHeldRow(r) && !r.prompt.trim()).length;
  if (blank)
    gaps.push(
      blank === 1
        ? "One shot still needs a line about what happens in it."
        : `${blank} shots still need a line about what happens in them.`,
    );
  // A kind that became impossible after the fact — she tagged the still as herself later, or a row
  // arrived from somewhere that did not check. Reported rather than silently rewritten, on the same
  // argument as `setKind`.
  const impossible = rows.filter((r) => !kindAllowed(r, r.kind)).length;
  if (impossible)
    gaps.push(
      `${impossible === 1 ? "One shot has" : `${impossible} shots have`} a kind that doesn't fit what's in it.`,
    );
  return gaps;
}

/**
 * The board's price, itemised, with the one refusal that stops it running.
 *
 * ⚠️ EVERY FIGURE COMES FROM A QUOTE IT WAS HANDED. Rows are matched to quotes BY KEY rather than by
 * position, so a reorder between quoting and approving cannot silently re-point a price at a
 * different shot.
 *
 * ⚠️ A MISSING QUOTE IS NOT FREE — AND A STILL IS NOT A MISSING QUOTE. A shot with no quote yet, and
 * a shot the server priced as `unpriced`, both block the board — `spendCaps` refuses an unpriced quote server-side, and a board that
 * silently dropped such a row from its total would show her a number smaller than what runs.
 *
 * ⚠️ AND NEITHER IS A MISSING CEILING. `limits` is what admission said (`null` until it has), and
 * `admissionRefusal` is admission's own sentence when it said no — the day ceiling, an expired check,
 * a board already run. Both block the board: there is no fallback number, so a board is never
 * approvable against a ceiling nobody told us.
 */
export function boardQuote(
  rows: StoryboardRow[],
  clipQuotes: RowQuote[],
  bridgeQuotes: RowQuote[],
  limits: BoardLimits | null,
  admissionRefusal: string | null = null,
): BoardQuote {
  const byKey = (qs: RowQuote[]) => new Map(qs.map((q) => [q.key, q]));
  const clips = byKey(clipQuotes);
  const bridges = byKey(bridgeQuotes);

  const perRow: QuotedRow[] = rows.map((row) => ({
    key: row.key,
    clip: clips.get(row.key) ?? null,
    bridge: row.bridgeRequested ? (bridges.get(row.key) ?? null) : null,
    held: isStillRow(row) ? (row.stillSec ?? null) : null,
    own: isClipRow(row) ? { seconds: clipPlays(row) } : null,
  }));

  const lines = perRow.flatMap((r) =>
    [r.clip, r.bridge].filter((q): q is RowQuote => q !== null),
  );
  const ceilingUsd = lines.reduce((n, q) => n + q.ceilingUsd, 0);
  const expectedUsd = lines.reduce((n, q) => n + q.expectedUsd, 0);

  // ⚠️ A STILL IS NOT A MISSING QUOTE. It has no clip quote because it has no clip — nothing is
  // made, so nothing is priced, and $0 is the one figure that is true of it. Counting it here would
  // hold a board with a held photo on "Still working out what this board costs" forever, and a
  // board of only stills would never price at all. Every OTHER row's missing quote still blocks.
  const missing = perRow.filter(
    (r) =>
      r.held === null &&
      r.own === null &&
      (r.clip === null || (r.bridge === null && rowWantsBridge(rows, r.key))),
  ).length;
  const unpriced = lines.filter((q) => q.unpriced).length;
  // Her words, from the server. Deduped: every piece of a board hits this wall at once, and the
  // sentence is about the product rather than about any one shot.
  const unavailable = lines.find((q) => q.unavailable)?.unavailable ?? null;

  // ⚠️ ORDER MATTERS. An unpriced board is refused BEFORE its total is compared to anything: a total
  // built from a quote that does not exist is a number with no meaning, and comparing it to a cap
  // would dress that up as a decision.
  const refusal =
    // ⚠️ FIRST, ahead of everything. "Still working out the cost" and "over the ceiling" are both
    // answers to "what will this cost", and neither is worth saying about a board that cannot run.
    unavailable
      ? unavailable
      : missing > 0
        ? "Still working out what this board costs — one moment."
        : unpriced > 0
          ? "We can't price one of these shots yet, so the board can't run."
          : // The server's own sentence — it names the ceiling and what is already spent today.
            admissionRefusal
            ? admissionRefusal
            : // An EMPTY board needs no ceiling: it costs nothing, and is the one $0.00 that is true.
              limits === null && lines.length > 0
              ? "Checking this board against today's limits — one moment."
              : limits !== null && ceilingUsd > limits.maxJobUsd
                ? `This board could cost up to ${money(ceilingUsd)}, over the ${money(limits.maxJobUsd)} ceiling. Remove a shot or a transition.`
                : null;

  return {
    perRow,
    ceilingUsd,
    expectedUsd,
    // ⚠️ AND NOT PRICED WHEN IT CANNOT RUN. A ceiling beside "not available" is a figure for a job
    // that will not happen; the surface renders no number while this is false.
    priced: missing === 0 && unpriced === 0 && unavailable === null,
    refusal,
  };
}

const rowWantsBridge = (rows: StoryboardRow[], key: string): boolean =>
  rows.find((r) => r.key === key)?.bridgeRequested === true;

/**
 * ─── WHERE A BOARD IS, ONCE IT HAS BEEN RUN ─────────────────────────────────────────────────────
 *
 * Phases come from `videoEntryLogic` (`VideoEntryPhase`) rather than being restated, so a board and
 * the Video tab cannot disagree about what "working" means. This reads them and says whether the
 * board as a whole is still moving.
 *
 * ⚠️ "SETTLED" IS NOT "SUCCEEDED". A board whose pieces have all stopped — some made, some failed —
 * is finished moving, and that is exactly when she should be offered the handoff for what DID get
 * made. Waiting for every piece to succeed would strand a board on one refusal and throw away work
 * already paid for, which is the same reason the run does not stop on the first error.
 */
export interface BoardProgress {
  /** Pieces asked for. Zero before she has run anything. */
  total: number;
  made: number;
  failed: number;
  /** Still expected to change on its own. */
  working: number;
  /** Every piece has stopped moving, and at least one was asked for. */
  settled: boolean;
  /** Something was made. The handoff is worth offering only when this is true. */
  hasClips: boolean;
}

export function boardProgress(
  phases: readonly ("queued" | "working" | "ready" | "failed" | "unknown")[],
): BoardProgress {
  const made = phases.filter((p) => p === "ready").length;
  const failed = phases.filter((p) => p === "failed" || p === "unknown").length;
  const working = phases.filter(
    (p) => p === "queued" || p === "working",
  ).length;
  return {
    total: phases.length,
    made,
    failed,
    working,
    settled: phases.length > 0 && working === 0,
    hasClips: made > 0,
  };
}
