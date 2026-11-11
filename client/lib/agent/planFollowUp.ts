/**
 * planFollowUp — the open chat's half of Mila's plan-ready follow-up (design "Goals tab post details + plan ready",
 * 12 Oct 2026). Pure, so it is unit-tested without a server.
 *
 * refresh_plan's progress card carries the plan run's id (payload.planRunId). While it runs, the chat re-reads the goals
 * read every PLAN_FOLLOW_POLL_MS (its `planning` names the run in progress), for at most PLAN_FOLLOW_MAX_MS. When the run
 * is no longer in progress, the chat re-reads the conversation once and:
 *   - the run told this chat (a row holds the card plan-ready:<run>): the progress card turns to done and Mila's row is
 *     added under it, once;
 *   - it did not (the run failed outright: no tell step ran): the progress card turns to failed, and says the current
 *     plan still stands.
 */
import type { AgentGoalsResponse } from "../../../shared/plan";

export const PLAN_FOLLOW_POLL_MS = 5000;
export const PLAN_FOLLOW_MAX_MS = 15 * 60_000;

export const planReadyCardId = (runId: string) => `plan-ready:${runId}`;

type Card = { id?: unknown; kind?: unknown; payload?: Record<string, unknown> | null };
const cardsOf = (v: unknown): Card[] => (Array.isArray(v) ? (v as Card[]) : []);

/** The plan run a turn's cards are waiting on: a running progress card's planRunId, or null. */
export function runningPlanRunId(cards: unknown): string | null {
  const c = cardsOf(cards).find((x) => x.kind === "progress" && x.payload?.state === "running" && typeof x.payload?.planRunId === "string");
  return c ? (c.payload!.planRunId as string) : null;
}

/** Whether the goals read still has this run in progress (a dark route, null, reads as not in progress). */
export const stillPlanning = (goals: AgentGoalsResponse | null | undefined, runId: string): boolean => goals?.planning?.runId === runId;

/** One conversation row as GET /me/conversations/:id answers it (server/mila/conversations.ts ConversationMessage). */
export interface ConversationRow {
  id?: string;
  role: "user" | "assistant";
  content: string;
  agentCards?: unknown[] | null;
}

/** A message as the chat holds it (only what this needs). */
export interface FollowMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  cards?: unknown[];
}

const setPlanCard = (cards: unknown[] | undefined, runId: string, state: "done" | "failed"): unknown[] | undefined => {
  if (!cards) return cards;
  let changed = false;
  const next = cards.map((c) => {
    const card = c as Card;
    if (card.kind !== "progress" || card.payload?.planRunId !== runId || card.payload?.state !== "running") return c;
    changed = true;
    const p = card.payload!;
    const of = typeof p.of === "number" ? p.of : 1;
    const steps = Array.isArray(p.steps) ? (p.steps as Array<Record<string, unknown>>) : null;
    return {
      ...card,
      payload: {
        ...p, state, ...(state === "done" ? { step: of } : {}),
        ...(steps ? { steps: steps.map((s) => (state === "done" ? { ...s, state: "done" } : s.state === "running" ? { ...s, state: "failed" } : s)) } : {}),
      },
    };
  });
  return changed ? next : cards;
};

/**
 * While the run works: the card shows where it is (the goals read's planning.step) — planning first, then the post kits.
 * Returns the same array when nothing moved.
 */
export function advancePlanCard<M extends FollowMessage>(messages: M[], runId: string, step: "plan" | "post_kits" | "tell"): M[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.cards) return m;
    const cards = m.cards.map((c) => {
      const card = c as Card;
      const p = card.payload;
      if (card.kind !== "progress" || p?.planRunId !== runId || p?.state !== "running") return c;
      const of = typeof p.of === "number" ? p.of : 1;
      const at = Math.min(of, step === "plan" ? 1 : step === "post_kits" ? 2 : of);
      if (p.step === at) return c;
      changed = true;
      const steps = Array.isArray(p.steps) ? (p.steps as Array<{ label: string; state: string }>) : null;
      return {
        ...card,
        payload: {
          ...p, step: at, ...(steps?.[at - 1] ? { label: steps[at - 1].label } : {}),
          ...(steps ? { steps: steps.map((s, i) => ({ ...s, state: i < at - 1 ? "done" : i === at - 1 ? "running" : "pending" })) } : {}),
        },
      };
    });
    return cards.some((c, i) => c !== m.cards![i]) ? { ...m, cards } : m;
  });
  return changed ? next : messages;
}

/**
 * The chat after the run ended: the re-read conversation decides whether Mila came back (done + her row, once) or the
 * run failed (the card says so). `mintId` gives a new message its list key.
 */
export function applyPlanFollowUp<M extends FollowMessage>(
  messages: M[], rows: ConversationRow[], runId: string, mintId: () => string,
  /** False when the chat stopped waiting (PLAN_FOLLOW_MAX_MS) rather than seeing the run end: no failure is claimed. */
  runEnded = true,
): M[] {
  const cardId = planReadyCardId(runId);
  const told = rows.find((r) => r.role === "assistant" && cardsOf(r.agentCards).some((c) => c.id === cardId));
  if (!told && !runEnded) return messages;
  const flipped = messages.map((m) => {
    const cards = setPlanCard(m.cards, runId, told ? "done" : "failed");
    return cards === m.cards ? m : { ...m, cards };
  });
  if (!told) return flipped;
  if (flipped.some((m) => cardsOf(m.cards).some((c) => c.id === cardId))) return flipped;
  return [...flipped, { id: mintId(), role: "assistant", content: told.content, cards: told.agentCards ?? [] } as unknown as M];
}
