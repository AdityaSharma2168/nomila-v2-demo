/**
 * affiliations.ts — teams as dated facts, and the one declared career status.
 *
 *   • A row per team: org, kind (school|club|pro|national|olympic), level, conference, role,
 *     position, started_on / ended_on (NULL = current), is_primary, provenance (said|found|proof).
 *   • The athlete's SAID list is one fact on the ledger (field `affiliations`, shape "teams"); this
 *     module turns it into rows (replacing her previous said rows, never touching found/proof rows)
 *     and PROJECTS the primary current row onto athletes.school / division / conference so the
 *     twenty-one readers of `school` keep working until each migrates to `listAffiliations`.
 *   • Research writes found rows elsewhere (a later PR) and never overwrites a said row.
 *
 * Design page: https://claude.ai/code/artifact/315f8535-1195-49e0-bab9-18f444a635ad
 */

import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { athleteAffiliations, athletes } from "../../shared/schema";
import { toCareerStatus, type CareerStatus } from "../../shared/goals";
import { normalizeConference } from "./conference";

export const ORG_KINDS = ["school", "club", "pro", "national", "olympic"] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

/** One team as the athlete states it (the ledger value item, and the PUT /record body item). */
export interface TeamInput {
  org: string;
  kind: OrgKind;
  level?: string | null;
  conference?: string | null;
  role?: string | null;
  position?: string | null;
  /** ISO date or "YYYY" / "YYYY-MM"; null = unknown. */
  from?: string | null;
  /** ISO date or "YYYY" / "YYYY-MM"; null = current. */
  to?: string | null;
  primary?: boolean;
}

export interface Affiliation extends Required<Omit<TeamInput, "primary">> {
  id: string;
  primary: boolean;
  current: boolean;
  kindOfFact: "said" | "found" | "proof";
  source: string | null;
  /** When the ledger row was recorded (ISO). Optional: older callers build Affiliation objects without it. */
  recordedAt?: string | null;
}

export class AffiliationError extends Error {}

const MAX_TEAMS = 12;
const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
};

