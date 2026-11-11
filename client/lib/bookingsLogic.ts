// bookingsLogic — the words and numbers her Bookings screens show (pure; unit-tested). Copy rules (booking screens
// design): "You receive $150 · buyers pay $177.96"; "Nomila service fee", never card fee / processing to buyers;
// "Email ✓ · Phone ✓ · ID checked by Stripe", never "verified" / "safe"; "Paid to you · On hold", never escrow / funded /
// released / disputed; "Payouts · Stripe", never Connect / KYC / onboarding; dates concrete ("Sat 14 Oct"), in her own
// time zone (the device's). Second person to her. Buyers are first name + initial (the server sends only that).
import type {
  Audience, BookingChecksView, BookingListItemView, BookingPhase, BookingsSummaryView, GroupAttendeeView, GroupCancelPreviewView,
  GroupSessionListItemView, OfferFormat, OfferView,
  PayoutStatusView, QuoteView,
} from "./bookingsTypes";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3_600_000;

/** "$150" / "$177.96". */
export function usd(cents: number): string {
  const whole = cents % 100 === 0;
  const n = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `$${n}`;
}

export function fmtDay(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "Thu 12 Oct, 4:00 pm". */
export function fmtWhen(iso: string): string {
  return `${fmtDay(iso)}, ${fmtTime(iso)}`;
}

/** "Thu 12 Oct, 4:00–4:30 pm" (same day) — the session's time on her screens. */
export function fmtRange(startIso: string, endIso: string | null): string {
  if (!endIso) return fmtWhen(startIso);
  const s = fmtTime(startIso), e = fmtTime(endIso);
  const sameHalf = s.slice(-2) === e.slice(-2);
  return `${fmtDay(startIso)}, ${sameHalf ? s.slice(0, -3) : s}–${e}`;
}

export const FORMAT_LABEL: Record<OfferFormat, string> = { video_call: "Video call", appearance: "Appearance", clinic: "Clinic", custom: "Custom" };

/** Her cancellation window as she picks it: 24 hours · 48 hours · 7 days. */
export function windowLabel(hours: number): string {
  return hours >= 72 && hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
}

/** "You receive $150 · buyers pay $177.96" — never "price", "commission" or "net". */
export function receiveLine(q: Pick<QuoteView, "athleteReceivesCents" | "buyerTotalCents">): string {
  return `You receive ${usd(q.athleteReceivesCents)} · buyers pay ${usd(q.buyerTotalCents)}`;
}

/** An offer row's one line: "30 min · You receive $150 · 6 times open". */
export function offerMeta(o: OfferView): string {
  const parts = [`${o.durationMinutes} min`];
  if (o.locationMode === "in_person") parts.push("In person");
  const group = o.audience === "private_group" || o.audience === "open_group";
  if (group) parts.push(`${o.audience === "open_group" ? "Open group" : "Fan + friends"} of up to ${o.maxPeople}`);
  parts.push(group ? `You receive ${usd(o.priceCents)} per person` : `You receive ${usd(o.priceCents)}`);
  if (o.status === "draft") parts.push("Draft");
  else if (o.status === "paused") parts.push(o.pausedReason === "athlete" ? "You paused it" : "Paused by Nomila");
  else if (o.schedulingMode === "slots") parts.push(o.openSlots === 1 ? "1 time open" : `${o.openSlots} times open`);
  else parts.push("Buyers suggest times");
  return parts.join(" · ");
}

/** What was checked, as badges: "Email ✓", "Phone ✓", "ID checked". Never "verified". */
export function checkBadges(c: BookingChecksView): string[] {
  return [c.email ? "Email ✓" : null, c.phone ? "Phone ✓" : null, c.idChecked ? "ID checked" : null].filter((x): x is string => !!x);
}

/** The deadline chip on a request: "18h left" inside a day, else "Reply by Sat". */
export function respondChip(respondBy: string | null, now = new Date()): string | null {
  if (!respondBy) return null;
  const ms = new Date(respondBy).getTime() - now.getTime();
  if (ms <= 0) return "Expired";
  if (ms < 24 * HOUR) return `${Math.max(1, Math.floor(ms / HOUR))}h left`;
  return `Reply by ${DAYS[new Date(respondBy).getDay()]}`;
}

const PHASE_LINE: Record<BookingPhase, string> = {
  request: "Waiting for your answer",
  waiting_buyer: "You suggested other times",
  waiting_payment: "Waiting for payment",
  booked: "Booked",
  happening: "Happening now",
  finished: "Finished · paid when they confirm",
  on_hold: "On hold · a person at Nomila is looking",
  paid: "Paid to you",
  declined: "You declined",
  withdrawn: "They withdrew",
  expired: "Expired",
  canceled: "Cancelled",
  refunded: "Refunded",
};

/** A booking row's status line, in plain words. */
export function phaseLine(b: Pick<BookingListItemView, "phase" | "startsAt" | "endsAt">): string {
  if (b.phase === "booked" && b.startsAt) return `Booked · ${fmtWhen(b.startsAt)}`;
  return PHASE_LINE[b.phase];
}

/** The time a booking row shows: its session time, or the buyer's suggestions. */
export function whenLine(b: Pick<BookingListItemView, "startsAt" | "endsAt" | "proposedTimes">): string {
  if (b.startsAt) return fmtRange(b.startsAt, b.endsAt);
  const t = b.proposedTimes;
  if (!t.length) return "Time to be agreed";
  return t.length === 1 ? fmtWhen(t[0].start) : `${fmtWhen(t[0].start)} + ${t.length - 1} more`;
}

/** Stripe's missing items in plain words (never "KYC", "requirements"). */
export function payoutNeedsLine(due: string[]): string | null {
  if (!due.length) return null;
  const words = new Set<string>();
  for (const d of due) {
    if (d.includes("external_account")) words.add("your bank account");
    else if (d.includes("verification.document")) words.add("a photo of your ID");
    else if (d.includes("dob")) words.add("your date of birth");
    else if (d.includes("ssn")) words.add("the last 4 digits of your SSN");
    else if (d.includes("address")) words.add("your address");
    else words.add("a few details");
  }
  return `Stripe still needs ${[...words].join(", ")} before it can send you money.`;
}

// ─── The time picker (her times; no native picker) ──────────────────────────────────────────────────────────────

export interface DayOption { key: string; label: string; date: Date }

/** The next `n` days from tomorrow, at local midnight. */
export function dayOptions(now: Date, n = 30): DayOption[] {
  const out: DayOption[] = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    out.push({ key: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, label: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`, date: d });
  }
  return out;
}

/** Start times every 30 minutes, 6:00 am to 10:00 pm, as minutes after midnight. */
export function timeOptions(): Array<{ minutes: number; label: string }> {
  const out: Array<{ minutes: number; label: string }> = [];
  for (let m = 6 * 60; m <= 22 * 60; m += 30) {
    const h = Math.floor(m / 60), mm = m % 60;
    out.push({ minutes: m, label: `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "am" : "pm"}` });
  }
  return out;
}

export function startIso(day: Date, minutes: number): string {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).toISOString();
}

/** Turn the editor's dollars text into cents (whole cents only), or null. "150" → 15000, "150.5" → 15050. */
export function dollarsToCents(text: string): number | null {
  const t = text.replace(/[$,\s]/g, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export const BOOKINGS_COPY = {
  title: "Bookings",
  tabs: { requests: "Requests", booked: "Booked", offers: "Offers" } as const,
  sectionTitle: "Bookings",
  seeAll: "See all",
  payoutsTitle: "Before you publish",
  payoutsBody: "Stripe sends your money to your bank. It takes about 5 minutes and you only do it once.",
  payoutsCta: "Set up payouts",
  sellTitle: "Sell your time",
  sellBody: "Offer a video call, a clinic or an appearance. You set the price and keep all of it. Buyers pay Nomila's fee on top.",
  newOffer: "New offer",
  offersFoot: "Fans book these from your page.",
  pausedTitle: "Your offers are paused",
  pausedBody: "Two sessions were missed, so new bookings are off while our support team takes a look. Your booked sessions still go ahead.",
  noRequests: "No requests right now",
  noRequestsBody: "When someone asks for one of your times, it shows up here and we'll email you.",
  noRequestsNoOffer: "Publish an offer and requests will show up here.",
  noBooked: "Nothing booked yet",
  noBookedBody: "Sessions you accept show up here, with what you'll receive and when.",
  loadError: "Couldn't load your bookings. Pull down to try again.",
  offersError: "Couldn't load your offers. Pull down to try again.",
  detailError: "Couldn't load this booking. Pull down to try again.",
  doorDetail: "Your offers, requests and sessions",
  mila: "Mila can explain a booking, but accepting, declining and cancelling are always your tap.",
} as const;

/** The overview's payout status, read as "not set up" when an older or partial overview leaves it out. */
export function payoutsOf(s: Pick<BookingsSummaryView, "payouts"> | null | undefined): PayoutStatusView {
  const p = s?.payouts;
  return { hasAccount: !!p?.hasAccount, ready: !!p?.ready, requirementsDue: Array.isArray(p?.requirementsDue) ? p!.requirementsDue : [] };
}

// ─── the new-session sheet's refusal line ────────────────────────────────────────────────────────────────────────

/** A server answer as bookingRefusal (hooks/use-bookings) reads it. */
export interface RefusalLike { status: number; code: string | null; error: string | null; detail: unknown }

const SETUP_PROBLEM: Record<string, string> = {
  too_soon: "Some open times are too soon. Times need to be at least a few hours away.",
  too_far: "Some open times are too far ahead. Times can be up to 60 days out.",
  bad_time: "One of the open times isn't a real time.",
  overlap: "Some open times overlap times you already offer. Remove those in the full editor, or pick other days.",
  "before available_from": "Some open times are before this session starts.",
  "after available_until": "Some open times are after this session ends.",
};
const SETUP_FIELD: Record<string, string> = {
  starts: "Open times", title: "Title", price_cents: "Price", duration_minutes: "Length", free_cancel_hours: "Cancellation window",
  format: "Session type", location_mode: "Where", video_mode: "Video", venue: "Place", scheduling_mode: "Scheduling", time_zone: "Time zone",
};
const NOT_READY: Record<string, string> = {
  payouts: "Set up payouts first.",
  venue: "Add the place and tick that it isn't your home.",
  paused_by_nomila: "Your sessions are paused while support takes a look.",
};
const SAVED = "It's saved as a draft.";

/**
 * Why "Publish this session" didn't go through, in words she can act on. The sheet has no highlighted fields, so the
 * server's "check the highlighted fields" is never shown: its field detail is spelled out instead. Not a server answer
 * (offline) or a server fault (5xx) → a plain "try again".
 */
export function setupRefusalText(r: RefusalLike | null): string {
  if (!r || r.status >= 500) return `Couldn't publish just now. ${SAVED} Try again, or finish it in the full editor.`;
  if (r.code === "INVALID" && Array.isArray(r.detail) && r.detail.length) {
    const lines = (r.detail as Array<{ field?: unknown; problem?: unknown }>).map((d) => {
      const problem = typeof d?.problem === "string" ? d.problem : "";
      if (SETUP_PROBLEM[problem]) return SETUP_PROBLEM[problem];
      const field = typeof d?.field === "string" ? SETUP_FIELD[d.field] ?? d.field : "Something";
      return problem ? `${field}: ${problem}.` : `${field} needs a look.`;
    });
    return `${[...new Set(lines)].join(" ")} ${SAVED}`;
  }
  if (r.code === "NOT_READY" && Array.isArray(r.detail) && r.detail.length) {
    const lines = (r.detail as unknown[]).map((d) => (typeof d === "string" && NOT_READY[d]) || null).filter((x): x is string => !!x);
    if (lines.length) return `${[...new Set(lines)].join(" ")} ${SAVED}`;
  }
  if (r.error) return `${r.error.charAt(0).toUpperCase()}${r.error.slice(1)}. ${SAVED}`;
  return `${SAVED} Finish it in the full editor.`;
}

// ─── Group sessions (0153) ───────────────────────────────────────────────────────────────────────────────────────
// Her price is PER PERSON: a booking's total is price × people, and she receives all of it.

export const AUDIENCE_OPTIONS: ReadonlyArray<{ key: Audience; label: string }> = [
  { key: "one", label: "Just one fan" },
  { key: "private_group", label: "A fan + friends" },
  { key: "open_group", label: "Open group" },
];

/** The fewest and most people a group session holds (the server's MAX_GROUP_PEOPLE). */
export const GROUP_MIN_PEOPLE = 2;
export const GROUP_MAX_PEOPLE = 20;

/** The people a session starts at when she picks who it's for: 4 for friends, 10 for an open group. */
export function defaultPeople(a: Audience): number {
  return a === "one" ? 1 : a === "private_group" ? 4 : 10;
}

export function clampPeople(n: number): number {
  return Math.min(GROUP_MAX_PEOPLE, Math.max(GROUP_MIN_PEOPLE, Math.round(n)));
}

/** "3 people" / "1 person". */
export function peopleCount(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** " · 3 people" on a private group's row; nothing for a 1:1 (or a group booked for one). */
export function partyTag(b: { audience?: Audience; partySize?: number }): string {
  return b.audience && b.audience !== "one" && (b.partySize ?? 1) > 1 ? ` · ${peopleCount(b.partySize!)}` : "";
}

/** "You get $25 per person · up to $250 per session". */
export function groupGetLine(unitCents: number, maxPeople: number): string {
  return `You get ${usd(unitCents)} per person · up to ${usd(unitCents * maxPeople)} per session`;
}

/** "Group clinic · Sat 14 Nov, 10:00 am · 4 of 10 booked" — an open-group time as one card. */
export function groupCardLine(g: Pick<GroupSessionListItemView, "format" | "startsAt" | "spotsTaken" | "capacity">): string {
  return `Group ${FORMAT_LABEL[g.format].toLowerCase()} · ${fmtWhen(g.startsAt)} · ${g.spotsTaken} of ${g.capacity} booked`;
}

/** "Jordan, Sam, Alex + 2 more" (or "No one yet"). */
export function namesLine(names: string[], show = 3): string {
  if (!names.length) return "No one yet";
  return names.length <= show ? names.join(", ") : `${names.slice(0, show).join(", ")} + ${names.length - show} more`;
}

const GROUP_PHASE: Record<GroupSessionListItemView["phase"], string> = {
  booked: "Booked", happening: "Happening now", finished: "Finished", canceled: "Cancelled",
};
export function groupPhaseLine(phase: GroupSessionListItemView["phase"]): string {
  return GROUP_PHASE[phase];
}

/** One attendee's state on her group screen: in the call now, joined earlier, or where their spot stands. */
export function attendeeLine(a: Pick<GroupAttendeeView, "status" | "joined" | "inRoom" | "partySize">): string {
  const state = a.inRoom ? "In the call" : a.joined ? "Joined" :
    a.status === "canceled" || a.status === "refunded" ? "Cancelled" :
    a.status === "issue_reported" || a.status === "disputed" ? "On hold" :
    a.status === "released" ? "Paid to you" : "Booked";
  return a.partySize > 1 ? `${state} · ${peopleCount(a.partySize)}` : state;
}

/**
 * "4 people get a full refund of $100." for her group-cancel sheet, with the held cards that are simply released.
 * Counts PEOPLE (the server's sum of party sizes), not bookings; an older server without `people` falls back to bookings.
 */
export function groupCancelLine(p: Pick<GroupCancelPreviewView, "bookings" | "pending" | "buyerRefundCents"> & { people?: number }): string {
  const parts: string[] = [];
  const people = p.people ?? p.bookings;
  if (people > 0) parts.push(`${people === 1 ? "1 person gets" : `${people} people get`} a full refund of ${usd(p.buyerRefundCents)}.`);
  if (p.pending > 0) parts.push(`${p.pending === 1 ? "1 person still checking out has" : `${p.pending} people still checking out have`} their card hold released.`);
  if (!parts.length) parts.push("No one has paid yet, so there's nothing to refund.");
  return `${parts.join(" ")} We'll let everyone know.`;
}

/**
 * Booked tab: an open group's spots each arrive as their own booking from GET /bookings, but she sees each time ONCE,
 * from GET /bookings/groups. Drop the spots; keep 1:1 and private-group bookings.
 */
export function withoutOpenGroupSpots<T extends { audience?: Audience }>(rows: T[]): T[] {
  return rows.filter((b) => b.audience !== "open_group");
}

export type BookedEntry = { kind: "booking"; b: BookingListItemView } | { kind: "group"; g: GroupSessionListItemView };

/** Bookings and open-group times in one list by start time: soonest first (upcoming) or newest first (past). */
export function bookedEntries(rows: BookingListItemView[], groups: GroupSessionListItemView[], order: "asc" | "desc" = "asc"): BookedEntry[] {
  const at = (e: BookedEntry) => Date.parse((e.kind === "group" ? e.g.startsAt : e.b.startsAt) ?? "") || 0;
  const all: BookedEntry[] = [
    ...withoutOpenGroupSpots(rows).map((b) => ({ kind: "booking" as const, b })),
    ...groups.map((g) => ({ kind: "group" as const, g })),
  ];
  return all.sort((x, y) => (order === "asc" ? at(x) - at(y) : at(y) - at(x)));
}
