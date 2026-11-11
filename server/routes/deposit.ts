/**
 * deposit.ts — the account-less BRAND seriousness-deposit surface (public). Mounted at /deposit.
 *
 * The athlete shares a per-deal link (/deposit/:dealId — dealId is the capability
 * token) on their public page / auto-appended in the thread. It creates a card
 * auth-hold via Stripe Checkout and redirects the brand there (plan §5).
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { createDepositCheckoutSession } from "../services/payments/deposit";
import { setCardCsp } from "../lib/securityHeaders";

const router = Router();
const logger = createLogger("routes/deposit");

function msg(m: string): string {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0C0D10;color:#F3EEE4;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:20px"><p style="max-width:340px;line-height:1.5">${m}</p></body>`;
}

// GET /deposit/:dealId — place a seriousness hold; redirect the brand to Stripe Checkout.
router.get("/:dealId", async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await createDepositCheckoutSession(req.params.dealId);
    if ("error" in r) {
      setCardCsp(res);
      if (r.status) { res.type("html").send(msg("A deposit has already been placed for this deal — thank you.")); return; }
      res.status(404).type("html").send(msg("This deposit link is no longer active.")); return;
    }
    res.redirect(303, r.url);
  } catch (err: any) {
    logger.error({ dealId: req.params.dealId, error: err.message }, "deposit link failed");
    setCardCsp(res);
    res.status(500).type("html").send(msg("Something went wrong. Please try again."));
  }
});

// GET /deposit/:dealId/done — post-Checkout landing.
router.get("/:dealId/done", (_req: Request, res: Response): void => {
  setCardCsp(res);
  res.type("html").send(msg("Deposit placed — thank you. This is a hold, not a charge; it's released the moment the athlete responds."));
});

export default router;
