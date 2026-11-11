/**
 * A saved row holding the same card twice draws it once (owner bug, 11 Nov 2026: a booking request's accept card showed
 * twice in Mila). The live stream already reconciles a data part by id; a reloaded chat must do the same.
 */
import { cardsOf, savedToMessages } from "./wire";

const BOOKING = "7e99354a-e693-47c6-93bc-8eb62dcda83f";
const card = (when: string) => ({
  id: `booking:b7abbd16-b530-4b5d-91ac-b08d7553ee42:${BOOKING}`, kind: "booking", title: "Mia B.",
  links: [{ label: "Open booking", target: { id: BOOKING, screen: "booking" } }], runId: "b7abbd16-b530-4b5d-91ac-b08d7553ee42",
  payload: { who: "Mia B.", what: "Video call · 1:1 video call · 30 min", when, bookingId: BOOKING, moneyLine: "$50 held until the session", suggested: null, statusLabel: "Waiting for you", waitingForYou: true },
});

describe("savedToMessages: one card per id", () => {
  it("the same booking card twice in a saved row is one card part (the later copy's data)", () => {
    const [m] = savedToMessages([{ id: "67a9779a", role: "assistant", content: "You have a request.", agentCards: [card("9:00 AM"), card("10:00 AM")] }]);
    const cards = cardsOf(m);
    expect(cards).toHaveLength(1);
    expect((cards[0].data as any).fields.when).toBe("10:00 AM");
  });

  it("different cards in one row all stay", () => {
    const other = { ...card("9:00 AM"), id: "booking:run:other", payload: { ...card("9:00 AM").payload, bookingId: "other" } };
    const [m] = savedToMessages([{ id: "1", role: "assistant", content: "", agentCards: [card("9:00 AM"), other] }]);
    expect(cardsOf(m)).toHaveLength(2);
  });
});
