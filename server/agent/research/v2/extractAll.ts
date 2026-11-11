/**
 * agent/research/v2/extractAll.ts — the two model steps of LEAN research (v2/lean.ts; signup_research v4 behind
 * LEAN_SIGNUP_RESEARCH, and the leanRun command), ported from the 26 Oct 2026 research bake-off (draft PR #1135):
 *
 *   extractAll  — the research/extract-all skill (research/extract 1.1.0 with rule 3 "extract every verifiable fact"
 *                 instead of "at most 30") on an explicit model and effort (default gpt-6.1-sol at low, the bake-off's
 *                 pick). Its answer goes through the same checks as every research pass (research.ts passResultFrom:
 *                 privacy drops, the cited URL must be one of the passages, the subject must be named), with a higher cap.
 *   verifyFacts — research/verify-facts 1.1.0: a separate cheap pass that reads each fact beside the exact text of the
 *                 page it cites and drops what that text does not support. 1.1.0 fixes the bake-off's main false
 *                 negative: a fact dated with the PAGE date (extract rule 6, when the passage gives none) is labelled
 *                 "(page date)" and the verifier no longer holds the claim to that date.
 *
 * Both steps call the model through a LeanModelCall, so the same code runs two ways:
 *   skillModelCall   the workflow (LIVE): runSkill — an agent_runs row with its cost (the per-run and daily caps count
 *                    it), keyed by parent ref so a retried step never pays twice;
 *   directModelCall  the leanRun command (SHADOW): callStructured straight to the provider — no agent_runs row,
 *                    nothing about any athlete written anywhere.
 */
import type { EvidenceRef, MemoryFact, ModelChoice, RunCost } from "../../../../shared/agent";
import type { JsonSchema } from "../../../../shared/agent";
import { loadJob } from "../../jobs";
import { callStructured } from "../llm";
import { runSkill } from "../runSkill";
import { dropPrivate } from "../privacy";
import { modelFor } from "../../models";
import { passResultFrom, type AthleteIdentity, type PassFact } from "../research";
import type { AgentStore } from "../store";
import { EXTRACT_SCHEMA, candidatesOf, extractInput, type ExtractResult } from "./extract";
import type { Passage } from "./rank";
import type { ResearchMoment } from "./plan";

export const EXTRACT_ALL_SKILL_ID = "research/extract-all";
export const VERIFY_SKILL_ID = "research/verify-facts";
/** The most facts one extract-all answer may hold (schema maxItems and the code cap). */
export const EXTRACT_ALL_MAX_FACTS = 150;
/** Output budget for extract-all: every fact rather than 30, plus reasoning tokens. */
export const EXTRACT_ALL_MAX_OUTPUT_TOKENS = 32_000;
export const VERIFY_MAX_OUTPUT_TOKENS = 16_000;

/** EXTRACT_SCHEMA with the facts cap raised to EXTRACT_ALL_MAX_FACTS (everything else identical). */
export const EXTRACT_ALL_SCHEMA: JsonSchema = (() => {
  const s = JSON.parse(JSON.stringify(EXTRACT_SCHEMA));
  s.properties.facts.maxItems = EXTRACT_ALL_MAX_FACTS;
  return s;
})();

export const VERIFY_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "verdict", "reason"],
        properties: { id: { type: "string" }, verdict: { type: "string", enum: ["supported", "not_supported"] }, reason: { type: "string" } },
      },
    },
  },
} as JsonSchema;

export const ZERO_COST: RunCost = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 0 };

// ── the model call seam ──────────────────────────────────────────────────────

export type Sanitize = (json: any) => { json: any; dropped: number; overCap?: number; drops?: Array<{ category: string; reason: string; source_url: string | null }> };

export interface LeanCallRequest {
  /** Which lean step (parent ref suffix in live mode). */
  step: "extract" | "verify" | "extract2" | "verify2";
  skillId: string;
  input: string;
  schemaName: string;
  schema: JsonSchema;
  maxOutputTokens: number;
  /** Null: the skill's own tier (modelFor; AGENT_SKILL_MODELS overrides apply). */
  model: ModelChoice | null;
  sanitize?: Sanitize;
  evidenceRead?: EvidenceRef[];
}
export interface LeanCallResult { runId: string | null; json: any; cost: RunCost; reused: boolean; ms: number; model: ModelChoice }
export type LeanModelCall = (req: LeanCallRequest) => Promise<LeanCallResult>;

