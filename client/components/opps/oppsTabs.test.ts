import { pillLabel } from "./oppsTabs";

describe("pillLabel", () => {
  it("speaks the count only when something needs her", () => {
    expect(pillLabel({ label: "Deals", count: 4 })).toBe("Deals, 4 need you");
    expect(pillLabel({ label: "Bookings", count: 1 })).toBe("Bookings, 1 needs you");
    expect(pillLabel({ label: "Deals", count: 0 })).toBe("Deals");
    expect(pillLabel({ label: "Deals", count: null })).toBe("Deals");
  });
});
