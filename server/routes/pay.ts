/**
 * pay.ts — the account-less BRAND payment surface (public, no auth). Mounted at /pay.
 *
 * Brands have no Nomila account (plan §2.1): the pay link IS the credential. The
 * link opens Stripe's hosted Checkout (itemized deal + 10% + processing) directly —
 * Stripe Checkout is our account-less payment page. The payment id (a random UUID)
 * is the capability token, same as card_shares. Reached via a link dropped into the
 * brand's email/DM thread.
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { createDealCheckoutSession } from "../services/payments/escrow";
import { setHostedFormCsp } from "../lib/securityHeaders";

const router = Router();
const logger = createLogger("routes/pay");

function payMsg(m: string): string {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0C0D10;color:#F3EEE4;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:20px"><p style="max-width:340px;line-height:1.5">${m}</p></body>`;
}

// GET /pay/:paymentId — redirect the brand to the payment's ONE open Checkout session (reused, or created).
router.get("/:paymentId", async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await createDealCheckoutSession(req.params.paymentId);
    if ("error" in r) {
      setHostedFormCsp(res);
      if (r.error === "already paid") {
        res.status(200).type("html").send(payMsg("This payment has already been received — thank you. There is nothing more to pay."));
      } else if (r.error === "processing") {
        res.status(200).type("html").send(payMsg("Your payment is being processed. There is nothing more to pay — you can close this page."));
      } else {
        res.status(404).type("html").send(payMsg("This payment link is no longer active."));
      }
      return;
    }
    res.redirect(303, r.url);
  } catch (err: any) {
    logger.error({ paymentId: req.params.paymentId, error: err.message }, "pay link failed");
    setHostedFormCsp(res);
    res.status(500).type("html").send(payMsg("Something went wrong starting your payment. Please try again."));
  }
});

// GET /pay/:dealId/done — post-Checkout landing (success_url). Cosmetic; the webhook is authoritative.
router.get("/:dealId/done", (_req: Request, res: Response): void => {
  setHostedFormCsp(res);
  res.type("html").send(payMsg("Payment received — thank you. You can close this page. Nomila holds the funds in escrow and releases them to the athlete when the work is confirmed delivered."));
});

export default router;
