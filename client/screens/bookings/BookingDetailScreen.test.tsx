/**
 * BookingDetailScreen.test — one request / booking, from the real typed responses (hooks replaced):
 *
 *   D1 loading and error
 *   D2 a request: what we checked, their message, what she receives ("their card is held; charged only if you accept");
 *      Accept and Decline both open confirm sheets — nothing is sent until she confirms
 *   D3 accept: request mode makes her pick one of their times; "Accept and charge" sends the time + backup link; a
 *      Stripe hiccup reads "Couldn't accept. Nothing was sent. Try again."; a lapsed hold says a pay link went out
 *   D4 decline (her reason stays hers; "Something felt off" shows the support line); propose 1–3 times
 *   D5 booked: Join and the after-session door appear only when the session PR's screens exist (no dead taps); cancel
 *      previews the full refund and her card fee (first one free) before she confirms
 *   D6 money: paid (minus a card fee), on hold; the thread: messages, a held one says why, sending
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { BookingDetailScreen } from "./BookingDetailScreen";
import { detailFixture, inHours, messageFixture } from "../../test/bookingFixtures";

const navigate = jest.fn();
let routeNames: string[] = ["OpportunitiesList", "BookingDetail"];
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames }) }),
  useRoute: () => ({ params: { bookingId: "b1" } }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn() }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q = (data: any, over: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, refetch: jest.fn(async () => ({})), ...over });
const hooks = {
  booking: q(detailFixture()), thread: q([messageFixture()]),
  action: { mutate: jest.fn(), isPending: false }, post: { mutate: jest.fn(), isPending: false },
  preview: q({ buyerRefundCents: 17_796, firstCancelFree: true, estCardFeeCents: 0 }),
};
const blocking = { preview: q(undefined) as any, fan: { mutate: jest.fn(), isPending: false }, args: null as any, target: null as any };
jest.mock("../../hooks/use-bookings", () => ({
  useBooking: () => hooks.booking,
  useBookingThread: () => hooks.thread,
  useBookingAction: () => hooks.action,
  usePostMessage: () => hooks.post,
  useCancelPreview: () => hooks.preview,
  useBlockPreview: (target: unknown, identity: unknown) => { blocking.args = { target, identity }; return blocking.preview; },
  useBlockFan: (target: unknown) => { blocking.target = target; return blocking.fan; },
  useStartPayouts: () => ({ mutate: jest.fn(), isPending: false }),
  bookingRefusal: (err: any) => { const m = /^(\d{3}): (.*)$/.exec(err?.message ?? ""); return m ? { status: Number(m[1]), ...JSON.parse(m[2]) } : null; },
}));

beforeEach(() => {
  navigate.mockReset(); hooks.action.mutate.mockReset(); hooks.post.mutate.mockReset(); routeNames = ["OpportunitiesList", "BookingDetail"];
  hooks.booking = q(detailFixture()); hooks.thread = q([messageFixture()]);
  hooks.preview = q({ buyerRefundCents: 17_796, firstCancelFree: true, estCardFeeCents: 0 });
});

describe("D1 states", () => {
  it("loading and error", () => {
    hooks.booking = q(undefined, { isLoading: true });
    const a = render(<BookingDetailScreen />);
    expect(screen.getByTestId("booking-loading")).toBeTruthy();
    a.unmount();
    hooks.booking = q(undefined, { isError: true });
    render(<BookingDetailScreen />);
    expect(screen.getByText("Couldn't load this booking. Pull down to try again.")).toBeTruthy();
  });
});

describe("D2 a request", () => {
  it("shows the facts and sends nothing until she confirms", () => {
    render(<BookingDetailScreen />);
    expect(screen.getByTestId("detail-eyebrow").props.children.join("")).toMatch(/^Request · reply by /);
    expect(screen.getByText("Email code confirmed")).toBeTruthy();
    expect(screen.getByText("Phone code confirmed")).toBeTruthy();
    expect(screen.getByText("Said they're 18 or older")).toBeTruthy();
    expect(screen.getByText("Video call, no ID needed")).toBeTruthy();
    expect(screen.getByTestId("buyer-message").props.children.join("")).toContain("How did you handle recruiting?");
    expect(screen.getByText("Their card is held. It's charged only if you accept.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("accept"));
    expect(screen.getByText("Accept Jordan's request?")).toBeTruthy();
    expect(hooks.action.mutate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("accept-sheet-back"));
    fireEvent.press(screen.getByTestId("decline"));
    expect(screen.getByText("Decline this request?")).toBeTruthy();
    expect(hooks.action.mutate).not.toHaveBeenCalled();
  });
});

describe("D3 accept", () => {
  it("request mode: pick one of their times, then accept and charge with the backup link", () => {
    const times = [{ start: inHours(50), tz: null }, { start: inHours(74), tz: null }];
    hooks.booking = q(detailFixture({ startsAt: null, endsAt: null, proposedTimes: times }));
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("accept"));
    fireEvent.press(screen.getByTestId("accept-sheet-confirm"));
    expect(screen.getByTestId("accept-sheet-error").props.children).toBe("Pick one of the times first.");
    fireEvent.press(screen.getByTestId(`pick-${times[1].start}`));
    fireEvent.changeText(screen.getByTestId("accept-link"), "https://meet.example.com/abc");
    fireEvent.press(screen.getByTestId("accept-sheet-confirm"));
    expect(hooks.action.mutate.mock.calls[0][0]).toEqual({ action: "accept", start: times[1].start, backupLink: "https://meet.example.com/abc" });
    act(() => { hooks.action.mutate.mock.calls[0][1].onSuccess({ result: "confirmed", booking: detailFixture() }); });
    expect(screen.getByTestId("detail-flash").props.children).toBe("Accepted. We've emailed Jordan.");
  });
  it("Stripe didn't answer: nothing was sent; a lapsed hold: a pay link went out", () => {
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("accept"));
    fireEvent.press(screen.getByTestId("accept-sheet-confirm"));
    act(() => { hooks.action.mutate.mock.calls[0][1].onError(new Error('502: {"error":"Couldn\'t accept. Nothing was sent. Try again.","code":"CAPTURE_RETRY"}')); });
    expect(screen.getByTestId("accept-sheet-error").props.children).toBe("Couldn't accept. Nothing was sent. Try again.");
    fireEvent.press(screen.getByTestId("accept-sheet-confirm"));
    act(() => { hooks.action.mutate.mock.calls[1][1].onSuccess({ result: "waiting_payment", booking: detailFixture() }); });
    expect(screen.getByTestId("detail-flash").props.children).toBe("Accepted. Jordan's hold had ended, so we sent them a link to pay.");
  });
});

describe("D4 decline + propose", () => {
  it("decline: her reason stays hers; 'Something felt off' shows the support line", () => {
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("decline"));
    fireEvent.press(screen.getByTestId("reason-felt_off"));
    expect(screen.getByTestId("felt-off").props.children.join("")).toContain("support@nomila.co");
    fireEvent.press(screen.getByTestId("decline-sheet-confirm"));
    expect(hooks.action.mutate.mock.calls[0][0]).toEqual({ action: "decline", reason: "felt_off" });
    act(() => { hooks.action.mutate.mock.calls[0][1].onSuccess({ booking: detailFixture({ phase: "declined" }) }); });
    expect(screen.getByTestId("detail-flash").props.children).toBe("Declined. We've let Jordan know.");
  });
  it("propose: up to 3 times, sent on confirm", () => {
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("propose"));
    fireEvent.press(screen.getByTestId("propose-sheet-confirm"));
    expect(screen.getByTestId("propose-sheet-error").props.children).toBe("Pick at least one time.");
    fireEvent.press(screen.getByTestId("propose-time-600"));
    fireEvent.press(screen.getByTestId("propose-day-1"));
    fireEvent.press(screen.getByTestId("propose-time-960"));
    fireEvent.press(screen.getByTestId("propose-sheet-confirm"));
    const sent = hooks.action.mutate.mock.calls[0][0];
    expect(sent.action).toBe("propose");
    expect(sent.times).toHaveLength(2);
  });
});

describe("D5 booked", () => {
  const booked = (over = {}) => detailFixture({
    status: "confirmed", phase: "booked", startsAt: inHours(30), endsAt: inHours(30.5),
    actions: { accept: false, decline: false, propose: false, cancel: true, noShow: false, noShowAt: inHours(30.25), sessionDone: false, message: true, block: true },
    payout: { receiveCents: 15_000, state: "held", releaseDueAt: null, paidAt: null, cardFeeCents: 0 }, ...over,
  });
  it("Join and the after-session door only when the session screens exist", () => {
    hooks.booking = q(booked());
    const a = render(<BookingDetailScreen />);
    expect(screen.getByTestId("session-block")).toBeTruthy();
    expect(screen.queryByTestId("join")).toBeNull();
    a.unmount();
    routeNames = ["OpportunitiesList", "BookingDetail", "BookingSession", "BookingAfter"];
    hooks.booking = q(booked({ phase: "happening", actions: { accept: false, decline: false, propose: false, cancel: false, noShow: true, noShowAt: inHours(-0.1), sessionDone: true, message: true } }));
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("join"));
    expect(navigate).toHaveBeenCalledWith("BookingSession", { bookingId: "b1" });
    fireEvent.press(screen.getByTestId("after-session"));
    expect(navigate).toHaveBeenCalledWith("BookingAfter", { bookingId: "b1" });
  });
  it("cancel: the preview first (full refund, first one free), then her confirm with her reason", () => {
    hooks.booking = q(booked());
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("cancel-door"));
    expect(screen.getByTestId("cancel-refund").props.children.join("")).toBe("Jordan gets a full refund of $177.96. We'll let them know.");
    expect(screen.getByText("This one's on us")).toBeTruthy();
    fireEvent.changeText(screen.getByTestId("cancel-reason"), "Called into practice.");
    fireEvent.press(screen.getByTestId("cancel-sheet-confirm"));
    expect(hooks.action.mutate.mock.calls[0][0]).toEqual({ action: "cancel", reason: "Called into practice." });
  });
  it("cancel, not her first: the card fee estimate", () => {
    hooks.booking = q(booked());
    hooks.preview = q({ buyerRefundCents: 17_796, firstCancelFree: false, estCardFeeCents: 546 });
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("cancel-door"));
    expect(screen.getByTestId("cancel-fee").props.children.join("")).toBe("The card fee (about $5.46) comes out of your next payout.");
  });
});

describe("D6 money + the thread", () => {
  it("paid (minus a card fee); on hold", () => {
    hooks.booking = q(detailFixture({ status: "released", phase: "paid", actions: { accept: false, decline: false, propose: false, cancel: false, noShow: false, noShowAt: null, sessionDone: false, message: true, block: true }, payout: { receiveCents: 15_000, state: "paid", releaseDueAt: null, paidAt: inHours(-5), cardFeeCents: 531 } }));
    const a = render(<BookingDetailScreen />);
    expect(screen.getByText("$144.69")).toBeTruthy();
    a.unmount();
    hooks.booking = q(detailFixture({ status: "issue_reported", phase: "on_hold", actions: { accept: false, decline: false, propose: false, cancel: false, noShow: false, noShowAt: null, sessionDone: false, message: true, block: true }, payout: { receiveCents: 15_000, state: "on_hold", releaseDueAt: null, paidAt: null, cardFeeCents: 0 } }));
    render(<BookingDetailScreen />);
    expect(screen.getByText("On hold. A person at Nomila is looking at a report. We'll email you.")).toBeTruthy();
  });
  it("messages, a held one says why, and sending", () => {
    hooks.thread = q([messageFixture(), messageFixture({ id: "m2", from: "you", body: "text me 512 555 0100", held: true, heldReason: "contact_details" })]);
    render(<BookingDetailScreen />);
    expect(screen.getByText("Thanks so much!")).toBeTruthy();
    expect(screen.getByText("Not delivered. It included contact details.")).toBeTruthy();
    expect(screen.getByText("Messages go through Nomila. Jordan doesn't see your email or phone.")).toBeTruthy();
    fireEvent.changeText(screen.getByTestId("thread-input"), "See you then!");
    fireEvent.press(screen.getByTestId("thread-send"));
    expect(hooks.post.mutate.mock.calls[0][0]).toBe("See you then!");
  });
  it("an empty thread and a failing one", () => {
    hooks.thread = q([]);
    const a = render(<BookingDetailScreen />);
    expect(screen.getByTestId("thread-empty")).toBeTruthy();
    a.unmount();
    hooks.thread = q(undefined, { isError: true });
    render(<BookingDetailScreen />);
    expect(screen.getByTestId("thread-error")).toBeTruthy();
  });
});

describe("D7 a private group (a fan + friends)", () => {
  it("says how many people and the friends' first names, and how many more can be invited", () => {
    hooks.booking = q(detailFixture({ phase: "booked", status: "confirmed", audience: "private_group", partySize: 4, guests: [{ name: "Sam Lee" }, { name: null }] }));
    render(<BookingDetailScreen />);
    expect(screen.getByTestId("party-size").props.children).toBe("4 people");
    expect(screen.getByTestId("party-names").props.children).toBe("Jordan, Sam, A friend");
    expect(screen.getByText(/^Jordan can still invite 1 friend\./)).toBeTruthy();
    expect(screen.getByText(/· 4 people/)).toBeTruthy();
  });
  it("a 1:1 shows no party block", () => {
    hooks.booking = q(detailFixture({ phase: "booked", status: "confirmed" }));
    render(<BookingDetailScreen />);
    expect(screen.queryByTestId("party-block")).toBeNull();
  });
});

describe("D8 block (0154)", () => {
  beforeEach(() => { blocking.fan.mutate.mockReset(); blocking.args = null; blocking.target = null; blocking.preview = q(undefined); });

  it("Block opens a confirm sheet that says the upcoming booking is cancelled and refunded; nothing is sent until she confirms", () => {
    hooks.booking = q(detailFixture({ phase: "booked", status: "confirmed" }));
    blocking.preview = q({ firstName: "Jordan", role: "buyer", alreadyBlocked: false, pendingRequests: 1,
      cancels: [{ bookingId: "b1", title: "1:1 video call", startsAt: "2026-11-20T18:00:00Z", refundCents: 17_796 }] });
    render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("block-door"));
    expect(blocking.args).toEqual({ target: { bookingId: "b1" }, identity: null });
    expect(screen.getByText("Block Jordan?")).toBeTruthy();
    expect(screen.getByText(/is cancelled and Jordan gets a full refund of \$177\.96\./)).toBeTruthy();
    expect(screen.getByText("Their request waiting on you is declined.")).toBeTruthy();
    expect(screen.getByText(/card fee comes out of your next payout/)).toBeTruthy();
    expect(screen.queryByText("Jordan leaves this call now.")).toBeNull();
    expect(blocking.fan.mutate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("block-sheet-back"));
    expect(blocking.fan.mutate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("block-door"));
    fireEvent.changeText(screen.getByTestId("block-sheet-reason"), "kept messaging after");
    blocking.fan.mutate.mockImplementation((_v: unknown, o: any) => o.onSuccess({ block: {}, canceled: 1, refundedCents: 17_796, requestsEnded: 1, removedFromCall: true }));
    fireEvent.press(screen.getByTestId("block-sheet-confirm"));
    expect(blocking.fan.mutate).toHaveBeenCalledWith({ identity: null, reason: "kept messaging after" }, expect.anything());
    expect(blocking.target).toEqual({ bookingId: "b1" });
    expect(screen.getByTestId("detail-flash").props.children).toBe("Jordan is blocked. Their upcoming booking is cancelled and refunded.");
  });

  it("a refusal stays on the sheet; a blocked booker shows a quiet line and no Block door", () => {
    hooks.booking = q(detailFixture({ phase: "paid", status: "released" }));
    blocking.preview = q({ firstName: "Jordan", role: "buyer", alreadyBlocked: false, pendingRequests: 0, cancels: [] });
    const a = render(<BookingDetailScreen />);
    fireEvent.press(screen.getByTestId("block-door"));
    expect(screen.getByTestId("block-sheet-confirm")).toBeTruthy();
    blocking.fan.mutate.mockImplementation((_v: unknown, o: any) => o.onError(new Error("409: {\"error\":\"this booking has changed — pull to refresh\"}")));
    fireEvent.press(screen.getByTestId("block-sheet-confirm"));
    expect(screen.getByTestId("block-sheet-error").props.children).toBe("This booking has changed — pull to refresh");
    a.unmount();
    hooks.booking = q(detailFixture({ phase: "paid", status: "released", fanBlocked: true, actions: { ...detailFixture().actions, block: false } }));
    render(<BookingDetailScreen />);
    expect(screen.queryByTestId("block-door")).toBeNull();
    expect(screen.getByTestId("detail-blocked").props.children).toBe("You blocked Jordan. Unblock them from Your sessions › Blocked fans.");
  });
});
