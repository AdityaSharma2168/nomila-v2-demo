/**
 * services/push/events.ts — the first three notifications (owner, 12 Oct 2026), each fixed copy built by code:
 *
 *   plan_ready    "Your plan's ready" — from the plan run's tell step, only when she has something to act on (a new
 *                 plan with posts or other actions this week). Nothing new, skipped, or nothing to do: no push. A plan
 *                 nobody asked for in chat gets this push and the Goals notice, never a chat message.
 *   brand_reply   "A brand replied" — a new inbound message on a thread that is already a deal (the deal detector's
 *                 reply branch, once per stored message), only for a message from the last 24 hours (a backfill, a
 *                 reconnect, a dead-letter replay or a second inbox never fires old replies), at most one per deal per
 *                 3 hours. The brand's name shows only when she turned "Show brand names in notifications" on (off by
 *                 default: the lock screen). No email text, ever.
 *   waiting       "Waiting on your tap" — an outgoing action queued for her approval (agent/approvals.ts queueApproval),
 *                 fixed copy per verb (never the item's own title). Not for the chat's own "Want me to save that?"
 *                 (save_memory). A tap opens Ask Mila, where the card waits. NOTE: no chat tool queues anything but
 *                 save_memory today, so this does not fire yet; it is wired for the first act-level tool.
 *
 * Each says what is waiting and opens the screen it is on. None sends, posts, accepts or pays anything: her tap in the
 * app does that (tap-to-send).
 */
import { and, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import { deals, pendingActions, pushSends } from "../../../shared/schema";
import type { ApprovalVerb } from "../../../shared/agent";
import type { PlanReadyFacts } from "../../agent/plan/tell";
import { pushEnabled, pushSoon, sendPush, type PushEvent, type SendResult } from "./push";
import { milaProactiveEnabled } from "../../agent/proactive/config";
import { emitAthleteEvent, routeToMila, type StartDispatch } from "../../agent/proactive/events";

const HOUR = 3_600_000;
/** A reply older than this when it is stored is history (a backfill, a reconnect, a replay): no push. */
export const BRAND_REPLY_FRESH_MS = 24 * HOUR;
/** At most one brand-reply push per deal in this window. */
export const BRAND_REPLY_COALESCE_MS = 3 * HOUR;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The plan-ready push, or null when there is nothing for her to act on. */
export function planReadyEvent(runId: string, f: PlanReadyFacts): PushEvent | null {
  if (f.outcome !== "planned") return null;
  const c = f.counts;
  if (!c.posts && !c.otherActions) return null;
  const parts = [
    c.posts ? `${plural(c.posts, "post", "posts")} this week.` : `${plural(c.otherActions, "thing", "things")} to do this week.`,
    f.kitsStep !== "off" && c.kitsBuilt ? `${plural(c.kitsBuilt, "post kit is", "post kits are")} ready to look at.` : null,
  ];
  return { kind: "plan_ready", dedupeKey: `plan_ready:${runId}`, title: "Your plan's ready", body: parts.filter(Boolean).join(" "), target: { screen: "goals" } };
}

export const pushPlanReady = (athleteId: string, runId: string, f: PlanReadyFacts): Promise<SendResult | null> => {
  const e = planReadyEvent(runId, f);
  return e ? sendPush(athleteId, e) : Promise.resolve(null);
};

export function brandReplyEvent(dealId: string, messageId: string, brand: string | null): PushEvent {
  const name = brand?.replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    kind: "brand_reply", dedupeKey: `brand_reply:${dealId}:${messageId}`,
    title: "A brand replied", body: "Open Nomila to read it.",
    ...(name ? { named: { title: `${name} replied` } } : {}),
    coalesce: { prefix: `brand_reply:${dealId}:`, withinMs: BRAND_REPLY_COALESCE_MS },
    target: { screen: "opportunities" },
  };
}

/**
 * A brand replied on a deal thread (fire and forget). Nothing at all while push is off; nothing for a message older than
 * 24 hours, or with no date (it cannot be shown to be new); otherwise the deal's own brand name, read for this athlete
 * only.
 */
