/**
 * context/shadow.ts — the shadow-comparison infrastructure (design §3.4, gate G1).
 *
 * The pure structural comparison the parity tests (context/parity.test.ts) use to compare each view with today's
 * reader. No reader runs it any more: the CANONICAL_CONTEXT_READERS / CONTEXT_SHADOW switches never advanced past
 * Step 2d-1 and were deleted 2 Nov 2026 (owner decision).
 */

/** The readers the Step 2d design named (design §3.3). */
export const CONTEXT_READERS = ["record", "onboarding", "identity", "deck", "search", "admin", "client"] as const;
export type ContextReader = (typeof CONTEXT_READERS)[number];
import type { PromptView } from "./views/prompt";
import type { IdentityView } from "./views/identity";
import type { SearchView } from "./views/search";

/**
 * The documented exception paths per reader (design §1.2 D2/D4/D5/D7, §3.2 provenance labels, §3.1 dates by as_of;
 * the build record's exception table). Everything else a shadow run reports is a defect.
 */
export const SHADOW_IGNORE: Record<ContextReader, Array<string | RegExp>> = {
  // record: D2 (level rows 6 + 7 from the ledger's level record), D4 (profile rows 8–10), §3.2 labels (credential 11,
  // found 0–2), D5 (the causes row 4 never carries a value), §3.1 dates, counts as consequences.
  // c04 legacy retirement map item 2.4 (the modern M.I.A. score PR): the legacy reader's score/header now come from
  // the ledger read of record, and the legacy "Capitals" row is dropped (no modern replacement for the four
  // capitals), while the canonical/legacyAdapter view still reads legacy athletes_current.display_score/tier/capitals
  // — a deliberate, documented split pending the canonical reader's own switch (out of scope here).
  record: [
    /^groups\[0\]\.entries\[(6|7|8|9|10|11)\]\.(at|kind|source|value)$/, /^groups\[4\]\.entries\[(0|1|2)\]\.(source|at)$/,
    /^groups\[4\]\.entries\[4\]\.(source|at|value|kind)$/, /^groups\[3\]\.entries\[1\]\.at$/, "counts.found", "counts.said",
    "header.displayScore", "header.tier", /^groups\[5\]\.entries\.length$/, /^groups\[5\]\.entries\[(0|1)\]\./, "counts.made",
  ],
  // onboarding (facts only, see onboardingFactsForShadow): the as-of date, the ledger team, D2 level
  onboarding: ["researched", "team_or_school", "division", "segment"],
  // identity: D2 level (division/segment from the ledger); `school` is compared STRICTLY against the ledger team (no projection fallback)
  identity: ["division", "segment"],
  deck: ["research", "commercialState", "inferredPartners", "storyArc", "division", "segment", "coverage", "sourceMode", "brandFitTags"],   // sourceMode/coverage: provenance on the view; brandFitTags: the canonical inference or [] on the view, undefined on the legacy reader (D6)
  // search: knownHandles adds platform-verified identities — the caller ignores a platform only when the view's handle is identity-sourced
  search: [],
  // admin: the roster's team from athlete_index_v is compared STRICTLY; `socials` is documented to differ — the index
  // adds connected / platform-verified identities the landing form never saw and normalises the handle (no leading @)
  admin: [/^socials\./],
  client: [],
};

/** The projection fields the identity readers read today (design §1.2 #4, #7, #9, #10, #26, #28). */
export interface LegacyIdentityRow { sport?: string | null; school?: string | null; division?: string | null; conference?: string | null; segment?: string | null; career_status?: string | null }
export const legacyIdentityFields = (r: LegacyIdentityRow) => ({ sport: r.sport ?? null, school: r.school ?? null, division: r.division ?? null, conference: r.conference ?? null, segment: r.segment ?? null, career: r.career_status ?? "active" });
/** The same fields from the identity view: `school` IS the ledger's primary current team — never the projection. */
export const identityFieldsForShadow = (v: IdentityView) => ({ sport: v.sport, school: v.currentTeam, division: v.level.division, conference: v.level.conference, segment: v.level.segment, career: v.careerStatus });
/** One call for every search/hint reader: today's anchor + handles vs the view. A handle differs by design only when the
 *  view's handle is identity-sourced (design §2.2); the anchor is compared strictly (a stale projection is a real diff). */
