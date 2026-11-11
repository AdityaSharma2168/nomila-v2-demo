/**
 * agent/postKit/config.ts — the post-kit builder's flag and limits, in one place (design "Moments → post kits" §13–§15).
 * Getters, so env is read at call time; the same pattern as agent/plan/config.ts.
 *
 * AGENT_POST_KITS — Track E runs: the plan workflow's post_kits step builds kits for new post actions, the daily
 * post-ideas cron proposes ideas from new media, and the post-kit routes are mounted. Off unless exactly "true" (set in
 * neither Cloud Run yaml: dark in dev and prod until someone turns it on).
 *
 * Cost (§15): one cheap-tier (Gemini Flash) re-rank per kit built, ~1–3 kits a week; one cheap-tier ideas call per
 * athlete per day at most, and only when new media arrived. Caps:
 *   AGENT_POST_KIT_RUN_CAP_USD   (default 0.03) the worst case one post-kit skill call may cost: a call starts only when
 *                                this still fits under the week and day caps. The per-call ceiling is max_output_tokens.
 *   AGENT_POST_KIT_WEEK_CAP_USD  (default 0.15) per athlete, summed over post-kit/match and post-kit/ideas runs in the
 *                                last 7 days.
 *   AGENT_POST_KIT_MAX_PER_WEEK  (default 5) kits built per athlete per 7 days, whatever they cost.
 *   AGENT_DAY_COST_CAP_USD       (default 5) the harness's per-athlete per-day cap, shared with every run.
 */
import { readCap } from "../../lib/spendCap";
import { AGENT_CAP_MAX } from "../config";
import { POST_KIT_CAPTION_CHARS } from "../../../shared/postKit";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function agentPostKitsEnabled(): boolean {
  return process.env.AGENT_POST_KITS === "true";
}

/**
 * AGENT_POST_KIT_RENDER — the preview render (design §11 v2, build step 9): a built, swapped or re-captioned kit is
 * compiled to a render and queued on the stitch queue (studio/stitchRunner.ts), from the athlete's real media only — no
 * model call, no generation, $0 but CPU. Off unless exactly "true", and only ever on together with AGENT_POST_KITS.
 *
 * Caps:
 *   AGENT_POST_KIT_RENDER_TIMEOUT_MS  (default 120000) the CPU budget of ONE render — every ffmpeg run in it together
 *                                     (stills, the cut, carousel pictures, the cover) — never more than the stitch
 *                                     queue's own budget (STUDIO_STITCH_TIMEOUT_MS), which the lease is derived from.
 *   length                            POST_KIT.TOTAL_MAX_SEC (30 s): a preview is never longer, nor is any one slide.
 */
export function agentPostKitRenderEnabled(): boolean {
  return agentPostKitsEnabled() && process.env.AGENT_POST_KIT_RENDER === "true";
}

export const POST_KIT_RENDER = {
  get TIMEOUT_MS(): number { return Math.floor(positive("AGENT_POST_KIT_RENDER_TIMEOUT_MS", 120_000)); },
  /** A preview's length cap, and any one slide's: the kit's own cut cap. */
  get MAX_SEC(): number { return POST_KIT.TOTAL_MAX_SEC; },
} as const;

/**
 * AGENT_POST_KIT_PREVIEW_CLEANUP — the daily clean-up of superseded preview renders (render/cleanup.ts,
 * POST /api/internal/post-kit-preview-cleanup-cron). A swap re-renders under a new key and the old key's rows and files
 * were never removed. Off unless exactly "true"; independent of AGENT_POST_KITS, so previews already made are still
 * cleaned up after the builder is switched off. On in dev, off in prod (gcp/cloud-run-*.yaml).
 */
export function agentPostKitPreviewCleanupEnabled(): boolean {
  return process.env.AGENT_POST_KIT_PREVIEW_CLEANUP === "true";
}

export const POST_KIT_PREVIEW_CLEANUP = {
  /** A preview row whose key is no longer its kit's is soft-deleted once it is this old (24 h). */
  SOFT_DELETE_AFTER_MS: 24 * 60 * 60_000,
  /** A soft-deleted preview row's files are deleted from storage once it has been deleted this long (7 days). */
  PURGE_AFTER_MS: 7 * 24 * 60 * 60_000,
  /** Athletes looked at in one pass, and rows per athlete per phase: the rest wait for the next day. */
  MAX_ATHLETES: 200,
  MAX_ROWS_PER_ATHLETE: 500,
  /** Wall-clock budget for one pass, inside the scheduler's 300 s attempt deadline; the rest waits for tomorrow. */
  BUDGET_MS: 240_000,
} as const;

