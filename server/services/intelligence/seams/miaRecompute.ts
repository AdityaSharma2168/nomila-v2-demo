/**
 * seams/miaRecompute.ts — the dev/admin seam that recomputes M.I.A. for ONE athlete, asking the identity gate FIRST.
 *
 * Same request the existing admin manual refresh makes (requestEvaluation, USER_REQUESTED_REFRESH, force: a person
 * asking anyway bypasses the digest comparison, never the gate), behind the same preflight PR H2 gave that route
 * (miaIdentityPreflight): with the identity boundary on and her public identity not resolved, nothing is enqueued and
 * the caller gets the held-for-identity result (`{ held: "identity", identity: { value, reason } }`). The H1 choke point
 * (miaIdentityGate, at the snapshot step) stays the final guard. Boundary off ⇒ never held (Beta.1 behaviour).
 */

import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { athletes } from "../../../../shared/schema";
import { miaIdentityPreflight, requestEvaluation } from "../../marketabilityBeta1Orchestrator";
import type { IdentityValue } from "../research/identityResolution";

export type MiaRecomputeResult =
  | { outcome: "not_found" }
  | { outcome: "no_sport" }
  | { outcome: "held"; held: "identity"; identity: { value: IdentityValue; reason: string | null } }
  | { outcome: "requested"; runId: string; created: boolean };

/**
 * Preflight, then the existing manual-refresh request. `kick` is the runner's default (inline), exactly as the existing
 * admin route requests it; the forced run has its own active scope, so it never joins a debounced one.
 */
export async function requestMiaRecompute(athleteId: string, opts: { reason?: string | null; createdBy?: string } = {}): Promise<MiaRecomputeResult> {
  const [a] = await db.select({ id: athletes.id, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return { outcome: "not_found" };
  if (!a.sport) return { outcome: "no_sport" };
  const pre = await miaIdentityPreflight(athleteId);
  if (pre.held) return { outcome: "held", held: pre.held, identity: pre.identity };
  const { runId, created } = await requestEvaluation({ athleteId, trigger: "USER_REQUESTED_REFRESH", force: true, reason: opts.reason ?? null, createdBy: opts.createdBy ?? "admin_dev_seam" });
  return { outcome: "requested", runId, created };
}
