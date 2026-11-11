/**
 * bookings/config.ts — every product knob for paid bookings (Bookings v2) in one place.
 *
 * Env-overridable so the product decisions (service fee %, processing rate, price floor, release window …) change without a code
 * change. Money is INTEGER CENTS. Nothing here names an athlete, sport or school; the pilot allowlist is env-only.
 *
 * Bookings are DARK until BOOKINGS_ENABLED=true, and even then only for athletes on BOOKINGS_PILOT_ATHLETE_IDS
 * (empty list = nobody). B1 shipped schema + this config + the quote; the flow PRs (0102 + the state machine, the athlete
 * routes, the buyer API) read it through bookingsEnabledFor() and answer 404 for everyone else.
 */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
}

function envNumList(name: string, fallback: number[]): number[] {
  const nums = envList(name).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return nums.length ? nums : fallback;
}

/**
 * Stripe's limit on holding funds in the platform balance (Connect "Holding funds": United States 2 years, all other
 * countries 90 days; https://docs.stripe.com/connect/account-balances, read 7 Oct 2026). Bookings design to the
 * STRICTER 90 days so the hold stays inside the limit even for a non-US connected account.
 */
export const STRIPE_HOLD_LIMIT_DAYS = 90;

export const BOOKINGS = {
  /** Master switch. Off by default. */
  get enabled(): boolean { return process.env.BOOKINGS_ENABLED?.trim().toLowerCase() === "true"; },
  /** Athletes allowed to publish offers while bookings are piloted (comma-separated athlete ids). */
  get pilotAthleteIds(): string[] { return envList("BOOKINGS_PILOT_ATHLETE_IDS"); },

  /**
   * Nomila's keep, as a percent of HER price (v2.1, owner decision 7 Oct 2026: 15%). She receives 100% of her price;
   * the BUYER pays one "Nomila service fee" = this keep PLUS the card-processing pass-through, grossed up so that
   * after Stripe's fee Nomila still keeps the full percentage (quoteBookingCharge). May be fractional (e.g. 12.5).
   */
  serviceFeePercent:   envNum("BOOKING_SERVICE_FEE_PERCENT", 15),
  /**
   * The card-processing rate the service fee passes through (Stripe US standard card pricing: 2.9% + 30¢). Config,
   * never hard-coded in the quote. Identical for every payment method: the buyer sees ONE "Nomila service fee" line,
   * never a card fee or surcharge. Refund costs always use Stripe's ACTUAL fee from the balance transaction.
   */
  processingPercent:      envNum("BOOKING_PROCESSING_PERCENT", 2.9),
  processingFixedCents:   envNum("BOOKING_PROCESSING_FIXED_CENTS", 30),
  /** Her price floor: below it the fixed card fee and refund risk outweigh the fee. */
  minPriceCents:       envNum("BOOKING_MIN_PRICE_CENTS", 2_500),
  /** Her price ceiling (fat-finger / exposure guard; card-only, chargebacks land on Nomila). */
  maxPriceCents:       envNum("BOOKING_MAX_PRICE_CENTS", 500_000),

  /** Auto-release this many hours after the scheduled end, ONLY if no report/dispute is open. */
  releaseHours:        envNum("BOOKING_RELEASE_HOURS", 48),
  /**
   * Cancellation window (v2.1): HER per-offer setting (offers.free_cancel_hours), snapshotted onto each booking and
   * shown to the buyer before paying. A buyer who cancels at least that many hours before the start gets her price
   * back (the service fee is non-refundable). The default for a new offer, and the choices she is offered.
   */
  freeCancelHoursDefault: envNum("BOOKING_FREE_CANCEL_HOURS_DEFAULT", 24),
  get freeCancelHoursOptions(): number[] { return envNumList("BOOKING_FREE_CANCEL_HOURS_OPTIONS", [24, 48, 168]); },
  /**
   * The cancellation-policy VERSION (offers/bookings.policy_key): the rules text the window plugs into. Bump it when the
   * rules change; the window itself is a per-offer number, not part of the key.
   */
  cancellationPolicyVersion: "athlete_window_v1",

  /**
   * No-shows (v2.1, owner-proposed; logic lands in B5). Both sides get this grace after the start. Buyer no-show: after
   * the grace she taps "Buyer didn't show" and is paid on the normal clock (LiveKit attendance is evidence only).
   * Athlete no-show: full refund incl. the service fee; she covers Stripe's actual fee (her first one is waived).
   */
  noShowGraceMinutes:     envNum("BOOKING_NO_SHOW_GRACE_MINUTES", 15),
  /** This many athlete no-shows pause her offers (offers.paused_reason 'no_show_review') pending support review. */
  noShowPauseThreshold:   envNum("BOOKING_NO_SHOW_PAUSE_THRESHOLD", 2),
  /**
   * She has this long to answer a verified request (owner decision: 72 hours). The buyer's card is HELD (Stripe manual
   * capture) from the request, so this window must end well inside a card authorization's life (~7 days online;
   * cardAuthorizationDays, holdFitsAuthorization). respond_by is the EARLIER of this and respondLeadHours before the start.
   */
  respondHours:        envNum("BOOKING_RESPOND_HOURS", 72),
  /** respond_by never falls later than this many hours before the session starts. */
  respondLeadHours:    envNum("BOOKING_RESPOND_LEAD_HOURS", 2),
  /**
   * Only after a FAILED capture at accept (the bank dropped the hold): the buyer gets a Checkout pay link and this long
   * to pay before the booking expires and the slot reopens (public card v3.1 §7). Normally her accept captures at once.
   */
  payHours:            envNum("BOOKING_PAY_HOURS", 24),
  /**
   * The life of a card authorization for an online payment that Stripe documents (about 7 days; some networks and
   * wallets allow less). The hold placed at request must be captured or released well inside it.
   */
  cardAuthorizationDays: envNum("BOOKING_CARD_AUTHORIZATION_DAYS", 7),
  /** A slot picked by a buyer who has not finished verifying is held this long, then the request lapses (open q. 23). */
  unverifiedHoldMinutes: envNum("BOOKING_UNVERIFIED_HOLD_MINUTES", 15),
  /** A request that never got past verification is deleted after this many hours (it was never real). */
  unverifiedPurgeHours:  envNum("BOOKING_UNVERIFIED_PURGE_HOURS", 24),
  /** Request mode: the buyer suggests at most this many times; her counter-offer has the same cap. */
  maxProposedTimes:    3,
  /** Text limits (characters): the buyer's message, the request-mode note, one relayed thread message. */
  buyerMessageMaxChars: 1_000,
  proposedNoteMaxChars: 300,
  threadMessageMaxChars: 2_000,
  /** Email code: lifetime, tries, and the wait before "Send it again". */
  otpMinutes:          envNum("BOOKING_OTP_MINUTES", 10),
  otpMaxAttempts:      envNum("BOOKING_OTP_MAX_ATTEMPTS", 5),
  otpResendSeconds:    envNum("BOOKING_OTP_RESEND_SECONDS", 30),
  /** After an email code, the buyer's private page stays open this long before it asks for a fresh code. */
  buyerAccessHours:    envNum("BOOKING_BUYER_ACCESS_HOURS", 12),
  /** The card-hold Checkout session's life (Stripe's minimum is 30 minutes). */
  holdCheckoutMinutes: envNum("BOOKING_HOLD_CHECKOUT_MINUTES", 30),
  /** Length choices (minutes) the offer editor accepts. */
  durationMinOptions:  [15, 30, 45, 60, 90, 120, 180, 240] as number[],
  /** An issue still open this many days after the charge alerts an admin (the platform hold limit is 90). */
  releaseAlertDays:    envNum("BOOKING_RELEASE_ALERT_DAYS", 80),
  /**
   * HMAC key for the buyer's email / phone hashes (blocks, returning buyers) and the buyer page's access key. Secret
   * Manager (BOOKING_HASH_SECRET). Without it the buyer side refuses to start (503), so nothing is hashed with a guess.
   */
  get hashSecret(): string | null { return process.env.BOOKING_HASH_SECRET?.trim() || null; },
  /** How far ahead a session can be booked. Keeps the platform hold short (see bookingHoldDays). */
  maxAdvanceDays:      envNum("BOOKING_MAX_ADVANCE_DAYS", 60),

  /** LiveKit join window: open this many minutes before the start … */
  videoJoinEarlyMinutes: envNum("BOOKING_VIDEO_JOIN_EARLY_MINUTES", 10),
  /** … and close this many minutes after the scheduled end. */
  videoJoinLateMinutes:  envNum("BOOKING_VIDEO_JOIN_LATE_MINUTES", 30),

  /**
   * Support is EMAIL ONLY (v2.1: no phone support). Every report / issue / dispute is emailed here, and it is the
   * address shown to buyers and athletes. Owner to confirm the mailbox.
   */
  get supportEmail(): string { return envStr("SUPPORT_EMAIL", "support@nomila.co"); },
  supportChannel:         "email" as const,
  /** Response targets (v2.1, accepted): acknowledge an in-person safety report within … */
  safetyAckHours:         envNum("BOOKING_SAFETY_ACK_HOURS", 4),
  /** … and first response to a dispute within … */
  disputeFirstResponseHours: envNum("BOOKING_DISPUTE_FIRST_RESPONSE_HOURS", 24),

  /**
   * Buyer verification (v2.1, decided; implementation lands in B3): an email code AND a phone code, the phone code via
   * Firebase Phone Auth. Controls, not guarantees.
   */
  buyerVerification: { email: "email_code", phone: "firebase_phone_auth" } as const,
  /**
   * ID + selfie (Stripe Identity), v2.1: REQUIRED for in person (offers/bookings_in_person_id_check); NOT required for
   * online calls by default (email + phone code + a paid card + in-app video + her approval + report/block are the
   * controls), but she may require it per offer (offers.require_id_verification).
   */
  identityCheck: { in_person: "required", online: "optional_per_offer" } as const,

  /** ISO currency (shared with deal payments). */
  currency:            envStr("PAYMENTS_CURRENCY", "usd"),
};

