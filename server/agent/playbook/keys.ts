/**
 * agent/playbook/keys.ts — the distinct (sport, stage, platform) keys the daily playbook refresh should cover:
 * enumerated from the LIVE roster, never a hard-coded cross product (design "Moments → post kits" §5: "only the
 * combinations at least one current athlete is actually in, so the monthly refresh never pays for a key nobody
 * needs").
 *
 * A key needs:
 *   · an athlete with a current Brief (memory_briefs.status = 'current') — one who has been through Understand;
 *   · a sport (athletes.sport is not null/blank) — folded to `lower(trim())` (review fix, PR #929: read.ts looks a
 *     key up by whatever a caller spells its sport as, so the roster and the read side must fold the same way or a
 *     lookup silently misses on case or stray whitespace alone — "soccer", " Soccer", "Soccer " are one key, not
 *     three);
 *   · a KNOWN stage band (display.stage.band, one of shared/playbook.ts PLAYBOOK_STAGES — "unclear" is excluded: an
 *     athlete whose stage is not yet known cannot be specific to one);
 *   · at least one ACTIVE social identity (social_identities.status = 'active') — the platform list this way grows
 *     with the connectors in server/lib/integrations/registry.ts, never a list this file has to know about.
 */
import { and, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes, memoryBriefs, socialIdentities } from "../../../shared/schema";
import { PLAYBOOK_STAGES, type PlaybookKey, type PlaybookStage } from "../../../shared/playbook";

/** `lower(trim())`, in SQL, applied identically everywhere a sport is read for a playbook key. */
const sportExpr = sql<string>`lower(trim(${athletes.sport}))`;
const stageExpr = sql<string>`(${memoryBriefs.display}->'stage'->>'band')`;
const stageList = () => sql.join(PLAYBOOK_STAGES.map((s) => sql`${s}`), sql`, `);

export interface RosterPlaybookKey {
  key: PlaybookKey;
  /** How many current athletes sit at this key today (grounding for the skill; never named in its output). */
  athleteCount: number;
}

/** Every distinct (sport, stage, platform) key at least one current athlete is in, with how many. Injectable for tests. */
export async function rosterPlaybookKeys(): Promise<RosterPlaybookKey[]> {
  const rows = await db
    .select({ sport: sportExpr, stage: stageExpr, platform: socialIdentities.platform, athleteCount: sql<number>`count(distinct ${athletes.id})` })
    .from(athletes)
    .innerJoin(memoryBriefs, sql`${memoryBriefs.athlete_id} = ${athletes.id} AND ${memoryBriefs.status} = 'current'`)
    .innerJoin(socialIdentities, sql`${socialIdentities.athlete_id} = ${athletes.id} AND ${socialIdentities.status} = 'active'`)
    .where(sql`${athletes.sport} IS NOT NULL AND length(trim(${athletes.sport})) > 0 AND ${stageExpr} IN (${stageList()})`)
    .groupBy(sportExpr, stageExpr, socialIdentities.platform);

  // sport/stage/platform are each guaranteed non-null by the WHERE/JOIN conditions above, not re-checked in JS.
  return rows.map((r) => ({ key: { sport: r.sport, stage: r.stage as PlaybookStage, platform: r.platform }, athleteCount: Number(r.athleteCount) || 0 }));
}

/**
 * The same (sport, stage) derivation, for ONE athlete — used by read.ts getPlaybookForAthlete so a caller can never
 * hand it a sport/stage that drifted from what the roster query itself would say for her. Null when she does not yet
 * have a current Brief, a sport, or a known (non-"unclear") stage band — the same gate rosterPlaybookKeys applies.
 */
export async function athletePlaybookKeyBase(athleteId: string): Promise<{ sport: string; stage: PlaybookStage } | null> {
  const [row] = await db
    .select({ sport: sportExpr, stage: stageExpr })
    .from(athletes)
    .innerJoin(memoryBriefs, sql`${memoryBriefs.athlete_id} = ${athletes.id} AND ${memoryBriefs.status} = 'current'`)
    .where(and(sql`${athletes.id} = ${athleteId}`, sql`${athletes.sport} IS NOT NULL AND length(trim(${athletes.sport})) > 0 AND ${stageExpr} IN (${stageList()})`))
    .limit(1);
  return row ? { sport: row.sport, stage: row.stage as PlaybookStage } : null;
}