/** "2024" → 2024-01-01 · "2024-07" → 2024-07-01 · "2024-07-15" → itself · anything else → null. */
export function toDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^\d{4}$/.test(t)) return `${t}-01-01`;
  if (/^\d{4}-\d{2}$/.test(t)) return `${t}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

export function orgKindOf(v: unknown): OrgKind | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if ((ORG_KINDS as readonly string[]).includes(t)) return t as OrgKind;
  // Generic words only — no sport, league or country acronyms here. A team's kind is about the
  // organisation (a school, a club, a professional side, a national programme), never the sport.
  if (/^(college|university|school|high school|hs|ncaa|varsity)$/.test(t)) return "school";
  if (/^(professional|franchise|league|team)$/.test(t)) return "pro";
  if (/^(national team|national|country|international|federation)$/.test(t)) return "national";
  if (/^(academy|youth|amateur|travel)$/.test(t)) return "club";
  return null;
}

/**
 * Validate a list of teams from any door: an array of objects (PUT /record, the app) or the
 * compact text Mila's tool writes, one team per line or semicolon:
 *   "Stanford University | school | D1 | midfielder | 2023- | primary"
 *   "U-17 national team | national | | captain | 2022-2022"
 * Fields after the kind are optional and positional: level · role · from-to · primary.
 */
export function coerceTeams(raw: unknown): TeamInput[] {
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[;\n]/).map(parseTeamLine).filter(Boolean) : [];
  const out: TeamInput[] = [];
  for (const it of items) {
    const o = (it ?? {}) as Record<string, unknown>;
    const org = clean(o.org ?? o.name ?? o.org_name, 120);
    const kind = orgKindOf(o.kind ?? o.org_kind);
    if (!org) throw new AffiliationError("A team needs a name");
    if (!kind) throw new AffiliationError(`"${org}" needs a kind: school, club, pro, national or olympic`);
    if (out.some((x) => x.org.toLowerCase() === org.toLowerCase() && x.kind === kind && (x.from ?? null) === (toDate(o.from ?? o.started_on) ?? null))) continue;
    out.push({
      org, kind,
      level: clean(o.level, 40), conference: clean(o.conference, 60),
      role: clean(o.role, 40), position: clean(o.position, 40),
      from: toDate(o.from ?? o.started_on), to: toDate(o.to ?? o.ended_on),
      primary: o.primary === true || o.is_primary === true || o.primary === "primary",
    });
  }
  if (!out.length) throw new AffiliationError("No teams given");
  if (out.length > MAX_TEAMS) throw new AffiliationError(`At most ${MAX_TEAMS} teams`);
  // Exactly one primary among CURRENT teams: the one marked, else the highest level, else the first.
  const current = out.filter((t) => !t.to);
  if (current.length) {
    let idx = current.findIndex((t) => t.primary);
    if (idx < 0) idx = current.indexOf([...current].sort((a, b) => levelRank(b.kind) - levelRank(a.kind))[0]);
    current.forEach((t, i) => { t.primary = i === idx; });
  }
  out.filter((t) => t.to).forEach((t) => { t.primary = false; });
  return out;
}

function parseTeamLine(line: string): Record<string, unknown> | null {
  const parts = line.split("|").map((p) => p.trim());
  if (!parts[0]) return null;
  const [org, kind, level, role, span, flag] = parts;
  let from: string | null = null, to: string | null = null;
  if (span) {
    const m = span.match(/^(\d{4}(?:-\d{2})?(?:-\d{2})?)?\s*[-–]\s*(\d{4}(?:-\d{2})?(?:-\d{2})?)?$/);
    if (m) { from = m[1] ?? null; to = m[2] ?? null; }
    else if (/^\d{4}/.test(span)) { from = span; to = span; }
  }
  return { org, kind, level: level || null, role: role || null, from, to, primary: /primary/i.test(flag ?? "") };
}

export const levelRank = (kind: OrgKind): number => ({ olympic: 5, national: 4, pro: 3, school: 2, club: 1 })[kind];

/** One line for a receipt or a Facts row. */
export function displayTeam(t: TeamInput | Affiliation): string {
  // A "school" reads by its level (D1, high school, JUCO…) when known, else plainly "school" — it is
  // never assumed to be a college.
  const bits = [t.org, t.kind === "school" ? (t.level ?? "school") : t.kind, t.conference ?? null].filter(Boolean);
  return bits.join(" · ");
}
export function displayTeams(list: TeamInput[]): string {
  return list.map((t) => `${displayTeam(t)}${t.to ? ` (${t.from ? t.from.slice(0, 4) + "–" : ""}${t.to.slice(0, 4)})` : t.primary ? " (current, primary)" : " (current)"}`).join("; ");
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Current first (primary first among them), then past by end date desc. */
export async function listAffiliations(athleteId: string): Promise<Affiliation[]> {
  // Explicit columns (not select()): the readers need none of the sync's bookkeeping, and the read then works the same
  // before and after migration 0050 — the dry-run scripts run against dev ahead of the deploy that applies it.
  const rows = await db.select({ id: athleteAffiliations.id, org_name: athleteAffiliations.org_name, org_kind: athleteAffiliations.org_kind, level: athleteAffiliations.level, conference: athleteAffiliations.conference, role: athleteAffiliations.role, position: athleteAffiliations.position, started_on: athleteAffiliations.started_on, ended_on: athleteAffiliations.ended_on, is_primary: athleteAffiliations.is_primary, kind: athleteAffiliations.kind, source: athleteAffiliations.source, created_at: athleteAffiliations.created_at }).from(athleteAffiliations)
    .where(eq(athleteAffiliations.athlete_id, athleteId))
    .orderBy(desc(sql`${athleteAffiliations.ended_on} IS NULL`), desc(athleteAffiliations.is_primary), desc(athleteAffiliations.ended_on), asc(athleteAffiliations.started_on));
  return rows.map((r) => ({
    id: r.id, org: r.org_name, kind: r.org_kind as OrgKind, level: r.level, conference: r.conference,
    role: r.role, position: r.position, from: r.started_on, to: r.ended_on,
    primary: r.is_primary, current: r.ended_on === null, kindOfFact: r.kind as Affiliation["kindOfFact"], source: r.source,
    recordedAt: r.created_at?.toISOString() ?? null,
  }));
}

/** The team a brand reads first: the primary current row, else the newest current, else null. */
export async function primaryAffiliation(athleteId: string): Promise<Affiliation | null> {
  const all = await listAffiliations(athleteId);
  return all.find((a) => a.current && a.primary) ?? all.find((a) => a.current) ?? null;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Replace the athlete's SAID rows with `teams` (found/proof rows are untouched), then project the
 * primary current row onto athletes.school / division / conference. Returns the rows as written.
 * Runs in one transaction so the one-primary index never sees two primaries mid-write.
 */
export async function replaceSaidAffiliations(opts: {
  athleteId: string; teams: TeamInput[]; source: string; assertedId?: string | null;
}): Promise<Affiliation[]> {
  const teams = coerceTeams(opts.teams);
  await db.transaction(async (tx) => {
    // A found row for the same org+kind that the athlete now confirms becomes hers: drop the
    // found row so the said one is the single row for that team.
    await tx.delete(athleteAffiliations).where(and(eq(athleteAffiliations.athlete_id, opts.athleteId), eq(athleteAffiliations.kind, "said")));
    for (const t of teams) {
      await tx.delete(athleteAffiliations).where(and(
        eq(athleteAffiliations.athlete_id, opts.athleteId), eq(athleteAffiliations.kind, "found"),
        sql`lower(${athleteAffiliations.org_name}) = lower(${t.org})`, eq(athleteAffiliations.org_kind, t.kind),
      ));
    }
    // Any found/proof row that is still primary+current must yield to the said primary.
    if (teams.some((t) => t.primary)) {
      await tx.update(athleteAffiliations).set({ is_primary: false })
        .where(and(eq(athleteAffiliations.athlete_id, opts.athleteId), isNull(athleteAffiliations.ended_on)));
    }
    if (teams.length) {
      await tx.insert(athleteAffiliations).values(teams.map((t) => ({
        athlete_id: opts.athleteId, org_name: t.org, org_kind: t.kind, level: t.level ?? null, conference: t.conference ?? null,
        role: t.role ?? null, position: t.position ?? null, started_on: t.from ?? null, ended_on: t.to ?? null,
        is_primary: !!t.primary, kind: "said", source: opts.source, asserted_id: opts.assertedId ?? null,
      })));
    }
    await projectPrimary(opts.athleteId, tx);
  });
  return listAffiliations(opts.athleteId);
}

/**
 * The facts behind FOUND teams that a whole-list save leaves out (same org + kind, case-insensitive). The record
 * editor sends every team she was shown, so a found team missing from it is one she removed: the caller records her
 * denial of its fact. The found row and the fact stay (research history); the denial hides them from every
 * governed reader. Found rows with no fact behind them are already hidden, so they need nothing.
 */
export async function foundFactsLeftOut(athleteId: string, teams: TeamInput[]): Promise<string[]> {
  const kept = new Set(coerceTeams(teams).map((t) => `${t.org.toLowerCase()}|${t.kind}`));
  const rows = await db.select({ org: athleteAffiliations.org_name, kind: athleteAffiliations.org_kind, factId: athleteAffiliations.fact_id }).from(athleteAffiliations)
    .where(and(eq(athleteAffiliations.athlete_id, athleteId), eq(athleteAffiliations.kind, "found"), isNotNull(athleteAffiliations.fact_id)));
  return [...new Set(rows.filter((r) => !kept.has(`${r.org.toLowerCase()}|${r.kind}`)).map((r) => r.factId!))];
}

/** Undo path: put back exactly the said rows the receipt recorded (or none). */
export async function restoreSaidAffiliations(athleteId: string, teams: TeamInput[] | null, source: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(athleteAffiliations).where(and(eq(athleteAffiliations.athlete_id, athleteId), eq(athleteAffiliations.kind, "said")));
    if (teams && teams.length) {
      const list = coerceTeams(teams);
      await tx.insert(athleteAffiliations).values(list.map((t) => ({
        athlete_id: athleteId, org_name: t.org, org_kind: t.kind, level: t.level ?? null, conference: t.conference ?? null,
        role: t.role ?? null, position: t.position ?? null, started_on: t.from ?? null, ended_on: t.to ?? null,
        is_primary: !!t.primary, kind: "said", source,
      })));
    }
    await projectPrimary(athleteId, tx);
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AffiliationsClient = typeof db | Tx;

/**
 * athletes.school / division / conference ← the PRIMARY CURRENT ledger row only (Phase A Step 2d-6, design §4.4 +
 * the user's decision: no newest-current fallback). The projection is compatibility infrastructure: it follows the
 * ledger and never regains authority. No primary current row ⇒ all three NULL (`segment`, generated from `division`,
 * follows; career_status carries the meaning). `conference` is normalised (D11) with the scoring rule so the ledger-
 * derived views and the projection carry one representation. Research never writes these columns (§4.4).
 */
export async function projectPrimary(athleteId: string, client: AffiliationsClient = db): Promise<{ school: string | null; division: string | null; conference: string | null }> {
  const [p] = await client.select().from(athleteAffiliations)
    .where(and(eq(athleteAffiliations.athlete_id, athleteId), isNull(athleteAffiliations.ended_on), eq(athleteAffiliations.is_primary, true)))
    .limit(1);
  const next = p
    ? { school: p.org_name, division: p.level ?? (p.org_kind === "pro" ? "Pro" : p.org_kind === "olympic" ? "Olympic" : null), conference: normalizeConference(p.conference) }
    : { school: null, division: null, conference: null };
  await client.update(athletes).set(next).where(eq(athletes.id, athleteId));
  return next;
}

// ─── Career status ────────────────────────────────────────────────────────────

export interface CareerStatusValue { status: CareerStatus; since: string | null }

/** "retired" · "Retired since 2024" · { status, since } → { status, since: "2024" | null }. */
export function coerceCareerStatus(raw: unknown): CareerStatusValue {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const status = toCareerStatus(o.status ?? o.text);
    if (!status) throw new AffiliationError("Unknown career status");
    const since = typeof o.since === "string" && /^\d{4}$/.test(o.since.trim()) ? o.since.trim() : null;
    return { status, since };
  }
  if (typeof raw === "string") {
    const m = raw.match(/(\d{4})/);
    const status = toCareerStatus(raw.replace(/\b(since|in|after|from)\b.*$/i, "").replace(/\d{4}/, "").trim()) ?? toCareerStatus(raw);
    if (!status) throw new AffiliationError(`Unknown career status "${raw.slice(0, 40)}"`);
    return { status, since: m ? m[1] : null };
  }
  throw new AffiliationError("Unknown career status");
}

export function displayCareerStatus(v: CareerStatusValue): string {
  const label = { active: "Playing", between_teams: "Between teams", out_this_season: "Out this season", retired: "Retired" }[v.status];
  return v.since ? `${label} · ${v.since}` : label;
}

// ─── Found teams (research proposes, the athlete confirms) ────────────────────

/** A team research found. Same shape as TeamInput minus `primary`: a found row is never primary. */
export type FoundTeamInput = Omit<TeamInput, "primary">;

/**
 * Add research's teams as FOUND rows. Never touches said or proof rows, never sets a primary, never
 * changes the projection: a found current team becomes the athlete's team only when she confirms it
 * (the editor saves the list as said). A team already on record (same org + kind, case-insensitive)
 * is skipped. Returns the rows added.
 */
export async function proposeFoundAffiliations(opts: {
  athleteId: string; teams: FoundTeamInput[]; source: string;
}): Promise<Affiliation[]> {
  // A found team needs at least one date. A row with neither start nor end reads as CURRENT
  // (ended_on IS NULL), and research must not put a team on the athlete's present without a
  // year to anchor it — the level reader would take it as where she competes today.
  const dated = opts.teams.filter((t) => t.from || t.to);
  const proposed = dated.length ? coerceTeams(dated.map((t) => ({ ...t, primary: false }))) : [];
  if (!proposed.length) return [];
  const existing = await listAffiliations(opts.athleteId);
  const have = new Set(existing.map((e) => `${e.org.toLowerCase()}|${e.kind}`));
  const fresh = proposed.filter((t) => !have.has(`${t.org.toLowerCase()}|${t.kind}`));
  if (!fresh.length) return [];
  await db.insert(athleteAffiliations).values(fresh.map((t) => ({
    athlete_id: opts.athleteId, org_name: t.org, org_kind: t.kind, level: t.level ?? null, conference: t.conference ?? null,
    role: t.role ?? null, position: t.position ?? null, started_on: t.from ?? null, ended_on: t.to ?? null,
    is_primary: false, kind: "found", source: opts.source,
  })));
  const after = await listAffiliations(opts.athleteId);
  return after.filter((a) => a.kindOfFact === "found" && fresh.some((t) => t.org.toLowerCase() === a.org.toLowerCase() && t.kind === a.kind));
}

/**
 * A conservative fallback when research returned no structured teams: national and Olympic
 * programmes named in achievement text, with the achievement's year as the span. Generic on
 * purpose — it knows how national-team names are WRITTEN (an age-group token, the word "national
 * team", a federation acronym ending in NT, "Olympic"), never which sport or country.
 */
export function teamsFromAchievements(achievements: Array<{ name?: unknown; year?: unknown }>): FoundTeamInput[] {
  // Group mentions by programme (age group, or senior) so an undated "U-17 captain" line can take
  // the year from a dated "U-17 World Cup" line about the same programme. A group with no year at
  // all is skipped: a team with no date would read as current.
  const groups = new Map<string, { age: string | null; acronym: string | null; year: string | null; role: string | null; olympic: boolean }>();
  for (const a of achievements) {
    const name = typeof a?.name === "string" ? a.name : "";
    if (!name) continue;
    const year = a?.year != null && /^\d{4}$/.test(String(a.year)) ? String(a.year) : null;
    const age = name.match(/\b(U-?\s?\d{2})\b/i)?.[1]?.replace(/\s/g, "").toUpperCase().replace(/^U(\d)/, "U-$1") ?? null;
    const acronym = name.match(/\b([A-Z]{2,4}[WM]?NT)\b/)?.[1] ?? null;
    const olympic = /\bolympic/i.test(name);
    const national = /national team|\bnational\b|world cup/i.test(name) || !!acronym;
    if (!national && !olympic) continue;
    // One group per programme: the age group AND the federation acronym when the text names one, so
    // two countries' senior teams never merge. A youth mention without an acronym still joins the
    // same age group's named mention below (second pass) — "U-17 World Cup team, 2022" dates "U-17 USWNT".
    const key = olympic ? "olympic" : `${age ?? "senior"}|${acronym ?? ""}`;
    const g = groups.get(key) ?? { age, acronym: null, year: null, role: null, olympic };
    g.acronym = g.acronym ?? acronym;
    g.year = g.year ?? year;
    g.role = g.role ?? (/\bcaptain/i.test(name) ? "captain" : null);
    groups.set(key, g);
  }
  // Second pass: a named youth programme with no year takes the year (and role) from the same age
  // group's unnamed mention, which then folds into it. Senior mentions never merge across names.
  for (const [key, g] of groups) {
    if (!g.age || g.olympic || !g.acronym) continue;
    const twin = groups.get(`${g.age}|`);
    if (twin) { g.year = g.year ?? twin.year; g.role = g.role ?? twin.role; groups.delete(`${g.age}|`); }
    groups.set(key, g);
  }
  const out: FoundTeamInput[] = [];
  for (const g of groups.values()) {
    if (!g.year) continue;
    const org = g.olympic ? "Olympic team" : [g.age, g.acronym ?? "national team"].filter(Boolean).join(" ");
    out.push({ org, kind: g.olympic ? "olympic" : "national", level: g.age ?? (g.olympic ? null : "senior"), role: g.role, from: g.year, to: g.year, position: null, conference: null });
  }
  return out;
}

// ─── The competition level, read from the rows ───────────────────────────────

export interface LevelRecord {
  /** The team the level came from, or null when the athlete has no rows at all. */
  org: string | null;
  kind: OrgKind | null;
  /** What scoringService.AthleteRecord reads: division text, conference, and a segment word. */
  division: string | null;
  conference: string | null;
  segment: "pro" | "olympic" | "college" | "high_school" | "youth" | null;
  /** True when a current national or Olympic row sits beside the primary team (two shirts). */
  alsoNational: boolean;
}

const SCHOOL_DIVISIONS = ["D1", "FBS", "FCS", "D2", "D3", "NAIA", "JUCO", "NJCAA"];

/**
 * Where the athlete competes, from athlete_affiliations. Highest CURRENT team wins (olympic and
 * senior national count as the top tier, then pro, then school, then club); with no current row —
 * retired, between teams — the highest level she ever held. `fallback` is the athletes row's own
 * columns, used only when there are no rows at all (an account that predates 0041's backfill).
 * Sport-neutral: kinds and division strings, never a sport or a league name.
 */
export async function levelRecordFor(
  athleteId: string,
  fallback: { division?: string | null; conference?: string | null; segment?: string | null } = {},
): Promise<LevelRecord> {
  const all = await listAffiliations(athleteId);
  // Research proposes; the athlete's word (said) or a contract (proof) decides. A found row sets
  // the level only when there is nothing else on record.
  const confirmed = all.filter((r) => r.kindOfFact !== "found");
  const rows = confirmed.length ? confirmed : all;
  if (!rows.length) {
    return { org: null, kind: null, division: fallback.division ?? null, conference: fallback.conference ?? null, segment: (fallback.segment as LevelRecord["segment"]) ?? null, alsoNational: false };
  }
  const current = rows.filter((r) => r.current);
  const pool = current.length ? current : rows;
  const rank = (r: Affiliation) => {
    if (r.kind === "olympic") return 6;
    if (r.kind === "national") return /^u-?\d{2}/i.test(r.level ?? "") ? 3 : 5; // youth national sits with school, senior with the top
    if (r.kind === "pro") return 4;
    if (r.kind === "school") return SCHOOL_DIVISIONS.includes((r.level ?? "").toUpperCase()) ? 3 : 2;
    return 1; // club
  };
  const top = [...pool].sort((a, b) => rank(b) - rank(a) || Number(b.primary) - Number(a.primary))[0];
  const alsoNational = current.some((r) => r !== top && (r.kind === "national" || r.kind === "olympic"));
  const level = (top.level ?? "").trim();
  let segment: LevelRecord["segment"];
  let division: string | null = level || null;
  if (top.kind === "olympic" || (top.kind === "national" && rank(top) === 5)) { segment = "olympic"; division = division ?? "Olympic"; }
  else if (top.kind === "pro") { segment = "pro"; division = "Pro"; }
  else if (top.kind === "school") {
    const up = level.toUpperCase();
    if (SCHOOL_DIVISIONS.includes(up)) { segment = "college"; division = up; }
    else if (/high school|^hs$|class \d|varsity/i.test(level)) { segment = "high_school"; division = "High School"; }
    else { segment = fallback.segment === "high_school" ? "high_school" : "college"; division = division ?? fallback.division ?? null; }
  } else if (top.kind === "national") { segment = "college"; division = level || null; } // a youth national team beside no club: school-tier
  else { segment = "youth"; division = level || "Club"; }
  // 2d-6 (D11, user decision): one representation of the conference everywhere — the same normalisation as the projection.
  return { org: top.org, kind: top.kind, division, conference: normalizeConference(top.conference ?? (top.kind === "school" ? fallback.conference ?? null : null)), segment, alsoNational };
}

/** One line for a prompt: "Stanford University (school, D1, current, primary); U-17 USWNT (national, 2022)". */
export async function teamsLineFor(athleteId: string): Promise<string | null> {
  const rows = await listAffiliations(athleteId);
  if (!rows.length) return null;
  return rows.map((r) => `${r.org} (${[r.kind, r.level, r.current ? "current" : r.to ? `ended ${r.to.slice(0, 4)}` : "past", r.primary ? "primary" : null].filter(Boolean).join(", ")})`).join("; ");
}
