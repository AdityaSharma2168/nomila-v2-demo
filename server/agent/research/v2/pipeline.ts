/**
 * agent/research/v2/pipeline.ts — the narrow research pipeline end to end, with every outside call injectable:
 *
 *   plan (code) → discover (search provider) → fetch + clean (our fetcher, Defuddle) → follow a few same-site links
 *   from the athlete's own pages (no search) → rank + filter (code: their own pages whole, other pages as BM25
 *   passages) → extract (one model call over what was kept) → the same PassResult a research pass returns.
 *
 * It returns the result AND the measurements the shadow compares against today's passes: facts kept, distinct
 * sources, wrong-person rejections, pages skipped and why, characters sent to the model, cost and wall time per step.
 *
 * Moments (plan.ts): at SIGN-UP identity comes first — strict namesake rejection (the sport, team or handle must appear
 * near the name), and when the sources do not confirm which person this is, the outcome is an honest "couldn't
 * confirm" with NO facts kept. When the sources show two or more different people who fit, the outcome also carries
 * a "which one are you?" question (identityQuestion) built from what tells them apart, so sign-up can ask the athlete.
 * At REFRESH the record anchors identity and the plan targets what the record lacks.
 */
import type { MemoryFact } from "../../../../shared/agent";
import type { AthleteIdentity, JobContext, PassResult } from "../research";
import { V2, cleanerOf, type CleanerId, type DiscoverProviderId } from "./config";
import { planQueries, type PlannedQuery, type ResearchMoment } from "./plan";
import { discover, type DiscoverQuery } from "./discover";
import { fetchAndClean, type SkipReason } from "./fetchClean";
import { namesAthlete, pageIdentity, pickFollowLinks, rankPassages, type Passage } from "./rank";
import { extractFacts, type IdentityCandidate } from "./extract";

export interface PipelineInput {
  athlete: AthleteIdentity;
  team?: string | null;
  handles?: string[];
  known: MemoryFact[];
  today: string;
  /** Default signup. */
  moment?: ResearchMoment;
}

/**
 * confirmed — the sources show which person this is; facts kept.
 * unconfirmed — sign-up only: no page tied the name to the sport/team, or the sources leave it unclear which person
 *   this is; nothing is kept and `unconfirmedReason` says why in plain words.
 */
export type IdentityOutcome = "confirmed" | "unconfirmed";

export interface PipelineDeps {
  provider: DiscoverProviderId;
  discoverQuery: DiscoverQuery;
  fetchImpl?: typeof fetch;
  /** The page cleaner; defaults to RESEARCH_V2_CLEANER (Defuddle unless set to readability). */
  cleaner?: CleanerId;
  /** Defaults to the real extract step (one model call). */
  extract?: (passages: Passage[]) => Promise<PassResult & { candidates?: IdentityCandidate[] }>;
}

export interface PipelineMetrics {
  queries: number;
  pagesFound: number;
  pagesFetched: number;
  /** Same-site pages followed from the athlete's own pages (fetched; included in pagesFetched). */
  pagesFollowed: number;
  /** The athlete's own pages sent whole rather than as passages. */
  wholePages: number;
  pagesSkipped: Partial<Record<SkipReason, number>>;
  passages: number;
  passageChars: number;
  wrongPersonRejections: number;
  unrelatedPages: number;
  /** Pages that showed this is the athlete (sport, team or handle in structured data, URL, title or near the name). */
  anchoredPages: number;
  /** Pages that named the athlete but said nothing either way (read only beside an anchored page, labelled). */
  neutralPages: number;
  /** Search queries the provider ran, and their per-search fees (inside costMicroUsd.discover), at list price. */
  searchQueries: number;
  searchFeeMicroUsd: number;
  factsKept: number;
  factsDropped: number;
  distinctSources: number;
  officialSources: number;
  identityResolved: boolean;
  moment: ResearchMoment;
  outcome: IdentityOutcome;
  unconfirmedReason: string | null;
  /** Facts the extract step returned but sign-up withheld because identity was not confirmed. */
  factsWithheld: number;
  costMicroUsd: { discover: number; extract: number; total: number };
  ms: { discover: number; fetch: number; rank: number; extract: number; total: number };
  discoverErrors: string[];
}

/** Sign-up, two or more people fit: what to ask the athlete. Nothing about any candidate is kept until they answer. */
export interface IdentityQuestion {
  kind: "which_one";
  prompt: string;
  candidates: Array<IdentityCandidate & { urls: string[] }>;
}

export interface PipelineResult {
  plan: PlannedQuery[];
  identityQuestion: IdentityQuestion | null;
  result: PassResult | null;
  passages: Passage[];
  wrongPerson: Array<{ url: string; reason: string }>;
  metrics: PipelineMetrics;
}

