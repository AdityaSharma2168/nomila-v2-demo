/**
 * confirm.ts — the account-less BRAND delivery-confirmation surface (public). Mounted at /confirm.
 *
 * The brand has no Nomila account (plan §2.1/§7). Its credential is the brand-only token
 * (services/payments/brandToken.ts) emailed to the brand when the athlete marks delivered:
 * /confirm/:paymentId?t=<token>. The payment id alone opens nothing — the athlete knows it,
 * and confirming releases her funds.
 *
 * The page is plain HTML with two forms that POST back here (no JavaScript at all; strict
 * CSP via setHostedFormCsp). Every interpolated value is HTML-escaped — the brand name comes
 * from detected inbound email and is untrusted.
 */

import express, { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { confirmDeliveryByBrand, disputeDeliveryByBrand, loadBrandConfirmView } from "../services/payments/settle";
import { htmlEscape, setHostedFormCsp } from "../lib/securityHeaders";

const router = Router();
const logger = createLogger("routes/confirm");

// The forms post application/x-www-form-urlencoded; JSON is accepted too.
router.use(express.urlencoded({ extended: false, limit: "4kb" }));

const INACTIVE = "This confirmation link is no longer active.";

/** `body` must already be escaped HTML. */
function shell(body: string): string {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Confirm delivery</title><body style="font-family:system-ui;background:#0C0D10;color:#F3EEE4;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px"><div style="max-width:360px;width:100%;text-align:center;line-height:1.5">${body}</div></body>`;
}
const msg = (text: string) => shell(`<p>${htmlEscape(text)}</p>`);

function confirmPage(paymentId: string, token: string, brand: string | null, amountCents: number): string {
  const usd = (amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const btn = "display:block;width:100%;padding:14px;margin:8px 0;border-radius:12px;border:0;font-size:16px;font-weight:600;cursor:pointer";
  const action = (path: string) => `/confirm/${encodeURIComponent(paymentId)}/${path}`;
  const hidden = `<input type="hidden" name="t" value="${htmlEscape(token)}">`;
  const who = brand ? htmlEscape(brand) : "your team";
  return shell(`
    <h2 style="font-weight:700;margin:0 0 8px">Confirm delivery</h2>
    <p style="opacity:.8;margin:0 0 20px">Did ${who} receive the agreed work? Confirming releases the ${htmlEscape(usd)} deal payment to the athlete.</p>
    <form method="post" action="${htmlEscape(action("confirm"))}">${hidden}<button type="submit" style="${btn};background:#5B8DEF;color:#fff">Yes — confirm delivered</button></form>
    <form method="post" action="${htmlEscape(action("dispute"))}">${hidden}<button type="submit" style="${btn};background:transparent;color:#F3EEE4;border:1px solid #33353B">Raise an issue instead</button></form>`);
}

const tokenOf = (req: Request): unknown => req.body?.t ?? req.query.t;
const wantsJson = (req: Request) => !!req.is("application/json");

// GET /confirm/:paymentId?t=<token> — the hosted confirmation page.
router.get("/:paymentId", async (req: Request, res: Response): Promise<void> => {
  setHostedFormCsp(res);
  try {
    const view = await loadBrandConfirmView(req.params.paymentId, req.query.t);
    if (!view) { res.status(404).type("html").send(msg(INACTIVE)); return; }
    if (view.status === "settled")  { res.type("html").send(msg("This payment has already been released to the athlete. Thank you.")); return; }
    if (view.status === "disputed") { res.type("html").send(msg("Thanks — this deal is already flagged and we're following up.")); return; }
    if (view.status !== "funded")   { res.type("html").send(msg("This deal isn't awaiting confirmation right now.")); return; }
    res.type("html").send(confirmPage(req.params.paymentId, String(req.query.t), view.brand, view.amountCents));
  } catch (err: any) {
    logger.error({ paymentId: req.params.paymentId, error: err.message }, "confirm page failed");
    res.status(404).type("html").send(msg(INACTIVE)); // e.g. a malformed id — never leak detail
  }
});

// POST /confirm/:paymentId/confirm  (t=<token>) — brand confirms delivery.
router.post("/:paymentId/confirm", async (req: Request, res: Response): Promise<void> => {
  setHostedFormCsp(res);
  try {
    const r = await confirmDeliveryByBrand(req.params.paymentId, tokenOf(req));
    const status = r.ok ? 200 : r.message === "not found" ? 404 : 409;
    if (wantsJson(req)) { res.status(status).json(r); return; }
    const text = !r.ok ? (r.message === "not found" ? INACTIVE : "This deal isn't awaiting confirmation right now.")
      : r.settled ? "Released to the athlete. Thank you!" : "Confirmed. Thank you!";
    res.status(status).type("html").send(msg(text));
  } catch (err: any) {
    logger.error({ paymentId: req.params.paymentId, error: err.message }, "brand confirm failed");
    if (wantsJson(req)) { res.status(500).json({ ok: false, error: "failed" }); return; }
    res.status(500).type("html").send(msg("Something went wrong. Please try again."));
  }
});

// POST /confirm/:paymentId/dispute  (t=<token>) — brand raises an issue.
router.post("/:paymentId/dispute", async (req: Request, res: Response): Promise<void> => {
  setHostedFormCsp(res);
  try {
    const r = await disputeDeliveryByBrand(req.params.paymentId, tokenOf(req));
    if (wantsJson(req)) { res.status(r.ok ? 200 : 404).json(r); return; }
    res.status(r.ok ? 200 : 404).type("html").send(msg(r.ok ? "Thanks — we've paused the release and will follow up." : INACTIVE));
  } catch (err: any) {
    logger.error({ paymentId: req.params.paymentId, error: err.message }, "brand dispute failed");
    if (wantsJson(req)) { res.status(500).json({ ok: false, error: "failed" }); return; }
    res.status(500).type("html").send(msg("Something went wrong. Please try again."));
  }
});

export default router;
