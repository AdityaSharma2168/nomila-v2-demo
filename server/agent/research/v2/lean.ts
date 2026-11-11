/**
 * agent/research/v2/lean.ts — LEAN research: the one sign-up research path the owner approved on 26 Oct 2026 ("build the
 * real path once" — the bake-off's winning chain, so a later comparison is a command, not new glue). Behind
 * LEAN_SIGNUP_RESEARCH (dev true, prod false): signup_research v4 (onboarding/leanResearchStep.ts), the
 * lean_research_refresh run Mila's refresh_research tool starts, and the leanRun command (shadow, writes nothing).
 *
 *   plan       code: identity first, then results and EVERY commercial area (partners, audience, media, upcoming)
 *   discover   FREE first — Wikidata (CC0): the athlete's Wikipedia article, official site, identifier pages and team
 *              sites, then the team site's roster and the athlete's link on it — then OpenAI web search (the existing
 *              openai_search provider), never Google grounding (its terms forbid fetching grounded links)
 *   fetch      our own fetcher, once per page (robots.txt, Defuddle), plus a few same-site links from her own pages
 *   rank       code: identity per page (a namesake's page is rejected), her own pages whole, others as passages
 *   extract    research/extract-all (configurable model; default gpt-6.1-sol at low effort, the bake-off's pick)
 *   identity   unresolved ⇒ an honest "couldn't confirm": no fact is kept (the caller records the identity outcome)
 *   verify     research/verify-facts 1.1.0: each fact beside the text of the page it cites
 *   follow-up  ONE extra round, cost-capped: a targeted query for each M.I.A. dimension the verified facts left without
 *              a single fact (v2/dimensions.ts maps fact topics to the eight dimensions)
 *
 * Everything outside is injectable (Wikidata, search, fetch, the model calls), so tests reach no provider and the same
 * function runs live (the workflow) and in shadow (leanRun). It writes nothing itself: saving is leanSave.ts.
 */
import type { MemoryFact, ModelChoice } from "../../../../shared/agent";
import { EFFORTS, type Effort } from "../../../../shared/agent";
import type { AthleteIdentity, PassFact } from "../research";
import { V2, type CleanerId } from "./config";
import { AIM_TOPICS, leanFollowUpQueries, leanPlanQueries, type EvidenceAim, type PlannedQuery, type ResearchMoment } from "./plan";
import { emptyDimensions, factsByDimension } from "./dimensions";
import type { MarketabilityDimension } from "../../../services/intelligence/types";
import { discover, DiscoverCapRefusal, qualityOf, type DiscoverQuery, type FoundPage } from "./discover";
import { fetchAndClean, type CleanPage, type SkipReason } from "./fetchClean";
import { namesAthlete, pageIdentity, pickFollowLinks, rankPassages, type Passage } from "./rank";
import { pickAthleteLinks, pickRosterLinks, wdGet, wikidataSeeds, type WikidataDiscovery, type WikidataGet } from "./wikidata";
import { extractAll, verifyFacts, type LeanModelCall } from "./extractAll";
import { questionFrom, type IdentityQuestion } from "./pipeline";
import { providerOf } from "../../models";
import { readCap } from "../../../lib/spendCap";

// ── config ───────────────────────────────────────────────────────────────────

/** LEAN_SIGNUP_RESEARCH exactly "true": new sign-up research runs pin signup_research v4 and Mila's refresh_research
 *  tool is offered. Dev true, prod false (gcp yamls). */
export function leanSignupResearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEAN_SIGNUP_RESEARCH === "true";
}

export type LeanSearch = "openai" | "none";
/** LEAN_RESEARCH_SEARCH: "none" turns the paid search off (free discovery only); anything else is OpenAI web search. */
export function leanSearchOf(env: NodeJS.ProcessEnv = process.env): LeanSearch {
  return env.LEAN_RESEARCH_SEARCH === "none" ? "none" : "openai";
}

/** "gpt-6.1-sol", "gpt-6.1-sol:low", "gpt-6-luna:medium" → a ModelChoice (effort default low). Null for empty input. */
export function parseModelChoice(raw: string | null | undefined, fallbackEffort: Effort = "low"): ModelChoice | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const [model, e] = s.split(":");
  const effort = e && (EFFORTS as readonly string[]).includes(e) ? (e as Effort) : fallbackEffort;
  return { provider: providerOf(model), model, effort };
}

