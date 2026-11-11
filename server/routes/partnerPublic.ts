/**
 * partnerPublic.ts — the PUBLIC Partner door of her profile (no account, no cookie). Mounted only while PUBLIC_CARD and
 * PARTNER_INTAKE are both "true" (server/index.ts).
 *
 * JSON, for the public page and public Mila (both on other tracks), under /api/v1/public/cards/:handle/partner:
 *   POST /fit                       { website, brand_name?, about? }  → the light site read + Mila's first read (sealed)
 *   POST /requests                  the request card / press form     → 201 { id, ref, draftToken, seriousOffer, guardianNote }
 *   POST /requests/:id/send         { draft_token }                   → 202 { status: "awaiting_email" } (the confirm email)
 *   POST /requests/:id/hold         { draft_token }                   → { checkoutUrl } — the optional Serious offer hold
 *                                   (Stripe Checkout, manual capture); once held, the confirm email goes automatically
 * HTML, Stripe's return pages for the hold:
 *   GET  /partner/hold/:id/done | /canceled
 * HTML (no script), for the link in the confirm email:
 *   GET  /partner/confirm/:token    the "Send to [First]" page (a GET never confirms: mail scanners open links)
 *   POST /partner/confirm/:token    confirms → 303 to the private status page /r/:token
 *
 * Every call resolves the athlete from the HANDLE through the published card seam (unknown / unpublished / Partner off
 * all answer the same 404). A draft token opens only its own draft, for that athlete.
 */
import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { PARTNER } from "../services/partner/config";
import { KIND_MAP } from "../services/partner/kinds";
import { publishedCard, type PublishedCardFacts } from "../services/partner/publishedCard";
import { readBrandSite, websiteDomain } from "../services/partner/siteRead";
import { fitPreview } from "../services/partner/fit";
import { take } from "../lib/publicRateCounters";
import { createDraft, findByConfirmToken, confirmRequest, openDraft, parseDraftInput, seriousOfferFor, sendForConfirmation } from "../services/partner/requests";
import { randomToken, seal, visitorHash } from "../services/partner/tokens";
import { esc, messagePage, sendPage } from "../services/partner/pages";
import { createSeriousOfferCheckout, heldCentsForRequest, linkHoldToDeal } from "../services/payments/seriousOffer";

const logger = createLogger("routes/partnerPublic");

/** /api/v1/public/cards — the JSON door. */
export const partnerApiRouter = Router();
/** /partner — the confirm page. */
export const partnerConfirmRouter = Router();

const NOT_FOUND = { error: "not found" };

async function cardOr404(req: Request, res: Response): Promise<PublishedCardFacts | null> {
  const card = await publishedCard(req.params.handle);
  if (!card || !card.partnerOpen) { res.status(404).json(NOT_FOUND); return null; }
  res.setHeader("Cache-Control", "no-store");
  return card;
}

// ─── POST /api/v1/public/cards/:handle/partner/fit ───────────────────────────────────────────────────────────
partnerApiRouter.post("/:handle/partner/fit", async (req: Request, res: Response): Promise<void> => {
  const card = await cardOr404(req, res); if (!card) return;
  const domain = websiteDomain(req.body?.website);
  if (!domain) { res.status(400).json({ error: "that doesn't look like a website", field: "website" }); return; }
  const now = new Date();
  if (!(await take(["fit-visitor", visitorHash(req.ip, now)], PARTNER.limits.fitPerVisitorDay, "day", now))) {
    res.status(429).json({ error: "You've asked for a few first reads today. You can still send your request." }); return;
  }
  try {
    const site = await readBrandSite(domain, { now });
    const about = typeof req.body?.about === "string" ? req.body.about.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const brand = (typeof req.body?.brand_name === "string" && req.body.brand_name.trim().slice(0, 120)) || site.meta?.siteName || domain;
    const basis = site.readable ? "site" : about ? "told" : null;
    let preview = null;
    if (basis) {
      const athleteOk = await take(["fit-athlete", card.athleteId], PARTNER.limits.fitPerAthleteDay, "day", now);
      if (athleteOk) preview = (await fitPreview({ card, domain, brand, basis, about: basis === "site" ? site.meta! : about, now })).preview;
    }
    res.json({
      domain,
      site: { readable: site.readable, title: site.meta?.title ?? null, description: site.meta?.description ?? null, siteName: site.meta?.siteName ?? null },
      // The site couldn't be read and nothing was told yet: ask "In a sentence, what does [brand] make?"
      askAbout: !site.readable && !about,
      fit: preview ? { preview, seal: seal({ athleteId: card.athleteId, preview }) } : null,
    });
  } catch (err: any) {
    logger.error({ handle: card.handle, error: err?.message }, "partner fit failed");
    res.status(500).json({ error: "failed" });
  }
});

