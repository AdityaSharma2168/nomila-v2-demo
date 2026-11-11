/**
 * notices.ts — the session emails. Plain words, second person, her FIRST name only, and every email ends with the
 * support line. Every value interpolated into HTML is escaped. Nothing here names an athlete, sport or school: the
 * names come from the booking.
 *
 * Sending goes through sendEmail (Gmail; logs and no-ops unless EMAIL_PROVIDER=gmail), so tests mock one function.
 */

import { sendEmail } from "../../../lib/notify";
import { htmlEscape } from "../../../lib/securityHeaders";
import { BOOKINGS } from "../config";
import { formatWhen } from "../common";
import type { BookingForSession, ReportCategory } from "./sessionPorts";

/** The bookings' own date format (common.formatWhen): "Thu 12 Oct, 4:00 PM EDT" in the reader's zone. */
const when = (d: Date | null, timeZone: string | null = null): string => (d ? formatWhen(d, timeZone) : "the scheduled time");

function footerText(): string {
  return `\n\nQuestions or safety concerns? ${BOOKINGS.supportEmail} · In danger? Call 911.`;
}
function footerHtml(): string {
  const s = htmlEscape(BOOKINGS.supportEmail);
  return `<p style="color:#6B6B6B;font-size:12px">Questions or safety concerns? <a href="mailto:${s}">${s}</a> · In danger? Call 911.</p>`;
}

interface Mail { to: string; subject: string; lines: string[]; link?: { href: string; label: string } }

async function send(m: Mail): Promise<boolean> {
  const text = m.lines.join("\n\n") + (m.link ? `\n\n${m.link.label}: ${m.link.href}` : "") + footerText();
  const html = m.lines.map((l) => `<p>${htmlEscape(l)}</p>`).join("")
    + (m.link ? `<p><a href="${htmlEscape(m.link.href)}">${htmlEscape(m.link.label)}</a></p>` : "")
    + footerHtml();
  const r = await sendEmail({ to: m.to, subject: m.subject, text, html });
  return r.sent;
}

type B = BookingForSession & { buyerTimezone?: string | null };

// ─── To the buyer ────────────────────────────────────────────────────────────────────────────────────────────────

export function joinLinkToBuyer(b: B, url: string): Promise<boolean> | false {
  if (!b.buyerEmail) return false;
  return send({
    to: b.buyerEmail, subject: `Your call with ${b.athleteFirstName} opens in 10 minutes`,
    lines: [`Your video call with ${b.athleteFirstName} starts ${when(b.startsAt, b.buyerTimezone)}. You can join now from your browser. No app or account needed.`, "Nomila doesn't record calls."],
    link: { href: url, label: "Join call" },
  });
}

/** A private-group friend (0153): the same reminder, with their OWN link. */
export function joinLinkToGuest(b: B, to: string, url: string): Promise<boolean> | false {
  if (!to) return false;
  return send({
    to, subject: `Your call with ${b.athleteFirstName} opens in 10 minutes`,
    lines: [`${b.buyerFirstName}'s group call with ${b.athleteFirstName} starts ${when(b.startsAt, b.buyerTimezone)}. You can join now from your browser. No app or account needed.`,
      "This link is just for you. Nomila doesn't record calls."],
    link: { href: url, label: "Join call" },
  });
}

export function athleteNotJoinedToBuyer(b: B, url: string): Promise<boolean> | false {
  if (!b.buyerEmail) return false;
  return send({
    to: b.buyerEmail, subject: `${b.athleteFirstName} hasn't joined yet`,
    lines: [`It's been ${BOOKINGS.noShowGraceMinutes} minutes since your call with ${b.athleteFirstName} was due to start, and ${b.athleteFirstName} hasn't joined.`,
      "Your payment is held by Nomila. If the call doesn't happen, open your session page and tap Report a problem. A person at Nomila will look at it."],
    link: { href: url, label: "Open your session" },
  });
}