/** The extract model: LEAN_RESEARCH_EXTRACT_MODEL ("model[:effort]"); unset ⇒ the skill's own (gpt-6.1-sol, low). */
export const leanExtractModel = (env: NodeJS.ProcessEnv = process.env) => parseModelChoice(env.LEAN_RESEARCH_EXTRACT_MODEL);
/** The verifier model: LEAN_RESEARCH_VERIFY_MODEL; unset ⇒ the skill's own (the fast tier, gpt-6-luna, low). */
export const leanVerifyModel = (env: NodeJS.ProcessEnv = process.env) => parseModelChoice(env.LEAN_RESEARCH_VERIFY_MODEL);

/** A USD cap from env, clamped to `max` and failing closed (lib/spendCap.ts); "0" allowed (no follow-up round). */
const usd = (name: string, fallback: number, max: number, env: NodeJS.ProcessEnv) =>
  Math.round(readCap(name, fallback, max, { allowZero: true, env }) * 1_000_000);

export const LEAN = {
  /** Wikidata identifier pages per athlete hit, roster links per team page, athlete links from rosters. */
  maxIdentifiers: 8,
  maxRosterLinks: 2,
  maxAthleteLinks: 3,
  /** Pages fetched from search results per round (the free pages are always read). */
  maxSearchFetch: V2.maxFetch,
  /** The follow-up round runs only while the run's spend so far is under this (LEAN_RESEARCH_FOLLOWUP_MAX_USD,
   *  default 0.40) — a famous athlete whose first round already cost a lot gets no second one. */
  followUpMaxMicroUsd: (env: NodeJS.ProcessEnv = process.env) => usd("LEAN_RESEARCH_FOLLOWUP_MAX_USD", 0.4, 2, env),
} as const;

/** Which research topics count for each evidence area here: v2's AIM_TOPICS plus audience demographics and dated
 *  moments (the extract schema's topic list has both). */
export const LEAN_AIM_TOPICS: Record<EvidenceAim, string[]> = {
  ...AIM_TOPICS,
  audience: [...AIM_TOPICS.audience, "demographics"],
  upcoming: [...AIM_TOPICS.upcoming, "moment"],
};

/** Pure: verified facts per topic, and per evidence area (facts about the athlete only). */
export function factsByTopic(facts: Array<Pick<PassFact, "topic" | "subject_kind">>): { topics: Record<string, number>; aims: Record<EvidenceAim, number> } {
  const topics: Record<string, number> = {};
  for (const f of facts) topics[f.topic || "other"] = (topics[f.topic || "other"] ?? 0) + 1;
  const aims = Object.fromEntries((Object.keys(LEAN_AIM_TOPICS) as EvidenceAim[]).map((a) => [a, facts.filter((f) => f.subject_kind === "athlete" && LEAN_AIM_TOPICS[a].includes(f.topic)).length])) as Record<EvidenceAim, number>;
  return { topics, aims };
}

// ── the run ──────────────────────────────────────────────────────────────────

export interface LeanInput {
  athlete: AthleteIdentity;
  team?: string | null;
  handles?: string[];
  /** The athlete's facts (said facts anchor identity; at refresh the record's coverage steers the plan). */
  known: MemoryFact[];
  today: string;
  moment?: ResearchMoment;
  /** Only these evidence areas (refresh_research topics); identity is always checked. */
  aims?: EvidenceAim[] | null;
}

