/**
 * services/quickScore/step.ts — the signup_research v3 `quick_score` step: the one web-searching call (oneCall.ts) for a
 * sign-up, beside her two research passes, so she sees an M.I.A. read about a minute after joining while the full
 * record (research → merge → mia_preview) still builds in the background, unchanged.
 *
 * Reads (no write to her memory): her said facts (written when the run was created: name, sport, school or team,
 * handles) and her connected accounts' latest numbers, rendered by the existing block renderer IN MEMORY (no measured
 * fact is written here; the merge step syncs them as before).
 *
 * Writes, and only these:
 *   agent_runs   one row per call (skill mia/quick-score): tokens, web searches, cost — so the daily sign-up cap
 *                counts it — and a minimal output (status, score, confidence; never the answer text or the sources).
 *                Its parent ref makes a retried step reuse it: a step that already called never calls again.
 *   step output  the quick score for HER display (the landing reads it through GET /waitlist/progress): score, the
 *                method's reason lines, confidence and the cited sources (title + link, shown as clickable links).
 * Never memory_facts: the searched answer is never stored as her facts, never fed to another model.
 *
 * Never fails the run: any error ends as { status: "fallback" } and the existing path is the only score.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logger";
import { wireEffort } from "../../agent/models";
import { dbStore } from "../../agent/research/dbStore";
import { loadConnectedChannels, measuredFactsFrom } from "../../agent/research/connected";
import type { StepCtx, StepDef } from "../../workflow/types";
import type { RunCost } from "../../../shared/agent";
import { loadBeta1Params } from "../marketabilityBeta1Params";
import { createBeta1Normalizer } from "../marketabilityBeta1Normalization";
import { composeBlock, loadMemoryFacts, measuredAccounts, selectPreviewFacts, type PreviewFact } from "../miaPreview/memoryAdapter";
import {
  QUICK_SCORE_MAX_SEARCHES, QUICK_SCORE_SEARCH_CONTEXT, quickScoreMaxOutputTokens, quickScoreMaxUsd, quickScoreMinSources, quickScoreModel, quickScoreOneCallEnabled, quickScoreTimeoutMs,
} from "./config";
import { resultCostUsd, runQuickScore, type GroundedCall, type GroundedProvider, type QuickScoreAttempt, type QuickScoreInput, type ScoringContext } from "./oneCall";
import { isPlatformCapError } from "../../lib/platformSpend";

const logger = createLogger("quick-score");

export const QUICK_SCORE_STEP_NAME = "quick_score";
export const QUICK_SCORE_SKILL_ID = "mia/quick-score";
export const QUICK_SCORE_SKILL_VERSION = "1.0.0";
export const quickScoreParentRef = (workflowRunId: string) => `${QUICK_SCORE_STEP_NAME}:workflow:${workflowRunId}`;

/**
 * The real call: OpenAI web search through the existing Responses helper (openaiWebSearch.ts runOpenAIOnce) on the
 * fast model, low search context, low reasoning, a search cap, a token ceiling and a timeout. No system instruction:
 * the frozen M.I.A. prompt is the whole request, as it was on Gemini. An answer cut at the ceiling reads MAX_TOKENS
 * (oneCall.ts refuses it, as before).
 */
/** The URL without the utm_* tags the search tool appends. */
function stripUtm(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return raw; }
}
const hostOf = (raw: string): string => { try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return ""; } };

