/**
 * snapshotRows.ts — which athlete_snapshots rows count as "the athlete's latest snapshot".
 *
 * A periodic First Look refresh (skills/firstLook.ts → refreshFirstLook) writes its own row with
 * trigger 'first_look' that carries ONLY `first_look` — no social, score, research or deals. Any
 * reader that takes "the newest row" as the scoring state (the previous social to merge into, the
 * previous snapshots for scoring history, the score history itself) must skip those rows, or a
 * refresh would look like an empty snapshot. First Look readers filter on the `first_look` column
 * and are unaffected.
 */

import { and, eq, ne, type SQL } from "drizzle-orm";
import { athleteSnapshots } from "../../shared/schema";

export const FIRST_LOOK_SNAPSHOT_TRIGGER = "first_look";

/** WHERE clause for an athlete's snapshot rows that carry scoring state (every trigger except 'first_look'). */
export function scoringSnapshotsOf(athleteId: string): SQL {
  return and(eq(athleteSnapshots.athlete_id, athleteId), ne(athleteSnapshots.trigger, FIRST_LOOK_SNAPSHOT_TRIGGER))!;
}
