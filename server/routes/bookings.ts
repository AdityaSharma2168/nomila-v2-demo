/**
 * routes/bookings.ts — her side of Bookings v2 (requireAuth; mounted at /api/v1/me). Every route answers 404 unless
 * BOOKINGS_ENABLED is on AND she is on BOOKINGS_PILOT_ATHLETE_IDS, so the feature is invisible to everyone else. Every
 * query is scoped to req.athleteId: another athlete's offer or booking is 404, never 403.
 *
 * Every route here that reaches the buyer or moves money (publish, accept, decline, propose, cancel, a message) is her
 * own tap on a confirm sheet in the app. Mila has no path to any of them.
 *
 *   GET    /bookings/overview                her Bookings screens: payouts, offer counts, requests waiting, limits
 *                                            (GET /bookings/summary is app layout B's read in routes/financials.ts)
 *   POST   /bookings/quote                   { price_cents, party_size? } → what buyers pay (the editor's live line);
 *                                            price_cents is PER PERSON, party_size (default 1) prices a group booking
 *   GET    /bookings/offers                  her offers (not archived)
 *   POST   /bookings/offers                  create a draft
 *   GET    /bookings/offers/:id              one offer
 *   PATCH  /bookings/offers/:id              edit (applies to new requests only)
 *   DELETE /bookings/offers/:id              archive
 *   POST   /bookings/offers/:id/publish      { adult_attested } — gated on payouts
 *   POST   /bookings/offers/:id/pause | /resume
 *   GET    /bookings/offers/:id/slots        open times
 *   POST   /bookings/offers/:id/slots        { starts: ISO[] }
 *   POST   /bookings/offers/:id/slots/withdraw { slot_ids: id[] } (≤ 100) — many open times at once; booked ones stay
 *   DELETE /bookings/offers/:id{ID}/slots/:slotId{ID}
 *   GET    /bookings?view=requests|upcoming|past
 *   GET    /bookings/payouts                 booking money for Financials
 *   GET    /bookings/search                  ?q=&tab=active|done|closed&format= — All bookings (DEALS_SEARCH)
 *   GET    /bookings/:id                     detail (no buyer contact details)
 *   POST   /bookings/:id/accept              { start?, backup_link? } — captures the held card
 *   POST   /bookings/:id/decline             { reason? } — releases the hold
 *   POST   /bookings/:id/propose             { times } — 1–3 other times
 *   GET    /bookings/:id/cancel-preview
 *   POST   /bookings/:id/cancel              { reason? } — full refund to the buyer
 *   GET    /bookings/:id/messages · POST /bookings/:id/messages { body }
 *
 * Open group sessions (0153): one time, many fans, ONE item for her (services/bookings/groups.ts). Each fan's spot is
 * still its own booking above (its money, refund and release); these read and act on the whole time:
 *   GET    /bookings/groups?view=upcoming|past            → { view, groups: GroupSessionListItemView[] }
 *   GET    /bookings/groups/:slotId                       → { group: GroupSessionView }
 *   GET    /bookings/groups/:slotId/cancel-preview        → GroupCancelPreviewView
 *   POST   /bookings/groups/:slotId/cancel   { reason? }  → GroupCancelResultView: every spot cancelled + refunded in full
 *   POST   /bookings/groups/:slotId/session-done          → { group } ("Session done" on every live spot; no money)
 * Joining the time's ONE room and removing a participant are the session routes (routes/bookingSession.ts).
 *
 * Blocking (0154; services/bookings/blocking.ts + services/fanSafety/fanBlocks.ts), each her tap on a confirm sheet:
 *   GET    /bookings/blocks                               → { blocks: FanBlockView[] } her Blocked fans
 *   DELETE /bookings/blocks/:blockId                      → unblock → { blocks }
 *   GET    /bookings/:id/block-preview?identity=          → BlockPreviewView (who; upcoming bookings cancelled + refunded)
 *   POST   /bookings/:id/block   { identity?, reason? }   → BlockResultView. No identity = the booker; an identity = that
 *                                                           person in the call (booker / friend). Takes them out of the
 *                                                           call, cancels + fully refunds their upcoming paid bookings.
 *   GET    /bookings/groups/:slotId/block-preview?identity= · POST /bookings/groups/:slotId/block { identity } → one fan
 *                                                           in an open group's call (a tile)
 *
 * The session and the after-session taps (session, session-done, buyer-no-show, report, checkin) are the session PR's
 * routes (#868, routes/bookingSession.ts) on the same /bookings/:id prefix.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { bookingsEnabledFor } from "../services/bookings/config";
import { isBookablePrice, quoteBookingCharge } from "../services/bookings/money";
import {
  addSlots, archiveOffer, createOffer, getOffer, listOffers, listSlots, offerViews, pauseOffer, publishOffer, resumeOffer,
  updateOffer, withdrawSlot, withdrawSlots,
} from "../services/bookings/offers";
import {
  acceptBooking, bookingDetail, bookingPayouts, bookingsSummary, cancelByAthlete, cancelPreview, declineBooking,
  getOwnedBooking, listBookings, proposeTimes, type BookingListView,
} from "../services/bookings/athlete";
import { searchBookings } from "../services/bookings/search";
import { MAX_GROUP_PEOPLE, quotePartyCharge } from "../services/bookings/money";
import {
  cancelGroupSession, groupCancelPreview, groupSessionDetail, listGroupSessions, markGroupSessionDone, type GroupListView,
} from "../services/bookings/groups";
import { postMessage, threadFor } from "../services/bookings/relay";
import { blockFromCall, blockPreview } from "../services/bookings/blocking";
import { listFanBlocks, unblockFan } from "../services/fanSafety/fanBlocks";

const logger = createLogger("routes/bookings");
const router = Router();

/**
 * The pilot gate: off (or not on the list) → leave this router, as if these routes did not exist. Other /bookings routes
 * on the same mount (the read-only GET /bookings/summary of routes/financials.ts) still answer; anything else ends in the
 * app's 404.
 */
