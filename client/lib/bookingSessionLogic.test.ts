/**
 * bookingSessionLogic.test — the call screen's and the after-session screen's own decisions (pure).
 *   J1 the join block follows the server's window: grey before, open inside, a line after; link mode opens her link
 *   J2 errors become short lines, never raw server text
 *   J3 "5 minutes left" only near the end, never a running clock
 *   J4 the after-session summary: paid · on hold · buyer no-show · confirmed · asked · default
 */
import {
  afterSummary, canRemoveTile, errorCode, errorLine, gridColumns, groupAsSessionView, groupCallControl, isGroupCall, joinBlock, tileName, timeLeftLine, type AthleteSessionView,
} from "./bookingSessionLogic";
import { groupFixture } from "../test/bookingFixtures";

const view = (over: { video?: Partial<AthleteSessionView["video"]>; after?: Partial<AthleteSessionView["after"]>; status?: string } = {}): AthleteSessionView => ({
  booking: { id: "b1", title: "Video call", format: "video_call", locationMode: "virtual", status: over.status ?? "confirmed", startsAt: "2026-10-12T20:00:00Z",
    endsAt: "2026-10-12T20:30:00Z", durationMinutes: 30, priceCents: 15000, currency: "usd", buyerName: "Jordan P.", venue: null },
  video: { mode: "livekit", joinOpensAt: "2026-10-12T19:50:00Z", joinClosesAt: "2026-10-12T21:00:00Z", joinState: "open", fallbackLink: null, recorded: false, ...over.video },
  attendance: { athleteJoined: false, buyerJoined: false, buyerInRoom: false },
  after: { sessionDoneAt: null, buyerConfirmedAt: null, releaseDueAt: null, releasedAt: null, noShowBy: null, reportOpen: false,
    canMarkSessionDone: false, canMarkBuyerNoShow: false, buyerNoShowFrom: null, canReport: true, ...over.after },
  safety: { inPerson: false, checkedInAt: null, canCheckIn: false, checkinUrl: null },
  supportEmail: "support@nomila.co",
  serverNow: "2026-10-12T19:55:00Z",
});

describe("J1 join block", () => {
  it("open / not yet / closed / link / link missing", () => {
    expect(joinBlock(view())).toEqual({ kind: "button", label: "Join call", enabled: true });
    const early = joinBlock(view({ video: { joinState: "not_yet_open" } }));
    expect(early).toMatchObject({ kind: "button", enabled: false });
    expect((early as any).label).toMatch(/^Join opens at /);
    expect(joinBlock(view({ video: { joinState: "closed" } }))).toMatchObject({ kind: "none" });
    expect(joinBlock(view({ video: { mode: "link", fallbackLink: "https://zoom.example.com/j/1" } }))).toEqual({ kind: "link", url: "https://zoom.example.com/j/1" });
    expect(joinBlock(view({ video: { mode: "link", fallbackLink: null } }))).toMatchObject({ kind: "none" });
    expect(joinBlock(view({ video: { mode: "none" } }))).toMatchObject({ kind: "none" });
  });
});

describe("J2 errors", () => {
  it("reads the server's code and maps it to a line", () => {
    const e = new Error('403: {"error":"not_yet_open"}');
    expect(errorCode(e)).toBe("not_yet_open");
    expect(errorLine(e)).toBe("The call isn't open yet.");
    expect(errorLine(new Error("409: {\"error\":\"issue_open\"}"))).toMatch(/problem was reported/);
    expect(errorLine(new Error("429: Too many"))).toMatch(/Too many tries/);
    expect(errorLine(new Error("TypeError: Network request failed"))).toMatch(/Check your connection/);
  });
});

