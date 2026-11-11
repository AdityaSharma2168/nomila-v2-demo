/**
 * meMemory.ts — Me on the agent memory: the Scouting report and What Nomila knows (shared/meScouting.ts).
 *
 *   GET    /me/scouting               scouting/1 — hero, what defines you, M.I.A., working for you / room to grow,
 *                                     your brands, the Knows door. SELECTs only; no model call.
 *   GET    /me/facts?subject=         knows/1 — facts grouped by topic; subject = athlete (default) | others | all.
 *                                     Care facts only in `private` (only you see them); hidden facts in `hidden`.
 *   GET    /me/facts/:id              one fact: sources, history (versions + reviews), where it is used
 *   PATCH  /me/facts/:id   { claim, date? }   your correction: a new "said" fact supersedes the old one → 200 { fact, rerun }
 *                                     409 { error, code, currentId } when it was already replaced
 *   DELETE /me/facts/:id   { note? }  hide (status removed) → 200 { rerun }
 *   POST   /me/facts/:id/restore      undo a hide → 200 { fact, rerun }
 *   POST   /me/facts/:id/dispute { said? }  "this isn't right" → status disputed → 200 { seed, rerun } (the app opens Mila)
 *   POST   /me/facts/:id/confirm      "that's right" → 204; re-runs nothing
 *   GET    /me/handles                the Instagram / YouTube handles she confirmed (with the latest public reading) and
 *                                     the ones research found for her to confirm ("Is this you?")
 *   POST   /me/handles/confirm { platform, handle }   "this is my Instagram / YouTube": her word as a said fact, then one
 *                                     public API read (Business Discovery / YouTube Data API) → 200 { lookup, followers,
 *                                     measured }. Both 404 unless LEAN_SIGNUP_RESEARCH (the scoring source rule's step:
 *                                     agent/research/publicPlatform.ts)
 *
 * An athlete with no memory facts gets { contract, status: "no_memory" } from both reads, so the app keeps the old
 * screens for them. Edits queue a re-run of only what used the fact (agent/memoryRerun.ts) after a 30-minute window.
 *
 * Tenancy: athleteId comes from the token only; another athlete's fact id is a 404.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { FACT_SUBJECT_FILTERS, type FactSubjectFilter } from "../../shared/agent";
import { confirmFact, correctFact, disputeFact, getFactDetail, getKnows, hideFact, KnowsError, restoreFact } from "../services/meKnows";
import { getScoutingReport } from "../services/meScouting";
import { confirmHandle, HandleError, readHandles } from "../agent/research/publicPlatform";

const logger = createLogger("routes/meMemory");
const router = Router();

function fail(res: Response, req: Request, err: any, what: string): void {
  if (err instanceof KnowsError) { res.status(err.status).json({ error: err.message, code: err.code, ...err.extra }); return; }
  logger.error({ athleteId: req.athleteId, error: String(err?.message ?? err).slice(0, 300) }, what);
  res.status(500).json({ error: "Internal server error" });
}

router.get("/scouting", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json(await getScoutingReport(req.athleteId!)); } catch (err) { fail(res, req, err, "scouting read failed"); }
});

router.get("/facts", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const raw = req.query.subject;
  const subject = raw == null || raw === "" ? "athlete" : raw;
  if (typeof subject !== "string" || !(FACT_SUBJECT_FILTERS as readonly string[]).includes(subject)) {
    res.status(400).json({ error: `subject must be one of ${FACT_SUBJECT_FILTERS.join(", ")}`, code: "invalid" }); return;
  }
  try { res.json(await getKnows(req.athleteId!, subject as FactSubjectFilter)); } catch (err) { fail(res, req, err, "knows read failed"); }
});

router.get("/facts/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json(await getFactDetail(req.athleteId!, String(req.params.id))); } catch (err) { fail(res, req, err, "fact read failed"); }
});

router.patch("/facts/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json(await correctFact(req.athleteId!, String(req.params.id), req.body ?? {})); } catch (err) { fail(res, req, err, "fact correction failed"); }
});

router.delete("/facts/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json({ rerun: await hideFact(req.athleteId!, String(req.params.id), req.body ?? {}) }); } catch (err) { fail(res, req, err, "fact hide failed"); }
});

router.post("/facts/:id/restore", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json(await restoreFact(req.athleteId!, String(req.params.id))); } catch (err) { fail(res, req, err, "fact restore failed"); }
});

router.post("/facts/:id/dispute", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json(await disputeFact(req.athleteId!, String(req.params.id), req.body ?? {})); } catch (err) { fail(res, req, err, "fact dispute failed"); }
});

router.post("/facts/:id/confirm", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { await confirmFact(req.athleteId!, String(req.params.id)); res.status(204).end(); } catch (err) { fail(res, req, err, "fact confirm failed"); }
});

const handlesOn = () => process.env.LEAN_SIGNUP_RESEARCH === "true";
const handleLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

router.get("/handles", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!handlesOn()) { res.status(404).json({ error: "Not found" }); return; }
  try { res.json(await readHandles(req.athleteId!)); } catch (err) { fail(res, req, err, "handles read failed"); }
});

router.post("/handles/confirm", requireAuth, handleLimiter, async (req: Request, res: Response): Promise<void> => {
  if (!handlesOn()) { res.status(404).json({ error: "Not found" }); return; }
  try { res.json(await confirmHandle(req.athleteId!, req.body ?? {})); }
  catch (err: any) {
    if (err instanceof HandleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    fail(res, req, err, "handle confirm failed");
  }
});

export default router;
