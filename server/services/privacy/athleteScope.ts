/**
 * athleteScope.ts — resolve who an account deletion / export is for, once, before anything is read or deleted.
 *
 * The sign-in users are resolved up front because the rows that link them (athlete_users) are deleted before the
 * users themselves. A user who also belongs to another athlete is never included.
 */

import { sql } from "drizzle-orm";
import type { AthleteScope } from "../../lib/athleteDataManifest";
import { exclusiveUserIdsOfAthlete } from "../intelligence/identity/users";

/** drizzle's execute() returns { rows } on node-postgres and PGlite alike. */
export const rowsOf = <T = Record<string, unknown>>(r: unknown): T[] => ((r as any)?.rows ?? r) as T[];

export interface Executor { execute: (q: any) => Promise<unknown> }

export interface ResolvedScope extends AthleteScope { authId: string | null }

export async function resolveAthleteScope(exec: Executor, athleteId: string): Promise<ResolvedScope | null> {
  const [athlete] = rowsOf<{ auth_id: string | null }>(
    await exec.execute(sql`SELECT auth_id FROM athletes WHERE id = ${athleteId}::uuid`),
  );
  if (!athlete) return null;
  const authId = athlete.auth_id ?? null;
  const userIds = await exclusiveUserIdsOfAthlete(athleteId, authId, exec);
  return { athleteId, userIds, authId };
}
