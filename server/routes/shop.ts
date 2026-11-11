/**
 * routes/shop.ts — Her picks, the athlete's side (docs/design/shop-her-picks.md §5). Mounted at /api/v1/me only while
 * SHOP_V1 is on (server/index.ts).
 *
 *   GET    /shop                     her answers + whether the shelf is open, her picks (clicks 7/30 d), the NIL Go reminder
 *   PUT    /shop/settings            her answers: adult_confirmed · international_student · international_ack ·
 *                                    supplements_opt_in · school_apparel_sponsor
 *   POST   /shop/preview             { url } → what Nomila read + the warnings. Writes nothing.
 *   POST   /shop/items               { url, suggested_blurb? } → a DRAFT (the same link again → the existing pick)
 *   PATCH  /shop/items/:id           title · blurb · category · discount_code · status (live runs the gates;
 *                                    409 needs_confirmation until she resends with confirm_warnings: true)
 *   POST   /shop/items/order         { ids } → her order
 *   DELETE /shop/items/:id           the pick and its click days
 *   GET    /shop/public-preview      exactly what the public read returns, for her preview
 *
 * TENANCY: requireAuth on every route; the athlete is `req.athleteId`, never the body; every service call filters by it.
 * Manual validation (no zod in routes), like the rest of /me.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { shopLinkLimiter } from "../lib/rateLimit";
import { createLogger } from "../logger";
import { eligibility, loadSettings } from "../services/shop/checks";
import { nilGoReminder } from "../services/shop/nilGo";
import { publicShelf } from "../services/shop/publicShelf";
import { reconcilePublishedCard } from "../services/publicCard/reconcile";
import { SHOP_CATEGORIES } from "../services/shop/config";
import { ShopError, addItem, deleteItem, listItems, previewLink, reorderItems, updateItem, updateSettings } from "../services/shop/items";

const logger = createLogger("routes/shop");
const router = Router();
const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function fail(res: Response, err: unknown): void {
  if (err instanceof ShopError) { res.status(err.status).json({ error: err.message, code: err.code, ...err.extra }); return; }
  logger.error({ err }, "shop route failed");
  res.status(500).json({ error: "shop operation failed" });
}

async function settingsView(athleteId: string) {
  const [s, elig] = await Promise.all([loadSettings(athleteId), eligibility(athleteId)]);
  return {
    eligible: elig.eligible,
    needs: elig.needs,
    adultConfirmed: !!s?.adult_confirmed_at,
    internationalStudent: elig.internationalStudent,
    internationalAcknowledged: !!s?.international_ack_at,
    supplementsOn: elig.supplementsOn,
    schoolApparelSponsor: elig.schoolApparelSponsor,
  };
}

router.get("/shop", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  try {
    const [settings, items, nilGo] = await Promise.all([settingsView(athleteId), listItems(athleteId), nilGoReminder(athleteId)]);
    res.json({ settings, items, nilGo, categories: SHOP_CATEGORIES });
  } catch (err) { fail(res, err); }
});

router.put("/shop/settings", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  try {
    await updateSettings(athleteId, (req.body ?? {}) as Record<string, unknown>);
    res.json({ settings: await settingsView(athleteId) });
  } catch (err) { fail(res, err); }
});

router.post("/shop/preview", requireAuth, shopLinkLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const p = await previewLink(req.athleteId!, req.body?.url);
    res.json({ link: p.read, category: p.category, warnings: p.warnings, eligible: p.eligibility.eligible });
  } catch (err) { fail(res, err); }
});

router.post("/shop/items", requireAuth, shopLinkLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await addItem(req.athleteId!, { url: req.body?.url, suggested_blurb: req.body?.suggested_blurb });
    res.status(r.existing ? 200 : 201).json(r);
  } catch (err) { fail(res, err); }
});

router.post("/shop/items/order", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json({ items: await reorderItems(req.athleteId!, req.body?.ids) }); } catch (err) { fail(res, err); }
});

router.patch("/shop/items/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!isUuid(req.params.id)) { res.status(404).json({ error: "pick not found", code: "not_found" }); return; }
  try {
    const out = await updateItem(req.athleteId!, req.params.id, (req.body ?? {}) as Record<string, unknown>);
    // A pick that is no longer live leaves her published public card at once (design-public-card-v3 §10).
    await reconcilePublishedCard(req.athleteId!, "A pick left your shelf, so it came off your public card.");
    res.json(out);
  } catch (err) { fail(res, err); }
});

router.delete("/shop/items/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!isUuid(req.params.id)) { res.status(404).json({ error: "pick not found", code: "not_found" }); return; }
  try {
    await deleteItem(req.athleteId!, req.params.id);
    await reconcilePublishedCard(req.athleteId!, "A pick left your shelf, so it came off your public card.");
    res.status(204).end();
  } catch (err) { fail(res, err); }
});

router.get("/shop/public-preview", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json(await publicShelf(req.athleteId!)); } catch (err) { fail(res, err); }
});

export default router;
