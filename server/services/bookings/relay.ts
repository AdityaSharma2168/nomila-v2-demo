/**
 * bookings/relay.ts — the booking thread (booking_messages). Every message goes through Nomila: it is checked first and
 * delivered only if it passes. Neither side ever sees the other's email or phone.
 *
 * HELD (not delivered; the sender sees "Not delivered…"): contact details (emails, phone numbers, @handles), links, and
 * asks to pay off-platform — the relay rules of the public card v3.1 §7a, which keep the relay from being bypassed by
 * accident. These are hard rules, not judgment, so they are plain checks. An abuse classifier (a model call that fails
 * closed) and the human review queue for held messages are the safety PR (S1): until then a held message simply stays
 * undelivered, and anything abusive can be reported.
 *
 * A notice of a new message never carries the text.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { bookingMessages, bookings } from "../../../shared/schema";
import type { Booking, BookingMessage } from "../../../shared/schema";
import type { BookingMessageView } from "../../../shared/bookingsApi";
import { BOOKINGS } from "./config";
import { coded } from "./common";
import { notices } from "./notices";
import { recordBookingEvent } from "./stateMachine";

export type HeldReason = "contact_details" | "link" | "off_platform_payment";

const EMAIL = /[A-Z0-9._%+-]+\s*(@|\(at\)|\[at\])\s*[A-Z0-9.-]+\s*(\.|\(dot\)|\[dot\])\s*[A-Z]{2,}/i;
const PHONE = /(\+?\d[\s().-]*){7,}/;
const HANDLE = /(^|[\s(])@[A-Z0-9_.]{2,}/i;
const LINK = /\bhttps?:\/\/|\bwww\.|\b[A-Z0-9-]{2,}\.(com|net|org|io|co|me|app|ly|gg|tv|us|link)\b/i;
const OFF_PLATFORM = /\b(venmo|cash\s?app|cashapp|zelle|paypal|apple\s?cash|wire\s+transfer|bitcoin|crypto|pay\s+(you|me)\s+(directly|outside|in\s+cash)|pay\s+cash)\b/i;

/** The relay check. Order matters only for the reason shown to the sender. */
export function moderateText(text: string): { moderation: "clean" } | { moderation: "held"; reason: HeldReason } {
  if (EMAIL.test(text) || PHONE.test(text) || HANDLE.test(text)) return { moderation: "held", reason: "contact_details" };
  if (OFF_PLATFORM.test(text)) return { moderation: "held", reason: "off_platform_payment" };
  if (LINK.test(text)) return { moderation: "held", reason: "link" };
  return { moderation: "clean" };
}

const THREAD_OPEN: Booking["status"][] = ["requested", "accepted", "confirmed", "in_review", "issue_reported", "disputed", "released"];

export function threadOpen(status: string): boolean {
  return THREAD_OPEN.includes(status as Booking["status"]);
}

/** Post a message as `sender`. Returns the stored row (held rows are stored, never delivered). */
export async function postMessage(b: Booking, sender: "athlete" | "buyer", raw: unknown): Promise<BookingMessage> {
  if (!threadOpen(b.status)) throw coded("THREAD_CLOSED");
  const body = typeof raw === "string" ? raw.trim() : "";
  if (!body) throw coded("INVALID", [{ field: "body", problem: "empty" }]);
  if (body.length > BOOKINGS.threadMessageMaxChars) throw coded("INVALID", [{ field: "body", problem: `at most ${BOOKINGS.threadMessageMaxChars} characters` }]);
  const m = moderateText(body);
  const now = new Date();
  const [row] = await db.insert(bookingMessages).values({
    booking_id: b.id, sender, body, moderation: m.moderation,
    moderation_reason: m.moderation === "held" ? m.reason : null,
    delivered_at: m.moderation === "clean" ? now : null,
  }).returning();
  if (m.moderation === "held") {
    await recordBookingEvent(b.id, "message", sender, { held: m.reason, message_id: row.id });
  } else if (sender === "athlete") {
    await notices.newMessageToBuyer(b);
  } else {
    await notices.newMessageToAthlete(b);
  }
  return row;
}

/** The thread as `viewer` sees it: the other side's held messages never appear; your own held ones say so. */
export async function threadFor(bookingId: string, viewer: "athlete" | "buyer"): Promise<BookingMessageView[]> {
  const rows = await db.select().from(bookingMessages).where(eq(bookingMessages.booking_id, bookingId)).orderBy(asc(bookingMessages.created_at));
  const out: BookingMessageView[] = [];
  for (const r of rows) {
    const mine = r.sender === viewer;
    const delivered = r.moderation === "clean";
    if (!mine && !delivered) continue;
    out.push({
      id: r.id,
      from: r.sender === "nomila" ? "nomila" : mine ? "you" : "them",
      body: r.body,
      held: mine && !delivered,
      heldReason: mine && !delivered ? ((r.moderation_reason as BookingMessageView["heldReason"]) ?? "review") : null,
      at: r.created_at.toISOString(),
    });
  }
  return out;
}

/** Messages from the other side after the viewer's own last message (the "new" count on her list). */
export async function unansweredCounts(bookingIds: string[], viewer: "athlete" | "buyer"): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!bookingIds.length) return out;
  const rows = await db.select({ id: bookingMessages.booking_id, sender: bookingMessages.sender, moderation: bookingMessages.moderation })
    .from(bookingMessages).where(inArray(bookingMessages.booking_id, bookingIds)).orderBy(asc(bookingMessages.created_at));
  for (const id of bookingIds) out.set(id, 0);
  for (const r of rows) {
    if (r.sender === viewer) out.set(r.id, 0);
    else if (r.sender !== "nomila" && r.moderation === "clean") out.set(r.id, (out.get(r.id) ?? 0) + 1);
  }
  return out;
}

/** A Nomila status line in the thread ("Accepted: your card was charged $177.96"). */
export async function nomilaLine(bookingId: string, text: string): Promise<void> {
  await db.insert(bookingMessages).values({ booking_id: bookingId, sender: "nomila", body: text, moderation: "clean", delivered_at: new Date() });
}

export async function bookingById(id: string): Promise<Booking | null> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return b ?? null;
}