describe("J3 time left", () => {
  it("silent until five minutes, then a quiet count", () => {
    const end = "2026-10-12T20:30:00Z";
    expect(timeLeftLine(end, Date.parse("2026-10-12T20:10:00Z"))).toBeNull();
    expect(timeLeftLine(end, Date.parse("2026-10-12T20:25:00Z"))).toBe("5 minutes left");
    expect(timeLeftLine(end, Date.parse("2026-10-12T20:29:30Z"))).toBe("1 minute left");
    expect(timeLeftLine(end, Date.parse("2026-10-12T20:31:00Z"))).toBe("Scheduled time is up");
  });
});

describe("J4 after summary", () => {
  it("each state, in priority order", () => {
    expect(afterSummary(view({ after: { releasedAt: "x" } })).title).toBe("Paid");
    expect(afterSummary(view({ after: { reportOpen: true } })).title).toBe("On hold");
    expect(afterSummary(view({ after: { noShowBy: "buyer" } })).line).toContain("We told Jordan P.");
    expect(afterSummary(view({ after: { buyerConfirmedAt: "x" } })).title).toBe("Confirmed");
    expect(afterSummary(view({ after: { sessionDoneAt: "x" } })).title).toBe("We asked them to confirm");
    expect(afterSummary(view()).line).toContain("Tap Session done");
    expect(afterSummary(view()).line).not.toMatch(/\bshe\b|\bher\b|\bhis\b/i);
  });
});

describe("J5 group calls (0153)", () => {
  it("an open group's time reads as a session view: 'your group', its window, no per-fan no-show or report", () => {
    const g = groupFixture({ video: { mode: "livekit", joinOpensAt: null, joinClosesAt: null, joinState: "open", fallbackLink: null } });
    const v = groupAsSessionView(g);
    expect(v.booking.buyerName).toBe("your group");
    expect(v.booking.audience).toBe("open_group");
    expect(v.booking.durationMinutes).toBe(60);
    expect(isGroupCall(v)).toBe(true);
    expect(joinBlock(v)).toEqual({ kind: "button", label: "Join call", enabled: true });
    expect(v.after.canMarkBuyerNoShow).toBe(false);
    expect(v.after.canReport).toBe(false);
    expect(isGroupCall(view())).toBe(false);
  });
  it("tiles are named from the attendees first, then the call's own name, then 'Guest'", () => {
    const attendees = [{ identity: "b_1", firstName: "Jordan" }];
    expect(tileName("b_1", "Fan", attendees)).toBe("Jordan");
    expect(tileName("g_2", "Sam Lee", attendees)).toBe("Sam");
    expect(tileName("g_3", "  ", attendees)).toBe("Guest");
  });
  it("Remove comes from the server: a private group's session view, an open group's time view; never a removed person", () => {
    const participants = [
      { identity: "b_r", firstName: "Riley", role: "buyer" as const, removed: false },
      { identity: "g_s", firstName: "Sam", role: "guest" as const, removed: true },
    ];
    const pg = { ...view(), booking: { ...view().booking, audience: "private_group" as const }, participants, actions: { removeParticipant: true } };
    const c = groupCallControl(pg);
    expect(c).toEqual({ attendees: participants, canRemove: true });
    expect(canRemoveTile(c, "b_r")).toBe(true);
    expect(canRemoveTile(c, "g_s")).toBe(false);
    expect(tileName("g_s", "Fan", c.attendees)).toBe("Sam");
    expect(groupCallControl({ ...pg, actions: { removeParticipant: false } }).canRemove).toBe(false);
    expect(groupCallControl({ ...pg, actions: undefined, participants: undefined })).toEqual({ attendees: [], canRemove: false });   // an older server
    const og = { ...view(), booking: { ...view().booking, audience: "open_group" as const } };
    const time = { attendees: [{ identity: "b_j", firstName: "Jordan" }], actions: { removeParticipant: true } };
    expect(groupCallControl(og, time)).toEqual({ attendees: time.attendees, canRemove: true });
    expect(groupCallControl(og, null).canRemove).toBe(false);
  });
  it("the grid: stacked for two, two across up to four, more columns beyond", () => {
    expect([1, 2, 3, 4, 5, 9, 10, 20].map(gridColumns)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});
