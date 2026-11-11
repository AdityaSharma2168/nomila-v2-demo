/**
 * routes/bookingsPublic.ts — the buyer's side of Bookings v2: account-less JSON for the public booking page (built
 * later). Mounted at /api/v1/book. Every route answers 404 while BOOKINGS_ENABLED is off, and for any athlete not on the
 * pilot list. Rate-limited per IP. Owner-scoped: a booking is reached only by its private token (from the buyer's
 * email), and everything after the first email code also needs the access key that code returned (header
 * `x-booking-access`) — the link alone opens nothing.
 *
 *   GET  /cards/:handle/offers                her bookable offers for her public page's Book door, live (each as
 *                                             GET /offers/:publicId answers); 404 unless her published card has Book on
 *   GET  /offers/:publicId                    the offer, her first name, the all-in quote, open times
 *   GET  /offers/:publicId/quote?party_size=N the all-in quote alone (a private group prices 1..max people; default 1)
 *   POST /offers/:publicId/requests           { slot_id | proposed_times, proposed_note?, message, buyer_name, buyer_email,
 *                                               buyer_phone, buyer_timezone, adult_attested, parent_booking?,
 *                                               child_first_name?, agree_terms, displayed_total_cents } → 201 { token … }
 *   POST /b/:token/contact                    a request that started in Ask Mila: the contact step (same fields and
 *                                             checks as a direct request, minus the time) → sends the email code
 *   POST /b/:token/email/send                 (re)send the email code
 *   POST /b/:token/email/verify  { code }     → { access, accessExpiresAt, nextStep }
 *   POST /b/:token/access/send · /access { code }   a fresh access key later (the status page's email-code re-check)
 *   — the rest need x-booking-access —
 *   POST /b/:token/phone/verify  { firebase_id_token }
 *   POST /b/:token/identity · /identity/refresh       Stripe Identity (in person, or her offer asks)
 *   POST /b/:token/hold · /hold/confirm               the card hold (Checkout, manual capture) and the return re-check
 *   GET  /b/:token                            the status page's data
 *   POST /b/:token/withdraw · /pick-time { start } · /pay
 *   GET  /b/:token/cancel-preview · POST /b/:token/cancel
 *   GET|POST /b/:token/messages
 *   GET  /b/:token/guests · POST /b/:token/guests { email, name? } | { guests: [{ email, name? }] }
 *   DELETE /b/:token/guests/:guestId · POST /b/:token/guests/:guestId/resend
 *                                             a private group's friends (0153): up to party_size − 1, once paid, until
 *                                             the end; each gets their own call link by email
 *
 * The session and after it — the call, "It happened" (which releases her money), "Report a problem" — are the session
 * page of #868 (/s/:token, routes/bookingSession.ts), the ONE release path.
 */
import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { bookingCodeLimiter, bookingPublicLimiter, bookingRequestLimiter } from "../lib/rateLimit";
import { BOOKINGS, bookingsEnabledFor } from "../services/bookings/config";
import { allInLine, quoteBookingCharge } from "../services/bookings/money";
import {
  attachContact, bookingByToken, buyerCancelPreview, buyerPayLink, buyerView, cancelByBuyer, checkEmailCode,
  confirmHoldReturn, confirmPhone, createRequest, partySizeFor, pickTime, publicOffer, publicOffersForHandle, quoteOf, refreshIdentity, requireAccess, resendEmailCode,
  startHold, startIdentity, withdrawBooking,
} from "../services/bookings/buyer";
import { postMessage, threadFor } from "../services/bookings/relay";
import { addGuests, guestViews, removeGuest, resendGuestInvite } from "../services/bookings/guests";
import { coded } from "../services/bookings/common";
import type { Booking } from "../../shared/schema";

const logger = createLogger("routes/bookingsPublic");
const router = Router();

router.use((_req, res, next) => {
  if (!BOOKINGS.enabled) { res.status(404).json({ error: "not found" }); return; }
  if (!BOOKINGS.hashSecret) { res.status(503).json({ error: "bookings aren't available right now", code: "BOOKINGS_NOT_CONFIGURED" }); return; }
  next();
});
router.use(bookingPublicLimiter);

