/**
 * athletesCurrentWriter.ts — the ONE writer of athletes_current.
 *
 * Legacy retirement P2-4 (owner decisions 8 Oct 2026): the legacy /850 score, tier, capitals and the v3 rate card
 * (pav, deal_type_rates, rate_card) are no longer computed or written. Nothing reads them (P2-3's guard); P3-1 drops
 * the columns. What is left on the row is what still has a reader:
 *
 *   • story_arc + research_updated_at — written when the caller ran research (researchAthlete);
 *   • the row itself — Studio waits for it as "her profile has been put together" (routes/studio.ts), so a social
 *     connect creates it too (fetchSocialData), touching only updated_at.
 *
 * Follower counts (the social substrate: services/followers.ts) and research counts (derived from the research by
 * every reader) are no longer copied here either.
 *
 * Callers: researchAthlete, fetchSocialData. Nothing else may write this table.
 */

import { db } from "../db";
import { athletesCurrent } from "../../shared/schema";

export interface AthletesCurrentWrite {
  athleteId: string;
  /** Present when the caller ran research; sets the story arc + research timestamp. */
  research?: { storyArc: string | null };
  now?: Date;
}

export async function writeAthletesCurrent(w: AthletesCurrentWrite): Promise<void> {
  const now = w.now ?? new Date();
  const set = {
    updated_at: now,
    ...(w.research ? { story_arc: w.research.storyArc, research_updated_at: now } : {}),
  };
  await db.insert(athletesCurrent)
    .values({ athlete_id: w.athleteId, ...set })
    .onConflictDoUpdate({ target: athletesCurrent.athlete_id, set });
}

/** The column names this writer may touch — pinned by the writer test. */
export const WRITTEN_COLUMNS = ["updated_at", "story_arc", "research_updated_at"] as const;
