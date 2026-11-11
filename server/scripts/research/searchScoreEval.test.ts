/**
 * searchScoreEval — every provider is mocked (owner rule: tests never reach providers). Checks that each setup sends the
 * existing M.I.A. text verbatim, scores with the orchestrator's own functions, runs the DeepSeek tool loop with only our
 * free tools (search_web only when the backend is on), counts cost at the list prices, and that the grader and summary read
 * what the runs produced.
 */
// Pure code under test; the modules it imports open no connection unless called (the harness reads the DB only in the CLI).
jest.mock("../../db", () => ({ db: {} }));
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../../services/marketabilityBeta1FrozenParams";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1 } from "../../services/marketabilityBeta1Lookups";
import { createBeta1Normalizer } from "../../services/marketabilityBeta1Normalization";
import type { Beta1PriorScope } from "../../services/marketabilityBeta1Freeze";
import type { NormalizedSignal } from "../../services/intelligence/types";
import { promptFor } from "../../services/marketabilityBeta1Snapshot";
import { FACTS_HEADING } from "../../services/miaPreview/factsOnlySpec";
import {
  DEEPSEEK_MODEL, GEMINI_MODEL, GRADER_MODEL, MAX_TOOL_CALLS, PRICES, SAID_HEADING, costUsd, estimateRunUsd, factsBlockFor, frozenPrompt,
  grade, gradeRationales, groundingSupported, runDeepSeekLoop, runGeminiOneCall, runQuickEvidence, scoreFactsOnly, summarise, zeroUsage,
  type AthleteCase, type Providers, type ScoringContext, type SetupRun,
} from "./searchScoreEval.lib";

const params = MARKETABILITY_BETA1_FROZEN_PARAMS;
const normalizer = createBeta1Normalizer({ cohorts: BETA1_COHORTS_V0, priors: BETA1_PRIORS_V1, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0, freshnessDays: { connected_verified: 2, platform_public: 7, web_researched: 30, inferred: 30, imputed: 3650 } });
const ctx: ScoringContext = { params, subWeights: params.config.subWeights, prior: (p: string, s: Beta1PriorScope) => normalizer.prior(p as never, s as never) as NormalizedSignal };
const ASOF = "2026-10-26T00:00:00.000Z";

const athlete: AthleteCase = {
  id: "00000000-0000-4000-8000-000000000001", name: "Test Athlete", sport: "soccer", said: ["Plays for Example University"],
  accounts: [], socialBlock: null, reference: { score: 600, anchor: ["Plays for Example University"] },
};

/** A complete evaluator answer: every sub-signal scored 60, citing `cite`. */
function evaluatorJson(cite: string[], extra: Record<string, unknown> = {}): string {
  const dimensions: Record<string, Record<string, unknown>> = {};
  for (const [d, sub] of Object.entries(params.config.subWeights)) {
    dimensions[d] = Object.fromEntries(Object.keys(sub).map((k) => [k, { status: "scored", score: 60, confidence: "MEDIUM", evidence_ids: cite, rationale: "r" }]));
  }
  return "```json\n" + JSON.stringify({ athlete: { identity_confidence: "HIGH" }, dimensions, evidence: [{ id: "E1", claim: "Scored 10 goals in 2025", source_url: "https://example.edu/roster/test-athlete" }], ...extra }) + "\n```";
}

const usage = (input: number, output: number, searches = 0) => ({ ...zeroUsage(), input, output, searches });

