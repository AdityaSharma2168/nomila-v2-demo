/**
 * deletionFence.ts — is this athlete's account being deleted? (account deletion phase 1, 0145)
 *
 * Phase 1 of an account delete sets athletes.deletion_requested_at in one small transaction. From then on:
 *   - requireAuth refuses the athlete's requests (lib/auth.ts authenticateRequest);
 *   - no workflow run starts for them, and a claimed step of theirs stops at its checkpoint (workflow/runner.ts);
 *   - no Mila turn starts for them, an in-flight turn writes nothing more (agent/engine/mastra/turn.ts, agent/trace.ts),
 *     and Mila's tools refuse their pass (agent/callTool.ts, every call).
 *   - no tool call runs for them, whichever engine or caller (agent/callTool.ts checks it on every call, reusing an
 *     engine's fresh clearFence result), and the approve tap runs nothing (agent/approvals.ts executeAgentAction).
 * Phase 2 (workflow/definitions/accountDeletion.ts) purges the rows, the athletes row last; after that the foreign keys
 * refuse any straggler write.
 *
 * A missing athlete row reads as deleting too: whoever still holds the id is holding a deleted account.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

const rowsOf = <T>(r: unknown): T[] => ((r as any)?.rows ?? r) as T[];

export class AthleteDeletingError extends Error {
  readonly code = "athlete_deleting";
  constructor(public readonly athleteId: string) {
    super("This account is being deleted");
    this.name = "AthleteDeletingError";
  }
}

/** True when the athlete asked to delete the account (or the row is already gone). */
export async function isAthleteDeleting(athleteId: string): Promise<boolean> {
  const [row] = rowsOf<{ deleting: boolean }>(await db.execute(sql`
    SELECT deletion_requested_at IS NOT NULL AS deleting FROM athletes WHERE id = ${athleteId}::uuid
  `));
  return row ? Boolean(row.deleting) : true;
}

/** Throws AthleteDeletingError when the account is being deleted. */
export async function assertAthleteNotDeleting(athleteId: string): Promise<void> {
  if (await isAthleteDeleting(athleteId)) throw new AthleteDeletingError(athleteId);
}

// ─── the per-call fence, reused within a turn ──────────────────────────────────────────────────────────────────────
// callTool (agent/callTool.ts) checks the fence on EVERY tool call, whichever engine runs it. An engine that has just
// checked it for this call (the Mastra tool wrapper, per call) hands its result over as a clearance, so
// the call does not read the athletes row twice. A clearance is minted only here, for one athlete, and is honoured only
// while it is fresh: a deletion asked mid-turn is still seen by the next call after FENCE_REUSE_MS at the latest.

/** How long a clearance may stand in for a fresh read (ms). */
export const FENCE_REUSE_MS = 5_000;

/** "Not being deleted", as checked at `at` for `athleteId`. Only clearFence makes one that isFreshClearance accepts. */
export interface FenceClearance {
  readonly athleteId: string;
  readonly at: number;
}

const minted = new WeakSet<FenceClearance>();

/**
 * Check the fence and, when the athlete is NOT being deleted, return a clearance for the calls that follow; null when
 * fenced. Fails closed: a check that throws counts as fenced.
 */
export async function clearFence(
  athleteId: string,
  isDeleting: (athleteId: string) => Promise<boolean> = isAthleteDeleting,
): Promise<FenceClearance | null> {
  if (await isDeleting(athleteId).catch(() => true)) return null;
  const c: FenceClearance = Object.freeze({ athleteId, at: Date.now() });
  minted.add(c);
  return c;
}

/** True when `c` was minted by clearFence for this athlete within FENCE_REUSE_MS. */
export function isFreshClearance(c: FenceClearance | undefined, athleteId: string, now: number = Date.now()): boolean {
  return !!c && minted.has(c) && c.athleteId === athleteId && now - c.at >= 0 && now - c.at < FENCE_REUSE_MS;
}