export const openaiQuickScoreProvider: GroundedProvider = async (req) => {
  const t0 = Date.now();
  // Loaded at call time: the workflow definitions import this module, and the helper's own load (it builds its system
  // text from geminiGrounded.ts) must not join every importer's module graph.
  const { runOpenAIOnce } = await import("../../lib/research/providers/openaiWebSearch");
  const r = await runOpenAIOnce(req.prompt, "", {
    model: req.model, contextSize: QUICK_SCORE_SEARCH_CONTEXT, maxToolCalls: req.maxSearches, maxOutputTokens: req.maxOutputTokens,
    effort: wireEffort(req.model, "low"), timeoutMs: req.timeoutMs, includeSources: true, store: false,
  });
  const reasoning = r.reasoningTokens ?? 0;
  const call: GroundedCall = {
    text: r.text, finishReason: r.finishReason === "incomplete:max_output_tokens" ? "MAX_TOKENS" : (r.finishReason ?? null), ms: Date.now() - t0,
    usage: { input: r.promptTokens ?? 0, cached: r.cachedTokens ?? 0, output: Math.max(0, (r.completionTokens ?? 0) - reasoning), thinking: reasoning, queries: r.searchCalls ?? 0 },
    // The inline citations first, then every other page the searches consulted: a JSON answer carries few or no inline
    // citations, and Gemini's groundingChunks (what this replaced) listed every page the search used. The utm_ tags the
    // search appends are removed, so a page both cited and consulted is one source (oneCall.ts distinctSources).
    // A consulted page often comes without a title: its host name stands in, so a chip is never blank.
    sources: [...r.citations, ...(r.searchSources ?? [])].filter((c) => c.url).map((c) => ({ uri: stripUtm(c.url), title: c.title || hostOf(c.url) })),
    queries: r.searchQueries,
  };
  return call;
};

/** Measured NewFacts as in-memory PreviewFacts (nothing written), for the existing block renderer. */
function asPreviewFacts(facts: ReturnType<typeof measuredFactsFrom>): PreviewFact[] {
  const now = new Date().toISOString();
  return facts.map((f) => ({
    id: randomUUID(), type: "measured", status: "active", claim: f.claim, subjectKind: f.subject.kind, subjectName: f.subject.name ?? "",
    sourceUrl: f.source.url ?? null, sourceRef: f.source.ref ?? null, sourceTitle: f.source.title ?? null, observedOn: f.date ?? null,
    confidence: f.confidence, sensitive: false, careKind: null, disputes: null, createdAt: now,
  }));
}

/** Her input: name + sport (the run's anchor), said facts, and the connected block (fresh readings, else measured memory). */
export async function quickScoreInputFor(athleteId: string, anchor: { name: string; sport: string }): Promise<QuickScoreInput> {
  const facts = await loadMemoryFacts(athleteId, ["active"]);
  const said = facts.filter((f) => f.type === "said").map((f) => f.claim);
  const channels = await loadConnectedChannels(athleteId);
  let measured = asPreviewFacts(measuredFactsFrom(channels, anchor.name));
  if (!measured.length) measured = selectPreviewFacts(facts).measured;
  const handles = new Map<string, string>(channels.filter((c) => c.handle).map((c) => [c.platform, String(c.handle).replace(/^@+/, "")]));
  const accounts = measuredAccounts(measured, handles, new Set()).map((m) => m.account);
  return { athleteId, name: anchor.name, sport: anchor.sport, said, socialBlock: composeBlock(accounts, []) };
}

async function scoringContext(): Promise<ScoringContext> {
  const { params, bundle } = await loadBeta1Params();
  const normalizer = createBeta1Normalizer(bundle);
  return { params, subWeights: params.config.subWeights, prior: (p, s) => normalizer.prior(p as never, s as never) as any };
}

const costOf = (a: QuickScoreAttempt): RunCost => ({
  inputTokens: a.usage.input, cachedInputTokens: a.usage.cached, outputTokens: a.usage.output, reasoningTokens: a.usage.thinking,
  webSearchCalls: a.usage.queries, microUsd: Math.round(a.costUsd * 1_000_000),
});

export interface QuickScoreDeps { provider?: GroundedProvider; scoring?: () => Promise<ScoringContext>; now?: () => Date }

