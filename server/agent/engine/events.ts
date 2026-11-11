/**
 * agent/engine/events.ts (moved from agent/tf/, 8 Nov 2026; the Mastra turn delivers what it queues) — app events Mila should know about, queued for her next turn (design §5).
 *
 *   approval          the athlete's tap on an approval card Mila queued — approved (and done, or failed) or declined —
 *                     so Mila's history matches what happened ("Want me to save that?" → she tapped Save → Mila must not
 *                     ask again). Queued on the conversation the card came from (the run's conversation). Called by the
 *                     approve and dismiss routes after the row has changed.
 *   deal_reply        a new inbound message on a thread that is already one of their deals (the deal detector's two
 *                     reply branches, next to the "A brand replied" push). Only a message from the last 24 hours (a
 *                     backfill, a reconnect or a replay never queues old news, the push's own rule); one waiting event
 *                     per deal.
 *   research_done     a research run for them finished: lean_research_refresh (Mila's refresh_research tool) and
 *                     signup_research (every version), from the workflow's onDone hook (exactly once per run). Carries the
 *                     number of facts the run saved when its output says.
 *   account_connected an OAuth connect (or reconnect) completed (routes/oauthCallback.ts, after the provider activated the
 *                     row). One waiting event per connect (connection id + connected_at).
 *
 * The outside events (all but approval) are queued on the athlete's most recently used Mila conversation
 * (engine/sessions.ts queueEventForAthlete), idempotent per key. Every function never throws and never delays its
 * caller beyond one small write (the callers do not await them where that matters).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { deals } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { queueEventForAthlete, queueEventForRun, type AppEventBody } from "./sessions";
import { emitAthleteEvent } from "../proactive/events";

const logger = createLogger("agent/engine/events");

/** A deal reply older than this when it is stored is history (services/push/events.ts BRAND_REPLY_FRESH_MS). */
export const DEAL_REPLY_FRESH_MS = 24 * 3_600_000;

export async function noteApprovalOutcome(
  athleteId: string,
  item: { id: string; runId: string | null; title: string },
  outcome: "approved" | "failed" | "declined",
): Promise<void> {
  try {
    const queued = await queueEventForRun(athleteId, item.runId, { kind: "approval", outcome, title: item.title, approvalId: item.id });
    if (queued) logger.info({ athleteId, approvalId: item.id, outcome }, "events: approval outcome queued for Mila's next turn");
  } catch (err: any) {
    logger.warn({ athleteId, approvalId: item.id, err: err?.message }, "events: approval outcome not queued");
  }
}

async function noteOutside(athleteId: string | null | undefined, e: AppEventBody, key: string, now?: Date): Promise<boolean> {
  if (!athleteId) return false;
  try {
    const queued = await queueEventForAthlete(athleteId, e, key, now);
    if (queued) logger.info({ athleteId, kind: e.kind }, "events: app event queued for Mila's next turn");
    return queued;
  } catch (err: any) {
    logger.warn({ athleteId, kind: e.kind, err: err?.message }, "events: app event not queued");
    return false;
  }
}

/**
 * A brand replied on one of their deals. No date, or older than 24 hours: nothing (it cannot be shown to be new). The
 * deal's brand name is read for this athlete only; a deal that is not theirs queues nothing.
 */
export async function noteDealReply(athleteId: string, p: { dealId: string; receivedAt: Date | null }, now: Date = new Date()): Promise<boolean> {
  const at = p.receivedAt;
  if (!at || Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > DEAL_REPLY_FRESH_MS) return false;
  try {
    const [d] = await db.select({ brand: deals.brand_name }).from(deals).where(and(eq(deals.id, p.dealId), eq(deals.athlete_id, athleteId))).limit(1);
    if (!d) return false;
    return await noteOutside(athleteId, { kind: "deal_reply", dealId: p.dealId, brand: d.brand ?? null }, `deal_reply:${p.dealId}`, now);
  } catch (err: any) {
    logger.warn({ athleteId, err: err?.message }, "events: deal reply not queued");
    return false;
  }
}

/** Fire and forget, for the deal detector's reply branches (never delays or fails mail processing). */
export function noteDealReplySoon(athleteId: string, dealId: string, receivedAt: Date | null): void {
  void noteDealReply(athleteId, { dealId, receivedAt }).catch(() => undefined);
}

/** The facts a research run saved, from its outputs (lean_research or research_merge `inserted`), when it says. */
export function newFactsFrom(outputs: Record<string, unknown> | null | undefined): number | null {
  for (const step of ["lean_research", "research_merge"]) {
    const n = (outputs?.[step] as { inserted?: unknown } | null | undefined)?.inserted;
    if (typeof n === "number" && Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return null;
}

/** A research run finished (a workflow onDone hook). */
export function noteResearchDone(
  which: "lean_research_refresh" | "signup_research",
  run: { runId: string; athleteId: string | null; outputs: Record<string, unknown> },
): Promise<boolean> {
  const newFacts = newFactsFrom(run.outputs);
  // MILA_PROACTIVE: logged too (rules.ts: brief only; Mila hears it in the next chat through the queue below).
  if (run.athleteId) void emitAthleteEvent({ athleteId: run.athleteId, kind: "research_done", dedupeKey: `research_done:${run.runId}`, payload: { facts: { newFacts } } });
  return noteOutside(run.athleteId, { kind: "research_done", process: which, runId: run.runId, newFacts }, `research_done:${run.runId}`);
}

/** An account was connected (or reconnected). `connectKey` names this connect (connection id + connected_at). */
export function noteAccountConnected(athleteId: string, p: { platform: string; reconnected: boolean; connectKey: string }): Promise<boolean> {
  // MILA_PROACTIVE: Mila says it in the chat right away (rules.ts: speak now, no phone buzz).
  const key = `account_connected:${p.connectKey}`;
  void emitAthleteEvent({ athleteId, kind: "account_connected", dedupeKey: key, payload: { facts: { platform: p.platform, reconnected: p.reconnected }, queueKey: key } });
  return noteOutside(athleteId, { kind: "account_connected", platform: p.platform, reconnected: p.reconnected }, key);
}
