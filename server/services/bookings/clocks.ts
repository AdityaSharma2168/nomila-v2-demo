/**
 * bookings/clocks.ts — the booking's clocks and refund outcomes, as pure functions (unit-tested; no DB, no Stripe).
 *
 *   unverified hold   a slot picked by a buyer who hasn't finished verifying lapses after unverifiedHoldMinutes
 *   respond_by        her answer is due by the EARLIER of request + respondHours (72h) and start − respondLeadHours;
 *                     the card hold placed at request must be captured or released inside its authorization (~7 days)
 *   no-show           "Buyer didn't show" opens noShowGraceMinutes after the start
 *   release_due_at    end + releaseHours (48h): the clock releases her money only with nothing open
 *   cancel refunds    who cancels, and when, decides the refund (money.ts bookingRefund, in integer cents)
 */
import { BOOKINGS } from "./config";
import { bookingRefund, buyerCancelCause, type BookingRefund, type RefundCause } from "./money";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

type Cfg = typeof BOOKINGS;

export function unverifiedHoldExpiresAt(createdAt: Date, cfg: Pick<Cfg, "unverifiedHoldMinutes"> = BOOKINGS): Date {
  return new Date(createdAt.getTime() + cfg.unverifiedHoldMinutes * MIN);
}

/** Her answer is due by the earlier of request + respondHours and the first possible start − respondLeadHours. */
export function respondByFor(requestedAt: Date, firstStart: Date | null, cfg: Pick<Cfg, "respondHours" | "respondLeadHours"> = BOOKINGS): Date {
  const window = requestedAt.getTime() + cfg.respondHours * HOUR;
  if (!firstStart) return new Date(window);
  return new Date(Math.min(window, firstStart.getTime() - cfg.respondLeadHours * HOUR));
}

/** The pay-by for the capture-failure fallback (a Checkout pay link), never later than the start. */
export function payByFor(now: Date, startsAt: Date | null, cfg: Pick<Cfg, "payHours"> = BOOKINGS): Date {
  const by = now.getTime() + cfg.payHours * HOUR;
  return new Date(startsAt ? Math.min(by, startsAt.getTime()) : by);
}

export function noShowAvailableAt(startsAt: Date, cfg: Pick<Cfg, "noShowGraceMinutes"> = BOOKINGS): Date {
  return new Date(startsAt.getTime() + cfg.noShowGraceMinutes * MIN);
}

export function releaseDueAt(endsAt: Date, cfg: Pick<Cfg, "releaseHours"> = BOOKINGS): Date {
  return new Date(endsAt.getTime() + cfg.releaseHours * HOUR);
}

export interface ProposedTime { start: string; tz: string | null }

export type TimeProblem = "none" | "too_many" | "bad_time" | "too_soon" | "too_far" | "duplicate";

/**
 * Is `start` bookable now: in the future by more than the respond lead (so she has time to answer and the hold ends
 * before the session), and no further ahead than maxAdvanceDays (keeps the platform hold under Stripe's limit).
 */
export function startProblem(start: Date, now: Date, cfg: Pick<Cfg, "respondLeadHours" | "maxAdvanceDays"> = BOOKINGS): Exclude<TimeProblem, "too_many" | "duplicate"> {
  if (!Number.isFinite(start.getTime())) return "bad_time";
  if (start.getTime() - now.getTime() < (cfg.respondLeadHours + 1) * HOUR) return "too_soon";
  if (start.getTime() - now.getTime() > cfg.maxAdvanceDays * DAY) return "too_far";
  return "none";
}

/** Validate and normalise 1..maxProposedTimes suggested times (request mode, or her counter-offer). */
export function parseProposedTimes(
  raw: unknown, now: Date, cfg: Pick<Cfg, "respondLeadHours" | "maxAdvanceDays" | "maxProposedTimes"> = BOOKINGS,
): { ok: true; times: ProposedTime[] } | { ok: false; problem: TimeProblem } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, problem: "bad_time" };
  if (raw.length > cfg.maxProposedTimes) return { ok: false, problem: "too_many" };
  const out: ProposedTime[] = [];
  for (const item of raw) {
    const startRaw = typeof item === "string" ? item : (item as { start?: unknown })?.start;
    const tzRaw = typeof item === "object" && item ? (item as { tz?: unknown }).tz : null;
    if (typeof startRaw !== "string") return { ok: false, problem: "bad_time" };
    const d = new Date(startRaw);
    const p = startProblem(d, now, cfg);
    if (p !== "none") return { ok: false, problem: p };
    const iso = d.toISOString();
    if (out.some((t) => t.start === iso)) return { ok: false, problem: "duplicate" };
    out.push({ start: iso, tz: typeof tzRaw === "string" && tzRaw.length <= 64 ? tzRaw : null });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return { ok: true, times: out };
}

/** The earliest start a booking could have: its slot / picked time, else its earliest proposed time. */
export function firstPossibleStart(b: { starts_at: Date | null; proposed_times: unknown }): Date | null {
  if (b.starts_at) return b.starts_at;
  const times = Array.isArray(b.proposed_times) ? (b.proposed_times as ProposedTime[]) : [];
  const ms = times.map((t) => new Date(t.start).getTime()).filter(Number.isFinite);
  return ms.length ? new Date(Math.min(...ms)) : null;
}

// ─── Cancellation refunds (integer cents) ───────────────────────────────────────────────────────────────────────

export interface CancelQuote extends BookingRefund {
  cause:            RefundCause;
  /** What is not refunded to the buyer (buyer total − refund). */
  keptCents:        number;
  /** Buyer-side only: the moment the free window closes. */
  freeUntil:        string | null;
}

type Snapshot = { price_cents: number; service_fee_cents: number; buyer_total_cents: number; starts_at: Date | null; free_cancel_hours: number };

/**
 * The refund a cancellation gets. The buyer: her price back at least `free_cancel_hours` before the start (the service
 * fee is non-refundable), nothing after. Her: everything back to the buyer (she covers Stripe's actual fee; her first is
 * free — athleteRefundCost, applied when the refund succeeds).
 */
export function cancelQuote(b: Snapshot, by: "buyer" | "athlete", now: Date): CancelQuote {
  if (by === "athlete" || !b.starts_at) {
    const cause: RefundCause = by === "athlete" ? "athlete_cancel" : "buyer_cancel_in_window";
    const r = bookingRefund(b, cause);
    return { ...r, cause, keptCents: b.buyer_total_cents - r.refundCents, freeUntil: null };
  }
  const cause = buyerCancelCause(b.starts_at, now, b.free_cancel_hours);
  const r = bookingRefund(b, cause);
  return {
    ...r, cause, keptCents: b.buyer_total_cents - r.refundCents,
    freeUntil: new Date(b.starts_at.getTime() - b.free_cancel_hours * HOUR).toISOString(),
  };
}

/** Days from the charge to now (the 80-day alert before Stripe's 90-day platform hold limit). */
export function daysSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / DAY;
}
