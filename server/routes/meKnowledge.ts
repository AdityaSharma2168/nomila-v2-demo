/**
 * meKnowledge.ts — Concept 0.4 Slice 1 reads + the knowledge/3 "This isn't right" write (Concept 0.4 PR 4).
 *
 *   GET /me/overview    the Me identity header: name, photo, factual identity, what Nomila knows (counts per category).
 *                       M.I.A. and Story are `coming` (Slices 2 and 3); never the legacy score.
 *   GET /me/knowledge   "What Nomila Knows": key facts + categories, every entry with a source label from canonical
 *                       provenance and, where she can correct it, the asserted field PUT /me/record/:field writes.
 *
 *   POST /me/knowledge/disputes  { entryId, said? } — "This isn't right" for an entry with no correction field: an
 *                       athlete_asserted `dispute` row via the existing assertion writer (services/athleteKnowledge.ts).
 *                       201 { ok, entryId, assertedId, target } · 400 bad body · 404 no such entry for HER · 409 nothing on
 *                       record to dispute. No intelligence recompute.
 *
 * Tenancy: athleteId comes from the token. Corrections use the existing PUT /me/record/:field (routes/record.ts).
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { OnboardingFieldError } from "../mila/onboarding";
import { disputeKnowledgeEntry, getAthleteKnowledge, getMeOverview } from "../services/athleteKnowledge";

const logger = createLogger("routes/meKnowledge");
const router = Router();

router.get("/overview", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const out = await getMeOverview(req.athleteId!);
    if (!out) { res.status(404).json({ error: "Athlete not found" }); return; }
    res.json(out);
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "overview read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/knowledge", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const out = await getAthleteKnowledge(req.athleteId!);
    if (!out) { res.status(404).json({ error: "Athlete not found" }); return; }
    res.json(out);
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: err.message }, "knowledge read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/knowledge/disputes", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { entryId, said } = (req.body ?? {}) as { entryId?: unknown; said?: unknown };
  if (typeof entryId !== "string" || !entryId.trim() || entryId.length > 200) { res.status(400).json({ error: "entryId is required" }); return; }
  if (said != null && typeof said !== "string") { res.status(400).json({ error: "said must be text" }); return; }
  try {
    const out = await disputeKnowledgeEntry(req.athleteId!, entryId.trim(), (said as string | null | undefined) ?? null);
    if (!out.ok) { res.status(out.status).json({ error: out.error }); return; }
    res.status(201).json(out);
  } catch (err: any) {
    if (err instanceof OnboardingFieldError) { res.status(400).json({ error: err.message }); return; }
    logger.error({ athleteId: req.athleteId, error: err.message }, "knowledge dispute failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
