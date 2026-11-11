/**
 * agent/models.ts — THE one place that picks the model for a skill, and prices what it used.
 *
 * A skill's front-matter names a TIER (reasoning | fast | cheap) and an effort; it never names a model id. This file
 * turns that into a ModelChoice:
 *   1. a per-skill override in AGENT_SKILL_MODELS (JSON: { "<skill id>": { "model": "...", "effort": "..." } }), else
 *   2. the tier's model (env-overridable, so a bad model is a config flip, not a deploy).
 * Every run records the choice it actually used (agent_runs.provider / model / effort).
 *
 * The provider rule (agreed 10 Oct 2026):
 *   - OpenAI for anything athlete-facing or any judgement an athlete sees, and for ALL web search;
 *   - Gemini Flash on Vertex (the GCP credits) for routine extraction, classification and tagging;
 *   - voice stays on Gemini Live (not routed here); no per-message routing in chat (a skill has one model).
 * So `reasoning` and `fast` are OpenAI, and `cheap` is Gemini Flash (agent/geminiProvider.ts). Only routine skills sit
 * on `cheap` (atmosphere/queries, atmosphere/check, post-kit/match, post-kit/ideas). The provider follows from the model id (`gemini-*` → Gemini,
 * anything else → OpenAI), so a per-skill AGENT_SKILL_MODELS override can move one skill either way, and
 * AGENT_CHEAP_MODEL=gpt-6-luna moves the whole tier back to OpenAI without a deploy. A skill that lists web_search can
 * never resolve to Gemini: modelFor throws (search stays on OpenAI).
 *
 * Model ids (9 Oct 2026): `reasoning` = gpt-6.1-sol, the model the baseline test ran on this week (Responses API,
 * web_search, effort high). `fast` = gpt-6-luna: of the models GET /v1/models lists for our key, the gpt-6 family is
 * gpt-6-astra / gpt-6-sol / gpt-6-luna (no 6.1 sibling below sol), and luna is the only one smaller than sol (judged
 * by price; the pricing page gives no sizes). `cheap` = GEMINI.flash from server/lib/models.ts (the repo's one list of
 * Gemini ids; env GEMINI_FLASH_MODEL), overridable for the agent alone with AGENT_CHEAP_MODEL.
 *
 * Prices are USD per million tokens, by exact model id and API route, with effective dates: see PRICE_SCHEDULE below
 * (verified 27 Oct 2026). Env-overridable through AGENT_MODEL_PRICES (JSON keyed by model id). An
 * unknown model is priced at the most expensive known rate, never at zero, so a cap can only trip early, not late.
 * Vertex calls bill against the GCP credits; they are still priced here so the caps mean the same thing everywhere.
 */
import type { Effort, ModelChoice, ModelProvider, ModelTier, RunCost, Skill } from "../../shared/agent";
import { EFFORTS } from "../../shared/agent";
import { GEMINI } from "../lib/models";
import { clampPrice, readPrice } from "../lib/spendCap";

export const AGENT_MODELS = {
  get reasoning(): string { return process.env.OPENAI_AGENT_MODEL ?? "gpt-6.1-sol"; },
  get fast(): string { return process.env.OPENAI_AGENT_FAST_MODEL ?? "gpt-6-luna"; },
  get cheap(): string { return process.env.AGENT_CHEAP_MODEL ?? GEMINI.flash; },
} as const;

export interface ModelPrice {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  /** Input tokens written to the prompt cache. Absent = CACHE_WRITE_MULTIPLIER × inputPerMTok (how OpenAI bills writes). */
  cacheWritePerMTok?: number;
  /** The rates for one request whose input is ABOVE `aboveInputTokens` (OpenAI "long context", Gemini "> 200K"). */
  longContext?: { aboveInputTokens: number; inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number };
}

/** One price for a model over a span of days (UTC calendar dates, both ends inclusive; absent = open-ended). */
export interface PricePeriod extends ModelPrice {
  from?: string;
  until?: string;
}

/** Cache writes (30-minute) bill at 1.25× the model's input rate (OpenAI pricing page, checked 27 Oct 2026). */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** The date every price below was last read off its provider's page (by exact model id and route). */
export const PRICES_VERIFIED_ON = "2026-10-27";

const OPENAI_LONG = 272_000;  // OpenAI: "Short context: ≤272K input tokens. Long context: >272K input tokens."
const GEMINI_LONG = 200_000;  // Vertex: "<= 200K input tokens" / "> 200K input tokens".

