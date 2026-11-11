/**
 * voice/oneMila/routes.ts — ONE MILA FOR VOICE, the server side (MILA_VOICE_ONE, off by default; on in dev only).
 * Mounted at /api/internal/voice (server/index.ts). The caller is the mila-voice worker (trusted infrastructure).
 *
 *   POST /session   → the call's start: { version, athleteId, conversationId, sessionId, instructions, context, tools,
 *                     toolsJsonSchema, limits, digests, approxTokens } (session.ts VoiceSession)
 *   POST /tool      { turnId, name, args, callId? } → { callId, text, isError, messageId, cards[], runId }
 *                     (toolProxy.ts VoiceToolResult)
 *
 * ── The guard (auth.ts voiceGrantAuthorized) ────────────────────────────────────────────────────────────────────
 * Flag first: with MILA_VOICE_ONE off both routes 404 before anything is checked, so an off route is indistinguishable
 * from a missing one. Then the service secret (401), then the grant, REQUIRED (401: the athlete and the conversation
 * come from the verified grant and nowhere else), then voiceAuthorized with the grant's athlete (uuid, and the
 * deletion fence: 410 account_deleting). A body that names another athlete or conversation is refused (403): the
 * worker never chooses who a call is for.
 *
 * ── The card handoff (the widget bridge, for PR C) ──────────────────────────────────────────────────────────────
 * A /tool answer with `cards` means the call put cards on the athlete's conversation, saved on ONE chat_messages row
 * (`messageId`, role assistant, empty text, source 'voice', agent_cards). The worker publishes ids only on the existing
 * `mila.widget` topic: { type: "mila.cards", messageId, cards: [{ cardId, kind, approvalId?, pendingActionId? }] }.
 * The app fetches GET /api/v1/me/conversations/:conversationId (requireAuth), finds the row by `messageId` and draws
 * its `agentCards` with the card kit (the same component chat uses, approval state included). The model was already
 * told the card is on screen (toolProxy.ts CARD_ON_SCREEN_NOTE).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { createLogger } from "../../logger";
import { MILA } from "../../mila/config";
import { sendVoiceRefusal, voiceGrantAuthorized } from "../auth";
import { buildVoiceSession } from "./session";
import { runVoiceTool } from "./toolProxy";
import { callKeyOf, TURN_ID_RE } from "./state";

const logger = createLogger("voice/oneMila");

export const oneMilaRouter = Router();

function gate(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  if (!MILA.VOICE_ONE) { res.status(404).json({ error: "Not found" }); return; }
  next();
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A body may echo who the call is for, but never name someone else. */
function bodyNamesSomeoneElse(body: Record<string, unknown>, athleteId: string, conversationId: string): boolean {
  if (body.athleteId !== undefined && body.athleteId !== athleteId) return true;
  if (body.conversationId !== undefined && body.conversationId !== conversationId) return true;
  return false;
}

oneMilaRouter.post("/session", gate, async (req: Request, res: Response) => {
  const auth = await voiceGrantAuthorized(req);
  if (!auth.ok) { sendVoiceRefusal(res, auth); return; }
  const { athleteId, conversationId, exp } = auth.claims;
  const body = isRecord(req.body) ? req.body : {};
  if (bodyNamesSomeoneElse(body, athleteId, conversationId)) { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const session = await buildVoiceSession({ athleteId, conversationId, callKey: callKeyOf(auth.grant), grantExp: exp });
    logger.info({ athleteId, tools: session.tools.length, tokens: session.approxTokens }, "voice session served");
    res.json(session);
  } catch (err: any) {
    logger.error({ athleteId, err: err?.message }, "voice session failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

oneMilaRouter.post("/tool", gate, async (req: Request, res: Response) => {
  const auth = await voiceGrantAuthorized(req);
  if (!auth.ok) { sendVoiceRefusal(res, auth); return; }
  const { athleteId, conversationId } = auth.claims;
  const body = isRecord(req.body) ? req.body : {};
  if (bodyNamesSomeoneElse(body, athleteId, conversationId)) { res.status(403).json({ error: "Forbidden" }); return; }
  const turnId = typeof body.turnId === "string" ? body.turnId : "";
  const name = typeof body.name === "string" ? body.name : "";
  const callId = typeof body.callId === "string" ? body.callId.slice(0, 200) : null;
  if (!TURN_ID_RE.test(turnId)) { res.status(400).json({ error: "Invalid turnId" }); return; }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) { res.status(400).json({ error: "Invalid tool name" }); return; }
  const args = body.args === undefined || body.args === null ? {} : body.args;
  if (!isRecord(args)) {
    // As callTool answers a non-object: an error the model can read, not an HTTP failure.
    res.json({ callId, text: JSON.stringify({ status: "error", reason: "arguments were not a JSON object" }), isError: true, messageId: null, cards: [], runId: null });
    return;
  }
  try {
    const out = await runVoiceTool({ athleteId, conversationId, callKey: callKeyOf(auth.grant), turnId, name, args });
    res.json({ callId, ...out });
  } catch (err: any) {
    logger.error({ athleteId, tool: name, err: err?.message }, "voice tool failed");
    // The model can recover from this; the call goes on.
    res.json({ callId, text: JSON.stringify({ status: "error", reason: "the tool failed" }), isError: true, messageId: null, cards: [], runId: null });
  }
});
