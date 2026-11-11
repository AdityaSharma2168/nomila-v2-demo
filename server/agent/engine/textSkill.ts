/**
 * agent/engine/textSkill.ts — ONE plain-text model call for a skill that lists no tools, traced and costed like any run.
 *
 * Why it exists (5 Nov 2026, P1): the chat's rolling summary fold (chat/summary.ts, run after every Mila chat turn)
 * used the old harness loop (runAgent, deleted in Mastra-only PR 2) for its one tool-less call. This is that same call
 * without the loop. For a skill with no tools it does exactly what runAgent did:
 *
 *   skill    loadJob(id) → its instructions (jobs.ts instructionsFor: the base block + the procedure), its run limits
 *   model    modelFor(skill) and the same provider for it (Gemini for the cheap tier, OpenAI otherwise; the OpenAI
 *            adapter sends store:false)
 *   trace    an agent_runs row, 'running', before anything is spent (TraceRecorder: the skill step, the model step
 *            with its cost, the end state)
 *   caps     before the call: the skill's run cap and the athlete's day cap (checkCost), then the platform's day cap
 *   call     the message as the one user input; no functions, no built-ins; cache key skill:<id>@<version>
 *   finish   completed | stopped (cost_cap_run / cost_cap_day / aborted) | failed; a stop with no text says the
 *            usual stop line (stopMessages.ts)
 *
 * A skill that lists tools is refused: it needs a loop, not this.
 */
import type { RunCost, RunStatus, RunTrigger, StopReason } from "../../../shared/agent";
import { createLogger } from "../../logger";
import { PLATFORM_CAP_MESSAGE, platformBudget, type PlatformBudget } from "../../lib/platformSpend";
import { AGENT, runLimitsFor } from "../config";
import { createGeminiProvider } from "../geminiProvider";
import { instructionsFor, loadJob } from "../jobs";
import { costOf, modelFor } from "../models";
import { createOpenAIProvider } from "../openaiResponses";
import { checkCost } from "../policy";
import type { AgentModelProvider } from "../provider";
import { dbTraceSink, spentTodayMicroUsd, TraceRecorder, type TraceSink } from "../trace";
import { STOP_MESSAGES } from "./stopMessages";

const logger = createLogger("agent/engine/textSkill");

/** What the call needs besides the model (default: the database). A harness runtime fits it as it is. */
export interface TextSkillRuntime {
  trace: TraceSink;
  spentTodayMicroUsd(athleteId: string): Promise<number>;
  /** The platform-wide day ceiling (default lib/platformSpend.ts platformBudget). */
  platformBudget?: () => Promise<PlatformBudget>;
}

export interface TextSkillDeps {
  provider?: AgentModelProvider;
  runtime?: TextSkillRuntime;
}

export interface TextSkillParams {
  athleteId: string;
  skillId: string;
  trigger: RunTrigger;
  conversationId?: string | null;
  message: string;
  signal?: AbortSignal;
}

export interface TextSkillResult {
  runId: string;
  text: string;
  status: Exclude<RunStatus, "running">;
  stopReason: StopReason | null;
  cost: RunCost;
}

const dbRuntime: TextSkillRuntime = { trace: dbTraceSink, spentTodayMicroUsd: (athleteId) => spentTodayMicroUsd(athleteId) };

export async function runTextSkill(params: TextSkillParams, deps: TextSkillDeps = {}): Promise<TextSkillResult> {
  const skill = loadJob(params.skillId);
  if (skill.tools.length) throw new Error(`runTextSkill: ${skill.id} lists tools; it runs tool-less skills only`);
  const runtime = deps.runtime ?? dbRuntime;
  const model = modelFor(skill);
  const limits = runLimitsFor(skill);
  const provider = deps.provider ?? (model.provider === "gemini" ? createGeminiProvider() : createOpenAIProvider());

  const trace = await TraceRecorder.start({
    athleteId: params.athleteId, skillId: skill.id, skillVersion: skill.version, trigger: params.trigger, model, conversationId: params.conversationId ?? null,
  }, runtime.trace);
  trace.stepSkill(skill);

  let text = "";
  let status: Exclude<RunStatus, "running"> = "completed";
  let stopReason: StopReason | null = null;
  let error: string | null = null;
  let platformCapped = false;
  try {
    if (params.signal?.aborted) { status = "stopped"; stopReason = "aborted"; }
    else {
      const cost = checkCost({
        runMicroUsd: trace.cost.microUsd,
        dayMicroUsd: await runtime.spentTodayMicroUsd(params.athleteId),
        runCap: limits.costCapMicroUsd,
        dayCap: AGENT.DAY_COST_CAP_MICRO_USD,
      });
      if (cost.decision !== "allow") {
        trace.step({ type: "policy", rule: "cost_cap", decision: "deny", reason: cost.reason });
        status = "stopped"; stopReason = cost.stop!;
      } else if ((await (runtime.platformBudget ?? platformBudget)().catch(() => null))?.over) {
        trace.step({ type: "policy", rule: "cost_cap", decision: "deny", reason: "the platform's day spend cap is reached (PLATFORM_DAY_COST_CAP_USD)" });
        status = "stopped"; stopReason = "cost_cap_day"; platformCapped = true;
      } else {
        const started = Date.now();
        const turn = await provider.turn({
          model, instructions: instructionsFor(skill), input: [provider.userMessage(params.message)], functions: [], builtins: [],
          cacheKey: `skill:${skill.id}@${skill.version}`,
          signal: params.signal,
          onText: (d) => { text += d; },
        });
        const turnCost = costOf(model.model, turn.usage);
        trace.addCost(turnCost);
        trace.step({ type: "model", model, cost: turnCost, durationMs: Date.now() - started });
        await trace.flush();
        // No tools were offered, so a function call cannot be answered: the step limit, as the harness would end it.
        if (turn.functionCalls.length) { status = "stopped"; stopReason = "max_steps"; }
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError" || params.signal?.aborted) { status = "stopped"; stopReason = "aborted"; }
    else { status = "failed"; stopReason = "error"; error = String(err?.message ?? err); }
    trace.step({ type: "error", message: (error ?? "aborted").slice(0, 500) });
    logger.error({ runId: trace.runId, error }, "text skill run failed");
  }

  if (stopReason && stopReason !== "aborted" && !text.trim()) text = platformCapped ? PLATFORM_CAP_MESSAGE : STOP_MESSAGES[stopReason];
  await trace.finish(status, stopReason, error, null);
  return { runId: trace.runId, text, status, stopReason, cost: trace.cost };
}