/**
 * THE price registry. USD per million tokens, STANDARD (pay-as-you-go) tier, on the route we actually call. Batch,
 * Flex, Priority / Fast and regional (data-residency, non-global) rates are used by no caller and are not listed.
 *
 * OpenAI: the OpenAI API (api.openai.com, the SDK default; no data-residency endpoint), Responses API. Source:
 *   https://developers.openai.com/api/docs/pricing (Standard table; the page's .md version), checked 27 Oct 2026.
 *   Every id below is listed there by its exact id; the long-context (>272K input) rates are from the same table.
 *   On the page but unused by us: Batch / Flex = half the standard rate, Fast = 2×, regional endpoints +10%.
 *   Image input (Mila's chat attachments, agent/engine/mastra/attachments.ts): no separate rate. OpenAI's vision guide
 *   (developers.openai.com/api/docs/guides/images-vision, checked 3 Nov 2026) says "Vision models convert image inputs
 *   into billable input tokens" (gpt-6 family: 32×32 patches × a per-model multiplier, e.g. 1,229 tokens for a
 *   1024×1024 image on gpt-6-astra), and they arrive INSIDE the response's input tokens, so costOf already prices them
 *   at the model's input rate and every cost cap counts them (pinned in attachments.db.test.ts V6).
 *
 * Gemini: Vertex AI (server/lib/models.ts genai(): vertexai, project gamechanger-pocket-agent, location `global`; no
 *   Cloud Run env overrides VERTEX_LOCATION). NOT the Gemini Developer API / AI Studio (ai.google.dev), which no longer
 *   lists gemini-3.5-flash. Source: https://cloud.google.com/vertex-ai/generative-ai/pricing (now titled "Agent
 *   Platform Pricing"), Standard table, Region = Global, checked 27 Oct 2026. Output includes thinking tokens ("Text
 *   output (response and reasoning)"). Non-global regions are 10% higher (3.5 Flash: 1.65 / 0.165 / 9.90). The id
 *   gemini-3.5-flash is confirmed on its Vertex model page (docs/models/gemini/3-5-flash, "Model ID").
 *   Grounding with Google Search is separate: $14 per 1,000 grounding queries after 5,000 free a month.
 *
 * gemini-3.8-flash: the page offers "introductory pricing of $0.75 / $3.75 per 1M tokens input / output through
 *   December 31, 2026. Starting January 1, 2027, standard pricing of $1.5 / $7.5", the intro rate "provided through
 *   50% credits back on net spend": the invoice line is the standard rate and half comes back as a credit. Priced
 *   here at the NET intro rate through 31 Dec 2026, then at standard.
 */
const PRICE_SCHEDULE: Record<string, PricePeriod[]> = {
  // OpenAI, Standard: short context (≤272K input), and long context where the page lists one.
  "gpt-6.1-sol":  [{ inputPerMTok: 2,    cachedInputPerMTok: 0.1,   outputPerMTok: 10,
                     longContext: { aboveInputTokens: OPENAI_LONG, inputPerMTok: 4,   cachedInputPerMTok: 0.2,  outputPerMTok: 15 } }],
  "gpt-6-sol":    [{ inputPerMTok: 2,    cachedInputPerMTok: 0.2,   outputPerMTok: 10,
                     longContext: { aboveInputTokens: OPENAI_LONG, inputPerMTok: 4,   cachedInputPerMTok: 0.4,  outputPerMTok: 15 } }],
  "gpt-6-luna":   [{ inputPerMTok: 0.1,  cachedInputPerMTok: 0.01,  outputPerMTok: 0.5,
                     longContext: { aboveInputTokens: OPENAI_LONG, inputPerMTok: 0.2, cachedInputPerMTok: 0.02, outputPerMTok: 0.75 } }],
  "gpt-6-astra":  [{ inputPerMTok: 10,   cachedInputPerMTok: 1,     outputPerMTok: 50,
                     longContext: { aboveInputTokens: OPENAI_LONG, inputPerMTok: 20,  cachedInputPerMTok: 2,    outputPerMTok: 75 } }],
  "gpt-5.4":      [{ inputPerMTok: 2.5,  cachedInputPerMTok: 0.25,  outputPerMTok: 15,
                     longContext: { aboveInputTokens: OPENAI_LONG, inputPerMTok: 5,   cachedInputPerMTok: 0.5,  outputPerMTok: 22.5 } }],
  "gpt-5.4-mini": [{ inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 4.5 }],
  "gpt-5.4-nano": [{ inputPerMTok: 0.2,  cachedInputPerMTok: 0.02,  outputPerMTok: 1.25 }],

  // Gemini on Vertex AI, Standard, Region = Global. Flash / Flash-Lite have one rate at every context length.
  "gemini-3.5-flash":       [{ inputPerMTok: 1.5, cachedInputPerMTok: 0.15, outputPerMTok: 9 }],
  "gemini-3.5-flash-lite":  [{ inputPerMTok: 0.3, cachedInputPerMTok: 0.03, outputPerMTok: 2.5 }],
  "gemini-3.1-pro-preview": [{ inputPerMTok: 2,   cachedInputPerMTok: 0.2,  outputPerMTok: 12,
                               longContext: { aboveInputTokens: GEMINI_LONG, inputPerMTok: 4, cachedInputPerMTok: 0.4, outputPerMTok: 18 } }],
  "gemini-3.8-flash": [
    { until: "2026-12-31", inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 3.75 },
    { from: "2027-01-01",  inputPerMTok: 1.5,  cachedInputPerMTok: 0.15,  outputPerMTok: 7.5 },
  ],
};

