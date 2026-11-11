/**
 * lean.test.ts — LEAN research (agent/research/v2/lean.ts and its parts), every outside call mocked: no provider, no
 * network, no database.
 *
 *   L1 the plan covers identity, then results and every commercial area; topics narrow it; identity-only; follow-up
 *   L2 the dimension map uses the M.I.A.'s own eight dimensions; facts per dimension; empty dimensions → follow-up aims
 *   L3 the verifier's date fix: a page date is labelled "(page date)" and the source shows its page date; a stated date
 *      is not; verify-facts 1.1.0 carries the rule; extract-all 1.1.0 carries the balance rule
 *   L4 happy path: Wikidata first (free), then search; identity confirmed; facts verified; follow-up for empty dimensions
 *   L5 identity not confirmed: no fact kept, no verify call; nothing about the athlete at all ⇒ no model call
 *   L6 de-duplication and conflicts (leanSave.planFactWrites)
 *   L7 topic-balanced selection into the scorer's cap (memoryAdapter.balancedByTopic); the default is unchanged
 *   L8 Wikidata free discovery (ported from the bake-off)
 */
jest.mock("../../../db", () => ({ db: {} }));   // pure: nothing here reaches a database
import { leanFollowUpQueries, leanPlanQueries, COMMERCIAL_AIMS, LEAN_MAX_QUERIES } from "./plan";
import { DIMENSION_TOPICS, emptyDimensions, factsByDimension } from "./dimensions";
import { EXTRACT_ALL_MAX_FACTS, EXTRACT_ALL_SCHEMA, applyVerdicts, isPageDate, verifyInput, type LeanCallRequest, type LeanModelCall } from "./extractAll";
import { EXTRACT_SCHEMA } from "./extract";
import { LEAN, leanSignupResearchEnabled, parseModelChoice, runLeanResearch } from "./lean";
import { claimShape, planFactWrites, relation, numbersOf, normClaim } from "./leanSave";
import { entityOf, identifierUrl, matchesSport, pickAthleteLinks, pickRosterLinks, wikidataSeeds, type WikidataGet } from "./wikidata";
import { loadJob } from "../../jobs";
import { MARKETABILITY_DIMENSIONS } from "../../../services/intelligence/types";
import { balancedByTopic, selectFactsOnlyInput, type PreviewFact } from "../../../services/miaPreview/memoryAdapter";
import { factsGeminiChoice } from "../../../services/marketabilityBeta1Evaluator";
import { GEMINI } from "../../../lib/models";
import type { MemoryFact } from "../../../../shared/agent";
import type { PassFact } from "../research";
import type { Passage } from "./rank";

const ATHLETE = { name: "Riley Example", sport: "soccer" };
const TODAY = "2026-10-26";
const para = (s: string, n = 6) => Array.from({ length: n }, () => s).join(" ");
const page = (title: string, body: string, date = "2026-09-12") => `<html><head><title>${title}</title><meta property="article:published_time" content="${date}T10:00:00Z"></head>
<body><nav>Home | Scores | Shop</nav><article><h1>${title}</h1><p>${body}</p><p>${body}</p></article><footer>Cookies</footer></body></html>`;
const usage = (microUsd: number) => ({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, reasoningTokens: 0, webSearchCalls: 0, microUsd });

describe("L1 plan", () => {
  test("sign-up: identity first, then results and EVERY commercial area; quoted name; capped", () => {
    const p = leanPlanQueries({ ...ATHLETE, team: "Example University", handles: ["riley.ex"], today: TODAY });
    expect(p.length).toBeLessThanOrEqual(LEAN_MAX_QUERIES);
    expect(p.slice(0, 3).map((q) => q.aim)).toEqual(["identity", "identity", "identity"]);
    expect(p.map((q) => q.aim)).toEqual(expect.arrayContaining(["results", ...COMMERCIAL_AIMS]));
    expect(p.every((q) => q.q.includes(`"${ATHLETE.name}"`))).toBe(true);
  });
  test("topics narrow it; [] is identity only", () => {
    expect(leanPlanQueries({ ...ATHLETE, today: TODAY, moment: "refresh", aims: ["partners"] }).map((q) => q.aim)).toEqual(["identity", "identity", "partners"]);
    expect(leanPlanQueries({ ...ATHLETE, today: TODAY, moment: "refresh", aims: [] }).map((q) => q.aim)).toEqual(["identity", "identity"]);
  });
  test("follow-up: one differently worded query per empty area, generic words only", () => {
    const f = leanFollowUpQueries({ ...ATHLETE, today: TODAY }, ["partners", "audience"]);
    expect(f.map((q) => q.aim)).toEqual(["partners", "audience"]);
    const first = leanPlanQueries({ ...ATHLETE, today: TODAY });
    for (const q of f) expect(first.map((x) => x.q)).not.toContain(q.q);
  });
});

