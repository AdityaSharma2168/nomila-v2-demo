/**
 * studio/creative/routes.ts — the creative-intent surface, behind STUDIO_CREATIVE_INTENTS (off ⇒ 404, the surface
 * does not exist). Create (her words), read (derived state), interpret (creative intelligence), confirm (the load-
 * bearing read stage), withdraw. Nothing here spends, generates, clears or publishes: the preview path does that,
 * with its own gates, once an intent is confirmed.
 */
import type { RequestHandler, Router, Request, Response } from "express";
import { db } from "../../db";
import { creativeIntentsEnabled } from "../config";
import { confirmInterpretation, creativeIntentState, latestInterpretation, withdrawCreativeIntent } from "../../services/intelligence/creative/store";
import { requestCreative } from "./door";
import { interpretCreativeIntent } from "./interpret";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMATS = ["post", "story", "reel", "carousel", "ad", "clip", "written", "other"] as const;

export function registerCreativeRoutes(router: Router, gate: readonly RequestHandler[]): void {
  const on = (_req: Request, res: Response, next: () => void) => { if (!creativeIntentsEnabled()) { res.status(404).json({ error: "Not found" }); return; } next(); };
  const id = (req: Request, res: Response): string | null => { const v = req.params.id; if (typeof v !== "string" || !UUID_RE.test(v)) { res.status(400).json({ error: "not an intent id", field: "id" }); return null; } return v; };

  router.post("/studio/creative/intents", ...gate, on, async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await requestCreative(db, req.athleteId as string, { ask: b.ask as string, moment: (b.moment as any) ?? null, brandId: (b.brandId as number | null | undefined) ?? null, requestKey: (b.requestKey as string | null | undefined) ?? null });
    if (!r.ok) { res.status(400).json({ error: r.error, field: r.field }); return; }
    res.status(r.created ? 201 : 200).json({ intent: r.intent, created: r.created });
  });

  router.get("/studio/creative/intents/:id", ...gate, on, async (req, res) => {
    const i = id(req, res); if (!i) return;
    const s = await creativeIntentState(db, req.athleteId as string, i);
    if (!s) { res.status(404).json({ error: "That creative request isn't one of yours.", field: "id" }); return; }
    const latest = await latestInterpretation(db, req.athleteId as string, i);
    res.status(200).json({ intent: s.intent, state: s.state, interpretation: latest, downstream: s.downstream });
  });

  router.post("/studio/creative/intents/:id/interpret", ...gate, on, async (req, res) => {
    const i = id(req, res); if (!i) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.objective !== undefined && body.objective !== null && typeof body.objective !== "string") { res.status(400).json({ error: "objective must be a string", field: "objective" }); return; }
    const r = await interpretCreativeIntent(db, req.athleteId as string, i, {}, { objective: (body.objective as string | undefined) ?? null });
    // A missing or unknown objective is a question for her (400, with the choices), never a server failure. Only the
    // model's own failures are 502.
    if (!r.ok) { res.status(r.reason === "not_found" ? 404 : r.reason === "withdrawn" ? 409 : r.reason === "disabled" ? 404 : r.reason === "needs_objective" || r.reason === "invalid_input" ? 400 : 502).json({ error: r.reason, detail: r.detail ?? null, ...(r.options ? { options: r.options } : {}) }); return; }
    res.status(200).json({ interpretation: r.interpretation, proposals: r.proposals });
  });

  // CONFIRMATION: the interpretation she read, the proposal/concept she chose, the inferred fields she accepts, and —
  // only when her request fixed none or was wrong — the format. Her verbatim ask is never touched.
  router.post("/studio/creative/intents/:id/confirm", ...gate, on, async (req, res) => {
    const i = id(req, res); if (!i) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.interpretationId !== "string" || !UUID_RE.test(b.interpretationId)) { res.status(400).json({ error: "interpretationId required", field: "interpretationId" }); return; }
    const proposalIndex = b.proposalIndex === undefined ? 0 : b.proposalIndex;
    if (!Number.isInteger(proposalIndex) || (proposalIndex as number) < 0) { res.status(400).json({ error: "proposalIndex must be a non-negative integer", field: "proposalIndex" }); return; }
    if (b.formatClass !== undefined && b.formatClass !== null && !(FORMATS as readonly string[]).includes(b.formatClass as string)) { res.status(400).json({ error: `formatClass must be one of: ${FORMATS.join(", ")}`, field: "formatClass" }); return; }
    const latest = await latestInterpretation(db, req.athleteId as string, i);
    if (!latest || latest.id !== b.interpretationId) { res.status(409).json({ error: "that interpretation is not the current one", field: "interpretationId" }); return; }
    const proposals = ((latest.proposal as any)?.proposals ?? []) as any[];
    if (!proposals[proposalIndex as number]) { res.status(400).json({ error: "no such proposal", field: "proposalIndex" }); return; }
    try {
      const r = await confirmInterpretation(db, { athleteId: req.athleteId as string, interpretationId: latest.id, concept: { proposalIndex, concept: proposals[proposalIndex as number]?.extras?.concept ?? null }, flags: Array.isArray(b.flags) ? b.flags : [], formatClass: (b.formatClass as string | null | undefined) ?? null });
      res.status(200).json({ interpretation: r });
    } catch (err) { res.status(409).json({ error: (err as Error).message, field: "interpretationId" }); }
  });

  router.post("/studio/creative/intents/:id/withdraw", ...gate, on, async (req, res) => {
    const i = id(req, res); if (!i) return;
    try { const r = await withdrawCreativeIntent(db, req.athleteId as string, i); res.status(200).json({ intent: r }); }
    catch { res.status(404).json({ error: "That creative request isn't one of yours.", field: "id" }); }
  });
}
