/**
 * routes.ts — the HTTP surface of the workflow runner.
 *
 *   athlete (mounted under /api/v1/me, requireAuth):
 *     GET  /workflow/runs?process=            the athlete's own runs (+ the step waiting on them)
 *     POST /workflow/runs/:id/steps/:step/complete   { fields, mode }  — the one door for await_human
 *
 *   admin (mounted under /api/v1/admin, requireAdmin already applied by the admin router):
 *     GET  /workflow/runs?process=&status=&athleteId=&limit=
 *     GET  /workflow/runs/:id                 run + every step attempt
 *     POST /workflow/runs/:id/retry | /cancel
 *     GET  /workflow/processes                registered definitions and versions
 *
 * Tenancy: the athlete routes never accept an athleteId — it comes from the token via
 * req.athleteId, and completeStep() re-checks the run belongs to it.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { listProcesses } from "./registry";
import {
  WorkflowError, activeRunFor, cancelRun, completeStep, getRun, listRuns, retryRun,
} from "./runner";

const logger = createLogger("workflow/routes");

const MODES = new Set(["chat", "voice", "form"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: Response, err: any, fallback: string): void {
  if (err instanceof WorkflowError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logger.error({ error: err?.message }, fallback);
  res.status(500).json({ error: "Internal server error" });
}

// ─── Athlete ──────────────────────────────────────────────────────────────────

export const workflowAthleteRouter = Router();

workflowAthleteRouter.get("/workflow/runs", requireAuth, async (req: Request, res: Response) => {
  try {
    const athleteId = req.athleteId!;
    const process = typeof req.query.process === "string" ? req.query.process : undefined;
    if (process) {
      const active = await activeRunFor(athleteId, process);
      res.json({ active: active ? { run: active.run, waiting: active.waiting } : null });
      return;
    }
    const runs = await listRuns({ athleteId, limit: 50 });
    res.json({ runs });
  } catch (err) {
    sendError(res, err, "workflow runs list failed");
  }
});

workflowAthleteRouter.post("/workflow/runs/:id/steps/:step/complete", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id, step } = req.params;
    if (!UUID.test(id)) { res.status(404).json({ error: "Run not found" }); return; }
    const { fields, mode } = (req.body ?? {}) as { fields?: unknown; mode?: unknown };
    if (typeof mode !== "string" || !MODES.has(mode)) { res.status(400).json({ error: "mode must be chat, voice or form" }); return; }
    if (fields === undefined) { res.status(400).json({ error: "fields is required" }); return; }
    const result = await completeStep({ runId: id, step, fields, mode: mode as any, athleteId: req.athleteId! });
    res.json({ run: result.run, alreadyDone: result.alreadyDone });
  } catch (err) {
    sendError(res, err, "workflow complete-step failed");
  }
});

// ─── Admin ────────────────────────────────────────────────────────────────────

export const workflowAdminRouter = Router();

workflowAdminRouter.get("/workflow/processes", (_req, res) => {
  res.json({ processes: listProcesses() });
});

workflowAdminRouter.get("/workflow/runs", async (req: Request, res: Response) => {
  try {
    const q = req.query;
    const runs = await listRuns({
      process:   typeof q.process === "string" ? q.process : undefined,
      status:    typeof q.status === "string" ? q.status : undefined,
      athleteId: typeof q.athleteId === "string" && UUID.test(q.athleteId) ? q.athleteId : undefined,
      limit:     Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100)),
    });
    res.json({ runs });
  } catch (err) {
    sendError(res, err, "admin workflow runs list failed");
  }
});

workflowAdminRouter.get("/workflow/runs/:id", async (req: Request, res: Response) => {
  try {
    if (!UUID.test(req.params.id)) { res.status(404).json({ error: "Run not found" }); return; }
    const found = await getRun(req.params.id);
    if (!found) { res.status(404).json({ error: "Run not found" }); return; }
    res.json(found);
  } catch (err) {
    sendError(res, err, "admin workflow run detail failed");
  }
});

workflowAdminRouter.post("/workflow/runs/:id/retry", async (req: Request, res: Response) => {
  try {
    if (!UUID.test(req.params.id)) { res.status(404).json({ error: "Run not found" }); return; }
    res.json({ run: await retryRun(req.params.id) });
  } catch (err) {
    sendError(res, err, "admin workflow retry failed");
  }
});

workflowAdminRouter.post("/workflow/runs/:id/cancel", async (req: Request, res: Response) => {
  try {
    if (!UUID.test(req.params.id)) { res.status(404).json({ error: "Run not found" }); return; }
    res.json({ run: await cancelRun(req.params.id) });
  } catch (err) {
    sendError(res, err, "admin workflow cancel failed");
  }
});
