/**
 * agent/research/v2/wikidata.ts — FREE discovery: the first step of lean sign-up research (v2/lean.ts, signup_research
 * v4 behind LEAN_SIGNUP_RESEARCH) and of the research bake-off. No search engine: Wikidata (CC0, free) says which pages
 * belong to the athlete, and our own fetcher reads them and follows a few same-site links.
 *
 *   1. Wikidata entity search for the athlete's name; keep only hits whose description, sport, occupation or position
 *      matches the athlete's sport (a same-name researcher or actress is never followed).
 *   2. Seed pages from each kept hit: its English Wikipedia article, its official website (P856), the pages its
 *      external identifiers point to (each identifier property's own formatter URL, P1630 — nothing hard-coded per
 *      site), and the official website of each team it is a member of (P54).
 *   3. The team the athlete gave at sign-up: Wikidata full-text search for the team words restricted to items of the
 *      athlete's sport (haswbstatement:P641=<sport>), and those teams' official websites.
 *   4. From a team's site: same-site roster links (pickRosterLinks); from a roster page: links that name the athlete
 *      (pickAthleteLinks). The existing v2 link-following (rank.ts pickFollowLinks) then runs as usual.
 *
 * Why not Google: Google's grounding terms forbid using grounded links to choose pages to crawl (see PR #1129), so the
 * free path uses no search engine at all; OpenAI web search is the paid second step (lean.ts).
 *
 * Wikidata's data-access guidance (https://www.wikidata.org/wiki/Wikidata:Data_access, read 26 Oct 2026): Action API
 * for small groups of entities (≤50 ids per wbgetentities request), a descriptive User-Agent, no excessive parallel
 * requests, back off on 429. All requests here are sequential and carry V2.userAgent. Ported from the Wikidata tool in
 * draft PR #1129 (server/scripts/research/searchScoreEval.ts), with the identifier and team steps added.
 */
import { V2 } from "./config";
import { sportTermsOf, termMatcher } from "./sportTerms";
import { namesAthlete, urlNamesAthlete } from "./rank";
import type { CleanPage } from "./fetchClean";

const WD = "https://www.wikidata.org/w/api.php";

export interface WikidataEntity {
  id: string;
  label: string;
  description: string;
  /** property id → values (an item id, a string, or a time). */
  claims: Record<string, string[]>;
  enwiki: string | null;
}

/** One seed page Wikidata pointed to, and why. */
export interface WikidataSeed {
  url: string;
  kind: "wikipedia" | "official_site" | "identifier" | "team_site";
  /** The entity (athlete or team) it came from, and a short note (the identifier property label, the team label). */
  from: string;
  note: string;
}

export type WikidataGet = (params: Record<string, string>) => Promise<any>;