describe("L2 dimensions", () => {
  test("the map covers exactly the M.I.A.'s eight dimensions, each fed by at least one research topic", () => {
    expect(Object.keys(DIMENSION_TOPICS).sort()).toEqual([...MARKETABILITY_DIMENSIONS].sort());
    for (const d of MARKETABILITY_DIMENSIONS) expect(DIMENSION_TOPICS[d].length).toBeGreaterThan(0);
  });
  test("facts per dimension (about the athlete only) and the follow-up aims for empty ones", () => {
    const by = factsByDimension([{ topic: "stats", subject_kind: "athlete" }, { topic: "sponsor", subject_kind: "athlete" }, { topic: "sponsor", subject_kind: "organization" }]);
    expect(by.athletic_authority).toBe(1);
    expect(by.commercial_proof).toBe(1);
    expect(by.audience_scale).toBe(0);
    const gap = emptyDimensions(by);
    expect(gap.dimensions).toEqual(expect.arrayContaining(["audience_scale", "engagement_quality", "cultural_relevance", "momentum"]));
    expect(gap.dimensions).not.toContain("commercial_proof");
    expect(gap.aims).toEqual(expect.arrayContaining(["audience", "media", "upcoming"]));
    expect(emptyDimensions(by, ["partners"]).aims).toEqual([]);   // a refresh about partners only never searches other areas
  });
});

const passages: Passage[] = [
  { id: "S1", url: "https://team.example.edu/riley", title: "Roster", date: "2026-09-12", text: "Riley Example's full name is Riley Ann Example.", score: 100 },
  { id: "S2", url: "https://news.example.com/a", title: "News", date: null, text: "Riley Example signed with Example Brand on 8 September 2025.", score: 3 },
];
const pf = (claim: string, url: string, date: string | null, extra: Partial<PassFact> = {}): PassFact => ({ key: "v1", subject_kind: "athlete", subject_name: "Riley Example", claim, topic: "stats", source_url: url, source_title: "", source_type: "official", date: date ?? "", confidence: 0.9, care: false, careKind: null, ...extra });

describe("L3 the verifier's date fix", () => {
  test("isPageDate: the page's own date or a coarser form of it", () => {
    expect(isPageDate("2026-09-12", "2026-09-12")).toBe(true);
    expect(isPageDate("2026-09", "2026-09-12")).toBe(true);
    expect(isPageDate("2026", "2026-09-12T10:00")).toBe(true);
    expect(isPageDate("2025", "2026-09-12")).toBe(false);
    expect(isPageDate("2026", null)).toBe(false);
    expect(isPageDate("", "2026-09-12")).toBe(false);
  });
  test("a fact dated with its page's date is labelled (page date); the source shows the page date; a stated date is not labelled", () => {
    const { input } = verifyInput([pf("Riley Example's full name is Riley Ann Example.", passages[0].url, "2026-09-12"), pf("Riley Example signed with Example Brand on 8 September 2025.", passages[1].url, "2025-09-08")], passages);
    expect(input).toContain("F1 | source V1 | Riley Example's full name is Riley Ann Example. | date 2026-09-12 (page date)");
    expect(input).toContain("F2 | source V2 | Riley Example signed with Example Brand on 8 September 2025. | date 2025-09-08");
    expect(input).not.toContain("2025-09-08 (page date)");
    expect(input).toContain("[V1] URL: https://team.example.edu/riley\nPage date: 2026-09-12");
    expect(input).toContain("[V2] URL: https://news.example.com/a\nPage date: unknown");
  });
  test("verify-facts 1.1.0 holds the claim, not the page date; extract-all 1.1.0 balances topics at the cap", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ");
    const v = loadJob("research/verify-facts");
    expect(v.version).toBe("1.1.0");
    expect(flat(v.instructions)).toContain("When it is marked `(page date)`, it is only the date the page itself was published or updated, attached because the source gives no date for the fact. Never mark a fact not_supported because the source text does not state that date. Judge the claim.");
    expect(flat(v.instructions)).toContain("A date written inside the claim, or a date not marked `(page date)`, must be supported like any other detail.");
    const e = loadJob("research/extract-all");
    expect(e.version).toBe("1.1.0");
    expect(flat(e.instructions)).toContain("No single topic takes more than 40 facts.");
    expect((EXTRACT_ALL_SCHEMA as any).properties.facts.maxItems).toBe(EXTRACT_ALL_MAX_FACTS);
    const strip = (s: any) => { const c = JSON.parse(JSON.stringify(s)); delete c.properties.facts.maxItems; return c; };
    expect(strip(EXTRACT_ALL_SCHEMA)).toEqual(strip(EXTRACT_SCHEMA));
  });
  test("verdicts: supported kept; not_supported and unanswered dropped", () => {
    const fs = [pf("a", passages[0].url, ""), pf("b", passages[0].url, ""), pf("c", passages[0].url, "")];
    const r = applyVerdicts(fs, ["F1", "F2", "F3"], { results: [{ id: "F1", verdict: "supported", reason: "" }, { id: "F2", verdict: "not_supported", reason: "number differs" }] });
    expect(r.kept.map((f) => f.claim)).toEqual(["a"]);
    expect(r.unanswered).toBe(1);
  });
});

