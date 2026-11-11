/**
 * models.test.ts — model-per-skill in one place (tier → model, per-skill override, env), and usage → cost (cached input
 * at the cached rate, reasoning inside output, web searches per call, unknown models never priced at zero).
 */
jest.mock("../db", () => ({ db: {} }));

import { AGENT_MODELS, addCost, costOf, modelFor, priceOf, PRICES_VERIFIED_ON, providerOf, ZERO_COST } from "./models";
import { GEMINI } from "../lib/models";
import { DEFAULT_COST_MODEL } from "../services/intelligence/research/policy";
import { loadJob } from "./jobs";

const KEYS = ["OPENAI_AGENT_MODEL", "OPENAI_AGENT_FAST_MODEL", "AGENT_CHEAP_MODEL", "AGENT_SKILL_MODELS", "AGENT_MODEL_PRICES", "AGENT_WEB_SEARCH_PRICE_USD"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("defaults (10 Oct 2026 provider rule)", () => {
  it("reasoning is gpt-6.1-sol and fast is gpt-6-luna (OpenAI); cheap is Gemini Flash; each tier has a listed price", () => {
    expect({ reasoning: AGENT_MODELS.reasoning, fast: AGENT_MODELS.fast, cheap: AGENT_MODELS.cheap })
      .toEqual({ reasoning: "gpt-6.1-sol", fast: "gpt-6-luna", cheap: GEMINI.flash });
    expect(priceOf(AGENT_MODELS.reasoning)).toMatchObject({ inputPerMTok: 2, cachedInputPerMTok: 0.1, outputPerMTok: 10 });
    expect(priceOf(AGENT_MODELS.fast)).toMatchObject({ inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.5 });
    expect(priceOf(AGENT_MODELS.cheap)).toMatchObject({ inputPerMTok: 1.5, cachedInputPerMTok: 0.15, outputPerMTok: 9 });
  });

  it("the provider follows the model id", () => {
    expect([providerOf("gemini-3.5-flash"), providerOf("gpt-6-luna"), providerOf("anything-else")]).toEqual(["gemini", "openai", "openai"]);
  });
});

describe("modelFor", () => {
  it("resolves reasoning and fast on OpenAI and cheap on Gemini, with the skill's effort", () => {
    expect(modelFor({ id: "x/y", model: "reasoning", effort: "high" })).toEqual({ provider: "openai", model: AGENT_MODELS.reasoning, effort: "high" });
    expect(modelFor({ id: "x/y", model: "fast", effort: "low" })).toEqual({ provider: "openai", model: AGENT_MODELS.fast, effort: "low" });
    expect(modelFor({ id: "x/y", model: "cheap", effort: "minimal" })).toEqual({ provider: "gemini", model: GEMINI.flash, effort: "minimal" });
  });

  it("the cheap tier goes back to OpenAI with one env var; one skill can move to Gemini alone", () => {
    process.env.AGENT_CHEAP_MODEL = "gpt-6-luna";
    expect(modelFor({ id: "x/y", model: "cheap", effort: "low" })).toEqual({ provider: "openai", model: "gpt-6-luna", effort: "low" });
    process.env.AGENT_SKILL_MODELS = JSON.stringify({ "x/tagger": { model: "gemini-3.5-flash-lite" } });
    expect(modelFor({ id: "x/tagger", model: "fast", effort: "low" })).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite", effort: "low" });
  });

  it("a skill that searches can never resolve to Gemini", () => {
    process.env.AGENT_SKILL_MODELS = JSON.stringify({ "x/search": { model: "gemini-3.5-flash" } });
    expect(() => modelFor({ id: "x/search", model: "reasoning", effort: "high", tools: ["web_search"] })).toThrow(/stays on OpenAI/);
    expect(() => modelFor({ id: "x/s2", model: "cheap", effort: "low", tools: ["web_search"] })).toThrow(/stays on OpenAI/);
  });

  it("the real skills: only the routine atmosphere and post-kit skills are on Gemini; research, merge, understand, plan, onboarding, moments stay on OpenAI", () => {
    const onGemini = ["atmosphere/queries", "atmosphere/check", "post-kit/match", "post-kit/ideas"];
    const onOpenAI = ["research", "research/merge", "understand", "plan", "plan/ready", "onboarding", "moments", "echo/health"];
    for (const id of onGemini) expect([id, modelFor(loadJob(id)).provider]).toEqual([id, "gemini"]);
    for (const id of onOpenAI) expect([id, modelFor(loadJob(id)).provider]).toEqual([id, "openai"]);
  });

  it("the weekly moments scan sits on the fast tier (gpt-6-luna) and can never be moved to Gemini: it searches", () => {
    expect(modelFor(loadJob("moments"))).toEqual({ provider: "openai", model: "gpt-6-luna", effort: "medium" });
    process.env.AGENT_SKILL_MODELS = JSON.stringify({ moments: { model: "gemini-3.5-flash" } });
    expect(() => modelFor(loadJob("moments"))).toThrow(/moments uses web_search, which stays on OpenAI/);
    // Why the fast tier and not the cheap one: cheap is Gemini Flash, which can never carry web search.
    delete process.env.AGENT_SKILL_MODELS;
    expect(() => modelFor({ ...loadJob("moments"), model: "cheap" })).toThrow(/stays on OpenAI/);
  });

  it("tier models are env-overridable, and one skill can be overridden alone", () => {
    process.env.OPENAI_AGENT_MODEL = "model-a";
    process.env.AGENT_SKILL_MODELS = JSON.stringify({ "x/special": { model: "model-b", effort: "medium" }, "x/bad": { effort: "ludicrous" } });
    expect(modelFor({ id: "x/y", model: "reasoning", effort: "high" }).model).toBe("model-a");
    expect(modelFor({ id: "x/special", model: "reasoning", effort: "high" })).toEqual({ provider: "openai", model: "model-b", effort: "medium" });
    expect(modelFor({ id: "x/bad", model: "fast", effort: "low" }).effort).toBe("low");
    process.env.AGENT_SKILL_MODELS = "{not json";
    expect(modelFor({ id: "x/special", model: "reasoning", effort: "high" }).model).toBe("model-a");
  });
});

describe("costOf", () => {
  it("prices uncached input, cached input and output (reasoning is inside output), rounded up", () => {
    process.env.AGENT_MODEL_PRICES = JSON.stringify({ m: { inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8 } });
    const c = costOf("m", { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 60, webSearchCalls: 0 });
    // 600 × 2 + 400 × 0.5 + 100 × 8 = 1200 + 200 + 800 = 2200 micro-dollars
    expect(c).toEqual({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 60, webSearchCalls: 0, microUsd: 2200 });
  });

  it("charges input written to the cache at 1.25× the input rate (a subset of the uncached input)", () => {
    process.env.AGENT_MODEL_PRICES = JSON.stringify({ m: { inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8 } });
    const c = costOf("m", { inputTokens: 1000, cachedInputTokens: 400, cacheWriteTokens: 400, outputTokens: 100, reasoningTokens: 0, webSearchCalls: 0 });
    // 200 × 2 + 400 × 2.5 + 400 × 0.5 + 100 × 8 = 400 + 1000 + 200 + 800 = 2400 micro-dollars
    expect(c.microUsd).toBe(2400);
    // Writes can never exceed the uncached input.
    expect(costOf("m", { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 5000, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0 }).microUsd).toBe(250);
  });

  it("the chat skill defaults to the reasoning tier at low effort, and AGENT_SKILL_MODELS changes it without a deploy", () => {
    expect(modelFor({ id: "chat", model: "reasoning", effort: "low" })).toEqual({ provider: "openai", model: "gpt-6.1-sol", effort: "low" });
    process.env.AGENT_SKILL_MODELS = JSON.stringify({ chat: { model: "gpt-6-luna", effort: "minimal" } });
    expect(modelFor({ id: "chat", model: "reasoning", effort: "low" })).toEqual({ provider: "openai", model: "gpt-6-luna", effort: "minimal" });
  });

  it("adds each web search call", () => {
    process.env.AGENT_WEB_SEARCH_PRICE_USD = "0.02";
    expect(costOf("gpt-5.4", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 3 }).microUsd).toBe(60_000);
    delete process.env.AGENT_WEB_SEARCH_PRICE_USD;
    expect(costOf("gpt-5.4", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 1 }).microUsd).toBe(10_000);
  });

  it("an unknown model is priced at the most expensive known rate, never zero", () => {
    const known = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"];
    expect(priceOf("some-new-model").outputPerMTok).toBe(Math.max(...known.map((m) => priceOf(m).outputPerMTok)));
    expect(costOf("some-new-model", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, webSearchCalls: 0 }).microUsd).toBeGreaterThan(0);
  });

  it("prices Gemini usage at the Gemini rate (thinking is inside output; cached is inside input)", () => {
    // 600 × 1.5 + 400 × 0.15 + 200 × 9 = 900 + 60 + 1800 = 2760 micro-dollars
    expect(costOf("gemini-3.5-flash", { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 150, webSearchCalls: 0 }).microUsd).toBe(2760);
  });

  it("addCost sums every field", () => {
    const a = { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 4, webSearchCalls: 5, microUsd: 6 };
    expect(addCost(addCost(ZERO_COST, a), a)).toEqual({ inputTokens: 2, cachedInputTokens: 4, outputTokens: 6, reasoningTokens: 8, webSearchCalls: 10, microUsd: 12 });
  });
});

