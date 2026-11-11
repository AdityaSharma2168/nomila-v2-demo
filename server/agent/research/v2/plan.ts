/**
 * agent/research/v2/plan.ts — the PLAN step: a few targeted queries. Deterministic (no model, no cost): today's passes
 * run up to 10 open-ended searches each; this asks only for what is needed. Two moments, one function:
 *
 *   signup  — we hold only the name and sport, maybe a team and, if the athlete connected an account, a handle. The plan
 *             is IDENTITY FIRST: the first queries exist to find the right person (name + sport/team, official roster
 *             or bio, handle), then three merged evidence queries (results + honours, partners, media). If identity cannot be confirmed, the pipeline says so and
 *             keeps nothing (pipeline.ts).
 *   refresh — the athlete's record is known. One identity anchor query, then the evidence areas the record covers
 *             least (no current found fact, or only stale ones); results and upcoming always (they go stale fastest).
 *
 * Every query carries the quoted name and the sport or team, so a namesake in another sport rarely comes back at all.
 */
import type { MemoryFact } from "../../../../shared/agent";
import { V2 } from "./config";

export type ResearchMoment = "signup" | "refresh";

export interface PlanInput {
  name: string;
  sport: string;
  /** Team, school, club or tour, when the athlete told us one (said). */
  team?: string | null;
  /** Social handles we hold (without @) — only from accounts the athlete connected. */
  handles?: string[];
  /** Today, YYYY-MM-DD — anchors "this season". */
  today: string;
  /** Default signup. */
  moment?: ResearchMoment;
  /** refresh: the athlete's facts, to aim at what the record lacks. */
  known?: MemoryFact[];
}

export type Aim = "identity" | "results" | "honours" | "partners" | "media" | "audience" | "upcoming";
type EvidenceAim = Exclude<Aim, "identity">;

export interface PlannedQuery {
  /** What the query is for (one of the evidence areas research covers). */
  aim: Aim;
  q: string;
}

/** Which research topics (research/schemas.ts FACT_TOPICS) count as covering each evidence area. */
export const AIM_TOPICS: Record<EvidenceAim, string[]> = {
  results: ["competition", "stats"],
  honours: ["achievement"],
  partners: ["sponsor", "business", "commerce"],
  media: ["media", "story", "conversation"],
  audience: ["social", "audience_growth", "engagement"],
  upcoming: ["upcoming", "event"],
};
/** A found fact older than this no longer counts as covering its area at refresh. */
const STALE_DAYS = 180;
/** At refresh, an area with at least this many current facts is covered (unless it is time-sensitive). */
const COVERED = 2;

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Pure: per evidence area, how many current (active, found, not stale) facts the record holds. */
export function coverageOf(known: MemoryFact[], today: string): Record<EvidenceAim, number> {
  const cutoff = Date.parse(today) - STALE_DAYS * 86_400_000;
  const out: Record<EvidenceAim, number> = { results: 0, honours: 0, partners: 0, media: 0, audience: 0, upcoming: 0 };
  for (const f of known) {
    if (f.type !== "found" || f.status !== "active" || !f.topic) continue;
    const when = Date.parse(f.date ?? f.createdAt);
    if (Number.isFinite(when) && when < cutoff) continue;
    for (const aim of Object.keys(AIM_TOPICS) as EvidenceAim[]) if (AIM_TOPICS[aim].includes(f.topic)) out[aim]++;
  }
  return out;
}

/** Pure: the query strings every plan is built from (planQueries, leanPlanQueries, leanFollowUpQueries). */
function queryParts(input: PlanInput) {
  const name = clean(input.name);
  const sport = clean(input.sport);
  const team = clean(input.team);
  const year = Number(input.today.slice(0, 4)) || new Date().getUTCFullYear();
  const anchor = team ? `${sport} ${team}` : sport;
  const quoted = `"${name}"`;
  const handle = (input.handles ?? []).map((h) => clean(h).replace(/^@/, "")).find(Boolean);
  const evidence: Record<EvidenceAim, string> = {
    results: `${quoted} ${anchor} stats ${year}`,
    honours: `${quoted} ${sport} award OR honors OR record`,
    partners: `${quoted} ${sport} NIL OR sponsor OR endorsement OR partnership`,
    media: `${quoted} ${sport} interview OR feature OR profile`,
    audience: handle ? `"${handle}" ${quoted}` : `${quoted} ${sport} instagram OR tiktok OR youtube`,
    upcoming: `${quoted} ${anchor} ${year} schedule OR upcoming OR selected`,
  };
  // Official sources first-hand: the team's or school's own athletics site when we know the team; otherwise the
  // governing bodies (national team, federation, league) that publish rosters and results for the sport. One query
  // covers roster, bio and profile pages (they overlapped as separate searches).
  const official: PlannedQuery = team
    ? { aim: "identity", q: `${quoted} ${team} ${sport} roster OR bio OR profile` }
    : { aim: "identity", q: `${quoted} ${sport} roster OR bio OR "national team" OR federation` };
  return { name, sport, year, anchor, quoted, handle, evidence, official };
}

const uniqueQueries = (qs: PlannedQuery[], max: number) => {
  const seen = new Set<string>();
  return qs.filter((p) => (seen.has(p.q.toLowerCase()) ? false : (seen.add(p.q.toLowerCase()), true))).slice(0, max);
};

