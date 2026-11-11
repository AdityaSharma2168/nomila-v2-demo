/**
 * dealWords — a date never reaches the screen as "2026-10-12" and a count never reads "1 messages" (owner, 8 Oct 2026).
 */
import { countLabel, dayLabel, messagesLabel, respondByLabel } from "./dealWords";

const NOW = new Date("2026-10-08T12:00:00Z");

it("a calendar day in words: this year without the year, another year with it; the stored day, never shifted", () => {
  expect(dayLabel("2026-10-12", NOW)).toBe("Oct 12");
  expect(dayLabel("2027-01-03", NOW)).toBe("Jan 3, 2027");
  expect(dayLabel("2026-10-01T23:30:00Z", NOW)).toBe("Oct 1");
});

it("unreadable or missing → null, never the raw string", () => {
  expect(dayLabel("soon", NOW)).toBeNull();
  expect(dayLabel(null, NOW)).toBeNull();
  expect(respondByLabel("", NOW)).toBeNull();
});

it("Respond by, in words", () => {
  expect(respondByLabel("2026-10-12", NOW)).toBe("Respond by Oct 12");
});

it("counts agree in number", () => {
  expect(messagesLabel(1)).toBe("1 message");
  expect(messagesLabel(0)).toBe("0 messages");
  expect(messagesLabel(4)).toBe("4 messages");
  expect(countLabel(1, "deal", "deals")).toBe("1 deal");
});
