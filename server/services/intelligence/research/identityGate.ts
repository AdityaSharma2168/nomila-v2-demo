/**
 * research/identityGate.ts — the research_refresh v3 Q1 identity gate (PR E2a; design record
 * docs/architecture/phase-a/pr-e-identity-resolution-design.md §5.2, §5.3, D9, D18).
 *
 * THE ONLY v3 writer of the athlete-level identity determination: it is the single E2a importer of
 * applyIdentityTransition (the allow-list in identityResolution.test.ts names exactly this file). Everything here reads
 * identityResolutionEnabled() — the one boundary PR E and PR H share.
 *
 *   enforced     the run governs identity (runInput.governIdentity) AND identityResolutionEnabled(). Q2–Q6 and the
 *                signals step run only while the athlete's determination reads `resolved` (read fresh, every step);
 *                otherwise their domains go back into `pending` with reason `identity_gate` (D18) and nothing is called.
 *   observed     anything else (calibration, D9; a run that does not govern identity): the gate is computed and recorded
 *                as `wouldGate`, never enforced, and NOTHING is written — no determination, no pending hold.
 *
 * Q1 itself is never gated. After Q1 persists, the caller classifies it (classifyQ1, pure) and hands the determination
 * here: applyIdentityTransition compares-and-sets from what was just read. A T5 (no determination) writes nothing; a
 * lost CAS is a returned result (a late Q1 never overwrites an athlete's confirmation), never an error.
 */

import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { athleteResearchState } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { identityResolutionEnabled } from "./config";
import { applyIdentityTransition, readIdentityState, type ApplyResult, type IdentityValue, type Q1Determination } from "./identityResolution";
import type { ResearchDomain } from "./registries";
import type { PendingRequest } from "./triggers";

const logger = createLogger("research-identity-gate");

/** The pending reason a gate hold records (the status contract's `heldBy`, E3). */
export const IDENTITY_GATE_REASON = "identity_gate";

/** Whether this run's gate is enforced (and its Q1 determination written) or only observed. */
export function identityGateEnforced(governIdentity: boolean): boolean {
  return governIdentity && identityResolutionEnabled();
}

export interface GateCheck {
  enforced: boolean;
  /** The determination as read now (NULL = none recorded; never treated as pending). */
  value: IdentityValue;
  /** The step must not run: enforced and the athlete is not `resolved`. */
  hold: boolean;
}

/** Read the athlete's determination fresh and decide whether an identity-dependent step may run. */
export async function checkIdentityGate(athleteId: string, governIdentity: boolean): Promise<GateCheck> {
  const enforced = identityGateEnforced(governIdentity);
  const value = (await readIdentityState(athleteId))?.value ?? null;
  return { enforced, value, hold: enforced && value !== "resolved" };
}

/**
 * Re-queue gate-held domains in `pending` (reason `identity_gate`, D18) so the next planner pass runs them once identity
 * resolves. Same concurrency as requestRefresh: one transaction, row lock, merge de-duplicated by domain, 50-entry bound.
 * Writes nothing unless the gate is enforced (which implies the one execution gate is open).
 */
export async function holdForIdentityGate(athleteId: string, domains: readonly ResearchDomain[], governIdentity: boolean, asOf: Date = new Date()): Promise<{ held: ResearchDomain[] }> {
  if (!identityGateEnforced(governIdentity) || !domains.length) return { held: [] };
  const wanted = [...new Set(domains)];
  const requests: PendingRequest[] = wanted.map((domain) => ({ domain, trigger: "event", reason: IDENTITY_GATE_REASON, requestedAt: asOf.toISOString() }));
  await db.transaction(async (tx) => {
    await tx.insert(athleteResearchState).values({ athlete_id: athleteId, research_status: "seed_only" }).onConflictDoNothing();
    const [row] = await tx.select({ pending: athleteResearchState.pending }).from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)).limit(1).for("update");
    const existing = (row?.pending ?? []) as PendingRequest[];
    const merged = [...existing.filter((p) => !wanted.includes(p.domain)), ...requests].slice(-50);
    await tx.update(athleteResearchState).set({ pending: merged as any, updated_at: new Date() }).where(eq(athleteResearchState.athlete_id, athleteId));
  });
  logger.info({ athleteId, domains: wanted }, "identity gate: domains held in pending");
  return { held: wanted };
}

export interface Q1GateInput {
  athleteId: string;
  governIdentity: boolean;
  determination: Q1Determination;
  researchRunId: string;
  workflowRunId: string | null;
  /** Hash of the anchor Q1 was asked with, and of the anchor as read when its answer came back (§1.2 T2). */
  requestAnchorHash: string;
  currentAnchorHash: string;
  namesakeEvidenceIds: string[];
  at?: Date;
}

export type Q1GateResult = ApplyResult | { written: false; reason: "observed" };

/**
 * Apply Q1's determination (T2 resolved / T3 ambiguous / T4 failed; T10 refresh; T5 no write) by compare-and-set from
 * the value read now. Observed runs (calibration, governIdentity false, or the boundary off) write nothing (D9).
 * Idempotent on a step retry: re-applying the same determination is a no-op, a refusal or a provenance refresh (T10).
 */
export async function applyQ1Gate(i: Q1GateInput): Promise<Q1GateResult> {
  if (!identityGateEnforced(i.governIdentity)) return { written: false, reason: "observed" };
  const current = (await readIdentityState(i.athleteId)) ?? { value: null, detail: null };
  const r = await applyIdentityTransition(i.athleteId, current, {
    kind: "q1", determination: i.determination, researchRunId: i.researchRunId, workflowRunId: i.workflowRunId,
    requestAnchorHash: i.requestAnchorHash, currentAnchorHash: i.currentAnchorHash, namesakeEvidenceIds: i.namesakeEvidenceIds,
  }, { at: i.at });
  logger.info({ athleteId: i.athleteId, outcome: i.determination.outcome, result: r }, "identity gate: Q1 determination");
  return r;
}
