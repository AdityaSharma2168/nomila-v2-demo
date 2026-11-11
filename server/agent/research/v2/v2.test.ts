/**
 * v2.test.ts — the narrow research pipeline (agent/research/v2) with every outside call mocked: no provider, no network.
 */
import { coverageOf, planQueries } from "./plan";
import { discover, openaiDiscover, qualityOf, type DiscoverQuery } from "./discover";
import { cleanHtml, fetchAndClean, robotsAllows } from "./fetchClean";
import { namesAthlete, pageIdentity, rankPassages, splitPassages } from "./rank";
import { extractInput } from "./extract";
import { runNarrowResearch } from "./pipeline";
import { researchV2ShadowEnabled, discoverProviderOf, V2 } from "./config";
import { passResultFrom } from "../research";
import type { MemoryFact } from "../../../../shared/agent";

// The OpenAI search call is mocked: tests never reach a provider.
const callStructuredMock = jest.fn();
jest.mock("../llm", () => ({ ...jest.requireActual("../llm"), callStructured: (...a: unknown[]) => callStructuredMock(...a) }));

const ATHLETE = { name: "Riley Example", sport: "soccer" };
const TODAY = "2026-10-25";
const para = (s: string, n = 6) => Array.from({ length: n }, () => s).join(" ");
const article = (body: string) => `<html><head><title>Story</title><meta property="article:published_time" content="2026-09-12T10:00:00Z"></head>
<body><nav>Home | Scores | Shop</nav><article><h1>Feature</h1><p>${body}</p><p>${body}</p></article><footer>Cookies · Ads</footer></body></html>`;

describe("config", () => {
  test("the shadow is on only for exactly \"true\"; discovery is OpenAI web search (the one search provider)", () => {
    expect(researchV2ShadowEnabled({ RESEARCH_PIPELINE_V2_SHADOW: "true" } as any)).toBe(true);
    for (const v of [undefined, "1", "TRUE", "false"]) expect(researchV2ShadowEnabled({ RESEARCH_PIPELINE_V2_SHADOW: v } as any)).toBe(false);
    expect(discoverProviderOf()).toBe("openai_search");
  });
});

describe("plan", () => {
  test("sign-up is identity first: name + sport, team roster, handle, profile — then evidence; quoted name; capped", () => {
    const p = planQueries({ ...ATHLETE, team: "Example University", handles: ["@riley.ex"], today: TODAY });
    expect(p.length).toBeLessThanOrEqual(V2.maxQueries);
    expect(p.every((q) => q.q.includes(`"${ATHLETE.name}"`))).toBe(true);
    expect(p.slice(0, 3).map((q) => q.aim)).toEqual(["identity", "identity", "identity"]);
    expect(p[1].q).toContain("Example University soccer roster OR bio");
    expect(p[2].q).toContain('"riley.ex"');
    expect(p.map((q) => q.aim)).toEqual(expect.arrayContaining(["results", "partners", "media"]));
    expect(p.some((q) => q.q.includes("2026"))).toBe(true);
    expect(new Set(p.map((q) => q.q)).size).toBe(p.length);
  });
  test("sign-up with only name and sport still plans identity first", () => {
    const p = planQueries({ ...ATHLETE, today: TODAY });
    expect(p.slice(0, 2).map((q) => q.aim)).toEqual(["identity", "identity"]);
    expect(p.every((q) => q.q.includes("soccer"))).toBe(true);
  });
  test("refresh aims at what the record lacks: covered areas skipped, stale facts don't count, results/upcoming always", () => {
    const fact = (topic: string, date: string) => ({ type: "found", status: "active", topic, date, createdAt: date }) as unknown as MemoryFact;
    const known = [fact("sponsor", "2026-09-01"), fact("business", "2026-08-01"), fact("media", "2025-01-01"), fact("media", "2025-02-01"), fact("stats", "2026-10-01"), fact("stats", "2026-10-02")];
    expect(coverageOf(known, TODAY)).toMatchObject({ partners: 2, media: 0, results: 2 });
    const p = planQueries({ ...ATHLETE, today: TODAY, moment: "refresh", known });
    const aims = p.map((q) => q.aim);
    expect(aims[0]).toBe("identity");
    expect(aims).not.toContain("partners");
    expect(aims).toEqual(expect.arrayContaining(["media", "honours", "audience", "results", "upcoming"]));
    expect(aims.indexOf("media")).toBeLessThan(aims.indexOf("results"));
  });
  test("no name or sport: no queries", () => {
    expect(planQueries({ name: "", sport: "soccer", today: TODAY })).toEqual([]);
  });
});