// ─── POST /api/v1/public/cards/:handle/partner/requests ──────────────────────────────────────────────────────
partnerApiRouter.post("/:handle/partner/requests", async (req: Request, res: Response): Promise<void> => {
  const card = await cardOr404(req, res); if (!card) return;
  const body = req.body ?? {};
  // Honeypot + minimum fill time: answer like a success, store nothing, send nothing.
  const openedAt = Number(body.opened_at);
  if ((typeof body.website_confirm === "string" && body.website_confirm.trim()) || (Number.isFinite(openedAt) && Date.now() - openedAt < PARTNER.minFillMs)) {
    logger.info({ handle: card.handle }, "partner request dropped by the spam check");
    res.status(201).json({ id: "00000000-0000-4000-8000-000000000000", ref: "------", draftToken: randomToken(), seriousOffer: { available: false, amountCents: null }, guardianNote: null });
    return;
  }
  const now = new Date();
  if (!(await take(["draft-visitor", visitorHash(req.ip, now)], PARTNER.limits.draftsPerVisitorDay, "day", now))) {
    res.status(429).json({ error: "Too many requests from here today. Please try again tomorrow." }); return;
  }
  const parsed = parseDraftInput(body, card);
  if (!parsed.ok) { res.status(parsed.status).json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }); return; }
  try {
    const { request, draftToken } = await createDraft(card, parsed.input, now);
    res.status(201).json({
      id: request.id, ref: request.public_ref, draftToken,
      seriousOffer: await seriousOfferFor(card.athleteId, request.kind as any),
      guardianNote: card.minor ? "A parent or guardian will be involved." : null,
    });
  } catch (err: any) {
    logger.error({ handle: card.handle, error: err?.message }, "partner draft failed");
    res.status(500).json({ error: "failed" });
  }
});

// ─── POST /api/v1/public/cards/:handle/partner/requests/:id/send ────────────────────────────────────────────
partnerApiRouter.post("/:handle/partner/requests/:id/send", async (req: Request, res: Response): Promise<void> => {
  const card = await cardOr404(req, res); if (!card) return;
  const row = await openDraft(card, req.params.id, req.body?.draft_token);
  if (!row) { res.status(404).json(NOT_FOUND); return; }
  const r = await sendForConfirmation(row, { holdCents: await heldCentsForRequest(row.id) });
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  res.status(202).json({ status: r.status, press: KIND_MAP[row.kind as keyof typeof KIND_MAP].press });
});

// ─── POST /api/v1/public/cards/:handle/partner/requests/:id/hold — the Serious offer ─────────────────────────
// The visitor's own tap on "Add $X hold · send". Never charged by itself: captured only if she agrees a deal (then it
// counts toward the first payment), otherwise released. The amount is hers to set and is never on the public card.
partnerApiRouter.post("/:handle/partner/requests/:id/hold", async (req: Request, res: Response): Promise<void> => {
  const card = await cardOr404(req, res); if (!card) return;
  const row = await openDraft(card, req.params.id, req.body?.draft_token);
  if (!row || row.status !== "drafting") { res.status(404).json(NOT_FOUND); return; }
  try {
    const r = await createSeriousOfferCheckout(row.id, card.handle);
    if ("error" in r) { res.status(r.error === "already_placed" ? 409 : r.error === "not_available" ? 404 : 502).json({ error: r.error }); return; }
    res.json({ checkoutUrl: r.url });
  } catch (err: any) {
    logger.error({ requestId: row.id, error: err?.message }, "serious offer checkout failed");
    res.status(502).json({ error: "checkout_unavailable" });
  }
});