/** Lean research plans at most this many first-round queries (one OpenAI web search each). */
export const LEAN_MAX_QUERIES = 8;
/** The commercial evidence areas lean research covers at sign-up (owner, 26 Oct 2026: the first lean records had no
 *  partner, audience or media facts, so the score could read only results and honours). */
export const COMMERCIAL_AIMS: readonly EvidenceAim[] = ["partners", "audience", "media", "upcoming"];
export type { EvidenceAim };

/**
 * Pure: LEAN research's first-round plan (v2/lean.ts; signup_research v4 behind LEAN_SIGNUP_RESEARCH, the leanRun
 * command and the refresh_research tool). Identity first (name + sport/team, the official roster or bio, the handle),
 * then results and honours, then EVERY commercial area — partners, audience, media, upcoming.
 *   aims  only these evidence areas (the refresh_research tool's topics; [] = identity only); identity queries are always planned. Absent:
 *         every area at sign-up; at refresh the areas the record covers least first (results and upcoming always).
 */
export function leanPlanQueries(input: PlanInput & { aims?: readonly EvidenceAim[] | null }): PlannedQuery[] {
  const { name, sport, anchor, quoted, handle, evidence, official, year } = queryParts(input);
  if (!name || !sport) return [];
  const out: PlannedQuery[] = [{ aim: "identity", q: `${quoted} ${anchor}` }, official];
  if (handle) out.push({ aim: "identity", q: `"${handle}" ${quoted} ${sport}` });
  const results: PlannedQuery = { aim: "results", q: `${quoted} ${anchor} stats OR award OR honors OR record ${year}` };
  if (input.aims) {
    // Only the areas asked for; none (the refresh_research tool's "identity" topic) ⇒ the identity queries only.
    for (const aim of input.aims) out.push(aim === "results" ? results : { aim, q: evidence[aim] });
  } else if ((input.moment ?? "signup") === "signup") {
    out.push(results, ...COMMERCIAL_AIMS.map((aim) => ({ aim, q: evidence[aim] })));
  } else {
    const cov = coverageOf(input.known ?? [], input.today);
    const always = new Set<EvidenceAim>(["results", "upcoming"]);
    const order = (Object.keys(evidence) as EvidenceAim[]).filter((a) => always.has(a) || cov[a] < COVERED).sort((a, b) => cov[a] - cov[b]);
    for (const aim of order) out.push({ aim, q: evidence[aim] });
  }
  return uniqueQueries(out, LEAN_MAX_QUERIES);
}

/**
 * Pure: the ONE follow-up round of lean research — a targeted query, worded differently from the first round's, for
 * each evidence area the first round's verified facts left at zero. Generic words only (no league, brand or outlet).
 */
export function leanFollowUpQueries(input: PlanInput, empty: readonly EvidenceAim[]): PlannedQuery[] {
  const { name, sport, anchor, quoted, year } = queryParts(input);
  if (!name || !sport) return [];
  const q: Record<EvidenceAim, string> = {
    partners: `${quoted} ${sport} "brand ambassador" OR "signs with" OR "NIL deal" OR partners`,
    audience: `${quoted} ${sport} followers OR subscribers OR "social media"`,
    media: `${quoted} ${sport} podcast OR "feature story" OR documentary OR interview ${year}`,
    upcoming: `${quoted} ${anchor} next OR upcoming OR "will compete" ${year}`,
    results: `${quoted} ${anchor} season statistics`,
    honours: `${quoted} ${sport} named OR selected OR award`,
  };
  return uniqueQueries(empty.map((aim) => ({ aim, q: q[aim] })), COMMERCIAL_AIMS.length);
}

export function planQueries(input: PlanInput): PlannedQuery[] {
  const name = clean(input.name);
  const sport = clean(input.sport);
  if (!name || !sport) return [];
  const { year, anchor, quoted, handle, evidence, official } = queryParts(input);
  const out: PlannedQuery[] = [{ aim: "identity", q: `${quoted} ${anchor}` }];
  if ((input.moment ?? "signup") === "signup") {
    // Identity first, then three merged evidence queries: every planned query is billed per Google search it runs,
    // and the athlete's own pages (read whole, plus the same-site pages they link to) carry most of the facts.
    out.push(official);
    if (handle) out.push({ aim: "identity", q: `"${handle}" ${quoted} ${sport}` });
    out.push({ aim: "results", q: `${quoted} ${anchor} stats OR award OR honors OR record ${year}` });
    out.push({ aim: "partners", q: evidence.partners });
    out.push({ aim: "media", q: evidence.media });
  } else {
    // Refresh: the areas the record covers least first; results and upcoming always.
    const cov = coverageOf(input.known ?? [], input.today);
    const always = new Set<EvidenceAim>(["results", "upcoming"]);
    const order = (Object.keys(evidence) as EvidenceAim[])
      .filter((a) => always.has(a) || cov[a] < COVERED)
      .sort((a, b) => cov[a] - cov[b]);
    out.push(official);
    for (const aim of order) out.push({ aim, q: evidence[aim] });
  }
  return uniqueQueries(out, V2.maxQueries);
}