const STATUS: Record<string, [number, string]> = {
  NOT_FOUND:           [404, "This link doesn't work any more. Check your latest email from Nomila."],
  INVALID:             [400, "Check the highlighted fields."],
  PRICE_CHANGED:       [409, "The price changed. Here's the new total."],
  SLOT_TAKEN:          [409, "That time was just booked. Pick another."],
  SLOT_FULL:           [409, "That session just filled up. Pick another time."],
  ALREADY_BOOKED:      [409, "You already have a spot in this session. Check your email for it."],
  GUESTS_FULL:         [409, "Everyone in your group is already added. Remove someone to add another."],
  ALREADY_INVITED:     [409, "That friend is already added."],
  // 0154: an address the athlete blocked. Neutral on purpose: it never says why.
  CANT_INVITE:         [409, "We couldn't invite that email to this session."],
  UNAVAILABLE:        [409, "This isn't available right now."],
  TOO_MANY:            [429, "Too many open requests. Finish or wait for one first."],
  ALREADY_CONFIRMED:   [409, "Your email is already confirmed."],
  CONTACT_FIRST:       [409, "Add your name and email first."],
  CONTACT_DONE:        [409, "We already have your details."],
  VERIFY_FIRST:        [409, "Confirm your email first."],
  WAIT:                [429, "Wait a few seconds before asking for another code."],
  NO_CODE:             [409, "Ask for a new code."],
  TOO_MANY_TRIES:      [429, "Too many tries. Start again in 10 minutes."],
  CODE_EXPIRED:        [400, "That code expired. We sent a new one."],
  WRONG_CODE:          [400, "That code didn't match."],
  ACCESS_REQUIRED:     [401, "Confirm the code we emailed you to open this page."],
  PHONE_NOT_CONFIRMED: [400, "We couldn't confirm that number. Try a mobile number."],
  WRONG_STATE:         [409, "This booking has changed. Refresh the page."],
  HOLD_LAPSED:         [409, "The time you picked was released. Pick a time again."],
  RETURNING_ONLY:      [403, "This athlete is only booking people they've met before right now."],
  IDENTITY_FIRST:      [409, "Finish the ID check first."],
  NOT_REQUIRED:        [409, "No ID check is needed for this booking."],
  ALREADY_VERIFIED:    [409, "Your ID check is done."],
  STARTED:             [409, "The session has started. Report a problem instead."],
  TOO_EARLY:           [409, "Not yet."],
  REPORT_OPEN:         [409, "A person at Nomila is looking at your report."],
  EXPIRED:             [409, "The time to pay ran out."],
  THREAD_CLOSED:       [409, "Messages are closed for this booking."],
  CHECKOUT_UNAVAILABLE: [502, "Couldn't reach the payment page. Try again."],
};

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try { await handler(req, res); }
    catch (err: any) {
      const hit = err?.code ? STATUS[err.code] : undefined;
      if (hit) { res.status(hit[0]).json({ error: hit[1], code: err.code, ...(err.detail !== undefined ? { detail: err.detail } : {}) }); return; }
      logger.error({ path: req.route?.path, error: err?.message }, "booking public route failed");
      res.status(500).json({ error: "Something went wrong. Try again." });
    }
  };
}

/** The booking for :token (its athlete must be in the pilot), and — unless `open` — a valid access key. */
async function load(req: Request, open = false): Promise<Booking> {
  const b = await bookingByToken(req.params.token);
  if (!bookingsEnabledFor(b.athlete_id)) throw coded("NOT_FOUND");
  if (!open) requireAccess(b, req.header("x-booking-access"));
  return b;
}