/** SHADOW: straight to the provider (no agent_runs row). `call` is injectable for tests. */
export function directModelCall(call: typeof callStructured = callStructured): LeanModelCall {
  return async (req) => {
    const skill = loadJob(req.skillId);
    const model = req.model ?? modelFor(skill);
    const t0 = Date.now();
    const r = await call({ skill, model, input: req.input, schemaName: req.schemaName, schema: req.schema, maxOutputTokens: req.maxOutputTokens });
    const json = req.sanitize ? req.sanitize(r.json).json : r.json;
    return { runId: null, json, cost: r.cost, reused: false, ms: Date.now() - t0, model };
  };
}

/** LIVE: through runSkill (an agent_runs row, cost recorded, parent ref `<prefix>:lean_<step>` → a retry reuses it). */
export function skillModelCall(o: { store: AgentStore; athleteId: string; parentPrefix: string; budget?: { spentMicroUsd: number; capMicroUsd: number } }): LeanModelCall {
  return async (req) => {
    const model = req.model ?? modelFor(loadJob(req.skillId));
    const t0 = Date.now();
    const r = await runSkill({
      store: o.store, athleteId: o.athleteId, skillId: req.skillId, trigger: "event", parentRef: `${o.parentPrefix}:lean_${req.step}`,
      input: req.input, schemaName: req.schemaName, schema: req.schema, maxOutputTokens: req.maxOutputTokens, model,
      ...(o.budget ? { budget: o.budget } : {}), ...(req.sanitize ? { sanitize: req.sanitize } : {}), ...(req.evidenceRead ? { evidenceRead: req.evidenceRead } : {}),
    });
    return { runId: r.runId, json: r.json, cost: r.reused ? ZERO_COST : r.cost, reused: r.reused, ms: Date.now() - t0, model };
  };
}

// ── extract ──────────────────────────────────────────────────────────────────

export interface ExtractAllOutcome {
  result: ExtractResult;
  /** Facts in the model's answer before any check (unknown, -1, when a retried step reused a stored run). */
  raw: number;
  /** Facts the privacy rules dropped (never stored). */
  privacyDropped: number;
  cost: RunCost;
  ms: number;
  model: ModelChoice;
  runId: string | null;
}

export async function extractAll(opts: {
  athlete: AthleteIdentity; known: MemoryFact[]; passages: Passage[]; today: string; moment?: ResearchMoment; model: ModelChoice | null; call: LeanModelCall;
}): Promise<ExtractAllOutcome> {
  let raw = -1, privacyDropped = 0;
  const r = await opts.call({
    step: "extract", skillId: EXTRACT_ALL_SKILL_ID, model: opts.model,
    input: extractInput(opts.athlete, opts.known, opts.passages, opts.today, opts.moment ?? "signup"),
    schemaName: "research_extract", schema: EXTRACT_ALL_SCHEMA, maxOutputTokens: EXTRACT_ALL_MAX_OUTPUT_TOKENS,
    sanitize: (json) => {
      raw = Array.isArray(json?.facts) ? json.facts.length : 0;
      const d = dropPrivate(json, "facts", EXTRACT_ALL_MAX_FACTS);
      privacyDropped = d.dropped;
      return d;
    },
    evidenceRead: opts.passages.map((p) => ({ kind: "url" as const, url: p.url, ...(p.title ? { title: p.title } : {}) })),
  });
  // The pages we fetched are the run's sources: a fact may cite only one of them.
  const sources = [...new Map(opts.passages.map((p) => [p.url, { url: p.url, title: p.title }])).values()];
  const pass = passResultFrom({ runId: r.runId ?? "shadow", json: r.json, sources, reused: r.reused, cost: r.cost }, opts.athlete, "a", "v", EXTRACT_ALL_MAX_FACTS);
  return { result: { ...pass, candidates: candidatesOf(r.json, opts.passages) }, raw, privacyDropped, cost: r.cost, ms: r.ms, model: r.model, runId: r.runId };
}

// ── verify ───────────────────────────────────────────────────────────────────

