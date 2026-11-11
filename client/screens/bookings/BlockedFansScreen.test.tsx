/**
 * BlockedFansScreen.test — her Blocked fans (0154), from the real typed response (hooks replaced):
 *   B1 loading, error, empty
 *   B2 each row: first name, where and when, her note; "Open the booking" opens it
 *   B3 Unblock is a confirm sheet; nothing is sent until she confirms; then a line says so; a refusal stays on the sheet
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { BlockedFansScreen } from "./BlockedFansScreen";
import type { FanBlockView } from "../../lib/bookingsTypes";

const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames: [] }) }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn() }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q = (data: any, over: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, refetch: jest.fn(async () => ({})), ...over });
const rows: FanBlockView[] = [
  { id: "k1", firstName: "Jordan", source: "booking", bookingId: "b1", reason: "kept messaging", blockedAt: "2026-11-02T18:00:00Z" },
  { id: "k2", firstName: "Sam", source: "guest", bookingId: null, reason: null, blockedAt: "2026-11-01T18:00:00Z" },
];
const hooks = { blocks: q(rows) as any, unblock: { mutate: jest.fn(), isPending: false } };
jest.mock("../../hooks/use-bookings", () => ({
  useFanBlocks: () => hooks.blocks,
  useUnblockFan: () => hooks.unblock,
  useStartPayouts: () => ({ mutate: jest.fn(), isPending: false }),
  bookingRefusal: (err: any) => { const m = /^(\d{3}): (.*)$/.exec(err?.message ?? ""); return m ? { status: Number(m[1]), ...JSON.parse(m[2]) } : null; },
}));

beforeEach(() => { navigate.mockReset(); hooks.unblock.mutate.mockReset(); hooks.blocks = q(rows); });

describe("B1 states", () => {
  it("loading, error, empty", () => {
    hooks.blocks = q(undefined, { isLoading: true });
    const a = render(<BlockedFansScreen />);
    expect(screen.getByTestId("blocks-loading")).toBeTruthy();
    a.unmount();
    hooks.blocks = q(undefined, { isError: true });
    const b = render(<BlockedFansScreen />);
    expect(screen.getByTestId("blocks-error")).toBeTruthy();
    b.unmount();
    hooks.blocks = q([]);
    render(<BlockedFansScreen />);
    expect(screen.getByTestId("blocks-empty")).toBeTruthy();
  });
});

describe("B2 the list", () => {
  it("first name, where, her note; the booking opens", () => {
    render(<BlockedFansScreen />);
    expect(screen.getByText("Jordan")).toBeTruthy();
    expect(screen.getByText(/^From a booking · .* · “kept messaging”$/)).toBeTruthy();
    expect(screen.getByText(/^A friend in a group call · /)).toBeTruthy();
    fireEvent.press(screen.getByTestId("block-booking-k1"));
    expect(navigate).toHaveBeenCalledWith("BookingDetail", { bookingId: "b1" });
    expect(screen.queryByTestId("block-booking-k2")).toBeNull();
  });
});

describe("B3 unblock", () => {
  it("a confirm sheet; then the unblock route with that block; a refusal stays on the sheet", () => {
    render(<BlockedFansScreen />);
    fireEvent.press(screen.getByTestId("unblock-k1"));
    expect(screen.getByText("Unblock Jordan?")).toBeTruthy();
    expect(hooks.unblock.mutate).not.toHaveBeenCalled();
    hooks.unblock.mutate.mockImplementationOnce((_v: unknown, o: any) => o.onError(new Error("404: {\"error\":\"not found\"}")));
    fireEvent.press(screen.getByTestId("unblock-sheet-confirm"));
    expect(screen.getByTestId("unblock-sheet-error").props.children).toBe("Not found");
    hooks.unblock.mutate.mockImplementationOnce((_v: unknown, o: any) => o.onSuccess({ blocks: [rows[1]] }));
    fireEvent.press(screen.getByTestId("unblock-sheet-confirm"));
    expect(hooks.unblock.mutate).toHaveBeenLastCalledWith("k1", expect.anything());
    expect(screen.getByTestId("blocks-flash").props.children).toBe("Jordan is unblocked.");
  });
});
