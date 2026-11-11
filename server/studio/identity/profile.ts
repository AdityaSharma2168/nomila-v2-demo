/**
 * studio/identity/profile — her identity PACK and what was measured about it (PR 17, R-1/R-4).
 *
 * One row per athlete in `identity_profiles` (migrations/0067_identity_profile.sql). The row holds
 * asset IDS and NUMBERS: which photographs make up the pack, the face-box size and prominence
 * measured about each, her-vs-her band (min/max/pairs), and whether the stranger control passed.
 *
 * ─── ⚠️  NOTHING ABOUT HER FACE IS KEPT ────────────────────────────────────────────────────────
 *
 * No embedding, template, crop or box is written by this module or accepted by its types. Every
 * vector is made in memory by the calibration and dropped; only distances survive (qa/identity.ts,
 * "Legal"). `PackEntry` is deliberately closed — a caller cannot smuggle a vector in through it.
 *
 * ─── THE BAND IS ASSERTED ONLY WHEN THE CONTROL PASSED ──────────────────────────────────────────
 *
 * `bandFor` is the ONLY reader qa/identity.ts uses, and it answers null unless `control_passed` is
 * true AND a band is on the row. A band measured for the record on an athlete whose strangers
 * landed inside it is stored (R-4 "for the record") and never asserted (R-4 "flag-only").
 * ⚠️ MUTATIONS (profile.test): "a threshold is asserted before the stranger control passes" —
 * return the band when control_passed is null; "position() reads the profile row when control
 * failed" — return it when control_passed is false.
 *
 * TENANCY: every query filters by `athleteId`; the unique on athlete_id makes the upsert one row.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "../../db";
import { identityProfiles } from "../../../shared/schema";
import { PACK_MAX, PACK_MIN, type IdentityBand, type PackEntry } from "./types";

export { PACK_MAX, PACK_MIN, type IdentityBand, type PackEntry };

/** The instrument every number on the row came from. Pinned here; the row records it (R-5). */
export const EMBEDDER = "face-crop/multimodalembedding@001" as const;

export interface IdentityProfile {
  athleteId: string;
  pack: PackEntry[];
  /** Fewer than PACK_MIN entries. */
  incomplete: boolean;
  band: (IdentityBand & { measuredAt: string }) | null;
  /** Null until the stranger control has run for her. */
  controlPassed: boolean | null;
  controlMeasuredAt: string | null;
  embedder: string | null;
}

const NUM = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

/** The jsonb, read defensively: an entry that is not id + numbers is dropped, never trusted. */
export function parsePack(raw: unknown): PackEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PackEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.assetId !== "string") continue;
    const fv = o.faceVisibility;
    if (fv !== "clear" && fv !== "partial") continue;
    out.push({
      assetId: o.assetId,
      faceSizeFrac: NUM(o.faceSizeFrac),
      prominence: NUM(o.prominence) ?? 0,
      faceVisibility: fv,
      shotType: typeof o.shotType === "string" ? o.shotType : null,
    });
  }
  return out;
}

export async function readProfile(
  athleteId: string,
): Promise<IdentityProfile | null> {
  const [row] = await db
    .select()
    .from(identityProfiles)
    .where(eq(identityProfiles.athlete_id, athleteId))
    .limit(1);
  if (!row) return null;
  const pack = parsePack(row.pack);
  const min = NUM(row.band_min);
  const max = NUM(row.band_max);
  const band =
    min !== null &&
    max !== null &&
    row.band_pairs !== null &&
    row.band_measured_at
      ? {
          min,
          max,
          pairs: row.band_pairs,
          measuredAt: row.band_measured_at.toISOString(),
        }
      : null;
  return {
    athleteId,
    pack,
    incomplete: pack.length < PACK_MIN,
    band,
    controlPassed: row.control_passed,
    controlMeasuredAt: row.control_measured_at?.toISOString() ?? null,
    embedder: row.embedder,
  };
}

/**
 * Replace her pack. A new pack invalidates every measurement: the band and the control were about
 * the OLD photographs, so they are cleared here rather than left to be read against the wrong set.
 */
export async function writePack(
  athleteId: string,
  pack: PackEntry[],
): Promise<void> {
  const clean = parsePack(pack); // the closed shape, even from our own caller
  await db
    .insert(identityProfiles)
    .values({ athlete_id: athleteId, pack: clean })
    .onConflictDoUpdate({
      target: identityProfiles.athlete_id,
      set: {
        pack: clean,
        band_min: null,
        band_max: null,
        band_pairs: null,
        band_measured_at: null,
        control_passed: null,
        control_measured_at: null,
        embedder: null,
        updated_at: sql`now()`,
      },
    });
}

/** The calibration's face sizes, written back onto the SAME entries by id — numbers only. */
export async function writeFaceSizes(
  athleteId: string,
  sizes: Record<string, number | null>,
): Promise<void> {
  const current = await readProfile(athleteId);
  if (!current) return;
  const pack = current.pack.map((e) =>
    e.assetId in sizes ? { ...e, faceSizeFrac: sizes[e.assetId] } : e,
  );
  await db
    .update(identityProfiles)
    .set({ pack, updated_at: sql`now()` })
    .where(eq(identityProfiles.athlete_id, athleteId));
}

/** Her-vs-her band, for the record. Writing a band NEVER sets control_passed. */
export async function writeBand(
  athleteId: string,
  band: IdentityBand,
): Promise<void> {
  await db
    .update(identityProfiles)
    .set({
      band_min: String(band.min),
      band_max: String(band.max),
      band_pairs: band.pairs,
      band_measured_at: new Date(),
      embedder: EMBEDDER,
      updated_at: sql`now()`,
    })
    .where(eq(identityProfiles.athlete_id, athleteId));
}

/** The stranger control's answer. The only writer of `control_passed`. */
export async function writeControl(
  athleteId: string,
  passed: boolean,
): Promise<void> {
  await db
    .update(identityProfiles)
    .set({
      control_passed: passed,
      control_measured_at: new Date(),
      embedder: EMBEDDER,
      updated_at: sql`now()`,
    })
    .where(eq(identityProfiles.athlete_id, athleteId));
}

/**
 * The band qa/identity.ts may ASSERT for her — or null, and the global SAME_PERSON_BAND applies.
 * Null unless the control passed and a band is on the row. Pure over the profile so the rule is
 * testable without a database; `bandFor` is the db-backed form.
 */
export function assertableBand(
  profile: IdentityProfile | null,
): IdentityBand | null {
  if (!profile || profile.controlPassed !== true || !profile.band) return null;
  const { min, max, pairs } = profile.band;
  return { min, max, pairs };
}

export async function bandFor(athleteId: string): Promise<IdentityBand | null> {
  return assertableBand(await readProfile(athleteId));
}
