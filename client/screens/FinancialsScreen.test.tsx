/**
 * FinancialsScreen.test — her money (app layout B), rendered through the REAL hook (use-financials) from the shared wire
 * shape (shared/meSummaries FinancialSummary); only apiRequest is stubbed.
 *
 *   new athlete   the block at $0, "Nothing yet" and its line, no Payouts / Holds / Refunds, the payout account "Not set
 *                 up" with "Set up payouts" → POST /me/connect/onboard → Stripe's hosted page (her tap; moves no money)
 *   active        the block ("$2,450", "$1,200 paid in Oct · $4,900 this year"); Payouts upcoming (where each stands) then
 *                 paid; Holds; Refunds with this year's count; a deal's row opens that deal; a booking's row only reads;
 *                 "Payouts on" with no setup button; nothing on the screen spends, refunds or releases
 *   states        loading; error with Try again; a setup link that fails says so
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FinancialSummary } from "../../shared/meSummaries";
import { FinancialsScreen } from "./FinancialsScreen";

const navigate = jest.fn();
const goBack = jest.fn();
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack, getParent: () => undefined }) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const Icon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Feather: Icon, Ionicons: Icon };
});
jest.mock("../lib/haptics", () => {
  const noop = () => {};
  return { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop, haptics: { tap: noop, press: noop, select: noop, success: noop, warning: noop, error: noop } };
});

let financials: FinancialSummary | Error | "pending" = new Error("unset");
let onboard: { url: string } | Error = { url: "https://connect.stripe.test/setup" };
const calls: string[] = [];
jest.mock("../lib/query-client", () => ({
  apiRequest: async (method: string, route: string) => {
    calls.push(`${method} ${route}`);
    if (route === "/api/v1/me/connect/onboard") {
      if (onboard instanceof Error) throw onboard;
      const body = onboard;
      return { json: async () => body };
    }
    if (route !== "/api/v1/me/financials") throw new Error(`unexpected ${route}`);
    if (financials === "pending") return new Promise(() => {});
    if (financials instanceof Error) throw financials;
    const body = financials;
    return { json: async () => body };
  },
}));

const NOW = new Date("2026-10-08T12:00:00.000Z");
const NEW_ATHLETE: FinancialSummary = {
  version: "financials/0.1", hasMoney: false, currency: "usd", comingCents: 0, paidMonthCents: 0, paidYearCents: 0,
  payouts: { upcoming: [], paid: [] }, holds: [], refunds: { countYear: 0, cents: 0, items: [] },
  account: { state: "none", payoutsEnabled: false, detailsSubmitted: false, requirementsDue: 0 },
};
const line = (id: string, over: Partial<FinancialSummary["holds"][number]> = {}) => ({ id, source: "deal" as const, label: `Brand ${id}`, dealId: `deal-${id}`, bookingId: null, amountCents: 100_000, currency: "usd", at: null, ...over });
const ACTIVE: FinancialSummary = {
  version: "financials/0.1", hasMoney: true, currency: "usd", comingCents: 245_000, paidMonthCents: 120_000, paidYearCents: 490_000,
  payouts: {
    upcoming: [
      line("E", { amountCents: 180_000, stage: "awaiting_confirmation" }),
      line("bk", { source: "booking", label: "20-min video call", dealId: null, bookingId: "b1", amountCents: 65_000, stage: "after_booking" }),
    ],
    paid: [line("F", { amountCents: 120_000, at: "2026-10-03T10:00:00.000Z" })],
  },
  holds: [line("D", { amountCents: 5_000, at: "2026-10-07T00:00:00.000Z" })],
  refunds: { countYear: 1, cents: 30_000, items: [line("Z", { amountCents: 30_000, at: "2026-09-01T00:00:00.000Z" })] },
  account: { state: "active", payoutsEnabled: true, detailsSubmitted: true, requirementsDue: 0 },
};

function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}
const allText = () => texts(screen.toJSON()).join(" | ");
function renderFin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><FinancialsScreen now={NOW} /></QueryClientProvider>);
}

beforeEach(() => { navigate.mockReset(); goBack.mockReset(); calls.length = 0; onboard = { url: "https://connect.stripe.test/setup" }; });

describe("a new athlete", () => {
  beforeEach(() => { financials = NEW_ATHLETE; });

  it("$0, 'Nothing yet', no lists; the payout account 'Not set up' with her Set up payouts tap", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true as any);
    renderFin();
    await waitFor(() => expect(screen.getByTestId("financials-block")).toBeTruthy());
    const t = allText();
    expect(t).toContain("Coming to you");
    expect(t).toContain("$0");
    expect(t).toContain("Nothing yet");
    expect(t).toContain("Payouts, holds and refunds show here once a brand pays.");
    expect(screen.queryByTestId("financials-payouts")).toBeNull();
    expect(screen.queryByTestId("financials-holds")).toBeNull();
    expect(screen.queryByTestId("financials-refunds")).toBeNull();
    expect(t).toContain("Stripe · Not set up");
    await act(async () => { fireEvent.press(screen.getByText("Set up payouts")); });
    expect(calls).toContain("POST /api/v1/me/connect/onboard");
    expect(open).toHaveBeenCalledWith("https://connect.stripe.test/setup");
    open.mockRestore();
  });

  it("a setup link that fails says so", async () => {
    onboard = new Error("502: could not start onboarding");
    renderFin();
    await waitFor(() => expect(screen.getByText("Set up payouts")).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText("Set up payouts")); });
    expect(screen.getByText("Couldn't open payout setup. Try again.")).toBeTruthy();
  });
});

describe("an active athlete", () => {
  beforeEach(() => { financials = ACTIVE; });

  it("the block, payouts (upcoming then paid), holds, refunds, the account; deal rows open the deal; nothing spends", async () => {
    renderFin();
    await waitFor(() => expect(screen.getByTestId("financials-payouts")).toBeTruthy());
    const t = allText();
    expect(t).toContain("$2,450");
    expect(t).toContain("$1,200 paid in Oct · $4,900 this year");
    expect(t).toContain("Brand E");
    expect(t).toContain("Upcoming · after delivery is confirmed");
    expect(t).toContain("20-min video call");
    expect(t).toContain("Upcoming · after the booking");
    expect(t).toContain("Paid 3 Oct");
    expect(t).toContain("Refundable · returned to the brand if you decline");
    expect(t).toContain("1 this year");
    expect(t).toContain("Refunded 1 Sep");
    expect(t).toContain("Stripe · Payouts on");
    expect(screen.queryByText("Set up payouts")).toBeNull();
    expect(screen.queryByTestId("financials-empty")).toBeNull();
    for (const verb of ["Refund", "Release", "Pay", "Accept", "Decline"]) expect(screen.queryByText(verb)).toBeNull();
    fireEvent.press(screen.getByTestId("fin-row-E"));
    expect(navigate).toHaveBeenLastCalledWith("DealDetail", { dealId: "deal-E" });
    fireEvent.press(screen.getByTestId("fin-row-D"));
    expect(navigate).toHaveBeenLastCalledWith("DealDetail", { dealId: "deal-D" });
    navigate.mockReset();
    fireEvent.press(screen.getByTestId("fin-row-bk"));   // a booking: read-only until its detail exists
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText("Back"));
    expect(goBack).toHaveBeenCalled();
  });

  it("a payout account still finishing: 'Finishing setup' with what Stripe needs, and Continue setup", async () => {
    financials = { ...ACTIVE, account: { state: "pending", payoutsEnabled: false, detailsSubmitted: true, requirementsDue: 2 } };
    renderFin();
    await waitFor(() => expect(screen.getByText("Stripe · Finishing setup")).toBeTruthy());
    expect(screen.getByText("Stripe needs 2 more details before it can pay you.")).toBeTruthy();
    expect(screen.getByText("Continue setup")).toBeTruthy();
  });
});

describe("states", () => {
  it("loading", () => {
    financials = "pending";
    renderFin();
    expect(screen.getByTestId("financials-loading")).toBeTruthy();
  });

  it("error, then Try again reads it again", async () => {
    financials = new Error("500: boom");
    renderFin();
    await waitFor(() => expect(screen.getByText("Couldn't load your money.")).toBeTruthy());
    financials = ACTIVE;
    await act(async () => { fireEvent.press(screen.getByText("Try again")); });
    await waitFor(() => expect(screen.getByTestId("financials-payouts")).toBeTruthy());
  });
});