describe("discover", () => {
  test("de-duplicates pages, drops social and file links, ranks official sites first, keeps going past a failed query", async () => {
    const run: DiscoverQuery = jest.fn(async (q: string) => {
      if (q.includes("interview")) throw new Error("quota");
      return { costMicroUsd: 1000, results: [
        { url: "https://blog.example.com/riley", title: "Blog" },
        { url: "https://www.example.edu/sports/riley?x=1", title: "Roster" },
        { url: "https://example.edu/sports/riley", title: "Roster again" },
        { url: "https://www.instagram.com/riley/", title: "IG" },
        { url: "https://news.example.com/file.pdf", title: "PDF" },
      ] };
    });
    const r = await discover(planQueries({ ...ATHLETE, today: TODAY }), run, "openai_search");
    expect(r.pages.map((p) => p.url)).toEqual(["https://www.example.edu/sports/riley?x=1", "https://blog.example.com/riley"]);
    expect(r.errors.some((e) => e.startsWith("media"))).toBe(true);
    expect(r.costMicroUsd).toBeGreaterThan(0);
  });
  test("site quality: school or government site > encyclopedia > other", () => {
    expect(qualityOf("https://athletics.example.edu/x")).toBe(3);
    
    expect(qualityOf("https://en.wikipedia.org/wiki/X")).toBe(2);
    expect(qualityOf("https://someblog.net/x")).toBe(1);
  });
  test("OpenAI discovery: one low-context web search on the fast tier; only pages the search saw count; fees from the call", async () => {
    callStructuredMock.mockResolvedValueOnce({
      json: { pages: [{ url: "https://seen.example.edu/roster", title: "Roster" }, { url: "https://invented.example.com/x", title: "Never searched" }] },
      sources: [{ url: "https://seen.example.edu/roster", title: "Roster" }],
      cost: { microUsd: 11_000, webSearchCalls: 1 },
    });
    const r = await openaiDiscover()("\"Riley Example\" soccer");
    const call = callStructuredMock.mock.calls[0][0];
    expect(call.webSearch).toEqual({ maxCalls: 1, contextSize: "low" });
    expect(call.model.provider).toBe("openai");
    expect(r.results.map((x) => x.url)).not.toContain("https://invented.example.com/x");
    expect(r.results.map((x) => x.url)).toContain("https://seen.example.edu/roster");
    expect(r).toMatchObject({ costMicroUsd: 11_000, searchQueries: 1 });
    expect(r.searchFeeMicroUsd).toBeGreaterThan(0);
  });
});