export async function runNarrowResearch(ctx: JobContext, input: PipelineInput, deps: PipelineDeps, parentRef: string): Promise<PipelineResult> {
  const t0 = Date.now();
  const moment = input.moment ?? "signup";
  const plan = planQueries({ name: input.athlete.name, sport: input.athlete.sport, team: input.team, handles: input.handles, today: input.today, moment, known: input.known });

  const tD = Date.now();
  const found = await discover(plan, deps.discoverQuery, deps.provider);
  const msDiscover = Date.now() - tD;

  const tF = Date.now();
  const chosen = found.pages.slice(0, V2.maxFetch);
  const fetched = await fetchAndClean(chosen.map((p) => p.url), deps.fetchImpl, { cleaner: deps.cleaner ?? cleanerOf(), concurrency: V2.fetchConcurrency });
  const skipped: Partial<Record<SkipReason, number>> = {};
  for (const f of fetched) if (f.skipped) skipped[f.skipped] = (skipped[f.skipped] ?? 0) + 1;
  const qualityByUrl = new Map(chosen.map((p) => [p.url, p.quality]));
  const pages = fetched.filter((f) => f.page).map((f) => ({ ...f.page!, quality: qualityByUrl.get(f.url) ?? 1 }));
  // Follow a few same-site links from the athlete's own pages (a roster → their player page, a profile → their stats
  // or bio) with our fetcher instead of paying for more searches. robots.txt and the fetch caps apply as for any page.
  const identityAthlete = { name: input.athlete.name, sport: input.athlete.sport, team: input.team, handles: input.handles };
  const strict = moment === "signup";
  const follow = pickFollowLinks(
    pages.map((p) => ({ ...p, anchored: namesAthlete(p.text, identityAthlete.name) && pageIdentity(p, identityAthlete, { strict }).verdict === "anchored" })),
    identityAthlete.name, [...chosen.map((p) => p.url), ...pages.map((p) => p.url)],
  );
  const followed = follow.length ? await fetchAndClean(follow, deps.fetchImpl, { cleaner: deps.cleaner ?? cleanerOf(), concurrency: V2.fetchConcurrency }) : [];
  for (const f of followed) if (f.skipped) skipped[f.skipped] = (skipped[f.skipped] ?? 0) + 1;
  const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  const qualityOfHost = (u: string) => Math.max(1, ...pages.filter((p) => hostOf(p.url) === hostOf(u)).map((p) => p.quality));
  const followedPages = followed.filter((f) => f.page).map((f) => ({ ...f.page!, quality: qualityOfHost(f.url) }));
  pages.push(...followedPages);
  const msFetch = Date.now() - tF;

  const tR = Date.now();
  const ranked = rankPassages(pages, identityAthlete, { strict });
  const msRank = Date.now() - tR;

  const tE = Date.now();
  const extracted = ranked.passages.length
    ? await (deps.extract ?? ((passages) => extractFacts(ctx, { athlete: input.athlete, known: input.known, passages, moment, parentRef: `${parentRef}:extract` })))(ranked.passages)
    : null;
  const msExtract = Date.now() - tE;

  // Honest "couldn't confirm" (sign-up): keep nothing rather than risk another person's facts.
  let unconfirmedReason: string | null = null;
  if (moment === "signup") {
    if (!ranked.passages.length) unconfirmedReason = ranked.wrongPerson.length
      ? "Every page naming this athlete looked like someone else with the same name."
      : "No page we could read named this athlete together with their sport or team.";
    else if (extracted && !extracted.identity.resolved) unconfirmedReason = extracted.identity.ambiguity || "The sources did not show clearly which person this is.";
  }
  const factsWithheld = unconfirmedReason ? extracted?.facts.length ?? 0 : 0;
  const identityQuestion = unconfirmedReason ? questionFrom(extracted?.candidates ?? [], ranked.passages) : null;
  const result = extracted && unconfirmedReason ? { ...extracted, facts: [] } : extracted;

  const cited = new Set((result?.facts ?? []).map((f) => f.source_url));
  const extractCost = result?.costMicroUsd ?? 0;
  return {
    plan, identityQuestion, result, passages: ranked.passages, wrongPerson: ranked.wrongPerson,
    metrics: {
      queries: plan.length, pagesFound: found.pages.length, pagesFetched: pages.length, pagesFollowed: followedPages.length, wholePages: ranked.wholePages, pagesSkipped: skipped,
      passages: ranked.passages.length, passageChars: ranked.chars, wrongPersonRejections: ranked.wrongPerson.length, unrelatedPages: ranked.unrelated,
      anchoredPages: ranked.anchoredPages, neutralPages: ranked.neutralPages, searchQueries: found.searchQueries, searchFeeMicroUsd: found.searchFeeMicroUsd,
      factsKept: result?.facts.length ?? 0, factsDropped: result?.dropped.length ?? 0, distinctSources: cited.size,
      officialSources: (result?.facts ?? []).filter((f) => f.source_type === "official").length,
      identityResolved: result?.identity.resolved === true,
      moment, outcome: unconfirmedReason ? "unconfirmed" : "confirmed", unconfirmedReason, factsWithheld,
      costMicroUsd: { discover: found.costMicroUsd, extract: extractCost, total: found.costMicroUsd + extractCost },
      ms: { discover: msDiscover, fetch: msFetch, rank: msRank, extract: msExtract, total: Date.now() - t0 },
      discoverErrors: found.errors,
    },
  };
}

/** Pure: two or more distinct candidates → the "which one are you?" question (their source ids resolved to URLs). */
export function questionFrom(candidates: IdentityCandidate[], passages: Passage[]): IdentityQuestion | null {
  if (candidates.length < 2) return null;
  const urlOf = new Map(passages.map((p) => [p.id, p.url]));
  return {
    kind: "which_one",
    prompt: "We found more than one athlete with your name in your sport. Which one are you?",
    candidates: candidates.map((c) => ({ ...c, urls: [...new Set(c.sources.map((id) => urlOf.get(id)).filter((u): u is string => !!u))] })),
  };
}
