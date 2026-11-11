/**
 * studio/referenceGate — the casting law at the reference door (PR 12, R-5).
 *
 * What the app already decides about a photograph is the vision tagger's answer on the row
 * (lib/visionTag.ts, media_assets.metadata.vision). Two rules, read from it and nothing else:
 *
 *   1. AN UNREAD PHOTO IS NOT A REFERENCE. A `person` or `product` reference whose row carries no
 *      `vision` is refused before any quote — and the reason says WHY it is unread, because the
 *      three cases want three different things from her (ruling 2, 23 Sep 2026):
 *        pending   nothing recorded yet — a fresh upload tags within seconds; try again
 *        failed    set down as `oversize` (services/mediaEnrichment.ts) — it will never read as it is
 *        capped    set down after the attempt budget — a re-upload is the way back in
 *      An `object` reference is a thing she pointed at; the tagger says nothing useful about it and
 *      it passes as before.
 *   3. MADE HERE WITHOUT HER IS NOT HER (ruling 24 Sep 2026). A generated still or clip whose job
 *      carried no `person` reference of her cannot be her likeness, whatever the tagger says — the
 *      named prompt calls a generated stranger "the athlete" 15 times in 18 (ledger). The fact is the
 *      caster's `identity_bound` (agent/cast.ts S2), read deterministically off the generating job;
 *      null (no job, or a job that is not hers) does not refuse — it is unknown, not "not from her".
 *   2. NO FACE, NO LIKENESS. A `person` reference is her likeness; a row whose `face_visibility` is
 *      `none` cannot carry one. Read through `faceOf`, so a row tagged before the key existed falls
 *      back to what it does say (hers → partial → accepted): nothing refuses an old row for lacking a
 *      key that did not exist when it was tagged (R-3).
 *
 * Pure. The same decision serves the generation route's `resolveReferences` (routes/studio.ts) and
 * the edit engine's source gate (studio/edit/source.ts) for the read-state words. Flag-gated by the
 * CALLERS (STUDIO_LIBRARY_FIELDS); this module only decides.
 *
 * ⚠️ MUTATIONS (referenceGate.test, routes/studio.test):
 *   "an unclassified image reaches a generation call"      — return null for an unread row
 *   "a no-face photo is accepted as a person likeness ref"  — drop the face arm
 *   "an old row without face_visibility is refused"         — read `vision.face_visibility` raw
 *   "a made-here still with no person reference is accepted as a likeness reference" — drop rule 3
 *
 * PR 17 hooks its chooser at this boundary: `likenessDecision` is the ONE function every reference
 * role passes through before a quote exists; add a reason here, never a second check site.
 */
import { faceOf } from "../lib/visionTag";

export type ReferenceRefusal =
  | "reference_unread"
  | "reference_read_failed"
  | "reference_read_capped"
  | "likeness_no_face"
  | "likeness_not_from_her";

export const REFERENCE_REFUSAL_COPY: Record<ReferenceRefusal, string> = {
  reference_unread:
    "We're still reading this photo. Give it a moment and try again.",
  reference_read_failed:
    "We couldn't read this photo — it's too large to check — so it can't be a reference. Try a smaller copy.",
  reference_read_capped:
    "We tried to read this photo several times and couldn't. Re-upload it to try again.",
  likeness_no_face:
    "This photo doesn't show your face clearly enough to use as a likeness. Pick one where your face is visible.",
  likeness_not_from_her:
    "This was made here without a photo of you, so it can't stand in for you. Pick a photo of yourself.",
};

/** A row's provenance as the gate and the tile sources read it: where it came from, and whether its job carried her. */
export interface MadeFrom {
  origin: string | null;
  /** The caster's `identity_bound`: true when the generating job carried a `person` reference; false when it did not; null unknown. */
  identityBound: boolean | null;
}

