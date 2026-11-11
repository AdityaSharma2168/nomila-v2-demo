/**
 * affiliationSync.ts — syncAffiliationsFromFacts (Phase A Step 2d-6, design §3.5; decisions Q2/Q3 in the 2d-6 review).
 *
 * Rule-7 affiliations are athlete_facts rows; this makes them ledger rows the reader-side already understands
 * (kind='found', source='fact', fact_id). Runs inside persistResearchRun's transaction after the facts are resolved,
 * so it is reachable ONLY when RESEARCH_SUBSTRATE_WRITE is true. Safe to run after every persist:
 *
 *   key           (athlete, org_kind, normalizeText(org_name), season)   season = value.season ?? year(valid_from ?? value.from);
 *                 a fact with neither season nor start keys on org + kind alone (V1: two undated facts for the same
 *                 org/kind are the same affiliation — no evidence distinguishes separate stints)
 *   reconfirmed   same key ⇒ the existing found row is re-pointed (fact_id) and its dates corrected in place — no new row
 *   different key a current fact with a new org or season ⇒ the previous found-from-fact CURRENT row is closed
 *                 (ended_on = the new fact's start, else the old fact's valid_to, else the run's as-of) and one row inserted;
 *                 a found row is never edited into a different team
 *   historical    a historical fact ⇒ ended_on = valid_to (never deleted: the ledger keeps history)
 *   precedence    said/proof rows are NEVER modified or demoted here; a found row is primary only when the fact says
 *                 primary AND no confirmed (said/proof) current row exists; the one-primary-current index holds because
 *                 a superseded found primary is closed before the new one is inserted
 *   idempotent    the same facts twice ⇒ no insert, no update (G6)
 * Then projectPrimary: the projection follows the ledger (primary current only, §4.4).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { athleteAffiliations, athleteFacts } from "../../../../shared/schema";
import { projectPrimary, type AffiliationsClient } from "../../affiliations";
import { normalizeText } from "./factRegistry";

export interface SyncResult { inserted: number; updated: number; closed: number; projected: { school: string | null; division: string | null; conference: string | null } }

interface AffValue { org: string; orgKind: string; level?: string | null; conference?: string | null; role?: string | null; position?: string | null; season?: number | null; from?: string | null; to?: string | null; primary?: boolean }

const yearOf = (d: string | null | undefined): number | null => { const m = /^(\d{4})/.exec(String(d ?? "")); return m ? Number(m[1]) : null; };
const seasonOf = (v: AffValue, validFrom: string | null): number | null => v.season ?? yearOf(validFrom ?? v.from ?? null);
const keyOf = (orgKind: string, org: string, season: number | null) => `${orgKind}|${normalizeText(org)}|${season ?? ""}`;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
/** Only a full YYYY-MM-DD may enter a date column; a year-only or partial value (registry v2 allows "YYYY") stays null — the season key already carries the year. */
const fullDateOrNull = (d: string | null | undefined): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? "")) ? String(d) : null);

