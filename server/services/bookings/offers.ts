/**
 * bookings/offers.ts — what she sells (offers) and the times she offers (offer_slots). Always scoped to her athlete id:
 * another athlete's offer is NOT_FOUND, never a hint that it exists.
 *
 *   draft      saved freely (no payout account needed): format, words, length, HER price (she receives all of it), where,
 *              her rules, her cancellation window (24h / 48h / 7 days), slots or request mode
 *   publish    her tap on a confirm sheet: needs Stripe payouts working, and for in person a venue
 *              she confirmed is a public place or her usual venue (never her home). ID + selfie is always on in person.
 *   pause      hers to pause and resume — except a pause by Nomila after missed sessions, which only support lifts
 *   delete     archives (bookings keep their snapshot); a live offer's edits apply to new requests only
 */
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { bookings, offerSlots, offers, pushDevices } from "../../../shared/schema";
import type { Offer, OfferSlot } from "../../../shared/schema";
import type { OfferView, SlotView } from "../../../shared/bookingsApi";
import { assertPayoutReady } from "../payments/connect";
import { BOOKINGS, isAllowedFreeCancelHours } from "./config";
import { isBookablePrice, MAX_GROUP_PEOPLE, quoteBookingCharge } from "./money";
import { coded, validZone } from "./common";
import { LIVE_STATUSES } from "./stateMachine";
import { startProblem } from "./clocks";
import { parseAvailability } from "./availability";

const FORMATS = ["video_call", "appearance", "clinic", "custom"] as const;
const AUDIENCES = ["one", "private_group", "open_group"] as const;
const DAY = 86_400_000;

export interface OfferInput {
  format?: unknown; title?: unknown; description?: unknown; price_cents?: unknown; duration_minutes?: unknown;
  location_mode?: unknown; video_mode?: unknown; venue?: unknown; venue_confirmed?: unknown;
  require_id_verification?: unknown; allow_minor_attendees?: unknown; returning_buyers_only?: unknown;
  scheduling_mode?: unknown; available_from?: unknown; available_until?: unknown; free_cancel_hours?: unknown;
  /** Her IANA time zone (the app sends the phone's); kept for her notices and reminders. */
  time_zone?: unknown;
  /** 0153: who it's for — "one" | "private_group" | "open_group" — and, for a group, how many people (2–20). */
  audience?: unknown; max_people?: unknown;
  /** 0154: open groups only — each spot waits for her Accept (default false: spots confirm themselves). */
  approve_each_spot?: unknown;
  /** 0155: her weekly hours ({ version: 1, preset, blocks }) so the app's hours editor can reopen them, or null. */
  availability?: unknown;
}

type Field = keyof OfferInput;
export type OfferProblem = { field: Field; problem: string };

const str = (v: unknown, max: number): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : typeof v === "string" ? v.trim().slice(0, max) || null : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const isoDate = (v: unknown): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;