describe("config", () => {
  test("LEAN_SIGNUP_RESEARCH only for exactly \"true\"; model choices parse model[:effort]", () => {
    expect(leanSignupResearchEnabled({ LEAN_SIGNUP_RESEARCH: "true" } as any)).toBe(true);
    for (const v of [undefined, "1", "TRUE", "false"]) expect(leanSignupResearchEnabled({ LEAN_SIGNUP_RESEARCH: v } as any)).toBe(false);
    expect(parseModelChoice("gpt-6.1-sol")).toEqual({ provider: "openai", model: "gpt-6.1-sol", effort: "low" });
    expect(parseModelChoice("gpt-6-luna:medium")).toEqual({ provider: "openai", model: "gpt-6-luna", effort: "medium" });
    expect(parseModelChoice("")).toBeNull();
  });
  test("the facts-only scorer's Gemini model: today's default unless configured (e.g. gemini-3.8-flash at low thinking)", () => {
    expect(factsGeminiChoice({} as any)).toEqual({ model: GEMINI.flash, thinkingLevel: null });
    expect(factsGeminiChoice({ MIA_FACTS_GEMINI_MODEL: "gemini-3.8-flash", MIA_FACTS_GEMINI_THINKING: "low" } as any)).toEqual({ model: "gemini-3.8-flash", thinkingLevel: "low" });
    expect(factsGeminiChoice({ MIA_FACTS_GEMINI_THINKING: "max" } as any).thinkingLevel).toBeNull();
  });
});

// ── L4/L5: the pipeline, mocked ──────────────────────────────────────────────

const claim = (v: string, rank = "normal") => ({ rank, mainsnak: { datavalue: { value: /^Q\d+$/.test(v) ? { id: v } : v } } });
/** Wikidata: one soccer player Riley Example with an official site, and a same-name actress (never followed). */
const wikidata: WikidataGet = async (p) => {
  if (p.action === "wbsearchentities") return { search: [{ id: "Q1" }, { id: "Q2" }] };
  if (p.action === "wbgetentities" && p.ids === "Q1|Q2") return { entities: {
    Q1: { labels: { en: { value: "Riley Example" } }, descriptions: { en: { value: "college soccer player" } }, claims: { P31: [claim("Q5")], P856: [claim("https://rileyexample.example.com/")] } },
    Q2: { labels: { en: { value: "Riley Example" } }, descriptions: { en: { value: "stage actress" } }, claims: { P31: [claim("Q5")] } },
  } };
  return { entities: {} };
};
const PAGES: Record<string, string> = {
  "https://rileyexample.example.com/": page("Riley Example — soccer", para("Riley Example is a soccer midfielder for Example University and scored 7 goals in 2025.")),
  "https://news.example.com/deal": page("Riley Example signs NIL deal", para("Riley Example, the Example University soccer midfielder, signed an NIL deal with Example Brand.")),
  "https://news.example.com/followers": page("Riley Example audience", para("Riley Example, the soccer midfielder, has 12,000 Instagram followers.")),
};
const fetchImpl = jest.fn(async (u: any) => {
  const url = String(u);
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  const html = PAGES[url];
  return html ? new Response(html, { headers: { "content-type": "text/html" } }) : new Response("nope", { status: 404 });
}) as any;
const urlsIn = (input: string) => [...input.matchAll(/^URL: (\S+)/gm)].map((m) => m[1]);

