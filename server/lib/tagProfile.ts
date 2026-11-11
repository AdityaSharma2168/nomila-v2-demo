/**
 * tagProfile — who the vision taggers are told to look for (lib/visionTag.ts `AthleteProfile`):
 * full_name · sport, read off the athlete row. No new schema. Null when the row is gone.
 *
 * Its own module so the photo lane (services/mediaEnrichment.ts), the review route
 * (routes/media.ts) and the clip lane (studio/enrich/videoEnrichment.ts) read one copy without any
 * of them importing another. Cached per process for a minute, so a chunk of one athlete's rows
 * reads her row once rather than once per asset.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { athletes } from "../../shared/schema";
import type { AthleteProfile } from "./visionTag";

/*
 * ⚠️ NAME AND SPORT ONLY. The athlete row's school column is a PROJECTION read only by an
 * allow-list (services/intelligence/context/sourceGuard.test.ts G5, "never add without a design
 * entry" — and that guard greps for the column's name, so it is not written here even in prose).
 * The profile is not worth a design entry: the tagger tells her from a stranger by name and sport.
 * `team` stays on the type, null here, for a reader with a sanctioned source (athlete_affiliations).
 */

const PROFILE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; profile: AthleteProfile | null }>();

export async function tagProfileFor(
  athleteId: string,
): Promise<AthleteProfile | null> {
  const hit = cache.get(athleteId);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const [row] = await db
    .select({
      name: athletes.full_name,
      sport: athletes.sport,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const profile: AthleteProfile | null = row
    ? { name: row.name, sport: row.sport ?? null, team: null }
    : null;
  cache.set(athleteId, { at: Date.now(), profile });
  return profile;
}

/** Test seam: forget every cached row. */
export const forgetTagProfiles = (): void => cache.clear();