/**
 * THE PRICE REGISTRY, pinned. Every value below was read off the provider's own pricing page for the exact model id and
 * the route we call, on PRICES_VERIFIED_ON. Changing a number here means re-reading that page, not adjusting a test.
 *   OpenAI (api.openai.com, Standard): https://developers.openai.com/api/docs/pricing
 *   Gemini (Vertex AI, location global, Standard): https://cloud.google.com/vertex-ai/generative-ai/pricing
 */
describe("price registry (verified 27 Oct 2026)", () => {
  const OCT = new Date("2026-10-27T12:00:00Z");
  const OAI_LONG = 272_000;

  it("records when it was verified", () => {
    expect(PRICES_VERIFIED_ON).toBe("2026-10-27");
  });

  it.each([
    ["gpt-6.1-sol", 2, 0.1, 10, { aboveInputTokens: OAI_LONG, inputPerMTok: 4, cachedInputPerMTok: 0.2, outputPerMTok: 15 }],
    ["gpt-6-sol", 2, 0.2, 10, { aboveInputTokens: OAI_LONG, inputPerMTok: 4, cachedInputPerMTok: 0.4, outputPerMTok: 15 }],
    ["gpt-6-luna", 0.1, 0.01, 0.5, { aboveInputTokens: OAI_LONG, inputPerMTok: 0.2, cachedInputPerMTok: 0.02, outputPerMTok: 0.75 }],
    ["gpt-6-astra", 10, 1, 50, { aboveInputTokens: OAI_LONG, inputPerMTok: 20, cachedInputPerMTok: 2, outputPerMTok: 75 }],
    ["gpt-5.4", 2.5, 0.25, 15, { aboveInputTokens: OAI_LONG, inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 22.5 }],
    ["gpt-5.4-mini", 0.75, 0.075, 4.5, undefined],
    ["gpt-5.4-nano", 0.2, 0.02, 1.25, undefined],
    ["gemini-3.5-flash", 1.5, 0.15, 9, undefined],
    ["gemini-3.5-flash-lite", 0.3, 0.03, 2.5, undefined],
    ["gemini-3.1-pro-preview", 2, 0.2, 12, { aboveInputTokens: 200_000, inputPerMTok: 4, cachedInputPerMTok: 0.4, outputPerMTok: 18 }],
  ] as const)("%s: %p in / %p cached / %p out", (model, input, cached, output, longContext) => {
    const expected: Record<string, unknown> = { inputPerMTok: input, cachedInputPerMTok: cached, outputPerMTok: output };
    if (longContext) expected.longContext = longContext;
    expect(priceOf(model, OCT)).toEqual(expected);
  });

  it("gemini-3.8-flash: the intro rate through 31 Dec 2026, the standard rate from 1 Jan 2027", () => {
    const intro = { inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 3.75 };
    expect(priceOf("gemini-3.8-flash", OCT)).toEqual(intro);
    expect(priceOf("gemini-3.8-flash", new Date("2026-12-31T23:59:59Z"))).toEqual(intro);
    expect(priceOf("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))).toEqual({ inputPerMTok: 1.5, cachedInputPerMTok: 0.15, outputPerMTok: 7.5 });
  });

  it("bills a request above the long-context threshold at the long-context rates", () => {
    const usage = (inputTokens: number) => ({ inputTokens, cachedInputTokens: 0, outputTokens: 1000, reasoningTokens: 0, webSearchCalls: 0 });
    // at the threshold, short rates: 272,000 × 0.1 + 1,000 × 0.5 = 27,200 + 500
    expect(costOf("gpt-6-luna", usage(272_000), OCT).microUsd).toBe(27_700);
    // above it, long rates: 272,001 × 0.2 + 1,000 × 0.75 = 54,400.2 + 750 → 55,151 (rounded up)
    expect(costOf("gpt-6-luna", usage(272_001), OCT).microUsd).toBe(55_151);
    // Gemini 3.5 Flash has one rate at any length: 300,000 × 1.5 + 1,000 × 9
    expect(costOf("gemini-3.5-flash", usage(300_000), OCT).microUsd).toBe(459_000);
  });

  it("the research cost model prices gemini_grounded (which runs GEMINI.flash) at the registry's Flash rate", () => {
    expect(GEMINI.flash).toBe("gemini-3.5-flash");
    const flash = priceOf(GEMINI.flash, OCT);
    expect(DEFAULT_COST_MODEL.gemini_grounded).toMatchObject({ perMTokInUsd: flash.inputPerMTok, perMTokOutUsd: flash.outputPerMTok });
    expect(DEFAULT_COST_MODEL.gemini_direct).toMatchObject({ perMTokInUsd: flash.inputPerMTok, perMTokOutUsd: flash.outputPerMTok, perSearchQueryUsd: 0.014 });
  });

  it("an env override still wins for a listed model", () => {
    process.env.AGENT_MODEL_PRICES = JSON.stringify({ "gpt-6-luna": { inputPerMTok: 1, cachedInputPerMTok: 1, outputPerMTok: 1 } });
    expect(priceOf("gpt-6-luna", OCT)).toEqual({ inputPerMTok: 1, cachedInputPerMTok: 1, outputPerMTok: 1 });
  });
});