/** A fake model: extract answers with one fact per source (topic by page), verify supports everything. */
function fakeCall(o: { resolved?: boolean } = {}) {
  const calls: LeanCallRequest[] = [];
  const call: LeanModelCall = async (req) => {
    calls.push(req);
    if (req.skillId === "research/extract-all") {
      const facts = urlsIn(req.input).map((url) => ({
        subject_kind: "athlete", subject_name: "Riley Example", source_title: "", source_type: "official", date: "2025", confidence: 0.9, sensitivity: "none", never_reason: "none", care_kind: "none",
        claim: url.includes("deal") ? "Riley Example signed an NIL deal with Example Brand." : url.includes("followers") ? "Riley Example has 12,000 Instagram followers." : "Riley Example scored 7 goals in 2025.",
        topic: url.includes("deal") ? "sponsor" : url.includes("followers") ? "social" : "stats", source_url: url,
      }));
      const json = { identity: { resolved: o.resolved !== false, description: "A college soccer midfielder.", ambiguity: o.resolved === false ? "Two soccer players share this name." : "", candidates: [] }, facts, gaps: [], narrative: "" };
      return { runId: `run-${calls.length}`, json: req.sanitize ? req.sanitize(json).json : json, cost: usage(100_000), reused: false, ms: 5, model: { provider: "openai", model: "gpt-6.1-sol", effort: "low" } };
    }
    const ids = [...req.input.matchAll(/^(F\d+) \|/gm)].map((m) => m[1]);
    return { runId: `run-${calls.length}`, json: { results: ids.map((id) => ({ id, verdict: "supported", reason: "stated" })) }, cost: usage(5_000), reused: false, ms: 2, model: { provider: "openai", model: "gpt-6-luna", effort: "low" } };
  };
  return { call, calls };
}

describe("L4/L5 runLeanResearch", () => {
  test("L4 happy path: Wikidata first (a namesake is never followed), then search; identity confirmed; facts verified; follow-up for empty dimensions", async () => {
    const searched: string[] = [];
    const discoverQuery = jest.fn(async (q: string) => {
      searched.push(q);
      // The first round's searches find the deal; only the follow-up's audience query finds the followers page.
      return { results: /subscribers/.test(q) ? [{ url: "https://news.example.com/followers", title: "followers" }] : [{ url: "https://news.example.com/deal", title: "deal" }], costMicroUsd: 10_000, searchQueries: 1, searchFeeMicroUsd: 10_000 };
    });
    const { call, calls } = fakeCall();
    const stages: Array<{ stage: string; count?: number }> = [];
    const r = await runLeanResearch({ athlete: ATHLETE, known: [], today: TODAY }, { call, discoverQuery, wikidataGet: wikidata, fetchImpl, followUpMaxMicroUsd: 10_000_000, onStage: (s) => { stages.push(s); throw new Error("a status line never breaks research"); } });
    expect(r.outcome).toBe("confirmed");
    // The live stages are real transitions, in order: finding, reading (pages read so far), pulling, checking — per round.
    expect(stages[0]).toEqual({ stage: "finding" });
    const order = stages.map((s) => s.stage).filter((s, i, a) => s !== a[i - 1]);
    expect(order.slice(0, 4)).toEqual(["finding", "reading", "pulling", "checking"]);
    expect(order).toEqual(expect.arrayContaining(["reading", "pulling", "checking"]));
    const reads = stages.filter((s) => s.stage === "reading").map((s) => s.count!);
    expect(reads[reads.length - 1]).toBe(r.pages.length);
    expect(reads).toEqual([...reads].sort((a, b) => a - b));
    expect(r.wikidata.hits.map((h) => [h.id, h.kept])).toEqual([["Q1", true], ["Q2", false]]);
    expect(r.pages.find((p) => p.via === "wikidata")?.url).toBe("https://rileyexample.example.com/");
    expect(r.facts.map((f) => f.topic)).toEqual(expect.arrayContaining(["stats", "sponsor"]));
    expect(r.byDimension.commercial_proof).toBeGreaterThan(0);
    // The first round left audience empty ⇒ one follow-up round found the followers page.
    expect(r.followUp.ran).toBe(true);
    expect(r.followUp.dimensions).toContain("audience_scale");
    expect(r.rounds).toHaveLength(2);
    expect(r.facts.map((f) => f.claim)).toContain("Riley Example has 12,000 Instagram followers.");
    expect(calls.map((c) => c.step)).toEqual(["extract", "verify", "extract2", "verify2"]);
    expect(r.costMicroUsd.total).toBe(r.costMicroUsd.search + r.costMicroUsd.extract + r.costMicroUsd.verify);
    expect(r.costMicroUsd.extract).toBe(200_000);
  });

  test("the follow-up round respects its cost cap", async () => {
    const { call, calls } = fakeCall();
    const discoverQuery = async () => ({ results: [{ url: "https://news.example.com/deal", title: "deal" }], costMicroUsd: 10_000, searchQueries: 1 });
    const r = await runLeanResearch({ athlete: ATHLETE, known: [], today: TODAY }, { call, discoverQuery, wikidataGet: wikidata, fetchImpl, followUpMaxMicroUsd: 1 });
    expect(r.followUp.ran).toBe(false);
    expect(r.followUp.reason).toMatch(/follow-up cap/);
    expect(calls.map((c) => c.step)).toEqual(["extract", "verify"]);
  });

  test("L5 identity not confirmed: no fact kept, no verify call, the reason kept", async () => {
    const { call, calls } = fakeCall({ resolved: false });
    const r = await runLeanResearch({ athlete: ATHLETE, known: [], today: TODAY }, { call, discoverQuery: null, wikidataGet: wikidata, fetchImpl });
    expect(r.outcome).toBe("unconfirmed");
    expect(r.unconfirmedReason).toBe("Two soccer players share this name.");
    expect(r.facts).toEqual([]);
    expect(r.withheld).toBeGreaterThan(0);
    expect(calls.map((c) => c.step)).toEqual(["extract"]);
    expect(r.followUp.ran).toBe(false);
  });

  test("L5 nothing names the athlete: no model call at all; dry run: no model call and no search", async () => {
    const { call, calls } = fakeCall();
    const none: WikidataGet = async (p) => (p.action === "wbsearchentities" ? { search: [] } : { entities: {} });
    const r = await runLeanResearch({ athlete: ATHLETE, known: [], today: TODAY }, { call, discoverQuery: null, wikidataGet: none, fetchImpl });
    expect(r.outcome).toBe("unconfirmed");
    expect(r.unconfirmedReason).toMatch(/No page we could read named this athlete/);
    expect(calls).toHaveLength(0);
    const search = jest.fn();
    const dry = await runLeanResearch({ athlete: ATHLETE, known: [], today: TODAY }, { call, discoverQuery: search as any, wikidataGet: wikidata, fetchImpl, dryRun: true });
    expect(search).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(dry.rounds[0].passages.length).toBeGreaterThan(0);
    expect(dry.unconfirmedReason).toMatch(/dry run/);
  });
});