export function pushBrandReply(athleteId: string, dealId: string, messageId: string, receivedAt: Date | null, now: Date = new Date()): void {
  if (!pushEnabled() && !milaProactiveEnabled()) return;
  if (!receivedAt || Number.isNaN(receivedAt.getTime()) || now.getTime() - receivedAt.getTime() > BRAND_REPLY_FRESH_MS) return;
  void (async () => {
    const [d] = await db.select({ brand: deals.brand_name }).from(deals).where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId))).limit(1);
    if (!d) return;
    const event = brandReplyEvent(dealId, messageId, d.brand);
    // MILA_PROACTIVE: Mila reads the reply and writes the message; this push is its fallback (agent/proactive).
    if (routeToMila({ athleteId, kind: "brand_reply", dedupeKey: `brand_reply:${dealId}:${messageId}`, payload: { dealId, label: d.brand, fallbackPush: event, queueKey: `deal_reply:${dealId}` } })) return;
    if (pushEnabled()) pushSoon(athleteId, event);
  })().catch(() => undefined);
}

/** A payment notice older than this when it is filed is history (a backfill, a re-check): no push. */
export const PAYMENT_FRESH_MS = 7 * 24 * HOUR;

/** Dev switch for the payment push (PUSH_PAYMENT_RECEIVED=true), on top of PUSH_NOTIFICATIONS. Off everywhere else. */
export const paymentPushEnabled = (): boolean => pushEnabled() && process.env.PUSH_PAYMENT_RECEIVED === "true";