/**
 * AGENT_POST_KIT_CAPABILITY_BLOCK — the capability layer's block in the re-rank (Studio capability layer v3, PR 1a). On:
 * a kit is matched by post-kit/match-library, whose prompt carries no fixed look or music list — it reads the block
 * generated from the Studio capability library (studio/agent/capabilityBlock.ts) for that post, and its output schema's
 * look and mood lists come from the same entries. Off: post-kit/match 1.0.0, byte for byte. Same model tier, same
 * caps, the same picks parser; the input grows by the block (~1.5k characters). Off unless exactly "true"; set in
 * neither Cloud Run yaml.
 */
export function agentPostKitCapabilityBlockEnabled(): boolean {
  return process.env.AGENT_POST_KIT_CAPABILITY_BLOCK === "true";
}

export const MATCH_SKILL_ID = "post-kit/match";
/** The re-rank with the capability block (AGENT_POST_KIT_CAPABILITY_BLOCK); its runs count against the same caps. */
export const MATCH_LIBRARY_SKILL_ID = "post-kit/match-library";
/**
 * The reverse pass's skill — and the memory_decisions.skill_id of the idea-bank rows it writes, so an idea is always
 * traceable to the skill that wrote it (and never confused with anything else filed under "other").
 */
export const IDEAS_SKILL_ID = "post-kit/ideas";

export const POST_KIT = {
  get RUN_RESERVE_MICRO_USD(): number { return Math.round(readCap("AGENT_POST_KIT_RUN_CAP_USD", 0.03, 0.3) * 1_000_000); },
  get WEEK_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_POST_KIT_WEEK_CAP_USD", 0.15, 1.5) * 1_000_000); },
  get DAY_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_DAY_COST_CAP_USD", 5, AGENT_CAP_MAX.DAY_USD) * 1_000_000); },
  get MAX_PER_WEEK(): number { return Math.floor(positive("AGENT_POST_KIT_MAX_PER_WEEK", 5)); },
  /** The output ceiling of one post-kit skill call (thinking included): the hard per-call cost bound. */
  MAX_OUTPUT_TOKENS: 2_000,
  /** Kits the plan workflow's post_kits step builds in one run (the rest wait for the next run or a tap). */
  MAX_PER_RUN: 3,
  /**
   * C1, prepare before Keep: of those, the next timely posts held for recommended goals still waiting may be built too,
   * at most this many a run (after the kept goals' own), under the same week and day caps (≤ MAX_PER_WEEK kits).
   */
  HELD_PER_RUN: 2,
  /** Candidates each searchMedia call returns (design §10: k 12), and the most the re-rank is shown. */
  SEARCH_K: 12,
  MAX_CANDIDATES: 12,
  /** The most assets in a kit: a carousel's ceiling (the render and the stitch workspace take up to 12). */
  MAX_ASSETS: 10,
  /** The most assets in a reel or story: its cut stays inside TOTAL_MAX_SEC (a feed post is one photo). */
  VIDEO_MAX_ASSETS: 3,
  /** A clip's cut: at least this long, at most this long; a video post's whole cut at most TOTAL_MAX_SEC. */
  MIN_CLIP_SEC: 1.5,
  MAX_CLIP_SEC: 12,
  TOTAL_MAX_SEC: 30,
  /** The overlay line's length, at a word. */
  OVERLAY_CHARS: 80,
  /** A caption's length (the platforms' common ceiling). */
  CAPTION_CHARS: POST_KIT_CAPTION_CHARS,
  /** Other kits whose assets count as used (not offered again) look back this far. */
  USED_LOOKBACK_DAYS: 60,
  /** The reverse pass (assets → ideas): new assets looked at per athlete per pass, ideas written per pass. */
  IDEAS_MAX_ASSETS: 12,
  IDEAS_MAX_PER_PASS: 3,
  /** Open moments shown to the ideas call. */
  IDEAS_MAX_MOMENTS: 8,
  /** Athletes one cron call handles (oldest pass first). */
  IDEAS_SWEEP_LIMIT: 25,
} as const;