export async function syncAffiliationsFromFacts(athleteId: string, client: AffiliationsClient = db, asOf: Date = new Date()): Promise<SyncResult> {
  // Every affiliation fact (any status) keys the rows that point at it; only current/historical facts drive changes.
  const allFacts = await client.select().from(athleteFacts)
    .where(and(eq(athleteFacts.athlete_id, athleteId), eq(athleteFacts.fact_key, "affiliation")))
    .orderBy(athleteFacts.retrieved_at, athleteFacts.created_at);
  const facts = allFacts.filter((f) => f.status === "current" || f.status === "historical");
  const rows = await client.select().from(athleteAffiliations).where(eq(athleteAffiliations.athlete_id, athleteId));
  const confirmedCurrent = rows.some((r) => (r.kind === "said" || r.kind === "proof") && r.ended_on === null);
  const factById = new Map(allFacts.map((f) => [f.id, f]));
  const keyOfRow = (r: typeof rows[number]): string => {
    const f = r.fact_id ? factById.get(r.fact_id) : undefined;
    if (f) { const v = f.value as AffValue; return keyOf(v.orgKind, v.org, seasonOf(v, f.valid_from)); }
    return keyOf(r.org_kind, r.org_name, yearOf(r.started_on));
  };
  // Only rows this sync owns: found rows written from a fact. Said/proof rows and legacy found rows (source='research') are never touched.
  const owned = rows.filter((r) => r.kind === "found" && r.source === "fact");
  const out: SyncResult = { inserted: 0, updated: 0, closed: 0, projected: { school: null, division: null, conference: null } };
  const currentKeys = new Set<string>();

  for (const f of facts) {
    const v = f.value as AffValue;
    if (!v?.org || !v?.orgKind) continue;
    const key = keyOf(v.orgKind, v.org, seasonOf(v, f.valid_from));
    if (f.status === "current") currentKeys.add(key);
    const startedOn = fullDateOrNull(f.valid_from) ?? fullDateOrNull(v.from);
    const endedOn = f.status === "historical" ? (fullDateOrNull(f.valid_to) ?? fullDateOrNull(v.to)) : fullDateOrNull(v.to);
    const wantPrimary = f.status === "current" && v.primary === true && !confirmedCurrent;
    const existing = owned.find((r) => keyOfRow(r) === key);
    if (existing) {
      const next = { fact_id: f.id, started_on: startedOn, ended_on: endedOn, level: v.level ?? null, conference: v.conference ?? null, role: v.role ?? null, position: v.position ?? null, is_primary: wantPrimary && endedOn === null };
      const changed = (Object.keys(next) as Array<keyof typeof next>).some((k) => (existing as any)[k] !== next[k]);
      if (changed) {
        // The one-primary-current index: demote another owned primary current row before promoting this one.
        if (next.is_primary && !existing.is_primary) for (const o of owned) if (o.id !== existing.id && o.is_primary && o.ended_on === null) { await client.update(athleteAffiliations).set({ is_primary: false, updated_at: asOf }).where(eq(athleteAffiliations.id, o.id)); o.is_primary = false; out.updated++; }
        await client.update(athleteAffiliations).set({ ...next, updated_at: asOf }).where(eq(athleteAffiliations.id, existing.id));
        Object.assign(existing, next); out.updated++;
      }
      continue;
    }
    // A new key: a current fact with a different org/season CLOSES this sync's previous current row(s) whose fact is no
    // longer current (the resolver superseded it) — history kept, never edited into the new team. A row whose fact is
    // still current (a concurrent affiliation, e.g. school + national team) stays open; it is only demoted if this one is primary.
    if (f.status === "current") {
      for (const o of owned) {
        if (o.ended_on !== null || keyOfRow(o) === key) continue;
        const of = o.fact_id ? factById.get(o.fact_id) : undefined;
        if (of?.status === "current") continue;
        const closeOn = startedOn ?? of?.valid_to ?? dateOnly(asOf);
        await client.update(athleteAffiliations).set({ ended_on: closeOn, is_primary: false, updated_at: asOf }).where(eq(athleteAffiliations.id, o.id));
        o.ended_on = closeOn; o.is_primary = false; out.closed++;
      }
      // The one-primary-current index: demote any other owned primary current row before writing a new primary.
      if (wantPrimary && endedOn === null) for (const o of owned) if (o.is_primary && o.ended_on === null) { await client.update(athleteAffiliations).set({ is_primary: false, updated_at: asOf }).where(eq(athleteAffiliations.id, o.id)); o.is_primary = false; out.updated++; }
    }
    const [ins] = await client.insert(athleteAffiliations).values({
      athlete_id: athleteId, org_name: v.org, org_kind: v.orgKind, level: v.level ?? null, conference: v.conference ?? null, role: v.role ?? null, position: v.position ?? null,
      started_on: startedOn, ended_on: endedOn, is_primary: wantPrimary && endedOn === null, kind: "found", source: "fact", fact_id: f.id, created_at: asOf, updated_at: asOf,
    }).returning();
    owned.push(ins); out.inserted++;
  }
  out.projected = await projectPrimary(athleteId, client);
  return out;
}