/** True when bookings are on AND this athlete is on the pilot list. */
export function bookingsEnabledFor(athleteId: string): boolean {
  return BOOKINGS.enabled && BOOKINGS.pilotAthleteIds.includes(athleteId);
}

/**
 * True when the card hold placed at request is always captured or released inside a card authorization's life: the
 * unverified hold, then her whole respond window, must end before cardAuthorizationDays (with a day of margin).
 */
export function holdFitsAuthorization(cfg: Pick<typeof BOOKINGS, "respondHours" | "unverifiedHoldMinutes" | "cardAuthorizationDays"> = BOOKINGS): boolean {
  const holdHours = cfg.respondHours + cfg.unverifiedHoldMinutes / 60;
  return holdHours <= (cfg.cardAuthorizationDays - 1) * 24;
}

/**
 * The longest a booking's money can sit in the platform balance, in days: the charge (capture) happens only when she accepts,
 * so the worst case is a payment the moment a booking is accepted for the furthest allowed date, held through the
 * session and the release window. Must stay under STRIPE_HOLD_LIMIT_DAYS.
 */
export function bookingHoldDays(cfg: Pick<typeof BOOKINGS, "maxAdvanceDays" | "releaseHours"> = BOOKINGS, maxDurationHours = 24): number {
  return cfg.maxAdvanceDays + (maxDurationHours + cfg.releaseHours) / 24;
}

/** True when `hours` is one of the cancellation windows she may choose for an offer. */
export function isAllowedFreeCancelHours(hours: number, options: number[] = BOOKINGS.freeCancelHoursOptions): boolean {
  return Number.isInteger(hours) && options.includes(hours);
}
