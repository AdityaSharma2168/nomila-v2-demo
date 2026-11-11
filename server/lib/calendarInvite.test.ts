/**
 * calendarInvite — the ingest decision "this is a calendar invite, not a deal", and the "Call · Mon 12 Oct, 11am"
 * label. Pure; mocked messages only.
 */
import { calendarSignalFromGmailPayload, detectCalendarInvite, meetingLabel, normaliseTime, parseIcs, parseWhen } from "./calendarInvite";

const GORJANA = {
  from: "Michelle Garcia <michelle@gorjana.com>",
  subject: "Invitation: gorjana x Mia Bhuta Connect @ Mon Oct 12, 2026 11am - 11:30am (PDT) (miabhuta@gmail.com)",
  body: "gorjana x Mia Bhuta Connect\nMonday Oct 12, 2026 ⋅ 11am – 11:30am\n\nOrganizer\nMichelle Garcia\nmichelle@gorjana.com\n\nGuests\n",
};

describe("detectCalendarInvite", () => {
  it("reads the gorjana Google Calendar invite: title, wall-clock start, organiser", () => {
    const inv = detectCalendarInvite(GORJANA)!;
    expect(inv).toMatchObject({
      event: "invited", title: "gorjana x Mia Bhuta Connect",
      start: { date: "2026-10-12", time: "11:00", tz: "PDT" }, organizer: "michelle@gorjana.com", signals: ["calendar_subject"],
    });
    expect(meetingLabel(inv)).toBe("Call · Mon 12 Oct, 11am");
  });

  it("Google's other subject shapes: updated, canceled, a reply; day-month order", () => {
    expect(detectCalendarInvite({ ...GORJANA, subject: "Updated invitation: Sync @ Tue Oct 13, 2026 2:30pm - 3pm (EDT) (a@b.com)" }))
      .toMatchObject({ event: "updated", start: { date: "2026-10-13", time: "14:30" } });
    const canceled = detectCalendarInvite({ ...GORJANA, subject: "Canceled event: Sync @ Tue 13 Oct 2026 14:00 - 15:00 (BST) (a@b.com)" })!;
    expect(canceled).toMatchObject({ event: "canceled", start: { date: "2026-10-13", time: "14:00", tz: "BST" } });
    expect(meetingLabel(canceled)).toBe("Call canceled · Tue 13 Oct, 2pm");
    expect(detectCalendarInvite({ ...GORJANA, subject: "Accepted: Sync @ Wed Oct 14, 2026 (a@b.com)" }))
      .toMatchObject({ event: "response", start: { date: "2026-10-14", time: null } });
  });

  it("a brand's own 'Invitation:' pitch with no calendar date is NOT an invite", () => {
    expect(detectCalendarInvite({ from: "PR <pr@brand.com>", subject: "Invitation: our launch party", body: "Join us" })).toBeNull();
    expect(detectCalendarInvite({ from: "PR <pr@brand.com>", subject: "Invitation: meet @ our studio", body: "" })).toBeNull();
    expect(detectCalendarInvite({ from: "PR <pr@brand.com>", subject: "Paid campaign for October", body: "" })).toBeNull();
  });

  it("structure decides on its own: a text/calendar part (ics read for title/start), Outlook eventMessage, the Google notifier", () => {
    const ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nDTSTART:20261012T180000Z\r\nSUMMARY:Brand intro\r\n  call\r\nORGANIZER;CN=Jo:mailto:Jo@Brand.com\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const inv = detectCalendarInvite({ from: "jo@brand.com", subject: "Brand intro call", body: "", calendar: { part: true, ics } })!;
    expect(inv).toMatchObject({ event: "invited", title: "Brand intro call", start: { date: "2026-10-12", time: "18:00", tz: "UTC" }, organizer: "jo@brand.com" });
    expect(meetingLabel(inv)).toBe("Call · Mon 12 Oct, 6pm UTC");
    expect(detectCalendarInvite({ from: "jo@brand.com", subject: "Brand intro call", body: "", calendar: { part: false, outlookEvent: true } }))
      .toMatchObject({ signals: ["outlook_event"], start: null });
    expect(detectCalendarInvite({ from: "Google Calendar <calendar-notification@google.com>", subject: "Reminder", body: "" }))
      .toMatchObject({ signals: ["google_notifier"] });
    expect(meetingLabel({ event: "invited", start: null })).toBe("Call");
  });
});

describe("parsers", () => {
  it("times, dates and iCalendar fields", () => {
    expect(normaliseTime("11am")).toBe("11:00");
    expect(normaliseTime("12pm")).toBe("12:00");
    expect(normaliseTime("12:15am")).toBe("00:15");
    expect(normaliseTime("17:45")).toBe("17:45");
    expect(normaliseTime("11")).toBeNull();
    expect(parseWhen("Feb 30, 2026 10am")).toBeNull();
    expect(parseWhen("Thursday, Oct 15, 2026")).toEqual({ date: "2026-10-15", time: null, tz: null });
    expect(parseIcs("METHOD:CANCEL\nDTSTART;TZID=America/Los_Angeles:20261012T110000\nDTSTART;VALUE=DATE:20261013"))
      .toMatchObject({ method: "CANCEL", start: { date: "2026-10-12", time: "11:00", tz: "America/Los_Angeles" } });
  });

  it("the Gmail MIME walk finds a text/calendar part or an .ics file, and inlined calendar text", () => {
    const data = Buffer.from("BEGIN:VCALENDAR\nSUMMARY:Hi\nEND:VCALENDAR").toString("base64");
    expect(calendarSignalFromGmailPayload({ mimeType: "multipart/mixed", parts: [
      { mimeType: "text/plain", body: { data: "eA" } },
      { mimeType: "multipart/alternative", parts: [{ mimeType: "text/calendar", body: { data } }] },
    ] })).toEqual({ part: true, ics: "BEGIN:VCALENDAR\nSUMMARY:Hi\nEND:VCALENDAR" });
    expect(calendarSignalFromGmailPayload({ mimeType: "multipart/mixed", parts: [{ mimeType: "application/octet-stream", filename: "invite.ics", body: { attachmentId: "a1" } }] }))
      .toEqual({ part: true, ics: null });
    expect(calendarSignalFromGmailPayload({ mimeType: "text/plain", body: { data: "eA" } })).toBeNull();
  });
});
