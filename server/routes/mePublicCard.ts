/**
 * routes/mePublicCard.ts — her public card, her side (design-public-card-v3 §10–§11, PR 2). Mounted at /api/v1/me only
 * while PUBLIC_CARD is on (server/index.ts); every handler re-checks the flag (404 when off). Bodies and responses are
 * the types in shared/publicCard.ts.
 *
 *   GET   /public-card/draft      → PublicCardDraftResponse      her chapters, items, sources, what was cut and why
 *   PUT   /public-card/draft      PublicCardDraftRequest → PublicCardDraftResponse   her decisions (replaced whole)
 *   GET   /public-card/preview    → PublicCardPreviewResponse    exactly what Publish would freeze now
 *   POST  /public-card/publish    → PublicCardPublishResponse    her tap: version N+1, live at once
 *   POST  /public-card/unpublish  → PublicCardUnpublishResponse  one tap off; snapshots deleted
 *   PATCH /public-card/switches   PublicCardSwitchesRequest → PublicCardSwitchesResponse
 *   PUT   /public-card/handle     PublicCardHandleRequest → PublicCardHandleResponse
 *   GET   /public-card/metrics    → PublicPageMetrics             her metrics rail, last 30 days (shared/publicPageStats.ts)
 *   errors → PublicCardErrorResponse
 *
 * OWNER ONLY: requireAuth on every route; the athlete is `req.athleteId` from the token, never a body or path field, so
 * no route can name another athlete. Publish is her tap only (tap-to-send): Mila and admins never call it.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { parseDecisions } from "../services/publicCard/draft";
import { HandleError } from "../services/publicCard/handles";
import { PublicCardError } from "../services/publicCard/publish";
import { publicCardEnabled } from "../services/publicCard/flag";
import { pageMetrics } from "../services/publicPage/stats";
import type { PublicPageMetrics } from "../../shared/publicPageStats";
import { changeHandle, getDraft, getPreview, publishDraft, saveDecisions, setSwitches, unpublishCard } from "../services/publicCard/service";
import type {
  PublicCardDraftResponse, PublicCardErrorResponse, PublicCardHandleResponse, PublicCardPreviewResponse,
  PublicCardPublishResponse, PublicCardSwitches, PublicCardSwitchesResponse, PublicCardUnpublishResponse,
} from "../../shared/publicCard";

const logger = createLogger("routes/me-public-card");
const router = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof PublicCardError) {
    const body: PublicCardErrorResponse = { error: err.message, code: err.code === "not_published" ? "not_published" : err.code };
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof HandleError) {
    const status = err.code === "invalid" ? 422 : err.code === "too_soon" ? 429 : 409;
    const body: PublicCardErrorResponse = { error: err.message, code: err.code, ...(err.nextChangeAt ? { nextChangeAt: err.nextChangeAt.toISOString() } : {}) };
    res.status(status).json(body);
    return;
  }
  logger.error({ error: String((err as any)?.message ?? err).slice(0, 200) }, "public card route failed");
  res.status(500).json({ error: "public card operation failed" });
}
const bad = (res: Response, error: string) => { const body: PublicCardErrorResponse = { error, code: "bad_request" }; res.status(400).json(body); };

router.get("/public-card/draft", requireAuth, async (req: Request, res: Response<PublicCardDraftResponse | PublicCardErrorResponse>): Promise<void> => {
  try { res.json(await getDraft(req.athleteId!)); } catch (err) { fail(res, err); }
});

router.put("/public-card/draft", requireAuth, async (req: Request, res: Response<PublicCardDraftResponse | PublicCardErrorResponse>): Promise<void> => {
  const parsed = parseDecisions(req.body);
  if (!parsed.ok) { bad(res, parsed.error); return; }
  try { res.json(await saveDecisions(req.athleteId!, parsed.value)); } catch (err) { fail(res, err); }
});

router.get("/public-card/preview", requireAuth, async (req: Request, res: Response<PublicCardPreviewResponse | PublicCardErrorResponse>): Promise<void> => {
  res.set("Cache-Control", "no-store");
  try { res.json(await getPreview(req.athleteId!)); } catch (err) { fail(res, err); }
});

router.post("/public-card/publish", requireAuth, async (req: Request, res: Response<PublicCardPublishResponse | PublicCardErrorResponse>): Promise<void> => {
  try { res.json(await publishDraft(req.athleteId!, req.userId ?? null)); } catch (err) { fail(res, err); }
});

router.post("/public-card/unpublish", requireAuth, async (req: Request, res: Response<PublicCardUnpublishResponse | PublicCardErrorResponse>): Promise<void> => {
  try { res.json({ unpublished: await unpublishCard(req.athleteId!) }); } catch (err) { fail(res, err); }
});

const SWITCH_KEYS: (keyof PublicCardSwitches)[] = ["partner", "book", "shop", "create", "askMila", "showMia", "indexable"];

router.patch("/public-card/switches", requireAuth, async (req: Request, res: Response<PublicCardSwitchesResponse | PublicCardErrorResponse>): Promise<void> => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) { bad(res, "body must be an object"); return; }
  const keys = Object.keys(body);
  if (!keys.length) { bad(res, "nothing to change"); return; }
  const patch: Partial<PublicCardSwitches> = {};
  for (const k of keys) {
    if (!(SWITCH_KEYS as string[]).includes(k)) { bad(res, `unknown switch: ${k.slice(0, 40)}`); return; }
    if (typeof body[k] !== "boolean") { bad(res, `${k} must be true or false`); return; }
    patch[k as keyof PublicCardSwitches] = body[k];
  }
  try { res.json(await setSwitches(req.athleteId!, patch)); } catch (err) { fail(res, err); }
});

// Her metrics rail on the Front Door page (her own view only): views · likes · requests · bookings · shop, last 30 days.
router.get("/public-card/metrics", requireAuth, async (req: Request, res: Response<PublicPageMetrics | PublicCardErrorResponse>): Promise<void> => {
  if (!publicCardEnabled()) { res.status(404).json({ error: "Not found", code: "disabled" }); return; }
  res.set("Cache-Control", "no-store");
  try { res.json(await pageMetrics(req.athleteId!)); } catch (err) { fail(res, err); }
});

router.put("/public-card/handle", requireAuth, async (req: Request, res: Response<PublicCardHandleResponse | PublicCardErrorResponse>): Promise<void> => {
  if (typeof req.body?.handle !== "string") { bad(res, "handle must be a string"); return; }
  try { res.json(await changeHandle(req.athleteId!, req.body.handle)); } catch (err) { fail(res, err); }
});

export default router;
