/**
 * identity/index.ts — the Athlete Index: the view's record, the candidate query and the pure
 * scoring / tier logic (design §2, §4.1–4.3). MATCHING ONLY: a tier says which athlete record this
 * probably is; it never authorizes a link (see claim.ts). No provider import (boundary test).
 *
 * The view athlete_index_v is created by migration 0048 and is not declared in shared/schema.ts
 * (the drift gate cannot see views), so its column set is pinned here and checked at runtime
 * (`assertIndexShape`) and in tests.
 */

import { sql } from "drizzle-orm";
import { db } from "../../../db";
import type { IdentityPolicy } from "./policy";
import { normalizeHandle, normalizeIdentityText } from "./policy";

/** The view's columns, in order. Changing the view means changing this list AND the test that compares them. */
export const ATHLETE_INDEX_COLUMNS = [
  "athlete_id", "full_name", "name_norm", "aliases", "sport", "team_or_school", "org_kind", "level", "conference", "affiliation_kind",
  "class_year", "graduation_year", "city_or_country", "known_social_handles", "identity_confidence", "research_status", "disputed_domains",
  "last_researched_at", "next_due_at", "connection_status", "has_user", "claimability", "is_golden_anchor", "athlete_status", "index_updated_at",
] as const;

export type Claimability = "open" | "review" | "none";
export interface KnownHandle { handle: string; sourceClass: string; confidence: number | string | null }

/** The canonical Athlete Index record (design §2): public fields only. */
export interface AthleteIndexRecord {
  athleteId: string;
  fullName: string;
  nameNorm: string;
  aliases: string[];
  sport: string | null;
  teamOrSchool: string | null;
  orgKind: string | null;
  level: string | null;
  conference: string | null;
  affiliationKind: "said" | "proof" | "found" | null;
  classYear: number | null;
  graduationYear: number | null;
  cityOrCountry: string | null;
  knownSocialHandles: Record<string, KnownHandle>;
  identityConfidence: number;
  researchStatus: string;
  disputedDomains: string[];
  lastResearchedAt: string | null;
  nextDueAt: string | null;
  connectionStatus: "none" | "active" | "expired" | "revoked";
  hasUser: boolean;
  claimability: Claimability;
  isGoldenAnchor: boolean;
  athleteStatus: string;
  indexUpdatedAt: string | null;
}

export function toIndexRecord(r: Record<string, unknown>): AthleteIndexRecord {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return {
    athleteId: String(r.athlete_id), fullName: String(r.full_name), nameNorm: String(r.name_norm ?? ""),
    aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
    sport: (r.sport as string | null) ?? null, teamOrSchool: (r.team_or_school as string | null) ?? null, orgKind: (r.org_kind as string | null) ?? null,
    level: (r.level as string | null) ?? null, conference: (r.conference as string | null) ?? null, affiliationKind: (r.affiliation_kind as AthleteIndexRecord["affiliationKind"]) ?? null,
    classYear: r.class_year == null ? null : Number(r.class_year), graduationYear: r.graduation_year == null ? null : Number(r.graduation_year),
    cityOrCountry: (r.city_or_country as string | null) ?? null,
    knownSocialHandles: (r.known_social_handles as Record<string, KnownHandle>) ?? {},
    identityConfidence: Number(r.identity_confidence ?? 0), researchStatus: String(r.research_status ?? "seed_only"),
    disputedDomains: Array.isArray(r.disputed_domains) ? (r.disputed_domains as string[]) : [],
    lastResearchedAt: iso(r.last_researched_at), nextDueAt: iso(r.next_due_at),
    connectionStatus: (r.connection_status as AthleteIndexRecord["connectionStatus"]) ?? "none",
    hasUser: !!r.has_user, claimability: (r.claimability as Claimability) ?? "review", isGoldenAnchor: !!r.is_golden_anchor,
    athleteStatus: String(r.athlete_status ?? ""), indexUpdatedAt: iso(r.index_updated_at),
  };
}

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

