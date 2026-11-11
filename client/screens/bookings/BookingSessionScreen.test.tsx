/**
 * BookingSessionScreen.test — her call screen renders from a real AthleteSessionView, through every state:
 *   C1 loading, error + retry
 *   C2 before: Join grey until the window opens; Join starts the call; the backup link opens her link
 *   C3 permission denied: Open Settings + Try again
 *   C4 the call: waiting / reconnecting / the other side left / the +15 no-show hint; mute · camera · flip · leave;
 *      the other person shown whole (contain), her own PiP filled (cover) and mirrored only on the front camera
 *   C5 leaving lands on the after-session screen
 *   C6 web (unsupported): no dead Join, the backup link instead
 *   G1 a private group: every other person is a tile with their call name; the ⋯ (or a long-press) → confirm → the
 *      remove route gets their identity; a 1:1 stays the one full-bleed view, no grid, no remove
 *   G2 an open group's time ({ slotId }): read from the group view, tiles named from its attendees (fans join as "Fan"),
 *      leaving goes back to the group screen
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { Linking } from "react-native";
import type { AthleteSessionView } from "../../lib/bookingSessionLogic";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
const nav = { navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn() };
let routeParams: any = { bookingId: "b1" };
jest.mock("@react-navigation/native", () => ({ useNavigation: () => nav, useRoute: () => ({ params: routeParams }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const videos: any[] = [];
jest.mock("../../components/bookings/CallVideo", () => ({ CallVideo: (p: any) => { videos.push(p); return null; } }));

const q: { data: AthleteSessionView | undefined; isError: boolean; error: unknown; refetch: jest.Mock } = { data: undefined, isError: false, error: null, refetch: jest.fn() };
const remove = { mutate: jest.fn(), isPending: false, target: null as any };
const mute = { mutate: jest.fn(), isPending: false, target: null as any };
jest.mock("../../hooks/use-booking-session", () => ({
  useBookingSession: () => q,
  useRemoveParticipant: (target: unknown) => { remove.target = target; return remove; },
  useMuteParticipant: (target: unknown) => { mute.target = target; return mute; },
}));
const g: { data: any; isError: boolean; error: unknown; refetch: jest.Mock } = { data: undefined, isError: false, error: null, refetch: jest.fn() };
const blockPreview = { data: undefined as any, isLoading: false, isError: false, args: null as any };
const block = { mutate: jest.fn(), isPending: false, target: null as any };
jest.mock("../../hooks/use-bookings", () => ({
  useBlockPreview: (target: unknown, identity: unknown) => { blockPreview.args = { target, identity }; return blockPreview; },
  useBlockFan: (target: unknown) => { block.target = target; return block; },
  useGroupSession: (slotId: string | null) => (slotId ? g : { data: undefined, isError: false, error: null, refetch: jest.fn() }),
  bookingRefusal: () => null,
  useStartPayouts: () => ({ mutate: jest.fn(), isPending: false }),
}));
const actions = { join: jest.fn(async () => {}), toggleMic: jest.fn(async () => {}), toggleCam: jest.fn(async () => {}), flip: jest.fn(async () => {}), leave: jest.fn(async () => {}), start: jest.fn() };
const base = { status: "idle", localVideo: null, remoteVideo: null, remoteJoined: false, remotes: [] as any[], remoteLeft: false, micOn: true, camOn: true, facing: "user", error: null };
let callState: any = { ...base };
jest.mock("../../hooks/use-booking-call", () => ({ useBookingCall: () => ({ call: callState, actions }) }));

import { BookingSessionScreen } from "./BookingSessionScreen";
import { groupFixture } from "../../test/bookingFixtures";

const view = (over: { booking?: Partial<AthleteSessionView["booking"]>; video?: Partial<AthleteSessionView["video"]>; after?: Partial<AthleteSessionView["after"]>; attendance?: Partial<AthleteSessionView["attendance"]> } = {}): AthleteSessionView => ({
  booking: { id: "b1", title: "Video call", format: "video_call", locationMode: "virtual", status: "confirmed", startsAt: "2026-10-12T20:00:00Z",
    endsAt: "2099-10-12T20:30:00Z", durationMinutes: 30, priceCents: 15000, currency: "usd", buyerName: "Jordan P.", venue: null, ...over.booking },
  video: { mode: "livekit", joinOpensAt: "2026-10-12T19:50:00Z", joinClosesAt: "2026-10-12T21:00:00Z", joinState: "open", fallbackLink: "https://meet.example.com/abc", recorded: false, ...over.video },
  attendance: { athleteJoined: false, buyerJoined: false, buyerInRoom: false, ...over.attendance },
  after: { sessionDoneAt: null, buyerConfirmedAt: null, releaseDueAt: null, releasedAt: null, noShowBy: null, reportOpen: false,
    canMarkSessionDone: false, canMarkBuyerNoShow: false, buyerNoShowFrom: null, canReport: true, ...over.after },
  safety: { inPerson: false, checkedInAt: null, canCheckIn: false, checkinUrl: null },
  supportEmail: "support@nomila.co", serverNow: "2026-10-12T19:55:00Z",
});

beforeEach(() => {
  q.data = undefined; q.isError = false; q.error = null; q.refetch.mockReset();
  callState = { ...base };
  Object.values(actions).forEach((f) => (f as jest.Mock).mockClear());
  nav.replace.mockReset(); nav.goBack.mockReset();
  videos.length = 0;
  routeParams = { bookingId: "b1" };
  g.data = undefined; g.isError = false;
  remove.mutate.mockReset(); remove.target = null;
  mute.mutate.mockReset(); mute.target = null;
  block.mutate.mockReset(); block.target = null;
  blockPreview.data = undefined; blockPreview.args = null;
});

describe("C1 loading and error", () => {
  it("shows a spinner, then an error line with a working retry", () => {
    const a = render(<BookingSessionScreen />);
    expect(screen.getByTestId("session-loading")).toBeTruthy();
    a.unmount();
    q.isError = true; q.error = new Error("404: {\"error\":\"not_found\"}");
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("session-error").props.children).toBe("This booking couldn't be found.");
    fireEvent.press(screen.getByTestId("session-retry"));
    expect(q.refetch).toHaveBeenCalled();
  });
});

describe("C2 before the call", () => {
  it("Join is grey until the window opens, and says when", () => {
    q.data = view({ video: { joinState: "not_yet_open" } });
    render(<BookingSessionScreen />);
    const join = screen.getByTestId("join-call");
    expect(join.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(join);
    expect(actions.join).not.toHaveBeenCalled();
    expect(screen.getByText(/^Join opens at /)).toBeTruthy();
  });
  it("inside the window Join starts the call; the backup link opens her link; Not recorded is stated", () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true as any);
    q.data = view();
    render(<BookingSessionScreen />);
    expect(screen.getByText("Nomila doesn't record calls.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("join-call"));
    expect(actions.join).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId("backup-link"));
    expect(open).toHaveBeenCalledWith("https://meet.example.com/abc");
  });
  it("a closed call has no Join button, only a line", () => {
    q.data = view({ video: { joinState: "closed", fallbackLink: null } });
    render(<BookingSessionScreen />);
    expect(screen.queryByTestId("join-call")).toBeNull();
    expect(screen.getByTestId("join-unavailable")).toBeTruthy();
  });
});

describe("C3 permission denied", () => {
  it("Open Settings and Try again both work", () => {
    const settings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined as any);
    q.data = view();
    callState = { ...base, status: "permission_denied" };
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("permission-denied")).toBeTruthy();
    expect(screen.queryByTestId("join-call")).toBeNull();
    fireEvent.press(screen.getByTestId("open-settings"));
    expect(settings).toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("permission-retry"));
    expect(actions.join).toHaveBeenCalled();
  });
});

describe("C4 the call", () => {
  it("waiting, then the controls do what they say", () => {
    q.data = view();
    callState = { ...base, status: "waiting" };
    render(<BookingSessionScreen />);
    expect(screen.getByText("Waiting for Jordan P.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("call-mic"));
    fireEvent.press(screen.getByTestId("call-cam"));
    fireEvent.press(screen.getByTestId("call-flip"));
    fireEvent.press(screen.getByTestId("call-leave"));
    expect(actions.toggleMic).toHaveBeenCalled();
    expect(actions.toggleCam).toHaveBeenCalled();
    expect(actions.flip).toHaveBeenCalled();
    expect(actions.leave).toHaveBeenCalled();
  });
  it("reconnecting, the other side left, and the +15 hint", () => {
    q.data = view({ after: { canMarkBuyerNoShow: true } });
    callState = { ...base, status: "reconnecting", remoteLeft: true };
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("call-reconnecting")).toBeTruthy();
    expect(screen.getByTestId("call-remote-left").props.children).toMatch(/^Jordan P\. left the call\. They can rejoin until /);
    expect(screen.getByTestId("call-noshow-hint")).toBeTruthy();
  });
  it("while connecting, mute / camera / flip are disabled (no dead taps) but Leave works", () => {
    q.data = view();
    callState = { ...base, status: "connecting" };
    render(<BookingSessionScreen />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    fireEvent.press(screen.getByTestId("call-mic"));
    expect(actions.toggleMic).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("call-leave"));
    expect(actions.leave).toHaveBeenCalled();
  });  it("the other person is shown whole (contain); her own PiP fills its tile (cover), mirrored on the front camera only", () => {
    q.data = view();
    const remote = { id: "remote" }, local = { id: "local" };
    callState = { ...base, status: "in_call", remoteJoined: true, remoteVideo: remote, localVideo: local };
    const a = render(<BookingSessionScreen />);
    const last = (t: unknown) => [...videos].reverse().find((p) => p.track === t);
    expect(last(remote).fit).toBe("contain");
    expect(last(local).fit).toBe("cover");
    expect(last(local).mirror).toBe(true);
    a.unmount();
    callState = { ...callState, facing: "environment" };
    render(<BookingSessionScreen />);
    expect(last(local).mirror).toBe(false);
  });
});

describe("C5 after leaving", () => {
  it("goes to the after-session screen for this booking", () => {
    q.data = view();
    callState = { ...base, status: "ended" };
    render(<BookingSessionScreen />);
    expect(nav.replace).toHaveBeenCalledWith("BookingAfter", { bookingId: "b1" });
  });
});

describe("C6 unsupported (web)", () => {
  it("says to join from the phone and keeps the backup link; no Join", () => {
    q.data = view();
    callState = { ...base, status: "unsupported" };
    render(<BookingSessionScreen />);
    expect(screen.getByText("Join the call from the Nomila app on your phone.")).toBeTruthy();
    expect(screen.queryByTestId("join-call")).toBeNull();
    expect(screen.getByTestId("backup-link")).toBeTruthy();
  });
});

describe("G1 a private group's call", () => {
  const tiles = [
    { identity: "b_jordan", name: "Jordan", video: { id: "v1" } },
    { identity: "g_sam", name: "Sam", video: { id: "v2" } },
    { identity: "g_alex", name: "Alex Rivera", video: null },
  ];
  const participants = [
    { identity: "b_jordan", firstName: "Jordan", role: "buyer" as const, removed: false },
    { identity: "g_sam", firstName: "Sam", role: "guest" as const, removed: false },
    { identity: "g_alex", firstName: "Alex", role: "guest" as const, removed: false },
  ];
  const privateView = (removeParticipant = true, people = participants): AthleteSessionView =>
    ({ ...view({ booking: { audience: "private_group", partySize: 3 } }), participants: people, actions: { removeParticipant } });
  it("every other person is a named tile, drawn whole", () => {
    q.data = privateView();
    callState = { ...base, status: "in_call", remoteJoined: true, remoteVideo: tiles[0].video, remotes: tiles };
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("call-grid")).toBeTruthy();
    for (const t of tiles) expect(screen.getByTestId(`call-tile-${t.identity}`)).toBeTruthy();
    expect(screen.getByTestId("call-tile-name-g_alex").props.children).toBe("Alex");
    expect(videos.filter((p) => p.track === tiles[0].video || p.track === tiles[1].video).every((p) => p.fit === "contain")).toBe(true);
  });
  it("⋯ → Remove from call → confirm → the remove route gets that identity; Keep them sends nothing", () => {
    q.data = privateView();
    callState = { ...base, status: "in_call", remoteJoined: true, remotes: tiles };
    render(<BookingSessionScreen />);
    fireEvent.press(screen.getByTestId("call-tile-menu-g_sam"));
    fireEvent.press(screen.getByTestId("tile-menu-remove"));
    expect(screen.getByText("Remove Sam from the call?")).toBeTruthy();
    fireEvent.press(screen.getByTestId("remove-sheet-back"));
    expect(remove.mutate).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId("call-tile-b_jordan"), "longPress");
    fireEvent.press(screen.getByTestId("tile-menu-remove"));
    fireEvent.press(screen.getByTestId("remove-sheet-confirm"));
    expect(remove.mutate).toHaveBeenCalledWith("b_jordan", expect.anything());
    expect(remove.target).toEqual({ bookingId: "b1" });
  });
  it("tiles are named from the server's participants (a friend who joined under another name shows their first name)", () => {
    q.data = privateView(true, [{ ...participants[0], firstName: "Jordan" }, { ...participants[1], firstName: "Samantha" }]);
    callState = { ...base, status: "in_call", remoteJoined: true, remotes: tiles };
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("call-tile-name-g_sam").props.children).toBe("Samantha");
  });
  it("no Remove when the server says she can't remove anyone now, or on someone she already took out", () => {
    q.data = privateView(false);
    callState = { ...base, status: "in_call", remoteJoined: true, remotes: tiles };
    const a = render(<BookingSessionScreen />);
    for (const t of tiles) expect(screen.queryByTestId(`call-tile-menu-${t.identity}`)).toBeNull();
    a.unmount();
    q.data = privateView(true, [participants[0], { ...participants[1], removed: true }, participants[2]]);
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("call-tile-menu-b_jordan")).toBeTruthy();
    expect(screen.queryByTestId("call-tile-menu-g_sam")).toBeNull();
    expect(screen.getByTestId("call-tile-menu-g_alex")).toBeTruthy();
  });
  it("a 1:1 is unchanged: one full-bleed view, no grid, no remove", () => {
    q.data = view();
    callState = { ...base, status: "in_call", remoteJoined: true, remoteVideo: { id: "r" }, remotes: [{ identity: "b_x", name: "Jordan", video: { id: "r" } }] };
    render(<BookingSessionScreen />);
    expect(screen.queryByTestId("call-grid")).toBeNull();
    expect(screen.queryByTestId("call-tile-menu-b_x")).toBeNull();
  });
});

describe("G2 an open group's time", () => {
  it("reads the group view, names tiles from its attendees, removes through the group route, and goes back when it ends", () => {
    routeParams = { slotId: "slot1" };
    g.data = groupFixture({ video: { mode: "livekit", joinOpensAt: null, joinClosesAt: "2099-01-01T00:00:00Z", joinState: "open", fallbackLink: null },
      actions: { join: true, cancel: false, sessionDone: false, removeParticipant: true } });
    const a = render(<BookingSessionScreen />);
    expect(screen.getByText("Call with your group")).toBeTruthy();
    fireEvent.press(screen.getByTestId("join-call"));
    expect(actions.join).toHaveBeenCalled();
    a.unmount();
    callState = { ...base, status: "in_call", remoteJoined: true, remotes: [
      { identity: "b_jordan", name: "Fan", video: null }, { identity: "b_sam", name: "Fan", video: null }, { identity: "b_new", name: "Fan", video: null },
    ] };
    const b = render(<BookingSessionScreen />);
    expect(screen.getByTestId("call-tile-name-b_jordan").props.children).toBe("Jordan");
    expect(screen.getByTestId("call-tile-name-b_sam").props.children).toBe("Sam");
    expect(screen.getByTestId("call-tile-name-b_new").props.children).toBe("Fan");
    fireEvent.press(screen.getByTestId("call-tile-menu-b_sam"));
    fireEvent.press(screen.getByTestId("tile-menu-remove"));
    fireEvent.press(screen.getByTestId("remove-sheet-confirm"));
    expect(remove.mutate).toHaveBeenCalledWith("b_sam", expect.anything());
    expect(remove.target).toEqual({ slotId: "slot1" });
    b.unmount();
    callState = { ...base, status: "ended" };
    render(<BookingSessionScreen />);
    expect(nav.goBack).toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
  it("no remove menu when the server says she can't remove anyone now", () => {
    routeParams = { slotId: "slot1" };
    g.data = groupFixture({ actions: { join: true, cancel: false, sessionDone: false, removeParticipant: false } });
    callState = { ...base, status: "in_call", remoteJoined: true, remotes: [{ identity: "b_jordan", name: "Fan", video: null }] };
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("call-grid")).toBeTruthy();
    expect(screen.queryByTestId("call-tile-menu-b_jordan")).toBeNull();
  });
});

describe("S1 the tile menu (0154): Mute · Turn off camera · Remove · Block", () => {
  const tiles = [{ identity: "b_jordan", name: "Jordan", video: null }, { identity: "g_sam", name: "Sam", video: null }];
  const participants = [
    { identity: "b_jordan", firstName: "Jordan", role: "buyer" as const, removed: false },
    { identity: "g_sam", firstName: "Sam", role: "guest" as const, removed: false },
  ];
  const groupCall = () => {
    q.data = { ...view({ booking: { audience: "private_group", partySize: 2 } }), participants, actions: { removeParticipant: true } };
    callState = { ...base, status: "in_call", remoteJoined: true, remotes: tiles };
  };

  it("lists the four actions; Mute and Turn off camera are one tap with that identity, then a line in the call", () => {
    groupCall();
    render(<BookingSessionScreen />);
    fireEvent.press(screen.getByTestId("call-tile-menu-g_sam"));
    expect(["mute", "camera", "remove", "block"].map((k) => screen.getByTestId(`tile-menu-${k}`))).toHaveLength(4);
    expect(screen.getByText("Turn off camera")).toBeTruthy();
    fireEvent.press(screen.getByTestId("tile-menu-mute"));
    expect(mute.mutate).toHaveBeenCalledWith({ identity: "g_sam", track: "microphone" }, expect.anything());
    expect(mute.target).toEqual({ bookingId: "b1" });
    act(() => { mute.mutate.mock.calls[0][1].onSuccess({ outcome: "muted" }); });
    expect(screen.queryByTestId("tile-menu")).toBeNull();
    expect(screen.getByTestId("call-flash").props.children).toBe("You muted Sam. They can unmute themselves.");
    fireEvent.press(screen.getByTestId("call-tile-menu-b_jordan"));
    fireEvent.press(screen.getByTestId("tile-menu-camera"));
    expect(mute.mutate).toHaveBeenLastCalledWith({ identity: "b_jordan", track: "camera" }, expect.anything());
  });

  it("Block → the confirm sheet says what will happen (from the server's preview) → block with that identity", () => {
    groupCall();
    blockPreview.data = { firstName: "Jordan", role: "buyer", alreadyBlocked: false, pendingRequests: 0,
      cancels: [{ bookingId: "b9", title: "Video call", startsAt: "2026-11-20T18:00:00Z", refundCents: 17_796 }] };
    render(<BookingSessionScreen />);
    fireEvent.press(screen.getByTestId("call-tile-menu-b_jordan"));
    fireEvent.press(screen.getByTestId("tile-menu-block"));
    expect(blockPreview.args).toEqual({ target: { bookingId: "b1" }, identity: "b_jordan" });
    expect(screen.getByText("Block Jordan?")).toBeTruthy();
    expect(screen.getByText(/^Jordan won't be able to book you, request you or join your calls\. We don't tell them/)).toBeTruthy();
    expect(screen.getByText("Jordan leaves this call now.")).toBeTruthy();
    expect(screen.getByText(/is cancelled and Jordan gets a full refund of \$177\.96\./)).toBeTruthy();
    expect(block.mutate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("block-sheet-confirm"));
    expect(block.mutate).toHaveBeenCalledWith({ identity: "b_jordan", reason: undefined }, expect.anything());
    expect(block.target).toEqual({ bookingId: "b1" });
  });

  it("a 1:1 gets the same menu on its one full-bleed view (no grid)", () => {
    q.data = { ...view(), participants: [participants[0]], actions: { removeParticipant: true } };
    callState = { ...base, status: "in_call", remoteJoined: true, remoteVideo: { id: "r" }, remotes: [{ identity: "b_jordan", name: "Jordan", video: { id: "r" } }] };
    render(<BookingSessionScreen />);
    expect(screen.queryByTestId("call-grid")).toBeNull();
    fireEvent.press(screen.getByTestId("call-tile-menu-b_jordan"));
    fireEvent.press(screen.getByTestId("tile-menu-mute"));
    expect(mute.mutate).toHaveBeenCalledWith({ identity: "b_jordan", track: "microphone" }, expect.anything());
  });

  it("an open group's tile mutes through the time's route", () => {
    routeParams = { slotId: "slot1" };
    g.data = groupFixture({ video: { mode: "livekit", joinOpensAt: null, joinClosesAt: "2099-01-01T00:00:00Z", joinState: "open", fallbackLink: null },
      actions: { join: true, cancel: false, sessionDone: false, removeParticipant: true } });
    callState = { ...base, status: "in_call", remoteJoined: true, remotes: [{ identity: "b_sam", name: "Fan", video: null }] };
    render(<BookingSessionScreen />);
    fireEvent.press(screen.getByTestId("call-tile-menu-b_sam"));
    fireEvent.press(screen.getByTestId("tile-menu-camera"));
    expect(mute.target).toEqual({ slotId: "slot1" });
    expect(mute.mutate).toHaveBeenCalledWith({ identity: "b_sam", track: "camera" }, expect.anything());
  });
});

describe("S2 the +15 'hasn't joined' hint needs real evidence (0154)", () => {
  it("hidden with no attendance evidence, or when the buyer tapped Join; shown on evidence", () => {
    callState = { ...base, status: "waiting" };
    q.data = view({ after: { canMarkBuyerNoShow: true }, attendance: { known: false } });
    const a = render(<BookingSessionScreen />);
    expect(screen.queryByTestId("call-noshow-hint")).toBeNull();
    a.unmount();
    q.data = view({ after: { canMarkBuyerNoShow: true }, attendance: { known: true, buyerTappedJoin: true } });
    const b = render(<BookingSessionScreen />);
    expect(screen.queryByTestId("call-noshow-hint")).toBeNull();
    b.unmount();
    q.data = view({ after: { canMarkBuyerNoShow: true }, attendance: { known: true, buyerTappedJoin: false } });
    render(<BookingSessionScreen />);
    expect(screen.getByTestId("call-noshow-hint")).toBeTruthy();
  });
});

afterAll(() => { act(() => {}); });
