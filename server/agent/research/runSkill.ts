/**
 * agent/research/runSkill.ts — run one structured skill call and leave a trace.
 *
 * Load the skill (jobs.ts) → pick its model (models.ts) → check the budget → start an agent_runs row → one
 * structured call → record the trace (skill, model + cost, web searches with their sources, errors) → finish the row
 * with the skill's JSON output. A finished run with the same parentRef is returned as is (a retried workflow step never
 * pays twice).
 *
 * Plumbing only: the judgement is the skill's; the caller validates the output against the facts it was given.
 */
import type { EvidenceRef, ModelChoice, RunCost, RunTrigger, TraceStep } from "../../../shared/agent";
import { createLogger } from "../../logger";
import { CostCapError } from "../../lib/spendErrors";
import { assertPlatformBudget } from "../../lib/platformSpend";
import { loadJob, promptDigest } from "../jobs";
import { modelFor, webSearchCallMicroUsd } from "../models";
import { callStructured, ModelCallError, type StructuredCallResult } from "./llm";
import type { AgentStore } from "./store";
import type { JsonSchema, ResearchEvent } from "../../../shared/agent";

const logger = createLogger("agent/research");

export { CostCapError };

export interface SkillRunRequest {
  store: AgentStore;
  athleteId: string;
  skillId: string;
  trigger: RunTrigger;
  parentRef: string | null;
  input: string;
  schemaName: string;
  schema: JsonSchema;
  webSearch?: { maxCalls: number; contextSize?: "low" | "medium" | "high" };
  maxOutputTokens?: number;
  /** Abort the model call (a caller's timeout or a client disconnect). */
  signal?: AbortSignal;
  /** What the run reads (facts, records) — recorded as evidence read. */
  evidenceRead?: EvidenceRef[];
  /**
   * Applied to the model's JSON BEFORE the run's output is stored (privacy drops, caps). What it removed is recorded
   * as a policy step in the trace — counts only, never the content.
   */
  sanitize?: (json: any) => { json: any; dropped: number; overCap?: number; drops?: Array<{ category: string; reason: string; source_url: string | null }> };
  /** An explicit model for this call (lean research's configurable extract and verify models); default: the skill's tier
   *  through modelFor (which honours AGENT_SKILL_MODELS). */
  model?: ModelChoice;
  /** Spend so far and the cap for the job this run belongs to (micro-dollars). The call is refused at or over it. */
  budget?: { spentMicroUsd: number; capMicroUsd: number };
  /**
   * Live events while the model works (research passes): turn each completed search, and the answer text so far, into
   * events the UI shows. They are kept on the running run (output.events) — flushed at most every LIVE_FLUSH_MS — so any
   * instance can serve them, and stay on the finished run.
   */
  live?: {
    onSearch?: (search: { queries: string[]; sources: Array<{ url: string; title?: string }> }) => ResearchEvent[];
    onText?: (textSoFar: string) => ResearchEvent[];
    onDone?: (json: any) => ResearchEvent[];
  };
  /**
   * Stop early and keep what there is (the waitlist sign-up's time budget). `check` is asked every `everyMs`; once it
   * says true the call is aborted and the run finishes COMPLETED (stop reason "aborted", output.cut = true) with
   * `salvage` of the answer streamed so far — so a later step that reuses this run (same parentRef) reads the partial
   * answer instead of calling the model again. The sources are the searches seen before the stop. Its cost is only the
   * searches seen: the provider reports token usage only on a completed response.
   */
  cut?: { check: () => Promise<boolean>; everyMs: number; salvage: (textSoFar: string) => any };
}

export const LIVE_FLUSH_MS = 1500;

export interface SkillRunResult {
  runId: string;
  json: any;
  cost: RunCost;
  sources: Array<{ url: string; title?: string }>;
  queries: string[];
  reused: boolean;
  /** True when `cut` stopped the call: json is the salvaged partial answer. */
  cut?: boolean;
}

