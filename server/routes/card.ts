/**
 * card.ts — the Nomi Card read routes (moved out of server/index.ts so they can be tested).
 *
 *   GET /card/:athleteId        the card HTML. OWNER-ONLY preview: anyone else gets 404.
 *   GET /api/card/themes        the card looks. Public (a static list).
 *   GET /api/card/:athleteId    the signed MediaKitData JSON the app renders. requireAuth + ownership.
 *   GET /c/:shareId             a SHARED card — the only public way to view one. Never builds a kit.
 *
 * Why (security fix A1): both card routes used to be public by athlete id, so anyone holding an
 * athlete UUID got her brand-tailored pitches (?brandId), every rate and package, the cards she had
 * removed, and could run the paid multi-model kit build on demand (?refresh=1 / any cache miss).
 * Public viewing now goes only through the share layer (kitShare.ts: revoke, expiry, recipient
 * token, open tracking), and only the athlete's own authenticated calls can start a build.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth, authenticateRequest } from "../lib/auth";
import { setCardCsp } from "../lib/securityHeaders";
import { publicCardLimiter, shareLinkLimiters } from "../lib/rateLimit";
import { createLogger } from "../logger";

const logger = createLogger("card-routes");
const router = Router();

export const cardMsg = (m: string) =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0C0D10;color:#F3EEE4;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:20px"><p style="max-width:320px;line-height:1.5">${m}</p></body>`;

const notFoundHtml = (res: Response) => res.status(404).type("html").send(cardMsg("Card not found."));

// GET /card/:athleteId — the card HTML, for the athlete's OWN preview (any look via ?theme, brand
// decks via ?brandId, a forced rebuild via ?refresh=1). Not public: a missing/invalid token, or a
// token for a different athlete, gets the same 404 as an unknown id, so ids can't be probed. Brands
// see the card through a share (/c/:shareId).
router.get("/card/:athleteId", publicCardLimiter, async (req: Request, res: Response) => {
  const failure = await authenticateRequest(req);
  if (failure || req.athleteId !== req.params.athleteId) {
    notFoundHtml(res);
    return;
  }
  try {
    const { getOrBuildKit, signKit, applyThemeImagery } = await import("../services/kitCache.js");
    const { renderKitHtml } = await import("../services/kitRenderer.js");
    const { getOverrides } = await import("../services/cardOverrides.js");
    const brandId = req.query.brandId ? Number(req.query.brandId) : undefined; // per-brand tailored card
    const refresh = req.query.refresh === "1"; // bypass the cache, assemble fresh (owner only)
    const kit = await getOrBuildKit(req.params.athleteId, { brandId: brandId || undefined, refresh });
    const theme = typeof req.query.theme === "string" ? req.query.theme : undefined; // preview a look
    const chrome = typeof req.query.chrome === "string" ? req.query.chrome : undefined; // ?chrome=none → native shell owns the action bar
    const ov = await getOverrides(req.params.athleteId, brandId || 0); // manual photo picks win over per-look auto
    const themed = applyThemeImagery(kit, theme ?? kit.tokens?.theme ?? "nomila", new Set(Object.keys(ov?.images ?? {})));
    setCardCsp(res); // relax CSP for the card HTML
    // Luxe/Campaign are drawn by the brand book's engine (services/nomiDeck). ?edition=page previews the public page.
    const { engineDrawsTheme, renderNomiForWeb } = await import("../services/nomiDeck/index.js");
    const look = theme ?? themed.tokens?.theme;
    if (engineDrawsTheme(look)) {
      if (req.query.edition === "page" && !brandId) {
        // The public page as visitors will see it (front door v2.1, simplified): her doors as her card has them.
        const { renderOwnerPublicPage } = await import("../services/nomiDeck/publicPage.js");
        res.type("html").send(await renderOwnerPublicPage(req.params.athleteId, themed, look));
        return;
      }
      res.type("html").send(await renderNomiForWeb(themed, { theme: look, mode: "deck" }));
      return;
    }
    res.type("html").send(renderKitHtml(await signKit(themed), theme, { chrome }));
  } catch (err: any) {
    logger.warn({ athleteId: req.params.athleteId, error: err?.message?.slice(0, 120) }, "card render failed");
    notFoundHtml(res);
  }
});

// GET /api/card/themes — which card looks exist (for the preview theme-switcher). Public.
// Registered BEFORE /api/card/:athleteId so "themes" is never read as an athlete id.
router.get("/api/card/themes", async (_req: Request, res: Response) => {
  // The picker offers the three looks (Nomila, Luxe, Broadcast — 23 Oct 2026); a deck on a retired look renders in Nomila.
  const { listPickableThemes } = await import("../services/kitRenderer.js");
  res.json({ themes: listPickableThemes() });
});

// GET /api/card/:athleteId[?brandId=N] — the signed MediaKitData JSON the app renders. brandId>0
// serves the brand-TAILORED deck (a pitch); omitted/0 serves the generic card. The caller must act
// for that athlete (the same check every /api/v1/athletes/:id route makes).
router.get("/api/card/:athleteId", requireAuth, async (req: Request, res: Response) => {
  if (req.athleteId !== req.params.athleteId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const { getOrBuildKit, signKit } = await import("../services/kitCache.js");
    const brandId = Number(req.query.brandId) || 0;
    res.json(await signKit(await getOrBuildKit(req.params.athleteId, brandId ? { brandId } : {})));
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

// GET /c/:shareId — a shared Nomi Card. Live → the CACHED canonical kit; snapshot → the frozen
// copy. Enforces revoke/expiry/recipient scope, logs the open, injects a dwell beacon. Public, and
// never builds a kit (resolveShare reads the cache only).
router.get("/c/:shareId", ...shareLinkLimiters, async (req: Request, res: Response) => {
  try {
    const { resolveShare, logShareView } = await import("../services/kitShare.js");
    const { signKit, applyThemeImagery } = await import("../services/kitCache.js");
    const { renderKitHtml } = await import("../services/kitRenderer.js");
    const token = typeof req.query.t === "string" ? req.query.t : undefined;
    const r = await resolveShare(req.params.shareId, token);
    if (!r) {
      notFoundHtml(res);
      return;
    }
    if (r.gated) {
      const msg =
        r.reason === "revoked"
          ? "This link has been turned off."
          : r.reason === "expired"
            ? "This link has expired."
            : r.reason === "unavailable"
              ? "This card is being refreshed — please check back shortly."
              : "This card was shared privately — please open it from your original link.";
      const status = r.reason === "recipient-only" ? 403 : r.reason === "unavailable" ? 503 : 410;
      res.status(status).type("html").send(cardMsg(msg));
      return;
    }
    const viewId = await logShareView(req.params.shareId, { token });
    const beaconFor = (vid: string) => {
      const beat = "/c/" + req.params.shareId + "/beat";
      return `<script>(function(){var s=Date.now();function b(){try{fetch(${JSON.stringify(beat)},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({viewId:${JSON.stringify(vid)},dwellMs:Date.now()-s}),keepalive:true})}catch(e){}}document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")b()});window.addEventListener("pagehide",b);})();</script>`;
    };
    // External / hand-built deck (custom_html): serve it verbatim, with the SAME open-log + dwell beacon.
    if (r.customHtml) {
      let html = r.customHtml;
      if (viewId) {
        const beacon = beaconFor(viewId);
        html = html.includes("</body>") ? html.replace("</body>", beacon + "</body>") : html + beacon;
      }
      setCardCsp(res);
      res.type("html").send(html);
      return;
    }
    const theme = typeof req.query.theme === "string" ? req.query.theme : undefined;
    const { getOverrides } = await import("../services/cardOverrides.js");
    const ov = r.athleteId ? await getOverrides(r.athleteId, r.brandId ?? 0) : null; // manual picks win over per-look auto
    const themed = applyThemeImagery(r.kit!, theme ?? r.kit!.tokens?.theme ?? "nomila", new Set(Object.keys(ov?.images ?? {})));
    const { engineDrawsTheme, renderNomiForWeb } = await import("../services/nomiDeck/index.js");
    const look = theme ?? themed.tokens?.theme;
    let html = engineDrawsTheme(look) ? await renderNomiForWeb(themed, { theme: look }) : renderKitHtml(await signKit(themed), theme);
    if (viewId) html = html.replace("</body>", beaconFor(viewId) + "</body>");
    setCardCsp(res); // relax CSP for the card HTML
    res.type("html").send(html);
  } catch (err: any) {
    logger.warn({ shareId: req.params.shareId, error: err?.message?.slice(0, 120) }, "share render failed");
    notFoundHtml(res);
  }
});

export default router;