export const wdGet = (fetchImpl: typeof fetch = fetch): WikidataGet => async (params) => {
  const qs = new URLSearchParams({ format: "json", origin: "*", ...params });
  const res = await fetchImpl(`${WD}?${qs}`, { headers: { "user-agent": V2.userAgent, "accept-encoding": "gzip,deflate" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`wikidata ${res.status}`);
  return res.json();
};

const valueOf = (c: any): string | null => {
  const v = c?.mainsnak?.datavalue?.value;
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v.id) return String(v.id);
  if (v.time) return String(v.time).slice(1, 11);
  return null;
};

/** Pure: a wbgetentities entity → our shape (preferred-rank claims first, deprecated ones dropped). */
export function entityOf(id: string, e: any): WikidataEntity {
  const claims: Record<string, string[]> = {};
  for (const [p, list] of Object.entries((e?.claims ?? {}) as Record<string, any[]>)) {
    const rank = (c: any) => (c?.rank === "preferred" ? 0 : 1);
    const vals = [...list].filter((c) => c?.rank !== "deprecated").sort((a, b) => rank(a) - rank(b)).map(valueOf).filter((v): v is string => !!v);
    if (vals.length) claims[p] = vals;
  }
  const title = e?.sitelinks?.enwiki?.title;
  return {
    id, label: e?.labels?.en?.value ?? "", description: e?.descriptions?.en?.value ?? "", claims,
    enwiki: title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, "_"))}` : null,
  };
}

async function getEntities(get: WikidataGet, ids: string[], props = "labels|descriptions|claims|sitelinks"): Promise<WikidataEntity[]> {
  const out: WikidataEntity[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const e = await get({ action: "wbgetentities", ids: chunk.join("|"), props, languages: "en" });
    for (const id of chunk) if (e?.entities?.[id]) out.push(entityOf(id, e.entities[id]));
  }
  return out;
}

/** Properties whose item labels say what sport / role a person has: sport, occupation, position played. */
const ROLE_PROPS = ["P641", "P106", "P413"];

/** Pure: does this hit look like an athlete in this sport? Its description or the labels of its sport, occupation or
 *  position must use one of the sport's terms (sportTerms.ts). A hit with none of them is never followed. */
export function matchesSport(hit: WikidataEntity, roleLabels: string[], sport: string): boolean {
  const m = termMatcher(sportTermsOf(sport));
  if (!m) return false;
  return m.test(hit.description) || roleLabels.some((l) => m.test(l));
}

/** Pure: an external identifier's page from the property's formatter URL (P1630): $1 replaced by the value. Web
 *  archive and social formatters are skipped (the fetcher drops social pages anyway). */
export function identifierUrl(formatters: string[], value: string): string | null {
  const f = formatters.find((x) => /^https?:\/\//.test(x) && x.includes("$1") && !/web\.archive\.org/.test(x));
  if (!f) return null;
  return f.replace("$1", encodeURIComponent(value).replace(/%2F/gi, "/"));
}

const SOCIAL = /\b(facebook|instagram|tiktok|x|twitter|linkedin|pinterest|youtube|threads|snapchat)\.com\b/i;
/** Identifier pages that are search engines, media files or library authority records, not pages about the athlete's
 *  sport career (generic hosts, never an athlete's or a team's). */
const NOT_A_PROFILE = /\b(google\.com|wikimedia\.org|wikipedia\.org|wikidata\.org|viaf\.org|id\.loc\.gov|d-nb\.info|isni\.org|worldcat\.org|musicbrainz\.org|freebase)\b/i;

export interface WikidataDiscovery {
  /** Every athlete hit we saw, and whether it matched the sport (kept) — the wrong-person check at this step. */
  hits: Array<{ id: string; label: string; description: string; kept: boolean }>;
  seeds: WikidataSeed[];
  requests: number;
  errors: string[];
}

/**
 * The free seeds for one athlete. `team` is what the athlete gave at sign-up (may be empty). At most `maxIdentifiers` (8)
 * identifier pages per athlete hit (in the order Wikidata lists the properties) and 3 team sites.
 */
export async function wikidataSeeds(input: { name: string; sport: string; team?: string | null }, get: WikidataGet = wdGet(), opts: { maxIdentifiers?: number; maxHits?: number } = {}): Promise<WikidataDiscovery> {
  const errors: string[] = [];
  let requests = 0;
  const call = async (p: Record<string, string>) => { requests++; return get(p); };
  const seeds: WikidataSeed[] = [];
  const hitsOut: WikidataDiscovery["hits"] = [];
  const maxIds = opts.maxIdentifiers ?? 8;
  const add = (s: WikidataSeed) => { if (/^https?:\/\//.test(s.url) && !SOCIAL.test(s.url) && !seeds.some((x) => x.url === s.url)) seeds.push(s); };
  let sportItem: string | null = null;
  try {
    const s = await call({ action: "wbsearchentities", search: input.name, language: "en", limit: "7", type: "item" });
    const ids: string[] = (s?.search ?? []).map((x: any) => String(x.id));
    const ents = ids.length ? await getEntities((p) => call(p), ids) : [];
    // Labels for the role items of every hit, in one request.
    const roleIds = [...new Set(ents.flatMap((e) => ROLE_PROPS.flatMap((p) => e.claims[p] ?? [])).filter((v) => /^Q\d+$/.test(v)))].slice(0, 50);
    const roleLabel = new Map<string, string>();
    if (roleIds.length) for (const e of await getEntities((p) => call(p), roleIds, "labels")) roleLabel.set(e.id, e.label);
    const kept = ents.filter((e) => {
      // A person (instance of human, Q5) with the athlete's name, in their sport — never a foundation or a term.
      const ok = (e.claims.P31 ?? []).includes("Q5") && namesAthlete(e.label, input.name) && matchesSport(e, ROLE_PROPS.flatMap((p) => (e.claims[p] ?? []).map((v) => roleLabel.get(v) ?? "")), input.sport);
      hitsOut.push({ id: e.id, label: e.label, description: e.description, kept: ok });
      return ok;
    }).slice(0, opts.maxHits ?? 2);
    sportItem = kept.flatMap((e) => e.claims.P641 ?? [])[0] ?? null;
    // Identifier properties: their formatter URLs, in one request.
    const extProps = new Map<string, Array<{ hit: string; value: string }>>();
    for (const e of kept) {
      if (e.enwiki) add({ url: e.enwiki, kind: "wikipedia", from: e.id, note: "English Wikipedia article" });
      for (const site of e.claims.P856 ?? []) add({ url: site, kind: "official_site", from: e.id, note: "official website (P856)" });
      for (const [p, vals] of Object.entries(e.claims)) {
        if (!/^P\d+$/.test(p) || /^Q\d+$/.test(vals[0]) || /^\d{4}-\d{2}-\d{2}$/.test(vals[0]) || p === "P856") continue;
        extProps.set(p, [...(extProps.get(p) ?? []), { hit: e.id, value: vals[0] }]);
      }
    }
    if (extProps.size) {
      const props = await getEntities((p) => call(p), [...extProps.keys()].slice(0, 50), "labels|claims");
      const perHit = new Map<string, number>();
      for (const prop of props) {
        const formatters = prop.claims.P1630 ?? [];
        for (const { hit, value } of extProps.get(prop.id) ?? []) {
          if ((perHit.get(hit) ?? 0) >= maxIds) continue;
          const url = identifierUrl(formatters, value);
          if (!url || SOCIAL.test(url) || NOT_A_PROFILE.test(url)) continue;
          perHit.set(hit, (perHit.get(hit) ?? 0) + 1);
          add({ url, kind: "identifier", from: hit, note: prop.label || prop.id });
        }
      }
    }
    // The teams the athlete is a member of (P54): the latest listed first.
    const teamIds = [...new Set(kept.flatMap((e) => [...(e.claims.P54 ?? [])].reverse()))].slice(0, 3);
    if (teamIds.length) for (const t of await getEntities((p) => call(p), teamIds, "labels|claims")) for (const site of (t.claims.P856 ?? []).slice(0, 1)) add({ url: site, kind: "team_site", from: t.id, note: `${t.label} (member of sports team)` });
  } catch (err: any) {
    errors.push(`athlete: ${String(err?.message ?? err).slice(0, 160)}`);
  }
  // The team the athlete gave: Wikidata full-text search for its words among items of the athlete's sport.
  const team = (input.team ?? "").trim();
  if (team) {
    try {
      if (!sportItem) {
        const s = await call({ action: "wbsearchentities", search: input.sport, language: "en", limit: "1", type: "item" });
        sportItem = s?.search?.[0]?.id ?? null;
      }
      const q = sportItem ? `${team} haswbstatement:P641=${sportItem}` : team;
      const r = await call({ action: "query", list: "search", srsearch: q, srlimit: "3", srnamespace: "0" });
      const ids: string[] = (r?.query?.search ?? []).map((x: any) => String(x.title)).filter((t: string) => /^Q\d+$/.test(t));
      if (ids.length) for (const t of await getEntities((p) => call(p), ids, "labels|claims")) for (const site of (t.claims.P856 ?? []).slice(0, 1)) add({ url: site, kind: "team_site", from: t.id, note: `${t.label} (the team the athlete gave)` });
    } catch (err: any) {
      errors.push(`team: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  return { hits: hitsOut, seeds, requests, errors };
}

