import { bookingRowLine, cappedLine, closedHint, dealRowLogo, dealRowStatus, onlyNotADeal, shortDay } from "./searchLogic";
import { searchPath } from "../../hooks/use-deal-search";
import { bookingsTabState, isGroupLine, lineOpener, lineState, requestsLede } from "./bookingsTabLogic";
import type { DealSearchRow } from "../../hooks/use-deal-search";
jest.mock("../../lib/query-client", () => ({ apiRequest: jest.fn() }));


const row = (over: Partial<DealSearchRow> = {}): DealSearchRow => ({
  opportunity_id: "o1",
  brand: { id: 1, name: "Nuun", logo_url: "https://logo/nuun.png", safe_logo_url: "https://own/nuun.png", domain: "nuun.com", is_person: false, research_confirmed: false },
  via: null, dealType: "gift", type_label: "Gift", money: "Product only (~$150)", ask: null, status_label: "Waiting on you",
  tab: "active", closed_group: null, last_activity_at: "2026-10-07T10:00:00Z", closed_at: null, ...over,
});

describe("All deals rows", () => {
  it("status + last activity; a closed row shows when it closed", () => {
    expect(dealRowStatus(row())).toBe("Waiting on you · Oct 7");
    expect(dealRowStatus(row({ tab: "closed", status_label: "Not a deal", closed_at: "2026-09-02T00:00:00Z" }))).toBe("Not a deal · Sep 2");
    expect(shortDay(null)).toBeNull();
  });

  it("the logo: the own-domain one until research is confirmed", () => {
    expect(dealRowLogo(row())).toEqual({ logoUrl: "https://own/nuun.png", domain: "nuun.com" });
    expect(dealRowLogo(row({ brand: { ...row().brand, research_confirmed: true } })).logoUrl).toBe("https://logo/nuun.png");
  });

  it("filed mail is under Closed → Not a deal, and Active says so", () => {
    expect(onlyNotADeal([row({ closed_group: "not_a_deal" }), row({ closed_group: "declined" })])).toHaveLength(1);
    expect(closedHint({ tab: "active", tabs: { active: 4, done: 2, closed: 7 } }, 5)).toBe("Plus 7 under Closed, 5 of them filed as “Not a deal”.");
    expect(closedHint({ tab: "active", tabs: { active: 4, done: 2, closed: 7 } }, null)).toBe("Plus 7 under Closed.");
    expect(closedHint({ tab: "closed", tabs: { active: 4, done: 2, closed: 7 } }, 5)).toBeNull();
  });

  it("says when the server capped the rows", () => {
    expect(cappedLine(212, 50)).toBe("Showing the newest 50 of 212. Search to narrow them.");
    expect(cappedLine(12, 12)).toBeNull();
  });

  it("the search path is stable and encoded", () => {
    expect(searchPath("/api/v1/me/deals/search", { q: " gift box ", tab: "closed", filter: "gift", filterKey: "type" })).toBe("/api/v1/me/deals/search?q=gift%20box&tab=closed&type=gift&limit=50");
    expect(searchPath("/api/v1/me/bookings/search", { q: "", tab: "active", filter: null, filterKey: "format" })).toBe("/api/v1/me/bookings/search?q=&tab=active&limit=50");
  });
});

describe("All bookings and the Bookings tab", () => {
  it("a booking row: format, length, day, price", () => {
    expect(bookingRowLine({ format_label: "Video call", duration_minutes: 30, starts_at: "2026-10-18T16:00:00Z", price_cents: 6000, currency: "usd" })).toBe("Video call · 30 min · Oct 18 · $60");
  });

  it("not set up → the empty state; set up → the board", () => {
    expect(bookingsTabState(undefined)).toBe("loading");
    expect(bookingsTabState(null)).toBe("empty");
    expect(bookingsTabState({ published: false, requests: [], upcoming: [] })).toBe("empty");
    expect(bookingsTabState({ published: true, requests: [], upcoming: [] })).toBe("board");
    expect(requestsLede(1)).toBe("1 request needs you.");
    expect(requestsLede(0)).toBeNull();
  });

  it("an open group's time is ONE line: 'n of max booked', and it opens the group screen by its slot (0153)", () => {
    const group = { id: "b1", status: "confirmed", audience: "open_group" as const, slotId: "s1", spotsTaken: 4, capacity: 10 };
    const one = { id: "b2", status: "confirmed", audience: "one" as const, slotId: null };
    expect(isGroupLine(group)).toBe(true);
    expect(isGroupLine(one)).toBe(false);
    expect(isGroupLine({ id: "b3", status: "confirmed" })).toBe(false);   // an older server: no audience
    expect(lineState(group)).toEqual({ text: "4 of 10 booked", waiting: false });
    expect(lineState(one)).toEqual({ text: "Accepted", waiting: false });
    expect(lineState({ id: "b4", status: "requested" })).toEqual({ text: "Waiting for you", waiting: true });
    const onOpen = jest.fn(), onOpenGroup = jest.fn();
    lineOpener(group, onOpen, onOpenGroup)!();
    lineOpener(one, onOpen, onOpenGroup)!();
    expect(onOpenGroup).toHaveBeenCalledWith("s1");
    expect(onOpen).toHaveBeenCalledWith("b2");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(lineOpener(group, onOpen)).toBeNull();   // no group screen in this build: not a dead tap
    expect(lineOpener(one)).toBeNull();
  });
});