/** "$5,000" / "5,000.50 EUR": whole units when whole. */
export function moneyWords(amountCents: number, currency = "usd"): string {
  const cur = currency.toUpperCase();
  const whole = amountCents % 100 === 0;
  const n = (amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return cur === "USD" ? `$${n}` : `${n} ${cur}`;
}

/**
 * "{Brand} paid you $X" — a payment notice filed on her deal. Without her "Show brand names" switch the lock screen
 * names neither the brand nor the amount. One push per notice thread; a tap opens that brand's opportunity.
 */
export function paymentReceivedEvent(p: { threadId: string; opportunityId: string; brand: string | null; amountCents: number | null; currency?: string }): PushEvent {
  const name = p.brand?.replace(/\s+/g, " ").trim().slice(0, 60) || null;
  const amount = p.amountCents != null ? moneyWords(p.amountCents, p.currency) : null;
  const named = name ? { title: amount ? `${name} paid you ${amount}` : `${name} paid you` } : undefined;
  return {
    kind: "payment_received", dedupeKey: `payment_received:${p.threadId}`,
    title: "You got paid", body: "Open Nomila to see it.",
    ...(named ? { named } : {}),
    target: { screen: "opportunities", id: p.opportunityId },
  };
}

/** A payment notice was filed on her deal (fire and forget): only while the dev switch is on and the notice is fresh. */
export function pushPaymentReceived(athleteId: string, p: Parameters<typeof paymentReceivedEvent>[0] & { paidAt: Date | null }, now: Date = new Date()): void {
  if (!paymentPushEnabled() && !milaProactiveEnabled()) return;
  if (!p.paidAt || Number.isNaN(p.paidAt.getTime()) || now.getTime() - p.paidAt.getTime() > PAYMENT_FRESH_MS) return;
  const event = paymentReceivedEvent(p);
  // MILA_PROACTIVE: Mila tells them in the chat; the push is only the fallback while the payment push is on.
  const routed = routeToMila({
    athleteId, kind: "payment_received", dedupeKey: `payment_received:${p.threadId}`,
    payload: { label: p.brand, facts: { amountCents: p.amountCents, currency: p.currency ?? "usd" }, ...(paymentPushEnabled() ? { fallbackPush: event } : {}) },
  });
  if (!routed && paymentPushEnabled()) pushSoon(athleteId, event);
}

/** Fixed copy per verb: what is waiting, never the item's own words. */
export const WAITING_COPY: Record<Exclude<ApprovalVerb, "save_memory">, string> = {
  send_message: "A message is ready for you to check.",
  post: "A post is ready for you to check.",
  publish: "Something is ready to publish when you say so.",
  deal_response: "A deal reply is ready for you to check.",
  payment: "A payment is waiting for your OK.",
  calendar_invite: "An invite is ready for you to check.",
  other_act: "Something is ready for you to check.",
};

/** An item waiting for her tap, or null for one that lives only in the chat she is in. */
export function waitingEvent(item: { id: string; verb: ApprovalVerb }): PushEvent | null {
  if (item.verb === "save_memory") return null;
  const what = WAITING_COPY[item.verb] ?? WAITING_COPY.other_act;
  return { kind: "waiting", dedupeKey: `waiting:${item.id}`, title: "Waiting on your tap", body: `${what} Nothing goes out until you tap.`, target: { screen: "mila" } };
}

/** A failed send is retried once, within this long of its first try (an hour-old reply or item is stale news). */
export const RETRY_WITHIN_MS = HOUR;

/**
 * The one retry, for real (the push-receipts-cron): a brand reply or a waiting item whose send failed outright (no phone
 * took it: Expo was down, or every ticket errored), tried once, under an hour old, is sent again. The event is rebuilt
 * from its key — the deal's own brand name; a waiting item only while it still waits on her tap — so nothing about it
 * was stored. sendPush claims attempt 2 and keeps every rule (her switches, quiet hours, the daily cap). A plan-ready
 * push is not retried here: its facts are the run's, not rebuildable from a key; Goals and the chat already say it.
 */
export async function retryFailedSends(opts: { now?: Date; limit?: number } = {}): Promise<{ retried: number; sent: number }> {
  const out = { retried: 0, sent: 0 };
  if (!pushEnabled()) return out;
  const now = opts.now ?? new Date();
  const rows = await db.select({ athleteId: pushSends.athlete_id, kind: pushSends.kind, key: pushSends.dedupe_key }).from(pushSends).where(and(
    inArray(pushSends.kind, ["brand_reply", "waiting"]), eq(pushSends.attempts, 1), eq(pushSends.devices, 0), isNotNull(pushSends.error),
    gt(pushSends.created_at, new Date(now.getTime() - RETRY_WITHIN_MS)),
  )).limit(Math.max(1, Math.min(opts.limit ?? 100, 500)));
  for (const r of rows) {
    let event: PushEvent | null = null;
    const parts = r.key.split(":");
    if (r.kind === "brand_reply" && parts.length === 3) {
      const [d] = await db.select({ brand: deals.brand_name }).from(deals).where(and(eq(deals.id, parts[1]), eq(deals.athlete_id, r.athleteId))).limit(1);
      if (d) event = brandReplyEvent(parts[1], parts[2], d.brand);
    } else if (r.kind === "waiting" && parts.length === 2 && (parts[0] === "waiting" || parts[0] === "waiting_expiring")) {
      const [p] = await db.select({ status: pendingActions.status, kind: pendingActions.kind, payload: pendingActions.payload, expiresAt: pendingActions.expires_at }).from(pendingActions)
        .where(and(eq(pendingActions.id, parts[1]), eq(pendingActions.athlete_id, r.athleteId))).limit(1);
      const verb = (p?.payload as { verb?: ApprovalVerb } | null)?.verb ?? (p?.kind === "send_reply" ? "send_message" : undefined);
      // The expiry reminder is rebuilt as itself (its own key and copy), only while the item still waits and has not lapsed.
      if (parts[0] === "waiting_expiring") {
        if (p?.status === "pending" && verb !== "save_memory" && p.expiresAt && p.expiresAt.getTime() > now.getTime()) event = expiringEvent(parts[1]);
      } else if (p?.status === "pending" && verb) event = waitingEvent({ id: parts[1], verb });
    }
    if (!event) continue;
    out.retried++;
    if ((await sendPush(r.athleteId, event, { now })).status === "sent") out.sent++;
  }
  return out;
}

/** A reply draft waiting this long (she did not approve it as she made it) is worth a push. */
export const REPLY_WAIT_MS = 10 * 60_000;
/** An item that still waits this close to its expiry gets one reminder. */
export const EXPIRY_REMINDER_MS = 24 * HOUR;

/** "Expires tomorrow": one reminder for anything still waiting on her tap the day before it lapses. */
export function expiringEvent(itemId: string): PushEvent {
  return {
    kind: "waiting", dedupeKey: `waiting_expiring:${itemId}`, title: "Waiting on your tap",
    body: "Something you haven't approved expires tomorrow. Nothing goes out until you tap.", target: { screen: "opportunities" },
  };
}

/**
 * The same cron, for what the agent harness does not queue (deals audit, 12 Oct): a reply draft (pending_actions kind
 * send_reply — the ask-terms batch, a Mila or voice draft) still waiting 10 minutes after it was made gets the waiting
 * push once (a draft she approves as she makes it never does); and anything still waiting on her tap gets one reminder
 * the day before it expires (ask-terms rows lapse after 7 days). Fixed copy; every push rule applies.
 *
 * With MILA_PROACTIVE on, each reminder is handed to the dispatcher instead (rules.ts "reminder"), which sends the same
 * push once. The counts include those handed over (a new event logged), so the cron's totals mean the same with the
 * flag on or off; a reminder already handed over on an earlier sweep is not counted again. Tests pass `startDispatch`.
 */
export async function sweepWaiting(opts: { now?: Date; limit?: number; startDispatch?: StartDispatch } = {}): Promise<{ waiting: number; expiring: number }> {
  const out = { waiting: 0, expiring: 0 };
  if (!pushEnabled()) return out;
  // True when a new event was logged for the dispatcher (a repeat, or a failure that fell back to the push, is not).
  const handOver = async (athleteId: string, kind: "draft_waiting" | "item_expiring", id: string, event: PushEvent) =>
    !!(await emitAthleteEvent({ athleteId, kind, dedupeKey: `${kind}:${id}`, payload: { fallbackPush: event } }, { start: opts.startDispatch }));
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const replies = await db.select({ id: pendingActions.id, athleteId: pendingActions.athlete_id }).from(pendingActions).where(and(
    eq(pendingActions.kind, "send_reply"), eq(pendingActions.status, "pending"),
    lt(pendingActions.created_at, new Date(now.getTime() - REPLY_WAIT_MS)), gt(pendingActions.created_at, new Date(now.getTime() - 24 * HOUR)),
  )).limit(limit);
  for (const r of replies) {
    const event = waitingEvent({ id: r.id, verb: "send_message" })!;
    // MILA_PROACTIVE: the dispatcher sends this same reminder, once (rules.ts "reminder").
    if (milaProactiveEnabled()) { if (await handOver(r.athleteId, "draft_waiting", r.id, event)) out.waiting++; continue; }
    if ((await sendPush(r.athleteId, event, { now })).status === "sent") out.waiting++;
  }
  const expiring = await db.select({ id: pendingActions.id, athleteId: pendingActions.athlete_id }).from(pendingActions).where(and(
    eq(pendingActions.status, "pending"), isNotNull(pendingActions.expires_at),
    gt(pendingActions.expires_at, now), lt(pendingActions.expires_at, new Date(now.getTime() + EXPIRY_REMINDER_MS)),
    // The chat's own "Want me to save that?" (save_memory) lives only in the chat: never pushed, reminder included.
    sql`NOT (${pendingActions.kind} = 'agent_action' AND coalesce(${pendingActions.payload}->>'verb', '') = 'save_memory')`,
  )).limit(limit);
  for (const r of expiring) {
    const event = expiringEvent(r.id);
    if (milaProactiveEnabled()) { if (await handOver(r.athleteId, "item_expiring", r.id, event)) out.expiring++; continue; }
    if ((await sendPush(r.athleteId, event, { now })).status === "sent") out.expiring++;
  }
  return out;
}

export function pushWaiting(athleteId: string, item: { id: string; verb: ApprovalVerb }): void {
  if (!pushEnabled()) return;
  const e = waitingEvent(item);
  if (e) pushSoon(athleteId, e);
}
