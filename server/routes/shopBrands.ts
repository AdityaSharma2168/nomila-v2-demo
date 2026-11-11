/**
 * routes/shopBrands.ts — "From your brands", the athlete's side of the Shopify catalog app
 * (docs/design/shop-her-picks.md §12). Mounted at /api/v1/me only while SHOP_SHOPIFY_APP (and SHOP_V1) are on.
 *
 *   GET  /shop/brands                          installed stores of HER brands, with her approval state
 *   POST /shop/brands/:shopId/request          she asks the brand to let her feature its products
 *   GET  /shop/brands/:shopId/products?q=      the catalog — only once the brand approved her (403 otherwise)
 *   POST /shop/brands/products/:productId/add  a DRAFT pick with her code applied (404 unless approved and hers)
 *
 * TENANCY: requireAuth on every route; the athlete is `req.athleteId`; a store that isn't one of her brands is a 404.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { ShopError } from "../services/shop/items";
import { addFromCatalog, catalogFor, myBrands, requestFeature } from "../services/shopify/approvals";

const logger = createLogger("routes/shop-brands");
const router = Router();
const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function fail(res: Response, err: unknown): void {
  if (err instanceof ShopError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  logger.error({ err }, "shop brands route failed");
  res.status(500).json({ error: "shop operation failed" });
}

router.get("/shop/brands", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try { res.json({ brands: await myBrands(req.athleteId!) }); } catch (err) { fail(res, err); }
});

router.post("/shop/brands/:shopId/request", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!isUuid(req.params.shopId)) { res.status(404).json({ error: "brand not found", code: "not_found" }); return; }
  try { res.json({ brand: await requestFeature(req.athleteId!, req.params.shopId) }); } catch (err) { fail(res, err); }
});

router.get("/shop/brands/:shopId/products", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!isUuid(req.params.shopId)) { res.status(404).json({ error: "brand not found", code: "not_found" }); return; }
  try { res.json({ products: await catalogFor(req.athleteId!, req.params.shopId, req.query.q) }); } catch (err) { fail(res, err); }
});

router.post("/shop/brands/products/:productId/add", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await addFromCatalog(req.athleteId!, req.params.productId);
    res.status(r.existing ? 200 : 201).json(r);
  } catch (err) { fail(res, err); }
});

export default router;