export interface LeanDeps {
  /** The model calls (live: skillModelCall; shadow: directModelCall; tests: a fake). */
  call: LeanModelCall;
  /** OpenAI web search per query, or null (no paid search: free discovery only). */
  discoverQuery: DiscoverQuery | null;
  wikidataGet?: WikidataGet;
  fetchImpl?: typeof fetch;
  cleaner?: CleanerId;
  extractModel?: ModelChoice | null;
  verifyModel?: ModelChoice | null;
  /** A retried step's earlier search results (already paid): reused instead of searching again. */
  priorSearch?: { pages: FoundPage[]; searchQueries: number; costMicroUsd: number } | null;
  /** The same for the follow-up round's search (a retried, or held then released, step never pays for it twice). */
  priorFollowUpSearch?: { pages: FoundPage[]; searchQueries: number } | null;
  /** Spend before this run (micro-dollars), counted against the follow-up round's cap. */
  spentBeforeMicroUsd?: number;
  followUpMaxMicroUsd?: number;
  /** Dry run (leanRun --dry): free discovery, fetch and rank only — no model call and no paid search. */
  dryRun?: boolean;
  /**
   * Where the run is now, as it happens (the waitlist's live status line): finding her pages, reading them (count =
   * pages read so far), pulling facts from them (count = passages), checking the facts (count = facts to check). Called
   * at each real transition; must not throw (errors are swallowed here) and is never awaited.
   */
  onStage?: (s: LeanStage) => void;
  /**
   * Paid search spend, recorded AS SOON AS it is known: after each round's search, before any extract call that the
   * platform day cap could refuse (the step would then be held and its spend otherwise never reach agent_runs).
   * `complete` false: the platform cap refused part of the search (the step is about to be held); those results are
   * spend only, never reused. Awaited; an error here fails the step.
   */
  onSearchSpend?: (s: LeanSearchSpend) => Promise<void>;
}

export interface LeanSearchSpend {
  round: 1 | 2;
  complete: boolean;
  queries: string[];
  pages: FoundPage[];
  searchQueries: number;
  costMicroUsd: number;
}

/** A lean run's live stage (see LeanDeps.onStage). */
export interface LeanStage { stage: "finding" | "reading" | "pulling" | "checking"; count?: number }
const report = (deps: LeanDeps, s: LeanStage) => { try { deps.onStage?.(s); } catch { /* a status line never breaks research */ } };

type Via = "wikidata" | "followed" | "search" | "search_followup";
export interface LeanPage extends CleanPage { quality: number; via: Via; note: string }

export interface LeanRound {
  queries: PlannedQuery[];
  passages: Passage[];
  extracted: number;
  checked: number;
  identityResolved: boolean;
  verified: PassFact[];
  verifyDropped: Array<{ claim: string; source_url: string; reason: string }>;
  extractRunId: string | null;
  verifyRunId: string | null;
  costMicroUsd: { search: number; extract: number; verify: number };
  ms: { search: number; fetch: number; rank: number; extract: number; verify: number };
  /** The models the calls actually used (null: no call made). */
  models: { extract: ModelChoice | null; verify: ModelChoice | null };
}

