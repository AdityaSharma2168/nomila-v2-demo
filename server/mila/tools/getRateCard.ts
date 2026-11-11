/**
 * getRateCard.ts — Mila read tool: what the athlete charges.
 *
 * Legacy retirement, phase 1 (owner decision 8 Oct 2026): the computed v3 rate card
 * (`athletes_current.rate_card` — per-platform post rates, appearance/ambassador ranges and the
 * projected annual value) is retired and is NO LONGER read here. Its numbers contradicted what the
 * athlete could see (a per-post rate on a platform she no longer posts to), and a new rate model
 * does not exist yet.
 *
 * What remains is HER OWN words: the per-deal-type floor she set (`deal_preferences.minimum_rates`,
 * written by Brand › Rates — "the least you'll take"). The tool always answers with
 * `rates_status: "being_rebuilt"` so the model can say so plainly, plus her floor when she set one.
 * It never returns a computed or market figure. The tool keeps its name so chips and status labels
 * that already know it are unchanged.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import type { MilaTool } from "../types";

/** The floor keys Brand › Rates writes, with the words the model should use for them. */
const FLOOR_KEYS: Array<[key: string, label: string]> = [
  ["socialPost", "per_social_post"],
  ["appearance", "per_appearance"],
  ["ambassador", "per_month_ambassador"],
  ["autograph", "per_autograph_deal"],
  ["licensing", "licensing_minimum"],
];

const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** Her own floors, keyed for the model; null when she set none. Pure, exported for tests. */
export function ownFloors(dealPreferences: unknown): Record<string, number> | null {
  const prefs = (dealPreferences ?? {}) as { minimum_rates?: Record<string, unknown> };
  const out: Record<string, number> = {};
  for (const [key, label] of FLOOR_KEYS) {
    const v = positive(prefs.minimum_rates?.[key]);
    if (v !== null) out[label] = v;
  }
  return Object.keys(out).length ? out : null;
}

export const getRateCardTool: MilaTool<z.ZodObject<Record<string, never>>> = {
  name: "get_rate_card",
  description:
    "Get what the athlete charges. Nomila's rate estimates are being rebuilt, so this returns " +
    "NO computed rates, NO per-post rates and NO projected annual value — only `your_floor`: the " +
    "least the athlete themself said they will take, per deal type, in dollars (null when they " +
    "haven't set one). Say plainly that rates are being rebuilt; quote that floor as THEIR number " +
    "when they set one; never invent or estimate a rate.",
  argsSchema: z.object({}),
  async execute(athleteId, _args) {
    const [row] = await db
      .select({ deal_preferences: athletes.deal_preferences })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1);

    return {
      rates_status: "being_rebuilt",
      your_floor: ownFloors(row?.deal_preferences),
    };
  },
};
