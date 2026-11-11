/**
 * conference.ts — conference-name normalisation (affiliations, the projection writer, its reconciliation script).
 *
 * Moved out of the retired v7.2 scoring engine (services/scoringService.ts, deleted in the legacy retirement P2-5,
 * 8 Oct 2026), where it lived only because scoring was its first reader. Byte for byte the code it was.
 */

/** The conferences that carry the power tier, in their short form. */
export const POWER_CONFERENCES = ["ACC", "Big Ten", "Big 12", "SEC", "Pac-12", "Big East"] as const;

const CONFERENCE_FULL_NAMES: Record<string, string> = {
  "atlantic coast conference": "ACC",
  "southeastern conference": "SEC",
  "big ten conference": "Big Ten",
  "big 12 conference": "Big 12",
  "big twelve conference": "Big 12",
  "pacific-12 conference": "Pac-12",
  "pac-12 conference": "Pac-12",
  "big east conference": "Big East",
};

/**
 * "Atlantic Coast Conference (ACC)" → "ACC" · "Big Ten Conference" → "Big Ten" · "SEC" → "SEC".
 * A parenthesised abbreviation wins; then a known full name; else the trimmed string as given.
 * Sport-neutral: it only knows how conference names are written, not which sports they hold.
 */
export function normalizeConference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const paren = t.match(/\(([^)]+)\)\s*$/);
  if (paren) return paren[1].trim();
  return CONFERENCE_FULL_NAMES[t.toLowerCase()] ?? t;
}
