/**
 * studio/agent/entryPrompt — the capability library as the planner reads it, and the reasons it
 * writes back (PR 6, 6a2).
 *
 * The prompt's per-kind prose is gone: what each thing does, needs, costs and risks is RENDERED from
 * the committed entries (studio/agent/capabilityEntries), one line each, so an entry changed in a
 * reviewed diff changes what the planner reads with no second copy to drift. Prices are read from the
 * registry at render time. i2v's demotion is its cost and its likeness risk, stated beside $0 held
 * photos — and A1b, S1, S1b, S1c and A2 stay hard vetoes in cast.ts whatever the planner prefers.
 *
 * ─── A REASON IS CHECKED, NOT TRUSTED ───────────────────────────────────────────────────────────
 *
 * Every item names the entry it was chosen from. An entry that is not in the library, or not this
 * item's kind, NULLS the reason (the item stays — an adjective is not a kind) and is reported by
 * value so derivePlan logs it. ⚠️ MUTATION (entryPrompt.test): accept any entry id — "reason names an
 * entry not in the library" reds by name.
 *
 * ─── NAMES STAY IN THEIR FIELD ──────────────────────────────────────────────────────────────────
 *
 * "dolly" is a held photo's push-in (`image.motion`) AND a generated shot's camera (`movement`). The
 * block below writes a motion only as `image.motion` or `"motion": "…"` on an image item; the
 * capabilities list writes it only after `movement:`. A test holds every "dolly" in the prompt to one
 * of those two (decision 1, PR 6).
 */
import { MUSIC_TRACKS, isTrackId, type TrackDefinition } from "../music/tracks";
import { FOCUSED_MOTIONS, STILL_LOOKS, isStillLook } from "../video/still";
import { STITCH_BEDS, isBedName } from "../video/beds";
import {
  STILL_MOTIONS,
  readStillMotion,
  type StillMotion,
} from "../video/stillMotion";
import {
  CAPABILITY_ENTRIES,
  entryById,
  type CapabilityEntry,
} from "./capabilityEntries";
import { INSTAGRAM_LABEL, PROVENANCE_LABEL } from "./provenance";
import type { ItemReason, PlanItemKind, PlanLook, PlanMusic } from "./types";
import { capWords } from "../text";
import { costWords } from "./entryCost";
import {
  renderCapabilityBlock,
  type CapabilityBlockOptions,
} from "./capabilityBlock";

export { costWords };

const MAX_FITS = 160;

/** What choosing an entry writes, in the plan's own field words. */
function target(e: CapabilityEntry): string {
  if (e.field === "item.kind") {
    const from =
      e.provenance === null
        ? ""
        : ` on a CLIP line "from: ${e.id === "clip.her_instagram" ? INSTAGRAM_LABEL : PROVENANCE_LABEL[e.provenance]}"`;
    return `an item with "kind": "${e.wire}"${from}`;
  }
  if (e.field === "image.motion")
    return `image.motion — "motion": "${e.wire}" on an "image" item`;
  if (e.field === "plan.music") return `plan-level "music" — a ${e.wire}`;
  return `plan-level "${e.wire}"`;
}

/** One entry, one line: what it is, what it takes, what it costs, what it risks, what was measured. */
export const entryLine = (e: CapabilityEntry): string =>
  [
    `- ${e.id} → ${target(e)}`,
    `does: ${e.does}`,
    `needs: ${e.needs}`,
    `cost: ${costWords(e)}`,
    `likeness risk: ${e.likenessRisk}`,
    `works: ${e.whenItWorks}`,
    ...(e.failureModes.length ? [`fails: ${e.failureModes.join(" ")}`] : []),
    `${e.reliability.measured ? "measured" : "NOT measured"}: ${e.reliability.summary}`,
  ].join(" | ");

/** Any catalogue of tracks — the committed one, or a test's (suggestMusic's own seam). */
type Tracks = Readonly<Record<string, TrackDefinition>>;