// ── L6 de-dup ───────────────────────────────────────────────────────────────

const held = (id: string, claimText: string, o: Partial<MemoryFact> = {}): MemoryFact => ({
  id, athleteId: "a1", subject: { kind: "athlete", name: "Riley Example" }, claim: claimText, type: "found", source: { url: "https://team.example.edu/riley" },
  date: "2025-01-01", confidence: 0.9, status: "active", supersededBy: null, runId: null, createdAt: "2026-01-01T00:00:00Z", ...o,
}) as MemoryFact;

describe("L6 de-duplication and conflicts", () => {
  test("pure helpers: numbers and folded claims", () => {
    expect(numbersOf("Scored 1,234 points and 4.5% in 2025")).toEqual(["1234", "2025", "4.5"]);
    expect(normClaim("Riley  Example, scored 7 goals.")).toBe(normClaim("riley example scored 7 goals"));
    expect(relation({ claim: "a b c 7", date: "2025-01-01", url: "x", subject: "s" }, { claim: "a b c 7", date: "2025-01-01", url: "x", subject: "t" })).toBeNull();
  });
  test("same claim + source → one (the one held); same numbers + date in other words → one; within the batch → one", () => {
    const existing = [held("h1", "Riley Example scored 7 goals in 2025.")];
    const plan = planFactWrites(existing, [
      pf("Riley Example scored 7 goals in 2025.", "https://team.example.edu/riley", "2025"),
      pf("In 2025 Riley Example scored 7 goals for the team.", "https://news.example.com/x", "2025"),
      pf("Riley Example signed with Example Brand.", "https://news.example.com/deal", "2026", { topic: "sponsor" }),
      pf("Riley Example signed with Example Brand.", "https://news.example.com/deal2", "2026", { topic: "sponsor" }),
    ], ATHLETE, "r1");
    expect(plan.duplicates.map((d) => d.of)).toEqual(["h1", "h1", "batch:0"]);
    expect(plan.writes.map((w) => w.fact.claim)).toEqual(["Riley Example signed with Example Brand."]);
    expect(plan.writes[0].fact).toMatchObject({ type: "found", status: "active", topic: "sponsor", source: { url: "https://news.example.com/deal" }, date: "2026-01-01", datePrecision: "year", runId: "r1" });
  });
  test("a newer reading of the same claim (another date) is history: written beside the old one, not a conflict", () => {
    const plan = planFactWrites([held("h1", "Riley Example scored 7 goals in the season.", { date: "2024-01-01" })], [pf("Riley Example scored 9 goals in the season.", "https://team.example.edu/riley", "2025")], ATHLETE, null);
    expect(plan.conflicts).toBe(0);
    expect(plan.writes[0].fact.status).toBe("active");
  });
  test("a genuine conflict (same words and date, different numbers) is disputed both ways, as the merge does; what she said stays hers", () => {
    const found = held("h1", "Riley Example scored 7 goals in 2025.");
    const plan = planFactWrites([found], [pf("Riley Example scored 9 goals in 2025.", "https://news.example.com/x", "2025")], ATHLETE, null);
    expect(plan.conflicts).toBe(1);
    expect(plan.writes[0]).toMatchObject({ conflictsWith: { id: "h1" }, fact: { status: "disputed", disputes: "h1" } });
    const said = held("s1", "Riley Example scored 7 goals in 2025.", { type: "said", source: { ref: "onboarding/x#goals" } as any });
    expect(planFactWrites([said], [pf("Riley Example scored 9 goals in 2025.", "https://news.example.com/x", "2025")], ATHLETE, null).writes[0].conflictsWith?.id).toBe("s1");
  });
  // Real lines from the 26 Oct shadow runs (Caitlin Clark: 21 of 94 facts would have been disputed; Moh Bility: 13 of
  // 82) — every one a different metric, game or field of the same source, none a conflict.
  const pair = (a: string, b: string, date: string | null, url = "https://www.wnba.com/player/caitlin-clark") =>
    planFactWrites([], [pf(a, url, date), pf(b, url, date)], ATHLETE, null);
  test.each([
    ["The WNBA reports that Caitlin Clark averaged 22.3 points per game in 2026.", "The WNBA reports that Caitlin Clark averaged 4.0 rebounds per game in 2026.", "2026"],
    ["The WNBA reports that Caitlin Clark shot 44.5% from the field in 2026.", "The WNBA reports that Caitlin Clark shot 85.2% from the free-throw line in 2026.", "2026"],
    ["Basketball Reference reports that Caitlin Clark scored 891 regular-season points in 2026.", "Basketball Reference reports that Caitlin Clark recorded 333 regular-season assists in 2026.", "2026"],
    ["The WNBA reports that Caitlin Clark set the rookie three-pointers record with 122 in 2024.", "The WNBA reports that Caitlin Clark set the rookie double-doubles record with 12 in 2024.", "2024"],
    ["The WNBA reports that Caitlin Clark set its single-season assists record with 337 in 2024.", "The WNBA reports that Caitlin Clark set its All-Star Game rookie assists record with 10 in 2024.", "2024"],
    ["Caitlin Clark won Big Ten Player of the Year in 2022, 2023 and 2024.", "Caitlin Clark won Big Ten Female Athlete of the Year in 2023 and 2024.", "2024"],
    ["The WNBA lists Caitlin Clark's height as 6-0.", "The WNBA lists Caitlin Clark's weight as 157 lbs.", null],
    ["On3 reports 2 total tackles for Moh Bility in 2025.", "On3 reports 0 assisted tackles for Moh Bility in 2025.", "2025"],
    ["Ourlads reports 2 solo tackles for Moh Bility against Prairie View A&M on September 13, 2025.", "Ourlads reports 1 pass defended for Moh Bility against Prairie View A&M on September 13, 2025.", "2025-09-13"],
    ["North Texas reports that Moh Bility recorded 21 tackles in 2020.", "North Texas reports that Moh Bility recorded three interceptions in 2020.", "2020"],
  ])("different metrics, fields or games are separate facts, not a conflict: %s / %s", (a, b, date) => {
    const plan = pair(a, b, date);
    expect(plan.conflicts).toBe(0);
    expect(plan.writes.map((w) => w.fact.status)).toEqual(["active", "active"]);
  });
  test("a different season, game or event is a separate fact, even with the same fact date", () => {
    expect(pair("Riley Example averaged 18.2 points per game in the 2023-24 season.", "Riley Example averaged 21.0 points per game in the 2024-25 season.", "2025").conflicts).toBe(0);
    expect(pair("Riley Example scored 30 points in Game 3 of the 2025 Finals.", "Riley Example scored 24 points in Game 4 of the 2025 Finals.", "2025").conflicts).toBe(0);
    expect(pair("Riley Example scored 30 points against Iowa on March 3, 2025.", "Riley Example scored 24 points against Iowa on March 9, 2025.", "2025").conflicts).toBe(0);
    // A game claim with only a year-precise date cannot be pinned to one game: two games against one opponent in a season.
    expect(pair("Riley Example scored 30 points against Iowa.", "Riley Example scored 24 points against Iowa.", "2025").conflicts).toBe(0);
  });
  test("the same metric, period and time from two outlets with different values IS a conflict (outlet and reporting words set aside)", () => {
    const plan = planFactWrites([], [
      pf("On3 reports Riley Example recorded 21 tackles in 2020.", "https://www.on3.com/db/riley", "2020"),
      pf("ESPN says Riley Example had 24 tackles in 2020.", "https://www.espn.com/riley", "2020"),
    ], ATHLETE, null);
    expect(plan.conflicts).toBe(1);
    expect(pair("Riley Example scored 30 points against Iowa on March 3, 2025.", "Riley Example scored 28 points against Iowa on March 3, 2025.", "2025-03-03").conflicts).toBe(1);
  });
  test("undated claims conflict only from the same source (two outlets at unknown times are two readings, not a conflict)", () => {
    expect(pair("Riley Example's height is 6-2.", "Riley Example's height is 6-1.", null, "https://a.example.com/r").conflicts).toBe(1);
    const plan = planFactWrites([], [pf("Riley Example's height is 6-2.", "https://a.example.com/r", null), pf("Riley Example's height is 6-1.", "https://b.example.com/r", null)], ATHLETE, null);
    expect(plan.conflicts).toBe(0);
  });
  test("claimShape: values, periods and what is measured", () => {
    expect(claimShape("On3 reports 2 total tackles for Moh Bility in 2025.")).toEqual({ what: ["bility", "moh", "on3", "tackles", "total"], periods: ["2025"], values: ["2"] });
    expect(claimShape("Riley Example scored 1,999 points in the 2023-24 season.").periods).toEqual(["2023", "24"]);
    expect(claimShape("Riley Example scored 1,999 points in the 2023-24 season.").values).toEqual(["1999"]);
    expect(claimShape("She recorded three interceptions on March 3.").values).toEqual(["3"]);
    expect(claimShape("She recorded three interceptions on March 3.").periods).toEqual(["3"]);
  });
  test("two facts of one batch that conflict are both written disputed", () => {
    const plan = planFactWrites([], [pf("Riley Example scored 7 goals in 2025.", "https://a.example.com/1", "2025"), pf("Riley Example scored 9 goals in 2025.", "https://b.example.com/2", "2025")], ATHLETE, null);
    expect(plan.writes.map((w) => w.fact.status)).toEqual(["disputed", "disputed"]);
    expect(plan.writes[1].conflictsWithBatch).toBe(0);
  });
});

