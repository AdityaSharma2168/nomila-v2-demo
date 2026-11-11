/**
 * context/legacyAdapter.ts — the ONLY code that parses `athlete_snapshots.research` or reads the
 * projection columns for display (design §3.1; D2 locked). Compatibility data, not evidence: every
 * value it produces is `origin legacy_blob` (or `legacy_row` for athletes.* columns), `sourceClass null`,
 * `authorityTier null`, `lineage legacy`, `freshness unknown`, dated by the snapshot's `as_of`
 * (NULL = unknown, never today). Fixes D4 (reads `profile.*`) and drops D5 (`values/causes`) here, once.
 * Deleted in Step 4 with the blob.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athletes, athleteSnapshots, athletesCurrent } from "../../../../shared/schema";
import type { Evidence, Fact, Inference } from "./contract";

export interface LegacyRow {
  fullName: string; firstName: string | null; lastName: string | null;
  sport: string | null; school: string | null; division: string | null; conference: string | null; segment: string | null;
  careerStatus: string; photoUrl: string | null; socials: Record<string, string>; createdAt: string | null;
  goalArchetype: string | null; secondaryGoals: unknown; brandVoice: unknown; status: string;
}

export interface LegacyBlob {
  present: boolean;
  /** The research as-of (athlete_snapshots.as_of); null = unknown. NEVER the carry-forward's created_at. */
  asOf: string | null;
  /** The snapshot's created_at — exposed only for parity with legacy readers that (wrongly) date by it. */
  snapshotCreatedAt: string | null;
  achievements: Fact<{ name: string; year: string | number | null; level: string | null; key: string }>[];
  press: Evidence<{ outlet: string | null; headline: string | null }>[];
  brandMentions: Evidence<{ brand: string; type: string | null; confidence: number | null }>[];
  position: Fact<{ text: string }> | null;
  classYear: Fact<{ label: string; season: number }> | null;
  hometown: Fact<{ city?: string | null; region?: string | null; country?: string | null }> | null;
  storyArc: Inference<string> | null;
  sentiment: Inference<unknown> | null;
  /** research.social_handles — the blob's handles (discovery fallback today); lowest rank. */
  socialHandles: Record<string, string>;
  /** The raw blob, for the deck view's `research` passthrough only (legacy parity). Never parsed elsewhere. */
  raw: Record<string, unknown> | null;
}

const legacyFact = <T>(value: T, asOf: string | null, key: string, status: Fact["status"] = "current"): Fact<T> =>
  ({ value, origin: "legacy_blob", sourceClass: null, authorityTier: null, status, retrievedAt: asOf, evidenceIds: [], freshness: "unknown", factKey: key });
const legacyEvidence = <T>(value: T, asOf: string | null): Evidence<T> => ({ value, sourceClass: null, sourceType: null, retrievedAt: asOf, lineage: "legacy" });

