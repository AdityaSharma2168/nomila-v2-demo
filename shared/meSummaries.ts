// The wire shapes of app layout B's read-only summaries, shared by the server that serves them and the client that
// draws them (one definition, so a field cannot drift between the two). Types only: no runtime code, no imports.
//
//   GET /api/v1/me/what-matters-next   WhatMattersNext     server/services/whatMattersNext.ts · client/lib/whatMattersNext.ts
//   GET /api/v1/me/financials          FinancialSummary    server/services/moneySummary.ts     · client/screens/FinancialsScreen.tsx
//   GET /api/v1/me/bookings/summary    BookingsSummary     server/services/bookings/summary.ts · client/screens/OpportunitiesScreen.tsx

// ── What matters next ─────────────────────────────────────────────────────────

export type NextKind = "booking_request" | "serious_offer" | "deal_waiting" | "payout_setup" | "money_paid" | "card_views" | "mila_suggestion";

/** Where a row opens. Nothing on Home acts: every target is a screen. */
export type NextTarget =
  | { screen: "opportunity"; opportunityId: string; dealId: string | null }
  | { screen: "booking"; id: string }
  | { screen: "financials" }
  | { screen: "card" }
  /** Mila's suggestion (research refresh): the chat it was posted to, where its card is answered. */
  | { screen: "mila"; conversationId: string | null; decisionId: string };

export interface NextCandidate {
  key: string;
  kind: NextKind;
  /** The clock: a deadline she has to meet (ISO). */
  dueAt: string | null;
  /** When it arrived or last moved (ISO): newest first within its group. */
  at: string | null;
  /** The Opportunities board's own order, for deals (0 first). */
  order: number | null;
  /** A booking's or a suggestion's own title. */
  title: string | null;
  brandName: string | null;
  logoUrl: string | null;
  amountCents: number | null;
  currency: string | null;
  target: NextTarget;
  /**
   * An opportunity's ONE next step, the same one its card on the board shows (server/lib/opportunityNext): the action
   * code, the plain verb phrase ("Confirm it’s signed", "Ask for terms", "Reply"…) and why, from the deal's own data.
   * Optional: absent on other kinds and from an older server.
   */
  action?: string | null;
  need?: string | null;
  why?: string | null;
}

export interface WhatMattersNext {
  version: "what-matters-next/0.1";
  items: NextCandidate[];
  /**
   * How many opportunities wait on her: the board's needsYou count, so Home's "See all N" and the Opportunities tab's
   * "N waiting on you" are the same number. Optional: absent from an older server.
   */
  waiting?: number;
}

// ── Financials ────────────────────────────────────────────────────────────────

export type MoneySource = "deal" | "booking";
/** Where an upcoming payout stands, as a code the client words. */
export type UpcomingStage = "awaiting_delivery" | "awaiting_confirmation" | "in_review" | "after_booking";

export interface MoneyLine {
  id: string;
  source: MoneySource;
  /** The deal's brand name, or the booking's title — her own records only. */
  label: string;
  dealId: string | null;
  bookingId: string | null;
  amountCents: number;
  currency: string;
  /** ISO: release-by for upcoming, paid date for paid, since for a hold, refunded date for a refund. */
  at: string | null;
  stage?: UpcomingStage;
  /** Paid by the brand directly (its payment notice), not through Nomila: `id` is the notice's thread. */
  direct?: true;
}

export type PayoutAccountState = "none" | "pending" | "active";

export interface FinancialSummary {
  version: "financials/0.1";
  /** Money exists: at least one payout, hold or refund. Before that the strip and Financials stay hidden. */
  hasMoney: boolean;
  currency: string;
  comingCents: number;
  paidMonthCents: number;
  paidYearCents: number;
  payouts: { upcoming: MoneyLine[]; paid: MoneyLine[] };
  holds: MoneyLine[];
  refunds: { countYear: number; cents: number; items: MoneyLine[] };
  account: { state: PayoutAccountState; payoutsEnabled: boolean; detailsSubmitted: boolean; requirementsDue: number };
}

// ── Bookings ──────────────────────────────────────────────────────────────────

export interface BookingLine {
  /** The booking's id; for an open-group line, the id of one booking in the time (open it by slotId instead). */
  id: string;
  title: string;
  format: string;
  status: string;
  /** What she receives: the booking's price, or for an open-group line every paid spot's together. */
  priceCents: number;
  currency: string;
  startsAt: string | null;
  respondBy: string | null;
  createdAt: string | null;
  /**
   * 0153 group sessions. An "open_group" line stands for a whole TIME (every fan's spot collapsed into one line): the
   * app opens the group screen by slotId and words it "spotsTaken of capacity booked". Optional: absent from an older
   * server (treat as "one").
   */
  audience?: "one" | "private_group" | "open_group";
  slotId?: string | null;
  /** People this line covers: the party size, or an open group's live spots. */
  spotsTaken?: number;
  /** Open group: the spots in the time. Otherwise the party size. */
  capacity?: number;
}

export interface BookingsSummary {
  version: "bookings-summary/0.1";
  /** She has at least one published offer: the Bookings section shows. */
  published: boolean;
  publishedOffers: number;
  requests: BookingLine[];
  upcoming: BookingLine[];
}