// ── L7 balanced selection ───────────────────────────────────────────────────

const prev = (i: number, topic: string, confidence = 0.9, observedOn = `2025-01-${String((i % 28) + 1).padStart(2, "0")}`): PreviewFact => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, type: "found", status: "active", claim: `Riley Example fact ${i}.`, subjectKind: "athlete", subjectName: "Riley Example",
  sourceUrl: "https://x.example.com", sourceRef: null, sourceTitle: null, observedOn, confidence, sensitive: false, careKind: null, disputes: null, createdAt: "2026-01-01T00:00:00Z", topic,
});

describe("L7 topic-balanced selection into the scorer's cap", () => {
  const facts = [...Array.from({ length: 70 }, (_, i) => prev(i, "achievement", 0.95)), ...Array.from({ length: 5 }, (_, i) => prev(100 + i, "sponsor", 0.8)), ...Array.from({ length: 5 }, (_, i) => prev(200 + i, "social", 0.7))];
  test("the default fills the cap by confidence (unchanged); balanced keeps every topic's facts", () => {
    const def = selectFactsOnlyInput(facts, "Riley Example").public;
    expect(def).toHaveLength(60);
    expect(def.every((f) => f.topic === "achievement")).toBe(true);
    const bal = selectFactsOnlyInput(facts, "Riley Example", { balanced: true }).public;
    expect(bal).toHaveLength(60);
    expect(bal.filter((f) => f.topic === "sponsor")).toHaveLength(5);
    expect(bal.filter((f) => f.topic === "social")).toHaveLength(5);
  });
  test("under the cap nothing is cut; within a topic the newest comes first", () => {
    expect(balancedByTopic(facts.slice(0, 10), 60)).toHaveLength(10);
    const picked = balancedByTopic([prev(1, "stats", 0.9, "2024-01-01"), prev(2, "stats", 0.9, "2026-01-01"), prev(3, "media", 0.5)], 2);
    expect(picked.map((f) => f.observedOn)).toContain("2026-01-01");
    expect(picked.some((f) => f.topic === "media")).toBe(true);
  });
});

