/**
 * researchInputs.ts — the athlete-side inputs every research path hands the substrate: the athlete's live
 * assertions mapped onto registry keys (assertionsFor) and the identity hints a provider searches with
 * (hintsFor). Originally part of the Step 2a legacy dual-write (researchDualWrite.ts, retired); the refresh,
 * v3 stage and reprocess paths import them from here.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { athleteAsserted, athleteFacts, type Athlete } from "../../../../shared/schema";
import { listAffiliations, primaryAffiliation } from "../../affiliations";
import type { IdentityHints } from "./providers";
import type { Assertion } from "./resolve";

/** Map the athlete's live assertions (athlete_asserted) onto registry keys and shapes. */
export async function assertionsFor(athleteId: string): Promise<Assertion[]> {
  const rows = await db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, athleteId), isNull(athleteAsserted.superseded_by), isNull(athleteAsserted.retracted_at))).orderBy(desc(athleteAsserted.created_at));
  const seen = new Set<string>();
  const out: Assertion[] = [];
  for (const r of rows) {
    if (seen.has(r.field)) continue;
    const v = r.value as Record<string, unknown>;
    const text = typeof v?.text === "string" ? v.text : null;
    let mapped: { factKey: string; value: unknown } | null = null;
    switch (r.field) {
      case "sport": if (text) mapped = { factKey: "sport", value: { sport: text } }; break;
      case "position": if (text) mapped = { factKey: "position", value: { text } }; break;
      case "hometown": if (text) mapped = { factKey: "hometown", value: { city: text } }; break;
      case "class_year": { const y = text ? /\b(20\d{2})\b/.exec(text)?.[1] : null; if (text && y) mapped = { factKey: "class_year", value: { label: text, season: Number(y) } }; break; }
      case "career_status": if (typeof v?.status === "string") mapped = { factKey: "career_status", value: { status: v.status } }; break;
      // Step 2c: "Goes by" becomes an alias fact (an Athlete Index match key), never a name change.
      case "nickname": if (text) mapped = { factKey: "alias", value: { text, kind: "nickname" } }; break;
      default: break;
    }
    if (!mapped) continue;
    seen.add(r.field);
    out.push({ factKey: mapped.factKey, value: mapped.value, assertedId: r.id, kind: "asserted", at: r.created_at?.toISOString() ?? new Date().toISOString() });
  }
  return out;
}

export async function hintsFor(athleteRow: Athlete, knownHandles: Record<string, string | undefined> = {}): Promise<{ hints: IdentityHints; hasAssertedAffiliations: boolean }> {
  const affs = await listAffiliations(athleteRow.id);
  const primary = await primaryAffiliation(athleteRow.id);
  const hasAssertedAffiliations = affs.some((a: any) => a.kind === "said" || a.kind === "proof");
  const handles: Record<string, string> = {};
  for (const [k, v] of Object.entries(knownHandles)) if (v) handles[k] = v;
  // Step 2c: real aliases and hometown from the canonical facts (empty until the substrate has rows).
  const facts = await db.select({ key: athleteFacts.fact_key, value: athleteFacts.value }).from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteRow.id), inArray(athleteFacts.fact_key, ["alias", "hometown"]), eq(athleteFacts.status, "current")));
  const aliases = [...new Set(facts.filter((f) => f.key === "alias").map((f) => String((f.value as any)?.text ?? "")).filter(Boolean))].slice(0, 8);
  const home = facts.find((f) => f.key === "hometown")?.value as { city?: string; region?: string; country?: string } | undefined;
  const hometown = home ? [home.city, home.region, home.country].filter(Boolean).join(", ") || null : null;
  // 2d-5 (#34): `Affiliation.org` — the old `org_name` read never existed, so the ledger team was never used here.
  return {
    hints: { athleteId: athleteRow.id, fullName: athleteRow.full_name, aliases, sport: athleteRow.sport ?? null, currentAffiliation: primary?.org ?? athleteRow.school ?? null, hometown, knownHandles: handles },
    hasAssertedAffiliations,
  };
}
