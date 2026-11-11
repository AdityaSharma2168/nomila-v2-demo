/**
 * studio/identity/packGate — may this photograph be in her identity PACK? (PR 17, R-2)
 *
 * Pure. Reads the tagger's answer on the row (media_assets.metadata.vision, lib/visionTag.ts) and
 * the row's `origin`, and nothing else. The PR 12 likeness gate (studio/referenceGate.ts
 * `likenessDecision`) is REUSED for the read-state and no-face arms — imported, never forked or
 * edited — and this module adds the arms a pack needs that a single reference does not:
 *
 *   generated     origin = generated. A render of her is not a photograph of her; a pack made of
 *                 renders would calibrate the ruler against its own output. This arm runs BEFORE
 *                 the PR 12 gate, so #584's "made here without her" (likeness_not_from_her) is a
 *                 strict subset of it here: covered by construction, never reached.
 *   not_you       subject ≠ the_athlete. "Hers to use" is not "of her" (referencePack.ts,
 *                 PERSON_PACK_RULE); a teammate in her library is a stranger to this instrument.
 *   rejected      disposition = reject. Unusable for the kit is unusable for calibration.
 *   face_partial  face_visibility = partial. Accepted ONLY when fewer than PACK_MIN clear faces
 *                 exist (`selectPack`), and the profile says so.
 *
 * Every refusal names its reason; the surface shows it beside the tile.
 *
 * ⚠️ MUTATIONS (packGate.test), red by name:
 *   "pack accepts a photo with no face"   — drop the likenessDecision call
 *   "pack accepts a generated photo"      — drop the origin arm
 *   "pack accepts someone else"           — drop the subject arm
 */
import { faceOf } from "../../lib/visionTag";
import {
  likenessDecision,
  visionOf,
  type ReferenceRefusal,
} from "../referenceGate";
import { isBodyShot, PACK_MAX, PACK_MIN, type PackEntry } from "./types";

export type PackRefusal =
  | ReferenceRefusal
  | "generated"
  | "not_you"
  | "rejected"
  | "face_partial";

export const PACK_REFUSAL_COPY: Record<PackRefusal, string> = {
  reference_unread:
    "We're still reading this photo. Give it a moment and try again.",
  reference_read_failed:
    "We couldn't read this photo — it's too large to check — so it can't be in your pack.",
  reference_read_capped:
    "We tried to read this photo several times and couldn't. Re-upload it to try again.",
  likeness_no_face:
    "Your face isn't visible in this one. Pick a photo where it is.",
  // #584's rule 3 (a render made here without her). Unreachable from this gate — the `origin`
  // arm refuses EVERY generated row first, with or without her — but the union carries it, so the
  // copy is total. Kept as PR 12's own sentence.
  likeness_not_from_her:
    "This was made here without a photo of you, so it can't stand in for you. Pick a photo of yourself.",
  generated:
    "This was made here, not photographed. Your pack is photos of you only.",
  not_you:
    "This doesn't look like a photo of you. Your pack is photos of you only.",
  rejected:
    "This one was set aside as unusable, so it can't anchor your likeness.",
  face_partial:
    "Your face is only partly visible here. It can fill in if fewer than ten clear ones exist.",
};

export interface PackCandidateRow {
  assetId: string;
  origin: string;
  metadata: unknown;
}

export interface PackDecision {
  assetId: string;
  refusal: PackRefusal | null;
  /** Present on an accepted row and on a `face_partial` one — what the entry would carry. */
  entry: PackEntry | null;
}

/** One row, judged. `refusal` null = accepted outright. */
export function packDecision(row: PackCandidateRow): PackDecision {
  const no = (refusal: PackRefusal, entry: PackEntry | null = null) => ({
    assetId: row.assetId,
    refusal,
    entry,
  });
  if (row.origin === "generated") return no("generated");
  // PR 12's gate, for the read state and the no-face arm. Reused, not re-derived.
  const prior = likenessDecision(row.metadata, "person");
  if (prior) return no(prior);
  const vision = visionOf(row.metadata);
  const subject = vision?.subject;
  const present = vision?.athlete_present === true;
  if (subject !== "the_athlete" && !(subject === undefined && present))
    return no("not_you");
  if (vision?.disposition === "reject") return no("rejected");
  const face = faceOf(vision);
  if (face !== "clear" && face !== "partial") return no("likeness_no_face");
  const prominence =
    typeof vision?.athlete_prominence === "number"
      ? vision.athlete_prominence
      : 0;
  const entry: PackEntry = {
    assetId: row.assetId,
    faceSizeFrac: null,
    prominence,
    faceVisibility: face,
    shotType: typeof vision?.shot_type === "string" ? vision.shot_type : null,
  };
  if (face === "partial") return no("face_partial", entry);
  return { assetId: row.assetId, refusal: null, entry };
}

export interface PackSelection {
  pack: PackEntry[];
  refused: { assetId: string; refusal: PackRefusal }[];
  /** Fewer than PACK_MIN made it in. */
  incomplete: boolean;
  /** Partial faces were admitted because fewer than PACK_MIN clear ones existed. */
  partialAdmitted: boolean;
  /** Accepted rows past PACK_MAX, dropped in her order. */
  overCap: string[];
  /**
   * No body-bearing shot (action / lifestyle / full-body) made it in. Non-blocking: the save goes
   * through and the surface nudges — "add a full-length photo so your build carries too".
   * ⚠️ MUTATION (packGate.test "pack saves silently with no body shot"): drop this field.
   */
  noBodyShot: boolean;
}

/**
 * Her chosen rows → the pack. Clear faces first, in her order; partial faces only when the clear
 * ones fall short of PACK_MIN, and then only up to it; PACK_MAX caps the whole.
 */
export function selectPack(rows: PackCandidateRow[]): PackSelection {
  const decisions = rows.map(packDecision);
  const clear = decisions.filter((d) => !d.refusal && d.entry);
  const partial = decisions.filter(
    (d) => d.refusal === "face_partial" && d.entry,
  );
  const refused = decisions
    .filter((d) => d.refusal && d.refusal !== "face_partial")
    .map((d) => ({ assetId: d.assetId, refusal: d.refusal! }));

  let chosen = clear.map((d) => d.entry!);
  let partialAdmitted = false;
  if (chosen.length < PACK_MIN && partial.length) {
    const room = PACK_MIN - chosen.length;
    chosen = [...chosen, ...partial.slice(0, room).map((d) => d.entry!)];
    partialAdmitted = true;
    for (const d of partial.slice(room))
      refused.push({ assetId: d.assetId, refusal: "face_partial" });
  } else {
    for (const d of partial)
      refused.push({ assetId: d.assetId, refusal: "face_partial" });
  }
  const overCap = chosen.slice(PACK_MAX).map((e) => e.assetId);
  const pack = chosen.slice(0, PACK_MAX);
  return {
    pack,
    refused,
    incomplete: pack.length < PACK_MIN,
    partialAdmitted,
    overCap,
    noBodyShot: pack.length > 0 && !pack.some((e) => isBodyShot(e.shotType)),
  };
}
