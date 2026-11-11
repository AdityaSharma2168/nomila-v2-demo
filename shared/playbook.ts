/**
 * shared/playbook.ts — the shared content playbook's contract (design "Moments → post kits" §5, v2 "shared
 * playbook"): lasting best-practice guidance for authentic growth — formats, hooks, ideal length, default posting
 * cadence, cross-platform reuse — one row per (sport, stage, platform) key that actually exists in the roster, never a
 * dated item (a trend or a seasonal hook belongs to the weekly moments scan, shared/plan.ts, not here).
 *
 * Versioned with the one-active-row pattern model_params already uses (migration 0043; server/services/intelligence/
 * params.ts): a row is never edited in place, draft rows are review-only, exactly one active row per key.
 *
 * Types and constants only, no runtime dependencies (shared/agent.ts rules). Nothing here names an athlete, sport,
 * school, league or brand.
 */
import { PLAN_STAGE_BANDS, type PlanStageBand } from "./plan";
import { POST_FORMATS } from "./postKit";

/**
 * The playbook's stage vocabulary: the Brief's own bands (shared/plan.ts PLAN_STAGE_BANDS), minus "unclear" — a key
 * needs a known stage to say anything specific; an athlete whose stage reads "unclear" is not in any playbook key yet.
 */
export const PLAYBOOK_STAGES = PLAN_STAGE_BANDS.filter((b) => b !== "unclear") as ReadonlyArray<Exclude<PlanStageBand, "unclear">>;
export type PlaybookStage = (typeof PLAYBOOK_STAGES)[number];

export function isPlaybookStage(v: unknown): v is PlaybookStage {
  return typeof v === "string" && (PLAYBOOK_STAGES as readonly string[]).includes(v);
}

/** One (sport, stage, platform) key — the composite identity of a content_playbooks row. `sport` is stored and looked
 * up folded to `lower(trim())` (keys.ts / read.ts), so a lookup never misses on case or stray whitespace alone. */
export interface PlaybookKey {
  sport: string;
  stage: PlaybookStage;
  /** As her connected accounts / social identities give it (e.g. "instagram", "tiktok", "youtube", "x"). */
  platform: string;
}

export const PLAYBOOK_STATUSES = ["draft", "active", "archived"] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

/** `post_format` is bounded (POST_FORMATS, or "other" when none fits) — the one field a post kit can act on
 * mechanically. The free-text `name` stays alongside it for the strategist's own wording ("a short vertical video"). */
export const PLAYBOOK_POST_FORMATS = [...POST_FORMATS, "other"] as const;
export type PlaybookPostFormat = (typeof PLAYBOOK_POST_FORMATS)[number];
export function isPlaybookPostFormat(v: unknown): v is PlaybookPostFormat {
  return typeof v === "string" && (PLAYBOOK_POST_FORMATS as readonly string[]).includes(v);
}

export interface PlaybookFormat {
  /** A few words, e.g. "a short vertical video" — the strategist's own wording, not a closed list. */
  name: string;
  /** Bounded: one of PostFormat, or "other" when none fits. */
  postFormat: PlaybookPostFormat;
  whenToUse: string;
}

export interface PlaybookCrossPlatformRule {
  from: string;
  to: string;
  rule: string;
}

export interface PlaybookSource {
  url: string;
  title: string;
}

/**
 * content_playbooks.config — lasting best practice for this (sport, stage, platform) key. Never a dated item: a
 * trending sound, a seasonal hook or a current event belongs to the weekly moments scan, not here (the playbook
 * skill's own rule, server/agent/jobs/playbook.md).
 */
export interface PlaybookConfig {
  formats: PlaybookFormat[];
  /** One line of hook guidance each. */
  hooks: string[];
  /** Seconds, 0 < min ≤ max ≤ 600 (code-enforced, refresh.ts). */
  idealLengthSec: { min: number; max: number };
  /**
   * The posting cadence for this key. `postsPerWeek` (0 < min ≤ max ≤ 21, code-enforced): the posts a week (feed posts,
   * reels, carousels; never stories) that grow reach and engagement here — playbook 1.2.0 makes it the TARGET the plan
   * recommends; only a limit the athlete set overrides it (the plan judges her words; this value is never silently
   * replaced here). playbook 1.2.0, optional (absent on a row written before, or when the model's numbers failed the
   * checks): `formatMix`, whole posts a week per format summing within the range; `storiesPerWeek`, a stories range
   * (0 ≤ min ≤ max ≤ 35), never counted in postsPerWeek.
   */
  cadence: {
    postsPerWeek: { min: number; max: number };
    formatMix?: { reel: number; carousel: number; feed: number };
    storiesPerWeek?: { min: number; max: number };
  };
  crossPlatformReuse: PlaybookCrossPlatformRule[];
  sources: PlaybookSource[];
  /** YYYY-MM-DD — when this version's research was done (not when the row was written or activated). */
  refreshedAt: string;
}
