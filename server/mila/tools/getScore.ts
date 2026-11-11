/**
 * getScore.ts — Mila read tool: the athlete's current M.I.A. score.
 *
 * The score is the ledger read of record (`buildMyIntelligence`, my-intelligence) — never the
 * legacy `athletes_current.display_score` / `tier` / `capitals`, which are a different,
 * disagreeing scale. `null` score when there is no assessed read, or the page withholds it
 * (ambiguous/failed identity) — the model is told to say it doesn't know rather than invent one.
 *
 * Legacy retirement, phase 1 (owner decision 8 Oct 2026): the legacy projected annual value (PAV)
 * and rate card are NO LONGER returned. They came from the retired v3 rate model and contradicted
 * what the athlete can see (per-post rates on a dormant platform). What the score is made of comes
 * from the same ledger read: the M.I.A. dimensions marked as strengths and as room to grow, with
 * their 0–100 scores — never raw evaluator prose.
 *
 * Follower counts come from the social substrate (services/followers.ts, legacy retirement P2-3), not from
 * `athletes_current`.
 */

import { z } from "zod";
import { readFollowers } from "../../services/followers";
import { buildMyIntelligence, type MyIntelligenceDimension } from "../../services/intelligence/views/myIntelligence";
import type { MilaTool } from "../types";

/** "athletic_authority" → "athletic authority". */
const dimensionName = (key: string): string => key.replace(/_/g, " ");

/** Scored dimensions in one state, strongest first. */
export function dimensionsIn(dims: Pick<MyIntelligenceDimension, "key" | "state" | "score">[], state: "strength" | "gap") {
  return dims
    .filter((d) => d.state === state && typeof d.score === "number")
    .sort((a, b) => (b.score as number) - (a.score as number))
    .map((d) => ({ dimension: dimensionName(d.key), score: d.score as number }));
}

export const getScoreTool: MilaTool<z.ZodObject<Record<string, never>>> = {
  name: "get_score",
  description:
    "Get the athlete's current M.I.A. score (out of 850), what it is made of — the M.I.A. " +
    "dimensions that are strengths and the ones with room to grow, each scored 0-100 — and " +
    "follower counts per platform. display_score is null when no score has been assessed yet: " +
    "say the score isn't available, never guess a number. This tool carries NO rates and NO " +
    "projected annual value.",
  argsSchema: z.object({}),
  async execute(athleteId, _args) {
    const [followers, mi] = await Promise.all([readFollowers(athleteId), buildMyIntelligence(athleteId)]);
    const assessment = mi.assessment;
    const anyCount = Object.values(followers.counts).some((n) => n != null);

    // Nothing at all to say: no assessment and no platform counts.
    if (!assessment && !anyCount) return null;

    const dims = assessment?.dimensions ?? [];
    return {
      display_score: assessment?.score ?? null,
      out_of: 850,
      evidence_as_of: assessment?.evidenceAsOf ?? null,
      strengths: dimensionsIn(dims, "strength"),
      room_to_grow: dimensionsIn(dims, "gap"),
      followers: anyCount
        ? {
            instagram: followers.counts.instagram,
            tiktok: followers.counts.tiktok,
            x: followers.counts.x,
            youtube: followers.counts.youtube,
          }
        : null,
    };
  },
};