function gate(req: Request, _res: Response, next: NextFunction): void {
  if (!req.athleteId || !bookingsEnabledFor(req.athleteId)) { next("router"); return; }
  next();
}

/** A booking / offer id segment is a UUID; anything else ("summary") is not ours and falls through. */
const ID = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";

const STATUS: Record<string, [number, string]> = {
  NOT_FOUND:        [404, "not found"],
  INVALID:          [400, "check the highlighted fields"],
  CONNECT_REQUIRED: [409, "set up payouts first"],
  NOT_READY:        [409, "this offer isn't ready to publish"],
  PAUSED_BY_NOMILA: [409, "your offers are paused while support takes a look"],
  WRONG_STATE:      [409, "this booking has changed — pull to refresh"],
  STALE_STATE:      [409, "this booking has changed — pull to refresh"],
  ILLEGAL_TRANSITION: [409, "that isn't possible for this booking"],
  NO_HOLD:          [409, "this request has no card hold"],
  EXPIRED:          [409, "this request expired"],
  PICK_A_TIME:      [400, "pick one of the suggested times"],
  TIME_PASSED:      [409, "that time has passed"],
  TIME_TAKEN:       [409, "you've booked this time"],
  SLOT_TAKEN:       [409, "someone has asked for this time"],
  STARTED:          [409, "the session has started"],
  TOO_EARLY:        [409, "not yet"],
  ALREADY_MARKED:   [409, "already marked"],
  THREAD_CLOSED:    [409, "messages are closed for this booking"],
  REFUND_FAILED:    [502, "couldn't refund — we'll retry"],
  CHARGEBACK_OPEN:  [409, "the buyer's bank has opened a dispute"],
  HAS_BOOKINGS:     [409, "people are booked: who it's for can't change now"],
  SLOT_FULL:        [409, "this time is full"],
};

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try { await handler(req, res); }
    catch (err: any) {
      const hit = err?.code ? STATUS[err.code] : undefined;
      if (hit) { res.status(hit[0]).json({ error: hit[1], code: err.code, ...(err.detail !== undefined ? { detail: err.detail } : {}) }); return; }
      logger.error({ path: req.path, athleteId: req.athleteId, error: err?.message }, "bookings route failed");
      res.status(500).json({ error: "failed" });
    }
  };
}

router.use("/bookings", requireAuth, gate);

router.get("/bookings/overview", wrap(async (req, res) => { res.json(await bookingsSummary(req.athleteId!)); }));

