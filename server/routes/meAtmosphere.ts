/**
 * meAtmosphere.ts — the atmosphere picker for screens (DESIGN.md §9), athlete-only, behind ATMOSPHERE_IMAGERY.
 *
 *   POST /me/atmosphere/pick   { screen, slots: [{ key, type, purpose, context?, category? }] }  (1–12 slots)
 *     → { images: [ { key, kind: "image", imageId, url, width, height }
 *                 | { key, kind: "default", category, reason } ] }   (in the order asked)
 *
 * `url` is a short-lived signed read URL of OUR stored copy (never a provider URL). No credit line or source link is
 * served: the app shows no photographer credit (owner decision 10 Oct 2026; the records stay in the table).
 * `kind: "default"` means draw the category default (components/strategy/RecommendationVisual).
 * Slots are filled in order, so no image repeats on the screen; a slot keeps its image once chosen.
 *
 * Tenancy: athleteId comes from the token only; no path, query or body parameter names an athlete.
 * 404 while the flag is off (read per request) · 400 bad input · 401 unauthenticated · 500 { error }.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { atmosphereEnabled } from "../services/atmosphere/config";
import { defaultDeps, pickScreen, PickerInputError, validateSlot, type PickerDeps, type SlotInput } from "../services/atmosphere/picker";

const logger = createLogger("routes/meAtmosphere");

export const MAX_SLOTS = 12;

/** The router over injectable providers (tests pass fakes; the app uses the real ones). */
export function createAtmosphereRouter(deps: PickerDeps = defaultDeps): Router {
  const router = Router();

  router.post("/atmosphere/pick", requireAuth, async (req: Request, res: Response): Promise<void> => {
    if (!atmosphereEnabled()) { res.status(404).json({ error: "Not found" }); return; }
    try {
      const { screen, slots } = req.body ?? {};
      if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_SLOTS) {
        res.status(400).json({ error: `slots must be a list of 1–${MAX_SLOTS}` });
        return;
      }
      const parsed: SlotInput[] = slots.map((s: unknown) => validateSlot(screen, s).slot);
      if (new Set(parsed.map((s) => s.key)).size !== parsed.length) {
        res.status(400).json({ error: "slot keys must be distinct" });
        return;
      }
      res.json({ images: await pickScreen(req.athleteId!, screen, parsed, deps) });
    } catch (err: any) {
      if (err instanceof PickerInputError) { res.status(400).json({ error: err.message }); return; }
      logger.error({ athleteId: req.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "atmosphere pick failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

export default createAtmosphereRouter();
