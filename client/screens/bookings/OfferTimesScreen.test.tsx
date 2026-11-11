/**
 * OfferTimesScreen.test — her times for a slots offer, from the real typed responses (hooks replaced):
 *
 *   T1 loading, error, empty
 *   T2 her times: a held time can't be removed (it says someone asked for it); a free one can
 *   T3 adding: pick a day and a start time → one ISO start sent; the server's refusals in plain words
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { OfferTimesScreen } from "./OfferTimesScreen";
import { offerFixture, slotFixture, inHours } from "../../test/bookingFixtures";
import { dayOptions, startIso } from "../../lib/bookingsLogic";

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useRoute: () => ({ params: { offerId: "o1" } }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn() }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q = (data: any, over: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, refetch: jest.fn(), ...over });
const hooks = { offer: q(offerFixture()), slots: q([slotFixture()]), add: { mutate: jest.fn(), isPending: false }, withdraw: { mutate: jest.fn(), isPending: false } };
jest.mock("../../hooks/use-bookings", () => ({
  useOffer: () => hooks.offer,
  useSlots: () => hooks.slots,
  useAddSlots: () => hooks.add,
  useWithdrawSlot: () => hooks.withdraw,
  bookingRefusal: () => null,
}));

const NOW = new Date(2026, 9, 8, 12);
beforeEach(() => { hooks.add.mutate.mockReset(); hooks.withdraw.mutate.mockReset(); hooks.slots = q([slotFixture()]); });

describe("T1 states", () => {
  it("loading, error, empty", () => {
    hooks.slots = q(undefined, { isLoading: true });
    const a = render(<OfferTimesScreen now={NOW} />);
    expect(screen.getByTestId("times-loading")).toBeTruthy();
    a.unmount();
    hooks.slots = q(undefined, { isError: true });
    const b = render(<OfferTimesScreen now={NOW} />);
    expect(screen.getByTestId("times-error")).toBeTruthy();
    b.unmount();
    hooks.slots = q([]);
    render(<OfferTimesScreen now={NOW} />);
    expect(screen.getByText("No times yet")).toBeTruthy();
  });
});

describe("T2 her times", () => {
  it("a held time can't be removed; a free one can", () => {
    hooks.slots = q([slotFixture(), slotFixture({ id: "s2", startsAt: inHours(50), endsAt: inHours(50.5), taken: true })]);
    render(<OfferTimesScreen now={NOW} />);
    expect(screen.getByText("Someone asked for this time")).toBeTruthy();
    expect(screen.queryByTestId("slot-remove-s2")).toBeNull();
    fireEvent.press(screen.getByTestId("slot-remove-s1"));
    expect(hooks.withdraw.mutate.mock.calls[0][0]).toEqual({ offerId: "o1", slotId: "s1" });
  });
});

describe("T3 adding", () => {
  it("a day and a start time → one ISO start; a refusal in plain words", () => {
    render(<OfferTimesScreen now={NOW} />);
    expect(screen.getByTestId("times-add").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId("day-2"));
    fireEvent.press(screen.getByTestId("time-990"));   // 4:30 pm
    fireEvent.press(screen.getByTestId("times-add"));
    const want = startIso(dayOptions(NOW, 30)[2].date, 990);
    expect(hooks.add.mutate.mock.calls[0][0]).toEqual({ offerId: "o1", starts: [want] });
    act(() => { hooks.add.mutate.mock.calls[0][1].onError(new Error('400: {"error":"x","code":"INVALID","detail":[{"field":"starts","problem":"overlap"}]}')); });
    expect(screen.getByTestId("times-line").props.children).toBe("That overlaps one of your other times.");
    act(() => { hooks.add.mutate.mock.calls[0][1].onSuccess(); });
    expect(screen.getByTestId("times-line").props.children).toBe("Added. Buyers can ask for it now.");
  });
});
