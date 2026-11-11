/**
 * studio/agent/config — the agent's model, pinned in one place.
 *
 * The house rule (server/CLAUDE.md): model strings live in a config module and are never hardcoded
 * at a call site. This is the agent's.
 *
 * ─── WHY PRO NOW (21 Sep 2026 — Mia approved; the plan-off was cancelled) ──────────────────────
 *
 * The planner ran on Flash while its job was mechanical: one sentence plus a list of photographs
 * into N typed items, each compiled deterministically. Since b-roll went to words
 * (docs/studio-broll-t2v-decision.md) it is not: a b-roll item's direction IS the prompt its clip is
 * made from, so the planner's prose now reaches the screen. Pro is the model for that — better beat
 * variety and better scene writing — as it already is for `deriveShotList`, whose structure this
 * planner borrows.
 *
 * WHAT IT COSTS: a plan moves from about a cent to a few cents, and "Planning…" gets a few seconds
 * slower. It is the one call made before she approves anything — $0 of generation until she does —
 * so it touches no cap. If plans read worse or the wait is painful, going back is ONE env line:
 * STUDIO_AGENT_MODEL set to the Flash model. `GEMINI.pro` is the registry's identifier
 * (server/lib/models.ts), never a string written here.
 */
import { GEMINI } from "../../lib/models";

/** The planner's model. Pinned, overridable by env, never chosen at a call site. */
export const agentModel = (): string =>
  process.env.STUDIO_AGENT_MODEL ?? GEMINI.pro;

/**
 * How long the planner may take before she is told it did not work.
 *
 * She is WAITING on this one — it is in front of the approval screen — so it is bounded, but not at
 * Flash's fifteen seconds: Pro thinks by default. The b-roll flip set thirty seconds as "a ceiling,
 * not a prediction" and asked the first real plans to measure it; they did (21 Sep 2026, C1b device
 * pass): two consecutive plans on a real library aborted AT the ceiling — "This operation was
 * aborted", 60 s apart — while a bare call to the same model answered in 3.6 s. So thirty seconds
 * is under Pro's thinking time on this prompt, not over it. Two minutes is the new ceiling; the
 * "plan derived" log line still carries `ms`, and the right number is the one it prints.
 * Env-overridable, like everything here.
 */
export const agentTimeoutMs = (): number =>
  Number(process.env.STUDIO_AGENT_TIMEOUT_MS ?? 120_000);

/**
 * The thinking config the planner is sent — or none. It FOLLOWS THE MODEL, because the one shape that
 * is proven on this project differs by model:
 *
 *   Flash  `{ thinkingBudget: 0 }` — what the planner (and the interpreter, and Mila) send the Flash
 *          models on Vertex daily. Thinking tokens bill as output and buy nothing for a short JSON.
 *   Pro    NOTHING. Google documents Gemini 3.1 Pro's thinking as levels (low/medium/high, default
 *          high) and `thinking_budget` as legacy, and says nothing of a zero budget on Pro — so a
 *          zero budget there is a guess. What `GEMINI.pro` is sent every day on this project
 *          (services/shotList.ts, services/narrator.ts) is no thinking config at all. That is the
 *          shape used, and a level is left for when it has been tried.
 *
 * Keyed on the registry's Flash identifiers, so an override to either Flash model gets Flash's shape.
 */
export const agentThinking = (): { thinkingBudget: number } | undefined => {
  const model = agentModel();
  return model === GEMINI.flash || model === GEMINI.flashLite
    ? { thinkingBudget: 0 }
    : undefined;
};