// ─── GET /partner/hold/:id/done | /canceled — where Stripe sends the visitor back ────────────────────────────
const backLink = (h: unknown) => (typeof h === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(h) ? `<p><a href="/p/${esc(h)}">Back to the profile</a></p>` : "");
partnerConfirmRouter.get("/hold/:id/done", (req: Request, res: Response): void => {
  sendPage(res, "Hold placed", `<div class="card"><h1>Your hold is placed</h1>
<p>It's a hold, not a payment. Check your email: open the link and tap Send to send your request.</p>
<p class="mute">If you agree a deal, the hold counts toward your first payment. If not, it is released. Your bank may show it as pending.</p>${backLink(req.query.h)}</div>`);
});
partnerConfirmRouter.get("/hold/:id/canceled", (req: Request, res: Response): void => {
  sendPage(res, "No hold placed", `<div class="card"><h1>No hold was placed</h1>
<p>You can still send your request without a hold. Both ways reach the athlete, and a hold never buys a yes.</p>${backLink(req.query.h)}</div>`);
});

// ─── GET /partner/confirm/:token — the page; POST confirms ───────────────────────────────────────────────────
partnerConfirmRouter.get("/confirm/:token", async (req: Request, res: Response): Promise<void> => {
  const found = await findByConfirmToken(req.params.token);
  if (!found) { messagePage(res, "This link isn't active", "Check that you opened the latest email from Nomila.", 404); return; }
  if (found.state === "expired") { messagePage(res, "This request has expired", "Requests that aren't confirmed within 72 hours are not sent. You can send a new one from the profile.", 410); return; }
  const { row } = found;
  const first = esc(row.display_name);
  if (found.state === "already") {
    sendPage(res, "Already sent", `<div class="card"><h1>Already sent to ${first}</h1><p>Use the link in the email that followed to see where it stands.</p></div>`);
    return;
  }
  sendPage(res, `Send your request to ${row.display_name}`, `<div class="card">
<h1>Send your request to ${first}</h1>
<p>${first} reviews every request personally. Nothing has been sent yet.</p>
<p class="mute">${esc(KIND_MAP[row.kind as keyof typeof KIND_MAP].label)} · ${esc(row.brand_name)} · Reference ${esc(row.public_ref)}</p>
<form method="post" action="/partner/confirm/${esc(encodeURIComponent(req.params.token))}"><button class="btn" type="submit">Send to ${first}</button></form>
</div>`);
});

partnerConfirmRouter.post("/confirm/:token", async (req: Request, res: Response): Promise<void> => {
  const found = await findByConfirmToken(req.params.token);
  if (!found) { messagePage(res, "This link isn't active", "Check that you opened the latest email from Nomila.", 404); return; }
  if (found.state === "expired") { messagePage(res, "This request has expired", "Requests that aren't confirmed within 72 hours are not sent.", 410); return; }
  try {
    const { statusToken, request, dealId } = await confirmRequest(found.row);
    // A Serious-offer hold now belongs to her deal too ("Verified · $X held") and her 6-day reply clock starts.
    await linkHoldToDeal(request.id, dealId);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(303, `/r/${encodeURIComponent(statusToken)}`);
  } catch (err: any) {
    logger.error({ requestId: found.row.id, error: err?.message }, "partner confirm failed");
    messagePage(res, "Something went wrong", "Please open the link again in a moment.", 500);
  }
});

