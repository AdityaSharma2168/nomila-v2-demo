/**
 * dealFixtures — made-up deal and booking cards for the agent gallery and the card tests (AGENT_DEALS_TOOLS /
 * AGENT_BOOKINGS_TOOLS). Brands and buyers are invented; logos come from a made-up domain (initials draw).
 */
import type { CardOf } from "./types";
import type { DealReplyCardPayload } from "../../../shared/agent";
import type { PendingRowLike } from "./dealCardLogic";

const BRAND = { name: "Northpeak Apparel", logoUrl: null, domain: null, isPerson: false };
const BRAND_2 = { name: "Trailmark Running", logoUrl: null, domain: null, isPerson: false };
const BRAND_3 = { name: "Brightwave Sodas", logoUrl: null, domain: null, isPerson: false };

export const DEAL_CARD_YOURS: CardOf<"deal"> = {
  id: "deal:run-1:o1", kind: "deal", title: BRAND.name, runId: "run-1",
  links: [{ label: "Open deal", target: { screen: "deal", id: "o1" } }],
  payload: {
    opportunityId: "o1", brand: BRAND, typeLabel: "Paid content", moneyLine: "$1,400 for 2 Reels — about $700 each, above your minimum",
    whoseMove: "yours", moveLabel: "Your move", chips: ["Above your minimum", "Nothing to flag", "Helps a goal"],
    action: { label: "Draft a reply", message: "Draft a reply to Northpeak Apparel" }, closed: false,
  },
};

export const DEAL_CARD_NO_FEE: CardOf<"deal"> = {
  id: "deal:run-1:o2", kind: "deal", title: BRAND_2.name, runId: "run-1",
  links: [{ label: "Open deal", target: { screen: "deal", id: "o2" } }],
  payload: {
    opportunityId: "o2", brand: BRAND_2, typeLabel: "No fee yet", moneyLine: "Their ask: a launch-week post · no fee yet",
    whoseMove: "yours", moveLabel: "Your move", chips: ["No fee yet"],
    action: { label: "Ask for terms", message: "Ask Trailmark Running for their terms" }, closed: false,
  },
};

export const DEAL_CARD_CLOSED: CardOf<"deal"> = {
  id: "deal:run-1:o9", kind: "deal", title: "Summit Gear", runId: "run-1",
  links: [{ label: "Open deal", target: { screen: "deal", id: "o9" } }],
  payload: {
    opportunityId: "o9", brand: { name: "Summit Gear", logoUrl: null, domain: null, isPerson: false }, typeLabel: "Paid content",
    moneyLine: "$3,000 for 4 posts", whoseMove: "nobody", moveLabel: "Done", chips: ["Above your minimum"], action: null, closed: true,
  },
};

const REPLY: DealReplyCardPayload = {
  pendingActionId: "pa-1", bodySha256: "0".repeat(64), opportunityId: "o1", dealId: "d1", threadId: "t1", brand: BRAND,
  intent: "counter", intentLabel: "Counter", inbox: "gmail", from: "rowan.athlete@gmail.com", to: "sam@northpeak.example",
  subject: "Re: November Reels", attachment: null,
  body: "Hi Sam,\n\nThanks for coming back so quickly. For two Reels with three months' paid usage I'd be at $1,800, with one round of edits.\n\nBest,\nRowan",
  sendable: true, whyNotSendable: null,
};

export const REPLY_CARD: CardOf<"deal-reply"> = {
  id: "deal-reply:pa-1", kind: "deal-reply", title: `Counter: ${BRAND.name}`, runId: "run-1",
  links: [{ label: "Open deal", target: { screen: "deal", id: "o1" } }], payload: REPLY,
};

export const REPLY_CARD_SENT: CardOf<"deal-reply"> = {
  ...REPLY_CARD, id: "deal-reply:pa-2", payload: { ...REPLY, pendingActionId: "pa-2", dealId: "d2", opportunityId: "o2" },
};

export const REPLY_CARD_OUTLOOK: CardOf<"deal-reply"> = {
  ...REPLY_CARD, id: "deal-reply:outlook", payload: { ...REPLY, pendingActionId: "", inbox: "outlook", sendable: false, whyNotSendable: "replies to Outlook mail are sent from Outlook for now", dealId: "d3" },
};