/** The period in force on `at` (its UTC date). A date no period covers falls back to the model's last period. */
function periodAt(periods: PricePeriod[], at: Date): ModelPrice {
  const day = at.toISOString().slice(0, 10);
  const hit = periods.find((p) => (!p.from || p.from <= day) && (!p.until || day <= p.until)) ?? periods[periods.length - 1];
  const { from: _from, until: _until, ...price } = hit;
  return price;
}

/**
 * One web_search call, in micro-dollars: $10 per 1,000 calls (OpenAI pricing page, checked 27 Oct 2026). The search
 * content tokens the page also bills "at model rates" arrive in the response's input tokens, so costOf already counts
 * them. Env: AGENT_WEB_SEARCH_PRICE_USD.
 */
export function webSearchCallMicroUsd(): number {
  // Floored at half the list price (lib/spendCap.ts readPrice): an override can never make a search free.
  return Math.round(readPrice("AGENT_WEB_SEARCH_PRICE_USD", 0.01, WEB_SEARCH_PRICE_FLOOR_USD) * 1_000_000);
}
export const WEB_SEARCH_PRICE_FLOOR_USD = 0.005;

/**
 * The floor an AGENT_MODEL_PRICES override is held to: for a model in the schedule, half its scheduled rate; for a model
 * the schedule does not list, the cheapest scheduled rate. So an override can raise a price freely (a cap trips early),
 * but can never price a model near zero (a cap that never trips). A field that is not a usable number is the built-in.
 */
const PRICE_FLOOR_SHARE = 0.5;
function flooredOverride(model: string, o: Partial<ModelPrice>, base: ModelPrice | undefined, cheapest: ModelPrice): ModelPrice {
  const ref = base ?? cheapest;
  type K = "inputPerMTok" | "cachedInputPerMTok" | "outputPerMTok";
  const floorOf = (k: K) => (base ? ref[k] * PRICE_FLOOR_SHARE : ref[k]);
  const field = (k: K, v: unknown, name: string): number => clampPrice(name, v ?? ref[k], ref[k], floorOf(k));
  const price: ModelPrice = {
    inputPerMTok: field("inputPerMTok", o.inputPerMTok, `AGENT_MODEL_PRICES.${model}.inputPerMTok`),
    cachedInputPerMTok: field("cachedInputPerMTok", o.cachedInputPerMTok, `AGENT_MODEL_PRICES.${model}.cachedInputPerMTok`),
    outputPerMTok: field("outputPerMTok", o.outputPerMTok, `AGENT_MODEL_PRICES.${model}.outputPerMTok`),
  };
  // The override replaces the entry, as it always did; a long-context tier it supplies is held to the same floors.
  const lc = o.longContext;
  if (lc && typeof lc === "object" && Number.isFinite(Number(lc.aboveInputTokens))) {
    price.longContext = {
      aboveInputTokens: Number(lc.aboveInputTokens),
      inputPerMTok: field("inputPerMTok", lc.inputPerMTok, `AGENT_MODEL_PRICES.${model}.longContext.inputPerMTok`),
      cachedInputPerMTok: field("cachedInputPerMTok", lc.cachedInputPerMTok, `AGENT_MODEL_PRICES.${model}.longContext.cachedInputPerMTok`),
      outputPerMTok: field("outputPerMTok", lc.outputPerMTok, `AGENT_MODEL_PRICES.${model}.longContext.outputPerMTok`),
    };
  }
  return price;
}

function priceTable(at: Date): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = {};
  for (const [model, periods] of Object.entries(PRICE_SCHEDULE)) table[model] = periodAt(periods, at);
  const raw = process.env.AGENT_MODEL_PRICES;
  if (!raw) return table;
  let parsed: Record<string, Partial<ModelPrice>>;
  try {
    parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
  } catch {
    return table;
  }
  if (!parsed || typeof parsed !== "object") return table;
  const cheapest = Object.values(table).reduce((a, b) => (b.outputPerMTok < a.outputPerMTok ? b : a));
  const out = { ...table };
  for (const [model, o] of Object.entries(parsed)) {
    if (!o || typeof o !== "object") continue;
    out[model] = flooredOverride(model, o, table[model], cheapest);
  }
  return out;
}

