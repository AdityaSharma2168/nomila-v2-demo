// bookingSessionLogic — Bookings v2, her side of a session (screens A6 "Video call" and the after-session part of A5).
// Pure: the response types (mirroring server/services/bookings/session/sessionView.ts, AthleteSessionView), the copy,
// and the small decisions the two screens make, so they are unit-tested without rendering.
//
// Every `can…` flag comes from the server, which applies the same rule its route enforces; the screens only show a
// tap the server will accept (no dead taps). Times are shown in the phone's zone; the server's clock decides.

export type VideoMode = "livekit" | "link" | "none";
export type JoinState = "not_yet_open" | "open" | "closed" | "unavailable";

export interface SessionVideo {
  mode: VideoMode;
  joinOpensAt: string | null;
  joinClosesAt: string | null;
  joinState: JoinState;
  fallbackLink: string | null;
  recorded: false;
}

export interface AthleteSessionView {
  booking: {
    id: string; title: string; format: string; locationMode: "virtual" | "in_person"; status: string;
    startsAt: string | null; endsAt: string | null; durationMinutes: number; priceCents: number; currency: string;
    buyerName: string; venue: string | null;
    /** 0153: who it was for and the people this booking covers (absent from an older server: read as "one", 1). */
    audience?: "one" | "private_group" | "open_group"; partySize?: number; slotId?: string | null;
  };
  video: SessionVideo;
  /**
   * guestsJoined / guestsInRoom: a private group's invited friends (0153). known (0154): false = Nomila's call has NO
   * attendance evidence at all for this booking, so nothing may say "didn't join"; buyerTappedJoin: the booker or a
   * friend tapped Join (weak evidence). Both absent from an older server (read as known, not tapped).
   */
  attendance: { athleteJoined: boolean; buyerJoined: boolean; buyerInRoom: boolean; guestsJoined?: number; guestsInRoom?: number; known?: boolean; buyerTappedJoin?: boolean };
  after: {
    sessionDoneAt: string | null; buyerConfirmedAt: string | null; releaseDueAt: string | null; releasedAt: string | null;
    noShowBy: "buyer" | "athlete" | null; reportOpen: boolean;
    canMarkSessionDone: boolean; canMarkBuyerNoShow: boolean; buyerNoShowFrom: string | null; canReport: boolean;
  };
  safety: { inPerson: boolean; checkedInAt: string | null; canCheckIn: boolean; checkinUrl: string | null };
  /**
   * 0153: the people on the other side of a 1:1 or private-group call (booker, then each invited friend): the identity
   * they join with and their first name, so a tile is named and Remove targets the right person. Empty for an open
   * group's spot (its time's attendees name those tiles). Optional: absent from an older server.
   */
  participants?: CallParticipant[];
  /** removeParticipant: the call is open and someone can still be taken out. Absent (older server) = no Remove. */
  actions?: { removeParticipant: boolean };
  supportEmail: string;
  serverNow: string;
}

export interface CallParticipant { identity: string; firstName: string; role: "buyer" | "guest"; removed: boolean }

/** POST /api/v1/me/bookings/:id/session/token */
export interface JoinTokenResponse { wsUrl: string; room: string; identity: string; token: string; expiresAt: string }

export interface ReportResponse { reportId: string; supportNotified: boolean; moneyHeld: boolean; replyBy: string }

export type ReportCategory = "safety" | "harassment" | "not_as_described" | "payment" | "other";

/** What she can report from the app. Her "the buyer didn't show" is its own tap (Buyer didn't show), not a report. */
export const ATHLETE_REPORT_OPTIONS: readonly { category: ReportCategory; label: string }[] = [
  { category: "safety", label: "I felt unsafe" },
  { category: "harassment", label: "Harassment or abuse" },
  { category: "not_as_described", label: "It wasn't what was agreed" },
  { category: "payment", label: "A payment problem" },
  { category: "other", label: "Something else" },
];