/**
 * The tracks and beds she may be given, as one line each — brand work sees only brandSafe tracks.
 * `brand` is decided upstream by studio/music/suggest.ts `brandWorkFor` (PR 10, R-2): off the brief and
 * the deal, and off the purpose chip only when there is neither.
 */
function musicCatalogue(brand: boolean, catalogue: Tracks): string[] {
  const tracks = Object.entries(catalogue)
    .filter(([, t]) => !brand || t.brandSafe)
    .map(
      ([id, t]) =>
        `    track ${id}: ${t.bpm} BPM, ${t.moods.join("/")}, energy ${t.energy} of 5`,
    );
  const beds = Object.entries(STITCH_BEDS)
    .filter(([, b]) => b.listed)
    .map(
      ([id, b]) =>
        `    bed ${id}: ${b.beat ? `${b.beat.bpm} BPM, ` : ""}${b.note}`,
    );
  return [...tracks, ...beds];
}

/**
 * The capability block, two ways (capability layer v3 §3):
 *
 *   capabilityBlock({ surface, format, forBrand, moment, env, … })  the generated block any planner reads — only the
 *        entries on that surface that are on here and relevant to this post, grouped by job, automatic ones stated,
 *        paid ones under "she decides", the ones that are off named once at the end (capabilityBlock.ts).
 *   capabilityBlock(kinds, forBrand, tracks?)  the Board's block, byte for byte as Aditya's planner reads it
 *        (pinned by a snapshot in capabilityBlock.test.ts) until the Board moves onto the generated form.
 */
export function capabilityBlock(opts: CapabilityBlockOptions): string;
export function capabilityBlock(
  kinds: readonly PlanItemKind[],
  forBrand: boolean,
  tracks?: Tracks,
): string;
export function capabilityBlock(
  kindsOrOpts: readonly PlanItemKind[] | CapabilityBlockOptions,
  forBrand?: boolean,
  tracks: Tracks = MUSIC_TRACKS,
): string {
  if (!Array.isArray(kindsOrOpts))
    return renderCapabilityBlock(kindsOrOpts as CapabilityBlockOptions);
  return boardBlock(kindsOrOpts, forBrand === true, tracks);
}

/**
 * The Board's block. Item entries only for the kinds this plan may use (product only with a product);
 * nothing the Board cannot hold (captions, text graphics — the PR 6 gap list); plan-level music and
 * look after the items.
 */
function boardBlock(
  kinds: readonly PlanItemKind[],
  forBrand: boolean,
  tracks: Tracks,
): string {
  const onBoard = CAPABILITY_ENTRIES.filter((e) => e.onBoard);
  const items = onBoard.filter(
    (e) =>
      e.field === "item.kind" &&
      e.itemKind !== null &&
      kinds.includes(e.itemKind),
  );
  const motions = kinds.includes("image")
    ? onBoard.filter((e) => e.field === "image.motion")
    : [];
  const plan = onBoard.filter(
    (e) => e.field === "plan.music" || e.field === "plan.look",
  );
  return [
    `WHAT YOU CAN PLAN — the capability library. One line per thing this app can make: what it does, what it needs, what it costs, how likely it is to draw someone who is not her ("likeness risk"), and what was measured. Plan against these lines, and name the one each choice came from in its "reason". A line's cost and risk are real: a $0 line that carries the moment beats a paid one that carries it no better.`,
    ...items.map(entryLine),
    ...motions.map(entryLine),
    ...plan.map(entryLine),
    `  music you may name:`,
    ...musicCatalogue(forBrand, tracks),
    `  looks you may name: ${STILL_LOOKS.join(" | ")}`,
  ].join("\n");
}

// ─── Parsing what the planner wrote back ────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const line = (v: unknown, max: number): string => {
  if (typeof v !== "string") return "";
  return capWords(v, max);
};

/** Whether an entry may be the reason for an item of this kind. An image's reason is held or a move. */
const entryFitsKind = (e: CapabilityEntry, kind: PlanItemKind): boolean =>
  e.field === "item.kind"
    ? e.itemKind === kind
    : kind === "image" && e.field === "image.motion";

