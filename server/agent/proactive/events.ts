/**
 * agent/proactive/events.ts — the event log's one door (athlete_events, 0143; design "Mila on watch" step 1).
 *
 *   emitAthleteEvent   write one event (once per athlete + dedupe key: a repeated source — a webhook delivered twice, a
 *                      retried callback, a cron that sees the same item again — is ignored) and start the dispatcher's
 *                      run for it on the workflow runner. Nothing while MILA_PROACTIVE is off. Never throws.
 *   routeToMila        for a source that today sends a fixed-copy push: true ⇒ the event went to Mila (the caller sends
 *                      nothing itself; the dispatcher sends `fallbackPush` if Mila's turn cannot run); false ⇒ the flag is
 *                      off, the caller does exactly what it did before.
 *
 * payload carries ids and short labels only (a brand's display name, an amount already on a deal), never email text.
 * Sources only report what happened; the rules table (rules.ts) decides how loud it is.
 */
import { db } from "../../db";
import { athleteEvents } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { pushSoon, type PushEvent } from "../../services/push/push";
import { MILA_PROACTIVE_PROCESS, milaProactiveEnabled } from "./config";
import type { AthleteEventKind } from "./rules";

const logger = createLogger("agent/proactive/events");

export interface AthleteEventPayload {
  /** The deal or booking the event is about (where its message goes, and what Mila should read). */
  dealId?: string;
  bookingId?: string;
  /** A short display label for the conversation's title and Mila's update line (a brand's name; no email text). */
  label?: string | null;
  /** Any other small fact the update line names (an amount in cents, a platform id, a count). */
  facts?: Record<string, string | number | boolean | null>;
  /** The fixed-copy push the source would have sent: the reminder itself, or the fallback when Mila's turn can't run. */
  fallbackPush?: PushEvent;
  /**
   * The key of the same news on the "next chat" queue (engine/events.ts, mila_tf_sessions.pending_events), when the source
   * queues it there too. Once Mila's message about this event is in the chat, that queued entry is dropped, so Mila does
   * not tell it again in the athlete's next conversation. Nothing sent (SILENT, failed, coalesced): the entry stays.
   */
  queueKey?: string;
}

export interface EmitInput {
  athleteId: string;
  kind: AthleteEventKind;
  dedupeKey: string;
  payload?: AthleteEventPayload;
}

/** Tests inject the run starter (the real one is the workflow runner's startRun). */
export type StartDispatch = (athleteId: string, eventId: string) => Promise<unknown>;
const defaultStart: StartDispatch = async (athleteId, eventId) => {
  const { startRun } = await import("../../workflow/runner");
  return startRun({ process: MILA_PROACTIVE_PROCESS, athleteId, input: { eventId }, idempotencyKey: `${MILA_PROACTIVE_PROCESS}:${eventId}`, createdBy: "event" });
};

/** Write the event and start its dispatch. Returns the new event's id, or null (flag off, a repeat, or a failure). */
export async function emitAthleteEvent(e: EmitInput, deps: { start?: StartDispatch } = {}): Promise<string | null> {
  if (!milaProactiveEnabled() || !e.athleteId) return null;
  try {
    const [row] = await db.insert(athleteEvents)
      .values({ athlete_id: e.athleteId, kind: e.kind, dedupe_key: e.dedupeKey.slice(0, 200), payload: (e.payload ?? {}) as any })
      .onConflictDoNothing().returning({ id: athleteEvents.id });
    if (!row) return null;   // the same news, already logged
    await (deps.start ?? defaultStart)(e.athleteId, row.id);
    logger.info({ athleteId: e.athleteId, kind: e.kind, eventId: row.id }, "proactive: event logged");
    return row.id;
  } catch (err: any) {
    logger.warn({ athleteId: e.athleteId, kind: e.kind, err: String(err?.message ?? err).slice(0, 200) }, "proactive: event not logged");
    // routeToMila's caller sent nothing itself: the source's fixed-copy push still goes out (never lose the news).
    if (e.payload?.fallbackPush) { try { pushSoon(e.athleteId, e.payload.fallbackPush); } catch { /* never throws */ } }
    return null;
  }
}

/**
 * For a source that sends a fixed-copy push today. Flag off: false, and the caller pushes as before. Flag on: the event
 * is logged in the background (never delays or fails the caller) and true is returned, so the caller sends nothing.
 */
export function routeToMila(e: EmitInput): boolean {
  if (!milaProactiveEnabled() || !e.athleteId) return false;
  void emitAthleteEvent(e).catch(() => undefined);
  return true;
}