/** Validate a create / patch body into column values. `base` is the current offer on a patch. */
export function parseOfferInput(input: OfferInput, base: Partial<Offer> | null): { ok: true; values: Partial<typeof offers.$inferInsert> } | { ok: false; problems: OfferProblem[] } {
  const v: Partial<typeof offers.$inferInsert> = {};
  const problems: OfferProblem[] = [];
  const bad = (field: Field, problem: string) => problems.push({ field, problem });

  if (input.format !== undefined) { if (FORMATS.includes(input.format as any)) v.format = input.format as string; else bad("format", "unknown format"); }
  const title = str(input.title, 80);
  if (title !== undefined) { if (title) v.title = title; else bad("title", "a title is needed"); }
  const description = str(input.description, 600);
  if (description !== undefined) v.description = description;
  else if (input.description !== undefined) bad("description", "text only");
  if (input.price_cents !== undefined) {
    if (typeof input.price_cents === "number" && isBookablePrice(input.price_cents)) v.price_cents = input.price_cents;
    else bad("price_cents", `between ${BOOKINGS.minPriceCents} and ${BOOKINGS.maxPriceCents} cents`);
  }
  if (input.duration_minutes !== undefined) {
    if (typeof input.duration_minutes === "number" && BOOKINGS.durationMinOptions.includes(input.duration_minutes)) v.duration_minutes = input.duration_minutes;
    else bad("duration_minutes", `one of ${BOOKINGS.durationMinOptions.join(", ")}`);
  }
  if (input.location_mode !== undefined) { if (input.location_mode === "virtual" || input.location_mode === "in_person") v.location_mode = input.location_mode; else bad("location_mode", "virtual or in_person"); }
  if (input.video_mode !== undefined) { if (input.video_mode === null || input.video_mode === "livekit" || input.video_mode === "link") v.video_mode = input.video_mode as any; else bad("video_mode", "livekit or link"); }
  const venue = str(input.venue, 200);
  if (venue !== undefined) v.venue = venue;
  for (const k of ["require_id_verification", "allow_minor_attendees", "returning_buyers_only", "approve_each_spot"] as const) {
    if (input[k] !== undefined) { const b = bool(input[k]); if (b === undefined) bad(k, "true or false"); else (v as any)[k] = b; }
  }
  if (input.scheduling_mode !== undefined) { if (input.scheduling_mode === "slots" || input.scheduling_mode === "request") v.scheduling_mode = input.scheduling_mode; else bad("scheduling_mode", "slots or request"); }
  for (const k of ["available_from", "available_until"] as const) {
    if (input[k] !== undefined) { const d = isoDate(input[k]); if (d === undefined) bad(k, "YYYY-MM-DD"); else (v as any)[k] = d; }
  }
  if (input.free_cancel_hours !== undefined) {
    if (typeof input.free_cancel_hours === "number" && isAllowedFreeCancelHours(input.free_cancel_hours)) v.free_cancel_hours = input.free_cancel_hours;
    else bad("free_cancel_hours", `one of ${BOOKINGS.freeCancelHoursOptions.join(", ")}`);
  }

  if (input.time_zone !== undefined) {
    const tz = typeof input.time_zone === "string" ? validZone(input.time_zone.slice(0, 64)) : null;
    if (tz) v.time_zone = tz; else bad("time_zone", "an IANA time zone");
  }
  if (input.audience !== undefined) {
    if (AUDIENCES.includes(input.audience as any)) v.audience = input.audience as string; else bad("audience", "one, private_group or open_group");
  }
  if (input.max_people !== undefined) {
    if (typeof input.max_people === "number" && Number.isInteger(input.max_people) && input.max_people >= 1 && input.max_people <= MAX_GROUP_PEOPLE) v.max_people = input.max_people;
    else bad("max_people", `2 to ${MAX_GROUP_PEOPLE} people`);
  }

  if (input.availability !== undefined) {
    const a = parseAvailability(input.availability);
    if (a.ok) v.availability = a.value; else bad("availability", a.problem);
  }

  // Cross-field rules on the merged result.
  const m = { ...base, ...v } as Partial<Offer>;
  if (m.location_mode === "in_person") {
    v.require_id_verification = true;                 // always on in person (offers_in_person_id_check)
    v.video_mode = null;
  } else if (m.location_mode === "virtual" && !m.video_mode) {
    v.video_mode = "livekit";
  }
  if (input.venue !== undefined || input.location_mode !== undefined) v.venue_confirmed_at = null;   // a new place needs a new tick
  if (input.venue_confirmed === true && (m.location_mode === "in_person") && (venue ?? m.venue)) v.venue_confirmed_at = new Date();
  if (m.available_from && m.available_until && m.available_from > m.available_until) bad("available_until", "after available_from");
  // Who it's for (0153): 1:1 is always one person; a group is 2–20 (a group switched on without a size starts at 2).
  const audience = m.audience ?? "one";
  // "Approve each spot" (0154) is an open-group setting: anything else is answered request by request already.
  if (audience !== "open_group" && m.approve_each_spot) v.approve_each_spot = false;
  if (audience === "one") { if (m.max_people !== 1) v.max_people = 1; }
  else {
    const n = v.max_people ?? m.max_people ?? 1;
    if (n < 2) { if (input.max_people !== undefined) bad("max_people", `2 to ${MAX_GROUP_PEOPLE} people`); else v.max_people = 2; }
    // An open group is sold by set times (strangers sign up to the same time); "only when I say" stays 1:1 or private.
    if (audience === "open_group" && (m.scheduling_mode ?? "request") !== "slots") {
      if (input.scheduling_mode !== undefined || base) bad("scheduling_mode", "open group sessions use set times");
      else v.scheduling_mode = "slots";
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, values: v };
}

/** Her phone's time zone (the newest registered device), or null. */
export async function phoneZone(athleteId: string): Promise<string | null> {
  const [d] = await db.select({ tz: pushDevices.time_zone }).from(pushDevices).where(eq(pushDevices.athlete_id, athleteId))
    .orderBy(desc(pushDevices.last_seen_at)).limit(1);
  return validZone(d?.tz ?? null);
}

export function newPublicId(): string {
  return randomBytes(9).toString("base64url");
}

export async function getOffer(athleteId: string, offerId: string): Promise<Offer> {
  const [o] = await db.select().from(offers).where(and(eq(offers.id, offerId), eq(offers.athlete_id, athleteId))).limit(1);
  if (!o || o.status === "archived") throw coded("NOT_FOUND");
  return o;
}

export async function createOffer(athleteId: string, input: OfferInput): Promise<Offer> {
  for (const required of ["format", "title", "price_cents", "duration_minutes", "location_mode"] as const) {
    if (input[required] === undefined) throw coded("INVALID", [{ field: required, problem: "required" }]);
  }
  const parsed = parseOfferInput(input, null);
  if (!parsed.ok) throw coded("INVALID", parsed.problems);
  const time_zone = parsed.values.time_zone ?? await phoneZone(athleteId);
  const [o] = await db.insert(offers).values({
    athlete_id: athleteId, public_id: newPublicId(), status: "draft", time_zone,
    free_cancel_hours: BOOKINGS.freeCancelHoursDefault, policy_key: BOOKINGS.cancellationPolicyVersion,
    ...(parsed.values as any),
  }).returning();
  return o;
}

export async function updateOffer(athleteId: string, offerId: string, input: OfferInput): Promise<Offer> {
  const cur = await getOffer(athleteId, offerId);
  const parsed = parseOfferInput(input, cur);
  if (!parsed.ok) throw coded("INVALID", parsed.problems);
  await assertGroupEditAllowed(cur, parsed.values);
  const [o] = await db.update(offers).set({ ...parsed.values, updated_at: new Date() })
    .where(and(eq(offers.id, offerId), eq(offers.athlete_id, athleteId))).returning();
  return o;
}

/**
 * Group edits (0153) while people are booked: who it's for can't change (bookings keep their snapshot, and an open
 * time's spots would no longer add up), and an open group's spots can't drop below the fullest upcoming time.
 */
async function assertGroupEditAllowed(cur: Offer, next: Partial<typeof offers.$inferInsert>): Promise<void> {
  const audienceChanges = next.audience !== undefined && next.audience !== cur.audience;
  const shrinks = next.max_people !== undefined && next.max_people < cur.max_people;
  if (!audienceChanges && !shrinks) return;
  const live = await db.select({ slot: bookings.slot_id, people: sql<number>`coalesce(sum(${bookings.party_size}), 0)::int` }).from(bookings)
    .where(and(eq(bookings.offer_id, cur.id), inArray(bookings.status, [...LIVE_STATUSES]))).groupBy(bookings.slot_id);
  if (!live.length) return;
  if (audienceChanges) throw coded("HAS_BOOKINGS");
  if (cur.audience === "open_group") {
    const fullest = Math.max(...live.map((r) => Number(r.people)));
    if (next.max_people! < fullest) throw coded("INVALID", [{ field: "max_people", problem: `at least ${fullest} (already booked)` }]);
  }
}

/** What still blocks publishing, in order. Empty = ready. */
export function publishBlockers(o: Offer, payoutReady: boolean): string[] {
  const out: string[] = [];
  if (!payoutReady) out.push("payouts");
  if (o.location_mode === "in_person" && (!o.venue || !o.venue_confirmed_at)) out.push("venue");
  if (o.paused_reason === "no_show_review" || o.paused_reason === "support") out.push("paused_by_nomila");
  return out;
}

/** Her tap on "Publish to my card". Throws CONNECT_REQUIRED / NOT_READY / PAUSED_BY_NOMILA. */
export async function publishOffer(athleteId: string, offerId: string, body: { adult_attested?: unknown }): Promise<Offer> {
  const cur = await getOffer(athleteId, offerId);
  if (cur.paused_reason === "no_show_review" || cur.paused_reason === "support") throw coded("PAUSED_BY_NOMILA");
  if (await athletePausedByNomila(athleteId)) throw coded("PAUSED_BY_NOMILA");
  await assertPayoutReady(athleteId);              // throws CONNECT_REQUIRED (re-reads Stripe once first)
  // No "I'm 18 or older" tick (owner, 22 Oct): the athlete's age never gates publishing. adult_attested_at stays as
  // history; a tick still sent by an older app build is recorded and ignored.
  const adultAt = cur.adult_attested_at ?? (body.adult_attested === true ? new Date() : null);
  const blockers = publishBlockers(cur, true);
  if (blockers.length) throw coded("NOT_READY", blockers);
  const [o] = await db.update(offers).set({ status: "published", paused_reason: null, adult_attested_at: adultAt, updated_at: new Date() })
    .where(and(eq(offers.id, offerId), eq(offers.athlete_id, athleteId))).returning();
  return o;
}

export async function pauseOffer(athleteId: string, offerId: string): Promise<Offer> {
  const cur = await getOffer(athleteId, offerId);
  if (cur.status !== "published") throw coded("WRONG_STATE", { status: cur.status });
  const [o] = await db.update(offers).set({ status: "paused", paused_reason: "athlete", updated_at: new Date() })
    .where(and(eq(offers.id, offerId), eq(offers.athlete_id, athleteId))).returning();
  return o;
}

export async function resumeOffer(athleteId: string, offerId: string): Promise<Offer> {
  const cur = await getOffer(athleteId, offerId);
  if (cur.status !== "paused") throw coded("WRONG_STATE", { status: cur.status });
  if (cur.paused_reason !== "athlete") throw coded("PAUSED_BY_NOMILA");
  return publishOffer(athleteId, offerId, {});
}

/** Archive (bookings keep their snapshots). Live requests and sessions still run to the end. */
export async function archiveOffer(athleteId: string, offerId: string): Promise<void> {
  await getOffer(athleteId, offerId);
  await db.update(offers).set({ status: "archived", paused_reason: null, updated_at: new Date() })
    .where(and(eq(offers.id, offerId), eq(offers.athlete_id, athleteId)));
}

/** Her offers are paused by Nomila (missed sessions or support) — she can't publish until support lifts it. */
export async function athletePausedByNomila(athleteId: string): Promise<boolean> {
  const [r] = await db.select({ n: count() }).from(offers)
    .where(and(eq(offers.athlete_id, athleteId), eq(offers.status, "paused"), inArray(offers.paused_reason, ["no_show_review", "support"])));
  return (r?.n ?? 0) > 0;
}

// ─── Slots ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function listSlots(athleteId: string, offerId: string, now = new Date()): Promise<SlotView[]> {
  const o = await getOffer(athleteId, offerId);
  const rows = await db.select().from(offerSlots)
    .where(and(eq(offerSlots.offer_id, offerId), eq(offerSlots.athlete_id, athleteId), isNull(offerSlots.withdrawn_at), gte(offerSlots.ends_at, now)))
    .orderBy(offerSlots.starts_at);
  const held = await slotPeople(rows.map((r) => r.id));
  return rows.map((r) => {
    const spots = slotSpots(o, held.get(r.id) ?? 0);
    return { id: r.id, startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(), taken: spots.full, capacity: spots.capacity, spotsTaken: spots.taken, spotsLeft: spots.left };
  });
}

