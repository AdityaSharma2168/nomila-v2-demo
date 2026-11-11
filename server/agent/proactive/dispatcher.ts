/**
 * agent/proactive/dispatcher.ts — what happens to one logged event (design "Mila on watch", steps 2–4). Three steps on
 * the workflow runner (workflow.ts), each idempotent (a step may run twice):
 *
 *   decide   the rules table (rules.ts): silent and brief are recorded and end there; a reminder sends the event's own
 *            fixed-copy push once (its dedupe key) and ends; speak_now goes on unless MILA_PROACTIVE was switched off
 *            since the event was logged (the source's fixed-copy push instead), or the same deal or booking already got
 *            a Mila message within the rule's window (a burst of replies is one message)
 *   speak    one Mila turn in its own session (turn.ts), ending in a structured decision (decision.ts:
 *            SPEAK | SILENT | DEFER). Code checks it and FAILS CLOSED: SILENT, a missing, malformed or ungrounded
 *            decision, or no card on a card rule ⇒ nothing is written and nothing is pushed (logged). DEFER schedules
 *            ONE re-check of the event on the workflow runner (a second DEFER ends it, closed). A turn that cannot run
 *            (the engine failing, her day cap) sends the source's fixed-copy push instead, so a brand reply is never lost.
 *            A SPEAK whose words are already in their chats is not sent twice. Otherwise ONLY the decision's message
 *            and its cards are added to the target conversation (chat_messages.mila_started, unread) and remembered
 *            on that conversation's own session (CowAgent remember_scheduled_output, MIT). Never retried.
 *   notify   one notification that opens on that message, unless: the rule says no phone (they are in the app when they
 *            connect), the message is a scam warning (chat only), their switches are off, it is their quiet hours, the
 *            athlete is in the app right now (they wrote to Mila or saw a Mila message in the last few minutes: the
 *            message is in the chat, the phone stays quiet), or 5 Mila notifications went out in 24 hours (pacing:
 *            never for an `important` rule, owner rule 28 Oct 2026). The push service still applies the overall cap
 *            of 8 and one push per key. Lock-screen words are fixed copy unless they turned "Show brand names" on,
 *            then Mila's first sentence.
 *
 * Every read and write is scoped to the event's athlete. Nothing here sends, accepts, publishes or pays (tap-to-send).
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { athleteEvents, chatMessages, pushDevices, pushSends } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { upsertConversationOnMessage } from "../../mila/conversations";
import { inQuietHours, localMinutes, readPreferences, sendPush, type PushEvent, type SendResult } from "../../services/push/push";
import { dropQueuedEvent, rememberMilaStarted } from "../engine/sessions";
import { MILA_PROACTIVE_PROCESS, milaProactiveEnabled } from "./config";
import type { AthleteEventPayload } from "./events";
import { PROACTIVE_LIMITS, PROACTIVE_RULES, isAthleteEventKind, type AthleteEventKind, type ProactiveRule } from "./rules";
import { runProactiveTurn, type ProactiveTurnDeps } from "./turn";

const logger = createLogger("agent/proactive/dispatcher");

export interface EventRow {
  id: string; athleteId: string; kind: string; dedupeKey: string; payload: AthleteEventPayload;
  createdAt: Date; dispatchedAt: Date | null; outcome: string | null; conversationId: string | null; messageId: string | null;
}

export async function loadEvent(athleteId: string, eventId: string): Promise<EventRow | null> {
  const [r] = await db.select().from(athleteEvents).where(and(eq(athleteEvents.id, eventId), eq(athleteEvents.athlete_id, athleteId))).limit(1);
  if (!r) return null;
  return {
    id: r.id, athleteId: r.athlete_id, kind: r.kind, dedupeKey: r.dedupe_key, payload: (r.payload ?? {}) as AthleteEventPayload,
    createdAt: r.created_at, dispatchedAt: r.dispatched_at, outcome: r.outcome, conversationId: r.conversation_id, messageId: r.message_id,
  };
}

/** Record the dispatcher's decision once (a second write never overwrites the first). */
async function finish(ev: EventRow, outcome: string, now: Date): Promise<string> {
  const [r] = await db.update(athleteEvents).set({ dispatched_at: now, outcome })
    .where(and(eq(athleteEvents.id, ev.id), eq(athleteEvents.athlete_id, ev.athleteId), isNull(athleteEvents.dispatched_at)))
    .returning({ outcome: athleteEvents.outcome });
  logger.info({ athleteId: ev.athleteId, eventId: ev.id, kind: ev.kind, outcome }, "proactive: event dispatched");
  return r?.outcome ?? outcome;
}

