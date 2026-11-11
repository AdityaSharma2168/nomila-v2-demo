/**
 * agent/engine/index.ts — THE way a surface runs a Mila turn: the chat route (routes/chat.ts), chat v2, the proactive
 * turn (agent/proactive/turn.ts), the landing's waitlist (agent/waitlist/turn.ts) and agent_onboarding's turns
 * (agent/onboarding/milaTurn.ts) all call runMilaTurn.
 *
 * Mila runs on Mastra (agent/engine/mastra/turn.ts), always: there is no engine switch and no other engine (Mastra-only,
 * PR 2 of 3, Nov 2026). The Mastra turn loads lazily, so a module that only imports this one stays light. What Mila
 * knows about the athlete and every tool live in our code and our database, never in the engine.
 */
import type { SSEStream } from "../../lib/sse";
import type { MilaEngineName } from "./config";
import type { MilaTurnDeps, TurnOptions, TurnResult } from "./turnTypes";
import type { MastraTurnTap } from "./mastra/turn";
import type { TurnAttachmentRef } from "./mastra/attachments";

/** `tap`: chat v2's view of a Mastra turn (mastra/turn.ts MastraTurnTap). */
/** `attachments`: asset ids + roles the chat route checked against their library; the Mastra turn shows them to the
 * model (mastra/attachments.ts). */
export type MilaTurnInput = { athleteId: string; message: string | null; conversationId?: string; sse: SSEStream; context?: unknown; tap?: MastraTurnTap; attachments?: TurnAttachmentRef[] };

/** The turn's result, plus the engine that ran it (logs and records report this one, never a guess). Optional only so
 * injected test turns need not set it; runMilaTurn always does. */
export type MilaTurnResult = TurnResult & { engine?: MilaEngineName };

export async function runMilaTurn(p: MilaTurnInput, deps: MilaTurnDeps = {}, opts: TurnOptions = {}): Promise<MilaTurnResult> {
  const { runMastraTurn } = await import("./mastra/turn");
  return { ...(await runMastraTurn(p, deps, opts)), engine: "mastra" };
}

export { MILA_TURN, milaWaitlistEnabled, type MilaEngineName } from "./config";
