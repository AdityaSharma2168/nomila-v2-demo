/**
 * views/search.ts — the search view (design §2.3, §4 2d-5): the ONE search anchor and the known
 * handles for research, refresh hints, discovery and the monthly sweep. Replaces the four copies of
 * buildSearchName (projection-anchored, D8) with an anchor built from the ledger's primary current
 * team; `knownHandles` keeps the legacy precedence (connected account > entered) and adds identities.
 */

import { buildCanonicalContext, type BuiltContext } from "../build";
import type { IdentityHints } from "../../research/providers";

export interface SearchView {
  athleteId: string;
  fullName: string;
  aliases: string[];
  sport: string | null;
  /** The ledger's primary current team (never the projection). */
  currentTeam: string | null;
  hometown: string | null;
  /** platform → handle, authority order: connected > platform-verified > web-researched > entered. Keys instagram | tiktok | youtube | x. */
  knownHandles: Record<string, string>;
  /** platform → where each known handle came from (social_identity | connected_account | entered), for the shadow classification. */
  handleOrigins: Record<string, string>;
  /** research.social_handles from the legacy blob — the discovery fallback of today; lowest rank; empty in canonical mode. */
  legacyBlobHandles: Record<string, string>;
  /** `<name> <current team> <sport>` from the ledger; the legacy anchor used the projection column. */
  searchAnchor: string;
  /** What buildSearchName produces today (projection-anchored), for parity while the callers migrate. */
  legacySearchAnchor: string;
}

const PLATFORMS = ["instagram", "tiktok", "youtube", "x"];

export function searchAnchorFor(v: Pick<SearchView, "fullName" | "currentTeam" | "sport">): string {
  return (v.currentTeam ? `${v.fullName} ${v.currentTeam} ${v.sport ?? ""}` : `${v.fullName} ${v.sport ?? ""}`).trim();
}

export function searchView(b: BuiltContext): SearchView {
  const { ctx, legacy } = b;
  const knownHandles: Record<string, string> = {};
  const handleOrigins: Record<string, string> = {};
  for (const p of PLATFORMS) { const h = ctx.social.handles[p]; if (h && h.origin !== "legacy_blob") { knownHandles[p] = h.handle; handleOrigins[p] = h.origin; } }
  const legacyBlobHandles: Record<string, string> = {};
  for (const [p, h] of Object.entries(ctx.social.handles)) if (h.origin === "legacy_blob") legacyBlobHandles[p] = h.handle;
  const h = ctx.identity.hometown?.value;
  const base = { fullName: ctx.identity.name.value.full, currentTeam: ctx.affiliations.current?.org ?? null, sport: ctx.identity.sport?.value.sport ?? null };
  return {
    athleteId: ctx.athleteId, ...base,
    aliases: ctx.identity.aliases.map((a) => a.value.text),
    hometown: h ? [h.city, h.region, h.country].filter(Boolean).join(", ") || null : null,
    knownHandles, handleOrigins, legacyBlobHandles,
    searchAnchor: searchAnchorFor(base),
    legacySearchAnchor: (legacy.row.school ? `${base.fullName} ${legacy.row.school} ${base.sport ?? ""}` : `${base.fullName} ${base.sport ?? ""}`).trim(),
  };
}

/** The search readers' entry point (2d-5): build the context and project it. Null when the athlete does not exist. */
export async function readSearchView(athleteId: string): Promise<SearchView | null> {
  const built = await buildCanonicalContext(athleteId);
  return built ? searchView(built) : null;
}

/** The extraction / refresh hints, from the search view (replaces the projection fallback in hintsFor, 2d-5). */
export function hintsFromSearchView(v: SearchView): IdentityHints {
  return { athleteId: v.athleteId, fullName: v.fullName, aliases: v.aliases.slice(0, 8), sport: v.sport, currentAffiliation: v.currentTeam, hometown: v.hometown, knownHandles: v.knownHandles };
}