router.post("/bookings/quote", wrap(async (req, res) => {
  const price = req.body?.price_cents;
  const party = req.body?.party_size ?? 1;
  if (typeof price !== "number" || !isBookablePrice(price)) { res.status(400).json({ error: "price out of range", code: "INVALID" }); return; }
  if (typeof party !== "number" || !Number.isInteger(party) || party < 1 || party > MAX_GROUP_PEOPLE) { res.status(400).json({ error: "party size out of range", code: "INVALID" }); return; }
  const q = party === 1 ? { ...quoteBookingCharge(price), unitPriceCents: price, partySize: 1 } : quotePartyCharge(price, party);
  res.json({ priceCents: q.priceCents, serviceFeeCents: q.serviceFeeCents, buyerTotalCents: q.buyerTotalCents, athleteReceivesCents: q.athleteReceivesCents, currency: q.currency, unitPriceCents: q.unitPriceCents, partySize: q.partySize });
}));

// ── offers ──
router.get("/bookings/offers", wrap(async (req, res) => {
  res.json({ offers: await offerViews(req.athleteId!, await listOffers(req.athleteId!)) });
}));
router.post("/bookings/offers", wrap(async (req, res) => {
  const o = await createOffer(req.athleteId!, req.body ?? {});
  res.status(201).json({ offer: (await offerViews(req.athleteId!, [o]))[0] });
}));
router.get(`/bookings/offers/:id${ID}`, wrap(async (req, res) => {
  const o = await getOffer(req.athleteId!, req.params.id);
  res.json({ offer: (await offerViews(req.athleteId!, [o]))[0] });
}));
router.patch(`/bookings/offers/:id${ID}`, wrap(async (req, res) => {
  const o = await updateOffer(req.athleteId!, req.params.id, req.body ?? {});
  res.json({ offer: (await offerViews(req.athleteId!, [o]))[0] });
}));
router.delete(`/bookings/offers/:id${ID}`, wrap(async (req, res) => {
  await archiveOffer(req.athleteId!, req.params.id);
  res.status(204).end();
}));
router.post(`/bookings/offers/:id${ID}/publish`, wrap(async (req, res) => {
  const o = await publishOffer(req.athleteId!, req.params.id, req.body ?? {});
  res.json({ offer: (await offerViews(req.athleteId!, [o]))[0] });
}));
router.post(`/bookings/offers/:id${ID}/pause`, wrap(async (req, res) => {
  const o = await pauseOffer(req.athleteId!, req.params.id);
  res.json({ offer: (await offerViews(req.athleteId!, [o]))[0] });
}));
router.post(`/bookings/offers/:id${ID}/resume`, wrap(async (req, res) => {
  const o = await resumeOffer(req.athleteId!, req.params.id);
  res.json({ offer: (await offerViews(req.athleteId!, [o]))[0] });
}));

// ── slots ──
router.get(`/bookings/offers/:id${ID}/slots`, wrap(async (req, res) => {
  res.json({ slots: await listSlots(req.athleteId!, req.params.id) });
}));
router.post(`/bookings/offers/:id${ID}/slots`, wrap(async (req, res) => {
  await addSlots(req.athleteId!, req.params.id, req.body?.starts);
  res.status(201).json({ slots: await listSlots(req.athleteId!, req.params.id) });
}));
// Many at once (Edit hours): never a booked time; answers what was withdrawn, what stayed (booked) and the open times.
router.post(`/bookings/offers/:id${ID}/slots/withdraw`, wrap(async (req, res) => {
  const r = await withdrawSlots(req.athleteId!, req.params.id, req.body?.slot_ids);
  res.json({ ...r, slots: await listSlots(req.athleteId!, req.params.id) });
}));
router.delete(`/bookings/offers/:id${ID}/slots/:slotId${ID}`, wrap(async (req, res) => {
  await withdrawSlot(req.athleteId!, req.params.id, req.params.slotId);
  res.status(204).end();
}));