// ── L8 Wikidata ─────────────────────────────────────────────────────────────

describe("L8 wikidata (free discovery)", () => {
  test("entityOf keeps preferred claims first, drops deprecated ones, builds the Wikipedia URL", () => {
    const e = entityOf("Q1", { labels: { en: { value: "Riley Example" } }, sitelinks: { enwiki: { title: "Riley Example" } }, claims: { P54: [claim("Q10"), claim("Q11", "preferred"), claim("Q12", "deprecated")] } });
    expect(e.claims.P54).toEqual(["Q11", "Q10"]);
    expect(e.enwiki).toBe("https://en.wikipedia.org/wiki/Riley_Example");
  });
  test("a hit counts only in the athlete's sport; identifier URLs from the property's formatter", () => {
    expect(matchesSport(entityOf("Q1", { descriptions: { en: { value: "researcher" } } }), [], "soccer")).toBe(false);
    expect(matchesSport(entityOf("Q1", {}), ["association football player"], "soccer")).toBe(true);
    expect(identifierUrl(["https://web.archive.org/web/*/x/$1", "https://stats.example.org/p/$1/"], "ab 12")).toBe("https://stats.example.org/p/ab%2012/");
  });
  test("seeds from the kept hit only; roster then the athlete's link", async () => {
    const r = await wikidataSeeds({ name: "Riley Example", sport: "soccer" }, wikidata);
    expect(r.seeds.map((s) => s.url)).toEqual(["https://rileyexample.example.com/"]);
    const team = { url: "https://team.example/sports/soccer", links: [{ url: "https://team.example/sports/soccer/roster", text: "Roster" }, { url: "https://team.example/tickets", text: "Tickets" }] };
    expect(pickRosterLinks(team, "soccer")).toEqual(["https://team.example/sports/soccer/roster"]);
    const roster = { url: "https://team.example/sports/soccer/roster", links: [{ url: "https://team.example/sports/soccer/roster/riley-example/12", text: "Riley Example" }, { url: "https://team.example/sports/soccer/roster/sam-other/13", text: "Sam Other" }] };
    expect(pickAthleteLinks(roster, "Riley Example")).toEqual(["https://team.example/sports/soccer/roster/riley-example/12"]);
  });
});

