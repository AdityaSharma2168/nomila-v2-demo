/** The card's one button by qualification (owner, 22 Oct 2026): wording and buttons only, same four categories. */
import { actionsFor, takeFor } from "./opportunityNext";

const base = { stage: null, kind: "deal", channel: "direct" } as any;

it("terms in → Accept or counter; under her minimum → Counter beside Decline; the rest unchanged", () => {
  expect(actionsFor({ ...base, qualification: "workable", state: "cash" }).primary).toEqual({ action: "accept_or_counter", label: "Accept or counter" });
  const below = actionsFor({ ...base, qualification: "below_floor", state: "below_floor" });
  expect(below.primary.label).toBe("Counter");
  expect(below.secondary.map((s) => s.label)).toEqual(["Decline"]);
  expect(actionsFor({ ...base, qualification: "needs_terms", state: "needs_terms" }).primary.label).toBe("Ask for terms");
  expect(actionsFor({ ...base, qualification: "verify_first", state: "needs_terms" }).secondary[0].label).toBe("Ask who they are");
  expect(actionsFor({ ...base, channel: "unverifiable", qualification: "workable", state: "cash" }).primary.label).toBe("Reply");
  // Under way, a deal is answered with Reply whatever the first email's terms were.
  expect(actionsFor({ ...base, stage: "Negotiating", qualification: "workable", state: "cash" }).primary.label).toBe("Reply");
});

it("product only and commission only share one state, so one take fits both (owner, 23 Oct 2026)", () => {
  const product = { ...base, qualification: "workable", state: "product" };
  expect(takeFor(product, { looksSigned: false })).toBe("No cash on the table. Take it only if it’s a brand you’d post for anyway.");
  expect(takeFor(product, { looksSigned: false })).not.toMatch(/product|commission/i);
});
