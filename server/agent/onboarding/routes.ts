/**
 * agent/onboarding/routes.ts — the onboarding API (mounted under /api/v1/me, requireAuth), dark behind AGENT_ONBOARDING.
 *
 *   POST /agent/onboarding/start        { name, sport }                       → { runId, created }   (202: research runs in the background)
 *   GET  /agent/onboarding              → state: progress card, conversation (messages + cards), checkpoints, done
 *   POST /agent/onboarding/turn         { message?, actions?, reply? }        → { message, cards, checkpoints, done }
 *   GET  /agent/onboarding/facts        ?subject=athlete|others|all (default all) → facts for review, each with sources, its run, topic, source type and `about`
 *   GET  /agent/onboarding/brief        → the Brief as the athlete sees it (never the internal read)
 *   GET  /agent/onboarding/goals        → goals the athlete holds
 *   GET  /agent/how/runs/:runId         → "How I got this" for a run (the card + the trace)
 *   GET  /agent/how/facts/:factId       → "How I got this" for a fact
 *
 * Tenancy: the athlete id is always req.athleteId (from the token); nothing in a body or path picks an athlete.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth";
import { createLogger } from "../../logger";
import {
  OnboardingError, howForFact, howIGotThis, onboardingBrief, onboardingFacts, onboardingGoals, onboardingState, onboardingTurn, startOnboarding,
  subjectFilterOf,
} from "./service";
import { CostCapError } from "../research/runSkill";

const logger = createLogger("agent/onboarding/routes");

export function agentOnboardingEnabled(): boolean {
  return process.env.AGENT_ONBOARDING === "true";
}

function fail(res: Response, err: any, what: string): void {
  if (err instanceof OnboardingError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  if (err instanceof CostCapError) { res.status(429).json({ error: "This onboarding has reached its spending limit.", code: "cost_cap" }); return; }
  logger.error({ error: String(err?.message ?? err).slice(0, 300) }, what);
  res.status(500).json({ error: "Internal server error" });
}

export const agentOnboardingRouter = Router();

agentOnboardingRouter.post("/agent/onboarding/start", requireAuth, async (req: Request, res: Response) => {
  try {
    const out = await startOnboarding(req.athleteId!, req.body ?? {});
    res.status(out.created ? 202 : 200).json(out);
  } catch (err) { fail(res, err, "agent onboarding start failed"); }
});

agentOnboardingRouter.get("/agent/onboarding", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await onboardingState(req.athleteId!)); } catch (err) { fail(res, err, "agent onboarding state failed"); }
});

agentOnboardingRouter.post("/agent/onboarding/turn", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await onboardingTurn(req.athleteId!, req.body ?? {})); } catch (err) { fail(res, err, "agent onboarding turn failed"); }
});

agentOnboardingRouter.get("/agent/onboarding/facts", requireAuth, async (req: Request, res: Response) => {
  try { res.json({ facts: await onboardingFacts(req.athleteId!, { subject: subjectFilterOf(req.query.subject) }) }); } catch (err) { fail(res, err, "agent onboarding facts failed"); }
});

agentOnboardingRouter.get("/agent/onboarding/brief", requireAuth, async (req: Request, res: Response) => {
  try { res.json({ brief: await onboardingBrief(req.athleteId!) }); } catch (err) { fail(res, err, "agent onboarding brief failed"); }
});

agentOnboardingRouter.get("/agent/onboarding/goals", requireAuth, async (req: Request, res: Response) => {
  try { res.json({ goals: await onboardingGoals(req.athleteId!) }); } catch (err) { fail(res, err, "agent onboarding goals failed"); }
});

agentOnboardingRouter.get("/agent/how/runs/:runId", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await howIGotThis(req.athleteId!, req.params.runId)); } catch (err) { fail(res, err, "how-i-got-this (run) failed"); }
});

agentOnboardingRouter.get("/agent/how/facts/:factId", requireAuth, async (req: Request, res: Response) => {
  try { res.json(await howForFact(req.athleteId!, req.params.factId)); } catch (err) { fail(res, err, "how-i-got-this (fact) failed"); }
});
