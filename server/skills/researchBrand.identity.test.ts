/**
 * researchBrand under BRAND_IDENTITY_GATE, against PGlite. Every provider is mocked (OpenAI web search,
 * extraction, image fetch) — no test reaches a paid provider.
 *
 *   confirmed   → the profile is stored as today, plus enrichment.identity; images only from the domain
 *   unconfirmed → only the identity record; a previous profile (and research imagery) is cleared
 *   no domain   → no search runs at all
 *   gate off    → today's behaviour, no identity record
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

// The OpenAI web search (agent/research/llm callStructured) is mocked: no test reaches a provider.
const webSearch = jest.fn();
jest.mock("../agent/research/llm", () => ({ ...jest.requireActual("../agent/research/llm"), callStructured: (...a: any[]) => webSearch(...a) }));
const kimiInstant = jest.fn();
jest.mock("../lib/kimi", () => ({ kimiInstant: (...a: any[]) => kimiInstant(...a) }));
const fetchBrandImages = jest.fn();
const fetchBrandImagesViaSearch = jest.fn();
jest.mock("../lib/brandImage", () => ({
  fetchBrandImages: (...a: any[]) => fetchBrandImages(...a),
  fetchBrandImagesViaSearch: (...a: any[]) => fetchBrandImagesViaSearch(...a),
  candidateDomains: (_n: string, d: string) => [d, "guessed-from-name.com"].filter(Boolean),
}));

import { eq } from "drizzle-orm";
import { brandFitNarratives, inboxBrands } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { researchBrand } from "./researchBrand";

const grounded = (hosts: string[], text = "research text") => ({
  json: { answer: text },
  text: JSON.stringify({ answer: text }),
  // What OpenAI web search returns: the real URL of each page the search saw (a title is only the page's title).
  sources: hosts.map((h) => ({ url: `https://${h}/about`, title: `About ${h}` })),
  queries: [], status: "completed", responseId: null, durationMs: 1,
  usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, webSearchCalls: 1 },
  cost: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, webSearchCalls: 1, microUsd: 10_150 },
});
const extraction = { industry: "Nutrition", description: "A gummy brand.", brand_tier: "emerging", audience_summary: "Athletes", sport_categories: ["soccer"], known_athlete_partnerships: ["Someone"] };

async function mkBrand(name: string, domain: string | null, extra: Record<string, unknown> = {}): Promise<number> {
  const [r] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase(), domain, ...extra } as any).returning({ id: inboxBrands.id });
  return r.id;
}
const row = async (id: number) => (await db.select().from(inboxBrands).where(eq(inboxBrands.id, id)))[0];

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });
beforeEach(() => {
  jest.clearAllMocks();
  process.env.BRAND_IDENTITY_GATE = "true";
  kimiInstant.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(extraction) } }] });
  fetchBrandImages.mockResolvedValue({ cover: "https://mpgummies.com/cover.jpg", images: ["https://mpgummies.com/cover.jpg"] });
  fetchBrandImagesViaSearch.mockResolvedValue({ cover: "https://elsewhere.com/x.jpg", images: [] });
});
afterAll(() => { delete process.env.BRAND_IDENTITY_GATE; });

it("confirmed: stores the profile and the identity record; images come from the confirmed domain only", async () => {
  webSearch.mockResolvedValue(grounded(["wikipedia.org", "mpgummies.com"]));
  const id = await mkBrand("MPG Performance Gummies", "mpgummies.com");
  await researchBrand(id, "MPG Performance Gummies", "mpgummies.com", { force: true });
  const r = await row(id);
  expect(r).toMatchObject({ brand_tier: "emerging", audience_summary: "Athletes", image_url: "https://mpgummies.com/cover.jpg" });
  expect((r.enrichment as any).identity).toMatchObject({ status: "confirmed", domain: "mpgummies.com", own_sources: ["mpgummies.com"] });
  expect(fetchBrandImages.mock.calls.map((c) => c[0])).toEqual(["mpgummies.com"]); // never the name-guessed domain
  expect(fetchBrandImagesViaSearch).not.toHaveBeenCalled();
  // The pages the searches saw are kept as the profile's sources (shown as links), de-duplicated across searches.
  expect((r.enrichment as any).sources).toEqual([
    { url: "https://wikipedia.org/about", title: "About wikipedia.org" },
    { url: "https://mpgummies.com/about", title: "About mpgummies.com" },
  ]);
  // Four OpenAI web searches on the fast tier, each capped at two calls at low context.
  expect(webSearch).toHaveBeenCalledTimes(4);
  for (const [req] of webSearch.mock.calls) {
    expect(req.model.provider).toBe("openai");
    expect(req.webSearch).toEqual({ maxCalls: 2, contextSize: "low" });
  }
});

it("the gate reads the URL a page is hosted on, never its title: a page titled with the brand's domain elsewhere does not confirm", async () => {
  webSearch.mockResolvedValue({ ...grounded([]), sources: [{ url: "https://reseller.example/mpg", title: "spoofed.com" }] });
  const id = await mkBrand("Spoofed", "spoofed.com");
  await researchBrand(id, "Spoofed", "spoofed.com", { force: true });
  const r = await row(id);
  expect((r.enrichment as any).identity).toMatchObject({ status: "unconfirmed", domain: "spoofed.com" });
  expect((r.enrichment as any).sources).toBeUndefined();
  expect(kimiInstant).not.toHaveBeenCalled();
});

it("a failed search stores nothing new and never throws", async () => {
  webSearch.mockRejectedValue(new Error("503"));
  const id = await mkBrand("Down Co", "down.example");
  await expect(researchBrand(id, "Down Co", "down.example", { force: true })).resolves.toBeUndefined();
  expect((await row(id)).enrichment).toEqual({ identity: expect.objectContaining({ status: "unconfirmed" }) });
});

it("unconfirmed: a look-alike's research is not stored, and an earlier wrong profile is cleared", async () => {
  webSearch.mockResolvedValue(grounded(["startx.com", "stanford.edu"]));
  const id = await mkBrand("StartX1", "startx1.com", {
    description: "Sports Tech. The StartX accelerator.", brand_tier: "established", audience_summary: "Founders",
    sport_categories: ["multi-sport"], known_athlete_partnerships: ["Lexie Hull"], category: "Sports Tech",
    image_url: "https://startx.com/hero.jpg", images: ["https://startx.com/hero.jpg"], logo_url: "https://logo/startx1.png",
    enrichment: { industry: "Sports Tech" }, enriched_at: new Date("2026-09-02"),
  });
  const athlete = await seedAthlete();
  await db.insert(brandFitNarratives).values({ athlete_id: athlete, brand_id: id, audience: "a", credibility: "c", whitespace: "w" } as any);
  await researchBrand(id, "StartX1", "startx1.com", { force: true });
  expect(await db.select().from(brandFitNarratives).where(eq(brandFitNarratives.brand_id, id))).toEqual([]);
  const r = await row(id);
  expect(r).toMatchObject({ description: null, brand_tier: null, audience_summary: null, sport_categories: null,
    known_athlete_partnerships: null, image_url: null, images: null, category: null, logo_url: "https://logo/startx1.png", domain: "startx1.com" });
  expect(r.enrichment).toEqual({ identity: expect.objectContaining({ status: "unconfirmed", domain: "startx1.com", basis: "no_own_domain_source" }) });
  expect(kimiInstant).not.toHaveBeenCalled(); // nothing extracted, nothing kept
});

it("unconfirmed keeps a category that did not come from research", async () => {
  webSearch.mockResolvedValue(grounded(["other.com"]));
  const id = await mkBrand("Categorised", "categorised.com", { category: "Beverages", enrichment: { industry: "Food Tech" }, enriched_at: new Date() });
  await researchBrand(id, "Categorised", "categorised.com", { force: true });
  expect((await row(id)).category).toBe("Beverages");
});

it("no domain evidence: no search runs, the verdict is recorded, any old profile is cleared", async () => {
  const id = await mkBrand("Stan Eats", null, { description: "Food Tech. Seattle surplus food.", enrichment: { industry: "Food Tech" }, enriched_at: new Date() });
  await researchBrand(id, "Stan Eats", "", { force: true });
  expect(webSearch).not.toHaveBeenCalled();
  const r = await row(id);
  expect(r.description).toBeNull();
  expect((r.enrichment as any).identity).toMatchObject({ status: "unconfirmed", domain: null, basis: "no_domain_evidence" });
});

it("gate off: today's behaviour — the profile is stored and no identity record is written", async () => {
  process.env.BRAND_IDENTITY_GATE = "false";
  webSearch.mockResolvedValue(grounded(["startx.com"]));
  const id = await mkBrand("Gate Off Co", "gateoff.com");
  await researchBrand(id, "Gate Off Co", "gateoff.com", { force: true });
  const r = await row(id);
  expect(r.brand_tier).toBe("emerging");
  expect((r.enrichment as any).identity).toBeUndefined();
});

describe("the identity gate on hosts: look-alikes, subdomains, other sites and http", () => {
  const cases: Array<[string, string[], "confirmed" | "unconfirmed"]> = [
    ["a look-alike that ends with the domain's name", ["evilmpgummies.com"], "unconfirmed"],
    ["the domain inside another site's host", ["mpgummies.com.evil.io"], "unconfirmed"],
    ["a different TLD", ["mpgummies.co"], "unconfirmed"],
    ["the brand's own subdomain", ["shop.mpgummies.com"], "confirmed"],
  ];
  for (const [name, hosts, status] of cases) {
    it(`${name}: ${status}`, async () => {
      webSearch.mockResolvedValue(grounded(hosts));
      const id = await mkBrand(`Brand ${name}`, "mpgummies.com");
      await researchBrand(id, `Brand ${name}`, "mpgummies.com", { force: true });
      expect((await row(id)).enrichment).toMatchObject({ identity: { status } });
    });
  }
  it("an http page on the brand's domain confirms (the host is what counts, not the scheme); a redirect link through another site does not", async () => {
    webSearch.mockResolvedValue({ ...grounded([]), sources: [{ url: "http://mpgummies.com/" }] });
    const a = await mkBrand("HTTP Brand", "mpgummies.com");
    await researchBrand(a, "HTTP Brand", "mpgummies.com", { force: true });
    expect((await row(a)).enrichment).toMatchObject({ identity: { status: "confirmed" } });
    webSearch.mockResolvedValue({ ...grounded([]), sources: [{ url: "https://l.example-redirect.com/out?u=https%3A%2F%2Fmpgummies.com" }] });
    const b = await mkBrand("Redirect Brand", "mpgummies.com");
    await researchBrand(b, "Redirect Brand", "mpgummies.com", { force: true });
    expect((await row(b)).enrichment).toMatchObject({ identity: { status: "unconfirmed" } });
  });
});

describe("the global daily brand research cap", () => {
  afterEach(() => { delete process.env.BRAND_RESEARCH_DAILY_CAP; });
  it("clamps: unset or junk is 100, never above 1,000", () => {
    const { brandResearchDailyCap } = jest.requireActual("./researchBrand");
    expect(brandResearchDailyCap({} as any)).toBe(100);
    expect(brandResearchDailyCap({ BRAND_RESEARCH_DAILY_CAP: "abc" } as any)).toBe(100);
    expect(brandResearchDailyCap({ BRAND_RESEARCH_DAILY_CAP: "0" } as any)).toBe(100);
    expect(brandResearchDailyCap({ BRAND_RESEARCH_DAILY_CAP: "5000" } as any)).toBe(1_000);
    expect(brandResearchDailyCap({ BRAND_RESEARCH_DAILY_CAP: "20" } as any)).toBe(20);
  });
  it("at the cap: no search runs and nothing is written", async () => {
    const { brandResearchesToday } = jest.requireActual("./researchBrand");
    await mkBrand("Researched Today", "researched.example", { enriched_at: new Date() });
    process.env.BRAND_RESEARCH_DAILY_CAP = String(await brandResearchesToday());
    webSearch.mockResolvedValue(grounded(["mpgummies.com"]));
    const id = await mkBrand("Capped Brand", "mpgummies.com");
    await researchBrand(id, "Capped Brand", "mpgummies.com", { force: true });
    expect(webSearch).not.toHaveBeenCalled();
    expect((await row(id)).enriched_at).toBeNull();
  });
});
