/**
 * The payment push (services/push/events.ts): copy, privacy, target and the gates. Pure; pushSoon is mocked, so nothing
 * reaches Expo or the database.
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("./push", () => {
  const actual = jest.requireActual("./push");
  return { ...actual, pushSoon: jest.fn() };
});
import { pushSoon } from "./push";
import { moneyWords, paymentReceivedEvent, pushPaymentReceived, PAYMENT_FRESH_MS } from "./events";

const base = { threadId: "t-1", opportunityId: "o-1", brand: "Acme  Co", amountCents: 500000, currency: "usd" };

describe("paymentReceivedEvent", () => {
  it("names the brand and amount only in the named copy, and opens the opportunity", () => {
    const e = paymentReceivedEvent(base);
    expect(e.kind).toBe("payment_received");
    expect(e.dedupeKey).toBe("payment_received:t-1");
    expect(e.title).toBe("You got paid");
    expect(e.body).not.toMatch(/Acme|5,000/);
    expect(e.named).toEqual({ title: "Acme Co paid you $5,000" });
    expect(e.target).toEqual({ screen: "opportunities", id: "o-1" });
  });
  it("leaves the amount out when the notice stated none, and the name when there is none", () => {
    expect(paymentReceivedEvent({ ...base, amountCents: null }).named).toEqual({ title: "Acme Co paid you" });
    expect(paymentReceivedEvent({ ...base, brand: null }).named).toBeUndefined();
  });
  it("words money in whole units when whole", () => {
    expect(moneyWords(500000)).toBe("$5,000");
    expect(moneyWords(123450, "eur")).toBe("1,234.50 EUR");
  });
});

describe("pushPaymentReceived", () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; (pushSoon as jest.Mock).mockClear(); });
  const now = new Date("2026-10-20T12:00:00Z");

  it("sends nothing unless both the push and the payment switches are on", () => {
    process.env.PUSH_NOTIFICATIONS = "true"; delete process.env.PUSH_PAYMENT_RECEIVED;
    pushPaymentReceived("a-1", { ...base, paidAt: now }, now);
    process.env.PUSH_PAYMENT_RECEIVED = "true"; process.env.PUSH_NOTIFICATIONS = "false";
    pushPaymentReceived("a-1", { ...base, paidAt: now }, now);
    expect(pushSoon).not.toHaveBeenCalled();
  });
  it("sends a fresh notice once switched on, never an old one", () => {
    process.env.PUSH_NOTIFICATIONS = "true"; process.env.PUSH_PAYMENT_RECEIVED = "true";
    pushPaymentReceived("a-1", { ...base, paidAt: new Date(now.getTime() - PAYMENT_FRESH_MS - 1) }, now);
    pushPaymentReceived("a-1", { ...base, paidAt: null }, now);
    expect(pushSoon).not.toHaveBeenCalled();
    pushPaymentReceived("a-1", { ...base, paidAt: new Date(now.getTime() - 60_000) }, now);
    expect(pushSoon).toHaveBeenCalledTimes(1);
    expect((pushSoon as jest.Mock).mock.calls[0][1].dedupeKey).toBe("payment_received:t-1");
  });
});
