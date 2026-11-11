/**
 * sessionView.ts — what each side's screen is told about a session (pure; the routes serialise these as-is).
 *
 * The athlete's view never carries the buyer's contact (only "Jordan P."); the buyer's view never carries anything
 * about her beyond her first name. Both carry the server clock, so a screen's "opens at 3:50" and "Buyer didn't show
 * from 4:15" agree with the server's rules instead of the phone's clock. Every `can…` flag is the SAME rule the route
 * enforces, so a button is shown only when the tap will be accepted (no dead taps).
 */

import { BOOKINGS } from "../config";
import { JOINABLE_STATUSES, joinRefusal, joinWindow, participantIdentity, usesLivekit } from "./sessionRoom";
import type { AttendanceSummary, BookingForSession } from "./sessionPorts";

const LIVE = new Set(["confirmed", "in_review"]);
const REPORTABLE = new Set(["confirmed", "in_review", "issue_reported", "disputed", "released"]);

export type VideoMode = "livekit" | "link" | "none";
export type JoinState = "not_yet_open" | "open" | "closed" | "unavailable";

export interface SessionVideo {
  mode:         VideoMode;
  joinOpensAt:  string | null;
  joinClosesAt: string | null;
  joinState:    JoinState;
  /** Her pasted Zoom / Meet link (https only): the fallback for a Nomila call, or the call itself in link mode. */
  fallbackLink: string | null;
  recorded:     false;
}

export interface AthleteSessionView {
  booking: {
    id: string; title: string; format: string; locationMode: "virtual" | "in_person"; status: string;
    startsAt: string | null; endsAt: string | null; durationMinutes: number; priceCents: number; currency: string;
    buyerName: string; venue: string | null;
    /** 0153: who it was for and the people this booking covers (an open group's whole time: GET /bookings/groups/:slotId). */
    audience: "one" | "private_group" | "open_group"; partySize: number; slotId: string | null;
  };
  video: SessionVideo;
  /** guestsJoined / guestsInRoom: a private group's invited friends (0153). */
  attendance: {
    athleteJoined: boolean; buyerJoined: boolean; buyerInRoom: boolean; guestsJoined: number; guestsInRoom: number;
    /**
     * 0154: false = no LiveKit attendance evidence at all on this booking (the screens say "We couldn't confirm
     * attendance for this call" instead of "didn't join"). buyerTappedJoin: the booker or a friend minted a join token
     * (weak evidence; it only stops a false "hasn't joined").
     */
    known: boolean; buyerTappedJoin: boolean;
  };
  after: {
    sessionDoneAt: string | null; buyerConfirmedAt: string | null; releaseDueAt: string | null; releasedAt: string | null;
    noShowBy: "buyer" | "athlete" | null; reportOpen: boolean;
    canMarkSessionDone: boolean; canMarkBuyerNoShow: boolean; buyerNoShowFrom: string | null; canReport: boolean;
  };
  safety: { inPerson: boolean; checkedInAt: string | null; canCheckIn: boolean; checkinUrl: string | null };
  /**
   * 0153: the people on the other side of a 1:1 or private-group call (the booker, then each invited friend), so her
   * app can put a first name on a tile and offer Remove. Identities are keyed pseudonyms; never contact details.
   * Empty for an open group (its time's view, GET /bookings/groups/:slotId, carries its attendees).
   */
  participants: CallParticipantView[];
  /**
   * removeParticipant: the call is open to join and someone in it can still be taken out (POST …/session/remove). The
   * same flag opens her tile menu (0154): Mute (POST …/session/mute), Turn off camera, Remove, Block.
   */
  actions: { removeParticipant: boolean };
  supportEmail: string;
  serverNow: string;
}

export interface CallParticipantView {
  identity: string;
  /** "Riley"; a friend with no name given is "Guest". */
  firstName: string;
  role: "buyer" | "guest";
  /** She already took them out of this call: their link gets no new token. */
  removed: boolean;
}

