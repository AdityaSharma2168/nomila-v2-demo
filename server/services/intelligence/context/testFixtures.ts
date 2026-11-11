/**
 * testFixtures.ts — the two athlete shapes the 2d tests need (design §3.4 G1: "PGlite fixtures for the
 * legacy blob shape (incl. profile.*, missing values) and for the canonical shape"). Not a *.test.ts.
 *
 *   seedLegacyAthlete     no research state, one legacy blob (D4 shape: position/class_year/hometown under
 *                         profile.*; no values/causes), projection == ledger, entered handles, a said assertion
 *   seedCanonicalAthlete  research_complete, canonical facts / evidence / inference / identities, PLUS a stale
 *                         legacy blob holding Brand X and a blob achievement that must never surface (G5b)
 */

import { eq } from "drizzle-orm";
import { db, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteAffiliations, athleteAsserted, athleteFacts, athleteInferences, athleteResearchState, athletes, athleteSnapshots, athletesCurrent, researchEvidence, researchRuns, socialIdentities } from "../../../../shared/schema";

export const T0 = new Date("2026-08-01T12:00:00Z");   // the legacy research moment (created_at == as_of)
export const T1 = new Date("2026-09-01T00:00:00Z");   // the canonical research moment
export const OLD = new Date("2020-01-01T00:00:00Z");  // older than any TTL → stale

const RATE_CARD = { social: [{ platform: "instagram", ratePerPost: { low: 300, mid: 500, high: 800 }, followers: 1000 }], appearance: { ratePerEvent: { mid: 1200 } } };

export async function seedLegacyAthlete(over: { brand?: string } = {}): Promise<string> {
  const id = await seedAthlete("Legacy Lane");
  await db.update(athletes).set({ first_name: "Lee", sport: "soccer", school: "Legacy University", division: "D1", conference: "ACC", status: "active", career_status: "active", goal_archetype: "brand_builder", socials: { instagram: "@legacy_ig", twitter: "legacy_x" }, created_at: new Date("2026-07-01T00:00:00Z") } as any).where(eq(athletes.id, id));
  await db.insert(athleteAffiliations).values({ athlete_id: id, org_name: "Legacy University", org_kind: "school", level: "D1", conference: "ACC", is_primary: true, kind: "said", source: "signup", started_on: "2024-08-01" });
  await db.insert(athleteSnapshots).values({
    athlete_id: id, trigger: "signup", created_at: T0, as_of: T0, sources: { apis_called: ["kimi"] },
    research: {
      achievements: [{ name: "All-Conference", year: 2025, level: "conference" }],
      press_mentions: [{ outlet: "Daily", headline: "Lane leads" }],
      brand_mentions: [{ brand: over.brand ?? "Brand X", type: "tagged" }],
      story_arc: "Legacy story arc",
      profile: { position: "Forward", class_year: "Junior 2026", hometown: "Springfield" },   // D4: under profile.*
      social_handles: { tiktok: "@legacy_tt" },
    },
  } as any);
  await db.insert(athletesCurrent).values({ athlete_id: id, story_arc: "Legacy story arc", research_updated_at: T0 } as any);
  await db.insert(athleteAsserted).values({ athlete_id: id, field: "position", value: { text: "Striker" }, said: "I play striker", source: "onboarding", mode: "chat" } as any);
  return id;
}

export interface CanonicalOptions { brandDomain: "confirmed_empty" | "populated"; name?: string }