const ROSTER = /\b(roster|squad|players|team)\b/i;

/** Pure: same-site roster links on a team page (link text or path says roster / squad / players), most specific
 *  first (a path that also carries a sport term). */
export function pickRosterLinks(page: Pick<CleanPage, "url" | "links">, sport: string, max = 2): string[] {
  const m = termMatcher(sportTermsOf(sport));
  // A team page with a path (a school's one sport, e.g. /sports/<sport>) keeps only rosters under that path, so a
  // sibling team's roster (another sport or the other gender's team) is never chosen.
  const base = (() => { try { return new URL(page.url).pathname.replace(/\/$/, ""); } catch { return ""; } })();
  const under = (u: string) => { try { return !base || new URL(u).pathname.startsWith(`${base}/`); } catch { return false; } };
  const scored = (page.links ?? [])
    .filter((l) => under(l.url) && (/roster|squad|players/i.test(l.url) || ROSTER.test(l.text)))
    .map((l) => ({ url: l.url, score: (/roster|squad/i.test(l.url) ? 2 : 0) + (m && m.test(l.url.replace(/[-_/]/g, " ")) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((s) => s.url))].filter((u) => u !== page.url).slice(0, max);
}

/** Pure: links on a roster or team page that name the athlete (in the link text or the URL). */
export function pickAthleteLinks(page: Pick<CleanPage, "url" | "links">, name: string, max = 2): string[] {
  const out = (page.links ?? []).filter((l) => namesAthlete(l.text, name) || urlNamesAthlete(l.url, name)).map((l) => l.url);
  return [...new Set(out)].filter((u) => u !== page.url).slice(0, max);
}
