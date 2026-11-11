/**
 * studio/reference/store — her brand profiles (migration 0060; spec docs/specs/creative-architecture.md §5).
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `athleteId` is ALWAYS `req.athleteId` (or the in-process caller's equivalent). Every query below carries it
 * in the predicate, so another athlete's profile id resolves to nothing: not-yours is not-found. The catalog
 * brand is the one global row read here, and only to confirm it exists; a profile is never keyed by brand
 * alone. The analyses under a profile are written by the reference engine, and the table's composite FK
 * refuses one filed under another athlete's profile even if code forgets.
 *
 * ─── WHAT IS NOT HERE ───────────────────────────────────────────────────────────────────────────────────
 *
 * No route and no model call. Nothing on main imports this module yet: the profile route, and the planner
 * reading a profile, land with the wiring after PR 2 (docs/studio-brand-profiles-wiring-card.md).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  inboxBrands,
  studioBrandProfiles,
  studioReferenceAnalyses,
  type StudioBrandProfile,
} from "../../../shared/schema";

/** A profile name is a brand name: one line. */
export const MAX_NAME = 80;
/** Spec §5 brand_attributes are a handful of short words ("premium", "athletic", "confident"). */
export const MAX_ATTRIBUTES = 12;
export const MAX_ATTRIBUTE = 40;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BrandProfile {
  id: string;
  brandId: number | null;
  name: string;
  attributes: string[];
  createdAt: Date;
}

export type CreateProfileResult =
  | { ok: true; profile: BrandProfile }
  | {
      ok: false;
      reason:
        | "invalid_name"
        | "invalid_attributes"
        | "unknown_brand"
        | "exists";
    };

function toProfile(row: StudioBrandProfile): BrandProfile {
  return {
    id: row.id,
    brandId: row.brand_id,
    name: row.name,
    attributes: Array.isArray(row.attributes) ? row.attributes : [],
    createdAt: row.created_at,
  };
}

/** Trimmed, de-duplicated (case-insensitively) and bounded, or null when the list is not a list of short words. */
export function cleanAttributes(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTRIBUTES) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (typeof a !== "string") return null;
    const t = a.trim().replace(/\s+/g, " ");
    if (!t || t.length > MAX_ATTRIBUTE) return null;
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export async function createBrandProfile(
  athleteId: string,
  input: { name: string; brandId?: number | null; attributes?: unknown },
): Promise<CreateProfileResult> {
  const name =
    typeof input.name === "string"
      ? input.name.trim().replace(/\s+/g, " ")
      : "";
  if (!name || name.length > MAX_NAME)
    return { ok: false, reason: "invalid_name" };
  const attributes = cleanAttributes(input.attributes);
  if (!attributes) return { ok: false, reason: "invalid_attributes" };

  const brandId = input.brandId ?? null;
  if (brandId !== null) {
    const [brand] = await db
      .select({ id: inboxBrands.id })
      .from(inboxBrands)
      .where(eq(inboxBrands.id, brandId))
      .limit(1);
    if (!brand) return { ok: false, reason: "unknown_brand" };
  }

  // One profile per catalog brand, per athlete: uq_studio_brand_profiles_brand. ON CONFLICT DO NOTHING on
  // that partial index means a concurrent second create is an "exists", never a thrown 23505.
  const rows = await db
    .insert(studioBrandProfiles)
    .values({ athlete_id: athleteId, brand_id: brandId, name, attributes })
    .onConflictDoNothing()
    .returning();
  if (!rows[0]) return { ok: false, reason: "exists" };
  return { ok: true, profile: toProfile(rows[0]) };
}

/** Her profiles, newest first. */
export async function listBrandProfiles(
  athleteId: string,
): Promise<BrandProfile[]> {
  const rows = await db
    .select()
    .from(studioBrandProfiles)
    .where(eq(studioBrandProfiles.athlete_id, athleteId))
    .orderBy(desc(studioBrandProfiles.created_at));
  return rows.map(toProfile);
}

/** One of HER profiles, or null — another athlete's id is indistinguishable from a missing one. */
export async function getBrandProfile(
  athleteId: string,
  profileId: string,
): Promise<BrandProfile | null> {
  if (!UUID_RE.test(profileId)) return null;
  const [row] = await db
    .select()
    .from(studioBrandProfiles)
    .where(
      and(
        eq(studioBrandProfiles.id, profileId),
        eq(studioBrandProfiles.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return row ? toProfile(row) : null;
}

export interface ReferenceAnalysisRow {
  id: string;
  brandProfileId: string | null;
  sourceKind: string;
  role: string;
  /** As reference/schema.ts validated it when it was written. */
  decomposition: unknown;
  model: string;
  promptVersion: string;
  createdAt: Date;
}

/**
 * Her analyses, newest first: one profile's reference set, or every one of hers when `brandProfileId` is
 * omitted. The source is never returned — no asset id, no brief text — only what was read out of it.
 */
export async function listReferenceAnalyses(
  athleteId: string,
  brandProfileId?: string,
): Promise<ReferenceAnalysisRow[]> {
  if (brandProfileId !== undefined && !UUID_RE.test(brandProfileId)) return [];
  const rows = await db
    .select({
      id: studioReferenceAnalyses.id,
      brandProfileId: studioReferenceAnalyses.brand_profile_id,
      sourceKind: studioReferenceAnalyses.source_kind,
      role: studioReferenceAnalyses.role,
      decomposition: studioReferenceAnalyses.decomposition,
      model: studioReferenceAnalyses.model,
      promptVersion: studioReferenceAnalyses.prompt_version,
      createdAt: studioReferenceAnalyses.created_at,
    })
    .from(studioReferenceAnalyses)
    .where(
      brandProfileId === undefined
        ? eq(studioReferenceAnalyses.athlete_id, athleteId)
        : and(
            eq(studioReferenceAnalyses.athlete_id, athleteId),
            eq(studioReferenceAnalyses.brand_profile_id, brandProfileId),
          ),
    )
    .orderBy(desc(studioReferenceAnalyses.created_at));
  return rows;
}
