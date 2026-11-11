/**
 * suggest.ts — the Board's "Suggested" track: the recommender's top pick for the words already on
 * her board, and the one line she is shown for why.
 *
 * ─── WHERE THE FEEL WORDS COME FROM ─────────────────────────────────────────────────────────────
 *
 * Her row sentences. The Board has no feel field, and asking for one would be a second place to
 * say what the first already says ("golden hour, slow walk off the court"). The route takes a list
 * of strings, not rows, so a plan-level feel (PR 6) can replace this source without touching it.
 *
 * ─── BRAND WORK, FAIL-CLOSED ────────────────────────────────────────────────────────────────────
 *
 * Whether a video is for a brand is read off its OBJECTIVE, and the rule is written as the list of
 * objectives that are NOT: her own content. Anything else — a brand objective, an objective added
 * next month, a missing one — is treated as brand work, so the recommender never offers a track
 * that is not brandSafe to it. Getting this wrong in the open direction is the one that costs.
 *
 * Pure: no DB, no model, nothing of hers stored.
 */
import { readFeel, recommend } from "./recommend";
import { MUSIC_TRACKS, type TrackDefinition } from "./tracks";

/** Objectives that make HER content, with no partner on the other end. Everything else is brand work. */
export const OWN_CONTENT_OBJECTIVES: ReadonlySet<string> = new Set([
  "grow-following",
  "recap",
  "concept",
]);

export const isBrandWork = (objective: unknown): boolean =>
  !(typeof objective === "string" && OWN_CONTENT_OBJECTIVES.has(objective));

/**
 * ─── WHAT DECIDES BRAND-NESS (PR 10, R-2 — Adi's rule, 23 Sep 2026) ──────────────────────────────
 *
 * Brand work = a deal is linked, OR the brief's objective.type is brand_campaign or ad, OR it is
 * social_content with a brand block (or the deal). Only when NONE of those inputs exist — no brief, no
 * deal: the plain Agent screen — does the purpose chip decide, through `isBrandWork` as before. The
 * planner (studio/agent/plan.ts) and the Board's suggestion (routes/studio.ts, off the stored plan row)
 * both come through THIS function, so the manual brand post (its assembled brief says brand_campaign)
 * and a confirmed brief whose goal is grow-following agree by construction. A brief whose type is not
 * one we know is brand work — fail-closed, the same direction as `isBrandWork`.
 * ⚠️ MUTATIONS (suggest.test / plan.test / brandPlan.test): return `isBrandWork(s.objective)` first —
 * "a grow-following brand brief is offered a non-brandSafe track" reds by name; drop the dealLinked
 * line — "a deal-linked plan with no brief is treated as own content" reds by name.
 */
export interface BrandSignals {
  /** The plan is for a deal deliverable. */
  dealLinked: boolean;
  /** The brief's `objective.type`, or null when there is no brief. */
  briefType: string | null;
  /** The brief carries a `brand` block. */
  briefHasBrand: boolean;
  /** The purpose chip — read only with no brief and no deal. */
  objective?: unknown;
}

export const OWN_BRIEF_TYPES: ReadonlySet<string> = new Set(["social_content"]);

export function brandWorkFor(s: BrandSignals): boolean {
  if (s.dealLinked) return true;
  if (s.briefType !== null)
    return OWN_BRIEF_TYPES.has(s.briefType) ? s.briefHasBrand : true;
  return isBrandWork(s.objective);
}

/**
 * The signals off what the plan route validated (a CampaignBrief) or what the plan row stored (its
 * `brief` jsonb, read back as unknown) — one reader for both, defensive: a brief that is an object with
 * no readable type is a brief of an unknown type, which is brand work.
 */
export function brandSignalsFrom(
  campaign: unknown,
  dealLinked: boolean,
  objective?: unknown,
): BrandSignals {
  const c =
    typeof campaign === "object" && campaign !== null
      ? (campaign as { objective?: unknown; brand?: unknown })
      : null;
  const o =
    c && typeof c.objective === "object" && c.objective !== null
      ? (c.objective as { type?: unknown })
      : null;
  return {
    dealLinked,
    briefType: c ? (typeof o?.type === "string" ? o.type : "") : null,
    briefHasBrand: !!c && typeof c.brand === "object" && c.brand !== null,
    objective,
  };
}

/** Enough for every row on a full board; a request past it is not a board. */
export const MAX_FEEL_LINES = 50;
export const MAX_FEEL_CHARS = 5000;

export interface SuggestedTrack {
  name: string;
  label: string;
  /** Shown to her as written. Built only from facts about the track (recommend.ts). */
  reason: string;
}

export interface MusicSuggestion {
  /** Null when her words name no feel at all — nothing is suggested on a guess. */
  top: SuggestedTrack | null;
  ranked: SuggestedTrack[];
}

export function suggestMusic(
  body: unknown,
  catalogue: Readonly<Record<string, TrackDefinition>> = MUSIC_TRACKS,
  /** The plan's brand signals, when the route found her plan row (PR 10, R-2); absent = no brief, no deal. */
  brand?: Omit<BrandSignals, "objective">,
): MusicSuggestion | { error: string } {
  const b = (body ?? {}) as { feel?: unknown; objective?: unknown };
  if (
    !Array.isArray(b.feel) ||
    b.feel.length > MAX_FEEL_LINES ||
    !b.feel.every((l): l is string => typeof l === "string") ||
    b.feel.join("").length > MAX_FEEL_CHARS
  ) {
    return {
      error: `feel is a list of up to ${MAX_FEEL_LINES} sentences, ${MAX_FEEL_CHARS} characters in all`,
    };
  }
  const feel = b.feel as string[];
  const forBrand = brandWorkFor({
    ...(brand ?? { dealLinked: false, briefType: null, briefHasBrand: false }),
    objective: b.objective,
  });
  const ranked = recommend({ feel, forBrand }, catalogue).map((r) => ({
    name: r.id,
    label: catalogue[r.id].title,
    reason: r.reason,
  }));
  const asked = readFeel(feel);
  const named = asked.moods.length > 0 || asked.tempo !== undefined;
  return { top: named ? (ranked[0] ?? null) : null, ranked };
}
