/**
 * services/quickScore/oneCall.ts — the sign-up QUICK SCORE: ONE web-searching call → identity, M.I.A. score, reasons
 * and the pages the search cited (owner decision, 26 Oct 2026; moved to OpenAI web search 4 Nov 2026, "one search
 * provider": gpt-6-luna, low search context, at most QUICK_SCORE_MAX_SEARCHES searches, through the existing
 * lib/research/providers/openaiWebSearch.ts runOpenAIOnce).
 *
 * WHAT IT IS: setup 1 "gemini_one_call" of the comparison harness (draft PR #1129, server/scripts/research/
 * searchScoreEval.lib.ts runGeminiOneCall / frozenPrompt / saidBlock / scoreFrom), promoted to a production path with the
 * same prompt, the same parser and the same scorer:
 *   prompt   the EXISTING search-enabled M.I.A. evaluator prompt, word for word (marketabilityBeta1Snapshot promptFor →
 *            blindEvalPromptV02), with her connected-account block (the existing renderer) and her said facts (the
 *            research step's own heading) as its evidence block — nothing else is added
 *   call     the fast OpenAI model (gpt-6-luna) on the Responses API with the web_search tool, low search context,
 *            low reasoning effort, a tool-call cap, an output ceiling and a timeout (step.ts openaiQuickScoreProvider)
 *   parse    parseEvaluatorResponse (the M.I.A. parser: a malformed answer, or one with no signal scored, is refused —
 *            never repaired)
 *   score    buildBeta1Dimensions → computeMarketabilityBeta1 with the active params (what scoreAndRecord computes)
 *
 * RELIABILITY: a refused or failed answer is retried ONCE, only while the step's cost cap leaves room for one more
 * worst-case call; then the step gives up (status "fallback") and the existing research + scorer are the only score.
 * Every call has a token ceiling (thinking included) and a timeout.
 *
 * THIN COVERAGE: fewer than QUICK_SCORE_MIN_SOURCES distinct cited sources, or the method's own overall confidence
 * LOW, ⇒ confidence "low". Nothing is filled in: a signal the model did not score stays missing (the parser's rule).
 *
 * IDENTITY: the method's own identity_confidence LOW ⇒ the score is withheld (a namesake's score is never shown as hers).
 *
 * SOURCES: the pages the search cited are shown to her as clickable links beside the score (OpenAI's web-search terms
 * ask for visible, clickable citations wherever search results are shown). Nothing here writes memory facts, and the
 * answer text is never handed to another model or a fetcher. The raw answer is never stored; see step.ts for what is kept.
 *
 * Generic: nothing names an athlete, sport, school, league or brand.
 */
import { promptFor } from "../marketabilityBeta1Snapshot";
import { parseEvaluatorResponse, type EvaluatorOutput } from "../marketabilityBeta1Evaluator";
import { buildBeta1Dimensions, type Beta1PriorFn } from "../marketabilityBeta1Freeze";
import { computeMarketabilityBeta1, type MarketabilityBeta1Input, type MarketabilityBeta1Params } from "../marketabilityBeta1";
import { costOf } from "../../agent/models";
import { isPlatformCapError } from "../../lib/platformSpend";

// ── the input ────────────────────────────────────────────────────────────────

export interface QuickScoreInput {
  athleteId: string;
  name: string;
  sport: string;
  /** What she told us (said facts), one line each. */
  said: string[];
  /** Her connected accounts' block (memoryAdapter composeBlock), or null when none is connected/read. */
  socialBlock: string | null;
}

/** The heading research.ts already uses for said facts. Prompt Register: research › "M.I.A. quick score (one grounded call)". */
export const SAID_HEADING = "WHAT THE ATHLETE HAS TOLD US (said; anchors identity)";

/** Her said facts under research.ts's own heading (PR #1129 saidBlock, unchanged). */
export function saidBlock(said: string[]): string {
  return `${SAID_HEADING}\n${said.length ? said.map((s) => `- ${s}`).join("\n") : "- (none yet)"}`;
}

/** The frozen (search-enabled) M.I.A. prompt, verbatim, with the connected block and said facts as its evidence block (PR #1129 frozenPrompt). */
export function quickScorePrompt(a: Pick<QuickScoreInput, "name" | "sport" | "said" | "socialBlock">): string {
  const block = [a.socialBlock, saidBlock(a.said)].filter(Boolean).join("\n\n");
  return promptFor({ name: a.name, sport: a.sport, socialBlock: block });
}

