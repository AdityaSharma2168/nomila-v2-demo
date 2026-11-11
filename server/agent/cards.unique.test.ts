/**
 * One booking request, one card (owner bug, 11 Nov 2026): Mila's proactive turn for a new booking request called
 * bookings_get twice on the same booking, each call left the card `booking:<runId>:<bookingId>`, and the saved message
 * held both, so "accept request" showed twice. A card id is the card: the turn keeps one per id, the later copy winning.
 */
import type { ChatCard } from "../../shared/agent";
import { bookingCard } from "./bookings/tools";
import { uniqueCards } from "./cards";
import { checkDecision } from "./proactive/decision";
import { PROACTIVE_RULES } from "./proactive/rules";

const RUN = "b7abbd16-b530-4b5d-91ac-b08d7553ee42";
const BOOKING = "7e99354a-e693-47c6-93bc-8eb62dcda83f";

const booking = (over: Record<string, unknown> = {}) => ({
  id: BOOKING, buyerLabel: "Mia B.", format: "video", title: "1:1 video call · 30 min", startsAt: "2026-11-11T09:00:00.000Z",
  proposedTimes: [], phase: "request", priceCents: 5000, currency: "usd", respondBy: null,
  checks: { email: true, phone: false, idChecked: false, adult: true }, ...over,
}) as any;

const ctx = { runId: RUN, athleteId: "dc8f37f1-deff-43f8-8c02-e37a5cc20d4f" } as any;

describe("uniqueCards", () => {
  it("keeps one card per id, at the first one's place, with the later copy's content", () => {
    const first = bookingCard(booking(), ctx);
    const again = bookingCard(booking({ startsAt: "2026-11-11T10:00:00.000Z" }), ctx);
    const other: ChatCard = { id: "how-i-got-this:x", kind: "how-i-got-this", title: "How I got this", payload: {}, links: [], runId: RUN } as any;
    expect(first.id).toBe(again.id);
    const out = uniqueCards([first, other, again]);
    expect(out.map((c) => c.id)).toEqual([first.id, other.id]);
    expect(out[0]).toBe(again);
  });

  it("never drops cards with different ids (two bookings stay two cards)", () => {
    const a = bookingCard(booking(), ctx);
    const b = bookingCard(booking({ id: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(uniqueCards([a, b])).toHaveLength(2);
  });

  it("a proactive booking_request turn that read the booking twice sends one card", () => {
    const card = bookingCard(booking(), ctx);
    const run = {
      runId: RUN, status: "completed", stopReason: null,
      text: '```json\n{"decision":"SPEAK","reason":"new request","message":"You have a request for a 1:1 video call.","evidence":["booking:' + BOOKING + '"]}\n```',
      cards: uniqueCards([card, bookingCard(booking(), ctx)]),
      evidence: [], tools: [],
    } as any;
    const v = checkDecision({ kind: "booking_request", payload: { bookingId: BOOKING } }, PROACTIVE_RULES.booking_request, run, 600);
    expect(v.send).toBe(true);
    if (v.send) expect(v.cards.filter((c) => c.kind === "booking")).toHaveLength(1);
  });
});
