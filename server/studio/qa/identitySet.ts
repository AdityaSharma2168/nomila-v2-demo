/**
 * studio/qa/identitySet — who a GENERATED image of her is compared against (R0.b).
 *
 * An edit is compared against the root of its chain. A generate has no chain, so its face is
 * compared against two sets of her own photographs instead:
 *
 *   references    the person references the job was conditioned on, off the frozen brief
 *   identity-set  her library photographs the job was NOT conditioned on — HELD OUT, so a render that
 *                 merely copied a reference cannot score well against them. The production form of
 *                 the R0 probe's hand-picked held-out set (docs/plans/studio-generation-identity-plan.md).
 *
 * A generate with no person reference is not scored at all and returns no targets: nothing she
 * attached says the image is meant to be her, and an invented person scored against her library is a
 * stranger control, not an observation of her.
 *
 * TENANCY: the brief's reference ids were resolved from her rows when the job was built
 * (studio/brief.ts, JobReference). They are re-read here under `athleteId` anyway, and a row that is
 * not hers is dropped rather than compared — this module hands out GCS paths to be fetched, and a path
 * that did not come off her own row is not one it will hand out.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import { db } from "../../db";
import { generationJobs, mediaAssets } from "../../../shared/schema";
import type { JobReference } from "../brief";

export type ComparedAgainst = "references" | "identity-set";

export interface IdentityTarget {
  assetId: string;
  gcsPath: string;
  comparedAgainst: ComparedAgainst;
}

/**
 * Held-out photographs per scored generate. The R0 probe scored against four. Each one costs a face
 * box and an embedding on EVERY scored generate, because nothing about her face is kept between them
 * (qa/identity.ts, `observeGenerateIdentity`).
 */
export const IDENTITY_SET_SIZE = 4;

/** The calibration's selection rule (qa/labeledSet.ts, IDENTITY_REFERENCES): she is the subject. */
const MIN_PROMINENCE = 0.5;

export async function identityTargetsFor(
  jobId: string,
  athleteId: string,
): Promise<IdentityTarget[]> {
  const [job] = await db
    .select({ brief: generationJobs.brief })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.athlete_id, athleteId),
      ),
    )
    .limit(1);
  const briefRefs =
    (job?.brief as { job?: { references?: JobReference[] } } | undefined)?.job
      ?.references ?? [];
  const personIds = briefRefs
    .filter((r) => r.role === "person")
    .map((r) => r.mediaAssetId);
  if (personIds.length === 0) return [];

  const rows = await db
    .select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, athleteId),
        inArray(mediaAssets.id, personIds),
      ),
    );
  const references = personIds.flatMap((id): IdentityTarget[] => {
    const row = rows.find((r) => r.id === id);
    return row?.gcs_path
      ? [{ assetId: id, gcsPath: row.gcs_path, comparedAgainst: "references" }]
      : [];
  });
  if (references.length === 0) return [];

  // `vision` is model output written by lib/visionTag.ts. A non-numeric prominence reads as 0 rather
  // than failing the cast and taking the whole query down with it.
  const prominence = sql<number>`CASE WHEN jsonb_typeof(${mediaAssets.metadata}->'vision'->'athlete_prominence') = 'number' THEN (${mediaAssets.metadata}->'vision'->>'athlete_prominence')::float8 ELSE 0 END`;
  const heldOut = await db
    .select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.media_type, "IMAGE"),
        eq(mediaAssets.status, "stored"),
        isNotNull(mediaAssets.gcs_path),
        isNull(mediaAssets.deleted_at),
        // A PHOTOGRAPH of her, never a render: scored against an earlier generate, the renderer would
        // be measured against itself. `origin` rather than `generation_job_id`: it is NOT NULL and
        // CHECK-constrained, and studio/jobs.ts writes both on every render.
        ne(mediaAssets.origin, "generated"),
        sql`${mediaAssets.metadata}->'vision'->'athlete_present' = 'true'::jsonb`,
        sql`${prominence} >= ${MIN_PROMINENCE}`,
        // Every person id on the brief, resolved or not — a held-out photo is one she did not attach.
        notInArray(mediaAssets.id, personIds),
      ),
    )
    // Most prominent first, then a stable order, so the set does not reshuffle between her generates.
    .orderBy(desc(prominence), asc(mediaAssets.id))
    .limit(IDENTITY_SET_SIZE);

  return [
    ...references,
    ...heldOut.map(
      (r): IdentityTarget => ({
        assetId: r.id,
        gcsPath: r.gcs_path!,
        comparedAgainst: "identity-set",
      }),
    ),
  ];
}