export interface BuyerSessionView {
  booking: {
    title: string; format: string; locationMode: "virtual" | "in_person"; status: string;
    startsAt: string | null; endsAt: string | null; durationMinutes: number; athleteFirstName: string;
    /** 0153: who it was for, and the people the room holds besides her (the party, or the open group's spots). */
    audience: "one" | "private_group" | "open_group"; groupSize: number;
  };
  /** buyer = the person who booked (and paid); guest = a friend a private-group booker invited (no money taps). */
  you: { role: "buyer" | "guest" };
  /**
   * athleteIdentity: her identity in this call, so the page can put her tile first and larger. joinMuted (0154): a
   * group call (private or open) — fans and friends join with the mic off and turn it on themselves; a 1:1 is unchanged.
   */
  video: SessionVideo & { athleteIdentity: string | null; joinMuted: boolean };
  after: {
    canSayItHappened: boolean; canReport: boolean; canReportNoShowFrom: string | null; itHappenedAt: string | null;
    releasedAt: string | null; releaseDueAt: string | null; reportOpen: boolean; athleteMarkedDone: boolean;
    markedYouNoShow: boolean;
    /**
     * 0154: what Nomila's call saw of YOU (the booker): seen (you joined), not_seen (others joined, you didn't), unknown
     * (no attendance evidence at all). The page never says "you didn't join" on its own authority.
     */
    attendance: "seen" | "not_seen" | "unknown";
  };
  supportEmail: string;
  serverNow: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** A group call (0154): fans and friends join with the mic off. */
export const isGroupAudience = (audience: BookingForSession["audience"]) => audience === "private_group" || audience === "open_group";
const safeIdentity = (f: () => string): string | null => { try { return f(); } catch { return null; } };

/** Only an https link is ever handed to a screen or the page (no javascript:, no http). */
export function safeLink(link: string | null): string | null {
  if (!link) return null;
  try { const u = new URL(link.trim()); return u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}

export function videoFor(b: BookingForSession, role: "athlete" | "buyer", now: Date): SessionVideo {
  const w = joinWindow(b);
  const live = usesLivekit(b);
  const mode: VideoMode = b.locationMode !== "virtual" ? "none" : live ? "livekit" : b.meetingMode === "link" ? "link" : "none";
  let joinState: JoinState = "unavailable";
  if (mode !== "none" && w && JOINABLE_STATUSES.has(b.status) && (role === "athlete" || b.buyerVerified)) {
    joinState = now < w.opensAt ? "not_yet_open" : now > w.closesAt ? "closed" : "open";
  }
  // The link is revealed only once the booking is paid (a joinable state), as the place is.
  const fallbackLink = mode !== "none" && JOINABLE_STATUSES.has(b.status) ? safeLink(b.meetingLink) : null;
  return { mode, joinOpensAt: iso(w?.opensAt), joinClosesAt: iso(w?.closesAt), joinState, fallbackLink, recorded: false };
}

const graceEnds = (b: BookingForSession) => (b.startsAt ? new Date(b.startsAt.getTime() + BOOKINGS.noShowGraceMinutes * 60_000) : null);

/**
 * `checkinUrl` is the read-only page she shares with a trusted friend from her phone's share sheet (in person only):
 * Nomila never sees or stores the friend's contact.
 */
export function athleteView(
  b: BookingForSession, a: AttendanceSummary, checkedInAt: Date | null, now: Date, checkinUrl: string | null = null,
  participants: CallParticipantView[] = [],
): AthleteSessionView {
  const started = !!b.startsAt && now >= b.startsAt;
  const grace = graceEnds(b);
  const video = videoFor(b, "athlete", now);
  const party = b.audience === "open_group" ? [] : participants;
  return {
    booking: {
      id: b.id, title: b.title, format: b.format, locationMode: b.locationMode, status: b.status,
      startsAt: iso(b.startsAt), endsAt: iso(b.endsAt), durationMinutes: b.durationMinutes, priceCents: b.priceCents, currency: b.currency,
      buyerName: b.buyerDisplayName, venue: b.locationMode === "in_person" && JOINABLE_STATUSES.has(b.status) ? b.venue : null,
      audience: b.audience, partySize: b.partySize, slotId: b.slotId,
    },
    video,
    attendance: {
      athleteJoined: a.athleteJoined, buyerJoined: a.buyerJoined, buyerInRoom: a.buyerInRoom, guestsJoined: a.guestsJoined, guestsInRoom: a.guestsInRoom,
      known: a.evidence, buyerTappedJoin: a.partyTapped,
    },
    after: {
      sessionDoneAt: iso(b.athleteDoneAt), buyerConfirmedAt: iso(b.buyerConfirmedAt), releaseDueAt: iso(b.releaseDueAt), releasedAt: iso(b.releasedAt),
      noShowBy: b.noShowBy, reportOpen: b.hasOpenReport,
      canMarkSessionDone: LIVE.has(b.status) && started && !b.athleteDoneAt,
      canMarkBuyerNoShow: LIVE.has(b.status) && !!grace && now >= grace && !b.noShowBy,
      buyerNoShowFrom: iso(grace),
      canReport: REPORTABLE.has(b.status),
    },
    safety: {
      inPerson: b.locationMode === "in_person",
      checkedInAt: iso(checkedInAt),
      canCheckIn: b.locationMode === "in_person" && REPORTABLE.has(b.status) && started && !checkedInAt,
      checkinUrl: b.locationMode === "in_person" && REPORTABLE.has(b.status) ? checkinUrl : null,
    },
    participants: party,
    actions: { removeParticipant: video.mode === "livekit" && video.joinState === "open" && party.some((p) => !p.removed) },
    supportEmail: BOOKINGS.supportEmail,
    serverNow: now.toISOString(),
  };
}

/**
 * The fan's (or a friend's) call page. A private-group friend (role "guest") has no money taps: "It happened" and
 * "Report a problem" are the booker's, who paid; a friend with a concern writes to support (the page shows the address).
 */
export function buyerView(b: BookingForSession, now: Date, role: "buyer" | "guest" = "buyer", a?: AttendanceSummary): BuyerSessionView {
  const started = !!b.startsAt && now >= b.startsAt;
  const payer = role === "buyer";
  const video = videoFor(b, "buyer", now);
  return {
    booking: {
      title: b.title, format: b.format, locationMode: b.locationMode, status: b.status,
      startsAt: iso(b.startsAt), endsAt: iso(b.endsAt), durationMinutes: b.durationMinutes, athleteFirstName: b.athleteFirstName,
      audience: b.audience, groupSize: b.audience === "open_group" ? b.roomCapacity : b.partySize,
    },
    you: { role },
    video: {
      ...video, athleteIdentity: video.mode === "livekit" ? safeIdentity(() => participantIdentity(b, "athlete")) : null,
      joinMuted: isGroupAudience(b.audience),
    },
    after: {
      canSayItHappened: payer && LIVE.has(b.status) && started && !b.hasOpenReport,
      canReport: payer && REPORTABLE.has(b.status),
      canReportNoShowFrom: iso(graceEnds(b)),
      itHappenedAt: iso(b.buyerConfirmedAt), releasedAt: iso(b.releasedAt), releaseDueAt: iso(b.releaseDueAt),
      reportOpen: b.hasOpenReport, athleteMarkedDone: !!b.athleteDoneAt, markedYouNoShow: b.noShowBy === "buyer",
      attendance: !a?.evidence ? "unknown" : (role === "guest" ? a.guestsJoined > 0 : a.buyerJoined) ? "seen" : "not_seen",
    },
    supportEmail: BOOKINGS.supportEmail,
    serverNow: now.toISOString(),
  };
}

export { joinRefusal };