export function shadowSearch(athleteId: string, legacy: { anchor: string; handles: Record<string, string> }, view: SearchView): ShadowResult {
  const identityHandles = Object.entries(view.handleOrigins).filter(([, o]) => o === "social_identity").map(([p]) => `handles.${p}`);
  return shadowCompare("search", athleteId, { anchor: legacy.anchor, handles: legacy.handles }, { anchor: view.searchAnchor, handles: view.knownHandles }, [...SHADOW_IGNORE.search, ...identityHandles]);
}

/** One call for every identity reader: compare today's projection row with the view under the shared exception list. */
export function shadowIdentity(athleteId: string, legacy: LegacyIdentityRow, view: IdentityView): ShadowResult {
  return shadowCompare("identity", athleteId, legacyIdentityFields(legacy), identityFieldsForShadow(view), SHADOW_IGNORE.identity);
}

/** What today's onboarding block says, as facts (mirrors renderOnboardingBlock's lines that carry data). */
export interface OnboardingFactsLike { full_name: string; first_name: string; sport: string | null; school: string | null; division: string | null; conference: string | null; segment: string | null; career_status: string; display_score: number | null; tier: string | null; researched_at: string | null; achievements: Array<{ name: string; year: string | null }>; brands_seen: string[]; connected: string[] }
export function onboardingFactsForShadow(f: OnboardingFactsLike): Record<string, string | null> {
  return { name: f.full_name, first_name: f.first_name, sport: f.sport, team_or_school: f.school, career: f.career_status, division: f.division, conference: f.conference, segment: f.segment,
    score: f.display_score != null ? `${f.display_score}${f.tier ? ` (${f.tier})` : ""}` : "not scored yet", researched: f.researched_at ? f.researched_at.slice(0, 10) : "no research yet",
    achievements_found: f.achievements.length ? f.achievements.map((a) => (a.year ? `${a.name} (${a.year})` : a.name)).join("; ") : "none",
    brands_seen_in_public: f.brands_seen.length ? f.brands_seen.join("; ") : "none", connected_accounts: f.connected.length ? f.connected.join(", ") : "none yet" };
}
/** The same keys from the prompt view's facts (provenance tags stripped from the achievements line). */
export function promptFactsForShadow(p: PromptView): Record<string, string | null> {
  const untag = (s: string | null) => (s ?? "").replace(/\s\[[^\]]*\]/g, "");
  const keys = ["name", "first_name", "sport", "team_or_school", "career", "division", "conference", "segment", "score", "researched", "achievements_found", "brands_seen_in_public", "connected_accounts"];
  return Object.fromEntries(keys.map((k) => [k, k === "achievements_found" ? untag(p.facts[k]) : p.facts[k] ?? null]));
}

const RECENT_MAX = 50;
const recent: ShadowResult[] = [];
/** The last shadow results of this process (newest first) — for tests and a future admin surface. */
export function recentShadowResults(): ShadowResult[] { return [...recent].reverse(); }

export interface DiffEntry { path: string; legacy: unknown; canonical: unknown }

/** Structural diff of two JSON-like values, as a list of differing paths (arrays compared by index). */
export function structuralDiff(legacy: unknown, canonical: unknown, path = "", out: DiffEntry[] = [], depth = 0): DiffEntry[] {
  if (depth > 12) return out;
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
  const a = norm(legacy), b = norm(canonical);
  if (a === b) return out;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") { out.push({ path: path || "$", legacy: a, canonical: b }); return out; }
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [a], bb = Array.isArray(b) ? b : [b];
    if (aa.length !== bb.length) out.push({ path: `${path}.length`, legacy: aa.length, canonical: bb.length });
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) structuralDiff(aa[i], bb[i], `${path}[${i}]`, out, depth + 1);
    return out;
  }
  for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) structuralDiff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k, out, depth + 1);
  return out;
}

export interface ShadowResult { reader: ContextReader; athleteId: string; equal: boolean; diffs: DiffEntry[]; ignored: string[] }

/** Compare a reader's legacy output with its view; `ignore` lists the documented exception paths (design §4.1). */
export function shadowCompare(reader: ContextReader, athleteId: string, legacy: unknown, canonical: unknown, ignore: Array<string | RegExp> = []): ShadowResult {
  const all = structuralDiff(legacy, canonical);
  const isIgnored = (p: string) => ignore.some((x) => (typeof x === "string" ? p === x || p.startsWith(x + ".") || p.startsWith(x + "[") : x.test(p)));
  const diffs = all.filter((d) => !isIgnored(d.path));
  const ignored = all.filter((d) => isIgnored(d.path)).map((d) => d.path);
  const result = { reader, athleteId, equal: diffs.length === 0, diffs, ignored };
  recent.push(result); if (recent.length > RECENT_MAX) recent.shift();
  return result;
}