/** Slots any live booking holds (a slot with anyone booked can't be withdrawn; for one / private_group it is taken). */
export async function takenSlotIds(slotIds: string[]): Promise<Set<string>> {
  return new Set((await slotPeople(slotIds)).keys());
}

/** People held per slot: the sum of live bookings' party sizes (only slots with someone in them appear). */
export async function slotPeople(slotIds: string[]): Promise<Map<string, number>> {
  if (!slotIds.length) return new Map();
  const rows = await db.select({ slot: bookings.slot_id, people: sql<number>`coalesce(sum(${bookings.party_size}), 0)::int` }).from(bookings)
    .where(and(inArray(bookings.slot_id, slotIds), inArray(bookings.status, [...LIVE_STATUSES]))).groupBy(bookings.slot_id);
  return new Map(rows.filter((r) => r.slot).map((r) => [r.slot!, Number(r.people)]));
}

/**
 * A slot's spots. One / private_group: one booking takes the whole time (capacity 1 booking). Open group: max_people
 * spots, each live booking holding its party size; full when none are left.
 */
export function slotSpots(o: Pick<Offer, "audience" | "max_people">, people: number): { capacity: number; taken: number; left: number; full: boolean } {
  if (o.audience !== "open_group") return { capacity: 1, taken: people > 0 ? 1 : 0, left: people > 0 ? 0 : 1, full: people > 0 };
  const left = Math.max(0, o.max_people - people);
  return { capacity: o.max_people, taken: people, left, full: left === 0 };
}