/** Pure: is `factDate` (YYYY, YYYY-MM or YYYY-MM-DD) the page's own date, or a coarser form of it? */
export function isPageDate(factDate: string | null | undefined, pageDate: string | null | undefined): boolean {
  const f = (factDate ?? "").trim(), p = (pageDate ?? "").trim().slice(0, 10);
  return !!f && !!p && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(f) && p.startsWith(f);
}

/**
 * Pure: the verifier's input. Each cited page appears ONCE (all of its passages the extract step read, in order), as
 * V1, V2 …, with the page's own date; each fact names the source it cites. A fact dated with its page's own date is
 * labelled "(page date)" (verify-facts 1.1.0 rule 3: the label is not part of the claim). Facts whose URL is not among
 * the passages never reach here (the extract checks drop them).
 */
export function verifyInput(facts: Array<Pick<PassFact, "claim" | "date" | "source_url">>, passages: Passage[]): { input: string; ids: string[] } {
  const urls = [...new Set(facts.map((f) => f.source_url))];
  const vid = new Map(urls.map((u, i) => [u, `V${i + 1}`]));
  const pageDate = new Map<string, string | null>();
  for (const p of passages) if (!pageDate.get(p.url)) pageDate.set(p.url, p.date ?? null);
  const ids = facts.map((_, i) => `F${i + 1}`);
  const sources = urls.map((u) => {
    const text = passages.filter((p) => p.url === u).map((p) => p.text).join("\n\n");
    return [`[${vid.get(u)}] URL: ${u}`, `Page date: ${pageDate.get(u) ?? "unknown"}`, text || "(no text)", ""].join("\n");
  });
  const dateLabel = (f: Pick<PassFact, "date" | "source_url">) => {
    if (!f.date) return "";
    return isPageDate(f.date, pageDate.get(f.source_url)) ? ` | date ${f.date} (page date)` : ` | date ${f.date}`;
  };
  const lines = facts.map((f, i) => `${ids[i]} | source ${vid.get(f.source_url)} | ${f.claim}${dateLabel(f)}`);
  return { input: ["SOURCES", ...sources, "FACTS", ...lines].join("\n"), ids };
}

export interface VerifyOutcome {
  kept: PassFact[];
  dropped: Array<{ claim: string; source_url: string; reason: string }>;
  /** Facts the verifier gave no verdict for (dropped: unchecked is not supported). */
  unanswered: number;
  cost: RunCost;
  ms: number;
  model: ModelChoice | null;
  runId: string | null;
}

/** Pure: verdicts → kept / dropped. A fact with no verdict is dropped and counted as unanswered. */
export function applyVerdicts(facts: PassFact[], ids: string[], json: unknown): Pick<VerifyOutcome, "kept" | "dropped" | "unanswered"> {
  const verdict = new Map<string, { verdict: string; reason: string }>();
  for (const r of Array.isArray((json as any)?.results) ? (json as any).results : []) {
    if (r && typeof r.id === "string" && !verdict.has(r.id)) verdict.set(r.id, { verdict: String(r.verdict), reason: String(r.reason ?? "") });
  }
  const kept: PassFact[] = [];
  const dropped: VerifyOutcome["dropped"] = [];
  let unanswered = 0;
  facts.forEach((f, i) => {
    const v = verdict.get(ids[i]);
    if (!v) { unanswered++; dropped.push({ claim: f.claim, source_url: f.source_url, reason: "no verdict" }); return; }
    if (v.verdict === "supported") kept.push(f);
    else dropped.push({ claim: f.claim, source_url: f.source_url, reason: v.reason.slice(0, 300) });
  });
  return { kept, dropped, unanswered };
}

export async function verifyFacts(opts: { facts: PassFact[]; passages: Passage[]; model: ModelChoice | null; call: LeanModelCall }): Promise<VerifyOutcome> {
  if (!opts.facts.length) return { kept: [], dropped: [], unanswered: 0, cost: ZERO_COST, ms: 0, model: null, runId: null };
  const { input, ids } = verifyInput(opts.facts, opts.passages);
  const r = await opts.call({ step: "verify", skillId: VERIFY_SKILL_ID, model: opts.model, input, schemaName: "fact_verdicts", schema: VERIFY_SCHEMA, maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS });
  return { ...applyVerdicts(opts.facts, ids, r.json), cost: r.cost, ms: r.ms, model: r.model, runId: r.runId };
}