// ── bookings ──
router.get("/bookings", wrap(async (req, res) => {
  const view = (["requests", "upcoming", "past"].includes(req.query.view as string) ? req.query.view : "requests") as BookingListView;
  res.json({ view, bookings: await listBookings(req.athleteId!, view) });
}));
router.get("/bookings/payouts", wrap(async (req, res) => { res.json(await bookingPayouts(req.athleteId!)); }));
// All bookings (services/bookings/search, DEALS_SEARCH): ?q=&tab=active|done|closed&format= — buyer as she sees them,
// what was booked, the date and the status. Never buyer contact details.
router.get("/bookings/search", wrap(async (req, res) => {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  res.json(await searchBookings(req.athleteId!, { q: str(req.query.q), tab: str(req.query.tab), format: str(req.query.format), limit: str(req.query.limit) }));
}));
// ── open group sessions (0153) ──
router.get("/bookings/groups", wrap(async (req, res) => {
  const view = (req.query.view === "past" ? "past" : "upcoming") as GroupListView;
  res.json({ view, groups: await listGroupSessions(req.athleteId!, view) });
}));
router.get(`/bookings/groups/:slotId${ID}`, wrap(async (req, res) => { res.json({ group: await groupSessionDetail(req.athleteId!, req.params.slotId) }); }));
router.get(`/bookings/groups/:slotId${ID}/cancel-preview`, wrap(async (req, res) => { res.json(await groupCancelPreview(req.athleteId!, req.params.slotId)); }));
router.post(`/bookings/groups/:slotId${ID}/cancel`, wrap(async (req, res) => { res.json(await cancelGroupSession(req.athleteId!, req.params.slotId, req.body ?? {})); }));
router.post(`/bookings/groups/:slotId${ID}/session-done`, wrap(async (req, res) => { res.json({ group: await markGroupSessionDone(req.athleteId!, req.params.slotId) }); }));

// ── blocking (0154): her Blocked fans list, and Block from a booking / an open group's attendee / a call tile ──
router.get("/bookings/blocks", wrap(async (req, res) => { res.json({ blocks: await listFanBlocks(req.athleteId!) }); }));
router.delete(`/bookings/blocks/:blockId${ID}`, wrap(async (req, res) => {
  if (!(await unblockFan(req.athleteId!, req.params.blockId))) { res.status(404).json({ error: "not found", code: "NOT_FOUND" }); return; }
  res.json({ blocks: await listFanBlocks(req.athleteId!) });
}));
const identityQuery = (req: Request) => (typeof req.query.identity === "string" ? req.query.identity : undefined);
router.get(`/bookings/:id${ID}/block-preview`, wrap(async (req, res) => {
  res.json(await blockPreview(req.athleteId!, { bookingId: req.params.id }, { identity: identityQuery(req) }));
}));
router.post(`/bookings/:id${ID}/block`, wrap(async (req, res) => { res.json(await blockFromCall(req.athleteId!, { bookingId: req.params.id }, req.body ?? {})); }));
router.get(`/bookings/groups/:slotId${ID}/block-preview`, wrap(async (req, res) => {
  res.json(await blockPreview(req.athleteId!, { slotId: req.params.slotId }, { identity: identityQuery(req) }));
}));
router.post(`/bookings/groups/:slotId${ID}/block`, wrap(async (req, res) => { res.json(await blockFromCall(req.athleteId!, { slotId: req.params.slotId }, req.body ?? {})); }));

router.get(`/bookings/:id${ID}`, wrap(async (req, res) => { res.json({ booking: await bookingDetail(req.athleteId!, req.params.id) }); }));

router.post(`/bookings/:id${ID}/accept`, wrap(async (req, res) => {
  const r = await acceptBooking(req.athleteId!, req.params.id, req.body ?? {});
  if (r.result === "retry") { res.status(502).json({ error: "Couldn't accept. Nothing was sent. Try again.", code: "CAPTURE_RETRY" }); return; }
  res.json(r);
}));
router.post(`/bookings/:id${ID}/decline`, wrap(async (req, res) => { res.json({ booking: await declineBooking(req.athleteId!, req.params.id, req.body ?? {}) }); }));
router.post(`/bookings/:id${ID}/propose`, wrap(async (req, res) => { res.json({ booking: await proposeTimes(req.athleteId!, req.params.id, req.body ?? {}) }); }));
router.get(`/bookings/:id${ID}/cancel-preview`, wrap(async (req, res) => { res.json(await cancelPreview(req.athleteId!, req.params.id)); }));
router.post(`/bookings/:id${ID}/cancel`, wrap(async (req, res) => { res.json({ booking: await cancelByAthlete(req.athleteId!, req.params.id, req.body ?? {}) }); }));

router.get(`/bookings/:id${ID}/messages`, wrap(async (req, res) => {
  const b = await getOwnedBooking(req.athleteId!, req.params.id);
  res.json({ messages: await threadFor(b.id, "athlete") });
}));
router.post(`/bookings/:id${ID}/messages`, wrap(async (req, res) => {
  const b = await getOwnedBooking(req.athleteId!, req.params.id);
  await postMessage(b, "athlete", req.body?.body);
  res.status(201).json({ messages: await threadFor(b.id, "athlete") });
}));

export default router;