/** Add 1..20 start times; each slot lasts the offer's length. Overlapping one of her own open slots is refused. */
export async function addSlots(athleteId: string, offerId: string, startsRaw: unknown, now = new Date()): Promise<OfferSlot[]> {
  const o = await getOffer(athleteId, offerId);
  if (!Array.isArray(startsRaw) || startsRaw.length === 0 || startsRaw.length > 20) throw coded("INVALID", [{ field: "starts", problem: "1 to 20 times" }]);
  const len = o.duration_minutes * 60_000;
  const wanted: Array<{ s: Date; e: Date }> = [];
  for (const raw of startsRaw) {
    const s = new Date(typeof raw === "string" ? raw : NaN);
    const p = startProblem(s, now);
    if (p !== "none") throw coded("INVALID", [{ field: "starts", problem: p }]);
    if (o.available_from && s.getTime() < Date.parse(o.available_from)) throw coded("INVALID", [{ field: "starts", problem: "before available_from" }]);
    if (o.available_until && s.getTime() >= Date.parse(o.available_until) + DAY) throw coded("INVALID", [{ field: "starts", problem: "after available_until" }]);
    wanted.push({ s, e: new Date(s.getTime() + len) });
  }
  wanted.sort((a, b) => a.s.getTime() - b.s.getTime());
  for (let i = 1; i < wanted.length; i++) if (wanted[i].s < wanted[i - 1].e) throw coded("INVALID", [{ field: "starts", problem: "overlap" }]);
  const existing = await db.select().from(offerSlots)
    .where(and(eq(offerSlots.athlete_id, athleteId), isNull(offerSlots.withdrawn_at), gte(offerSlots.ends_at, now)));
  for (const w of wanted) {
    if (existing.some((x) => w.s < x.ends_at && x.starts_at < w.e)) throw coded("INVALID", [{ field: "starts", problem: "overlap" }]);
  }
  return db.insert(offerSlots).values(wanted.map((w) => ({ offer_id: offerId, athlete_id: athleteId, starts_at: w.s, ends_at: w.e }))).returning();
}

