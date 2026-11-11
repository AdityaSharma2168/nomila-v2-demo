/**
 * goals.ts — the one goal vocabulary, and the career statuses that choose between its two sets.
 *
 * Until now the five goal slugs lived only in landing/index.html, and the server accepted any
 * text up to eighty characters — so the landing page wrote slugs and Mila's confirm card wrote
 * prose into the same column. The app and the waitlist route now share this list. (The landing page
 * stopped asking goals with the Oct 2026 join flow; server/routes/waitlist.goals.test.ts pins that it keeps no copy.)
 *
 * Two sets, one column. An ACTIVE athlete picks from GOALS ("get my first deal" assumes a season
 * ahead). A RETIRED athlete picks from RETIRED_GOALS. Which set the landing page shows follows the
 * career status she gave one screen earlier; the server accepts either set for either status, so a
 * status change never invalidates a stored goal.
 */

export const GOALS = [
  { slug: "grow_my_following", label: "Grow my following" },
  { slug: "get_my_first_deal", label: "Get my first deal" },
  { slug: "get_fair_value",    label: "Get fair value for deals" },
  { slug: "build_partnerships", label: "Build long-term partnerships" },
  { slug: "grow_my_business",  label: "Grow my own business" },
] as const;

export const RETIRED_GOALS = [
  { slug: "keep_partnerships",  label: "Keep the partnerships I built" },
  { slug: "own_business",       label: "Build my business or brand" },
  { slug: "speak_and_appear",   label: "Speak and appear" },
  { slug: "give_back",          label: "Give back" },
] as const;

export const ALL_GOALS = [...GOALS, ...RETIRED_GOALS] as const;

export type GoalSlug = (typeof ALL_GOALS)[number]["slug"];

export const GOAL_SLUGS: ReadonlySet<string> = new Set(ALL_GOALS.map((g) => g.slug));

export function isGoalSlug(v: unknown): v is GoalSlug {
  return typeof v === "string" && GOAL_SLUGS.has(v);
}

/** Accepts a slug or an exact label (case-insensitive); returns the slug or null. */
export function toGoalSlug(v: unknown): GoalSlug | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (GOAL_SLUGS.has(t)) return t as GoalSlug;
  const byLabel = ALL_GOALS.find((g) => g.label.toLowerCase() === t.toLowerCase());
  return byLabel?.slug ?? null;
}

/** The label for a stored slug; an unknown slug reads as itself, spaced and capitalised. */
export function goalLabel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const g = ALL_GOALS.find((x) => x.slug === slug);
  return g?.label ?? slug.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ─── Career status ───────────────────────────────────────────────────────────

/**
 * A DECLARED fact, never inferred: "no current team" is true of a retired legend, a free agent
 * and a signup Mila has not asked yet. Asked on the landing page before the goals; confirmed by
 * Mila at the first entry; editable on Brand › Facts.
 */
export const CAREER_STATUSES = [
  { slug: "active",          label: "Playing",         hint: "On a roster this season" },
  { slug: "between_teams",   label: "Between teams",   hint: "Transfer, draft, free agent" },
  { slug: "out_this_season", label: "Out this season", hint: "Injury, redshirt, a year off" },
  { slug: "retired",         label: "Retired",         hint: "Done competing" },
] as const;

export type CareerStatus = (typeof CAREER_STATUSES)[number]["slug"];
export const CAREER_STATUS_SLUGS: ReadonlySet<string> = new Set(CAREER_STATUSES.map((s) => s.slug));

export function isCareerStatus(v: unknown): v is CareerStatus {
  return typeof v === "string" && CAREER_STATUS_SLUGS.has(v);
}

/** Accepts a slug or a label ("Retired", "playing", "free agent"); returns the slug or null. */
export function toCareerStatus(v: unknown): CareerStatus | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CAREER_STATUS_SLUGS.has(t)) return t as CareerStatus;
  const byLabel = CAREER_STATUSES.find((s) => s.label.toLowerCase().replace(/\s+/g, "_") === t);
  if (byLabel) return byLabel.slug;
  if (/^(playing|competing|current|active_player)$/.test(t)) return "active";
  if (/^(free_agent|transfer|drafted|draft|looking|in_the_portal|transfer_portal)$/.test(t)) return "between_teams";
  if (/^(injured|redshirt|gap_year|out|sidelined|out_for_the_season)$/.test(t)) return "out_this_season";
  if (/^(retiring|done|finished|done_competing)$/.test(t)) return "retired";
  return null;
}

export function careerStatusLabel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return CAREER_STATUSES.find((s) => s.slug === slug)?.label ?? null;
}

/** Which goal set the landing page (and Mila) offers for a status. */
export function goalsFor(status: CareerStatus | null | undefined): ReadonlyArray<{ slug: GoalSlug; label: string }> {
  return status === "retired" ? RETIRED_GOALS : GOALS;
}
