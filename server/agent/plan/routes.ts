/**
 * agent/plan/routes.ts — the Goals API (mounted under /api/v1/me, requireAuth), dark behind AGENT_PLAN. The same
 * service functions the chat agent's goal tools call (goals.ts).
 *
 *   GET   /agent/goals                                   goals + game plan + this week's actions, set-aside goals,
 *                                                        recommended goals, comingUp (≤ 3), riskUpside, missing,
 *                                                        planning (a plan run in progress, planning.ts)
 *   POST  /agent/goals                    { text, horizon? }               add your own goal
 *   PATCH /agent/goals/:id                { text?, horizon?, gamePlan? }   change it (your game plan stays yours)
 *   POST  /agent/goals/:id/set-aside      { reason? }                      paused; its waiting actions expire
 *   POST  /agent/goals/:id/drop           { reason? }                      dropped; history kept
 *   POST  /agent/goals/:id/bring-back                                      paused → active
 *   POST  /agent/goals/recommended/:decisionId/keep { text? }              a recommendation becomes your goal
 *   POST  /agent/goals/recommended/:decisionId/skip { reason? }            "Not now": not suggested again for 90 days
 *   POST  /agent/goals/changes/:decisionId/undo                            the goal-change card's Undo
 *   GET   /agent/results                                 per goal: what you did and what came back (last 30 days)
 *   GET   /agent/wins                                    the learning loop's exceptional posts, last 7 days (Home v3)
 *
 * Each write answers { change, goals } — the goal-change card and the fresh read — so one request redraws the tab.
 * Tenancy: the athlete id is always req.athleteId (from the token); nothing in a body or path picks an athlete.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth";
import { createLogger } from "../../logger";
import { dbStore } from "../research/dbStore";
import { agentPlanEnabled } from "./config";
import { activePlanning } from "./planning";
import { readWins } from "../learning/wins";
import { recentDirectPayments } from "../../services/moneySummary";
import {
  addGoal, bringBackGoal, changeGoal, dropGoal, GoalsError, keepRecommended, readGoals, readResults, setAsideGoal, skipRecommended, undoChange,
  type GoalsDeps,
} from "./goals";

const logger = createLogger("agent/plan/routes");

export { agentPlanEnabled };

const deps = (): GoalsDeps => ({ store: dbStore, planning: (athleteId) => activePlanning(athleteId) });
const body = (req: Request) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const reasonOf = (req: Request) => (typeof body(req).reason === "string" ? String(body(req).reason) : null);

function fail(res: Response, err: any, what: string): void {
  if (err instanceof GoalsError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  logger.error({ error: String(err?.message ?? err).slice(0, 300) }, what);
  res.status(500).json({ error: "Internal server error" });
}

export const agentGoalsRouter = Router();

agentGoalsRouter.get("/agent/goals", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await readGoals(req.athleteId!, deps())); } catch (err) { fail(res, err, "goals read failed"); }
});

// Home v3's Wins circle (EXPO_PUBLIC_HOME_V3): the learning loop's exceptional-post messages and brands' direct payments
// of the last 7 days. Read-only.
agentGoalsRouter.get("/agent/wins", requireAuth, async (req: Request, res: Response) => {
  try {
    const athleteId = req.athleteId!;
    res.json(await readWins(athleteId, dbStore, new Date(), (since) => recentDirectPayments(athleteId, since).catch(() => [])));  // a failed payments read never loses the posts
  } catch (err) { fail(res, err, "wins read failed"); }
});

agentGoalsRouter.get("/agent/results", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await readResults(req.athleteId!, deps())); } catch (err) { fail(res, err, "results read failed"); }
});

/** A write, then the change card and the fresh read. */
const write = (what: string, f: (req: Request) => Promise<{ card: unknown }>) => async (req: Request, res: Response) => {
  try {
    const r = await f(req);
    res.json({ change: r.card, goals: await readGoals(req.athleteId!, deps()) });
  } catch (err) { fail(res, err, what); }
};

agentGoalsRouter.post("/agent/goals", requireAuth, write("goal add failed", (req) => addGoal(req.athleteId!, { text: body(req).text, horizon: body(req).horizon }, deps())));

agentGoalsRouter.patch("/agent/goals/:id", requireAuth, write("goal change failed", (req) => {
  const b = body(req);
  return changeGoal(req.athleteId!, req.params.id, { text: b.text, horizon: b.horizon, gamePlan: b.gamePlan }, deps());
}));

agentGoalsRouter.post("/agent/goals/recommended/:decisionId/keep", requireAuth, write("goal keep failed", (req) =>
  keepRecommended(req.athleteId!, req.params.decisionId, { text: typeof body(req).text === "string" ? String(body(req).text) : null }, deps())));

agentGoalsRouter.post("/agent/goals/recommended/:decisionId/skip", requireAuth, async (req: Request, res: Response) => {
  try {
    const r = await skipRecommended(req.athleteId!, req.params.decisionId, { reason: reasonOf(req) }, deps());
    res.json({ skipped: r.decisionId, goals: await readGoals(req.athleteId!, deps()) });
  } catch (err) { fail(res, err, "goal skip failed"); }
});

agentGoalsRouter.post("/agent/goals/changes/:decisionId/undo", requireAuth, write("goal undo failed", (req) => undoChange(req.athleteId!, req.params.decisionId, deps())));

agentGoalsRouter.post("/agent/goals/:id/set-aside", requireAuth, write("goal set-aside failed", (req) => setAsideGoal(req.athleteId!, req.params.id, { reason: reasonOf(req) }, deps())));
agentGoalsRouter.post("/agent/goals/:id/drop", requireAuth, write("goal drop failed", (req) => dropGoal(req.athleteId!, req.params.id, { reason: reasonOf(req) }, deps())));
agentGoalsRouter.post("/agent/goals/:id/bring-back", requireAuth, write("goal bring-back failed", (req) => bringBackGoal(req.athleteId!, req.params.id, {}, deps())));