/** The most open times one "withdraw times" request may name. */
export const MAX_WITHDRAW_PER_REQUEST = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Withdraw many open slots at once (her "Edit hours": the times that no longer fall inside her hours). ONE statement,
 * and a slot any live booking holds is never withdrawn: the NOT EXISTS is evaluated with the update, so a booking that
 * lands in between keeps its time. Another offer's or athlete's slot, or one already gone, is simply not withdrawn.
 * Returns the ids withdrawn and the ids kept because someone is booked.
 */
export async function withdrawSlots(athleteId: string, offerId: string, raw: unknown): Promise<{ withdrawn: string[]; booked: string[] }> {
  await getOffer(athleteId, offerId);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WITHDRAW_PER_REQUEST || !raw.every((x) => typeof x === "string" && UUID_RE.test(x))) {
    throw coded("INVALID", [{ field: "slot_ids", problem: `1 to ${MAX_WITHDRAW_PER_REQUEST} slot ids` }]);
  }
  const ids = [...new Set(raw as string[])];
  const rows = await db.update(offerSlots).set({ withdrawn_at: new Date() })
    .where(and(
      inArray(offerSlots.id, ids), eq(offerSlots.offer_id, offerId), eq(offerSlots.athlete_id, athleteId), isNull(offerSlots.withdrawn_at),
      sql`NOT EXISTS (SELECT 1 FROM ${bookings} WHERE ${bookings.slot_id} = ${offerSlots.id} AND ${inArray(bookings.status, [...LIVE_STATUSES])})`,
    ))
    .returning({ id: offerSlots.id });
  const withdrawn = rows.map((r) => r.id);
  const booked = [...await takenSlotIds(ids.filter((id) => !withdrawn.includes(id)))];
  return { withdrawn, booked };
}