/** The step's body (exported for tests; the provider and scoring context are injectable). */
export async function runQuickScoreStep(ctx: StepCtx, deps: QuickScoreDeps = {}): Promise<Record<string, unknown>> {
  if (!quickScoreOneCallEnabled()) return { status: "off", reason: "flag_off" };
  const athleteId = ctx.athleteId!;
  // Outside the run's own "workflow:<id>" prefix on purpose: the research passes' per-run cap (workflow.ts jobCtx) is not
  // shrunk by this call, so the background research is exactly as before. The daily sign-up cap still counts it.
  const parentRef = quickScoreParentRef(ctx.runId);
  try {
    // A step that already called (a lease expired, the runner retried) never calls again: its record stands.
    const prior = await dbStore.listRunsByPrefix(athleteId, parentRef);
    if (prior.length) {
      const done = prior.find((r) => r.status === "completed");
      return { status: "fallback", reason: "already_attempted", quick: true, prior_status: (done?.output as any)?.status ?? null };
    }
    const anchor = (ctx.runInput ?? {}) as { name?: string; sport?: string };
    if (!anchor.name || !anchor.sport) return { status: "fallback", reason: "no_anchor" };
    const input = await quickScoreInputFor(athleteId, { name: anchor.name, sport: anchor.sport });
    const scoring = await (deps.scoring ?? scoringContext)();
    const model = quickScoreModel();
    const record = async (a: QuickScoreAttempt) => {
      const id = await dbStore.startRun({ athleteId, skillId: QUICK_SCORE_SKILL_ID, skillVersion: QUICK_SCORE_SKILL_VERSION, trigger: "event", model: { provider: "openai", model, effort: "low" }, parentRef: `${parentRef}#${a.n}` });
      await dbStore.finishRun(athleteId, id, {
        status: a.ok ? "completed" : "failed", stopReason: a.ok ? null : "error", cost: costOf(a),
        steps: [{ seq: 0, at: new Date().toISOString(), type: "model", model: { provider: "openai", model, effort: "low" }, cost: costOf(a), durationMs: a.ms }],
        evidenceRead: [], output: { quick: true, attempt: a.n, ok: a.ok, finish_reason: a.finishReason }, error: a.error,
      });
    };
    const r = await runQuickScore(deps.provider ?? openaiQuickScoreProvider, input, scoring, {
      model, maxOutputTokens: quickScoreMaxOutputTokens(), maxSearches: QUICK_SCORE_MAX_SEARCHES, timeoutMs: quickScoreTimeoutMs(), maxUsd: quickScoreMaxUsd(),
      minSources: quickScoreMinSources(), asOf: (deps.now?.() ?? new Date()).toISOString(),
    }, record);
    const meta = { quick: true, search: "openai_web_search", model, attempts: r.attempts.length, cost_usd: Math.round(resultCostUsd(r) * 10_000) / 10_000, ms: r.attempts.reduce((s, a) => s + a.ms, 0) };
    logger.info({ athleteId, runId: ctx.runId, status: r.status, ...meta }, "quick score");
    if (r.status === "ready") {
      return {
        status: "ready", ...meta, score: r.score, confidence: r.confidence, low_confidence: r.lowConfidence, reasons: r.reasons,
        dimensions: r.dimensions, identity_confidence: r.identityConfidence,
        // For HER display only: the cited pages, shown as clickable links with the score (never stored as facts, never fetched).
        display: { sources: r.display.sources.slice(0, 20) },
      };
    }
    if (r.status === "withheld_identity") return { status: "withheld_identity", ...meta, identity_confidence: r.identityConfidence };
    return { status: "fallback", ...meta, reason: r.reason, errors: r.attempts.map((a) => a.error).filter(Boolean) };
  } catch (err: any) {
    // The platform day cap's refusal is rethrown: the runner HOLDS this step (it runs again when there is room).
    if (isPlatformCapError(err)) throw err;
    logger.warn({ athleteId, runId: ctx.runId, error: String(err?.message ?? err).slice(0, 200) }, "quick score failed: the existing path scores her");
    return { status: "fallback", reason: "error", error: String(err?.message ?? err).slice(0, 200) };
  }
}

/** The workflow step. No runner retry (the step retries the call itself, once); a lease long enough for two calls. */
export const QUICK_SCORE_STEP: StepDef = {
  name: QUICK_SCORE_STEP_NAME, kind: "model", parallel: true, leaseMs: 6 * 60_000, retry: { maxAttempts: 1 },
  run: (ctx) => runQuickScoreStep(ctx),
};