/**
 * Made here, and the job carried no reference of her — deterministic, no model. The ONE predicate
 * both tile sources (studio/mediaList.ts, routes/media.ts) and the gate below read, so the label
 * "Made here · not from you" and the refusal can never disagree. Null identity (no job, not hers)
 * is unknown, never "not from her".
 */
export const madeHereNotHer = (m: MadeFrom | null | undefined): boolean =>
  m?.origin === "generated" && m.identityBound === false;

/**
 * TODAY'S RULE — "did this job make her?", as SQL text over a job's `brief` column (`gj.brief`, or
 * `"generation_jobs"."brief"` where the table is joined): the job's frozen references carry a `person` role. Main's
 * expression, byte for byte. With STUDIO_LIBRARY_FIELDS off it is the whole answer; with it on it is the chain rule's
 * answer for a row whose chain does not reach her upload (`CHAIN_IDENTITY_BOUND_SQL`).
 */
export function jobIdentityBoundOf(brief: string): string {
  return `coalesce(${brief} -> 'job' -> 'references', '[]'::jsonb) @> '[{"role":"person"}]'::jsonb`;
}

/**
 * The caster's identity-bound expression (agent/cast.ts S2), as a correlated subquery a list can
 * select without a join. NULL when the row has no job or the job is not hers. Raw SQL text on purpose —
 * it is spliced into two list queries and must be the same expression in both. Today's rule — the flag-off answer.
 */
export const IDENTITY_BOUND_SQL = `CASE WHEN media_assets.generation_job_id IS NULL THEN NULL ELSE (
  SELECT ${jobIdentityBoundOf("gj.brief")}
    FROM generation_jobs gj
   WHERE gj.id = media_assets.generation_job_id AND gj.athlete_id = media_assets.athlete_id) END`;

/** How far the chain rule walks `derived_from_asset_id` — qa/chain.ts's own cap. Deeper, or a cycle: today's rule. */
export const STANDING_CHAIN_DEPTH = 24;

/** Edits that re-render her face: a link of one inherits only when identity-on-accept ran on it AND passed. */
export const REFACING_OPS: readonly string[] = ["CAMERA", "RELIGHT"];

/**
 * THE CHAIN RULE — "is this made-here row her?" (PR 19, ADI-R19-BOARD, STUDIO_LIBRARY_FIELDS). One walk, correlated on
 * the outer `media_assets` row, every hop under that row's athlete id:
 *
 *   the chain reaches HER UPLOAD   (a root with no `derived_from_asset_id` and origin 'upload')
 *        → her standing ("you") — UNLESS a made-here link on the way was flagged by identity-on-accept
 *          (`metadata.edit_identity.status = 'flag'`, edit/identityOnAccept.ts), or is a CAMERA / RELIGHT edit
 *          (`brief.job.editIntent.changes[].op`) whose check did not run and pass. Every other edit — a model edit, a
 *          crop, a typed op — inherits unless flagged: no check means inherit. R-14's crop arm is this rule's case.
 *   any other chain                (a from-scratch root, a severed pointer, a cycle, deeper than the cap)
 *        → TODAY'S RULE on the row's own job (`jobIdentityBoundOf`), NULL when that job is not hers.
 *
 * NULL for a row with no generating job, exactly as `IDENTITY_BOUND_SQL`. ⚠️ MUTATIONS (routes/studio.test,
 * standingChain.test): answer today's rule for every row — "an edit of her upload is her" reds by name; drop the
 * refacing arm — "a camera edit with no passed check is not her" reds; drop the flag arm — "an edit whose accept flagged
 * drift is not her" reds.
 */
