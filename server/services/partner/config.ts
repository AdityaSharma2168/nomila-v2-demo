/**
 * partner/config.ts — every knob of the Partner door (public brand + press requests, relay threads, Serious offer).
 *
 * The feature is DARK unless BOTH PUBLIC_CARD and PARTNER_INTAKE are exactly "true" (both off in every Cloud Run yaml).
 * Nothing here names an athlete, sport, school or brand. Times are in milliseconds unless the name says otherwise.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read per call (not at import) so tests and a flag flip see the current value. */
export function partnerIntakeEnabled(): boolean {
  return process.env.PUBLIC_CARD?.trim() === "true" && process.env.PARTNER_INTAKE?.trim() === "true";
}

export const PARTNER = {
  /** An unconfirmed request (drafting or awaiting the email link) expires after this. Design: 72h. */
  unconfirmedTtlMs: 72 * HOUR_MS,
  /** Serious offer: she has this long to reply before the hold is released. Design: 6 days. */
  replyWindowMs: 6 * DAY_MS,
  /** Site read + fit preview cache life. Design: 7 days. */
  cacheTtlMs: 7 * DAY_MS,
  /** Brand contact data is redacted this long after the deal closes. Design: 180 days. */
  contactRetentionMs: 180 * DAY_MS,
  /** Email code life and attempts. */
  codeTtlMs: 15 * 60_000,
  codeMaxAttempts: 5,
  /** The browser remembers a passed email-code check this long (cookie scoped to /requests and /r/). */
  visitorCheckTtlMs: 30 * DAY_MS,
  /** A form submitted faster than this after it was opened is treated as a bot (honeypot's partner). */
  minFillMs: 3_000,

  /** Relay limits (§7a): characters per message; messages per thread side per hour. */
  maxMessageChars: 2_000,
  messagesPerThreadPerHour: 10,

  /** Rate limits (database-backed: express-rate-limit is per instance). */
  limits: {
    /** Fit previews per visitor (daily-salted IP hash) per day. */
    get fitPerVisitorDay(): number { return envNum("PARTNER_FIT_PER_VISITOR_DAY", 3); },
    /** Fit previews per athlete per day. */
    get fitPerAthleteDay(): number { return envNum("PARTNER_FIT_PER_ATHLETE_DAY", 50); },
    /** New request drafts per visitor per day. */
    get draftsPerVisitorDay(): number { return envNum("PARTNER_DRAFTS_PER_VISITOR_DAY", 10); },
    /** Requests sent (email confirm asked) per email per athlete per week. Design: 3. */
    get sendsPerEmailAthleteWeek(): number { return envNum("PARTNER_SENDS_PER_EMAIL_WEEK", 3); },
    /** Email codes asked per email per hour. */
    get codesPerEmailHour(): number { return envNum("PARTNER_CODES_PER_EMAIL_HOUR", 5); },
    /** Inbound-mail replies per thread per hour (on top of the relay's own limit). */
    get inboundPerThreadHour(): number { return envNum("PARTNER_INBOUND_PER_THREAD_HOUR", 10); },
  },

  /** The amounts she can choose for a Serious offer hold, in cents. Default $50 (DEPOSIT_HOLD_CENTS). */
  seriousOfferAmounts: [5_000, 10_000, 15_000, 25_000] as const,
  seriousOfferDefaultCents: 5_000,

  /**
   * The dedicated Google Workspace mailbox that receives brand replies (services/partner/inboundMail.ts). Each notice's
   * reply-to is its plus-address, <local>+<token>@<domain>. PARTNER_INBOX_ADDRESS, default partners@nomila.co.
   */
  get inboxAddress(): string { return (process.env.PARTNER_INBOX_ADDRESS?.trim() || "partners@nomila.co").toLowerCase(); },
  /** The Gmail label put on every inbox message the poller has looked at (so it is never looked at twice). */
  inboxProcessedLabel: "nomila-processed",
  /** Messages handled per poll (the next tick takes the rest). */
  inboxBatch: 25,
} as const;

/**
 * Email replies (§7a) on: PARTNER_INBOUND_MAIL exactly "true", on top of the Partner door itself. Off ⇒ notices carry no
 * reply-to (the status page is the only way back) and the inbox is never polled. Read per call.
 */
export function partnerInboundMailEnabled(): boolean {
  return partnerIntakeEnabled() && process.env.PARTNER_INBOUND_MAIL?.trim() === "true";
}

export const MS = { HOUR: HOUR_MS, DAY: DAY_MS };
