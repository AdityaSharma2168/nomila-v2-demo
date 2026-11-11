/**
 * OpportunitiesScreen (the tab root, board on), rendered: the shell's tab-root look — a white screen (DESIGN.md §8b), the
 * title in the screenTitle role at the left (Strategy's), and NO refresh button (swipe down refreshes). The board, the
 * legacy co-pilot screens and the deals hooks are mocked; the board is handed the title row as its scroll header.
 *
 * App layout B: the money strip and the sections beside Deals, read through the REAL hooks (use-financials, use-shop)
 * from the shared wire shapes (shared/meSummaries); only apiRequest is stubbed.
 *   new athlete   no strip, no section heads, no Bookings or Shop: today's screen
 *   active        the strip ("$2,450 coming to you · $1,200 paid in Oct") → Financials; "Deals" head; Bookings (a
 *                 published offer) with its request "Waiting for you"; Shop (a live pick) → My Picks
 *   older server  404s read as nothing yet: today's screen
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaView, StyleSheet } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BookingsSummary, FinancialSummary } from "../../shared/meSummaries";
import { OpportunitiesScreen } from "./OpportunitiesScreen";
import { Bold, BoldType } from "../constants/theme";

const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack: jest.fn(), getParent: () => undefined }) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const Icon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Feather: Icon, Ionicons: Icon };
});
const flags = { OPPS_BOARD: true, SHOP_V1: true };
jest.mock("../lib/flags", () => ({ get OPPS_BOARD() { return flags.OPPS_BOARD; }, get SHOP_V1() { return flags.SHOP_V1; }, OPPS_LABEL: "Opportunities" }));
jest.mock("../lib/haptics", () => {
  const noop = () => {};
  return { haptics: { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop } };
});

// The one stubbed seam for the layout-B reads: each route's served body; a route with none answers 404.
let served: Record<string, unknown> = {};
const apiRoutes: string[] = [];
jest.mock("../lib/query-client", () => ({
  apiRequest: async (_m: string, route: string) => {
    apiRoutes.push(route);
    const body = served[route];
    if (body === undefined) throw new Error(`404: ${route}`);
    return { status: 200, json: async () => body };
  },
}));
jest.mock("../hooks/use-deals", () => ({ useDeals: () => ({ deals: [], isLoading: false, error: null, refetch: jest.fn() }) }));
jest.mock("../hooks/use-connections", () => ({ useConnections: () => ({ hasIssue: () => false }) }));
jest.mock("../hooks/use-pending-actions", () => ({ proposeAndApproveReply: jest.fn(), sendErrorMessage: () => "" }));
jest.mock("../components/deals/DealActionSheet", () => ({ DealActionSheet: () => null }));
jest.mock("../components/deals/ClassicListV2", () => ({ ClassicListV2: () => null }));
jest.mock("../components/deals/brief/BriefView", () => ({ BriefView: () => null }));
jest.mock("../components/deals/brief/DecisionSheet", () => ({ DecisionSheet: () => null }));
jest.mock("../components/deals/week/YourWeekOutcome", () => ({ YourWeekOutcome: () => null }));
jest.mock("../components/deals/week/FilteredView", () => ({ FilteredView: () => null }));
jest.mock("../components/deals/askterms/AskTermsBatch", () => ({ AskTermsBatch: () => null }));
jest.mock("../components/deals/AddContractSheet", () => ({ AddContractSheet: () => null }));
jest.mock("../lib/reply-link", () => ({ openReply: jest.fn() }));
const openPicks = jest.fn();
jest.mock("../navigation/meNav", () => ({ openSettings: jest.fn(), openPicks: (...a: unknown[]) => openPicks(...a) }));
// The board: renders the header and footer it is handed, so their places are observable.
jest.mock("../components/opps/OpportunityBoard", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { OpportunityBoard: ({ header, footer }: any) => React.createElement(View, { testID: "board" }, header, React.createElement(View, { testID: "board-deals" }), footer) };
});

const NO_MONEY: FinancialSummary = {
  version: "financials/0.1", hasMoney: false, currency: "usd", comingCents: 0, paidMonthCents: 0, paidYearCents: 0,
  payouts: { upcoming: [], paid: [] }, holds: [], refunds: { countYear: 0, cents: 0, items: [] },
  account: { state: "none", payoutsEnabled: false, detailsSubmitted: false, requirementsDue: 0 },
};
const MONEY: FinancialSummary = {
  ...NO_MONEY, hasMoney: true, comingCents: 245_000, paidMonthCents: 120_000, paidYearCents: 490_000,
  payouts: { upcoming: [{ id: "p1", source: "deal", label: "Brand E", dealId: "d1", bookingId: null, amountCents: 245_000, currency: "usd", at: null, stage: "awaiting_confirmation" }], paid: [] },
};
const NO_BOOKINGS: BookingsSummary = { version: "bookings-summary/0.1", published: false, publishedOffers: 0, requests: [], upcoming: [] };
const BOOKINGS: BookingsSummary = {
  version: "bookings-summary/0.1", published: true, publishedOffers: 1,
  requests: [{ id: "b1", title: "20-min video call", format: "video_call", status: "requested", priceCents: 12_000, currency: "usd", startsAt: "2026-10-18T16:00:00.000Z", respondBy: "2026-10-09T06:00:00.000Z", createdAt: "2026-10-08T00:00:00.000Z" }],
  upcoming: [],
};
const pick = (id: string, status: string, clicks7d: number) => ({ id, status, clicks7d, clicks30d: clicks7d, url: "https://example.test", host: "example.test", source: "link", networkTag: null, title: id, imageUrl: null, priceCents: null, currency: null, merchant: null, category: null, blurb: null, blurbSuggestion: null, discountCode: null, position: 0, publishedAt: null });
const shop = (items: unknown[]) => ({ settings: {}, items, nilGo: { applies: false, thresholdCents: 0, brands: [], copy: {} } });

function renderOpps() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><OpportunitiesScreen /></QueryClientProvider>);
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

// Let every read settle inside act before the tree unmounts.
afterEach(async () => { await flush(); });
beforeEach(() => { navigate.mockReset(); openPicks.mockReset(); flags.OPPS_BOARD = true; flags.SHOP_V1 = true; served = {}; apiRoutes.length = 0; });

it("white, the screenTitle at the left inside the board's scroll, and no refresh button", async () => {
  renderOpps();
  await flush();
  const safe = screen.UNSAFE_getAllByType(SafeAreaView)[0];
  expect(StyleSheet.flatten(safe.props.style).backgroundColor).toBe(Bold.paper);
  const title = screen.getByText("Opportunities");
  expect(StyleSheet.flatten(title.props.style)).toMatchObject({ fontSize: BoldType.screenTitle.fontSize, fontFamily: BoldType.screenTitle.fontFamily, color: Bold.ink });
  expect(StyleSheet.flatten(title.props.style).textAlign).toBeUndefined();
  // The title row is the board's scroll header (it scrolls with the board, as Strategy's does).
  const board = screen.getByTestId("board");
  expect(board.findAll((n: any) => n.props?.testID === "opportunities-head").length).toBeGreaterThan(0);
  expect(screen.queryByText("icon:refresh-cw")).toBeNull();
});

describe("app layout B: money and sections", () => {
  it("a new athlete: no strip, no section heads, no Bookings, no Shop — today's screen", async () => {
    served = { "/api/v1/me/financials": NO_MONEY, "/api/v1/me/bookings/summary": NO_BOOKINGS, "/api/v1/me/shop": shop([pick("draft", "draft", 0)]) };
    renderOpps();
    await flush();
    expect(apiRoutes).toEqual(expect.arrayContaining(["/api/v1/me/financials", "/api/v1/me/bookings/summary", "/api/v1/me/shop"]));
    expect(screen.queryByTestId("money-strip")).toBeNull();
    expect(screen.queryByText("Deals")).toBeNull();
    expect(screen.queryByTestId("opps-bookings")).toBeNull();
    expect(screen.queryByTestId("opps-shop")).toBeNull();
  });

  it("an older server (404 on every read): today's screen", async () => {
    renderOpps();
    await flush();
    expect(screen.queryByTestId("money-strip")).toBeNull();
    expect(screen.queryByText("Deals")).toBeNull();
  });

  it("active: the strip opens Financials; Deals head; Bookings with its request; Shop opens My Picks — in that order", async () => {
    served = { "/api/v1/me/financials": MONEY, "/api/v1/me/bookings/summary": BOOKINGS, "/api/v1/me/shop": shop([pick("a", "live", 12), pick("b", "live", 3), pick("c", "draft", 40)]) };
    renderOpps();
    await waitFor(() => expect(screen.getByTestId("money-strip")).toBeTruthy());
    expect(screen.getByText(/^\$2,450 coming to you · \$1,200 paid in [A-Z][a-z]{2}$/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("opps-shop")).toBeTruthy());
    expect(screen.getByText("Deals")).toBeTruthy();
    expect(screen.getByText("20-min video call")).toBeTruthy();
    expect(screen.getByText("Sun 18 Oct · $120")).toBeTruthy();
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("2 picks live")).toBeTruthy();
    expect(screen.getByText("15 clicks this week")).toBeTruthy();
    // the order inside the board's scroll: strip, (Deals head), the deals, Bookings, Shop
    const ids = screen.getByTestId("board").findAll((n: any) => ["money-strip", "board-deals", "opps-bookings", "opps-shop"].includes(n.props?.testID))
      .map((n: any) => n.props.testID).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    expect(ids).toEqual(["money-strip", "board-deals", "opps-bookings", "opps-shop"]);
    fireEvent.press(screen.getByTestId("money-strip"));
    expect(navigate).toHaveBeenLastCalledWith("Financials");
    fireEvent.press(screen.getByText("2 picks live"));
    expect(openPicks).toHaveBeenCalledTimes(1);
    // A booking row only reads (its detail is not built): nothing to accept or decline here.
    expect(screen.queryByText("Accept")).toBeNull();
    expect(screen.queryByText("Decline")).toBeNull();
  });

  it("SHOP_V1 off: no Shop section, and /me/shop is never read", async () => {
    flags.SHOP_V1 = false;
    served = { "/api/v1/me/financials": NO_MONEY, "/api/v1/me/bookings/summary": NO_BOOKINGS, "/api/v1/me/shop": shop([pick("a", "live", 1)]) };
    renderOpps();
    await flush();
    expect(screen.queryByTestId("opps-shop")).toBeNull();
    expect(apiRoutes).not.toContain("/api/v1/me/shop");
  });

  it("board off (Brief / Explore All): the strip and the sections sit above the lists", async () => {
    flags.OPPS_BOARD = false;
    served = { "/api/v1/me/financials": MONEY, "/api/v1/me/bookings/summary": BOOKINGS, "/api/v1/me/shop": shop([]) };
    renderOpps();
    await waitFor(() => expect(screen.getByTestId("opps-business")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("opps-bookings")).toBeTruthy());
    expect(screen.getByTestId("money-strip")).toBeTruthy();
    expect(screen.getByText("Deals")).toBeTruthy();
  });
});
