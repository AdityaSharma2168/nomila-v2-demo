/**
 * studio/edit/source — the photo an op transforms, and the ONE gate on it: the casting law, extended to
 * edits (PR 9). A reference with a person in it passes the existing her-verification before any op reads
 * it; a person-free one proceeds.
 *
 * ─── THE EXISTING HER-VERIFICATION IS THE TAGGER'S `subject` ────────────────────────────────────────
 *
 * There is no likeness check at upload (routes/media.ts runs SafeSearch and nothing about WHO). What the
 * app already decides about who is in a frame is the vision tagger's `subject` — the_athlete |
 * another_person | nobody — written to media_assets.metadata.vision with `athlete_present` derived from
 * it (lib/visionTag.ts; the enrichment eval's fix, 22 Sep 2026). The Agent's caster reads the same field
 * (studio/agent/subject.ts). So this gate reads it too, and nothing else — one rule, one implementation.
 *
 * FAIL-CLOSED (Adi's ruling, 23 Sep 2026):
 *
 *   nobody          proceeds — a product shot, a place; there is no one to verify.
 *   the_athlete     proceeds — her, by the same judgement the library already runs on.
 *   another_person  refused, `source_not_her` — not her photo to edit into something.
 *   untagged        refused, `source_unverified` — the tagger has not read it yet (a fresh upload is
 *                   untagged for a few seconds; the ad carousel waits for the tag before quoting).
 *
 * ⚠️ MUTATION (engine.test): let an untagged or another_person row through — "unverified person used
 * as op source" reds by name.
 *
 * HERS, FIRST. The row is read through `herPhoto` (studio/photoPredicate.ts) — hers, stored, not deleted,
 * top-level, a photograph — so another athlete's id and a missing id are one answer, and a row the
 * predicate excludes (PR 7's fetched references, once merged) is never a source.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import type { TagSubject } from "../../lib/visionTag";
import { libraryFieldsEnabled } from "../config";
import { herPhoto } from "../photoPredicate";
import { readStateOf } from "../referenceGate";

export type SourceRefusal =
  | "source_not_found"
  | "source_not_her"
  | "source_unverified"
  // PR 12 (ruling 2): with STUDIO_LIBRARY_FIELDS on, an unread row says WHY — pending keeps
  // `source_unverified`; a row enrichment set down reads as failed (oversize) or capped (attempts).
  | "source_read_failed"
  | "source_read_capped";

export interface VerifiedSource {
  id: string;
  gcsPath: string;
  origin: string;
  subject: TagSubject;
}

export const SOURCE_REFUSAL_COPY: Record<SourceRefusal, string> = {
  source_not_found: "We couldn't find that photo in your library.",
  source_not_her:
    "This photo shows someone who isn't you, so we won't edit it into something else. Pick a photo of you, or one with nobody in it.",
  source_unverified:
    "We're still checking who's in this photo. Give it a moment and try again.",
  source_read_failed:
    "We couldn't read this photo — it's too large to check — so we can't tell who's in it. Try a smaller copy.",
  source_read_capped:
    "We tried to read this photo several times and couldn't. Re-upload it to try again.",
};

/** The tagger's answer on a row, or null when it has not written one. Older rows carry only `athlete_present`. */
export function subjectOf(metadata: unknown): TagSubject | null {
  const vision = (metadata as { vision?: Record<string, unknown> } | null)
    ?.vision;
  if (!vision) return null;
  const s = vision.subject;
  if (s === "the_athlete" || s === "another_person" || s === "nobody") return s;
  // Pre-ternary rows: the boolean is all there is. True is her; false says nothing about WHO, so it is
  // "unverified" rather than "nobody" — the fail-closed side.
  return vision.athlete_present === true ? "the_athlete" : null;
}

/** The gate as a pure decision, so a test can walk every cell without a row. */
export function sourceDecision(
  subject: TagSubject | null,
): SourceRefusal | null {
  if (subject === null) return "source_unverified";
  if (subject === "another_person") return "source_not_her";
  return null;
}

/**
 * PR 12: an `source_unverified` row that enrichment has SET DOWN is not "give it a moment" — say so.
 * Flag-gated so the reason set is unchanged with the flag off. Pure; tested by the table.
 */
export function withReadState(
  refusal: SourceRefusal,
  metadata: unknown,
): SourceRefusal {
  if (refusal !== "source_unverified" || !libraryFieldsEnabled())
    return refusal;
  const state = readStateOf(metadata);
  if (state === "failed") return "source_read_failed";
  if (state === "capped") return "source_read_capped";
  return refusal;
}

/** Her photo, verified as a source — or the refusal. */
export async function verifiedSource(
  athleteId: string,
  assetId: string,
): Promise<
  { ok: true; source: VerifiedSource } | { ok: false; reason: SourceRefusal }
> {
  const [row] = await db
    .select({
      id: mediaAssets.id,
      gcs_path: mediaAssets.gcs_path,
      origin: mediaAssets.origin,
      metadata: mediaAssets.metadata,
    })
    .from(mediaAssets)
    .where(herPhoto(athleteId, eq(mediaAssets.id, assetId)))
    .limit(1);
  if (!row?.gcs_path) return { ok: false, reason: "source_not_found" };
  const subject = subjectOf(row.metadata);
  const refusal = sourceDecision(subject);
  if (refusal)
    return { ok: false, reason: withReadState(refusal, row.metadata) };
  return {
    ok: true,
    source: {
      id: row.id,
      gcsPath: row.gcs_path,
      origin: row.origin,
      subject: subject!,
    },
  };
}
