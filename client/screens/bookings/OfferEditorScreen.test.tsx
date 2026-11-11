/**
 * OfferEditorScreen.test — the offer editor from the real typed responses. Hooks replaced; the screen's decisions:
 *
 *   E1 states: loading an offer, a load error, the summary missing
 *   E2 a new offer: Publish waits for a title, a price in range and her "I'm 18 or older"; the server's quote shows as
 *      "You receive $150 · buyers pay $177.96"; out of range says so; the quote failing says so
 *   E3 Publish is HER tap on a confirm sheet (You receive / Buyers pay incl. the Nomila service fee) → save, then publish
 *      with her attestation; an error stays on the sheet; Save draft saves without publishing
 *   E4 in person: Publish waits for the place AND the "not my home" tick; ID check is locked on
 *   E5 payouts not set up: the black block, and Publish stays grey
 *   E6 an existing live offer: "…" → pause (a confirm sheet); delete is its own confirm; times open the times screen
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { OfferEditorScreen } from "./OfferEditorScreen";
import { offerFixture, summaryFixture } from "../../test/bookingFixtures";

const navigate = jest.fn();
const goBack = jest.fn();
let routeParams: any = { offerId: null };
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate, goBack, getParent: () => undefined, getState: () => ({ routeNames: [] }) }),
  useRoute: () => ({ params: routeParams }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn() }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q = (data: any, over: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, refetch: jest.fn(), ...over });
const quoteOf = (cents: number | null) => (cents === 15_000 ? { priceCents: 15_000, serviceFeeCents: 2_796, buyerTotalCents: 17_796, athleteReceivesCents: 15_000, currency: "usd" } : undefined);
const hooks = {
  summary: q(summaryFixture()), offer: q(undefined), quoteError: false,
  save: { mutateAsync: jest.fn(async () => ({ offer: offerFixture({ id: "new1", status: "draft" }) })), isPending: false },
  action: { mutateAsync: jest.fn(async () => ({ offer: offerFixture() })), isPending: false },
  start: { mutate: jest.fn(), isPending: false },
};
jest.mock("../../hooks/use-bookings", () => ({
  useBookingsSummary: () => hooks.summary,
  useOffer: (id: string | null) => (id ? hooks.offer : q(undefined)),
  useQuote: (cents: number | null) => q(hooks.quoteError ? undefined : quoteOf(cents), { isError: hooks.quoteError && cents !== null }),
  useSaveOffer: () => hooks.save,
  useOfferAction: () => hooks.action,
  useStartPayouts: () => hooks.start,
  bookingRefusal: (err: any) => { const m = /^(\d{3}): (.*)$/.exec(err?.message ?? ""); return m ? { status: Number(m[1]), ...JSON.parse(m[2]) } : null; },
}));

beforeEach(() => {
  jest.useFakeTimers();
  navigate.mockReset(); goBack.mockReset(); hooks.save.mutateAsync.mockClear(); hooks.action.mutateAsync.mockClear();
  routeParams = { offerId: null }; hooks.summary = q(summaryFixture()); hooks.offer = q(undefined); hooks.quoteError = false;
});
afterEach(() => { jest.useRealTimers(); });

const type = (id: string, text: string) => fireEvent.changeText(screen.getByTestId(`field-${id}`), text);
const settle = () => act(() => { jest.advanceTimersByTime(400); });

describe("E1 states", () => {
  it("loading an offer, a load error, no summary", () => {
    routeParams = { offerId: "o1" };
    hooks.offer = q(undefined, { isLoading: true });
    const a = render(<OfferEditorScreen />);
    expect(screen.getByTestId("offer-loading")).toBeTruthy();
    a.unmount();
    hooks.offer = q(undefined, { isError: true });
    const b = render(<OfferEditorScreen />);
    expect(screen.getByTestId("offer-error")).toBeTruthy();
    b.unmount();
    routeParams = { offerId: null };
    hooks.summary = q(null);
    render(<OfferEditorScreen />);
    expect(screen.getByTestId("offer-error")).toBeTruthy();
  });
});

describe("E2 + E3 a new offer", () => {
  it("Publish waits; the quote line; publish is her tap on a confirm sheet", async () => {
    render(<OfferEditorScreen />);
    expect(screen.getByTestId("offer-publish").props.accessibilityState.disabled).toBe(true);
    type("title", "1:1 video call");
    type("price", "10");
    settle();
    expect(screen.getByTestId("price-range").props.children.join("")).toBe("Between $25 and $5,000.");
    type("price", "150");
    settle();
    expect(screen.getByTestId("receive-line").props.children).toBe("You receive $150 · buyers pay $177.96");
    expect(screen.getByTestId("offer-publish").props.accessibilityState.disabled).toBe(false);
    fireEvent.press(screen.getByTestId("offer-publish"));
    expect(screen.getByText("Publish this offer?")).toBeTruthy();
    expect(screen.getByText("includes $27.96 Nomila service fee")).toBeTruthy();
    expect(screen.getByText("$177.96")).toBeTruthy();
    expect(hooks.save.mutateAsync).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(screen.getByTestId("publish-sheet-confirm")); });
    expect(hooks.save.mutateAsync).toHaveBeenCalledWith({ id: null, draft: expect.objectContaining({ title: "1:1 video call", price_cents: 15_000, location_mode: "virtual", format: "video_call", free_cancel_hours: 24, duration_minutes: 30 }) });
    expect(hooks.action.mutateAsync).toHaveBeenCalledWith({ id: "new1", action: "publish" });
    expect(goBack).toHaveBeenCalled();
  });

  it("a refused publish keeps the sheet open with the reason; Save draft saves only", async () => {
    hooks.action.mutateAsync.mockRejectedValueOnce(new Error('409: {"error":"set up payouts first","code":"CONNECT_REQUIRED"}'));
    render(<OfferEditorScreen />);
    type("title", "Call"); type("price", "150"); settle();
    fireEvent.press(screen.getByTestId("offer-publish"));
    await act(async () => { fireEvent.press(screen.getByTestId("publish-sheet-confirm")); });
    expect(screen.getByTestId("publish-sheet-error").props.children).toBe("Set up payouts first");
    expect(goBack).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("publish-sheet-back"));
    await act(async () => { fireEvent.press(screen.getByTestId("offer-save")); });
    expect(screen.getByTestId("editor-line").props.children).toBe("Saved as a draft.");
  });

  it("the quote failing says so (Publish waits)", () => {
    hooks.quoteError = true;
    render(<OfferEditorScreen />);
    type("title", "Call"); type("price", "150"); settle();
    expect(screen.getByTestId("quote-error")).toBeTruthy();
    expect(screen.getByTestId("offer-publish").props.accessibilityState.disabled).toBe(true);
  });
});

describe("E4 in person", () => {
  it("needs the place and the 'not my home' tick; ID check is locked on", async () => {
    render(<OfferEditorScreen />);
    fireEvent.press(screen.getByTestId("kind-in_person"));
    type("title", "Shooting clinic"); type("price", "150"); settle();
    expect(screen.getByTestId("rule-id").props.accessibilityState).toEqual({ checked: true, disabled: true });
    expect(screen.getByTestId("offer-publish").props.accessibilityState.disabled).toBe(true);
    type("venue", "Lakeside Courts");
    expect(screen.getByTestId("offer-publish").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId("venue-ok"));
    expect(screen.getByTestId("offer-publish").props.accessibilityState.disabled).toBe(false);
    fireEvent.press(screen.getByTestId("offer-publish"));
    await act(async () => { fireEvent.press(screen.getByTestId("publish-sheet-confirm")); });
    expect((hooks.save.mutateAsync.mock.calls[0] as any[])[0].draft).toMatchObject({ location_mode: "in_person", format: "clinic", venue: "Lakeside Courts", venue_confirmed: true, require_id_verification: true });
  });
});

describe("E5 payouts not set up", () => {
  it("the black block; Publish stays grey", () => {
    hooks.summary = q(summaryFixture({ payouts: { hasAccount: false, ready: false, requirementsDue: [] } }));
    render(<OfferEditorScreen />);
    type("title", "Call"); type("price", "150"); settle();
    expect(screen.getByTestId("editor-payouts")).toBeTruthy();
    expect(screen.getByTestId("offer-publish").props.accessibilityState.disabled).toBe(true);
  });
});

describe("E7 who it's for (group sessions)", () => {
  it("an open group: per-person price, only set times, and the save sends audience + max_people", async () => {
    render(<OfferEditorScreen />);
    expect(screen.queryByTestId("people-10")).toBeNull();
    fireEvent.press(screen.getByTestId("audience-open_group"));
    expect(screen.getByTestId("people-10").props.accessibilityState.selected).toBe(true);
    fireEvent.press(screen.getByTestId("people-12"));
    expect(screen.queryByTestId("scheduling-request")).toBeNull();
    expect(screen.getByTestId("scheduling-slots").props.accessibilityState.selected).toBe(true);
    type("title", "Group clinic"); type("price", "150"); settle();
    expect(screen.getByTestId("receive-line").props.children).toBe("You receive $150 · buyers pay $177.96 per person");
    expect(screen.getByTestId("receive-max").props.children.join("")).toBe("Up to $1,800 per session.");
    await act(async () => { fireEvent.press(screen.getByTestId("offer-save")); });
    expect(hooks.save.mutateAsync).toHaveBeenCalledWith({ id: null, draft: expect.objectContaining({ audience: "open_group", max_people: 12, scheduling_mode: "slots" }) });
  });

  it("approve each spot (0154): only for an open group, off by default; on is saved, and opens on for an offer that has it", async () => {
    const a = render(<OfferEditorScreen />);
    expect(screen.queryByTestId("rule-approve-spots")).toBeNull();
    fireEvent.press(screen.getByTestId("audience-private_group"));
    expect(screen.queryByTestId("rule-approve-spots")).toBeNull();
    fireEvent.press(screen.getByTestId("audience-open_group"));
    expect(screen.getByTestId("rule-approve-spots").props.accessibilityState.checked).toBe(false);
    fireEvent.press(screen.getByTestId("rule-approve-spots"));
    expect(screen.getByTestId("rule-approve-spots").props.accessibilityState.checked).toBe(true);
    expect(screen.getByText(/You approve each spot, like a request\./)).toBeTruthy();
    type("title", "Group clinic"); type("price", "150"); settle();
    await act(async () => { fireEvent.press(screen.getByTestId("offer-save")); });
    expect(hooks.save.mutateAsync).toHaveBeenCalledWith({ id: null, draft: expect.objectContaining({ audience: "open_group", approve_each_spot: true }) });
    a.unmount();
    routeParams = { offerId: "o1" };
    hooks.offer = q(offerFixture({ audience: "open_group", maxPeople: 8, approveEachSpot: true }));
    render(<OfferEditorScreen />);
    expect(screen.getByTestId("rule-approve-spots").props.accessibilityState.checked).toBe(true);
    fireEvent.press(screen.getByTestId("audience-private_group"));
    await act(async () => { fireEvent.press(screen.getByTestId("offer-save")); });
    expect(hooks.save.mutateAsync).toHaveBeenLastCalledWith({ id: "o1", draft: expect.objectContaining({ audience: "private_group", approve_each_spot: false }) });
  });

  it("an existing private group opens with its size; back to just one fan sends max_people 1", async () => {
    routeParams = { offerId: "o1" };
    hooks.offer = q(offerFixture({ audience: "private_group", maxPeople: 7 }));
    render(<OfferEditorScreen />);
    expect(screen.getByTestId("audience-private_group").props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId("people-7").props.accessibilityState.selected).toBe(true);
    fireEvent.press(screen.getByTestId("audience-one"));
    expect(screen.queryByTestId("people-7")).toBeNull();
    await act(async () => { fireEvent.press(screen.getByTestId("offer-save")); });
    expect(hooks.save.mutateAsync).toHaveBeenCalledWith({ id: "o1", draft: expect.objectContaining({ audience: "one", max_people: 1 }) });
  });
});

describe("E6 an existing live offer", () => {
  it("shows her saved choices; '…' pauses on a confirm sheet; delete is its own confirm; times open", async () => {
    routeParams = { offerId: "o1" };
    hooks.offer = q(offerFixture());
    render(<OfferEditorScreen />);
    expect(screen.getByText("Live on your card. Changes apply to new requests only.")).toBeTruthy();
    expect(screen.queryByTestId("adult")).toBeNull();   // no age tick (owner, 22 Oct)
    fireEvent.press(screen.getByTestId("offer-times"));
    expect(navigate).toHaveBeenCalledWith("BookingTimes", { offerId: "o1" });
    fireEvent.press(screen.getByTestId("offer-menu"));
    await act(async () => { fireEvent.press(screen.getByTestId("menu-sheet-confirm")); });
    expect(hooks.action.mutateAsync).toHaveBeenCalledWith({ id: "o1", action: "pause" });
    fireEvent.press(screen.getByTestId("offer-menu"));
    fireEvent.press(screen.getByTestId("menu-delete"));
    expect(screen.getByText("Delete this offer?")).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId("delete-sheet-confirm")); });
    expect(hooks.action.mutateAsync).toHaveBeenLastCalledWith({ id: "o1", action: "delete" });
    expect(goBack).toHaveBeenCalled();
  });
});