const ruleOf = (kind: string): ProactiveRule => (isAthleteEventKind(kind) ? PROACTIVE_RULES[kind] : { outcome: "silent" });

// ─── where the message goes ────────────────────────────────────────────────────────────────────────────────────────

/** A fixed conversation id (UUID v4 layout) for one athlete + subject, so every message about it lands in one chat. */
export function proactiveConversationId(athleteId: string, subject: string): string {
  const h = createHash("sha256").update(`nomila:mila-proactive:${athleteId}:${subject}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The phone (or browser) they used last tells the clock (UTC when none is known), as for quiet hours. */
export async function athleteTimeZone(athleteId: string): Promise<string | null> {
  const [d] = await db.select({ tz: pushDevices.time_zone }).from(pushDevices).where(eq(pushDevices.athlete_id, athleteId)).orderBy(desc(pushDevices.last_seen_at)).limit(1);
  return d?.tz ?? null;
}

/** YYYY-MM-DD on the athlete's clock. */
export function localDay(now: Date, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch { return now.toISOString().slice(0, 10); }
}

/**
 * Owner default (27 Oct 2026): each deal or booking keeps its own conversation; everything else goes to that day's
 * conversation. The title names the deal's brand label when the source gave one, never email text.
 */
export async function targetConversation(ev: EventRow, rule: ProactiveRule, now: Date): Promise<{ id: string; title: string }> {
  const label = typeof ev.payload.label === "string" ? ev.payload.label.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (rule.placement === "deal" && ev.payload.dealId) return { id: proactiveConversationId(ev.athleteId, `deal:${ev.payload.dealId}`), title: label ? `${label} · deal` : "A deal" };
  if (rule.placement === "booking" && ev.payload.bookingId) return { id: proactiveConversationId(ev.athleteId, `booking:${ev.payload.bookingId}`), title: "Booking request" };
  const day = localDay(now, await athleteTimeZone(ev.athleteId));
  return { id: proactiveConversationId(ev.athleteId, `day:${day}`), title: `Mila · ${day}` };
}

// ─── the guards ────────────────────────────────────────────────────────────────────────────────────────────────────

/** In the app right now: they wrote to Mila, or saw a Mila message, within PROACTIVE_LIMITS.activeHoldMs. */
export async function athleteActive(athleteId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - PROACTIVE_LIMITS.activeHoldMs);
  const [r] = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(
    eq(chatMessages.athlete_id, athleteId),
    or(and(eq(chatMessages.role, "user"), gt(chatMessages.created_at, since)), gt(chatMessages.seen_at, since)),
  )).limit(1);
  return !!r;
}

/** Mila-started notifications that went out (or are going out) in the last 24 hours. */
export async function milaPushesToday(athleteId: string, now: Date): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(pushSends).where(and(
    eq(pushSends.athlete_id, athleteId), eq(pushSends.kind, "mila_message"), gt(pushSends.created_at, new Date(now.getTime() - 24 * 3_600_000)),
    or(gt(pushSends.devices, 0), isNull(pushSends.error)),
  ));
  return n;
}

/**
 * The same deal or booking already got a Mila message within the window. A message counts from the moment it is in the
 * chat (message_id set), before its notify step has recorded the outcome: two events on one deal whose turns overlap
 * must not both land (speakStep checks again after its turn).
 */
async function spokeRecently(ev: EventRow, withinMs: number, now: Date): Promise<boolean> {
  const field = ev.payload.dealId ? "dealId" : ev.payload.bookingId ? "bookingId" : null;
  if (!field) return false;
  const value = field === "dealId" ? ev.payload.dealId! : ev.payload.bookingId!;
  const [r] = await db.select({ id: athleteEvents.id }).from(athleteEvents).where(and(
    eq(athleteEvents.athlete_id, ev.athleteId), isNotNull(athleteEvents.message_id),
    sql`coalesce(${athleteEvents.dispatched_at}, ${athleteEvents.created_at}) > ${new Date(now.getTime() - withinMs)}`, sql`${athleteEvents.payload} ->> ${field} = ${value}`,
    sql`${athleteEvents.id} <> ${ev.id}::uuid`,
  )).limit(1);
  return !!r;
}

/** Words compared for "already said": case, spacing and punctuation do not make a message new. */
const sameWords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The same words are already in one of their chats as a Mila-started message, within the window. */
async function alreadySaid(athleteId: string, text: string, now: Date): Promise<boolean> {
  const want = sameWords(text);
  if (!want) return false;
  const rows = await db.select({ content: chatMessages.content }).from(chatMessages).where(and(
    eq(chatMessages.athlete_id, athleteId), eq(chatMessages.mila_started, true),
    gt(chatMessages.created_at, new Date(now.getTime() - PROACTIVE_LIMITS.duplicateWindowMs)),
  )).orderBy(desc(chatMessages.created_at)).limit(50);
  return rows.some((r) => sameWords(r.content ?? "") === want);
}

/**
 * Interim marks on an event still in flight (dispatched_at stays null, so the steps go on; finish() replaces them):
 * "deferred" = its one DEFER is used; "warning" = its message is a scam warning (chat only, never a notification).
 */
const MARK = { deferred: "deferred", warning: "warning" } as const;
async function mark(ev: EventRow, outcome: string, extra: Partial<typeof athleteEvents.$inferInsert> = {}): Promise<void> {
  await db.update(athleteEvents).set({ outcome, ...extra })
    .where(and(eq(athleteEvents.id, ev.id), eq(athleteEvents.athlete_id, ev.athleteId), isNull(athleteEvents.dispatched_at)));
}

/** The re-check a DEFER asks for: a second run of the same process for the event, held until `at` (workflow runner). */
export type ScheduleRecheck = (athleteId: string, eventId: string, at: Date) => Promise<void>;
const defaultRecheck: ScheduleRecheck = async (athleteId, eventId, at) => {
  const { startRun } = await import("../../workflow/runner");
  await startRun({ process: MILA_PROACTIVE_PROCESS, athleteId, input: { eventId, recheck: true }, idempotencyKey: `${MILA_PROACTIVE_PROCESS}:${eventId}:recheck`, createdBy: "event", holdUntil: at });
};

// ─── the steps ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DispatchDeps {
  now?: () => Date;
  turn?: ProactiveTurnDeps;
  push?: (athleteId: string, e: PushEvent) => Promise<SendResult>;
  /** Tests record the DEFER re-check instead of starting a run. */
  recheck?: ScheduleRecheck;
}
const clock = (d: DispatchDeps) => (d.now ?? (() => new Date()))();
const pushWith = (d: DispatchDeps) => d.push ?? ((a: string, e: PushEvent) => sendPush(a, e));

export type DecideOutput = { done: true; outcome: string } | { done: false };

export async function decideStep(athleteId: string, eventId: string, deps: DispatchDeps = {}): Promise<DecideOutput> {
  const ev = await loadEvent(athleteId, eventId);
  if (!ev) return { done: true, outcome: "missing" };
  if (ev.dispatchedAt) return { done: true, outcome: ev.outcome ?? "done" };
  if (ev.messageId) return { done: false };   // a retried run whose message is already in the chat: on to notify
  const now = clock(deps);
  const rule = ruleOf(ev.kind);
  switch (rule.outcome) {
    case "silent": return { done: true, outcome: await finish(ev, "silent", now) };
    case "brief": return { done: true, outcome: await finish(ev, "brief", now) };
    case "reminder": {
      const fb = ev.payload.fallbackPush;
      const res = fb ? await pushWith(deps)(athleteId, fb) : null;
      return { done: true, outcome: await finish(ev, res ? `reminded_${res.status}` : "reminder_no_push", now) };
    }
    case "speak_now": {
      // Switched off since the event was logged: no Mila turn; the source's own fixed-copy push, as with the flag off.
      if (!milaProactiveEnabled()) {
        const fb = ev.payload.fallbackPush;
        const res = fb ? await pushWith(deps)(athleteId, fb).catch(() => null) : null;
        return { done: true, outcome: await finish(ev, `flag_off${res ? `_fallback_${res.status}` : ""}`, now) };
      }
      if (rule.coalesceMs && await spokeRecently(ev, rule.coalesceMs, now)) return { done: true, outcome: await finish(ev, "coalesced", now) };
      return { done: false };
    }
  }
}

export type SpeakOutput = { spoke: true; conversationId: string; messageId: string } | { spoke: false; outcome: string };

export async function speakStep(athleteId: string, eventId: string, deps: DispatchDeps = {}, opts: { recheck?: boolean } = {}): Promise<SpeakOutput> {
  const ev = await loadEvent(athleteId, eventId);
  if (!ev) return { spoke: false, outcome: "missing" };
  if (ev.messageId && ev.conversationId) return { spoke: true, conversationId: ev.conversationId, messageId: ev.messageId };
  if (ev.dispatchedAt) return { spoke: false, outcome: ev.outcome ?? "done" };
  const now = clock(deps);
  const rule = ruleOf(ev.kind);
  const target = await targetConversation(ev, rule, now);

  // The turn may fail or be unable to run: the source's own fixed-copy push still goes out (never lose the news).
  const fallback = async (why: string): Promise<SpeakOutput> => {
    const fb = ev.payload.fallbackPush;
    const res = fb ? await pushWith(deps)(athleteId, fb).catch(() => null) : null;
    return { spoke: false, outcome: await finish(ev, `turn_${why}${res ? `_fallback_${res.status}` : ""}`, now) };
  };
  let result;
  try {
    result = await runProactiveTurn({ athleteId, kind: ev.kind as AthleteEventKind, payload: ev.payload, conversationId: target.id }, deps.turn);
  } catch (err: any) {
    logger.warn({ athleteId, eventId, err: String(err?.message ?? err).slice(0, 200) }, "proactive: turn could not run");
    return fallback("error");
  }
  const v = result.verdict;
  if (!v.send) {
    if (v.why === "failed") return fallback("failed");
    if (v.why === "defer") {
      // The turn never ran (their other Mila turns were running: engine/mastra/turn.ts admitRun). Mila decided nothing,
      // so when it cannot be tried again the news still goes out, as the source's fixed-copy push (as for a failure).
      const capped = !!result.run.turnCap;
      // At most one DEFER per event: a second one (or one on the re-check run) ends it, closed.
      if (opts.recheck || ev.outcome === MARK.deferred) {
        if (capped) return fallback("capped");
        logger.warn({ athleteId, eventId, kind: ev.kind }, "proactive: second DEFER, closed without a message");
        return { spoke: false, outcome: await finish(ev, "defer_exhausted", now) };
      }
      const at = new Date(now.getTime() + v.defer.afterMinutes * 60_000);
      try {
        await (deps.recheck ?? defaultRecheck)(athleteId, eventId, at);
      } catch (err: any) {
        logger.warn({ athleteId, eventId, err: String(err?.message ?? err).slice(0, 200) }, "proactive: re-check not scheduled, closed");
        if (capped) return fallback("capped");
        return { spoke: false, outcome: await finish(ev, "defer_unscheduled", now) };
      }
      await mark(ev, MARK.deferred);
      logger.info({ athleteId, eventId, kind: ev.kind, why: v.defer.why, afterMinutes: v.defer.afterMinutes, reason: v.defer.reason.slice(0, 200) }, "proactive: deferred once");
      return { spoke: false, outcome: MARK.deferred };
    }
    // Mila's own SILENT, or code failing closed: nothing written, nothing pushed, the reason logged.
    if (v.why !== "silent") logger.warn({ athleteId, eventId, kind: ev.kind, why: v.why, detail: (v as { detail?: string }).detail?.slice(0, 200) }, "proactive: decision refused, closed");
    return { spoke: false, outcome: await finish(ev, v.why, now) };
  }

  // A turn on the same deal or booking that finished while this one ran already said it (a burst): this one stays quiet.
  if (rule.coalesceMs && await spokeRecently(ev, rule.coalesceMs, now)) return { spoke: false, outcome: await finish(ev, "coalesced", now) };
  // The same words are already in their chats: never twice.
  if (await alreadySaid(athleteId, v.text, now)) return { spoke: false, outcome: await finish(ev, "duplicate", now) };

  // Only the finished message and its cards reach the athlete's conversation, marked as Mila-started and unread.
  await upsertConversationOnMessage(athleteId, target.id, target.title);
  const [msg] = await db.insert(chatMessages).values({
    athlete_id: athleteId, role: "assistant", content: v.text, conversation_id: target.id,
    agent_cards: v.cards.length ? v.cards : null, agent_run_id: result.run.runId, mila_started: true,
  }).returning({ id: chatMessages.id });
  await db.update(athleteEvents).set({ conversation_id: target.id, message_id: msg.id, ...(v.warning ? { outcome: MARK.warning } : {}) })
    .where(and(eq(athleteEvents.id, ev.id), eq(athleteEvents.athlete_id, athleteId)));
  // Mila has now said it: the same news waiting on the "next chat" queue is dropped, so it is not told twice.
  if (ev.payload.queueKey) await dropQueuedEvent(athleteId, ev.payload.queueKey).catch((err) => logger.warn({ err: err?.message }, "proactive: queued event not dropped"));
  await rememberMilaStarted(athleteId, target.id, { text: v.text, cards: v.cards.filter((c) => c.kind !== "how-i-got-this").map((c) => c.title) },
    `mila_started:${msg.id}`, PROACTIVE_LIMITS.rememberedPerConversation, now).catch((err) => logger.warn({ err: err?.message }, "proactive: message not remembered"));
  return { spoke: true, conversationId: target.id, messageId: msg.id };
}

/**
 * Chat markdown as the plain words a lock screen shows: links and images keep their text, code keeps its words, emphasis
 * marks, headings, quotes, list markers and fences go. An underscore inside a word (deal_id) stays.
 */
export function plainText(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*(```|~~~).*$/gm, "")                                  // code fences
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")                           // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")                            // links → their text
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1")               // autolinks
    .replace(/`+([^`]+?)`+/g, "$1")                                     // inline code
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")                               // block quotes
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")                               // headings
    .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm, "")               // list markers
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")                       // rules
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")                    // **bold**, __bold__
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")                           // ~~strike~~
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1")                           // *italics*
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")            // _italics_, never deal_id
    .replace(/[*_~`]{2,}/g, "")                                         // stray unpaired runs
    .replace(/(^|\s)[*_~`]+(?=\S)|(\S)[*_~`]+(?=\s|$)/g, "$1$2");        // a lone mark at a word's edge
}

