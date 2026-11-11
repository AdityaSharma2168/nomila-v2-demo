/**
 * connectReturn.ts — where Stripe Connect onboarding sends the athlete back. Mounted at /connect (public).
 *
 * Stripe's hosted onboarding redirects the browser (no Nomila session) to return_url /
 * refresh_url, which carry the connected account id. The return page re-reads that account
 * from Stripe and syncs connect_accounts — the fallback for a Connect account.updated webhook
 * that never arrived — and, once the account can be paid, releases any payment that was
 * waiting on it. It only ever reads from Stripe and only acts on an account we created; it
 * shows no account details.
 */

import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { connectAccounts } from "../../shared/schema";
import { createLogger } from "../logger";
import { refreshConnectAccountFromStripe } from "../services/payments/connect";
import { releaseDuePayments } from "../services/payments/settle";
import { htmlEscape, setHostedFormCsp } from "../lib/securityHeaders";

const router = Router();
const logger = createLogger("routes/connectReturn");

const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/;

function page(text: string): string {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Payouts</title><body style="font-family:system-ui;background:#0C0D10;color:#F3EEE4;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center"><p style="max-width:340px;line-height:1.5">${htmlEscape(text)}</p></body>`;
}

// GET /connect/return/:accountId — onboarding finished (or was exited); re-check with Stripe.
router.get("/return/:accountId", async (req: Request, res: Response): Promise<void> => {
  setHostedFormCsp(res);
  const accountId = req.params.accountId;
  const back = "You can close this page and return to the Nomila app.";
  if (!ACCOUNT_ID.test(accountId)) { res.status(404).type("html").send(page(back)); return; }
  try {
    const [known] = await db.select({ id: connectAccounts.id }).from(connectAccounts)
      .where(eq(connectAccounts.stripe_account_id, accountId)).limit(1);
    if (!known) { res.status(404).type("html").send(page(back)); return; }

    const synced = await refreshConnectAccountFromStripe(accountId);
    if (synced?.payoutReady) {
      await releaseDuePayments(new Date(), synced.athleteId).catch((err: any) =>
        logger.warn({ accountId, error: err.message }, "release after onboarding failed — the sweep will retry"));
      res.type("html").send(page(`Your payout account is set up. ${back}`));
      return;
    }
    res.type("html").send(page(`Stripe still needs a few details before you can be paid. ${back}`));
  } catch (err: any) {
    logger.error({ accountId, error: err.message }, "connect return refresh failed");
    res.type("html").send(page(back));
  }
});

// GET /connect/refresh/:accountId — the onboarding link expired; a fresh one must come from the app (authenticated).
router.get("/refresh/:accountId", (_req: Request, res: Response): void => {
  setHostedFormCsp(res);
  res.type("html").send(page("This setup link has expired. Open payouts in the Nomila app to continue."));
});

export default router;