export const DEAL_CLOSED_CARD: CardOf<"deal-closed"> = {
  id: "deal-closed:run-1:o3", kind: "deal-closed", title: `Closed: ${BRAND_3.name}`, runId: "run-1", links: [],
  payload: {
    opportunityId: "o3", brand: BRAND_3, reason: "not_interested", reasonLabel: "Not interested", receiptId: "aa-1", actor: "you",
    politeNo: { ...REPLY, pendingActionId: "pa-3", dealId: "d4", opportunityId: "o3", brand: BRAND_3, intent: "decline", intentLabel: "Decline politely", to: "partners@brightwave.example", subject: "Re: Summer campaign", body: "Hi team,\n\nThanks so much for thinking of me. It's not the right fit this time, but I'd love to stay in touch.\n\nBest,\nRowan" },
  },
};

export const WAITING_CARD: CardOf<"deals-waiting"> = {
  id: "deals-waiting:run-1", kind: "deals-waiting", title: "Waiting for your tap", runId: "run-1", links: [],
  payload: {
    count: 3,
    items: [
      { pendingActionId: "pa-1", kind: "reply", opportunityId: "o1", brand: BRAND.name, title: `Reply to ${BRAND.name}`, createdAt: "2026-10-12T09:00:00.000Z" },
      { pendingActionId: "pa-5", kind: "ask_terms", opportunityId: "o2", brand: BRAND_2.name, title: `Ask ${BRAND_2.name} for terms`, createdAt: "2026-10-12T08:00:00.000Z" },
      { pendingActionId: "pa-3", kind: "reply", opportunityId: "o3", brand: BRAND_3.name, title: `Reply to ${BRAND_3.name}`, createdAt: "2026-10-11T18:00:00.000Z" },
    ],
  },
};

export const BOOKING_REQUEST_CARD: CardOf<"booking"> = {
  id: "booking:run-1:b1", kind: "booking", title: "Jordan P.", runId: "run-1",
  links: [{ label: "Open booking", target: { screen: "booking", id: "b1" } }],
  payload: { bookingId: "b1", who: "Jordan P.", what: "Video call · 30-minute call", when: "Sat, Oct 18, 4:00 PM", moneyLine: "$60 held until the session", statusLabel: "Waiting for you", waitingForYou: true, suggested: "accept" },
};

export const BOOKING_UPCOMING_CARD: CardOf<"booking"> = {
  id: "booking:run-1:b2", kind: "booking", title: "Riverside FC U14", runId: "run-1",
  links: [{ label: "Open booking", target: { screen: "booking", id: "b2" } }],
  payload: { bookingId: "b2", who: "Riverside FC U14", what: "Clinic · Group clinic", when: "Sun, Oct 26, 10:00 AM", moneyLine: "$480 paid, held until the session is done", statusLabel: "Confirmed", waitingForYou: false, suggested: null },
};

/** The pending actions the cards read (GET /pending-actions?deal_id=…), by deal id. */
export const DEAL_PENDING_ROWS: Record<string, PendingRowLike[]> = {
  d1: [{ id: "pa-1", status: "pending", payload: { body: REPLY.body }, result: null, error: null, expires_at: "2099-01-01T00:00:00.000Z" }],
  d2: [{ id: "pa-2", status: "approved", payload: { body_sha256: "x" }, result: { sent: true }, error: null, expires_at: null, executed_at: "2026-10-12T13:41:00.000Z" }],
  d4: [{ id: "pa-3", status: "pending", payload: {}, result: null, error: null, expires_at: "2099-01-01T00:00:00.000Z" }],
};

export const DEAL_CARD_FIXTURES = [DEAL_CARD_YOURS, DEAL_CARD_NO_FEE, DEAL_CARD_CLOSED, REPLY_CARD, REPLY_CARD_SENT, REPLY_CARD_OUTLOOK, DEAL_CLOSED_CARD, WAITING_CARD, BOOKING_REQUEST_CARD, BOOKING_UPCOMING_CARD];