export interface LeanResult {
  outcome: "confirmed" | "unconfirmed";
  unconfirmedReason: string | null;
  identity: { resolved: boolean; description: string; ambiguity: string };
  identityQuestion: IdentityQuestion | null;
  /** The verified facts of both rounds (nothing when identity was not confirmed). */
  facts: PassFact[];
  gaps: string[];
  narrative: string;
  wikidata: Pick<WikidataDiscovery, "hits" | "seeds" | "errors">;
  /** The first round's OpenAI search results (kept so a retried step need not search again). */
  search: { pages: FoundPage[]; searchQueries: number; costMicroUsd: number; errors: string[]; reused: boolean };
  pages: Array<{ url: string; via: Via; quality: number }>;
  skipped: Partial<Record<SkipReason, number>>;
  wrongPerson: Array<{ url: string; reason: string }>;
  rounds: LeanRound[];
  followUp: { ran: boolean; reason: string; aims: EvidenceAim[]; dimensions: MarketabilityDimension[] };
  sources: string[];
  byTopic: ReturnType<typeof factsByTopic>;
  /** Verified facts per M.I.A. dimension (v2/dimensions.ts; a fact counts for every dimension its topic feeds). */
  byDimension: Record<MarketabilityDimension, number>;
  withheld: number;
  models: { extract: ModelChoice | null; verify: ModelChoice | null };
  costMicroUsd: { search: number; extract: number; verify: number; total: number };
  ms: { wikidata: number; search: number; fetch: number; rank: number; extract: number; verify: number; total: number };
}

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const keyOf = (u: string) => { try { const x = new URL(u); x.hash = ""; x.search = ""; return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`.toLowerCase(); } catch { return u.toLowerCase(); } };
const pathOf = (u: string) => { try { return new URL(u).pathname.replace(/\/$/, ""); } catch { return ""; } };
/** Wiki housekeeping links (talk, log-in, edit, special pages) are not the athlete's pages, though their URL names them. */
const WIKI_META = /[?&](title=(Special|Talk)|action=)|\/wiki\/(Talk|Special|User|User_talk|File|Help|Wikipedia|Template|Category|Portal):/i;

/** One web-search query may take at most this long; past it the query counts as failed (the bake-off saw one hang). */
export const SEARCH_QUERY_TIMEOUT_MS = 90_000;
export function withQueryTimeout(inner: DiscoverQuery, ms: number = SEARCH_QUERY_TIMEOUT_MS): DiscoverQuery {
  return (q) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`search timed out after ${Math.round(ms / 1000)}s`)), ms);
    (t as any).unref?.();
    inner(q).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function runLeanResearch(input: LeanInput, rawDeps: LeanDeps): Promise<LeanResult> {
  const deps: LeanDeps = { ...rawDeps, discoverQuery: rawDeps.discoverQuery ? withQueryTimeout(rawDeps.discoverQuery) : null };
  const t0 = Date.now();
  const moment = input.moment ?? "signup";
  const strict = moment === "signup";
  const name = input.athlete.name;
  const identityAthlete = { name, sport: input.athlete.sport, team: input.team, handles: input.handles };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cleaner = deps.cleaner ?? "defuddle";
  const plan = leanPlanQueries({ name, sport: input.athlete.sport, team: input.team, handles: input.handles, today: input.today, moment, known: input.known, aims: input.aims });

  const pages: LeanPage[] = [];
  const seen = new Set<string>();
  const skipped: Partial<Record<SkipReason, number>> = {};
  const officialHosts = new Set<string>();
  let msFetch = 0;
  const fetchSome = async (items: Array<{ url: string; via: Via; note: string; quality?: number }>): Promise<LeanPage[]> => {
    const fresh = items.filter((i) => /^https?:\/\//.test(i.url) && !seen.has(keyOf(i.url)));
    for (const i of fresh) seen.add(keyOf(i.url));
    if (!fresh.length) return [];
    const tF = Date.now();
    const out = await fetchAndClean(fresh.map((i) => i.url), fetchImpl, { cleaner, concurrency: V2.fetchConcurrency });
    msFetch += Date.now() - tF;
    const got: LeanPage[] = [];
    out.forEach((o, n) => {
      if (o.skipped) { skipped[o.skipped] = (skipped[o.skipped] ?? 0) + 1; return; }
      if (!o.page) return;
      seen.add(keyOf(o.page.url));
      const quality = Math.max(qualityOf(o.page.url), fresh[n].quality ?? 1, officialHosts.has(hostOf(o.page.url)) ? 3 : 1);
      got.push({ ...o.page, quality, via: fresh[n].via, note: fresh[n].note });
    });
    pages.push(...got);
    if (got.length) report(deps, { stage: "reading", count: pages.length });
    return got;
  };
  report(deps, { stage: "finding" });
  const anchored = (ps: LeanPage[]) => ps.map((p) => ({ ...p, links: (p.links ?? []).filter((l) => !WIKI_META.test(l.url)), anchored: namesAthlete(p.text, name) && pageIdentity(p, identityAthlete, { strict }).verdict === "anchored" }));

  // The paid search starts now (it is independent of the free path) but its pages are read after the free ones.
  const tS = Date.now();
  let msSearch = 0;
  const searchP = deps.priorSearch
    ? Promise.resolve({ pages: deps.priorSearch.pages, searchQueries: deps.priorSearch.searchQueries, costMicroUsd: 0, errors: [] as string[], reused: true })
    : deps.discoverQuery && !deps.dryRun
      ? discover(plan, deps.discoverQuery, "openai_search").then((f) => ({ pages: f.pages, searchQueries: f.searchQueries, costMicroUsd: f.costMicroUsd, errors: f.errors, reused: false }))
      : Promise.resolve({ pages: [] as FoundPage[], searchQueries: 0, costMicroUsd: 0, errors: [] as string[], reused: false });
  void searchP.then(() => { msSearch = Date.now() - tS; }, () => undefined);

  // FREE: Wikidata seeds → roster links on team sites → the athlete's link on a roster or team page.
  const tW = Date.now();
  const wd = await wikidataSeeds({ name, sport: input.athlete.sport, team: input.team }, deps.wikidataGet ?? wdGet(fetchImpl), { maxIdentifiers: LEAN.maxIdentifiers });
  const msWikidata = Date.now() - tW;
  for (const s of wd.seeds) if (s.kind === "official_site" || s.kind === "team_site") officialHosts.add(hostOf(s.url));
  const seedPages = await fetchSome(wd.seeds.map((s) => ({ url: s.url, via: "wikidata" as const, note: `${s.kind}: ${s.note}`, quality: s.kind === "official_site" || s.kind === "team_site" ? 3 : undefined })));
  const teamPages = seedPages.filter((p) => officialHosts.has(hostOf(p.url)));
  // A site's home page is used for rosters only when Wikidata gave no more specific page (one sport) on that site.
  const rosterSources = teamPages.filter((p) => pathOf(p.url) || !teamPages.some((q) => q !== p && hostOf(q.url) === hostOf(p.url) && pathOf(q.url)));
  const rosterUrls = [...new Set(rosterSources.flatMap((p) => pickRosterLinks(p, input.athlete.sport, LEAN.maxRosterLinks)))];
  const rosterPages = await fetchSome(rosterUrls.map((url) => ({ url, via: "followed" as const, note: "roster link on a team site" })));
  const athleteUrls = [...new Set([...rosterPages, ...teamPages].flatMap((p) => pickAthleteLinks(p, name)))].slice(0, LEAN.maxAthleteLinks);
  await fetchSome(athleteUrls.map((url) => ({ url, via: "followed" as const, note: "athlete link on a roster or team page" })));

  // PAID: the OpenAI search results, then a few same-site links from her own pages (free and searched alike).
  let search: Awaited<typeof searchP>;
  try { search = await searchP; } catch (err) {
    if (err instanceof DiscoverCapRefusal && deps.onSearchSpend) {
      await deps.onSearchSpend({ round: 1, complete: false, queries: plan.map((q) => q.q), pages: [], searchQueries: err.spent.searchQueries, costMicroUsd: err.spent.costMicroUsd });
    }
    throw err;
  }
  if (!search.reused && (search.searchQueries || search.costMicroUsd) && deps.onSearchSpend) {
    await deps.onSearchSpend({ round: 1, complete: true, queries: plan.map((q) => q.q), pages: search.pages, searchQueries: search.searchQueries, costMicroUsd: search.costMicroUsd });
  }
  await fetchSome(search.pages.slice(0, LEAN.maxSearchFetch).map((p) => ({ url: p.url, via: "search" as const, note: `${p.aim}: ${p.title}`.slice(0, 160), quality: p.quality })));
  const follow = pickFollowLinks(anchored(pages), name, [...seen]);
  await fetchSome(follow.map((url) => ({ url, via: "followed" as const, note: "same-site link from the athlete's own page" })));

  // Round 1: rank, extract, identity, verify.
  const tR = Date.now();
  const ranked = rankPassages(pages, identityAthlete, { strict });
  const msRank1 = Date.now() - tR;
  const round1 = await extractRound({ input, deps, moment, passages: deps.dryRun ? [] : ranked.passages, queries: plan, search: { costMicroUsd: search.costMicroUsd, ms: msSearch }, msFetch, msRank: msRank1 });
  if (deps.dryRun) round1.round.passages = ranked.passages;
  const wrongPerson = [...ranked.wrongPerson];

  let unconfirmedReason: string | null = null;
  if (deps.dryRun) unconfirmedReason = "dry run: no model call was made";
  else if (!ranked.passages.length) unconfirmedReason = ranked.wrongPerson.length
    ? "Every page naming this athlete looked like someone else with the same name."
    : "No page we could read named this athlete together with their sport or team.";
  else if (!round1.extract?.result.identity.resolved) unconfirmedReason = round1.extract?.result.identity.ambiguity || "The sources did not show clearly which person this is.";

  const rounds: LeanRound[] = [round1.round];
  let followUp: LeanResult["followUp"] = { ran: false, reason: unconfirmedReason ? "identity not confirmed" : "every dimension has facts", aims: [], dimensions: [] };
  if (!unconfirmedReason) {
    // ONE follow-up round for the M.I.A. dimensions the first round's verified facts left without a single fact (one
    // targeted query per evidence area they need), while the run is under its follow-up cap.
    const gap = emptyDimensions(factsByDimension(round1.round.verified), input.aims ?? null);
    const empty = gap.aims;
    const spent = (deps.spentBeforeMicroUsd ?? 0) + sumCost(round1.round);
    const cap = deps.followUpMaxMicroUsd ?? LEAN.followUpMaxMicroUsd();
    if (!empty.length) followUp = { ran: false, reason: "every dimension has facts", aims: [], dimensions: [] };
    else if (!deps.discoverQuery) followUp = { ran: false, reason: "no search configured", aims: empty, dimensions: gap.dimensions };
    else if (spent >= cap) followUp = { ran: false, reason: `the run has spent $${(spent / 1e6).toFixed(2)} of the $${(cap / 1e6).toFixed(2)} follow-up cap`, aims: empty, dimensions: gap.dimensions };
    else {
      const queries = leanFollowUpQueries({ name, sport: input.athlete.sport, team: input.team, handles: input.handles, today: input.today, moment }, empty);
      const tS2 = Date.now();
      let found: Pick<Awaited<ReturnType<typeof discover>>, "pages" | "searchQueries" | "costMicroUsd">;
      const reusedFollowUp = !!deps.priorFollowUpSearch;
      if (deps.priorFollowUpSearch) found = { pages: deps.priorFollowUpSearch.pages, searchQueries: deps.priorFollowUpSearch.searchQueries, costMicroUsd: 0 };
      else {
        try { found = await discover(queries, deps.discoverQuery, "openai_search"); } catch (err) {
          if (err instanceof DiscoverCapRefusal && deps.onSearchSpend) {
            await deps.onSearchSpend({ round: 2, complete: false, queries: queries.map((q) => q.q), pages: [], searchQueries: err.spent.searchQueries, costMicroUsd: err.spent.costMicroUsd });
          }
          throw err;
        }
      }
      if (!reusedFollowUp && (found.searchQueries || found.costMicroUsd) && deps.onSearchSpend) {
        await deps.onSearchSpend({ round: 2, complete: true, queries: queries.map((q) => q.q), pages: found.pages, searchQueries: found.searchQueries, costMicroUsd: found.costMicroUsd });
      }
      const msSearch2 = Date.now() - tS2;
      const before = msFetch;
      const fresh = await fetchSome(found.pages.slice(0, LEAN.maxSearchFetch).map((p) => ({ url: p.url, via: "search_followup" as const, note: `${p.aim}: ${p.title}`.slice(0, 160), quality: p.quality })));
      const tR2 = Date.now();
      // Identity is judged per new page as in round 1; a page that says nothing either way is read only beside an
      // anchored new page (rankPassages), never on the strength of round 1.
      const ranked2 = rankPassages(fresh, identityAthlete, { strict });
      wrongPerson.push(...ranked2.wrongPerson);
      const r2 = await extractRound({ input, deps, moment, passages: ranked2.passages, queries, search: { costMicroUsd: found.costMicroUsd, ms: msSearch2 }, msFetch: msFetch - before, msRank: Date.now() - tR2, suffix: "2" });
      // A follow-up round that could not itself confirm identity adds nothing (its facts are dropped, never guessed).
      if (!r2.round.identityResolved) r2.round.verified = [];
      rounds.push(r2.round);
      followUp = { ran: true, reason: `no verified facts for ${gap.dimensions.join(", ")} after the first round`, aims: empty, dimensions: gap.dimensions };
    }
  }

  const all = unconfirmedReason ? [] : rounds.flatMap((r) => r.verified);
  const withheld = unconfirmedReason ? round1.round.extracted : 0;
  const cost = rounds.reduce((s, r) => ({ search: s.search + r.costMicroUsd.search, extract: s.extract + r.costMicroUsd.extract, verify: s.verify + r.costMicroUsd.verify }), { search: 0, extract: 0, verify: 0 });
  const ms = rounds.reduce((s, r) => ({ search: s.search + r.ms.search, fetch: s.fetch + r.ms.fetch, rank: s.rank + r.ms.rank, extract: s.extract + r.ms.extract, verify: s.verify + r.ms.verify }), { search: 0, fetch: 0, rank: 0, extract: 0, verify: 0 });
  const ex = round1.extract?.result;
  return {
    outcome: unconfirmedReason ? "unconfirmed" : "confirmed", unconfirmedReason,
    identity: ex?.identity ?? { resolved: false, description: "", ambiguity: unconfirmedReason ?? "" },
    identityQuestion: unconfirmedReason ? questionFrom(ex?.candidates ?? [], ranked.passages) : null,
    facts: all, gaps: ex?.gaps ?? [], narrative: ex?.narrative ?? "",
    wikidata: { hits: wd.hits, seeds: wd.seeds, errors: wd.errors },
    search: { pages: search.pages, searchQueries: search.searchQueries, costMicroUsd: search.costMicroUsd, errors: search.errors, reused: search.reused },
    pages: pages.map((p) => ({ url: p.url, via: p.via, quality: p.quality })), skipped, wrongPerson, rounds, followUp,
    sources: [...new Set(all.map((f) => f.source_url))], byTopic: factsByTopic(all), byDimension: factsByDimension(all), withheld,
    models: { extract: rounds[0].models.extract ?? deps.extractModel ?? null, verify: rounds[0].models.verify ?? deps.verifyModel ?? null },
    costMicroUsd: { ...cost, total: cost.search + cost.extract + cost.verify },
    ms: { wikidata: msWikidata, ...ms, total: Date.now() - t0 },
  };
}

const sumCost = (r: LeanRound) => r.costMicroUsd.search + r.costMicroUsd.extract + r.costMicroUsd.verify;

/** One extract → identity → verify round over ranked passages. Identity unresolved ⇒ no verify call (nothing is kept). */
async function extractRound(o: {
  input: LeanInput; deps: LeanDeps; moment: ResearchMoment; passages: Passage[]; queries: PlannedQuery[];
  search: { costMicroUsd: number; ms: number }; msFetch: number; msRank: number; suffix?: "2";
}) {
  const round: LeanRound = {
    queries: o.queries, passages: o.passages, extracted: 0, checked: 0, identityResolved: false, verified: [], verifyDropped: [],
    extractRunId: null, verifyRunId: null, costMicroUsd: { search: o.search.costMicroUsd, extract: 0, verify: 0 },
    ms: { search: o.search.ms, fetch: o.msFetch, rank: o.msRank, extract: 0, verify: 0 }, models: { extract: null, verify: null },
  };
  if (!o.passages.length) return { round, extract: null };
  const call: LeanModelCall = o.suffix ? (req) => o.deps.call({ ...req, step: req.step === "extract" ? "extract2" : "verify2" }) : o.deps.call;
  report(o.deps, { stage: "pulling", count: o.passages.length });
  const ex = await extractAll({ athlete: o.input.athlete, known: o.input.known, passages: o.passages, today: o.input.today, moment: o.moment, model: o.deps.extractModel ?? null, call });
  round.extractRunId = ex.runId;
  round.models.extract = ex.model;
  round.extracted = ex.raw >= 0 ? ex.raw : ex.result.facts.length;
  round.checked = ex.result.facts.length;
  round.costMicroUsd.extract = ex.cost.microUsd;
  round.ms.extract = ex.ms;
  round.identityResolved = ex.result.identity.resolved;
  if (!ex.result.identity.resolved) return { round, extract: ex };
  report(o.deps, { stage: "checking", count: ex.result.facts.length });
  const v = await verifyFacts({ facts: ex.result.facts, passages: o.passages, model: o.deps.verifyModel ?? null, call });
  round.verified = v.kept;
  round.verifyDropped = v.dropped;
  round.verifyRunId = v.runId;
  round.models.verify = v.model;
  round.costMicroUsd.verify = v.cost.microUsd;
  round.ms.verify = v.ms;
  return { round, extract: ex };
}