describe("fetch + clean", () => {
  test("robots.txt: our agent's group wins over *, longest rule wins, Allow wins a tie", () => {
    const robots = "User-agent: *\nDisallow: /private\n\nUser-agent: NomilaResearchBot\nDisallow: /\nAllow: /news\n";
    expect(robotsAllows(robots, "/news/story")).toBe(true);
    expect(robotsAllows(robots, "/roster")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/private/x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/public")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
  });
  test("Readability keeps the article text and the page date; navigation and footer are gone", () => {
    const page = cleanHtml(article(para("Riley Example scored twice for the soccer team in the final.")), "https://x.example.com/a")!;
    expect(page.text).toContain("Riley Example scored twice");
    expect(page.text).not.toMatch(/Cookies|Scores \| Shop/);
    expect(page.date).toBe("2026-09-12");
  });
  test("skips: robots, non-HTML, HTTP errors and script-only pages; never reaches the real network", async () => {
    const pages: Record<string, Response> = {
      "https://ok.example.com/robots.txt": new Response("", { status: 404 }),
      "https://ok.example.com/a": new Response(article(para("Riley Example soccer news from the season opener.")), { headers: { "content-type": "text/html" } }),
      "https://ok.example.com/js": new Response("<html><body><div id=app></div><script>render()</script></body></html>", { headers: { "content-type": "text/html" } }),
      "https://ok.example.com/pdf": new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      "https://ok.example.com/404": new Response("no", { status: 404 }),
      "https://blocked.example.com/robots.txt": new Response("User-agent: *\nDisallow: /"),
    };
    const f = jest.fn(async (u: any) => (pages[String(u)] ?? new Response("", { status: 404 })).clone()) as any;
    const out = await fetchAndClean(["https://ok.example.com/a", "https://ok.example.com/js", "https://ok.example.com/pdf", "https://ok.example.com/404", "https://blocked.example.com/x"], f);
    expect(out.map((o) => o.skipped)).toEqual([null, "script_only", "not_html", "http_error", "robots"]);
    expect(out[0].page!.text).toContain("season opener");
  });
});

describe("rank + filter", () => {
  test("names the athlete by full name or initial + surname", () => {
    expect(namesAthlete("…said Riley Example after…", ATHLETE.name)).toBe(true);
    expect(namesAthlete("…R. Example scored…", ATHLETE.name)).toBe(true);
    expect(namesAthlete("…Example Corp announced…", ATHLETE.name)).toBe(false);
  });
  const pg = (text: string) => ({ url: "https://news.example.com/a", title: "News", text });
  test("a page tying the name to another sport is a namesake; their sport or team anchors it", () => {
    const other = pageIdentity(pg("Riley Example pitched six innings for the baseball club."), { name: ATHLETE.name, sport: "soccer" });
    expect(other.verdict).toBe("other");
    expect((other as any).reason).toMatch(/pitched|innings|baseball/);
    expect(pageIdentity(pg("Riley Example scored in the soccer final."), { name: ATHLETE.name, sport: "soccer" }).verdict).toBe("anchored");
    expect(pageIdentity(pg("Riley Example signed with Example University."), { name: ATHLETE.name, sport: "soccer", team: "Example University" }).verdict).toBe("anchored");
  });
  test("strict (sign-up): the sport far from the name is not proof — neutral, not anchored and not rejected", () => {
    const far = `Riley Example opened a bakery downtown. ${"Filler text about the town. ".repeat(60)} The soccer club plays on Saturdays.`;
    expect(pageIdentity(pg(far), { name: ATHLETE.name, sport: "soccer" }).verdict).toBe("anchored");
    expect(pageIdentity(pg(far), { name: ATHLETE.name, sport: "soccer" }, { strict: true })).toEqual({ verdict: "neutral", via: "anchor named far from the name" });
    expect(pageIdentity(pg("Soccer forward Riley Example scored."), { name: ATHLETE.name, sport: "soccer" }, { strict: true }).verdict).toBe("anchored");
  });
  test("keeps only passages naming the athlete, rejects namesakes, caps per page, budget respected, S1.. ids", () => {
    const own = { url: "https://team.example.edu/riley", title: "Roster", date: null, quality: 3, text: [para("Riley Example is a forward for the soccer team and captain this season.", 15), para("The stadium was renovated in 2019 and seats 5,000 fans.", 20), para("Riley Example scored the winning goal in the conference soccer final.", 15)].join("\n\n") };
    const namesake = { url: "https://other.example.com/x", title: "Baseball", date: null, quality: 1, text: para("Riley Example pitched a shutout for the baseball club.") };
    const unrelated = { url: "https://news.example.com/y", title: "Other", date: null, quality: 2, text: para("A different athlete won the race.") };
    const r = rankPassages([own, namesake, unrelated], { ...ATHLETE, team: "Northfield University" });
    expect(r.wrongPerson.map((w) => w.url)).toEqual(["https://other.example.com/x"]);
    expect(r.anchoredPages).toBe(1);
    expect(r.unrelated).toBe(1);
    expect(r.passages.every((p) => namesAthlete(p.text, ATHLETE.name))).toBe(true);
    expect(r.passages.some((p) => p.text.includes("stadium was renovated"))).toBe(false);
    expect(r.passages.map((p) => p.id)).toEqual(r.passages.map((_, i) => `S${i + 1}`));
    expect(r.chars).toBeLessThanOrEqual(V2.maxPassageChars);
  });
  test("long text splits into passages of about the passage size", () => {
    const parts = splitPassages(Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ${"x".repeat(200)}`).join("\n\n"));
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= V2.passageChars * 1.5)).toBe(true);
  });
});

describe("extract", () => {
  test("the input carries the athlete, said facts only, and each source fenced by its id and URL", () => {
    const said = { type: "said", status: "active", claim: "Riley plays for Example University." } as unknown as MemoryFact;
    const found = { type: "found", status: "active", claim: "Found claim." } as unknown as MemoryFact;
    const text = extractInput(ATHLETE, [said, found], [{ id: "S1", url: "https://team.example.edu/riley", title: "Roster", date: "2026-09-12", text: "Riley Example is a forward.", score: 1 }], TODAY);
    expect(text).toContain("- Name: Riley Example");
    expect(text).toContain("Riley plays for Example University.");
    expect(text).not.toContain("Found claim.");
    expect(text).toContain("[S1] Roster\nURL: https://team.example.edu/riley\nPage date: 2026-09-12");
  });
  test("its answer goes through the same checks as a research pass: an unfetched URL is dropped", () => {
    const r = passResultFrom({
      runId: "r1", reused: false, cost: { microUsd: 500 }, sources: [{ url: "https://team.example.edu/riley" }],
      json: { identity: { resolved: true, description: "Soccer forward", ambiguity: "" }, gaps: [], narrative: "", facts: [
        { claim: "Riley Example is a forward for Example University.", topic: "team", source_url: "https://team.example.edu/riley", source_title: "Roster", source_type: "official", date: "2026", confidence: 0.9, subject_kind: "athlete", subject_name: "Riley Example", sensitivity: "none", never_reason: "none", care_kind: "none" },
        { claim: "Riley Example signed with a drinks brand.", topic: "sponsor", source_url: "https://never-fetched.example.com/x", source_title: "X", source_type: "other", date: "2026", confidence: 0.6, subject_kind: "athlete", subject_name: "Riley Example", sensitivity: "none", never_reason: "none", care_kind: "none" },
      ] },
    }, ATHLETE, "a", "v");
    expect(r.facts.map((f) => [f.key, f.source_url])).toEqual([["v1", "https://team.example.edu/riley"]]);
    expect(r.dropped.length).toBe(1);
  });
});

describe("pipeline", () => {
  test("end to end with mocked discovery, fetch and extract: metrics measured, nothing reaches a provider", async () => {
    const pageHtml = article(para("Riley Example scored twice for the soccer team in the final and was named captain."));
    const f = jest.fn(async (u: any) => (String(u).endsWith("robots.txt") ? new Response("", { status: 404 }) : new Response(pageHtml, { headers: { "content-type": "text/html" } }))) as any;
    const discoverQuery: DiscoverQuery = async (q) => ({ costMicroUsd: 2000, results: [{ url: `https://team.example.edu/riley-${q.length}`, title: "Roster" }] });
    const extract = jest.fn(async (passages: any[]) => passResultFrom({
      runId: "x1", reused: false, cost: { microUsd: 80_000 }, sources: passages.map((p) => ({ url: p.url })),
      json: { identity: { resolved: true, description: "", ambiguity: "" }, gaps: ["deal values"], narrative: "", facts: [
        { claim: "Riley Example was named captain.", topic: "team", source_url: passages[0].url, source_title: "Roster", source_type: "official", date: "2026", confidence: 0.9, subject_kind: "athlete", subject_name: "Riley Example", sensitivity: "none", never_reason: "none", care_kind: "none" },
      ] },
    }, ATHLETE, "a", "v"));
    const out = await runNarrowResearch({ store: {} as any, athleteId: "a1", parentPrefix: "shadow:t" }, { athlete: ATHLETE, known: [], today: TODAY }, { provider: "openai_search", discoverQuery, fetchImpl: f, extract }, "shadow:t");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(out.metrics.factsKept).toBe(1);
    expect(out.metrics.officialSources).toBe(1);
    expect(out.metrics.pagesFetched).toBeGreaterThan(0);
    expect(out.metrics.costMicroUsd.total).toBe(out.metrics.costMicroUsd.discover + 80_000);
    expect(out.metrics.identityResolved).toBe(true);
    expect(out.metrics.moment).toBe("signup");
    expect(out.metrics.outcome).toBe("confirmed");
  });
  test("sign-up, identity unclear: honest \"couldn't confirm\", facts withheld, the reason kept", async () => {
    const pageHtml = article(para("Riley Example scored twice for the soccer team in the final and was named captain."));
    const f = jest.fn(async (u: any) => (String(u).endsWith("robots.txt") ? new Response("", { status: 404 }) : new Response(pageHtml, { headers: { "content-type": "text/html" } }))) as any;
    const extract = jest.fn(async (passages: any[]) => passResultFrom({
      runId: "x2", reused: false, cost: { microUsd: 50_000 }, sources: passages.map((p) => ({ url: p.url })),
      json: { identity: { resolved: false, description: "", ambiguity: "Two soccer players share this name." }, gaps: [], narrative: "", facts: [
        { claim: "Riley Example was named captain.", topic: "team", source_url: passages[0].url, source_title: "Roster", source_type: "official", date: "2026", confidence: 0.5, subject_kind: "athlete", subject_name: "Riley Example", sensitivity: "none", never_reason: "none", care_kind: "none" },
      ] },
    }, ATHLETE, "a", "v"));
    const out = await runNarrowResearch({ store: {} as any, athleteId: "a1", parentPrefix: null }, { athlete: ATHLETE, known: [], today: TODAY }, { provider: "openai_search", discoverQuery: async () => ({ costMicroUsd: 0, results: [{ url: "https://team.example.edu/r", title: "" }] }), fetchImpl: f, extract }, "p");
    expect(out.metrics.outcome).toBe("unconfirmed");
    expect(out.metrics.unconfirmedReason).toBe("Two soccer players share this name.");
    expect(out.metrics.factsKept).toBe(0);
    expect(out.metrics.factsWithheld).toBe(1);
    expect(out.result!.facts).toEqual([]);
  });
  test("no passages about the athlete: no extract call at all (nothing spent on the model)", async () => {
    const f = jest.fn(async () => new Response(article(para("Nothing about our athlete here at all.")), { headers: { "content-type": "text/html" } })) as any;
    const extract = jest.fn();
    const out = await runNarrowResearch({ store: {} as any, athleteId: "a1", parentPrefix: null }, { athlete: ATHLETE, known: [], today: TODAY }, { provider: "openai_search", discoverQuery: async () => ({ costMicroUsd: 0, results: [{ url: "https://x.example.com/a", title: "" }] }), fetchImpl: f, extract: extract as any }, "p");
    expect(extract).not.toHaveBeenCalled();
    expect(out.result).toBeNull();
    expect(out.metrics.costMicroUsd.extract).toBe(0);
    expect(out.metrics.outcome).toBe("unconfirmed");
    expect(out.metrics.unconfirmedReason).toMatch(/No page we could read named this athlete/);
  });
});
