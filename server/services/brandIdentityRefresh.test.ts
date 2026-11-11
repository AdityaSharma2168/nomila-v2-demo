/**
 * brandIdentityRefresh.test.ts — "confirm the brand, then get its pictures", on PGlite with the real runner and the
 * real researchBrand. Every provider is mocked: web search + extraction (agent/research/llm, lib/kimi), research imagery
 * (lib/brandImage) and own-site imagery (lib/ownSiteImagery). Nothing reaches a network.
 *
 * Pinned:
 *   • gate off ⇒ nothing starts; evidence on a brand with nothing outstanding ⇒ nothing starts
 *   • a burst of requests for one brand is ONE run, which waits out the debounce and researches once
 *   • confirmed ⇒ own-site imagery stored (source own_site); unconfirmed ⇒ no imagery, own-site never fetched
 *   • research is capped per brand per window; her newer confirmation bypasses the cap; imagery she vouched for
 *     survives an unconfirmed re-check
 *   • the domain fill rule: an empty row takes the evidence domain unless another row holds it
 *   • a name-search lookup proposes a candidate only when the answer is grounded on that domain
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
// The OpenAI web search (agent/research/llm callStructured) is mocked: no test reaches a provider.
const webSearch = jest.fn();
jest.mock("../agent/research/llm", () => ({ ...jest.requireActual("../agent/research/llm"), callStructured: (...a: any[]) => webSearch(...a) }));
const kimiInstant = jest.fn();
jest.mock("../lib/kimi", () => ({ kimiInstant: (...a: any[]) => kimiInstant(...a) }));
jest.mock("../lib/brandImage", () => ({
  fetchBrandImages: jest.fn(async () => ({ cover: null, images: [] })),
  fetchBrandImagesViaSearch: jest.fn(async () => ({ cover: null, images: [] })),
  candidateDomains: (_n: string, d: string) => [d].filter(Boolean),
}));
const fetchOwnSiteImagery = jest.fn();
jest.mock("../lib/ownSiteImagery", () => ({ fetchOwnSiteImagery: (...a: any[]) => fetchOwnSiteImagery(...a) }));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { inboxBrands, workflowRuns, workflowSteps } from "../../shared/schema";
import { configureRunner, resetRunnerConfig, tick } from "../workflow/runner";
import {
  BRAND_IDENTITY_DEBOUNCE_MS, BRAND_IDENTITY_REFRESH_PROCESS, fillBrandDomain, noteBrandDomainEvidence,
  lookupBrandCandidate, requestBrandIdentityRefresh, runBrandIdentityRefresh,
} from "./brandIdentityRefresh";
import { searchOfficialSite } from "../skills/researchBrand";
import "../workflow/definitions/index";

const grounded = (hosts: string[], text = "research text") => ({
  json: { answer: text },
  text: JSON.stringify({ answer: text }),
  // What OpenAI web search returns: the real URL of each page the search saw (a title is only the page's title).
  sources: hosts.map((h) => ({ url: `https://${h}/about`, title: `About ${h}` })),
  queries: [], status: "completed", responseId: null, durationMs: 1,
  usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, webSearchCalls: 1 },
  cost: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, webSearchCalls: 1, microUsd: 10_150 },
});
const extraction = { industry: "Nutrition", description: "A gummy brand.", brand_tier: "emerging", audience_summary: "Athletes", sport_categories: [], known_athlete_partnerships: [] };
const ownSite = (domain: string, cover: string | null = `https://${domain}/og.jpg`) =>
  ({ domain, cover, logoUrl: `https://cdn.yoku.app/${domain}/type/logo/w/256/format/png/fallback/lettermark`, logoSource: "yoku", coverMiss: cover ? null : "no og:image" });

let athleteId: string;
let now = new Date("2026-10-07T10:00:00.000Z");
const later = (ms: number) => { now = new Date(now.getTime() + ms); };
let seq = 0;
async function mkBrand(over: Record<string, unknown> = {}): Promise<number> {
  seq += 1;
  const [r] = await db.insert(inboxBrands).values({ name: `Brand ${seq}`, normalized_name: `brand ${seq}`, ...over } as any).returning({ id: inboxBrands.id });
  return r.id;
}
const row = async (id: number) => (await db.select().from(inboxBrands).where(eq(inboxBrands.id, id)))[0];
const runs = () => db.select().from(workflowRuns).where(eq(workflowRuns.process, BRAND_IDENTITY_REFRESH_PROCESS));
const searchCalls = () => webSearch.mock.calls.length;

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Brand Pipeline Athlete"); });
afterAll(closeTestDb);
beforeEach(async () => {
  resetRunnerConfig();
  now = new Date("2026-10-07T10:00:00.000Z");
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } }, () => now);
  jest.clearAllMocks();
  process.env.BRAND_IDENTITY_GATE = "true";
  kimiInstant.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(extraction) } }] });
  fetchOwnSiteImagery.mockImplementation(async (d: string) => ownSite(d));
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});
afterEach(() => { delete process.env.BRAND_IDENTITY_GATE; });

test("gate off: a request starts nothing", async () => {
  delete process.env.BRAND_IDENTITY_GATE;
  const id = await mkBrand({ domain: "gateoff.example" });
  expect(await requestBrandIdentityRefresh(athleteId, id, "test")).toBeNull();
  expect(await noteBrandDomainEvidence(athleteId, id, "test")).toBeNull();
  expect(await runs()).toHaveLength(0);
});

test("evidence: only a brand with identity work outstanding asks, and a burst is one run", async () => {
  const fresh = await mkBrand({ domain: "fresh.example" });
  const noDomain = await mkBrand({ domain: null });
  const done = await mkBrand({ domain: "done.example", enrichment: { identity: { status: "confirmed", domain: "done.example", own_sources: ["done.example"], basis: "own_domain_source", checked_at: now.toISOString() }, own_site: { source: "own_site", domain: "done.example", cover: null, logo_url: null, basis: "identity_confirmed", fetched_at: now.toISOString() } } });
  const unconfirmed = await mkBrand({ domain: "unc.example", enrichment: { identity: { status: "unconfirmed", domain: "unc.example", own_sources: [], basis: "no_own_domain_source", checked_at: now.toISOString() } } });
  const agency = await mkBrand({ domain: "agency.example", is_agency: true });

  const a = await noteBrandDomainEvidence(athleteId, fresh, "email");
  const b = await noteBrandDomainEvidence(athleteId, fresh, "email again");
  expect(a?.created).toBe(true);
  expect(b).toMatchObject({ runId: a!.runId, created: false });
  for (const id of [done, unconfirmed, agency]) expect(await noteBrandDomainEvidence(athleteId, id, "email")).toBeNull();
  // A domain-less brand asks for the name search at ingest (its logo), and not again inside the cap window.
  expect((await noteBrandDomainEvidence(athleteId, noDomain, "email"))?.created).toBe(true);
  expect((await runs()).find((r: any) => r.input?.brandId === noDomain)?.input).toMatchObject({ lookup: true });
  // The ingest check reads the real clock (brandNeedsCandidateLookup(row, new Date(), ...)), not the test's fixed `now`:
  // stamp the lookup with today so the 30-day cap window holds whatever day CI runs (it expired on 6 Nov 2026).
  const searched = await mkBrand({ domain: null, enrichment: { candidate_lookup: { at: new Date().toISOString(), found: false } } });
  expect(await noteBrandDomainEvidence(athleteId, searched, "email")).toBeNull();
  expect(await runs()).toHaveLength(2);
});

test("the run waits out the debounce, researches once, and a confirmed brand is pictured from its own site", async () => {
  webSearch.mockResolvedValue(grounded(["wikipedia.org", "gummies.example"]));
  const id = await mkBrand({ domain: "gummies.example", logo_url: "https://www.google.com/s2/favicons?domain=gummies.example&sz=128" });
  await requestBrandIdentityRefresh(athleteId, id, "email");
  await requestBrandIdentityRefresh(athleteId, id, "another email");
  await tick(); await tick();
  expect(webSearch).not.toHaveBeenCalled();

  later(BRAND_IDENTITY_DEBOUNCE_MS + 1_000);
  await tick(); await tick();
  expect(searchCalls()).toBe(4);                       // one research (four web searches), not two
  expect(fetchOwnSiteImagery).toHaveBeenCalledTimes(1);
  expect(fetchOwnSiteImagery).toHaveBeenCalledWith("gummies.example");
  const r = await row(id);
  expect(r.image_url).toBe("https://gummies.example/og.jpg");
  expect(r.images).toEqual(["https://gummies.example/og.jpg"]);
  expect(r.logo_url).toContain("cdn.yoku.app/gummies.example");   // the favicon floor upgraded
  expect((r.enrichment as any).identity).toMatchObject({ status: "confirmed", domain: "gummies.example" });
  expect((r.enrichment as any).own_site).toMatchObject({ source: "own_site", domain: "gummies.example", basis: "identity_confirmed" });
  const [run] = await runs();
  expect(run.status).toBe("done");
});

test("unconfirmed: no imagery, and the own site is never fetched", async () => {
  webSearch.mockResolvedValue(grounded(["lookalike.example"]));
  const id = await mkBrand({ domain: "realbrand.example" });
  const out = await runBrandIdentityRefresh({ brandId: id, reason: "test" }, { now });
  expect(out).toMatchObject({ research: "ran", identity: "unconfirmed", imagery: "not_trusted" });
  expect(fetchOwnSiteImagery).not.toHaveBeenCalled();
  const r = await row(id);
  expect(r.image_url).toBeNull();
  expect((r.enrichment as any).own_site).toBeUndefined();
});

test("research is capped per brand; her newer confirmation bypasses the cap; her imagery survives an unconfirmed check", async () => {
  webSearch.mockResolvedValue(grounded(["elsewhere.example"]));   // research never confirms this one
  const id = await mkBrand({ domain: "capped.example" });
  expect(await runBrandIdentityRefresh({ brandId: id, reason: "first" }, { now })).toMatchObject({ research: "ran", imagery: "not_trusted" });
  later(5 * 24 * 3600_000);
  expect(await runBrandIdentityRefresh({ brandId: id, reason: "again" }, { now })).toMatchObject({ research: "capped" });
  expect(searchCalls()).toBe(4);

  // She confirms it (the confirm API writes this record): the cap is bypassed once, imagery follows her word.
  later(60_000);
  const at = now.toISOString();
  await db.update(inboxBrands).set({ enrichment: { ...(await row(id)).enrichment as any, athlete_confirmed: { domain: "capped.example", assertion_id: "00000000-0000-0000-0000-000000000001", at } } }).where(eq(inboxBrands.id, id));
  later(60_000);
  expect(await runBrandIdentityRefresh({ brandId: id, reason: "confirmed" }, { now })).toMatchObject({ research: "ran", identity: "unconfirmed", imagery: "stored" });
  expect(searchCalls()).toBe(8);
  let r = await row(id);
  expect(r.image_url).toBe("https://capped.example/og.jpg");
  expect((r.enrichment as any).own_site).toMatchObject({ basis: "athlete_confirmed" });

  // A later unconfirmed re-check (e.g. the brand-refresh cron) keeps what she vouched for.
  const { researchBrand } = await import("../skills/researchBrand");
  later(40 * 24 * 3600_000);
  await researchBrand(id, r.name, "capped.example", { force: true });
  r = await row(id);
  expect(r.image_url).toBe("https://capped.example/og.jpg");
  expect((r.enrichment as any)).toMatchObject({ athlete_confirmed: { domain: "capped.example" }, own_site: { basis: "athlete_confirmed" }, identity: { status: "unconfirmed" } });
});

test("domain fill: an empty row takes the evidence domain, never one another row holds, never re-pointed", async () => {
  const empty = await mkBrand({ domain: null });
  const holder = await mkBrand({ domain: "taken.example" });
  const other = await mkBrand({ domain: null });
  expect(await fillBrandDomain(empty, "https://www.newdomain.example/path")).toBe("set");
  expect((await row(empty)).domain).toBe("newdomain.example");
  expect(await fillBrandDomain(other, "taken.example")).toBe("held");
  expect((await row(other)).domain).toBeNull();
  expect(await fillBrandDomain(holder, "different.example")).toBe("different");
  expect(await fillBrandDomain(other, "gmail.com")).toBe("invalid");

  // Through the job: the input domain is filled and researched.
  webSearch.mockResolvedValue(grounded(["fromjob.example"]));
  const viaJob = await mkBrand({ domain: null });
  expect(await runBrandIdentityRefresh({ brandId: viaJob, reason: "catch-up", domain: "fromjob.example" }, { now })).toMatchObject({ fill: "set", domain: "fromjob.example", identity: "confirmed", imagery: "stored" });
});

test("lookup: a candidate is proposed only when the answer is grounded on that domain, and is not repeated", async () => {
  const id = await mkBrand({ domain: null, name: "Candidate Co" });
  const searchSite = jest.fn(async () => ({ domain: "candidate.example" }));
  const logoFor = jest.fn(async (d: string) => ({ url: `https://cdn.yoku.app/${d}/type/logo/w/256/format/png/fallback/lettermark`, source: "yoku" as const, reason: "logo" }));
  const deps = { research: jest.fn(), ownSite: jest.fn(), searchSite, logoFor };
  expect(await runBrandIdentityRefresh({ brandId: id, reason: "lookup", lookup: true }, { now, deps })).toMatchObject({ outcome: "no_domain", lookup: "found" });
  expect((await row(id)).enrichment).toMatchObject({ candidate: { domain: "candidate.example", source: "name_search", logo_url: expect.stringContaining("candidate.example") }, candidate_lookup: { found: true } });
  expect(logoFor).toHaveBeenCalledWith("candidate.example", expect.anything());
  expect((await row(id)).domain).toBeNull();          // a candidate is never evidence by itself
  expect(await runBrandIdentityRefresh({ brandId: id, reason: "lookup", lookup: true }, { now, deps })).toMatchObject({ lookup: "recent" });
  expect(searchSite).toHaveBeenCalledTimes(1);
  expect(deps.research).not.toHaveBeenCalled();

  // The verified search's record: source, confidence and what the check saw; a backfill may force past the window.
  const verified = await mkBrand({ domain: null, name: "Verified Co" });
  const vSearch = jest.fn(async () => ({ domain: "verified.example", source: "web_search_verified" as const, confidence: "high" as const, evidence: "homepage: Verified Co" }));
  const vDeps = { ...deps, searchSite: vSearch };
  expect(await lookupBrandCandidate(verified, { now, deps: vDeps })).toBe("found");
  expect((await row(verified)).enrichment).toMatchObject({ candidate: { domain: "verified.example", source: "web_search_verified", confidence: "high", evidence: "homepage: Verified Co" } });
  expect(await lookupBrandCandidate(verified, { now, deps: vDeps })).toBe("recent");
  expect(await lookupBrandCandidate(verified, { now, deps: vDeps, force: true })).toBe("found");
  expect(vSearch).toHaveBeenCalledTimes(2);

  // searchOfficialSite: the named domain counts only when a page the search saw is hosted on it.
  webSearch.mockResolvedValueOnce(grounded(["wikipedia.org"], "candidate.example"));
  expect((await searchOfficialSite("Candidate Co")).domain).toBeNull();
  webSearch.mockResolvedValueOnce(grounded(["www.candidate.example"], "The official site is candidate.example."));
  expect((await searchOfficialSite("Candidate Co")).domain).toBe("candidate.example");
  webSearch.mockResolvedValueOnce(grounded(["instagram.com"], "instagram.com/candidate"));
  expect((await searchOfficialSite("Candidate Co")).domain).toBeNull();
});

test("one active run per (athlete, brand): two brands run side by side", async () => {
  const a = await mkBrand({ domain: "side-a.example" });
  const b = await mkBrand({ domain: "side-b.example" });
  const ra = await requestBrandIdentityRefresh(athleteId, a, "x");
  const rb = await requestBrandIdentityRefresh(athleteId, b, "x");
  expect(ra?.created && rb?.created).toBe(true);
  expect(ra!.runId).not.toBe(rb!.runId);
  expect(await db.select().from(workflowRuns).where(and(eq(workflowRuns.process, BRAND_IDENTITY_REFRESH_PROCESS), eq(workflowRuns.athlete_id, athleteId)))).toHaveLength(2);
});

test("a verified official-site candidate settles the brand without her tap: research runs and own-site imagery is stored", async () => {
  webSearch.mockResolvedValue(grounded(["settled.example"]));
  const id = await mkBrand({ name: "Settled Co", normalized_name: "settled co", enrichment: {
    candidate: { domain: "settled.example", name: "Settled Co", source: "web_search_verified", proposed_at: now.toISOString(), confidence: "high", evidence: "homepage: Settled Co" },
  } });
  const out = await runBrandIdentityRefresh({ brandId: id, reason: "test" }, { now });
  expect(out).toMatchObject({ domain: "settled.example", research: "ran" });
  const r = await row(id);
  expect(r.domain).toBe("settled.example");
  expect((r.enrichment as any).system_confirmed).toMatchObject({ domain: "settled.example", basis: "verified_official_site" });
  if ((r.enrichment as any).identity?.status !== "confirmed") expect((r.enrichment as any).own_site).toMatchObject({ basis: "system_confirmed", cover: "https://settled.example/og.jpg" });
  expect(fetchOwnSiteImagery).toHaveBeenCalledWith("settled.example");
});

test("a mail domain alone settles who the brand is but never vouches for its site's imagery", async () => {
  webSearch.mockResolvedValue(grounded(["elsewhere.example"]));
  const id = await mkBrand({ domain: "maildomain.example" });
  const out = await runBrandIdentityRefresh({ brandId: id, reason: "test" }, { now });
  expect(out.research).toBe("ran");
  expect((await row(id)).enrichment).toMatchObject({ system_confirmed: { basis: "sender_domain" } });
  if (out.identity !== "confirmed") expect(out.imagery).toBe("not_trusted");
});