/** Withdraw an open slot. A slot a live booking holds can't be withdrawn (cancel or decline that booking instead). */
export async function withdrawSlot(athleteId: string, offerId: string, slotId: string): Promise<void> {
  await getOffer(athleteId, offerId);
  const [s] = await db.select().from(offerSlots)
    .where(and(eq(offerSlots.id, slotId), eq(offerSlots.offer_id, offerId), eq(offerSlots.athlete_id, athleteId), isNull(offerSlots.withdrawn_at))).limit(1);
  if (!s) throw coded("NOT_FOUND");
  if ((await takenSlotIds([slotId])).size) throw coded("SLOT_TAKEN");
  await db.update(offerSlots).set({ withdrawn_at: new Date() }).where(eq(offerSlots.id, slotId));
}

// ─── Views ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function offerViews(athleteId: string, rows: Offer[], now = new Date()): Promise<OfferView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const slots = await db.select({ offer: offerSlots.offer_id, id: offerSlots.id }).from(offerSlots)
    .where(and(inArray(offerSlots.offer_id, ids), isNull(offerSlots.withdrawn_at), gte(offerSlots.starts_at, now)));
  const held = await slotPeople(slots.map((s) => s.id));
  const live = await db.select({ offer: bookings.offer_id, n: count() }).from(bookings)
    .where(and(inArray(bookings.offer_id, ids), inArray(bookings.status, [...LIVE_STATUSES]), ne(bookings.status, "unverified")))
    .groupBy(bookings.offer_id);
  return rows.map((o) => {
    const q = quoteBookingCharge(o.price_cents);
    return {
      id: o.id, publicId: o.public_id, format: o.format as OfferView["format"], title: o.title, description: o.description,
      priceCents: o.price_cents, durationMinutes: o.duration_minutes, locationMode: o.location_mode as OfferView["locationMode"],
      videoMode: (o.video_mode as OfferView["videoMode"]) ?? null, venue: o.venue, venueConfirmed: !!o.venue_confirmed_at,
      requireIdVerification: o.require_id_verification, allowMinorAttendees: o.allow_minor_attendees,
      returningBuyersOnly: o.returning_buyers_only, schedulingMode: o.scheduling_mode as OfferView["schedulingMode"],
      availableFrom: o.available_from, availableUntil: o.available_until, freeCancelHours: o.free_cancel_hours,
      status: o.status as OfferView["status"], pausedReason: (o.paused_reason as OfferView["pausedReason"]) ?? null,
      adultAttested: !!o.adult_attested_at,
      audience: o.audience as OfferView["audience"], maxPeople: o.max_people,
      approveEachSpot: o.audience === "open_group" && o.approve_each_spot,
      availability: (o.availability as OfferView["availability"]) ?? null,
      quote: { priceCents: q.priceCents, serviceFeeCents: q.serviceFeeCents, buyerTotalCents: q.buyerTotalCents, athleteReceivesCents: q.athleteReceivesCents, currency: q.currency, unitPriceCents: o.price_cents, partySize: 1 },
      openSlots: slots.filter((s) => s.offer === o.id && !slotSpots(o, held.get(s.id) ?? 0).full).length,
      liveBookings: live.find((l) => l.offer === o.id)?.n ?? 0,
      updatedAt: o.updated_at.toISOString(),
    };
  });
}

export async function listOffers(athleteId: string): Promise<Offer[]> {
  return db.select().from(offers).where(and(eq(offers.athlete_id, athleteId), ne(offers.status, "archived")))
    .orderBy(sql`CASE ${offers.status} WHEN 'published' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END`, offers.created_at);
}