export async function runSkill(req: SkillRunRequest): Promise<SkillRunResult> {
  if (req.parentRef) {
    const done = await req.store.findCompletedRun(req.athleteId, req.parentRef);
    if (done && done.output && typeof done.output === "object") {
      const out = done.output as { json?: unknown; sources?: Array<{ url: string; title?: string }>; queries?: string[] };
      return { runId: done.id, json: out.json, cost: done.cost, sources: out.sources ?? [], queries: out.queries ?? [], reused: true };
    }
  }
  if (req.budget && req.budget.spentMicroUsd >= req.budget.capMicroUsd) {
    throw new CostCapError(req.budget.spentMicroUsd, req.budget.capMicroUsd);
  }
  // The platform-wide day ceiling (lib/platformSpend.ts): refused for everyone once today's total reaches it.
  await assertPlatformBudget();

  const skill = loadJob(req.skillId);
  const model = req.model ?? modelFor(skill);
  const runId = await req.store.startRun({
    athleteId: req.athleteId, skillId: skill.id, skillVersion: skill.version, trigger: req.trigger, model, parentRef: req.parentRef,
  });
  const steps: TraceStep[] = [];
  let seq = 0;
  const at = () => new Date().toISOString();
  steps.push({ seq: seq++, at: at(), type: "skill", skillId: skill.id, version: skill.version, digest: promptDigest(skill) });

  let result: StructuredCallResult | null = null;
  const events: ResearchEvent[] = [];
  let lastFlush = 0;
  let flushing: Promise<void> = Promise.resolve();
  const addEvents = (evs: ResearchEvent[]) => {
    if (!evs.length) return;
    events.push(...evs);
    const now = Date.now();
    if (now - lastFlush >= LIVE_FLUSH_MS) {
      lastFlush = now;
      const snapshot = [...events];
      flushing = flushing.then(() => req.store.setRunOutput(req.athleteId, runId, { events: snapshot })).catch(() => undefined);
    }
  };
  // The early stop (req.cut): what was searched and streamed so far, kept so the stop can salvage it.
  const seen = { text: "", queries: [] as string[], sources: [] as Array<{ url: string; title?: string }>, searches: 0 };
  const cutter = req.cut ? new AbortController() : null;
  let wasCut = false;
  let cutTimer: ReturnType<typeof setInterval> | null = null;
  if (cutter && req.cut) {
    if (req.signal?.aborted) cutter.abort();
    else req.signal?.addEventListener("abort", () => cutter.abort(), { once: true });
    const check = req.cut.check;
    cutTimer = setInterval(() => {
      if (wasCut) return;
      check().then((stop) => { if (stop && !wasCut) { wasCut = true; cutter.abort(); } }).catch(() => undefined);
    }, req.cut.everyMs);
  }
  const t0 = Date.now();
  let failure: any = null;
  try {
    result = await callStructured({
      skill, model, input: req.input, schemaName: req.schemaName, schema: req.schema,
      webSearch: req.webSearch, maxOutputTokens: req.maxOutputTokens, signal: cutter?.signal ?? req.signal,
      ...(req.live?.onSearch || req.cut ? { onSearch: (s) => {
        seen.searches++; seen.queries.push(...s.queries);
        for (const x of s.sources) if (!seen.sources.some((y) => y.url === x.url)) seen.sources.push(x);
        if (req.live?.onSearch) addEvents(req.live.onSearch(s));
      } } : {}),
      ...(req.live?.onText || req.cut ? { onText: (t) => { seen.text = t; if (req.live?.onText) addEvents(req.live.onText(t)); } } : {}),
    });
    await flushing;
  } catch (err: any) {
    if (!(wasCut && req.cut)) failure = err;
    else {
      // Stopped on purpose: keep what there is. Usage is unknown (no completed response), so only the searches count.
      await flushing;
      let salvaged: unknown = null;
      try { salvaged = req.cut.salvage(seen.text); } catch { salvaged = null; }
      const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: seen.searches };
      result = {
        json: salvaged && typeof salvaged === "object" ? salvaged : {}, text: seen.text, status: "cut", responseId: null, usage,
        cost: { ...usage, microUsd: seen.searches * webSearchCallMicroUsd() }, queries: seen.queries, sources: seen.sources, durationMs: Date.now() - t0,
      };
    }
  } finally {
    if (cutTimer) clearInterval(cutTimer);
  }
  if (failure || !result) {
    const err = failure;
    const partial = err instanceof ModelCallError ? err.partial : undefined;
    const cost = partial?.cost ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 0 };
    if (partial?.cost) steps.push({ seq: seq++, at: at(), type: "model", model, cost, durationMs: partial.durationMs ?? 0 });
    if (partial?.queries?.length || partial?.sources?.length) steps.push({ seq: seq++, at: at(), type: "web_search", queries: partial.queries ?? [], sources: partial.sources ?? [] });
    steps.push({ seq: seq++, at: at(), type: "error", message: String(err?.message ?? err).slice(0, 500) });
    await req.store.finishRun(req.athleteId, runId, {
      status: "failed", stopReason: "error", cost, steps, evidenceRead: req.evidenceRead ?? [], output: null, error: String(err?.message ?? err).slice(0, 500),
    });
    logger.warn({ athleteId: req.athleteId, runId, skill: skill.id, costMicroUsd: cost.microUsd, error: String(err?.message ?? err).slice(0, 200) }, "agent skill run failed");
    throw err;
  }

  steps.push({ seq: seq++, at: at(), type: "model", model, cost: result.cost, durationMs: result.durationMs });
  if (result.queries.length || result.sources.length) steps.push({ seq: seq++, at: at(), type: "web_search", queries: result.queries, sources: result.sources });
  if (req.webSearch && result.cost.webSearchCalls > req.webSearch.maxCalls) {
    // max_tool_calls is the provider-side cap; this records (and logs) any overshoot so it is visible, never silent.
    steps.push({ seq: seq++, at: at(), type: "policy", rule: "cost_cap", decision: "allow", reason: `searches ${result.cost.webSearchCalls} exceeded the cap of ${req.webSearch.maxCalls}` });
    logger.warn({ athleteId: req.athleteId, skill: skill.id, searches: result.cost.webSearchCalls, cap: req.webSearch.maxCalls }, "web search cap exceeded by the provider");
  }
  let json = result.json;
  let privacyDrops: Array<{ category: string; reason: string; source_url: string | null }> = [];
  if (req.sanitize) {
    const s = req.sanitize(json);
    json = s.json;
    privacyDrops = s.drops ?? [];
    if (s.dropped) {
      const byCat = Object.entries(privacyDrops.reduce<Record<string, number>>((a, d) => ({ ...a, [d.category]: (a[d.category] ?? 0) + 1 }), {}))
        .map(([c, n]) => `${c} ${n}`).join(", ");
      steps.push({ seq: seq++, at: at(), type: "policy", rule: "family_privacy", decision: "deny", reason: `dropped ${s.dropped} private fact(s)${byCat ? ` (${byCat})` : ""}; not stored — see output.privacy_drops` });
    }
    if (s.overCap) steps.push({ seq: seq++, at: at(), type: "policy", rule: "cost_cap", decision: "deny", reason: `kept the first facts up to the cap; ${s.overCap} more not stored` });
  }
  if (wasCut) {
    steps.push({ seq: seq++, at: at(), type: "policy", rule: "cost_cap", decision: "deny", reason: `stopped early by the caller's time budget after ${Math.round(result.durationMs / 1000)} s; kept the partial answer streamed so far (token usage unknown: only the searches are counted)` });
    logger.warn({ athleteId: req.athleteId, runId, skill: skill.id, searches: result.cost.webSearchCalls, ms: result.durationMs }, "agent skill run cut at its time budget");
  }
  const evidence: EvidenceRef[] = [...(req.evidenceRead ?? []), ...result.sources.map((s) => ({ kind: "url" as const, url: s.url, ...(s.title ? { title: s.title } : {}) }))];
  await req.store.finishRun(req.athleteId, runId, {
    status: "completed", stopReason: wasCut ? "aborted" : null, cost: result.cost, steps, evidenceRead: evidence,
    // privacy_drops: category + reason + source URL for each dropped fact (never its text), for auditing mistakes.
    output: {
      json, sources: result.sources, queries: result.queries, status: result.status,
      ...(wasCut ? { cut: true } : {}),
      ...(privacyDrops.length ? { privacy_drops: privacyDrops } : {}),
      ...(req.live ? { events: [...events, ...(req.live.onDone ? req.live.onDone(json) : [])] } : {}),
    }, error: null,
  });
  // Cost is logged per run (and summed per onboarding by the caller).
  logger.info({
    athleteId: req.athleteId, runId, skill: skill.id, model: model.model, effort: model.effort,
    inputTokens: result.cost.inputTokens, cachedInputTokens: result.cost.cachedInputTokens, outputTokens: result.cost.outputTokens,
    webSearchCalls: result.cost.webSearchCalls, costUsd: result.cost.microUsd / 1e6, ms: result.durationMs,
  }, "agent skill run cost");
  return { runId, json, cost: result.cost, sources: result.sources, queries: result.queries, reused: false, ...(wasCut ? { cut: true } : {}) };
}