// ── the offer ──
router.get("/cards/:handle/offers", wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ offers: await publicOffersForHandle(req.params.handle) });
}));
router.get("/offers/:publicId", wrap(async (req, res) => { res.json({ offer: await publicOffer(req.params.publicId) }); }));
router.get("/offers/:publicId/quote", wrap(async (req, res) => {
  const o = await publicOffer(req.params.publicId);
  const party = partySizeFor({ audience: o.audience, max_people: o.maxPeople }, req.query.party_size);
  if (party === null) throw coded("INVALID", [{ field: "party_size", problem: `1 to ${o.audience === "private_group" ? o.maxPeople : 1} people` }]);
  const quote = quoteOf(o.quote.unitPriceCents ?? o.quote.priceCents, party);
  res.json({ quote, allInLine: allInLine(quoteBookingCharge(quote.priceCents, { maxPriceCents: Number.MAX_SAFE_INTEGER }), o.athleteFirstName), freeCancelHours: o.freeCancelHours });
}));
router.post("/offers/:publicId/requests", bookingRequestLimiter, wrap(async (req, res) => {
  res.status(201).json(await createRequest(req.params.publicId, req.body ?? {}));
}));

// ── codes ──
router.post("/b/:token/contact", bookingRequestLimiter, wrap(async (req, res) => { res.json(await attachContact(await load(req, true), req.body ?? {})); }));
router.post("/b/:token/email/send", bookingCodeLimiter, wrap(async (req, res) => { res.json(await resendEmailCode(await load(req, true), "verify")); }));
router.post("/b/:token/email/verify", bookingCodeLimiter, wrap(async (req, res) => { res.json(await checkEmailCode(await load(req, true), req.body?.code)); }));
router.post("/b/:token/access/send", bookingCodeLimiter, wrap(async (req, res) => { res.json(await resendEmailCode(await load(req, true), "access")); }));
router.post("/b/:token/access", bookingCodeLimiter, wrap(async (req, res) => { res.json(await checkEmailCode(await load(req, true), req.body?.code)); }));
router.post("/b/:token/phone/verify", bookingCodeLimiter, wrap(async (req, res) => { res.json(await confirmPhone(await load(req), req.body?.firebase_id_token)); }));
router.post("/b/:token/identity", wrap(async (req, res) => { res.json(await startIdentity(await load(req))); }));
router.post("/b/:token/identity/refresh", wrap(async (req, res) => { res.json(await refreshIdentity(await load(req))); }));

// ── the hold ──
router.post("/b/:token/hold", wrap(async (req, res) => { res.json(await startHold(await load(req))); }));
router.post("/b/:token/hold/confirm", wrap(async (req, res) => {
  const b = await load(req);
  await confirmHoldReturn(b);
  res.json({ booking: await buyerView(await bookingByToken(req.params.token)) });
}));

// ── the private page ──
router.get("/b/:token", wrap(async (req, res) => { res.json({ booking: await buyerView(await load(req)) }); }));
router.post("/b/:token/withdraw", wrap(async (req, res) => { res.json({ booking: await withdrawBooking(await load(req)) }); }));
router.post("/b/:token/pick-time", wrap(async (req, res) => { res.json({ booking: await pickTime(await load(req), req.body?.start) }); }));
router.post("/b/:token/pay", wrap(async (req, res) => { res.json(await buyerPayLink(await load(req))); }));
router.get("/b/:token/cancel-preview", wrap(async (req, res) => { res.json(await buyerCancelPreview(await load(req))); }));
router.post("/b/:token/cancel", wrap(async (req, res) => { res.json({ booking: await cancelByBuyer(await load(req)) }); }));
router.get("/b/:token/messages", wrap(async (req, res) => { const b = await load(req); res.json({ messages: await threadFor(b.id, "buyer") }); }));
// ── a private group's friends (0153) ──
router.get("/b/:token/guests", wrap(async (req, res) => { const b = await load(req); res.json({ guests: await guestViews(b.id) }); }));
router.post("/b/:token/guests", bookingRequestLimiter, wrap(async (req, res) => { res.status(201).json({ guests: await addGuests(await load(req), req.body ?? {}) }); }));
router.delete("/b/:token/guests/:guestId", wrap(async (req, res) => { res.json({ guests: await removeGuest(await load(req), req.params.guestId) }); }));
router.post("/b/:token/guests/:guestId/resend", bookingCodeLimiter, wrap(async (req, res) => { res.json({ guests: await resendGuestInvite(await load(req), req.params.guestId) }); }));

router.post("/b/:token/messages", wrap(async (req, res) => {
  const b = await load(req);
  await postMessage(b, "buyer", req.body?.body);
  res.status(201).json({ messages: await threadFor(b.id, "buyer") });
}));

export default router;
