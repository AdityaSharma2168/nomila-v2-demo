/**
 * scoreRoute.ts — read-only score lookup for the voice worker (internal).
 *
 * GET /athletes/:id/score, mounted at /api/internal/voice (server/index.ts).
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, so the athlete id comes from the path and the shared secret is
 * the entire authorization boundary. See ./auth for the guard and why the secret
 * is its own rather than shared with CRON_SECRET.
 *
 * The response is a deliberately small, EXPLICIT shape — `getScore`'s own result
 * is model-facing (snake_case, a prompt-budget `truncated` flag, a summarized
 * rate card) and is free to change as the prompt is tuned; it is mapped here
 * rather than passed through so the voice contract doesn't move with it.
 */

import { Router, type Request, type Response } from "express";
import { getScoreTool } from "../mila/tools/getScore";
import { MILA } from "../mila/config";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import { presentFields } from "./logShape";

const logger = createLogger("voice/score");

const router = Router();

/**
 * The voice wire shape: the M.I.A. score (out of 850) and the M.I.A. dimensions that are her strengths, strongest
 * first, in plain words. Legacy retirement P2-5 (owner decisions 8 Oct 2026): no tier word, no four capitals, no top
 * area, no projected annual value — the worker no longer pushes the capitals card (nomila-co/mila-voice). `trend` is
 * absent by design: there is no M.I.A. history source yet.
 */
interface VoiceScore {
  displayScore: number | null;
  outOf: 850;
  strengths: string[];
}

/** Map the tool result onto the wire shape. Null means "no score to report". */
function toVoiceScore(result: unknown): VoiceScore | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const row = result as Record<string, unknown>;
  const strengths = Array.isArray(row.strengths)
    ? (row.strengths as unknown[])
        .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).dimension : null))
        .filter((d): d is string => typeof d === "string" && d.length > 0)
    : [];
  return {
    displayScore: typeof row.display_score === "number" ? row.display_score : null,
    outOf: 850,
    strengths,
  };
}

router.get("/athletes/:id/score", async (req: Request, res: Response) => {
  // Set before the guard so EVERY response from this route carries it — the
  // app-wide no-store middleware covers /api/v1/me|admin|auth only.
  res.setHeader("Cache-Control", "no-store");

  const voiceAuth = await voiceAuthorized(req, req.params.id);
  if (!voiceAuth.ok) {
    sendVoiceRefusal(res, voiceAuth);
    return;
  }

  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid athlete id" });
    return;
  }

  try {
    // The agent loop wraps every tool call in withTimeout; this path bypasses
    // the loop, so the bound has to be applied here.
    const result = await withTimeout(
      getScoreTool.execute(id, {}),
      MILA.TOOL_TIMEOUT_MS,
      "voice get_score",
    );

    const score = toVoiceScore(result);
    if (!score) {
      logger.info(
        { athleteId: id, tool: "get_score", outcome: "miss" },
        "Voice tool — get_score",
      );
      res.status(404).json({ error: "No score" });
      return;
    }
    // Fields only, never the score itself. See ./logShape on why no value from
    // any of these routes reaches a log line.
    logger.info(
      {
        athleteId: id,
        tool: "get_score",
        outcome: "hit",
        fields: presentFields(score),
      },
      "Voice tool — get_score",
    );
    res.json(score);
  } catch (err: any) {
    // athleteId only — never the secret or the request headers.
    logger.error(
      { athleteId: id, error: err.message },
      "Voice score lookup failed",
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