export async function readLegacyRow(athleteId: string): Promise<LegacyRow | null> {
  const [a] = await db.select({
    full_name: athletes.full_name, first_name: athletes.first_name, last_name: athletes.last_name, sport: athletes.sport, school: athletes.school,
    division: athletes.division, conference: athletes.conference, segment: athletes.segment, career_status: athletes.career_status, photo_url: athletes.photo_url,
    socials: athletes.socials, created_at: athletes.created_at, goal_archetype: athletes.goal_archetype, secondary_goals: athletes.secondary_goals, brand_voice: athletes.brand_voice, status: athletes.status,
  }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return null;
  const socials: Record<string, string> = {};
  for (const [k, v] of Object.entries((a.socials ?? {}) as Record<string, unknown>)) if (typeof v === "string" && v.trim()) socials[k] = v.trim();
  return { fullName: a.full_name, firstName: a.first_name, lastName: a.last_name, sport: a.sport, school: a.school, division: a.division, conference: a.conference, segment: a.segment, careerStatus: a.career_status ?? "active", photoUrl: a.photo_url, socials, createdAt: a.created_at?.toISOString() ?? null, goalArchetype: a.goal_archetype, secondaryGoals: a.secondary_goals, brandVoice: a.brand_voice, status: a.status };
}

/** The latest research blob, mapped to contract shapes. `story_arc` prefers athletes_current (what legacy readers show). */
export async function readLegacyBlob(athleteId: string): Promise<LegacyBlob> {
  const [snap] = await db.select({ research: athleteSnapshots.research, created_at: athleteSnapshots.created_at, as_of: athleteSnapshots.as_of })
    .from(athleteSnapshots).where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.research} IS NOT NULL`))
    .orderBy(desc(athleteSnapshots.created_at)).limit(1);
  const [cur] = await db.select({ story_arc: athletesCurrent.story_arc, research_updated_at: athletesCurrent.research_updated_at }).from(athletesCurrent).where(eq(athletesCurrent.athlete_id, athleteId)).limit(1);
  const r = (snap?.research ?? null) as Record<string, any> | null;
  const asOf = snap?.as_of?.toISOString() ?? null;
  const empty: LegacyBlob = { present: false, asOf, snapshotCreatedAt: snap?.created_at?.toISOString() ?? null, achievements: [], press: [], brandMentions: [], position: null, classYear: null, hometown: null, storyArc: null, sentiment: null, socialHandles: {}, raw: null };
  const storyText = (cur?.story_arc ?? r?.story_arc ?? null) as string | null;
  const storyArc = storyText ? { value: storyText, producer: "legacy_research", taxonomyVersion: null, computedAt: cur?.research_updated_at?.toISOString() ?? asOf, lineage: { runId: null, evidenceIds: [] }, legacy: true } as Inference<string> : null;
  if (!r) return { ...empty, storyArc };
  const profile = (r.profile && typeof r.profile === "object" ? r.profile : {}) as Record<string, unknown>;
  const pick = (k: string) => (profile[k] ?? r[k]) as unknown;   // D4: the producer writes under profile.*; the old readers looked at the top level
  const position = typeof pick("position") === "string" && String(pick("position")).trim() ? legacyFact({ text: String(pick("position")).trim() }, asOf, "position") : null;
  const cy = pick("class_year");
  const classYear = cy != null && String(cy).trim() ? legacyFact({ label: String(cy).trim(), season: Number(/\b(20\d{2})\b/.exec(String(cy))?.[1] ?? 0) }, asOf, "class_year") : null;
  const ht = pick("hometown");
  const hometown = typeof ht === "string" && ht.trim() ? legacyFact({ city: ht.trim(), region: null, country: null }, asOf, "hometown") : null;
  const socialHandles: Record<string, string> = {};
  for (const [k, v] of Object.entries((r.social_handles ?? {}) as Record<string, unknown>)) if (typeof v === "string" && v.trim()) socialHandles[k === "twitter" ? "x" : k] = v.trim().replace(/^@/, "");
  return {
    present: true, asOf, snapshotCreatedAt: snap?.created_at?.toISOString() ?? null,
    achievements: ((r.achievements ?? []) as any[]).filter((x) => x && typeof x.name === "string" && x.name.trim()).map((x) => legacyFact({ name: String(x.name).trim(), year: x.year ?? null, level: typeof x.level === "string" ? x.level : null, key: "achievement" }, asOf, "achievement", "historical")),
    press: ((r.press_mentions ?? []) as any[]).filter((x) => x && (x.outlet || x.headline)).map((x) => legacyEvidence({ outlet: x.outlet ? String(x.outlet) : null, headline: x.headline ? String(x.headline) : null }, asOf)),
    brandMentions: ((r.brand_mentions ?? []) as any[]).filter((x) => x && typeof x.brand === "string" && x.brand.trim()).map((x) => legacyEvidence({ brand: String(x.brand).trim(), type: typeof x.type === "string" ? x.type : null, confidence: typeof x.confidence === "number" ? x.confidence : null }, asOf)),
    position, classYear, hometown, storyArc,
    sentiment: r.sentiment ? { value: r.sentiment, producer: "legacy_research", taxonomyVersion: null, computedAt: asOf, lineage: { runId: null, evidenceIds: [] }, legacy: true } : null,
    socialHandles, raw: r,
  };
}
