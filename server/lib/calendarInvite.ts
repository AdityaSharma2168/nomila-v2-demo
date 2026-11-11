/**
 * calendarInvite.ts — is this message a calendar invite, and if so when is the meeting? Pure; no database, no model.
 *
 * A calendar invite ("Invitation: gorjana x Mia Bhuta Connect @ Mon Oct 12, 2026 11am", Google Calendar; an Outlook
 * meeting request; anything carrying an .ics) is a MEETING about a deal, never a deal. It is decided at ingest while
 * the message is in memory; only the decision (event, date/time, and — when content is retained — a title) is kept.
 *
 * Signals, strongest first:
 *   1. structure — a text/calendar MIME part or an .ics attachment (Gmail fetch), an Outlook eventMessage
 *      (Graph @odata.type), or the Google Calendar notifier sender (calendar-notification@google.com);
 *   2. subject  — Google Calendar's own subject shape: "Invitation: <title> @ <date> <time> …" (also Updated
 *      invitation / Canceled event / Accepted / Declined / Tentatively accepted), and only when the part after " @ "
 *      reads as a date. A brand writing "Invitation: our launch party" is not caught by this.
 */

export type MeetingEvent = "invited" | "updated" | "canceled" | "response";

/** The structural signals a fetch path saw (Gmail MIME walk / Outlook message type). In memory only. */
export interface CalendarSignal {
  /** A text/calendar part or an .ics attachment was present. */
  part: boolean;
  /** The inline iCalendar text when the provider handed it over without a download (bounded). Never stored. */
  ics?: string | null;
  /** Outlook: Graph says this is an eventMessage (meeting request / response / cancellation). */
  outlookEvent?: boolean;
}

export interface MeetingStart {
  /** YYYY-MM-DD, wall-clock date as the invite states it. */
  date: string;
  /** HH:MM 24h, wall-clock; null for an all-day event or when only a date is stated. */
  time: string | null;
  /** The invite's own zone label (PDT, America/Los_Angeles, UTC) — kept for reading, not converted. */
  tz: string | null;
}

export interface CalendarInvite {
  event: MeetingEvent;
  /** The meeting's title as the invite states it (subject / SUMMARY). In memory; the caller decides whether to keep it. */
  title: string | null;
  start: MeetingStart | null;
  /** The organiser's address when the invite states one (ICS ORGANIZER / Google body "Organizer" block). */
  organizer: string | null;
  signals: string[];
}

const GOOGLE_NOTIFIER = /^calendar-notification@google\.com$/i;

const GOOGLE_SUBJECT =
  /^(Updated invitation(?: with note)?|Invitation(?: with note)?|Canceled event(?: with note)?|Cancelled event(?: with note)?|Accepted|Declined|Tentatively accepted|Proposed new time)\s*:\s+(.+?)\s+@\s+(.+)$/i;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const monthOf = (s: string): number | null => MONTHS[s.toLowerCase().slice(0, 4)] ?? MONTHS[s.toLowerCase().slice(0, 3)] ?? null;