export function money(cents: number): string {
  const d = cents / 100;
  return "$" + d.toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

export function clock(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function dayAndTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** The code in an apiRequest error ("403: {\"error\":\"not_yet_open\"}") or null. */
export function errorCode(err: unknown): string | null {
  const m = /^(\d{3}):\s*(.*)$/s.exec(String((err as Error)?.message ?? ""));
  if (!m) return null;
  try { return (JSON.parse(m[2]) as { error?: string }).error ?? m[1]; } catch { return m[1]; }
}

/** A short line for a failed tap — never a raw server or SDK message. */
export function errorLine(err: unknown): string {
  switch (errorCode(err)) {
    case "not_yet_open": return "The call isn't open yet.";
    case "closed": return "This call has closed.";
    case "too_early": return "That isn't available yet.";
    case "already_marked": return "That's already been marked.";
    case "issue_open": return "A problem was reported, so a person at Nomila will decide.";
    case "video_not_configured": return "Video isn't available right now. Use the backup link if you added one.";
    case "429": return "Too many tries. Wait a moment and try again.";
    case "404": case "not_found": return "This booking couldn't be found.";
    default: return "That didn't go through. Check your connection and try again.";
  }
}

export type JoinBlock = { kind: "button"; label: string; enabled: boolean } | { kind: "link"; url: string } | { kind: "none"; line: string };

/** The call screen's primary action before joining. */
export function joinBlock(v: AthleteSessionView): JoinBlock {
  const video = v.video;
  if (video.mode === "link") return video.fallbackLink ? { kind: "link", url: video.fallbackLink } : { kind: "none", line: "Add your call link to the booking so your buyer can join." };
  if (video.mode !== "livekit") return { kind: "none", line: "This session isn't a video call." };
  switch (video.joinState) {
    case "open":         return { kind: "button", label: "Join call", enabled: true };
    case "not_yet_open": return { kind: "button", label: `Join opens at ${clock(video.joinOpensAt)}`, enabled: false };
    case "closed":       return { kind: "none", line: `This call closed at ${clock(video.joinClosesAt)}.` };
    default:             return { kind: "none", line: "This call can't be joined." };
  }
}

/** "5 minutes left" once, quietly, at five minutes or less; never a running clock. */
export function timeLeftLine(endsAt: string | null, nowMs: number): string | null {
  if (!endsAt) return null;
  const left = Math.ceil((new Date(endsAt).getTime() - nowMs) / 60_000);
  if (left <= 0) return "Scheduled time is up";
  return left <= 5 ? `${left} minute${left === 1 ? "" : "s"} left` : null;
}

/** The after-session headline and line, from what has happened. */
export function afterSummary(v: AthleteSessionView): { title: string; line: string } {
  const buyer = v.booking.buyerName, price = money(v.booking.priceCents), a = v.after;
  if (a.releasedAt || v.booking.status === "released") return { title: "Paid", line: `${price} is on its way to you.` };
  if (a.reportOpen) return { title: "On hold", line: "A problem was reported. The payment is held while a person at Nomila looks. We'll email you." };
  if (a.noShowBy === "buyer") return { title: "Marked: buyer didn't show", line: `We told ${buyer}. You'll be paid ${price} ${a.releaseDueAt ? `on ${dayAndTime(a.releaseDueAt)}` : "after the review window"}, unless they report a problem.` };
  if (a.buyerConfirmedAt) return { title: "Confirmed", line: `${buyer} said it happened. You're being paid ${price}.` };
  if (a.sessionDoneAt) return { title: "We asked them to confirm", line: `We asked ${buyer} to confirm. You're paid when they do, or ${a.releaseDueAt ? `on ${dayAndTime(a.releaseDueAt)}` : "48 hours after the end"} if nothing's reported.` };
  return { title: "How did it go?", line: `Tap Session done and we'll ask ${buyer} to confirm. You're paid when they do, or 48 hours after the end if nothing's reported.` };
}

// ─── Group calls (0153) ─────────────────────────────────────────────────────────────────────────────────────────

/** A group call: more than one person may be on the other side, and she can take someone out. */
export function isGroupCall(v: Pick<AthleteSessionView, "booking">): boolean {
  return v.booking.audience === "private_group" || v.booking.audience === "open_group";
}

/** The part of an open-group time the call screen needs (GroupSessionView, shared/bookingsApi.ts). */
export interface GroupCallSource {
  slotId: string; title: string; format: string; locationMode: "virtual" | "in_person"; startsAt: string; endsAt: string;
  spotsTaken: number; receiveCents: number;
  attendees: Array<{ firstName: string; identity: string; joined: boolean; inRoom: boolean }>;
  video: { mode: VideoMode; joinOpensAt: string | null; joinClosesAt: string | null; joinState: JoinState; fallbackLink: string | null };
  actions: { sessionDone: boolean };
  supportEmail: string; serverNow: string;
}

/**
 * An open group's time read as the call screen's session view, so the same screen (before / call) draws it: "your group"
 * stands in for the buyer; there is no per-fan no-show or report from here (each fan's own booking carries those).
 */
export function groupAsSessionView(g: GroupCallSource): AthleteSessionView {
  const minutes = Math.max(0, Math.round((Date.parse(g.endsAt) - Date.parse(g.startsAt)) / 60_000));
  return {
    booking: {
      id: g.slotId, title: g.title, format: g.format, locationMode: g.locationMode, status: "confirmed", startsAt: g.startsAt, endsAt: g.endsAt,
      durationMinutes: minutes, priceCents: g.receiveCents, currency: "usd", buyerName: "your group", venue: null,
      audience: "open_group", partySize: g.spotsTaken, slotId: g.slotId,
    },
    video: { ...g.video, recorded: false },
    attendance: { athleteJoined: false, buyerJoined: g.attendees.some((a) => a.joined), buyerInRoom: g.attendees.some((a) => a.inRoom) },
    after: {
      sessionDoneAt: null, buyerConfirmedAt: null, releaseDueAt: null, releasedAt: null, noShowBy: null, reportOpen: false,
      canMarkSessionDone: g.actions.sessionDone, canMarkBuyerNoShow: false, buyerNoShowFrom: null, canReport: false,
    },
    safety: { inPerson: g.locationMode === "in_person", checkedInAt: null, canCheckIn: false, checkinUrl: null },
    supportEmail: g.supportEmail,
    serverNow: g.serverNow,
  };
}

/**
 * The name on a remote tile. An open group's fans join as "Fan" (they never see each other's names); only her app maps
 * their identity to a first name, from the time's attendees. Otherwise the call's own name (a private group's booker
 * and friends join with their first names), then "Guest".
 */
export function tileName(identity: string, callName: string | null | undefined, attendees: Array<{ identity: string; firstName: string }> = []): string {
  const a = attendees.find((x) => x.identity === identity);
  if (a?.firstName) return a.firstName;
  const n = callName?.trim();
  return n ? n.split(/\s+/)[0] : "Guest";
}

/** How a group call names tiles and offers Remove: who is in it (identity → first name) and whether she may remove. */
export interface GroupCallControl {
  attendees: Array<{ identity: string; firstName: string; removed?: boolean }>;
  canRemove: boolean;
}

/**
 * Both kinds of group call from the server's own answers: an open group's time from its group view (attendees,
 * actions.removeParticipant); a private group from its session view (participants, actions.removeParticipant). Remove
 * is shown only when the server says the tap will be accepted (no dead taps).
 */
export function groupCallControl(
  v: Pick<AthleteSessionView, "booking" | "participants" | "actions">,
  group?: { attendees: Array<{ identity: string; firstName: string }>; actions: { removeParticipant: boolean } } | null,
): GroupCallControl {
  if (v.booking.audience === "open_group") return { attendees: group?.attendees ?? [], canRemove: !!group?.actions.removeParticipant };
  return { attendees: v.participants ?? [], canRemove: !!v.actions?.removeParticipant };
}

/** Remove on this tile: she may remove now, and this person isn't one she already took out. */
export function canRemoveTile(c: GroupCallControl, identity: string): boolean {
  return c.canRemove && !c.attendees.some((a) => a.identity === identity && a.removed);
}

// ─── Sessions safety (0154) ─────────────────────────────────────────────────────────────────────────────────────

export type TileAction = "mute" | "camera" | "remove" | "block";

/**
 * Her tile menu: Mute, Turn off camera, Remove, Block (= remove + block, after a confirm sheet). Offered only where the
 * server will accept it (canRemoveTile: the call is open and this person isn't one she already took out).
 */
export function tileMenuOptions(c: GroupCallControl, identity: string): Array<{ key: TileAction; label: string }> {
  if (!canRemoveTile(c, identity)) return [];
  return [
    { key: "mute", label: "Mute" },
    { key: "camera", label: "Turn off camera" },
    { key: "remove", label: "Remove from call" },
    { key: "block", label: "Block" },
  ];
}

/** The neutral line when Nomila's call has no attendance evidence (never "didn't join" on a guess). */
export const ATTENDANCE_UNKNOWN_LINE = "We couldn't confirm attendance for this call.";

/** True unless the server says there's no attendance evidence at all (an older server: known). */
export function attendanceKnown(v: Pick<AthleteSessionView, "attendance">): boolean {
  return v.attendance.known !== false;
}

/**
 * The in-call "hasn't joined" hint: only on real evidence — the call has attendance rows, the buyer never joined AND
 * never tapped Join, nobody is on screen, and the no-show door is open. A group never shows it.
 */
export function showNoShowHint(v: AthleteSessionView, remoteJoined: boolean, group: boolean): boolean {
  return !group && !remoteJoined && attendanceKnown(v) && !v.attendance.buyerJoined && !v.attendance.buyerTappedJoin && v.after.canMarkBuyerNoShow;
}

/** After the grace, with no evidence: the neutral attendance line for the after-session screen; else null. */
export function attendanceLine(v: AthleteSessionView, nowMs: number): string | null {
  if (attendanceKnown(v) || v.video.mode !== "livekit") return null;
  const from = v.after.buyerNoShowFrom ? Date.parse(v.after.buyerNoShowFrom) : NaN;
  return Number.isFinite(from) && nowMs >= from ? ATTENDANCE_UNKNOWN_LINE : null;
}

/** What the block confirm sheet says will happen (her own words come from the preview). */
export function blockSheetLines(p: { firstName: string; cancels: Array<{ startsAt: string; refundCents: number }>; pendingRequests: number }, inCall: boolean): string[] {
  const n = p.firstName;
  const out = [`${n} won't be able to book you, request you or join your calls. We don't tell them they're blocked.`];
  if (inCall) out.push(`${n} leaves this call now.`);
  for (const c of p.cancels) out.push(`Their booking on ${dayAndTime(c.startsAt)} is cancelled and ${n} gets a full refund of ${money(c.refundCents)}.`);
  if (p.cancels.length) out.push("As with any cancellation by you, the card fee comes out of your next payout (your first one is free).");
  if (p.pendingRequests) out.push(p.pendingRequests === 1 ? "Their request waiting on you is declined." : `Their ${p.pendingRequests} requests waiting on you are declined.`);
  return out;
}

/** Columns for N remote tiles on a portrait phone: 1–2 stacked, 3–4 two across, 5–9 three across, more four across. */
export function gridColumns(n: number): number {
  return n <= 2 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
}