export function howDidItGoToBuyer(b: B, url: string): Promise<boolean> | false {
  if (!b.buyerEmail) return false;
  return send({
    to: b.buyerEmail, subject: `How did it go with ${b.athleteFirstName}?`,
    lines: [`Your ${b.title.toLowerCase()} with ${b.athleteFirstName} was ${when(b.startsAt, b.buyerTimezone)}.`,
      `If it happened, tap It happened and ${b.athleteFirstName} is paid now. If something went wrong, tap Report a problem and we'll hold the payment while a person looks.`,
      `If we don't hear from you, ${b.athleteFirstName} is paid ${when(b.releaseDueAt, b.buyerTimezone)}, as long as nothing was reported.`],
    link: { href: url, label: "How did it go?" },
  });
}

export function sessionDoneToBuyer(b: B, url: string): Promise<boolean> | false {
  if (!b.buyerEmail) return false;
  return send({
    to: b.buyerEmail, subject: `${b.athleteFirstName} marked your session done. Did it happen?`,
    lines: [`${b.athleteFirstName} marked your session done.`, "Tap It happened if it did, or Report a problem if it didn't."],
    link: { href: url, label: "Did it happen?" },
  });
}

export function buyerNoShowToBuyer(b: B, url: string): Promise<boolean> | false {
  if (!b.buyerEmail) return false;
  return send({
    to: b.buyerEmail, subject: `${b.athleteFirstName} says you didn't join`,
    lines: [`${b.athleteFirstName} says you didn't join your session.`, `If that's wrong, report a problem by ${when(b.releaseDueAt, b.buyerTimezone)}.`],
    link: { href: url, label: "Report a problem" },
  });
}

export function reportReceivedToBuyer(b: B, replyBy: Date): Promise<boolean> | false {
  if (!b.buyerEmail) return false;
  return send({
    to: b.buyerEmail, subject: "We got your report",
    lines: ["Thanks for telling us. The payment is held while a person at Nomila looks at what happened.", `We'll reply by ${when(replyBy, b.buyerTimezone)}.`],
  });
}

// ─── To her ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function joinOpensToAthlete(b: B): Promise<boolean> | false {
  if (!b.athleteEmail) return false;
  // 0153: a group call is one call for her (an open group's fans are many bookings; a private group is a party).
  const who = b.audience === "open_group" ? "your group" : b.audience === "private_group" ? `${b.buyerDisplayName}'s group` : b.buyerDisplayName;
  return send({
    to: b.athleteEmail, subject: `Your call with ${who} opens in 10 minutes`,
    lines: [`Your video call with ${who} starts ${when(b.startsAt)}. Open ${b.audience === "open_group" ? "the group session" : "the booking"} in the Nomila app and tap Join call.`, "Nomila doesn't record calls."],
  });
}

export function buyerNotJoinedToAthlete(b: B): Promise<boolean> | false {
  if (!b.athleteEmail) return false;
  return send({
    to: b.athleteEmail, subject: `${b.buyerDisplayName} hasn't joined`,
    lines: [`It's been ${BOOKINGS.noShowGraceMinutes} minutes and ${b.buyerDisplayName} hasn't joined.`,
      "If they don't come, open the booking in the app and tap Buyer didn't show. You'll still be paid, unless they report a problem."],
  });
}

export function checkinNudgeToAthlete(b: B): Promise<boolean> | false {
  if (!b.athleteEmail) return false;
  return send({
    to: b.athleteEmail, subject: "Are you OK?",
    lines: ["Your in-person session has ended. Open the booking in the app and tap I'm OK so the friend you shared it with knows.", "If you feel unsafe, call 911 first."],
  });
}

// ─── To support (email only, v2.1) ───────────────────────────────────────────────────────────────────────────────

export function reportToSupport(b: B, r: { reportId: string; by: string; category: ReportCategory; details: string | null; replyBy: Date }): Promise<boolean> {
  return send({
    to: BOOKINGS.supportEmail, subject: `[Booking report] ${r.category} · booking ${b.id}`,
    lines: [`Report ${r.reportId} by the ${r.by} on booking ${b.id} (status ${b.status}).`,
      `Category: ${r.category}. First response due by ${r.replyBy.toISOString()}.`,
      `Details: ${r.details?.trim() || "(none given)"}`,
      "Release is frozen while this report is open. Attendance (LiveKit join / leave) is in booking_events as evidence."],
  });
}
