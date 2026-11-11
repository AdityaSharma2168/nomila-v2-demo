/**
 * evals/agent/postKit/types.ts — the post-kit stage's cases and records (design "Moments → post kits" §14, asset-match
 * quality). Each case is a MADE-UP library (assets described as the tagger would) and one post action; the stage runs
 * the real builder (server/agent/postKit/build.ts) in memory and grades what it picked.
 */
import type { BuildOutcome } from "../../../server/agent/postKit/build";
import type { PostFormat, PostKit } from "../../../shared/postKit";

/** One library asset, by a case-local key. "$partner" / "$rival" in `brands` resolve to the caster's sportswear list. */
export interface PostKitCaseAsset {
  key: string;
  kind: "photo" | "clip";
  description: string;
  shot_type?: string;
  setting?: string;
  vibe?: string;
  attire?: string;
  /** Default true. */
  athlete_present?: boolean;
  /** Default true. */
  brand_safe?: boolean;
  brands?: string[];
  /** Default "camera". */
  provenance?: "camera" | "synced" | "made-here";
  /** A clip's length in seconds. */
  duration?: number;
  /** A clip's described beats: [start, end, words]. */
  beats?: Array<[number, number, string]>;
  /** A clip's stored camera cuts. */
  shots?: number[];
}

export interface PostKitCase {
  id: string;
  description: string;
  /** False until the owner has checked the expectations. */
  reviewed: boolean;
  library: PostKitCaseAsset[];
  post: {
    what: string;
    /** The plan's post_brief body ("Caption: …\nShots: …"). */
    body: string;
    platform: string;
    /** A partner post: "$partner" resolves to the caster's first sportswear brand. */
    partner?: string;
    /** The moment the action is timed for, when there is one. */
    moment?: { name: string; date: string; hook?: string; format?: PostFormat; show?: string; captionAngle?: string; avoid?: string; mediaNeeds?: string };
  };
  /** Never-use names (an "avoid" preference). */
  never?: string[];
  expect: {
    /** At least one of these keys is in the kit. */
    any_of?: string[];
    /** None of these keys is ever shown to the re-rank or in the kit (unsafe, not the athlete's own, a rival mark, a never-use name). */
    must_not: string[];
    /** Usable, but wrong for this brief: shown to the re-rank, never picked (a quality check, not a safety one). */
    avoid_picking?: string[];
    /** A picked clip's seconds overlap this window: key → [start, end]. */
    clip_within?: Record<string, [number, number]>;
    ai_needed: boolean;
    format?: PostFormat;
  };
  /** What the --mock re-rank answers: keys in order (and a clip's segment index), or none fit. */
  mock: { picks: Array<{ key: string; segment?: number }>; none_fit?: boolean; look?: string; mood?: string };
}

export interface PostKitCaseRecord {
  caseId: string;
  mode: "mock" | "live";
  outcome: BuildOutcome | null;
  kit: PostKit | null;
  /** Asset id → case key, for reading the kit. */
  keyOf: Record<string, string>;
  /** The keys the re-rank was shown (empty when no call was made). */
  shown: string[];
  calls: number;
  costMicroUsd: number;
  latencyMs: number;
  error?: string;
}
