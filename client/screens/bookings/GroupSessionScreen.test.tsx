/**
 * GroupSessionScreen.test — one open-group time with its people, from the real typed response (hooks replaced):
 *
 *   GS1 loading and error
 *   GS2 the time: spots booked and left, each fan's first name and state (in the call / booked); a fan opens their own
 *       booking; what she receives
 *   GS3 Join only when the server says so and the call screen exists (no dead taps); it opens the call on this time
 *   GS4 cancel: the preview ("2 people get a full refund of $50") and her card fee before she confirms; nothing is sent
 *       until she taps; a refusal stays on the sheet in the server's words
 *   GS5 Session done: a confirm sheet, then the group route
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { GroupSessionScreen } from "./GroupSessionScreen";
import { groupFixture } from "../../test/bookingFixtures";

const navigate = jest.fn();
let routeNames: string[] = ["OpportunitiesList", "BookingGroup"];
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames }) }),
  useRoute: () => ({ params: { slotId: "slot1" } }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn() }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q = (data: any, over: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, refetch: jest.fn(async () => ({})), ...over });
const hooks = {
  group: q(groupFixture()),
  preview: q({ bookings: 2, people: 2, pending: 1, buyerRefundCents: 5_000, firstCancelFree: false, estCardFeeCents: 190 }),
  action: { mutate: jest.fn(), isPending: false },
};
const blocking = { preview: q(undefined) as any, fan: { mutate: jest.fn(), isPending: false }, args: null as any, target: null as any };
jest.mock("../../hooks/use-bookings", () => ({
  useBlockPreview: (target: unknown, identity: unknown) => { blocking.args = { target, identity }; return blocking.preview; },
  useBlockFan: (target: unknown) => { blocking.target = target; return blocking.fan; },
  useGroupSession: () => hooks.group,
  useGroupCancelPreview: () => hooks.preview,
  useGroupAction: () => hooks.action,
  useStartPayouts: () => ({ mutate: jest.fn(), isPending: false }),
  bookingRefusal: (err: any) => { const m = /^(\d{3}): (.*)$/.exec(err?.message ?? ""); return m ? { status: Number(m[1]), ...JSON.parse(m[2]) } : null; },
}));

beforeEach(() => {
  navigate.mockReset(); hooks.action.mutate.mockReset(); routeNames = ["OpportunitiesList", "BookingGroup"];
  hooks.group = q(groupFixture());
  hooks.preview = q({ bookings: 2, people: 2, pending: 1, buyerRefundCents: 5_000, firstCancelFree: false, estCardFeeCents: 190 });
});

describe("GS1 states", () => {
  it("loading and error", () => {
    hooks.group = q(undefined, { isLoading: true });
    const a = render(<GroupSessionScreen />);
    expect(screen.getByTestId("group-loading")).toBeTruthy();
    a.unmount();
    hooks.group = q(undefined, { isError: true });
    render(<GroupSessionScreen />);
    expect(screen.getByTestId("group-error")).toBeTruthy();
  });
});

describe("GS2 the time and its people", () => {
  it("spots, first names and states; a fan opens their own booking; what she receives", () => {
    render(<GroupSessionScreen />);
    expect(screen.getByText("Group clinic · 60 min")).toBeTruthy();
    expect(screen.getByTestId("group-spots").props.children.join("")).toBe("4 of 10 booked · 6 spots left");
    expect(screen.getByText("Jordan")).toBeTruthy();
    expect(screen.getByText("In the call")).toBeTruthy();
    expect(screen.getByText("Booked")).toBeTruthy();
    expect(screen.getByText("$100")).toBeTruthy();
    fireEvent.press(screen.getByTestId("group-person-gb2"));
    expect(navigate).toHaveBeenCalledWith("BookingDetail", { bookingId: "gb2" });
  });
});

describe("GS3 join", () => {
  it("only when the server opens it and the call screen exists; it opens the call on this time", () => {
    const a = render(<GroupSessionScreen />);
    expect(screen.queryByTestId("group-join")).toBeNull();
    a.unmount();
    hooks.group = q(groupFixture({ actions: { join: true, cancel: false, sessionDone: false, removeParticipant: true } }));
    const b = render(<GroupSessionScreen />);
    expect(screen.queryByTestId("group-join")).toBeNull();
    b.unmount();
    routeNames = ["OpportunitiesList", "BookingGroup", "BookingSession"];
    render(<GroupSessionScreen />);
    fireEvent.press(screen.getByTestId("group-join"));
    expect(navigate).toHaveBeenCalledWith("BookingSession", { slotId: "slot1" });
  });
});

describe("GS4 cancel this time", () => {
  it("previews the refunds and her card fee; nothing is sent until she confirms", () => {
    render(<GroupSessionScreen />);
    fireEvent.press(screen.getByTestId("group-cancel-door"));
    expect(screen.getByText("Cancel this time?")).toBeTruthy();
    expect(screen.getByTestId("group-cancel-refund").props.children)
      .toBe("2 people get a full refund of $50. 1 person still checking out has their card hold released. We'll let everyone know.");
    expect(screen.getByTestId("group-cancel-fee")).toBeTruthy();
    expect(hooks.action.mutate).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByTestId("group-cancel-reason"), "  Injured, sorry  ");
    hooks.action.mutate.mockImplementation((_v: unknown, o: any) => o.onSuccess({ canceled: 2, released: 1, refundedCents: 5_000, group: groupFixture({ phase: "canceled" }) }));
    fireEvent.press(screen.getByTestId("group-cancel-sheet-confirm"));
    expect(hooks.action.mutate).toHaveBeenCalledWith({ action: "cancel", reason: "Injured, sorry" }, expect.anything());
    expect(screen.getByTestId("group-flash").props.children).toBe("Cancelled. 2 people get a full refund.");
  });
  it("her first cancellation is on us; a refusal stays on the sheet", () => {
    hooks.preview = q({ bookings: 1, people: 1, pending: 0, buyerRefundCents: 2_500, firstCancelFree: true, estCardFeeCents: 95 });
    render(<GroupSessionScreen />);
    fireEvent.press(screen.getByTestId("group-cancel-door"));
    expect(screen.getByText("This one's on us")).toBeTruthy();
    expect(screen.queryByTestId("group-cancel-fee")).toBeNull();
    hooks.action.mutate.mockImplementation((_v: unknown, o: any) => o.onError(new Error("409: {\"error\":\"it has already started\"}")));
    fireEvent.press(screen.getByTestId("group-cancel-sheet-confirm"));
    expect(screen.getByTestId("group-cancel-sheet-error").props.children).toBe("It has already started");
  });
  it("no cancel door when the server says it can't be cancelled", () => {
    hooks.group = q(groupFixture({ actions: { join: false, cancel: false, sessionDone: false, removeParticipant: false } }));
    render(<GroupSessionScreen />);
    expect(screen.queryByTestId("group-cancel-door")).toBeNull();
  });
});

describe("GS6 block an attendee (0154)", () => {
  it("Block on a fan's row → the confirm sheet (their spot refunded) → block that fan's booking; a blocked fan says so", () => {
    blocking.fan.mutate.mockReset();
    blocking.preview = q({ firstName: "Sam", role: "buyer", alreadyBlocked: false, pendingRequests: 0,
      cancels: [{ bookingId: "gb2", title: "Group clinic", startsAt: "2026-11-20T18:00:00Z", refundCents: 2_976 }] });
    render(<GroupSessionScreen />);
    fireEvent.press(screen.getByTestId("group-block-gb2"));
    expect(navigate).not.toHaveBeenCalled();   // Block isn't the row's "open their booking"
    expect(blocking.args).toEqual({ target: { bookingId: "gb2" }, identity: null });
    expect(screen.getByText("Block Sam?")).toBeTruthy();
    expect(screen.getByText(/is cancelled and Sam gets a full refund of \$29\.76\./)).toBeTruthy();
    blocking.fan.mutate.mockImplementation((_v: unknown, o: any) => o.onSuccess({ block: {}, canceled: 1, refundedCents: 2_976, requestsEnded: 0, removedFromCall: true }));
    fireEvent.press(screen.getByTestId("block-sheet-confirm"));
    expect(blocking.fan.mutate).toHaveBeenCalledWith({ identity: null, reason: undefined }, expect.anything());
    expect(screen.getByTestId("group-flash").props.children).toBe("Sam is blocked. Their spot is cancelled and refunded.");
  });
  it("a blocked attendee shows Blocked instead of the button", () => {
    const g = groupFixture();
    hooks.group = q({ ...g, attendees: [{ ...g.attendees[0], blocked: true }, g.attendees[1]] });
    render(<GroupSessionScreen />);
    expect(screen.getByTestId("group-blocked-gb1")).toBeTruthy();
    expect(screen.queryByTestId("group-block-gb1")).toBeNull();
    expect(screen.getByTestId("group-block-gb2")).toBeTruthy();
  });
});

describe("GS5 session done", () => {
  it("a confirm sheet, then the group route", () => {
    hooks.group = q(groupFixture({ phase: "happening", actions: { join: false, cancel: false, sessionDone: true, removeParticipant: false } }));
    render(<GroupSessionScreen />);
    fireEvent.press(screen.getByTestId("group-done"));
    expect(hooks.action.mutate).not.toHaveBeenCalled();
    hooks.action.mutate.mockImplementation((_v: unknown, o: any) => o.onSuccess({ group: groupFixture() }));
    fireEvent.press(screen.getByTestId("group-done-sheet-confirm"));
    expect(hooks.action.mutate).toHaveBeenCalledWith({ action: "session_done" }, expect.anything());
    expect(screen.getByTestId("group-flash").props.children).toBe("Done. We've asked everyone to confirm.");
  });
});
