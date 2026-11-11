/**
 * BookingsScreen.test — Opportunities › Bookings, rendered from the real typed responses (client/test/bookingFixtures,
 * built on shared/bookingsApi.ts). The hooks are replaced; the screen's own decisions are tested:
 *
 *   S1 loading, error, and "not on for you" (the summary 404 → null)
 *   S2 Requests: rows with what was checked and the deadline chip; a row opens the detail; empty → "See your offers"
 *   S3 Booked: upcoming then past; empty; an open group's time is ONE row (its per-fan spots hidden) that opens the
 *      group screen; a private group's row says how many people
 *   S4 Offers: the payout black block until Stripe can pay her (opens Stripe's own sign-up); "paused by Nomila";
 *      live / paused / drafts rows open the editor; New offer; the empty invite; the booking money card, and its
 *      Financials link only when that screen exists (no dead taps)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { BookingsScreen } from "./BookingsScreen";
import { groupItemFixture, listItemFixture, offerFixture, payoutsFixture, summaryFixture } from "../../test/bookingFixtures";

const navigate = jest.fn();
let routeNames: string[] = ["OpportunitiesList", "Bookings"];
let routeParams: any = undefined;
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames }) }),
  useRoute: () => ({ params: routeParams }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn(async () => ({ type: "opened" })) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q = (data: any, over: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, refetch: jest.fn(async () => ({})), ...over });
const hooks = {
  summary: q(summaryFixture()), requests: q([listItemFixture()]), upcoming: q([]), past: q([]), groupsUpcoming: q([]), groupsPast: q([]),
  offers: q([offerFixture()]), payouts: q(payoutsFixture()), startPayouts: { mutate: jest.fn(), isPending: false },
  act: jest.fn(),
};
jest.mock("../../hooks/use-bookings", () => ({
  useBookingsSummary: () => hooks.summary,
  useBookingList: (view: string) => (view === "requests" ? hooks.requests : view === "upcoming" ? hooks.upcoming : hooks.past),
  useOffers: () => hooks.offers,
  useBookingPayouts: () => hooks.payouts,
  useStartPayouts: () => hooks.startPayouts,
  useSlots: () => ({ data: [], isLoading: false }),
  useQuote: () => ({ data: { priceCents: 5000, serviceFeeCents: 953, buyerTotalCents: 5953, athleteReceivesCents: 5000, currency: "usd" } }),
  useSaveOffer: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useAddSlots: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useOfferAction: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBooking: () => ({ data: undefined, isLoading: true }),
  useBookingAction: () => ({ mutate: hooks.act, isPending: false }),
  useGroupSessions: (view: string) => (view === "upcoming" ? hooks.groupsUpcoming : hooks.groupsPast),
  bookingRefusal: () => null,
}));

beforeEach(() => {
  navigate.mockReset(); hooks.startPayouts.mutate.mockReset(); hooks.act.mockReset(); routeParams = undefined; routeNames = ["OpportunitiesList", "Bookings"];
  hooks.summary = q(summaryFixture()); hooks.requests = q([listItemFixture()]); hooks.upcoming = q([]); hooks.past = q([]);
  hooks.offers = q([offerFixture()]); hooks.payouts = q(payoutsFixture()); hooks.groupsUpcoming = q([]); hooks.groupsPast = q([]);
});

describe("S1 states", () => {
  it("loading, error, and off", () => {
    hooks.summary = q(undefined, { isLoading: true });
    const a = render(<BookingsScreen />);
    expect(screen.getByTestId("bookings-loading")).toBeTruthy();
    a.unmount();
    hooks.summary = q(undefined, { isError: true });
    const b = render(<BookingsScreen />);
    expect(screen.getByText("Couldn't load your bookings. Pull down to try again.")).toBeTruthy();
    b.unmount();
    hooks.summary = q(null);
    render(<BookingsScreen />);
    expect(screen.getByTestId("bookings-off")).toBeTruthy();
  });
});

describe("S2 Requests", () => {
  it("opens on Requests when something waits; the card shows what was checked, the deadline and only 'You get'", () => {
    render(<BookingsScreen />);
    expect(screen.getByTestId("tab-requests").props.accessibilityState.selected).toBe(true);
    expect(screen.getByText(/^Jordan wants a /)).toBeTruthy();
    expect(screen.getByText("Email ✓ · Phone ✓")).toBeTruthy();
    expect(screen.getByText(/h left$/)).toBeTruthy();
    expect(screen.getByText(/^You get \$/)).toBeTruthy();
    expect(screen.queryByText(/Fans see|pays \$/)).toBeNull();
  });
  it("Accept on the card: shows at once with Undo; the request only goes out when the window closes", () => {
    jest.useFakeTimers();
    render(<BookingsScreen />);
    fireEvent.press(screen.getByTestId("request-b1-accept"));
    expect(screen.getByTestId("bookings-toast")).toBeTruthy();
    expect(hooks.act).not.toHaveBeenCalled();
    jest.advanceTimersByTime(10_000);
    expect(hooks.act).toHaveBeenCalledWith(expect.objectContaining({ action: "accept" }), expect.anything());
    jest.useRealTimers();
  });
  it("Undo inside the window sends nothing", () => {
    jest.useFakeTimers();
    render(<BookingsScreen />);
    fireEvent.press(screen.getByTestId("request-b1-accept"));
    fireEvent.press(screen.getByTestId("bookings-toast-undo"));
    jest.advanceTimersByTime(10_000);
    expect(hooks.act).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
  it("Decline is a reason chip; Suggest a time offers three times and the chip sends", () => {
    jest.useFakeTimers();
    render(<BookingsScreen />);
    fireEvent.press(screen.getByTestId("request-b1-decline"));
    fireEvent.press(screen.getByTestId("request-b1-reason-time"));
    jest.advanceTimersByTime(10_000);
    expect(hooks.act).toHaveBeenCalledWith({ action: "decline", reason: "time" }, expect.anything());
    jest.useRealTimers();
  });
  it("empty: the invite to her offers", () => {
    hooks.summary = q(summaryFixture({ requests: 0 }));
    hooks.requests = q([]);
    routeParams = { tab: "requests" };
    render(<BookingsScreen />);
    expect(screen.getByText("No requests right now")).toBeTruthy();
    fireEvent.press(screen.getByTestId("requests-empty-action"));
    expect(screen.getByTestId("tab-offers").props.accessibilityState.selected).toBe(true);
  });
  it("a list that fails says so", () => {
    hooks.requests = q(undefined, { isError: true });
    render(<BookingsScreen />);
    expect(screen.getByTestId("bookings-error")).toBeTruthy();
  });
});

describe("S3 Booked", () => {
  it("upcoming, then past; empty says so", () => {
    hooks.summary = q(summaryFixture({ requests: 0 }));
    hooks.upcoming = q([listItemFixture({ id: "u1", phase: "booked", status: "confirmed" })]);
    hooks.past = q([listItemFixture({ id: "p1", phase: "paid", status: "released" })]);
    const a = render(<BookingsScreen />);
    expect(screen.getByTestId("tab-booked").props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId("booking-row-u1")).toBeTruthy();
    expect(screen.getByText("Paid to you")).toBeTruthy();
    fireEvent.press(screen.getByTestId("booking-row-p1"));
    expect(navigate).toHaveBeenCalledWith("BookingDetail", { bookingId: "p1" });
    a.unmount();
    hooks.upcoming = q([]); hooks.past = q([]);
    render(<BookingsScreen />);
    expect(screen.getByText("Nothing booked yet")).toBeTruthy();
  });

  it("an open group's time is one row (its spots hidden) that opens the group screen; a private group says how many people", () => {
    hooks.summary = q(summaryFixture({ requests: 0 }));
    hooks.upcoming = q([
      listItemFixture({ id: "spot1", phase: "booked", status: "confirmed", audience: "open_group", slotId: "slot1" }),
      listItemFixture({ id: "spot2", phase: "booked", status: "confirmed", audience: "open_group", slotId: "slot1" }),
      listItemFixture({ id: "pg1", phase: "booked", status: "confirmed", audience: "private_group", partySize: 3, title: "Video call" }),
    ]);
    hooks.groupsUpcoming = q([groupItemFixture()]);
    render(<BookingsScreen />);
    expect(screen.queryByTestId("booking-row-spot1")).toBeNull();
    expect(screen.queryByTestId("booking-row-spot2")).toBeNull();
    expect(screen.getByText(/^Group clinic · .* · 4 of 10 booked$/)).toBeTruthy();
    expect(screen.getByText("Jordan, Sam, Alex + 1 more")).toBeTruthy();
    expect(screen.getByText(/^Video call · 3 people · /)).toBeTruthy();
    fireEvent.press(screen.getByTestId("group-row-slot1"));
    expect(navigate).toHaveBeenCalledWith("BookingGroup", { slotId: "slot1" });
  });

  it("a past open-group time shows under Past", () => {
    hooks.summary = q(summaryFixture({ requests: 0 }));
    hooks.groupsPast = q([groupItemFixture({ slotId: "old", phase: "finished", startsAt: new Date(Date.now() - 86_400_000).toISOString() })]);
    render(<BookingsScreen />);
    expect(screen.getByText("Past")).toBeTruthy();
    expect(screen.getByTestId("group-row-old")).toBeTruthy();
  });
});

describe("S4 Offers", () => {
  it("payouts not set up: the black block opens Stripe's own sign-up; offers still open the editor", async () => {
    hooks.summary = q(summaryFixture({ payouts: { hasAccount: false, ready: false, requirementsDue: [] } }));
    routeParams = { tab: "offers" };
    hooks.startPayouts.mutate.mockImplementation((_v: unknown, o: any) => o.onSuccess({ url: "https://connect.stripe.test/x" }));
    render(<BookingsScreen />);
    fireEvent.press(screen.getByTestId("payout-setup-cta"));
    const { openBrowserAsync } = require("expo-web-browser");
    await waitFor(() => expect(openBrowserAsync).toHaveBeenCalledWith("https://connect.stripe.test/x"));
    fireEvent.press(screen.getByTestId("offer-row-o1"));
    expect(navigate).toHaveBeenCalledWith("BookingOffer", { offerId: "o1" });
    fireEvent.press(screen.getByTestId("offer-new"));
    expect(screen.getByTestId("session-setup")).toBeTruthy();
  });
  it("Stripe needs one more thing: names it in plain words", () => {
    hooks.summary = q(summaryFixture({ payouts: { hasAccount: true, ready: false, requirementsDue: ["external_account"] } }));
    routeParams = { tab: "offers" };
    render(<BookingsScreen />);
    expect(screen.getByText("Stripe still needs your bank account before it can send you money.")).toBeTruthy();
  });
  it("live / paused / drafts; paused by Nomila: no New offer, the support line", () => {
    hooks.offers = q([offerFixture(), offerFixture({ id: "o2", status: "paused", pausedReason: "no_show_review", title: "Clinic" }), offerFixture({ id: "o3", status: "draft", title: "Meet" })]);
    hooks.summary = q(summaryFixture({ pausedByNomila: true }));
    routeParams = { tab: "offers" };
    render(<BookingsScreen />);
    expect(screen.getByText("Live on your page")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Drafts")).toBeTruthy();
    expect(screen.getByTestId("offers-paused")).toBeTruthy();
    expect(screen.queryByTestId("offer-new")).toBeNull();
    expect(screen.queryByTestId("payout-setup")).toBeNull();
  });
  it("empty: the 'Sell your time' invite", () => {
    hooks.offers = q([]);
    hooks.summary = q(summaryFixture({ offers: { published: 0, draft: 0, paused: 0 }, requests: 0 }));
    render(<BookingsScreen />);
    expect(screen.getByTestId("tab-offers").props.accessibilityState.selected).toBe(true);
    expect(screen.getByText("Sell your time")).toBeTruthy();
  });
  it("the booking money card; its Financials link only once Financials exists", () => {
    routeParams = { tab: "offers" };
    const a = render(<BookingsScreen />);
    expect(screen.getByTestId("payouts-coming").props.children).toBe("$150");
    expect(screen.getByText(/\$150 − \$5\.31 card fee/)).toBeTruthy();
    expect(screen.getByText("Taken from a payout")).toBeTruthy();
    expect(screen.queryByTestId("payouts-financials")).toBeNull();
    a.unmount();
    routeNames = ["OpportunitiesList", "Bookings", "Financials"];
    render(<BookingsScreen />);
    fireEvent.press(screen.getByTestId("payouts-financials"));
    expect(navigate).toHaveBeenCalledWith("Financials");
  });
  it("Blocked fans (0154): a door from Your sessions, only where the screen is registered", () => {
    routeParams = { tab: "offers" };
    const a = render(<BookingsScreen />);
    expect(screen.queryByTestId("blocked-fans-door")).toBeNull();
    a.unmount();
    routeNames = ["OpportunitiesList", "Bookings", "BookingBlocks"];
    render(<BookingsScreen />);
    fireEvent.press(screen.getByTestId("blocked-fans-door"));
    expect(navigate).toHaveBeenCalledWith("BookingBlocks");
  });
  it("offers that fail to load say so", () => {
    hooks.offers = q(undefined, { isError: true });
    routeParams = { tab: "offers" };
    render(<BookingsScreen />);
    expect(screen.getByTestId("offers-error")).toBeTruthy();
  });
});
