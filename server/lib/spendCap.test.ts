/**
 * spendCap.test.ts — every spend cap override is clamped to a hard maximum and fails CLOSED (spend guards, Nov 2026).
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { clampCap, clampPrice, readCap, readPrice } from "./spendCap";
import { AGENT, AGENT_CAP_MAX, runLimitsFor } from "../agent/config";
import { MASTRA } from "../agent/engine/config";
import { maxDayUsd, maxJobUsd, STUDIO_MAX_DAY_USD_CEILING, STUDIO_MAX_JOB_USD_CEILING } from "../studio/config";
import { enrichDailyCapUsd, ENRICH_DAILY_CAP_FALLBACK_USD, ENRICH_DAILY_CAP_MAX_USD } from "../studio/enrich/config";
import { ATMOSPHERE } from "../services/atmosphere/config";
import { MILA } from "../mila/config";
import { RESEARCH_REFRESH } from "../agent/researchRefresh/config";
import { priceOf, webSearchCallMicroUsd, WEB_SEARCH_PRICE_FLOOR_USD } from "../agent/models";
import { platformDayCapMicroUsd, PLATFORM_DAY_CAP_DEFAULT_USD, PLATFORM_DAY_CAP_MAX_USD, PlatformCapError, setPlatformSpendReaderForTests } from "./platformSpend";
import { onboardingCostCapMicroUsd, ONBOARDING_COST_CAP_MAX_USD } from "../agent/onboarding/costCap";
import { maxEditCalls } from "../studio/config";
import { videoEnrichMaxRunUsd, VIDEO_ENRICH_MAX_RUN_CEILING_USD } from "../studio/enrich/config";
import { ASK_MILA } from "../services/askMila/config";
import { quickScoreMaxUsd } from "../services/quickScore/config";
import { callStructured } from "../agent/research/llm";

const KEYS = [
  "X_CAP", "AGENT_RUN_COST_CAP_USD", "AGENT_DAY_COST_CAP_USD", "AGENT_SKILL_CAPS", "MILA_MAX_CONCURRENT_TURNS",
  "STUDIO_MAX_JOB_USD", "STUDIO_MAX_DAY_USD", "STUDIO_ENRICH_DAILY_CAP_USD", "ATMOSPHERE_ATHLETE_DAY_CAP_USD",
  "ATMOSPHERE_ATHLETE_TOTAL_CAP_USD", "ATMOSPHERE_DAY_CAP_USD", "MILA_WEB_SEARCH_MAX", "AGENT_RESEARCH_REFRESH_RUN_CAP_USD",
  "AGENT_RESEARCH_REFRESH_DAY_CAP_USD", "LEAN_RESEARCH_FOLLOWUP_MAX_USD", "DAILY_RESEARCH_CAP_USD", "AGENT_MODEL_PRICES",
  "AGENT_WEB_SEARCH_PRICE_USD", "PLATFORM_DAY_COST_CAP_USD", "AGENT_ONBOARDING_COST_CAP_USD", "STUDIO_MAX_EDIT_CALLS",
  "STUDIO_VIDEO_ENRICH_MAX_RUN_USD", "ASK_MILA_DAILY_SPEND_CAP_USD", "ASK_MILA_PRICE_INPUT_PER_MTOK_USD",
  "ASK_MILA_PRICE_OUTPUT_PER_MTOK_USD", "QUICK_SCORE_MAX_USD",
];
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("readCap", () => {
  it("unset or blank is the default", () => {
    expect(readCap("X_CAP", 5, 50, { env: {} })).toBe(5);
    expect(readCap("X_CAP", 5, 50, { env: { X_CAP: "  " } })).toBe(5);
  });
  it("a value under the maximum is used (stricter is always allowed)", () => {
    expect(readCap("X_CAP", 5, 50, { env: { X_CAP: "12.5" } })).toBe(12.5);
    expect(readCap("X_CAP", 5, 50, { env: { X_CAP: "0.01" } })).toBe(0.01);
  });
  it("a value above the hard maximum is clamped to it", () => {
    expect(readCap("X_CAP", 5, 50, { env: { X_CAP: "1000000" } })).toBe(50);
  });
  it.each(["abc", "NaN", "Infinity", "-1", "0", "1e999", "5 USD"])("%p fails closed to the default", (v) => {
    expect(readCap("X_CAP", 5, 50, { env: { X_CAP: v } })).toBe(5);
  });
  it("0 is a real value only where allowZero says so", () => {
    expect(readCap("X_CAP", 5, 50, { env: { X_CAP: "0" }, allowZero: true })).toBe(0);
    expect(readCap("X_CAP", 5, 50, { env: { X_CAP: "-0.5" }, allowZero: true })).toBe(5);
  });
  it("clampCap handles parsed JSON values the same way", () => {
    expect(clampCap("X", 9, 1, 3)).toBe(3);
    expect(clampCap("X", "x", 1, 3)).toBe(1);
    expect(clampCap("X", null, 1, 3)).toBe(1);
  });
});

describe("readPrice (the floor)", () => {
  it("never below the floor, never 0; a non-number is the default", () => {
    expect(readPrice("X_CAP", 0.01, 0.005, { X_CAP: "0" })).toBe(0.005);
    expect(readPrice("X_CAP", 0.01, 0.005, { X_CAP: "0.0001" })).toBe(0.005);
    expect(readPrice("X_CAP", 0.01, 0.005, { X_CAP: "abc" })).toBe(0.01);
    expect(readPrice("X_CAP", 0.01, 0.005, { X_CAP: "0.5" })).toBe(0.5);
    expect(clampPrice("X", -3, 1, 0.5)).toBe(0.5);
  });
  it("a web search can never be priced at 0", () => {
    process.env.AGENT_WEB_SEARCH_PRICE_USD = "0";
    expect(webSearchCallMicroUsd()).toBe(WEB_SEARCH_PRICE_FLOOR_USD * 1_000_000);
  });
  it("AGENT_MODEL_PRICES cannot price a known model below half its scheduled rate, or at 0", () => {
    const at = new Date("2026-11-04T12:00:00Z");
    const base = priceOf("gpt-6.1-sol", at);
    process.env.AGENT_MODEL_PRICES = JSON.stringify({ "gpt-6.1-sol": { inputPerMTok: 0, cachedInputPerMTok: "x", outputPerMTok: 0.0001 } });
    const p = priceOf("gpt-6.1-sol", at);
    expect(p.inputPerMTok).toBe(base.inputPerMTok / 2);
    expect(p.cachedInputPerMTok).toBe(base.cachedInputPerMTok);
    expect(p.outputPerMTok).toBe(base.outputPerMTok / 2);
  });
  it("an unlisted model in AGENT_MODEL_PRICES is held to the cheapest scheduled rate", () => {
    const at = new Date("2026-11-04T12:00:00Z");
    process.env.AGENT_MODEL_PRICES = JSON.stringify({ "free-model": { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 } });
    const p = priceOf("free-model", at);
    expect(p.inputPerMTok).toBeGreaterThan(0);
    expect(p.outputPerMTok).toBeGreaterThan(0);
  });
});

describe("every converted cap is clamped and fails closed", () => {
  it("agent run / day caps and AGENT_SKILL_CAPS", () => {
    process.env.AGENT_RUN_COST_CAP_USD = "999";
    process.env.AGENT_DAY_COST_CAP_USD = "abc";
    expect(AGENT.RUN_COST_CAP_MICRO_USD).toBe(AGENT_CAP_MAX.RUN_USD * 1_000_000);
    expect(AGENT.DAY_COST_CAP_MICRO_USD).toBe(5_000_000);
    process.env.AGENT_SKILL_CAPS = JSON.stringify({ s: { max_steps: 1e6, cost_cap_usd: 1e6, max_web_searches: 1e6 } });
    expect(runLimitsFor({ id: "s" })).toEqual({ maxSteps: AGENT_CAP_MAX.STEPS, costCapMicroUsd: AGENT_CAP_MAX.RUN_USD * 1_000_000, maxWebSearches: AGENT_CAP_MAX.WEB_SEARCHES });
    process.env.AGENT_SKILL_CAPS = JSON.stringify({ s: { cost_cap_usd: "nope" } });
    expect(runLimitsFor({ id: "s", limits: { costCapUsd: 0.15 } }).costCapMicroUsd).toBe(150_000);
  });
  it("Mila concurrent turns", () => {
    process.env.MILA_MAX_CONCURRENT_TURNS = "500";
    expect(MASTRA.maxConcurrentTurns).toBe(10);
    process.env.MILA_MAX_CONCURRENT_TURNS = "x";
    expect(MASTRA.maxConcurrentTurns).toBe(2);
  });
  it("Studio job and day caps (bare Number() before: NaN meant no cap)", () => {
    process.env.STUDIO_MAX_JOB_USD = "abc";
    process.env.STUDIO_MAX_DAY_USD = "abc";
    expect(maxJobUsd()).toBe(10);
    expect(maxDayUsd()).toBe(25);
    process.env.STUDIO_MAX_JOB_USD = "1e9";
    process.env.STUDIO_MAX_DAY_USD = "1e9";
    expect(maxJobUsd()).toBe(STUDIO_MAX_JOB_USD_CEILING);
    expect(maxDayUsd()).toBe(STUDIO_MAX_DAY_USD_CEILING);
  });
  it("Studio enrichment daily cap", () => {
    process.env.STUDIO_ENRICH_DAILY_CAP_USD = "abc";
    expect(enrichDailyCapUsd()).toBe(ENRICH_DAILY_CAP_FALLBACK_USD);
    process.env.STUDIO_ENRICH_DAILY_CAP_USD = "1e9";
    expect(enrichDailyCapUsd()).toBe(ENRICH_DAILY_CAP_MAX_USD);
    process.env.STUDIO_ENRICH_DAILY_CAP_USD = "0";
    expect(enrichDailyCapUsd()).toBe(0);
  });
  it("atmosphere caps", () => {
    process.env.ATMOSPHERE_ATHLETE_DAY_CAP_USD = "1e9";
    process.env.ATMOSPHERE_ATHLETE_TOTAL_CAP_USD = "1e9";
    process.env.ATMOSPHERE_DAY_CAP_USD = "1e9";
    expect(ATMOSPHERE.ATHLETE_DAY_CAP_MICRO_USD).toBe(5_000_000);
    expect(ATMOSPHERE.ATHLETE_TOTAL_CAP_MICRO_USD).toBe(20_000_000);
    expect(ATMOSPHERE.DAY_CAP_MICRO_USD).toBe(100_000_000);
  });
  it("web searches per window", () => {
    process.env.MILA_WEB_SEARCH_MAX = "1e9";
    expect(MILA.WEB_SEARCH_MAX_PER_WINDOW).toBe(50);
  });
  it("research refresh", () => {
    process.env.AGENT_RESEARCH_REFRESH_RUN_CAP_USD = "1e9";
    process.env.AGENT_RESEARCH_REFRESH_DAY_CAP_USD = "1e9";
    expect(RESEARCH_REFRESH.RUN_CAP_MICRO_USD).toBe(10_000_000);
    expect(RESEARCH_REFRESH.DAY_CAP_MICRO_USD).toBe(100_000_000);
  });
  it("the platform-wide day cap has its own clamp", () => {
    expect([PLATFORM_DAY_CAP_DEFAULT_USD, PLATFORM_DAY_CAP_MAX_USD]).toEqual([25, 250]); // owner, 5 Nov 2026
    delete process.env.PLATFORM_DAY_COST_CAP_USD;
    expect(platformDayCapMicroUsd()).toBe(PLATFORM_DAY_CAP_DEFAULT_USD * 1_000_000);
    process.env.PLATFORM_DAY_COST_CAP_USD = "1e9";
    expect(platformDayCapMicroUsd()).toBe(PLATFORM_DAY_CAP_MAX_USD * 1_000_000);
    process.env.PLATFORM_DAY_COST_CAP_USD = "abc";
    expect(platformDayCapMicroUsd()).toBe(PLATFORM_DAY_CAP_DEFAULT_USD * 1_000_000);
  });
});

describe("the caps the first pass missed (independent review)", () => {
  it("onboarding, Studio edit calls, video enrichment run, Ask Mila, quick score: clamped, and fail closed", () => {
    process.env.AGENT_ONBOARDING_COST_CAP_USD = "1e9";
    expect(onboardingCostCapMicroUsd()).toBe(ONBOARDING_COST_CAP_MAX_USD * 1_000_000);
    process.env.AGENT_ONBOARDING_COST_CAP_USD = "abc";
    expect(onboardingCostCapMicroUsd()).toBe(2_000_000);
    process.env.STUDIO_MAX_EDIT_CALLS = "abc";
    expect(maxEditCalls()).toBe(4);
    process.env.STUDIO_MAX_EDIT_CALLS = "1e9";
    expect(maxEditCalls()).toBe(12);
    process.env.STUDIO_VIDEO_ENRICH_MAX_RUN_USD = "abc"; // was a bare Number(): NaN, so no cap at all
    expect(videoEnrichMaxRunUsd()).toBe(2);
    process.env.STUDIO_VIDEO_ENRICH_MAX_RUN_USD = "1e9";
    expect(videoEnrichMaxRunUsd()).toBe(VIDEO_ENRICH_MAX_RUN_CEILING_USD);
    process.env.ASK_MILA_DAILY_SPEND_CAP_USD = "1e9";
    expect(ASK_MILA.dailySpendCapMicroUsd).toBe(200_000_000);
    process.env.ASK_MILA_DAILY_SPEND_CAP_USD = "0"; // still the kill switch
    expect(ASK_MILA.dailySpendCapMicroUsd).toBe(0);
    process.env.ASK_MILA_PRICE_INPUT_PER_MTOK_USD = "0";
    process.env.ASK_MILA_PRICE_OUTPUT_PER_MTOK_USD = "0";
    expect([ASK_MILA.priceInputPerMTokUsd, ASK_MILA.priceOutputPerMTokUsd]).toEqual([0.25, 1.5]);
    process.env.QUICK_SCORE_MAX_USD = "1e9";
    expect(quickScoreMaxUsd()).toBe(6);
    process.env.QUICK_SCORE_MAX_USD = "abc";
    expect(quickScoreMaxUsd()).toBe(0.6);
  });

  it("callStructured (the structured-call primitive, used directly by paths that skip runSkill) checks the platform cap first", async () => {
    process.env.PLATFORM_DAY_COST_CAP_USD = "1";
    setPlatformSpendReaderForTests(async () => 5_000_000);
    try {
      await expect(callStructured({ model: { provider: "openai", model: "gpt-6-luna" } } as any)).rejects.toBeInstanceOf(PlatformCapError);
    } finally {
      setPlatformSpendReaderForTests(null);
    }
  });
});
