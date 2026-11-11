/**
 * agent/engine/mastra/trace.ts — one Langfuse trace per Mastra turn, through OUR tracing (lib/tracing.ts: the
 * LANGFUSE_TRACING switch, the OpenTelemetry pipeline started at boot). No Mastra exporter or observability package.
 *
 *   who      userId = the athlete (withTraceAthlete), so account deletion finds and deletes it
 *            (lib/privacy/langfuseTraces.ts); metadata names the athlete, our agent_runs id, the thread (our session
 *            row id) and the engine.
 *   what     METADATA ONLY: the model, effort, token usage, our computed cost, how the turn ended, and the NAMES and
 *            outcomes of the tools it called (from our own tool records), and how many attachments and images it had. Never the instructions, the context block,
 *            the athlete's words, Mila's answer or any tool's arguments or results: Mila's turn input carries the
 *            athlete's record, and trace content is not something the athlete can see or correct.
 *   shape    a span "mila.turn" (the trace root) with one child generation "mila.model" carrying usage and cost.
 *
 * Transparent when tracing is off (one boolean). Never throws: a tracing failure is logged and the turn is unaffected.
 */
import type { RunCost, ToolCallRecord } from "../../../../shared/agent";
import { createLogger } from "../../../logger";
import { tracingEnabled, withTraceAthlete } from "../../../lib/tracing";
import { MASTRA, MASTRA_PROVIDER } from "../config";

const logger = createLogger("agent/engine/mastra/trace");

export interface TurnTraceRecord {
  athleteId: string;
  runId: string;
  threadId: string | null;
  trigger: string;
  status: string;
  stopReason: string | null;
  cost: RunCost;
  tools: ToolCallRecord[];
  durationMs: number;
  /** What she attached and what was shown: COUNTS only (attachments.ts), never an image, a path or a label. */
  attachments?: { attached: number; shown: number; images: number; unread: number; leftOut: number };
}

/** The trace payload: ids, numbers and tool names only (exported for the content-free test). */
export function traceAttributes(r: TurnTraceRecord) {
  return {
    span: {
      input: { athleteId: r.athleteId, runId: r.runId, trigger: r.trigger },
      output: { status: r.status, stopReason: r.stopReason, tools: r.tools.map((t) => ({ name: t.name, outcome: t.outcome })) },
      metadata: { athlete_id: r.athleteId, nomila_run_id: r.runId, thread_id: r.threadId ?? "", engine: MASTRA_PROVIDER, duration_ms: String(r.durationMs),
        ...(r.attachments ? {
          attachments: String(r.attachments.attached), attachments_shown: String(r.attachments.shown), images: String(r.attachments.images),
          attachments_unread: String(r.attachments.unread), attachments_left_out: String(r.attachments.leftOut),
        } : {}) },
    },
    generation: {
      model: MASTRA.priceModel,
      modelParameters: { reasoningEffort: MASTRA.effort },
      usageDetails: {
        input: r.cost.inputTokens, cached_input: r.cost.cachedInputTokens, output: r.cost.outputTokens,
        reasoning: r.cost.reasoningTokens, total: r.cost.inputTokens + r.cost.outputTokens,
      },
      costDetails: { total: r.cost.microUsd / 1_000_000 },
    },
  };
}

export async function traceMastraTurn(r: TurnTraceRecord): Promise<void> {
  if (!tracingEnabled()) return;
  try {
    const { startObservation } = await import("@langfuse/tracing");
    const a = traceAttributes(r);
    withTraceAthlete(r.athleteId, () => {
      const span = startObservation("mila.turn", { input: a.span.input, metadata: a.span.metadata });
      span.startObservation("mila.model", { model: a.generation.model, modelParameters: a.generation.modelParameters }, { asType: "generation" })
        .update({ usageDetails: a.generation.usageDetails, costDetails: a.generation.costDetails }).end();
      span.update({ output: a.span.output, ...(r.status === "failed" ? { level: "ERROR" as const } : {}) }).end();
    });
  } catch (err: any) {
    logger.warn({ runId: r.runId, error: err?.message?.slice(0, 200) }, "mastra turn trace not written");
  }
}