// ── the provider (injected; tests mock it) ───────────────────────────────────

/** One call's usage: output EXCLUDES thinking (reasoning tokens are counted apart); queries = web searches run. */
export interface GroundedUsage { input: number; cached: number; output: number; thinking: number; queries: number }
export interface GroundedSource { uri: string; title: string }
export interface GroundedCall {
  text: string;
  finishReason: string | null;
  usage: GroundedUsage;
  ms: number;
  /** The pages behind the answer: its inline citations (url_citation), then every page its searches consulted (action.sources). */
  sources: GroundedSource[];
  queries: string[];
}
export interface GroundedRequest { model: string; prompt: string; maxOutputTokens: number; maxSearches: number; timeoutMs: number }
export type GroundedProvider = (req: GroundedRequest) => Promise<GroundedCall>;

/** USD for one call at list price (agent/models.ts costOf: the model's token rates plus each web-search call's fee). */
export function callCostUsd(u: GroundedUsage, model: string): number {
  return costOf(model, { inputTokens: u.input, cachedInputTokens: u.cached, outputTokens: u.output + u.thinking, reasoningTokens: u.thinking, webSearchCalls: u.queries }).microUsd / 1_000_000;
}

/**
 * The most one call can cost given its token ceiling and its search cap: input estimated from the prompt (~4 chars a
 * token) plus the search content a low-context search adds (a generous 8k tokens a search), every search used.
 */
export function worstCaseCallUsd(promptChars: number, maxOutputTokens: number, model: string, maxSearches: number): number {
  return callCostUsd({ input: Math.ceil(promptChars / 4) + 8_000 * maxSearches, cached: 0, output: maxOutputTokens, thinking: 0, queries: maxSearches }, model);
}

// ── scoring (the orchestrator's own functions) ───────────────────────────────

export interface ScoringContext { params: MarketabilityBeta1Params; subWeights: Record<string, Record<string, number>>; prior: Beta1PriorFn }

// ── the result ───────────────────────────────────────────────────────────────

export type QuickConfidence = "low" | "medium" | "high";
export interface QuickScoreDimension { key: string; score: number; weight: number; contribution: number }
export interface QuickScoreAttempt { n: number; ok: boolean; error: string | null; ms: number; costUsd: number; usage: GroundedUsage; finishReason: string | null }

export type QuickScoreResult =
  | {
    status: "ready";
    score: number;
    confidence: QuickConfidence;
    /** True when coverage was thin (few cited sources) or the method's own overall confidence was LOW. */
    lowConfidence: boolean;
    /** The method's own words: its strengths and constraints notes, else its summary (at most three). */
    reasons: string[];
    dimensions: QuickScoreDimension[];
    identityConfidence: string | null;
    display: { sources: GroundedSource[] };
    attempts: QuickScoreAttempt[];
  }
  | { status: "withheld_identity"; identityConfidence: string | null; attempts: QuickScoreAttempt[] }
  | { status: "fallback"; reason: "invalid_response" | "call_failed" | "cost_cap"; attempts: QuickScoreAttempt[] };

export const resultCostUsd = (r: { attempts: QuickScoreAttempt[] }) => r.attempts.reduce((s, a) => s + a.costUsd, 0);

const CONF: Record<string, QuickConfidence> = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

/** Distinct sources by URI (the answer may cite one page several times). */
export function distinctSources(sources: GroundedSource[]): GroundedSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => s.uri && !seen.has(s.uri) && (seen.add(s.uri), true));
}

