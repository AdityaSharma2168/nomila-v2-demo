// Deal words — the small formatting every deal surface shares, so a date never reaches the screen as "2026-10-12" and a
// count never reads "1 messages" (owner, 8 Oct 2026). Pure: no React.

/**
 * A calendar day in words: "Oct 12" this year, "Oct 12, 2027" otherwise. Takes a YYYY-MM-DD (read as that calendar day,
 * never shifted by the phone's timezone) or a full ISO time (its UTC day). Anything unreadable → null, never the raw
 * string.
 */
export function dayLabel(raw: string | null | undefined, now: Date = new Date()): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** "1 message" · "3 messages". */
export function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const messagesLabel = (n: number): string => countLabel(n, "message", "messages");

/** "Respond by Oct 12" — null when there is no readable date. */
export function respondByLabel(raw: string | null | undefined, now: Date = new Date()): string | null {
  const day = dayLabel(raw, now);
  return day ? `Respond by ${day}` : null;
}