/** The view's live column set must equal ATHLETE_INDEX_COLUMNS (G3). Throws with the difference. */
export async function assertIndexShape(): Promise<void> {
  const res = await db.execute(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'athlete_index_v' order by ordinal_position`);
  const live = rowsOf(res).map((r) => String(r.column_name));
  const want = [...ATHLETE_INDEX_COLUMNS];
  const missing = want.filter((c) => !live.includes(c)); const extra = live.filter((c) => !want.includes(c as any));
  if (!live.length) throw new Error("athlete_index_v does not exist (migration 0048 not applied)");
  if (missing.length || extra.length) throw new Error(`athlete_index_v shape drift: missing [${missing.join(",")}] extra [${extra.join(",")}]`);
}

/** Bulk read for the admin roster (2d-3, #39): index records for a set of ids, in no particular order. */
export async function readIndexRecords(athleteIds: string[]): Promise<Map<string, AthleteIndexRecord>> {
  const out = new Map<string, AthleteIndexRecord>();
  if (!athleteIds.length) return out;
  // Every id is a bound parameter (no sql.raw on the canonical Identity path — review of #415).
  const res = await db.execute(sql`select * from athlete_index_v where athlete_id in (${sql.join(athleteIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const row of rowsOf(res)) { const r = toIndexRecord(row); out.set(r.athleteId, r); }
  return out;
}

export async function readIndexRecord(athleteId: string): Promise<AthleteIndexRecord | null> {
  const res = await db.execute(sql`select * from athlete_index_v where athlete_id = ${athleteId}::uuid`);
  const [row] = rowsOf(res);
  return row ? toIndexRecord(row) : null;
}

// ── the candidate query ────────────────────────────────────────────────────────

export interface CandidateQuery {
  name: string;
  sport?: string | null;
  teamOrSchool?: string | null;
  classYear?: number | null;
  handles?: Record<string, string | null | undefined>;
  /** Server-side creation paths only; never accepted from a client and never returned. */
  email?: string | null;
}

export interface Signals { nameSim: number; sportMatch: 1 | 0 | null; teamMatch: number | null; yearMatch: 1 | 0 | null; handleExact: 1 | 0 | null; emailExact: 1 | 0 | null }
export type MatchTier = "auto_match" | "candidate" | "new";

export interface ScoredCandidate {
  record: AthleteIndexRecord;
  signals: Signals;
  matchScore: number;
  corroborated: boolean;
  /** This row is reached by an exact identifier (email or handle) that maps to exactly one athlete. */
  uniqueIdentifier: boolean;
}

export interface CandidateResult {
  candidates: ScoredCandidate[];
  tier: MatchTier;
  best: ScoredCandidate | null;
  /** An exact identifier in the query maps to more than one athlete row. */
  ambiguousIdentifier: boolean;
  policyVersion: string;
}

interface RawScored { record: AthleteIndexRecord; simFull: number; simNorm: number; simFact: number; simTeam: number | null; emailExact: boolean; handleExactPlatforms: string[] }

/** Pure: the signals and the weighted score for one row (design §4.2). */
export function scoreCandidate(q: CandidateQuery, r: RawScored, policy: IdentityPolicy): Omit<ScoredCandidate, "uniqueIdentifier"> {
  const nameSim = Math.max(r.simFull, r.simNorm, r.simFact);
  // A signal is null (weight re-normalized away) ONLY when the QUERY does not supply it. When the query
  // supplies it and the row lacks it, the row scores 0 on it: a row with an unknown team must never
  // out-rank a row whose team matches (re-normalization would otherwise reward missing data).
  const qSport = q.sport ? normalizeIdentityText(q.sport) : null;
  const sportMatch: Signals["sportMatch"] = qSport ? (r.record.sport && normalizeIdentityText(r.record.sport) === qSport ? 1 : 0) : null;
  const kindW = r.record.affiliationKind ? policy.teamKindWeight[r.record.affiliationKind] ?? 1 : 1;
  const teamGiven = !!q.teamOrSchool?.trim();
  const teamMatch = teamGiven ? (r.simTeam == null ? 0 : Math.round(r.simTeam * kindW * 1000) / 1000) : null;
  const rowYear = r.record.classYear ?? r.record.graduationYear;
  const yearMatch: Signals["yearMatch"] = q.classYear != null ? (rowYear != null && Math.abs(q.classYear - rowYear) <= policy.yearTolerance ? 1 : 0) : null;
  const handlesGiven = Object.values(q.handles ?? {}).some((h) => normalizeHandle(h));
  const handleExact: Signals["handleExact"] = handlesGiven ? (r.handleExactPlatforms.length ? 1 : 0) : null;
  const emailExact: Signals["emailExact"] = q.email ? (r.emailExact ? 1 : 0) : null;
  const parts: Array<[number, number | null]> = [[policy.weights.name, nameSim], [policy.weights.sport, sportMatch], [policy.weights.team, teamMatch], [policy.weights.year, yearMatch], [policy.weights.handle, handleExact]];
  let wsum = 0, acc = 0;
  for (const [w, v] of parts) if (v != null) { wsum += w; acc += w * v; }
  const matchScore = wsum ? Math.max(0, Math.min(1, Math.round((acc / wsum) * 1000) / 1000)) : 0;
  const corroborated = sportMatch === 1 || (teamMatch != null && teamMatch >= policy.teamCorroboration) || yearMatch === 1 || handleExact === 1 || emailExact === 1;
  return { record: r.record, signals: { nameSim: Math.round(nameSim * 1000) / 1000, sportMatch, teamMatch, yearMatch, handleExact, emailExact }, matchScore, corroborated };
}

/** Pure: the tier for a ranked list (design §4.3). */
export function tierFor(ranked: ScoredCandidate[], ambiguousIdentifier: boolean, policy: IdentityPolicy): MatchTier {
  const best = ranked[0];
  if (!best) return "new";
  const second = ranked[1];
  const gapOk = !second || best.matchScore - second.matchScore >= policy.gap;
  if (!ambiguousIdentifier && best.record.claimability === "open") {
    if (best.uniqueIdentifier) return "auto_match";
    if (best.matchScore >= policy.autoMatch && best.corroborated && gapOk) return "auto_match";   // minimum-evidence rule: name alone never qualifies
  }
  if (best.matchScore >= policy.candidate || best.uniqueIdentifier || ambiguousIdentifier || best.matchScore >= policy.autoMatch) return "candidate";
  return "new";
}

/**
 * The candidate query: the match-key tables select the athlete ids FIRST (each on its own index: the
 * trigram index on athletes.full_name, the partial trigram index on name/alias facts, the email and
 * handle btrees, plus the entered-socials fallback), and the view is evaluated ONLY for those ids. Evaluating
 * the view for every athlete and filtering afterwards (the first cut) cost ~230 ms on a 10k roster because
 * the OR across the view's columns defeats every index (G4). Then pure scoring.
 */
export async function findCandidates(q: CandidateQuery, opts: { limit?: number; policy: IdentityPolicy }): Promise<CandidateResult> {
  const policy = opts.policy;
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 25);
  const name = q.name.trim().slice(0, 160);
  const nameNorm = normalizeIdentityText(name);
  const team = q.teamOrSchool?.trim().slice(0, 160) || null;
  const emailLower = q.email?.trim().toLowerCase() || null;
  const handles = Object.entries(q.handles ?? {}).map(([p, h]) => [p === "twitter" ? "x" : p, normalizeHandle(h)] as const).filter((x): x is readonly [string, string] => !!x[1]).slice(0, 6);
  if (!nameNorm && !emailLower && !handles.length) return { candidates: [], tier: "new", best: null, ambiguousIdentifier: false, policyVersion: policy.version ?? "defaults" };

  // Exact-handle membership = an ACTIVE social_identities row on that platform with that handle (ALL active
  // identities, not the one preferred handle the view projects) OR the entered-socials fallback (review of PR #404).
  const enteredKey = (p: string) => (p === "x" ? sql`coalesce(a.socials ->> 'x', a.socials ->> 'twitter')` : sql`a.socials ->> ${p}`);
  const handleMember = (p: string, h: string) => sql`(EXISTS (SELECT 1 FROM social_identities s WHERE s.athlete_id = v.athlete_id AND s.status = 'active' AND s.platform = ${p} AND lower(s.handle) = ${h}) OR lower(ltrim(coalesce(${enteredKey(p)}, ''), '@')) = ${h})`;
  const handleWhere = handles.length ? sql.join(handles.map(([p, h]) => handleMember(p, h)), sql` OR `) : sql`false`;
  const handleHits = handles.length ? sql.join(handles.map(([p, h]) => sql`CASE WHEN ${handleMember(p, h)} THEN ${p}::text END`), sql`, `) : sql`NULL::text`;
  // Candidate ids by key (each part index-assisted); exact-identifier ids are kept in full, name matches capped.
  const handleIds = handles.length
    ? sql.join(handles.map(([p, h]) => sql`SELECT s.athlete_id AS id FROM social_identities s WHERE s.status = 'active' AND s.platform = ${p} AND lower(s.handle) = ${h}
                                          UNION SELECT a.id FROM athletes a WHERE lower(ltrim(coalesce(${enteredKey(p)}, ''), '@')) = ${h}`), sql` UNION `)
    : sql`SELECT NULL::uuid AS id WHERE false`;
  const idSet = sql`
    SELECT id FROM (
      SELECT a.id FROM athletes a WHERE ${emailLower}::text IS NOT NULL AND a.email IS NOT NULL AND lower(a.email) = ${emailLower}::text
      UNION ${handleIds}
      UNION (SELECT id FROM (
               SELECT a.id, similarity(a.full_name, ${name}::text) AS s FROM athletes a WHERE ${nameNorm}::text <> '' AND a.full_name % ${name}::text
               UNION ALL SELECT f.athlete_id, similarity(f.value_text, ${nameNorm}::text) FROM athlete_facts f WHERE ${nameNorm}::text <> '' AND f.fact_key IN ('name','alias') AND f.status = 'current' AND f.value_text % ${nameNorm}::text
             ) n ORDER BY s DESC LIMIT 60)
    ) ids WHERE id IS NOT NULL`;
  const res = await db.execute(sql`
    SELECT v.*,
           (${emailLower}::text IS NOT NULL AND a.email IS NOT NULL AND lower(a.email) = ${emailLower}::text) AS email_exact,
           similarity(v.full_name, ${name}::text) AS sim_full,
           similarity(v.name_norm, ${nameNorm}::text) AS sim_norm,
           coalesce((SELECT max(similarity(f.value_text, ${nameNorm}::text)) FROM athlete_facts f WHERE f.athlete_id = v.athlete_id AND f.fact_key IN ('name','alias') AND f.status = 'current'), 0) AS sim_fact,
           CASE WHEN v.team_or_school IS NULL OR ${team}::text IS NULL THEN NULL ELSE similarity(v.team_or_school, ${team}::text) END AS sim_team,
           array_remove(ARRAY[${handleHits}], NULL) AS handle_hits
    FROM athlete_index_v v
    JOIN athletes a ON a.id = v.athlete_id
    WHERE v.athlete_id = ANY (ARRAY(${idSet}))
    ORDER BY ((${emailLower}::text IS NOT NULL AND a.email IS NOT NULL AND lower(a.email) = ${emailLower}::text) OR (${handleWhere})) DESC,
             greatest(similarity(v.full_name, ${name}::text), similarity(v.name_norm, ${nameNorm}::text)) DESC
    LIMIT 40`);
  const raw: RawScored[] = rowsOf(res).map((r) => ({ record: toIndexRecord(r), simFull: Number(r.sim_full ?? 0), simNorm: Number(r.sim_norm ?? 0), simFact: Number(r.sim_fact ?? 0), simTeam: r.sim_team == null ? null : Number(r.sim_team), emailExact: !!r.email_exact, handleExactPlatforms: Array.isArray(r.handle_hits) ? r.handle_hits.map(String) : [] }));

  // Exact identifiers count only when they map to exactly ONE athlete row (design §4.2, review: uniqueness).
  // Counted over ALL athletes reached by the identifier (active identities ∪ entered socials; every email row),
  // never from the returned rows or the view's one-handle-per-platform projection.
  const emailRows = emailLower ? Number(rowsOf(await db.execute(sql`SELECT count(*) AS n FROM athletes a WHERE a.email IS NOT NULL AND lower(a.email) = ${emailLower}::text`))[0]?.n ?? 0) : 0;
  const handleRows = new Map<string, number>();
  for (const [p, h] of handles) {
    const n = Number(rowsOf(await db.execute(sql`
      SELECT count(DISTINCT u.id) AS n FROM (
        SELECT s.athlete_id AS id FROM social_identities s WHERE s.status = 'active' AND s.platform = ${p} AND lower(s.handle) = ${h}
        UNION SELECT a.id FROM athletes a WHERE lower(ltrim(coalesce(${enteredKey(p)}, ''), '@')) = ${h}
      ) u`))[0]?.n ?? 0);
    handleRows.set(p, n);
  }
  const ambiguousIdentifier = emailRows > 1 || [...handleRows.values()].some((n) => n > 1);
  const scored: ScoredCandidate[] = raw
    .map((r) => {
      const s = scoreCandidate(q, r, policy);
      const uniqueIdentifier = (r.emailExact && emailRows === 1) || r.handleExactPlatforms.some((p) => handleRows.get(p) === 1);
      return { ...s, uniqueIdentifier };
    })
    .filter((c) => c.signals.nameSim >= policy.nameFloor || c.uniqueIdentifier || c.signals.emailExact === 1 || c.signals.handleExact === 1)
    // An unambiguous exact identifier determines the identity: it outranks every score-only candidate, and
    // matchScore orders within each class (review of PR #404). Ambiguous identifiers never set uniqueIdentifier.
    .sort((a, b) => Number(b.uniqueIdentifier) - Number(a.uniqueIdentifier) || b.matchScore - a.matchScore)
    .slice(0, limit);
  const tier = tierFor(scored, ambiguousIdentifier, policy);
  return { candidates: scored, tier, best: scored[0] ?? null, ambiguousIdentifier, policyVersion: policy.version ?? "defaults" };
}

/** Read-only name search for the admin list (no scoring, no auth keys): index rows whose name or alias is similar, optionally by legacy status. */
export async function searchIndex(qText: string, opts: { status?: string | null; limit?: number } = {}): Promise<AthleteIndexRecord[]> {
  const name = qText.trim().slice(0, 160); const nameNorm = normalizeIdentityText(name);
  if (!nameNorm) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const res = await db.execute(sql`
    SELECT v.* FROM athlete_index_v v
    WHERE v.athlete_id = ANY (ARRAY(
            SELECT a.id FROM athletes a WHERE a.full_name % ${name}::text
            UNION SELECT f.athlete_id FROM athlete_facts f WHERE f.fact_key IN ('name','alias') AND f.status = 'current' AND f.value_text % ${nameNorm}::text))
      AND (${opts.status ?? null}::text IS NULL OR v.athlete_status = ${opts.status ?? null}::text)
    ORDER BY greatest(similarity(v.full_name, ${name}::text), similarity(v.name_norm, ${nameNorm}::text)) DESC
    LIMIT ${limit}`);
  return rowsOf(res).map(toIndexRecord);
}

/** The fields a client may see: the view's record plus the match score, tier hint and signals without email. */
export function publicCandidate(c: ScoredCandidate) {
  const { emailExact: _e, ...signals } = c.signals;
  return { ...c.record, matchScore: c.matchScore, corroborated: c.corroborated, signals };
}