/** The price of `model` in force on `at` (default: now). */
export function priceOf(model: string, at: Date = new Date()): ModelPrice {
  const table = priceTable(at);
  if (table[model]) return table[model];
  // Unknown model → the most expensive known rate (a cap trips early, never late).
  return Object.values(table).reduce((a, b) => (b.outputPerMTok > a.outputPerMTok ? b : a));
}

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  webSearchCalls: number;
  /** Input tokens written to the prompt cache this call (a SUBSET of inputTokens, disjoint from the cached ones). */
  cacheWriteTokens?: number;
}

/**
 * Usage → RunCost. Cached input bills at the cached rate and is a SUBSET of inputTokens (OpenAI's shape); input written
 * to the cache bills at the cache-write rate (1.25× input unless the price table says otherwise); reasoning tokens are a
 * subset of outputTokens and bill as output. Rounded up to the micro-dollar.
 *
 * Long context: when the usage's input is above the model's long-context threshold, the whole usage bills at the
 * long-context rates (that is how both providers bill one request). A caller that passes several requests' usage summed
 * can only be over-priced by this, never under-priced.
 */
export function costOf(model: string, u: ModelUsage, at: Date = new Date()): RunCost {
  const base = priceOf(model, at);
  const lc = base.longContext;
  const p: ModelPrice = lc && u.inputTokens > lc.aboveInputTokens
    ? { inputPerMTok: lc.inputPerMTok, cachedInputPerMTok: lc.cachedInputPerMTok, outputPerMTok: lc.outputPerMTok }
    : base;
  const writes = Math.max(0, Math.min(u.cacheWriteTokens ?? 0, u.inputTokens - u.cachedInputTokens));
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens - writes);
  const writeRate = p.cacheWritePerMTok ?? p.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  const usd = (uncached * p.inputPerMTok + writes * writeRate + u.cachedInputTokens * p.cachedInputPerMTok + u.outputTokens * p.outputPerMTok) / 1_000_000;
  return {
    inputTokens: u.inputTokens,
    cachedInputTokens: u.cachedInputTokens,
    outputTokens: u.outputTokens,
    reasoningTokens: u.reasoningTokens,
    webSearchCalls: u.webSearchCalls,
    microUsd: Math.ceil(usd * 1_000_000) + u.webSearchCalls * webSearchCallMicroUsd(),
  };
}

export const ZERO_COST: RunCost = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 0 };

export function addCost(a: RunCost, b: RunCost): RunCost {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    webSearchCalls: a.webSearchCalls + b.webSearchCalls,
    microUsd: a.microUsd + b.microUsd,
  };
}

function skillOverrides(): Record<string, { model?: string; effort?: Effort }> {
  const raw = process.env.AGENT_SKILL_MODELS;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** THE model choice for a skill. */
/**
 * The reasoning effort as the provider accepts it. The contract's vocabulary is minimal | low | medium | high; the
 * model pages (developers.openai.com/api/docs/models, checked 9 Oct 2026) list:
 *   gpt-6.1-sol  low, medium, high, xhigh, max          (no "minimal", no "none")
 *   gpt-6-luna   none, low, medium, high, xhigh, max    (no "minimal")
 * So "minimal" goes out as the lowest effort the model supports ("none" on luna, "low" on sol); every other contract
 * value goes out as is. An unlisted model gets "low" for "minimal".
 */
const LOWEST_EFFORT: Record<string, string> = { "gpt-6.1-sol": "low", "gpt-6-sol": "low", "gpt-6-luna": "none", "gpt-6-astra": "low" };
export function wireEffort(model: string, effort: Effort): string {
  return effort === "minimal" ? LOWEST_EFFORT[model] ?? "low" : effort;
}

/** Which provider serves a model id: `gemini-*` is Gemini on Vertex; everything else is OpenAI. */
export function providerOf(model: string): ModelProvider {
  return /^gemini-/i.test(model) ? "gemini" : "openai";
}

export function modelFor(skill: Pick<Skill, "id" | "model" | "effort"> & { tools?: readonly string[] }): ModelChoice {
  const override = skillOverrides()[skill.id] ?? {};
  const tierModel: Record<ModelTier, string> = { reasoning: AGENT_MODELS.reasoning, fast: AGENT_MODELS.fast, cheap: AGENT_MODELS.cheap };
  const effort = override.effort && (EFFORTS as readonly string[]).includes(override.effort) ? override.effort : skill.effort;
  const model = override.model || tierModel[skill.model];
  const provider = providerOf(model);
  // Search stays on OpenAI by rule: a searching skill resolved to Gemini is a configuration error, not a quiet downgrade.
  if (provider === "gemini" && skill.tools?.includes("web_search")) {
    throw new Error(`${skill.id} uses web_search, which stays on OpenAI; it cannot run on ${model}. Fix its tier or AGENT_SKILL_MODELS`);
  }
  return { provider, model, effort };
}