/** Pure: the method's confidence, lowered to "low" for thin coverage. Never raised. */
export function confidenceFor(out: EvaluatorOutput, sourceCount: number, minSources: number): { confidence: QuickConfidence; low: boolean } {
  const method = CONF[out.overallConfidence?.level ?? ""] ?? "low";
  const thin = sourceCount < minSources;
  return thin ? { confidence: "low", low: true } : { confidence: method, low: method === "low" };
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** Pure: up to three of the method's own lines — first strength, first constraint, else the summary. */
export function reasonsFrom(out: EvaluatorOutput): string[] {
  const out3: string[] = [];
  for (const c of [out.keyStrengths[0], out.keyConstraints[0], out.summary, out.keyStrengths[1]]) {
    const l = clean(c);
    if (l && !out3.some((x) => x.toLowerCase() === l.toLowerCase())) out3.push(l.slice(0, 400));
    if (out3.length === 3) break;
  }
  return out3;
}

export interface RunOptions { model: string; maxOutputTokens: number; maxSearches: number; timeoutMs: number; maxUsd: number; minSources: number; asOf: string }

/**
 * Make the call (at most twice) and score the answer. Never throws for a provider or parse failure: those end as
 * status "fallback". `onAttempt` is told about every call that was made (for cost recording), success or not.
 */
export async function runQuickScore(
  provider: GroundedProvider, input: QuickScoreInput, ctx: ScoringContext, opts: RunOptions,
  onAttempt: (a: QuickScoreAttempt) => Promise<void> = async () => undefined,
): Promise<QuickScoreResult> {
  const prompt = quickScorePrompt(input);
  const worst = worstCaseCallUsd(prompt.length, opts.maxOutputTokens, opts.model, opts.maxSearches);
  const attempts: QuickScoreAttempt[] = [];
  let lastReason: "invalid_response" | "call_failed" = "call_failed";
  for (let n = 1; n <= 2; n++) {
    const spent = attempts.reduce((s, a) => s + a.costUsd, 0);
    if (spent + worst > opts.maxUsd) {
      return { status: "fallback", reason: "cost_cap", attempts };
    }
    let call: GroundedCall;
    const t0 = Date.now();
    try {
      call = await provider({ model: opts.model, prompt, maxOutputTokens: opts.maxOutputTokens, maxSearches: opts.maxSearches, timeoutMs: opts.timeoutMs });
    } catch (err: any) {
      // The platform day cap refused the call before it was made: nothing was spent, and the step is HELD (rethrown).
      if (isPlatformCapError(err)) throw err;
      // A timeout or transport error. The tokens of an aborted call are unknown: count it at its worst case.
      const a: QuickScoreAttempt = { n, ok: false, error: String(err?.message ?? err).slice(0, 200), ms: Date.now() - t0, costUsd: worst, usage: { input: 0, cached: 0, output: 0, thinking: 0, queries: 0 }, finishReason: null };
      attempts.push(a); await onAttempt(a);
      lastReason = "call_failed";
      continue;
    }
    const costUsd = callCostUsd(call.usage, opts.model);
    let out: EvaluatorOutput;
    try {
      if (call.finishReason === "MAX_TOKENS") throw new Error("the answer hit the token ceiling");
      out = parseEvaluatorResponse(call.text, ctx.subWeights);
    } catch (err: any) {
      const a: QuickScoreAttempt = { n, ok: false, error: String(err?.message ?? err).slice(0, 200), ms: call.ms, costUsd, usage: call.usage, finishReason: call.finishReason };
      attempts.push(a); await onAttempt(a);
      lastReason = "invalid_response";
      continue;
    }
    const a: QuickScoreAttempt = { n, ok: true, error: null, ms: call.ms, costUsd, usage: call.usage, finishReason: call.finishReason };
    attempts.push(a); await onAttempt(a);
    if (out.identityConfidence === "LOW") return { status: "withheld_identity", identityConfidence: out.identityConfidence, attempts };
    const sources = distinctSources(call.sources);
    const dims = buildBeta1Dimensions({ signals: out.judgements } as any, input.sport, ctx.prior, ctx.subWeights, opts.asOf) as MarketabilityBeta1Input["dimensions"];
    const r = computeMarketabilityBeta1({ athleteId: input.athleteId, asOf: opts.asOf, dimensions: dims }, ctx.params);
    const { confidence, low } = confidenceFor(out, sources.length, opts.minSources);
    return {
      status: "ready", score: Math.max(0, Math.min(850, Math.round(r.score))), confidence, lowConfidence: low, reasons: reasonsFrom(out),
      dimensions: r.dimensions.map((d) => ({ key: d.dimension, score: d.score, weight: d.weight, contribution: d.contribution })),
      identityConfidence: out.identityConfidence, display: { sources }, attempts,
    };
  }
  return { status: "fallback", reason: lastReason, attempts };
}
