/**
 * dealPayment.test.ts — the narrowing helpers fail loudly when a booking payment (deal_id NULL) reaches deal code.
 */
import { assertDealPayment, isDealPayment, requireDealId } from "./dealPayment";

describe("deal payment narrowing", () => {
  test("deal kinds with a deal id pass", () => {
    const p = { id: "p1", kind: "deal_payment", deal_id: "d1" as string | null };
    expect(() => assertDealPayment(p)).not.toThrow();
    expect(isDealPayment(p)).toBe(true);
    expect(isDealPayment({ kind: "deposit", deal_id: "d1" })).toBe(true);
  });

  test("a booking payment is refused", () => {
    const p = { id: "p2", kind: "booking_payment", deal_id: null as string | null };
    expect(() => assertDealPayment(p)).toThrow(/not a deal payment/);
    expect(isDealPayment(p)).toBe(false);
  });

  test("a deal kind without a deal id is refused", () => {
    expect(() => assertDealPayment({ id: "p3", kind: "deposit", deal_id: null })).toThrow(/no deal_id/);
    expect(() => requireDealId(null, "p3")).toThrow(/p3/);
    expect(requireDealId("d1")).toBe("d1");
  });
});
