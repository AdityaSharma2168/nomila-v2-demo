/**
 * record.ts — the athlete record over HTTP (PR A).
 *
 *   GET  /me/record                       everything we hold, six groups, with provenance
 *   GET  /me/record/history/:field        every receipt for one ledger field, newest first
 *   PUT  /me/record/:field  { value }     the athlete types a fact (source=settings) — a ledger
 *                                         row with a reversible receipt; "" / [] clears it
 *
 * Tenancy: athleteId comes from the token; the record read and the ledger writer both filter on
 * it. `:field` must be in the ledger vocabulary; anything else is a 400, never a column write.
 * Undo is the existing POST /me/agent-actions/:id/undo.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { getAthleteRecord, getFieldHistory } from "../services/athleteRecord";
import {
  ASSERTED_FIELDS, OnboardingFieldError, clearAssertion, recordAssertions, type AssertedField,
} from "../mila/onboarding";
import { isIdentityGovernanceField } from "../services/intelligence/identityIntelligence/governance";

const logger = createLogger("routes/record");
const router = Router();

router.get("/record", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const record = await getAthleteRecord(req.athleteId!);
    if (!record) { res.status(404).json({ error: "Athlete not found" }); return; }
    res.json(record);
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "record read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/record/history/:field", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const field = String(req.params.field);
  if (!(field in ASSERTED_FIELDS)) { res.status(400).json({ error: "Unknown field" }); return; }
  try {
    res.json({ field, items: await getFieldHistory(req.athleteId!, field) });
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, field, error: err.message }, "record history failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/record/:field", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const field = String(req.params.field);
  // Identity governance (Concept 0.4) gets its own doors (directives, disputes) in a later PR — never this one.
  if (!(field in ASSERTED_FIELDS) || isIdentityGovernanceField(field)) { res.status(400).json({ error: "Unknown field" }); return; }
  const { value, said } = (req.body ?? {}) as { value?: unknown; said?: unknown };
  if (value === undefined) { res.status(400).json({ error: "value is required" }); return; }
  const empty = value === null || value === "" || (Array.isArray(value) && value.length === 0);
  try {
    if (empty) {
      const cleared = await clearAssertion({ athleteId, field: field as AssertedField, mode: "form", source: "settings" });
      res.json({ ok: true, field, cleared: !!cleared, agent_action_id: cleared?.agent_action_id ?? null });
      return;
    }
    const [saved] = await recordAssertions({
      athleteId, runId: null, mode: "form", source: "settings",
      corrections: [{ field: field as AssertedField, value: value as any, ...(typeof said === "string" && said.trim() ? { said: said.trim().slice(0, 280) } : {}) }],
    });
    res.json({ ok: true, field, value: saved.value, agent_action_id: saved.agent_action_id });
  } catch (err: any) {
    if (err instanceof OnboardingFieldError) { res.status(400).json({ error: err.message }); return; }
    logger.error({ athleteId, field, error: err.message }, "record write failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
