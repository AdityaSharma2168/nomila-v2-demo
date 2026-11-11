/**
 * meIdentity.ts — the athlete's own public-identity statements: thin wrappers over research/confirmation.ts (PR E2b,
 * design record §1.2 T6/T8, §2.3). HER act, so athlete-authenticated (requireAuth), never admin.
 *
 *   GET  /me/identity            her identity state (E3 Axis 2) and, when a Q1 determination is in force, its candidates:
 *                                the Q1 run id and that run's evidence rows (what she may confirm as herself).
 *   POST /me/identity/confirm    { q1ResearchRunId, evidenceIds } → confirmPublicIdentity (T6, ambiguous → resolved), or
 *                                { byProof: true } → confirmByProofAffiliation (T6 by a verified proof affiliation).
 *   POST /me/identity/reject     { said? } → rejectPublicIdentity (T8, resolved → ambiguous: "that is not me").
 *
 * Tenancy: the athlete is the token's (req.athleteId); no athlete id is accepted from the client. The speaker is the
 * token's USER (req.userId, or the user row of the token's uid); the service refuses unless that user is her self user,
 * so account ownership only decides who may SPEAK, never what is resolved. Behind identityResolutionEnabled() like every
 * identity write (409 { reason: "disabled" } while it is off).
 *
 * 200 { ok: true, transition, assertedId, … } · 403 not_self · 409 state / boundary refusals · 422 evidence refusals.
 */

import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { db } from "../db";
import { researchEvidence } from "../../shared/schema";
import { findUserByUid } from "../services/intelligence/identity/users";
import { identityResolutionEnabled } from "../services/intelligence/research/config";
import { readIdentityState } from "../services/intelligence/research/identityResolution";
import { confirmByProofAffiliation, confirmPublicIdentity, rejectPublicIdentity, type ConfirmationResult } from "../services/intelligence/research/confirmation";

const logger = createLogger("routes/me-identity");
const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The speaking user: the membership-selected user, else the user row of the verified token uid. */
async function speakerOf(req: Request): Promise<string | null> {
  if (req.userId) return req.userId;
  if (!req.authUid) return null;
  return (await findUserByUid(req.authUid))?.id ?? null;
}

const STATUS: Record<string, number> = {
  not_self: 403, disabled: 409, not_ambiguous: 409, not_resolved: 409, transition_lost: 409, not_a_namesake_tie: 409,
  no_q1_run: 422, q1_run_mismatch: 422, no_evidence: 422, evidence_not_q1: 422, no_proof_affiliation: 422, proof_not_corroborated: 422,
};
function send(res: Response, r: ConfirmationResult): void {
  if (r.ok) { res.status(200).json(r); return; }
  res.status(STATUS[r.reason] ?? 409).json(r);
}

router.get("/identity", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!identityResolutionEnabled()) { res.json({ enabled: false, identity: null, candidates: null }); return; }
    const athleteId = req.athleteId!;
    const s = await readIdentityState(athleteId);
    const d = (s?.detail ?? {}) as Record<string, any>;
    const q1RunId: string | null = d.basis === "q1" ? d.researchRunId ?? null : d.q1ResearchRunId ?? null;
    const evidence = q1RunId
      ? await db.select({ id: researchEvidence.id, kind: researchEvidence.kind, claim: researchEvidence.claim, sourceUrl: researchEvidence.source_url, sourceDomain: researchEvidence.source_domain, lineage: researchEvidence.lineage_status })
        .from(researchEvidence).where(and(eq(researchEvidence.run_id, q1RunId), eq(researchEvidence.athlete_id, athleteId)))
      : [];
    res.json({
      enabled: true,
      identity: { value: s?.value ?? null, basis: d.basis ?? null, reason: d.reason ?? null, determinedAt: s?.value && s.value !== "pending" ? d.at ?? null : null },
      candidates: q1RunId ? { q1ResearchRunId: q1RunId, namesakeEvidenceIds: Array.isArray(d.namesakeEvidenceIds) ? d.namesakeEvidenceIds : [], evidence } : null,
    });
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "identity read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/identity/confirm", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const userId = await speakerOf(req);
    if (!userId) { res.status(403).json({ ok: false, reason: "not_self" }); return; }
    if (body.byProof === true) { send(res, await confirmByProofAffiliation({ athleteId: req.athleteId!, userId, source: "settings" })); return; }
    const q1ResearchRunId = typeof body.q1ResearchRunId === "string" && UUID.test(body.q1ResearchRunId) ? body.q1ResearchRunId : null;
    const evidenceIds = Array.isArray(body.evidenceIds) ? body.evidenceIds.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 50) : [];
    if (!q1ResearchRunId) { res.status(400).json({ error: "q1ResearchRunId (uuid) is required, or byProof: true" }); return; }
    if (!evidenceIds.length || evidenceIds.length !== (body.evidenceIds as unknown[]).length) { res.status(400).json({ error: "evidenceIds must be a non-empty array of evidence ids (uuid)" }); return; }
    const said = typeof body.said === "string" ? body.said.slice(0, 500) : null;
    send(res, await confirmPublicIdentity({ athleteId: req.athleteId!, userId, q1ResearchRunId, evidenceIds, said, source: "settings" }));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "identity confirm failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/identity/reject", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const userId = await speakerOf(req);
    if (!userId) { res.status(403).json({ ok: false, reason: "not_self" }); return; }
    const said = typeof body.said === "string" ? body.said.slice(0, 500) : null;
    send(res, await rejectPublicIdentity({ athleteId: req.athleteId!, userId, said, source: "settings" }));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "identity reject failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
