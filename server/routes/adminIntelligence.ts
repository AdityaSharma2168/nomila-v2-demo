/**
 * adminIntelligence.ts — DEVELOPMENT / ADMIN SEAMS for the modern intelligence pipeline, one athlete at a time.
 *
 * Mounted INSIDE the admin router (routes/admin.ts → /api/v1/admin/intelligence), so every route inherits requireAdmin:
 * the `admin` role. Athlete-general: no person, sport or school is known
 * here. Production lifecycle and cost policy are NOT decided here: these are deliberate operator acts that exercise the
 * pipeline for any specified athlete. Nothing here flips a flag; every research / identity write stays behind
 * identityResolutionEnabled() (a 409 { reason: "disabled" } while it is off).
 *
 *   POST /athletes/:athleteId/resolve-identity   body { promoteWithoutAccount?: true, label?: string }
 *        adminResolveIdentity: T1 (admin) from NULL, T7 (admin) from ambiguous | failed, then a Q1-only governed run,
 *        executed inline. An athlete with NO account is entered only with promoteWithoutAccount: true (the design
 *        record's "deliberately promoted" public athlete). Keyed per pending episode, so a same-day re-resolve after an
 *        ambiguous / failed result runs Q1 again; `label` is an explicit retry within one episode.
 *        200 { started: true, transition, workflowRunId, created, runStatus, account, identity } · 409 { started: false,
 *        reason } (disabled, no_self_membership, resolved_sticky, transition_refused) · 404 no athlete · 422 no sport.
 *
 *   POST /athletes/:athleteId/research           body { domains?: ResearchDomain[], label?: string, wait?: boolean }
 *        adminRunResearch: governed research_refresh v3 for an athlete already in governed resolution — the FULL plan
 *        (Q1–Q6 + signals) when `domains` is omitted, else the queries of those domains — under its own key, so it runs
 *        the same UTC day as her Q1 run. The identity gate holds inside the run (Q2–Q6 only once resolved). Default:
 *        queued for the service's workflow tick (202); wait: true runs it inline (200).
 *        409 { reason } identity_not_entered | identity_not_resolved | run_in_flight | disabled · 404 · 422 · 400.
 *
 *   POST /athletes/:athleteId/mia/recompute      body { reason?: string }
 *        The existing manual M.I.A. refresh request, preflighted by the identity gate: 202 { runId, created } ·
 *        409 { error, held: "identity", identity: { value, reason }, athleteId } (nothing enqueued) · 404 · 422.
 *
 *   POST /athletes/:athleteId/identity-intelligence/recompute   body { force?: true }
 *        Concept 0.4 Identity Intelligence v0, run ONCE synchronously (one synthesis call, one repair at most):
 *        200 IdentityRunResult { outcome: persisted | skipped_unchanged | insufficient | validation_failed |
 *        provider_error, entryId, value, validation[], sufficiency, runId } · 404. Runs whatever IDENTITY_INTELLIGENCE_ENABLED
 *        says (the flag gates the athlete read, not this operator act); force: true ignores an unchanged inputVersion.
 *        Every model answer, passed or rejected, is kept in identity_intelligence_attempts under `runId`.
 *
 *   POST /athletes/:athleteId/knowledge/reprocess   body { dryRun?: true }
 *        Concept 0.4 PR 4: generic deterministic reprocessing of research Nomila ALREADY holds — today's item mapping +
 *        fact registry + resolver over the stored payloads / evidence (research/reprocessKnowledge.ts). No provider call,
 *        no new evidence; created facts keep the original evidence ids + timestamps and a `reprocessed` marker;
 *        idempotent. 200 ReprocessReport { counts: examined/created/unchanged/refused/proposed, … } · 404 ·
 *        409 { reason: "disabled" } when a write is asked while RESEARCH_SUBSTRATE_WRITE is off (a dry run always runs).
 *
 *   GET  /athletes/:athleteId                    read-only inspection (seams/inspect.ts): account, identity, E3 research
 *        status, research runs (with capped steps), facts/evidence summary, budget headroom, M.I.A. read. 404.
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { RESEARCH_DOMAINS, type ResearchDomain } from "../services/intelligence/research/registries";

const logger = createLogger("routes/admin-intelligence");
const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const operatorOf = (req: Request) => `admin:${req.userId ?? req.athleteId ?? "unknown"}`;

function athleteParam(req: Request, res: Response): string | null {
  const id = req.params.athleteId;
  if (!UUID.test(id)) { res.status(404).json({ error: "athlete not found" }); return null; }
  return id;
}
function labelOf(req: Request, res: Response): string | null | undefined {
  const l = req.body?.label;
  if (l == null) return null;
  if (typeof l !== "string" || !LABEL.test(l)) { res.status(400).json({ error: "label must be 1–32 of [A-Za-z0-9_-]" }); return undefined; }
  return l;
}

router.post("/athletes/:athleteId/resolve-identity", async (req: Request, res: Response): Promise<void> => {
  const athleteId = athleteParam(req, res); if (!athleteId) return;
  const label = labelOf(req, res); if (label === undefined) return;
  const promote = req.body?.promoteWithoutAccount === true;
  try {
    const { adminResolveIdentity } = await import("../services/intelligence/research/lifecycle.js");
    const { readIdentityState } = await import("../services/intelligence/research/identityResolution.js");
    const r = await adminResolveIdentity(athleteId, { by: operatorOf(req), allowWithoutAccount: promote, perEpisodeKey: true, label, requireSport: true });
    if (!r.started) {
      const status = r.reason === "no_athlete" ? 404 : r.reason === "no_sport" ? 422 : 409;
      res.status(status).json({ ...r, ...(r.reason === "no_self_membership" ? { hint: "this athlete has no Nomila account; pass promoteWithoutAccount: true to enter a public athlete deliberately" } : {}) });
      return;
    }
    res.status(200).json({ ...r, identity: (await readIdentityState(athleteId))?.value ?? null });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "admin resolve identity failed");
    res.status(500).json({ error: "could not resolve identity" });
  }
});

router.post("/athletes/:athleteId/research", async (req: Request, res: Response): Promise<void> => {
  const athleteId = athleteParam(req, res); if (!athleteId) return;
  const label = labelOf(req, res); if (label === undefined) return;
  const raw = req.body?.domains;
  let domains: ResearchDomain[] | null = null;
  if (raw != null) {
    if (!Array.isArray(raw) || raw.some((d) => typeof d !== "string" || !(RESEARCH_DOMAINS as readonly string[]).includes(d))) {
      res.status(400).json({ error: `domains must be an array of: ${RESEARCH_DOMAINS.join(", ")}` }); return;
    }
    domains = raw.length ? (raw as ResearchDomain[]) : null;
  }
  const wait = req.body?.wait === true;
  try {
    const { adminRunResearch } = await import("../services/intelligence/research/lifecycle.js");
    const r = await adminRunResearch(athleteId, { by: operatorOf(req), domains, label, kick: wait });
    if (!r.started) {
      const status = r.reason === "no_athlete" ? 404 : r.reason === "no_sport" ? 422 : 409;
      res.status(status).json(r); return;
    }
    res.status(wait ? 200 : 202).json(r);
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "admin research run failed");
    res.status(500).json({ error: "could not start research" });
  }
});

router.post("/athletes/:athleteId/mia/recompute", async (req: Request, res: Response): Promise<void> => {
  const athleteId = athleteParam(req, res); if (!athleteId) return;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
  try {
    const { requestMiaRecompute } = await import("../services/intelligence/seams/miaRecompute.js");
    const r = await requestMiaRecompute(athleteId, { reason, createdBy: "admin_dev_seam" });
    if (r.outcome === "not_found") { res.status(404).json({ error: "athlete not found" }); return; }
    if (r.outcome === "no_sport") { res.status(422).json({ error: "athlete has no resolvable sport; the evaluator requires one and will not guess" }); return; }
    if (r.outcome === "held") { res.status(409).json({ error: "held for identity: the athlete's public identity is not resolved, so M.I.A. will not evaluate yet", held: r.held, identity: r.identity, athleteId }); return; }
    res.status(202).json({ runId: r.runId, created: r.created, athleteId });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "admin M.I.A. recompute failed");
    res.status(500).json({ error: "could not request an evaluation" });
  }
});

router.post("/athletes/:athleteId/identity-intelligence/recompute", async (req: Request, res: Response): Promise<void> => {
  const athleteId = athleteParam(req, res); if (!athleteId) return;
  const force = req.body?.force === true;
  try {
    const { db } = await import("../db.js");
    const { athletes } = await import("../../shared/schema.js");
    const { eq } = await import("drizzle-orm");
    const [a] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    if (!a) { res.status(404).json({ error: "athlete not found" }); return; }
    const { runIdentityIntelligence } = await import("../services/intelligence/identityIntelligence/run.js");
    const { callIdentitySynthesis } = await import("../services/identityIntelligenceProvider.js");
    const r = await runIdentityIntelligence(athleteId, { synthesize: callIdentitySynthesis, force });
    res.status(200).json(r);
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "admin identity intelligence recompute failed");
    res.status(500).json({ error: "could not recompute identity intelligence" });
  }
});

router.post("/athletes/:athleteId/knowledge/reprocess", async (req: Request, res: Response): Promise<void> => {
  const athleteId = athleteParam(req, res); if (!athleteId) return;
  const dryRun = req.body?.dryRun === true;
  try {
    const { reprocessKnowledge, ReprocessDisabledError } = await import("../services/intelligence/research/reprocessKnowledge.js");
    try {
      const r = await reprocessKnowledge(athleteId, { dryRun });
      if (!r) { res.status(404).json({ error: "athlete not found" }); return; }
      logger.info({ athleteId, operator: operatorOf(req), dryRun, counts: r.counts }, "admin knowledge reprocess");
      res.status(200).json(r);
    } catch (err: any) {
      if (err instanceof ReprocessDisabledError) { res.status(409).json({ reason: "disabled", error: err.message }); return; }
      throw err;
    }
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "admin knowledge reprocess failed");
    res.status(500).json({ error: "could not reprocess knowledge" });
  }
});

router.get("/athletes/:athleteId", async (req: Request, res: Response): Promise<void> => {
  const athleteId = athleteParam(req, res); if (!athleteId) return;
  try {
    const { inspectAthleteIntelligence } = await import("../services/intelligence/seams/inspect.js");
    const r = await inspectAthleteIntelligence(athleteId);
    if (!r) { res.status(404).json({ error: "athlete not found" }); return; }
    res.json(r);
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "admin intelligence inspect failed");
    res.status(500).json({ error: "could not inspect" });
  }
});

export default router;