export const CHAIN_IDENTITY_BOUND_SQL = `CASE WHEN media_assets.generation_job_id IS NULL THEN NULL ELSE (
  WITH RECURSIVE link(id, origin, derived_from, job_id, check_status, depth) AS (
    SELECT a.id, a.origin, a.derived_from_asset_id, a.generation_job_id, a.metadata -> 'edit_identity' ->> 'status', 0
      FROM media_assets a
     WHERE a.id = media_assets.id AND a.athlete_id = media_assets.athlete_id
    UNION ALL
    SELECT p.id, p.origin, p.derived_from_asset_id, p.generation_job_id, p.metadata -> 'edit_identity' ->> 'status', l.depth + 1
      FROM media_assets p JOIN link l ON p.id = l.derived_from
     WHERE p.athlete_id = media_assets.athlete_id AND l.depth < ${STANDING_CHAIN_DEPTH}
  )
  SELECT CASE
    WHEN bool_or(l.derived_from IS NULL AND l.origin = 'upload') THEN NOT coalesce(bool_or(
      l.origin = 'generated' AND (
        l.check_status = 'flag'
        OR (l.check_status IS DISTINCT FROM 'pass' AND EXISTS (
          SELECT 1
            FROM generation_jobs lj,
                 jsonb_array_elements(coalesce(lj.brief -> 'job' -> 'editIntent' -> 'changes', '[]'::jsonb)) ch
           WHERE lj.id = l.job_id AND lj.athlete_id = media_assets.athlete_id
             AND ch ->> 'op' IN (${REFACING_OPS.map((o) => `'${o}'`).join(", ")}))))), false)
    ELSE (SELECT ${jobIdentityBoundOf("gj.brief")}
            FROM generation_jobs gj
           WHERE gj.id = media_assets.generation_job_id AND gj.athlete_id = media_assets.athlete_id)
  END
    FROM link l) END`;

/**
 * The ROOT of a row's `derived_from` chain (PR 19, the walk's duplicate-photo finding): the same walk as
 * `CHAIN_IDENTITY_BOUND_SQL` — scoped to the row's athlete, capped at STANDING_CHAIN_DEPTH — answering the id at its far
 * end. A photo and every edit of it (and every edit of an edit, and two edits of one upload) share it: the caster's
 * "one photo". A row derived from nothing is its own root. Spliced in a select over `media_assets`.
 */
export const CHAIN_ROOT_SQL = `(
  WITH RECURSIVE link(id, derived_from, depth) AS (
    SELECT a.id, a.derived_from_asset_id, 0
      FROM media_assets a
     WHERE a.id = media_assets.id AND a.athlete_id = media_assets.athlete_id
    UNION ALL
    SELECT p.id, p.derived_from_asset_id, l.depth + 1
      FROM media_assets p JOIN link l ON p.id = l.derived_from
     WHERE p.athlete_id = media_assets.athlete_id AND l.depth < ${STANDING_CHAIN_DEPTH}
  )
  SELECT l.id FROM link l ORDER BY l.depth DESC LIMIT 1)`;

/** The identity-bound expression a caller splices in: the chain rule with STUDIO_LIBRARY_FIELDS on, today's off. */
export const identityBoundSql = (chain: boolean): string =>
  chain ? CHAIN_IDENTITY_BOUND_SQL : IDENTITY_BOUND_SQL;

/**
 * THE TILE RANK (PR 12 ruling 3, amended 24 Sep 2026) — the one expression both lists sort on and
 * both cursors carry as the rank key. Tiers, top to bottom:
 *
 *   hero_suitability   a tagged row of her, or a scene — the tagger's own 0..1
 *   -1                 untagged ("not read yet")
 *   -1.5               SOMEONE ELSE: the tagger's `another_person`, or made here without her
 *                      (`madeHereNotHer`) — a stranger at hero 0.9 sat at the top of the strip
 *   -2                 disposition reject — offered, labelled, last; never hidden
 *
 * A reject that is also someone else is a reject. `rankOf` is the same table in TypeScript, for the
 * cursor of a list that did not select the column. ⚠️ MUTATION (studio.media.test, media.test
 * "a someone-else row ranks above her rows"): drop the -1.5 arm from both — reds by name.
 */
