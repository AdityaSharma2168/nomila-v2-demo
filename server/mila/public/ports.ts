/**
 * public/ports.ts — the two NARROW seams public Mila mode reaches other tracks through (design-public-card-v3 §4, §7;
 * public profile v2 §6). Public Mila owns neither booking nor partner intake; it only:
 *
 *   PublicBookingsPort  (the bookings track: its publicPort.ts, injected in server/index.ts)
 *     bookable              whether THIS athlete can take a booking right now (bookings on and she is on the pilot
 *                           list). False → Mila is not given the booking tools at all, so no request card (and no tap
 *                           that could only be refused) ever appears.
 *     listOpenSlots         READ-ONLY. The open slots of ONE of her published offers. Times only, nothing else about
 *                           her day. Behind list_published_slots.
 *     createPendingRequest  ONE pending request (unverified, a short slot hold) and where the visitor verifies. Sends
 *                           nothing to her. Called only from the visitor's own tap (POST /p/:handle/ask/booking), never
 *                           by the model: the request_booking tool only prepares the card the visitor taps.
 *
 *   PartnerIntakePort   (the partner-intake track: server/services/partner/milaPort.ts)
 *     begin                 opens the intake for one request kind and returns where it continues. Called only from
 *                           the visitor's own tap (POST /p/:handle/ask/partner): a "What kind of request?" chip in the
 *                           Partner sheet, or a card start_partner_request prepared. The tool itself sends nothing.
 *
 * Until a track wires its port (createAskMilaPublicRouter({ bookings, partner }) in server/index.ts), the port is null:
 * its tools are NOT declared to the model and its tap route answers 404. Tests use doubles (server/testUtils/askMila.ts).
 *
 * The athlete id is ALWAYS the one the server resolved from the handle, never anything a visitor or the model sent.
 */

export interface PublicSlot {
  id: string;
  /** ISO 8601. */
  startsAt: string;
  endsAt: string;
}

export interface PublicBookingsPort {
  /** Bookings are on for THIS athlete (the flag and the pilot list). Read per call. */
  bookable(athleteId: string): boolean;
  /** Open, future, not held, not booked, inside the offer's window — of a PUBLISHED offer of THIS athlete only. */
  listOpenSlots(q: { athleteId: string; offerPublicId: string; from: Date; days: number }): Promise<PublicSlot[]>;
  /** Exactly one of slotId (slots mode) or times (request mode, 1–3 ISO times). */
  createPendingRequest(r: {
    athleteId: string;
    offerPublicId: string;
    slotId: string | null;
    times: string[] | null;
    note: string | null;
    askMilaSessionId: string;
  }): Promise<{ ok: true; ref: string; nextUrl: string } | { ok: false; reason: "slot_taken" | "unavailable" | "invalid" }>;
}

/** The "What kind of request?" kinds (render.ts PARTNER_KINDS ids). */
export const PARTNER_REQUEST_KINDS = ["sponsorship", "content", "endorsement", "appearance", "press", "other"] as const;
export type PartnerRequestKind = (typeof PARTNER_REQUEST_KINDS)[number];

export interface PartnerIntakePort {
  /** askMilaSessionId: the chat that led here, or null when the visitor tapped a request-kind chip before typing. */
  /** handle: the card's handle as the server resolved it (the visitor continues on that card's Partner page). */
  begin(r: { athleteId: string; handle: string; kind: PartnerRequestKind; askMilaSessionId: string | null }): Promise<{ ok: true; nextUrl: string } | { ok: false; reason: "closed" | "invalid" }>;
}

export interface PublicMilaPorts {
  bookings: PublicBookingsPort | null;
  partner: PartnerIntakePort | null;
}

/** The next-step URL a port hands back must stay on this site: a same-origin path, never another origin. */
export function safeNextUrl(u: unknown): string | null {
  return typeof u === "string" && /^\/(?!\/)[A-Za-z0-9\-._~/?=&%:]{0,300}$/.test(u) ? u : null;
}