/** Mila's first sentence as plain text, for the lock screen when they chose to see names there. */
export function firstSentence(text: string, max = 160): string {
  const t = plainText(text).replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** The notification for a Mila-started message: opens on it; one live notification per deal or booking. */
export function milaPushEvent(ev: Pick<EventRow, "dedupeKey" | "payload">, rule: ProactiveRule, at: { conversationId: string; messageId: string }, text: string): PushEvent {
  const subject = ev.payload.dealId ? `deal:${ev.payload.dealId}` : ev.payload.bookingId ? `booking:${ev.payload.bookingId}` : ev.dedupeKey;
  const collapse = `mila-${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;
  const body = rule.pushBody ?? "Mila has an update for you.";
  return {
    kind: "mila_message", dedupeKey: `mila:${ev.dedupeKey}`.slice(0, 200), title: "Mila", body,
    // A message that is only a card waiting on their tap has no words: the generic line, never an empty notification.
    named: { title: "Mila", body: firstSentence(text) || body },
    ...(rule.pref ? { pref: rule.pref } : {}),
    target: { screen: "mila", id: at.conversationId, messageId: at.messageId },
    collapseId: collapse, threadId: at.conversationId,
  };
}

export async function notifyStep(athleteId: string, eventId: string, deps: DispatchDeps = {}): Promise<{ outcome: string }> {
  const ev = await loadEvent(athleteId, eventId);
  if (!ev) return { outcome: "missing" };
  if (ev.dispatchedAt) return { outcome: ev.outcome ?? "done" };
  if (!ev.messageId || !ev.conversationId) return { outcome: await finish(ev, "no_message", clock(deps)) };
  const now = clock(deps);
  const rule = ruleOf(ev.kind);
  if (!rule.push) return { outcome: await finish(ev, "spoke_in_chat", now) };
  // A scam warning is said in the chat only: never a buzz about it.
  if (ev.outcome === MARK.warning) return { outcome: await finish(ev, "spoke_warning_in_chat", now) };
  // Their own switches (all notifications, and this kind), then quiet hours on their phone's clock: the message waits.
  const prefs = await readPreferences(athleteId);
  if (!prefs.enabled || (rule.pref && !prefs[rule.pref])) return { outcome: await finish(ev, "spoke_push_off", now) };
  if (inQuietHours(prefs, localMinutes(now, await athleteTimeZone(athleteId)))) return { outcome: await finish(ev, "spoke_quiet_hours", now) };
  if (await athleteActive(athleteId, now)) return { outcome: await finish(ev, "spoke_held_active", now) };
  // Pacing: never for an important business event or something they asked for (owner rule, 28 Oct 2026).
  if (!rule.important && await milaPushesToday(athleteId, now) >= PROACTIVE_LIMITS.dailyMilaPushCap) return { outcome: await finish(ev, "spoke_capped", now) };
  const [m] = await db.select({ content: chatMessages.content }).from(chatMessages)
    .where(and(eq(chatMessages.id, ev.messageId), eq(chatMessages.athlete_id, athleteId))).limit(1);
  const res = await pushWith(deps)(athleteId, milaPushEvent(ev, rule, { conversationId: ev.conversationId, messageId: ev.messageId }, m?.content ?? ""));
  return { outcome: await finish(ev, res.status === "sent" ? "spoke" : `spoke_push_${res.status}`, now) };
}