export const photoRankSql = (chain: boolean): string => `CASE
  WHEN media_assets.metadata -> 'vision' IS NULL THEN -1
  WHEN media_assets.metadata -> 'vision' ->> 'disposition' = 'reject' THEN -2
  WHEN media_assets.metadata -> 'vision' ->> 'subject' = 'another_person'
    OR (media_assets.origin = 'generated' AND (${identityBoundSql(chain)}) = false) THEN -1.5
  ELSE coalesce((media_assets.metadata -> 'vision' ->> 'hero_suitability')::float, -1) END`;

/** Today's rank — the flag-off expression, byte for byte (PR 19 made the identity arm a function of the flag). */
export const PHOTO_RANK_SQL = photoRankSql(false);

/** `PHOTO_RANK_SQL` as a function of a row: the same four tiers, for a list that computes the cursor in code. */
export function rankOf(
  vision: Record<string, unknown> | null,
  made: MadeFrom | null,
): number {
  if (!vision) return -1;
  if (vision.disposition === "reject") return -2;
  if (vision.subject === "another_person" || madeHereNotHer(made)) return -1.5;
  return typeof vision.hero_suitability === "number"
    ? vision.hero_suitability
    : -1;
}

export type ReadState = "read" | "pending" | "failed" | "capped";

/** What enrichment has recorded about a row: read, or why not yet (metadata.enrichment, mediaEnrichment.ts). */
export function readStateOf(metadata: unknown): ReadState {
  const m = (metadata ?? null) as {
    vision?: unknown;
    enrichment?: { abandoned_at?: unknown; abandoned_reason?: unknown };
  } | null;
  if (m?.vision && typeof m.vision === "object") return "read";
  const e = m?.enrichment;
  if (!e?.abandoned_at) return "pending";
  return e.abandoned_reason === "oversize" ? "failed" : "capped";
}

/** The vision object on a row, or null. */
export const visionOf = (metadata: unknown): Record<string, unknown> | null => {
  const v = (metadata as { vision?: unknown } | null)?.vision;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
};

/** The reason an unread row is refused, by its read state. Null for a read row. */
export function unreadRefusal(metadata: unknown): ReferenceRefusal | null {
  switch (readStateOf(metadata)) {
    case "read":
      return null;
    case "pending":
      return "reference_unread";
    case "failed":
      return "reference_read_failed";
    case "capped":
      return "reference_read_capped";
  }
}

/**
 * The gate: may this row be a reference in this role? Null = yes.
 * `role` is the request's word — person | product | object (studio/brief.ts ReferenceRole).
 */
export function likenessDecision(
  metadata: unknown,
  role: string,
  made?: MadeFrom | null,
  /**
   * Rule 2, the face arm. PR 19 (ADI-R19-FACE, STUDIO_IMAGE_OPS): "face visibility never rejects" — the generation
   * route's reference door passes false with the switch on, so a real photo of her with an unclear face is used for
   * what she asked. Default true: every other caller (the identity pack's gate) decides exactly as before. Rules 1
   * and 3 — unread, and "Made here · not from you" — are unchanged either way.
   *
   * `madeHereRefuses`, rule 3's arm. PR 19 (ADI-R19-BOARD3): a shot she set on her Board, or an image she chose in Create
   * Anything, runs as she set it — "Made here · not from you" is a LABEL there, never a refusal — so the generation
   * route's reference door passes false. Default true: every other caller decides exactly as before (the identity pack
   * keeps generated rows out on its own `origin` check, packGate.ts, whatever this says).
   */
  opts: { faceRejects?: boolean; madeHereRefuses?: boolean } = {},
): ReferenceRefusal | null {
  if (role !== "person" && role !== "product") return null;
  const unread = unreadRefusal(metadata);
  if (unread) return unread;
  // Rule 3 first: a generated stranger reads as her to the tagger, so the tag is not consulted.
  if (
    opts.madeHereRefuses !== false &&
    role === "person" &&
    madeHereNotHer(made)
  )
    return "likeness_not_from_her";
  if (
    opts.faceRejects !== false &&
    role === "person" &&
    faceOf(visionOf(metadata)) === "none"
  )
    return "likeness_no_face";
  return null;
}
