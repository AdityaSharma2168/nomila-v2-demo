/**
 * onboardingRoute.ts — the first entry, for the voice worker (internal).
 *
 *   GET  /athletes/:id/onboarding                        → { active, run_id, step, prompt }
 *   POST /athletes/:id/onboarding/steps/:step/complete   { fields } → { run_id, status, saved, next, door }
 *
 * Mounted at /api/internal/voice (server/index.ts), guarded by the shared voice secret like every
 * sibling route (see ./auth). The caller is TRUSTED INFRASTRUCTURE: `:id` from the path is the
 * only athlete these routes can touch, and completeStep re-checks the run belongs to it.
 *
 * GET hands the worker the SAME text the chat loop appends to Mila's system prompt for an
 * onboarding conversation (server/mila/onboarding.ts buildOnboardingPrompt) so voice and chat
 * open with the same facts and the same rules. `prompt` is built from our own tables — labels,
 * handles and short values, no email or thread text — so nothing an outsider wrote is spoken.
 *
 * POST is the voice twin of the complete_onboarding_step tool, with mode 'voice' so the receipt
 * says how the athlete answered. Same validators, same writes, same refusals. The worker must
 * only call it after the athlete has actually answered — it is the one write in this pair.
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import { buildOnboardingPrompt, OnboardingFieldError, ONBOARDING_STEPS, type SavedFact } from "../mila/onboarding";
import { activeRunFor, completeStep, getRun, WorkflowError } from "../workflow/runner";

const logger = createLogger("voice/onboarding");
const router = Router();

router.get("/athletes/:id/onboarding", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const voiceAuth = await voiceAuthorized(req, req.params.id);
  if (!voiceAuth.ok) { sendVoiceRefusal(res, voiceAuth); return; }
  const { id } = req.params;
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "Invalid athlete id" }); return; }
  try {
    const active = await activeRunFor(id, "onboarding");
    const step = active?.waiting?.step ?? null;
    const onboarding = !!step && (ONBOARDING_STEPS as readonly string[]).includes(step);
    const prompt = onboarding ? await buildOnboardingPrompt(id) : "";
    logger.info({ athleteId: id, tool: "get_onboarding", active: onboarding, step }, "Voice tool — get_onboarding");
    res.json({ active: onboarding, run_id: onboarding ? active!.run.id : null, step: onboarding ? step : null, prompt });
  } catch (err: any) {
    logger.error({ athleteId: id, error: err.message }, "Voice onboarding read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/athletes/:id/onboarding/steps/:step/complete", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const voiceAuth = await voiceAuthorized(req, req.params.id);
  if (!voiceAuth.ok) { sendVoiceRefusal(res, voiceAuth); return; }
  const { id, step } = req.params;
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "Invalid athlete id" }); return; }
  if (!(ONBOARDING_STEPS as readonly string[]).includes(step)) { res.status(400).json({ error: `step must be one of ${ONBOARDING_STEPS.join(", ")}` }); return; }
  const { fields } = (req.body ?? {}) as { fields?: unknown };
  if (fields === undefined || fields === null || typeof fields !== "object") { res.status(400).json({ error: "fields is required" }); return; }

  try {
    const active = await activeRunFor(id, "onboarding");
    if (!active?.waiting || active.waiting.step !== step) {
      res.status(409).json({ error: active?.waiting ? `The waiting step is '${active.waiting.step}'` : "No onboarding step is waiting", code: "not_waiting" });
      return;
    }
    const { run } = await completeStep({ runId: active.run.id, step, fields: { ...(fields as Record<string, unknown>), mode: "voice" }, mode: "voice", athleteId: id });
    const found = await getRun(run.id);
    const done = found?.steps.find((s) => s.step === step && s.status === "done");
    const output = (done?.output ?? {}) as { saved?: SavedFact[]; door?: string };
    const stillWaiting = found?.steps.find((s) => s.status === "waiting")?.step ?? null;
    logger.info({ athleteId: id, runId: run.id, step, saved: (output.saved ?? []).map((s) => s.field), next: stillWaiting ?? "done" }, "Voice tool — complete_onboarding_step");
    res.json({ run_id: run.id, status: run.status, step, saved: output.saved ?? [], next: stillWaiting === "doors" ? "doors" : "done", door: output.door ?? null });
  } catch (err: any) {
    if (err instanceof OnboardingFieldError) { res.status(400).json({ error: err.message }); return; }
    if (err instanceof WorkflowError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    logger.error({ athleteId: id, step, error: err.message }, "Voice onboarding complete failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