export async function seedCanonicalAthlete(o: CanonicalOptions): Promise<string> {
  const id = await seedAthlete(o.name ?? "Canon Cole");
  await db.update(athletes).set({ first_name: "Cole", sport: "soccer", school: "Stale School (projection)", division: "D2", conference: "Old Conf", status: "active", career_status: "active", socials: { twitter: "cole_x" }, created_at: new Date("2026-07-01T00:00:00Z") } as any).where(eq(athletes.id, id));
  await db.insert(athleteAffiliations).values([
    { athlete_id: id, org_name: "Canon University", org_kind: "school", level: "D1", conference: "Big Ten", is_primary: true, kind: "said", source: "onboarding", started_on: "2024-08-01" },
    { athlete_id: id, org_name: "Found FC", org_kind: "club", level: "amateur", is_primary: false, kind: "found", source: "research", started_on: "2023-01-01" },
  ]);
  const fact = (key: string, value: unknown, valueText: string, over: Partial<{ origin: string; status: string; tier: number; at: Date; family: string }> = {}) =>
    db.insert(athleteFacts).values({ athlete_id: id, fact_key: key, value: value as any, value_text: valueText, status: over.status ?? "current", retrieved_at: over.at ?? T1, origin: over.origin ?? "research", source_class: over.origin === "athlete_asserted" ? null : "web_researched", authority_tier: over.origin === "athlete_asserted" ? null : (over.tier ?? 2), confidence: "0.90", provenance: {} as any, freshness_family: over.family ?? "identity", resolver_version: "v1", registry_version: "v1" });
  await fact("sport", { sport: "Soccer" }, "soccer");
  await fact("alias", { text: "CC", kind: "nickname" }, "cc");
  await fact("hometown", { city: "Springfield", region: "IL", country: "US" }, "springfield il us");
  await fact("position", { text: "Forward" }, "forward", { family: "affiliations" });
  await fact("class_year", { label: "Junior", season: 2026 }, "junior 2026", { family: "affiliations", at: OLD });   // stale under every TTL
  await fact("achievement", { name: "National Champion", year: 2025, level: "national" }, "national champion 2025", { family: "achievements", tier: 1 });
  await fact("achievement", { name: "All-Conference", year: 2024, level: "conference" }, "all-conference 2024", { family: "achievements" });
  const [run] = await db.insert(researchRuns).values({ athlete_id: id, domain: "press", trigger: "manual", status: "ok" } as any).returning({ id: researchRuns.id });
  const ev = (kind: string, claim: Record<string, unknown>, over: Partial<{ suspect: boolean; lineage: string; key: string }> = {}) =>
    db.insert(researchEvidence).values({ athlete_id: id, run_id: run.id, kind, claim: claim as any, lineage_status: over.lineage ?? "cited", source_url: `https://daily.example/${over.key ?? kind}`, source_domain: "daily.example", source_type: "regional_news", retrieved_at: T1, confidence: "0.80", source_class: "web_researched", suspect: over.suspect ?? false, dedupe_key: `${kind}:${over.key ?? "1"}` } as any);
  await ev("press_mention", { outlet: "Daily", headline: "Cole wins" });
  await ev("press_mention", { outlet: "Rumour", headline: "SUSPECT HEADLINE" }, { suspect: true, key: "suspect" });   // never reaches a view (G2)
  if (o.brandDomain === "populated") await ev("brand_mention", { brand: "Brand Y", type: "tagged" }, { key: "y" });
  await db.insert(athleteInferences).values({ athlete_id: id, inference_key: "story_arc", value: "Canonical story arc" as any, producer: "narrative_v1", lineage: { runId: run.id, evidenceIds: [] } as any, confidence: "0.70", computed_at: T1 } as any);
  await db.insert(socialIdentities).values([
    { athlete_id: id, platform: "instagram", account_id: "ig-1", account_id_kind: "platform_id", handle: "cole_public", source_class: "platform_public", source_method: "discovery", confidence: "0.80", status: "active" },
    { athlete_id: id, platform: "tiktok", account_id: "tt-1", account_id_kind: "handle", handle: "cole_tt", source_class: "web_researched", source_method: "research", confidence: "0.60", status: "active" },
  ]);
  const fresh = (outcome: string) => ({ status: "fresh", outcome, lastResearchedAt: T1.toISOString() });
  await db.insert(athleteResearchState).values({ athlete_id: id, research_status: "research_complete", identity_confidence: "0.95", last_researched_at: T1,
    domains: { identity: fresh("refreshed"), profile: fresh("refreshed"), achievements: fresh("refreshed"), press: fresh("refreshed"), brand_mentions: fresh(o.brandDomain === "populated" ? "refreshed" : "confirmed_empty"), narrative: fresh("refreshed"), social_handles: fresh("refreshed") } as any });
  // A stale legacy blob that still holds Brand X and an achievement: MUST NOT surface (G5b).
  await db.insert(athleteSnapshots).values({ athlete_id: id, trigger: "signup", created_at: T0, as_of: T0, sources: { apis_called: ["kimi"] },
    research: { achievements: [{ name: "Blob Achievement", year: 2019 }], brand_mentions: [{ brand: "Brand X" }], story_arc: "Blob story", profile: { position: "Blob position" }, social_handles: { youtube: "blob_yt" } } } as any);
  await db.insert(athletesCurrent).values({ athlete_id: id, story_arc: "Canonical story arc", research_updated_at: T1 } as any);
  await db.insert(athleteAsserted).values({ athlete_id: id, field: "position", value: { text: "Striker" }, said: "I play striker", source: "onboarding", mode: "chat" } as any);
  return id;
}

/** Every string in a JSON-able value, for "X appears in no view" assertions. */
export function textOf(v: unknown): string { return JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : x)); }