describe("spend guards: LEAN_RESEARCH_FOLLOWUP_MAX_USD", () => {
  it("is clamped to 2 USD, fails closed to 0.40 on a non-number, and 0 still switches the round off", () => {
    expect(LEAN.followUpMaxMicroUsd({ LEAN_RESEARCH_FOLLOWUP_MAX_USD: "1e9" } as any)).toBe(2_000_000);
    expect(LEAN.followUpMaxMicroUsd({ LEAN_RESEARCH_FOLLOWUP_MAX_USD: "abc" } as any)).toBe(400_000);
    expect(LEAN.followUpMaxMicroUsd({ LEAN_RESEARCH_FOLLOWUP_MAX_USD: "0" } as any)).toBe(0);
  });
});

// ── L-cap: the platform day cap mid-research (the step is then HELD by the runner; its spend must still be recorded) ──

describe("L-cap: platform day cap refusals inside lean research", () => {
  const { PlatformCapError, isPlatformCapError } = jest.requireActual("../../../lib/platformSpend") as typeof import("../../../lib/platformSpend");
  const okSearch = { results: [{ url: "https://news.example.com/deal", title: "deal" }], costMicroUsd: 10_000, searchQueries: 1, searchFeeMicroUsd: 10_000 };

  test("a search cut short by the cap: its spent part is reported (complete false) and the refusal reaches the caller", async () => {
    let n = 0;
    const discoverQuery = jest.fn(async () => { n++; if (n === 1) throw new PlatformCapError(30e6, 25e6); return okSearch; });
    const spends: any[] = [];
    const { call, calls } = fakeCall();
    const err = await runLeanResearch({ athlete: ATHLETE, known: [], today: TODAY }, { call, discoverQuery, wikidataGet: wikidata, fetchImpl, onSearchSpend: async (s) => { spends.push(s); } })
      .then(() => null, (e) => e);
    expect(isPlatformCapError(err)).toBe(true);
    expect(calls).toHaveLength(0);                                         // nothing extracted from a cut-short search
    expect(spends).toEqual([expect.objectContaining({ round: 1, complete: false, costMicroUsd: (discoverQuery.mock.calls.length - 1) * 10_000 })]);
  });

  test("the extract refused after a paid search: the search spend is reported BEFORE the refusal", async () => {
    const discoverQuery = jest.fn(async () => okSearch);
    const order: string[] = [];
    const call: LeanModelCall = async () => { order.push("extract"); throw new PlatformCapError(30e6, 25e6); };
    const err = await runLeanResearch({ athlete: ATHLETE, known: [], today: TODAY }, { call, discoverQuery, wikidataGet: wikidata, fetchImpl, onSearchSpend: async (s) => { order.push(`spend:${s.round}:${s.complete}:${s.costMicroUsd}`); } })
      .then(() => null, (e) => e);
    expect(isPlatformCapError(err)).toBe(true);
    expect(order).toEqual([`spend:1:true:${discoverQuery.mock.calls.length * 10_000}`, "extract"]);
  });
});
