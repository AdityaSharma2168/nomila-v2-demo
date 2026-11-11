/**
 * agent/researchRefresh/routes.ts — the research refresh's three doors.
 *
 *   athlete (mounted under /api/v1/me, requireAuth):
 *     GET  /agent/suggestions/current        her open Mila suggestion as its card, or { card: null }
 *     POST /agent/suggestions/:decisionId    { response: "update" | "keep_mine" | "edit", statement? } — her answer;
 *                                            404 not hers · 409 already answered · 400 an edit with no words
 *   admin (mounted under /api/v1/admin, requireAdmin):
 *     POST /agent/research-refresh/:athleteId   start ONE refresh for that athlete now (an operator's run; owner
 *                                               approval needed per athlete). Off unless AGENT_RESEARCH_REFRESH.
 *   cron:
 *     POST /api/internal/agent-research-refresh-cron   the daily sweep (CRON_SECRET header). Starts nothing unless BOTH
 *                                                      AGENT_RESEARCH_REFRESH and AGENT_RESEARCH_REFRESH_COHORT are on.
 * Tenancy: the athlete is req.athleteId on the athlete door; never a body. The admin door names the athlete in the path.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth";
import { createLogger } from "../../logger";
import { dbStore } from "../research/dbStore";
import { answerProposal, openProposal, proposalCard, settleCard, SuggestionError, type SuggestionResponse } from "./proposal";
import { requestResearchRefresh, sweepResearchRefresh } from "./sweep";

const logger = createLogger("agent/research-refresh/routes");
const RESPONSES: SuggestionResponse[] = ["update", "keep_mine", "edit"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const suggestionsRouter = Router();

suggestionsRouter.get("/agent/suggestions/current", requireAuth, async (req: Request, res: Response) => {
  try {
    const d = await openProposal(dbStore, req.athleteId!);
    res.json({ card: d ? await proposalCard(dbStore, req.athleteId!, d) : null });
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "suggestion read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

suggestionsRouter.post("/agent/suggestions/:decisionId", requireAuth, async (req: Request, res: Response) => {
  const athleteId = req.athleteId!;
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as { response?: unknown; statement?: unknown };
  const response = RESPONSES.find((r) => r === b.response);
  if (!response) { res.status(400).json({ error: "response must be update, keep_mine or edit" }); return; }
  if (!UUID.test(req.params.decisionId)) { res.status(404).json({ error: "Suggestion not found" }); return; }
  try {
    const r = await answerProposal(dbStore, athleteId, req.params.decisionId, { response, ...(typeof b.statement === "string" ? { statement: b.statement } : {}) });
    await settleCard(athleteId, ((r.decision.detail ?? {}) as { conversationId?: string | null }).conversationId ?? null, r.decision.id, response);
    res.json({ ok: true, response, briefId: r.briefId });
  } catch (err: any) {
    if (err instanceof SuggestionError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "suggestion answer failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Admin: one refresh for one athlete, now (the run itself goes on in the background through the workflow tick). */
export const researchRefreshAdminRouter = Router();
researchRefreshAdminRouter.post("/agent/research-refresh/:athleteId", async (req: Request, res: Response) => {
  if (!UUID.test(req.params.athleteId)) { res.status(400).json({ error: "athleteId must be a uuid" }); return; }
  try {
    const r = await requestResearchRefresh(req.params.athleteId, { trigger: "manual", reason: "operator run", kick: false, createdBy: "admin" });
    res.status(r.started ? 202 : 409).json(r);
  } catch (err: any) {
    logger.error({ athleteId: req.params.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "admin research refresh failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export function researchRefreshCronRouter(cronSecretValid: (req: Request) => boolean, sweep: typeof sweepResearchRefresh = sweepResearchRefresh): Router {
  const r = Router();
  r.post("/api/internal/agent-research-refresh-cron", async (req: Request, res: Response) => {
    if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      res.json({ ok: true, ...(await sweep()) });
    } catch (err: any) {
      logger.error({ error: String(err?.message ?? err).slice(0, 300) }, "agent research refresh sweep failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return r;
}