export interface ParsedReason {
  reason: ItemReason | null;
  /** The entry id the model wrote when it was not a library entry of this kind — for the log. */
  outside: string | null;
  /**
   * What the model wrote as `over` when it was not an entry id — dropped, and logged, so a run can
   * tell "the planner skipped it" from "the planner wrote a phrase" (Adi's question on 6a2).
   */
  overOutside: string | null;
}

/**
 * An item's reason: kept only when its entry is in the library AND of this item's kind. `over` is
 * kept only when it too names an entry. ⚠️ MUTATION: drop the `entryById` check — "reason names an
 * entry not in the library" reds by name.
 */
export function parseReason(raw: unknown, kind: PlanItemKind): ParsedReason {
  if (!isObject(raw) || typeof raw.entry !== "string")
    return { reason: null, outside: null, overOutside: null };
  const e = entryById(raw.entry);
  if (!e || !entryFitsKind(e, kind))
    return {
      reason: null,
      outside: raw.entry.slice(0, 40),
      overOutside: null,
    };
  const over =
    typeof raw.over === "string" && entryById(raw.over) ? raw.over : null;
  const overOutside =
    typeof raw.over === "string" && raw.over.trim() && over === null
      ? raw.over.slice(0, 40)
      : null;
  return {
    reason: { entry: e.id, fits: line(raw.fits, MAX_FITS), over },
    outside: null,
    overOutside,
  };
}

const planReason = (
  raw: unknown,
  ids: readonly string[],
): ItemReason | null => {
  if (
    !isObject(raw) ||
    typeof raw.entry !== "string" ||
    !ids.includes(raw.entry)
  )
    return null;
  const over =
    typeof raw.over === "string" && entryById(raw.over) ? raw.over : null;
  return { entry: raw.entry, fits: line(raw.fits, MAX_FITS), over };
};

/** An image item's move — any of the four, "pan" read as dolly — or null on any other kind. */
export const parseMotion = (
  raw: unknown,
  kind: PlanItemKind,
): StillMotion | null => (kind === "image" ? readStillMotion(raw) : null);

/** A focus point beside a focused move: both fractions in 0..1, or null (the framing prior). */
export function parseFocus(
  raw: unknown,
  motion: StillMotion | null,
): { x: number; y: number } | null {
  if (
    !(FOCUSED_MOTIONS as readonly (string | null)[]).includes(motion) ||
    !isObject(raw)
  )
    return null;
  const { x, y } = raw;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

/** The plan's look: one of STILL_LOOKS, or null. */
export function parseLook(raw: unknown): PlanLook | null {
  if (!isObject(raw) || !isStillLook(raw.value)) return null;
  return { value: raw.value, reason: planReason(raw.reason, ["look"]) };
}

/**
 * The plan's music: a listed bed or a track, or null. FAIL-CLOSED on brand work, the recommender's
 * own rule (studio/music/suggest.ts `brandWorkFor`, decided by the caller): a track that is not
 * brandSafe is dropped, never kept. ⚠️ MUTATION: skip the brandSafe check — "brand work never gets a track that is not
 * brandSafe" reds by name.
 */
export function parseMusic(
  raw: unknown,
  forBrand: boolean,
  tracks: Tracks = MUSIC_TRACKS,
): PlanMusic | null {
  if (!isObject(raw) || typeof raw.name !== "string") return null;
  const name = raw.name;
  const track = Object.prototype.hasOwnProperty.call(tracks, name)
    ? tracks[name]
    : undefined;
  if (track) {
    if (forBrand && !track.brandSafe) return null;
  } else if (
    !(isBedName(name) && !isTrackId(name) && STITCH_BEDS[name].listed)
  ) {
    return null;
  }
  return {
    name,
    onBeat: raw.onBeat === true,
    reason: planReason(raw.reason, [track ? "music.track" : "music.bed"]),
  };
}

/** The four moves, for the field list's words. */
export const MOTION_WORDS = STILL_MOTIONS.map((m) => `"${m}"`).join(" | ");