function mockProviders(over: Partial<Providers> = {}): Providers & { calls: any[] } {
  const calls: any[] = [];
  const p: Providers & { calls: any[] } = {
    calls,
    gemini: async (req) => {
      calls.push({ kind: "gemini", req });
      if (req.system) {   // the quick evidence pass
        return { text: "```json\n" + JSON.stringify({ identity: { resolved: true, description: "Test Athlete, Example University soccer", ambiguity: "" }, facts: [
          { subject_kind: "athlete", subject_name: "Test Athlete", claim: "Test Athlete scored 10 goals in 2025", topic: "career", source_url: "https://example.edu/roster/test-athlete", source_title: "Roster", source_type: "official", date: "2025-12-01", confidence: 0.9, sensitivity: "public", care_kind: "none", never_reason: "none" },
          { subject_kind: "athlete", subject_name: "Test Athlete", claim: "Test Athlete is recovering from a knee injury", topic: "status", source_url: "https://news.example.com/a", source_title: "News", source_type: "local", date: "2026-09-01", confidence: 0.8, sensitivity: "care", care_kind: "personal", never_reason: "none" },
        ] }) + "\n```", usage: usage(5_000, 2_000, 4), ms: 1000, native: { chunks: [{ uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x", title: "example.edu" }], supports: [{ text: "Test Athlete scored 10 goals in 2025 for Example University.", chunks: [0] }], queries: ["q1", "q2", "q3", "q4"] } };
      }
      if (req.search) return { text: evaluatorJson(["E1"]), usage: usage(30_000, 9_000, 5), ms: 2000, native: { chunks: [], supports: [{ text: "Scored 10 goals in 2025", chunks: [0] }], queries: [] } };
      const id = /\[(F\d+|[0-9a-f-]{36})\]/.exec(req.user)?.[1] ?? "none";
      return { text: evaluatorJson([id]), usage: usage(20_000, 7_000), ms: 1500, native: { chunks: [], supports: [], queries: [] } };
    },
    vertexChat: async (req) => {
      calls.push({ kind: "chat", req });
      if (req.model === GRADER_MODEL) return { message: { content: JSON.stringify({ wrong_person: false, facts: [{ n: 1, support: "supported", contradicts_record: false }], problem: "none" }) }, usage: usage(3_000, 300), ms: 500 };
      const toolTurns = req.messages.filter((m) => m.role === "tool").length;
      if (req.messages[0].role === "system" && req.tools && toolTurns === 0) {
        return { message: { content: null, tool_calls: [
          { id: "t1", function: { name: "wikidata_lookup", arguments: JSON.stringify({ query: "Test Athlete" }) } },
          { id: "t2", function: { name: "fetch_page", arguments: JSON.stringify({ url: "https://example.edu/roster/test-athlete" }) } },
        ] }, usage: usage(25_000, 500), ms: 800 };
      }
      const id = /\[(F\d+|[0-9a-f-]{36})\]/.exec(String(req.messages[req.messages.length - 1].content))?.[1];
      return { message: { content: evaluatorJson(id ? [id] : ["E1"]) }, usage: usage(30_000, 12_000), ms: 3000 };
    },
    fetchPages: async (urls) => urls.map((url) => ({ url, title: "Roster", text: "Test Athlete scored 10 goals in 2025 for Example University soccer.", skipped: null })),
    wikidata: async () => [{ id: "Q1", label: "Test Athlete", description: "soccer player", officialWebsite: null, enwiki: null, facts: ["sport: association football"] }],
    ...over,
  };
  return p;
}

describe("searchScoreEval — setups", () => {
  it("setup 1 sends the frozen M.I.A. prompt verbatim (plus the said block) with Google Search, and scores it", async () => {
    const p = mockProviders();
    const r = await runGeminiOneCall(p, athlete, ctx, 1, ASOF);
    const req = p.calls[0].req;
    expect(req.model).toBe(GEMINI_MODEL);
    expect(req.search).toBe(true);
    expect(req.thinkingLevel).toBe("low");
    expect(req.user).toBe(frozenPrompt(athlete));
    expect(req.user.startsWith(promptFor({ name: athlete.name, sport: athlete.sport, socialBlock: null }).split("ATHLETE TO EVALUATE")[0])).toBe(true);
    expect(req.user).toContain(SAID_HEADING);
    expect(r.error).toBeNull();
    expect(r.result!.score).toBeGreaterThanOrEqual(200);
    expect(r.result!.score).toBeLessThanOrEqual(850);
    // 30k in + 9k out at Gemini 3.8 Flash list + 5 grounded queries.
    expect(r.steps[0].costUsd).toBeCloseTo(0.03 * 1.5 + 0.009 * 7.5 + 5 * PRICES.groundingPerQuery, 6);
  });

  it("setup 2 runs DeepSeek with thinking on, only Wikidata + our fetcher, and keeps the fetched pages for grading", async () => {
    const p = mockProviders();
    const r = await runDeepSeekLoop(p, athlete, ctx, 1, ASOF);
    const first = p.calls.find((c) => c.kind === "chat").req;
    expect(first.model).toBe(DEEPSEEK_MODEL);
    expect(first.thinking).toBe(true);
    expect(first.tools.map((t: any) => t.function.name)).toEqual(["wikidata_lookup", "fetch_page"]);
    expect(first.messages[1].content).toBe(frozenPrompt(athlete));
    expect(r.steps[0].usage.toolCalls).toBe(2);
    expect(r.pages).toHaveLength(1);
    expect(r.error).toBeNull();
    expect(r.result).not.toBeNull();
  });

  it("setup 2 offers search_web only when the DeepSeek Search backend is on", async () => {
    const p = mockProviders({ deepseekSearch: async () => [] });
    await runDeepSeekLoop(p, athlete, ctx, 1, ASOF);
    const first = p.calls.find((c) => c.kind === "chat").req;
    expect(first.tools.map((t: any) => t.function.name)).toEqual(["wikidata_lookup", "fetch_page", "search_web"]);
    expect(first.messages[0].content).toContain("search_web(query)");
  });

  it("setup 2 stops offering tools after the call budget and takes the final answer", async () => {
    let n = 0;
    const p = mockProviders({
      vertexChat: async (req) => {
        n++;
        if (req.tools) return { message: { content: null, tool_calls: [{ id: `t${n}`, function: { name: "wikidata_lookup", arguments: "{}" } }] }, usage: usage(1_000, 100), ms: 1 };
        return { message: { content: evaluatorJson(["E1"]) }, usage: usage(1_000, 100), ms: 1 };
      },
    });
    const r = await runDeepSeekLoop(p, athlete, ctx, 1, ASOF);
    expect(r.steps[0].usage.toolCalls).toBe(MAX_TOOL_CALLS);
    expect(r.result).not.toBeNull();
  });

  it("setup 3: the quick pass uses the research skill as system text; the facts-only scorer gets the existing prompt and enforcement", async () => {
    const p = mockProviders();
    const q = await runQuickEvidence(p, athlete, "SKILL TEXT", { type: "object" }, { a: "angle a", b: "angle b" }, "2026-10-26");
    expect(p.calls[0].req.system).toBe("SKILL TEXT");
    expect(p.calls[0].req.search).toBe(true);
    expect(q.ev.identity.resolved).toBe(true);
    expect(q.ev.facts).toHaveLength(2);
    expect(q.ev.facts[1].sensitive).toBe(true);   // the injury is kept as a care fact (momentum), not dropped
    const { block, sources } = factsBlockFor(athlete, q.ev.facts);
    expect(block.startsWith(FACTS_HEADING)).toBe(true);
    for (const scorer of ["gemini-3.8-flash", "deepseek-v4.1-flash"] as const) {
      const s = await scoreFactsOnly(p, athlete, block, sources, scorer, ctx, ASOF);
      expect(s.error).toBeNull();
      expect(s.result!.score).toBeGreaterThanOrEqual(200);
    }
    const ds = p.calls.filter((c) => c.kind === "chat").pop().req;
    expect(ds.model).toBe(DEEPSEEK_MODEL);
    expect(ds.thinking).toBe(true);
    expect(ds.tools).toBeUndefined();
  });
});

describe("searchScoreEval — Part A scorer head-to-head", () => {
  it("retries a parse failure once (as prod's bounded retry), sums both calls, and reports enforcement", async () => {
    let n = 0;
    const p = mockProviders({ gemini: async () => ({ text: ++n === 1 ? "not json" : evaluatorJson(["platform:instagram"]), usage: usage(10_000, 1_000), ms: 100, native: { chunks: [], supports: [], queries: [] } }) });
    const s = await scoreFactsOnly(p, athlete, "FACTS NOMILA HOLDS\n- (none)", [], "gemini-3.8-flash", ctx, ASOF);
    expect(s.attempts).toBe(2);
    expect(s.parseFailures).toBe(1);
    expect(s.step.usage.input).toBe(20_000);
    // Every signal cited an id that was never supplied → enforcement demotes them all → no score.
    expect(s.enforcement!.demoted).toBeGreaterThan(0);
    expect(s.result).toBeNull();
  });

  it("the rationale grader numbers the scored rationales and keeps only valid unsupported entries", async () => {
    const p = mockProviders({ vertexChat: async () => ({ message: { content: JSON.stringify({ unsupported: [{ n: 1, claim: "x" }, { n: 9999, claim: "out of range" }] }) }, usage: usage(5_000, 100), ms: 10 }) });
    const out = { judgements: [{ dimension: "d", key: "k", status: "scored", score: 50, confidence: "HIGH", evidenceIds: [], rationale: "Scored 10 goals", present: true }], keyStrengths: ["strong story"], keyConstraints: [], summary: null } as any;
    const g = await gradeRationales(p, athlete, "FACTS", out);
    expect(g.statements).toBe(2);
    expect(g.unsupported).toEqual([{ n: 1, claim: "x" }]);
  });
});

describe("searchScoreEval — grading, cost, summary", () => {
  it("the grader is GLM-5.2 (a third family) and sees the fetched page text for the tool setup", async () => {
    const p = mockProviders();
    const r = await runDeepSeekLoop(p, athlete, ctx, 1, ASOF);
    const g = await grade(p, athlete, r);
    const req = p.calls.filter((c) => c.kind === "chat").pop().req;
    expect(req.model).toBe(GRADER_MODEL);
    expect(req.messages[1].content).toContain("Test Athlete scored 10 goals in 2025 for Example University soccer.");
    expect(g.wrongPerson).toBe(false);
    expect(g.supported).toBe(1);
  });

  it("grounded facts are matched to Google's own support segments, never fetched", () => {
    expect(groundingSupported("Test Athlete scored 10 goals in 2025", ["Test Athlete scored 10 goals in 2025 for Example University."])).toBe(true);
    expect(groundingSupported("Signed with a shoe brand", ["Test Athlete scored 10 goals in 2025."])).toBe(false);
  });

  it("costs thinking tokens as output and cached input at the cached rate", () => {
    const u = { ...zeroUsage(), input: 1_000_000, cached: 500_000, output: 100_000, thinking: 100_000 };
    expect(costUsd(DEEPSEEK_MODEL, u)).toBeCloseTo(0.5 * 0.3 + 0.5 * 0.03 + 0.2 * 1.2, 6);
  });

  it("summarises delta vs the stored score and run-to-run spread", () => {
    const mk = (run: number, score: number): SetupRun => ({ setup: "x", athlete: athlete.name, run, identity: { resolved: true, description: "", confidence: null }, result: { score, composite: 0, confidence: 0, scored: 44, missing: 0, identityConfidence: null }, error: null, facts: [], steps: [{ name: "s", model: GEMINI_MODEL, ms: 1000, usage: zeroUsage(), costUsd: 0.1 }] });
    const [s] = summarise([mk(1, 620), mk(2, 580)], [athlete]);
    expect(s.meanAbsDelta).toBe(20);
    expect(s.meanSpread).toBe(40);
    expect(s.meanCostUsd).toBeCloseTo(0.1);
  });

  it("the dry-run estimate is positive and scales with athletes × runs", () => {
    const one = estimateRunUsd({ frozen: 12_000, factsOnly: 12_000, skill: 6_000 }, 1, 1).total;
    expect(one).toBeGreaterThan(0);
    expect(estimateRunUsd({ frozen: 12_000, factsOnly: 12_000, skill: 6_000 }, 5, 2).total).toBeCloseTo(one * 10, 6);
  });
});
