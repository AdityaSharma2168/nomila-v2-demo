/**
 * BookingAfterSessionScreen.test — the after-session taps render from a real AthleteSessionView and do what they say:
 *   A1 loading, error + retry
 *   A2 Session done is shown only when allowed and calls its route; a refusal shows a short line
 *   A3 Buyer didn't show: a confirm step, then the route; Cancel backs out
 *   A4 Report a problem: a category is required, then the route with her words; the sent receipt replaces the form
 *   A5 in person: I'm OK, and the share sheet with the check-in link
 *   A6 nothing she can't do is on screen (paid / report open)
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { Share } from "react-native";
import type { AthleteSessionView } from "../../lib/bookingSessionLogic";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
const nav = { navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn() };
jest.mock("@react-navigation/native", () => ({ useNavigation: () => nav, useRoute: () => ({ params: { bookingId: "b1" } }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q: { data: AthleteSessionView | undefined; isError: boolean; error: unknown; refetch: jest.Mock } = { data: undefined, isError: false, error: null, refetch: jest.fn() };
const m = () => ({ mutate: jest.fn(), isPending: false, data: undefined as any });
const muts = { done: m(), noShow: m(), report: m(), checkIn: m() };
jest.mock("../../hooks/use-booking-session", () => ({
  useBookingSession: () => q,
  useSessionDone: () => muts.done,
  useBuyerNoShow: () => muts.noShow,
  useReportProblem: () => muts.report,
  useCheckIn: () => muts.checkIn,
}));

import { BookingAfterSessionScreen } from "./BookingAfterSessionScreen";

const view = (over: { video?: Partial<AthleteSessionView["video"]>; after?: Partial<AthleteSessionView["after"]>; safety?: Partial<AthleteSessionView["safety"]>; status?: string; locationMode?: "virtual" | "in_person" } = {}): AthleteSessionView => ({
  booking: { id: "b1", title: "Video call", format: "video_call", locationMode: over.locationMode ?? "virtual", status: over.status ?? "in_review", startsAt: "2026-10-12T20:00:00Z",
    endsAt: "2026-10-12T20:30:00Z", durationMinutes: 30, priceCents: 15000, currency: "usd", buyerName: "Jordan P.", venue: over.locationMode === "in_person" ? "Lakeside Courts" : null },
  video: { mode: "livekit", joinOpensAt: null, joinClosesAt: null, joinState: "closed", fallbackLink: null, recorded: false, ...over.video },
  attendance: { athleteJoined: true, buyerJoined: true, buyerInRoom: false },
  after: { sessionDoneAt: null, buyerConfirmedAt: null, releaseDueAt: "2026-10-14T20:30:00Z", releasedAt: null, noShowBy: null, reportOpen: false,
    canMarkSessionDone: true, canMarkBuyerNoShow: true, buyerNoShowFrom: "2026-10-12T20:15:00Z", canReport: true, ...over.after },
  safety: { inPerson: false, checkedInAt: null, canCheckIn: false, checkinUrl: null, ...over.safety },
  supportEmail: "support@nomila.co", serverNow: "2026-10-12T20:40:00Z",
});

beforeEach(() => {
  q.data = undefined; q.isError = false; q.error = null;
  for (const k of Object.keys(muts) as (keyof typeof muts)[]) { muts[k].mutate.mockReset(); muts[k].data = undefined; }
});

describe("A1 loading and error", () => {
  it("spinner, then error + retry", () => {
    const a = render(<BookingAfterSessionScreen />);
    expect(screen.getByTestId("after-loading")).toBeTruthy();
    a.unmount();
    q.isError = true; q.error = new Error("500: oops");
    render(<BookingAfterSessionScreen />);
    fireEvent.press(screen.getByTestId("after-retry"));
    expect(q.refetch).toHaveBeenCalled();
  });
});

describe("A2 Session done", () => {
  it("calls the route; a refusal shows a short line", () => {
    q.data = view();
    render(<BookingAfterSessionScreen />);
    expect(screen.getByTestId("after-title").props.children).toBe("How did it go?");
    fireEvent.press(screen.getByTestId("session-done"));
    expect(muts.done.mutate).toHaveBeenCalledTimes(1);
    const { onError } = muts.done.mutate.mock.calls[0][1];
    // the error line is set through React state; trigger it and re-read
    act(() => onError(new Error('409: {"error":"too_early"}')));
    expect(screen.getByTestId("after-tap-error").props.children).toBe("That isn't available yet.");
  });
});

describe("A3 Buyer didn't show", () => {
  it("asks first, then marks; Cancel backs out", () => {
    q.data = view();
    render(<BookingAfterSessionScreen />);
    fireEvent.press(screen.getByTestId("buyer-no-show"));
    expect(screen.getByTestId("no-show-confirm")).toBeTruthy();
    fireEvent.press(screen.getByTestId("no-show-cancel"));
    expect(screen.queryByTestId("no-show-confirm")).toBeNull();
    fireEvent.press(screen.getByTestId("buyer-no-show"));
    fireEvent.press(screen.getByTestId("no-show-mark"));
    expect(muts.noShow.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("A4 Report a problem", () => {
  it("needs a category, then sends her words", () => {
    q.data = view();
    render(<BookingAfterSessionScreen />);
    fireEvent.press(screen.getByTestId("open-report"));
    const send = screen.getByTestId("report-send");
    expect(send.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId("report-harassment"));
    fireEvent.changeText(screen.getByTestId("report-details"), "  Abusive in the call ");
    fireEvent.press(screen.getByTestId("report-send"));
    expect(muts.report.mutate.mock.calls[0][0]).toEqual({ category: "harassment", details: "Abusive in the call" });
  });
  it("after sending, the receipt replaces the form", () => {
    q.data = view();
    muts.report.data = { reportId: "r1", supportNotified: true, moneyHeld: true, replyBy: "2026-10-13T20:40:00Z" };
    render(<BookingAfterSessionScreen />);
    expect(screen.getByTestId("report-sent")).toBeTruthy();
    expect(screen.queryByTestId("open-report")).toBeNull();
  });
});

describe("A5 in person", () => {
  it("I'm OK calls the route; Share opens the share sheet with the check-in link", () => {
    const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" } as any);
    q.data = view({ locationMode: "in_person", video: { mode: "none" }, safety: { inPerson: true, canCheckIn: true, checkinUrl: "https://book.test/ok/abc.def" } });
    render(<BookingAfterSessionScreen />);
    fireEvent.press(screen.getByTestId("checkin"));
    expect(muts.checkIn.mutate).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId("share-session"));
    expect(share.mock.calls[0][0].message).toContain("https://book.test/ok/abc.def");
    expect(share.mock.calls[0][0].message).toContain("Lakeside Courts");
  });
});

describe("A6 nothing she can't do", () => {
  it("paid: no taps but the support line", () => {
    q.data = view({ status: "released", after: { releasedAt: "2026-10-13T00:00:00Z", canMarkSessionDone: false, canMarkBuyerNoShow: false, canReport: true } });
    render(<BookingAfterSessionScreen />);
    expect(screen.getByTestId("after-title").props.children).toBe("Paid");
    for (const id of ["session-done", "buyer-no-show", "rejoin", "checkin"]) expect(screen.queryByTestId(id)).toBeNull();
  });
  it("report open: on hold, no second report", () => {
    q.data = view({ status: "issue_reported", after: { reportOpen: true, canMarkSessionDone: false, canMarkBuyerNoShow: false } });
    render(<BookingAfterSessionScreen />);
    expect(screen.getByTestId("after-title").props.children).toBe("On hold");
    expect(screen.queryByTestId("open-report")).toBeNull();
  });
  it("rejoin only while the window is open", () => {
    q.data = view({ video: { joinState: "open" } });
    render(<BookingAfterSessionScreen />);
    fireEvent.press(screen.getByTestId("rejoin"));
    expect(nav.replace).toHaveBeenCalledWith("BookingSession", { bookingId: "b1" });
  });
});

describe("A7 no false no-show (0154)", () => {
  it("no attendance evidence: the neutral line, never 'didn't join'; with evidence, no line", () => {
    q.data = { ...view(), attendance: { athleteJoined: false, buyerJoined: false, buyerInRoom: false, known: false, buyerTappedJoin: false } };
    const a = render(<BookingAfterSessionScreen />);
    expect(screen.getByTestId("attendance-unknown").props.children).toBe("We couldn't confirm attendance for this call.");
    expect(screen.queryByText(/didn't join/)).toBeNull();
    fireEvent.press(screen.getByTestId("buyer-no-show"));
    expect(screen.getByTestId("no-show-attendance-unknown").props.children).toMatch(/^We couldn't confirm attendance for this call\. Mark this only if you waited/);
    a.unmount();
    q.data = { ...view(), attendance: { athleteJoined: true, buyerJoined: false, buyerInRoom: false, known: true } };
    render(<BookingAfterSessionScreen />);
    expect(screen.queryByTestId("attendance-unknown")).toBeNull();
  });
  it("before the grace is over the line waits; an older server (no known flag) never shows it", () => {
    q.data = { ...view({ after: { buyerNoShowFrom: "2026-10-12T20:50:00Z" } }), attendance: { athleteJoined: false, buyerJoined: false, buyerInRoom: false, known: false } };
    const a = render(<BookingAfterSessionScreen />);
    expect(screen.queryByTestId("attendance-unknown")).toBeNull();
    a.unmount();
    q.data = view();
    render(<BookingAfterSessionScreen />);
    expect(screen.queryByTestId("attendance-unknown")).toBeNull();
  });
});