const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number): string | null {
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** "11am" / "11:30am" / "14:00" / "2 pm" → "HH:MM" (24h), else null. */
export function normaliseTime(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec((raw ?? "").trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (!ap && m[2] == null) return null;          // a bare number is not a time
  if (ap) { if (h < 1 || h > 12) return null; if (ap === "pm" && h !== 12) h += 12; if (ap === "am" && h === 12) h = 0; }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

const DAY = "(?:[A-Za-z]{3,9},?\\s+)?";
const TIME = "(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)";
const US_WHEN = new RegExp(`^${DAY}([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})(?:,?\\s+${TIME})?`, "i");
const UK_WHEN = new RegExp(`^${DAY}(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?,?\\s+(\\d{4})(?:,?\\s+${TIME})?`, "i");
const TZ_LABEL = /\((GMT[+-]\d{1,2}(?::\d{2})?|UTC|[A-Z]{2,5})\)/;

/** The "@ …" half of a Google Calendar subject → start, or null when it does not read as a date. */
export function parseWhen(when: string): MeetingStart | null {
  const s = when.trim();
  let date: string | null = null;
  let time: string | null = null;
  const us = US_WHEN.exec(s);
  if (us && monthOf(us[1])) { date = validDate(Number(us[3]), monthOf(us[1])!, Number(us[2])); time = normaliseTime(us[4]); }
  if (!date) {
    const uk = UK_WHEN.exec(s);
    if (uk && monthOf(uk[2])) { date = validDate(Number(uk[3]), monthOf(uk[2])!, Number(uk[1])); time = normaliseTime(uk[4]); }
  }
  if (!date) return null;
  return { date, time, tz: TZ_LABEL.exec(s)?.[1] ?? null };
}

/** The handful of iCalendar fields we read (RFC 5545 line unfolding; first VEVENT only). */
export function parseIcs(ics: string): { method: string | null; summary: string | null; start: MeetingStart | null; organizer: string | null } {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const get = (name: string) => lines.find((l) => l.toUpperCase().startsWith(`${name};`) || l.toUpperCase().startsWith(`${name}:`)) ?? null;
  const value = (line: string | null) => (line ? line.slice(line.indexOf(":") + 1).trim() : null);
  const method = value(get("METHOD"))?.toUpperCase() ?? null;
  const summary = value(get("SUMMARY"))?.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ") || null;
  const org = get("ORGANIZER");
  const organizer = org ? (/mailto:([^\s;]+)/i.exec(org)?.[1]?.toLowerCase() ?? null) : null;
  let start: MeetingStart | null = null;
  const dt = get("DTSTART");
  if (dt) {
    const params = dt.slice(0, dt.indexOf(":"));
    const v = value(dt) ?? "";
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?$/.exec(v);
    const date = m ? validDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
    if (date) {
      const tzid = /TZID=([^;:]+)/i.exec(params)?.[1] ?? null;
      start = { date, time: m![4] ? `${m![4]}:${m![5]}` : null, tz: m![6] ? "UTC" : (m![4] ? tzid : null) };
    }
  }
  return { method, summary, start, organizer };
}

function eventFromWords(word: string | null, method: string | null): MeetingEvent {
  const w = (word ?? "").toLowerCase();
  if (method === "CANCEL" || w.startsWith("cancel")) return "canceled";
  if (method === "REPLY" || /^(accepted|declined|tentatively accepted|proposed new time)$/.test(w)) return "response";
  if (w.startsWith("updated")) return "updated";
  return "invited";
}

/** Google's body names the organiser as "Organizer\n<name>\n<address>". */
function googleOrganizer(body: string): string | null {
  const m = /\bOrgani[sz]er\s*\n(?:[^\n]*\n){0,2}?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(body ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** Bare address of a From header. */
export function addressOf(from: string): string | null {
  const m = /<([^>]+)>/.exec(from ?? "");
  const a = (m ? m[1] : from ?? "").trim().toLowerCase();
  return a.includes("@") ? a : null;
}

/**
 * The decision: a CalendarInvite when the message is a calendar invite, else null. Email only — the caller does not
 * ask for Instagram DMs.
 */
export function detectCalendarInvite(msg: { from: string; subject: string; body: string; calendar?: CalendarSignal | null }): CalendarInvite | null {
  const signals: string[] = [];
  const cal = msg.calendar ?? null;
  if (cal?.part) signals.push("calendar_part");
  if (cal?.outlookEvent) signals.push("outlook_event");
  const sender = addressOf(msg.from);
  if (sender && GOOGLE_NOTIFIER.test(sender)) signals.push("google_notifier");

  const subj = GOOGLE_SUBJECT.exec((msg.subject ?? "").trim());
  const subjStart = subj ? parseWhen(subj[3]) : null;
  if (subj && subjStart) signals.push("calendar_subject");
  if (!signals.length) return null;

  const ics = cal?.ics ? parseIcs(cal.ics) : null;
  const title = (subj && subjStart ? subj[2].trim() : null) ?? ics?.summary ?? null;
  // The subject states the wall-clock time she was shown; an .ics often states UTC. Prefer the subject.
  const start = subjStart ?? ics?.start ?? null;
  return {
    event: eventFromWords(subj && subjStart ? subj[1] : null, ics?.method ?? null),
    title,
    start,
    organizer: ics?.organizer ?? googleOrganizer(msg.body) ?? null,
    signals,
  };
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Call · Mon 12 Oct, 11am" (all-day: "Call · Mon 12 Oct"; no date: "Call"). Canceled: "Call canceled · …". */
export function meetingLabel(m: { event: MeetingEvent; start: MeetingStart | null }): string {
  const head = m.event === "canceled" ? "Call canceled" : "Call";
  if (!m.start) return head;
  const [y, mo, d] = m.start.date.split("-").map(Number);
  const day = `${WEEKDAY[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MONTH[mo - 1]}`;
  if (!m.start.time) return `${head} · ${day}`;
  const [h, min] = m.start.time.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const t = `${h12}${min ? `:${pad(min)}` : ""}${h < 12 ? "am" : "pm"}${m.start.tz === "UTC" ? " UTC" : ""}`;
  return `${head} · ${day}, ${t}`;
}

/** Gmail MIME walk: a text/calendar part or an .ics file, and its inline text when Gmail inlined it (≤ 16 KB). */
export function calendarSignalFromGmailPayload(payload: any): CalendarSignal | null {
  let part = false;
  let ics: string | null = null;
  const walk = (p: any) => {
    if (!p) return;
    const mime = String(p.mimeType ?? "").toLowerCase();
    const name = String(p.filename ?? "");
    if (mime === "text/calendar" || mime === "application/ics" || /\.ics$/i.test(name)) {
      part = true;
      if (!ics && typeof p.body?.data === "string" && p.body.data.length < 22_000) {
        try { ics = Buffer.from(p.body.data, "base64").toString("utf8").slice(0, 16_000); } catch { /* ignore */ }
      }
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return part ? { part, ics } : null;
}
