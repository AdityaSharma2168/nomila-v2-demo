/**
 * context/searchInputs.ts — the ONE boundary for the search-anchor / research-hint readers (Phase A Step 2d-5,
 * design §1.2 #15, #17, #31, #33, #34, #35, #36, #41; §3.3 / §3.4).
 *
 * Exactly what the caller computed (its own anchor + handles + team), with empty handles dropped. (The listed path to
 * the canonical search view and its shadow comparison, CANONICAL_CONTEXT_READERS / CONTEXT_SHADOW, never ran and were
 * deleted 2 Nov 2026, owner decision.)
 *
 * Search and hints locate, disambiguate and research an athlete; they are never a source of truth. Nothing here
 * writes.
 */

export interface LegacySearchInputs {
  /** The anchor the caller built today (its buildSearchName copy over the projection). */
  anchor: string;
  /** The handles the caller collected today (typed + connected); undefined values are dropped. */
  handles: Record<string, string | undefined | null>;
  /** The team the caller would hand to platform discovery today (the projection column), when it has one. */
  team?: string | null;
}

export interface SearchInputs {
  anchor: string;
  handles: Record<string, string>;
  /** The caller's team (or null). */
  currentTeam: string | null;
}

const cleanHandles = (h: Record<string, string | undefined | null>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0));

export async function searchInputsFor(_athleteId: string, legacy: LegacySearchInputs): Promise<SearchInputs> {
  return { anchor: legacy.anchor, handles: cleanHandles(legacy.handles), currentTeam: legacy.team ?? null };
}
