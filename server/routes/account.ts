/**
 * account.ts — account deletion and data export (CASA data-deletion requirement, the Apple "delete account in-app"
 * blocker, Google Limited Use, and the privacy policy's deletion + export promises).
 *
 * Both routes walk the athlete data manifest (server/lib/athleteDataManifest.ts), so a table cannot be deleted but
 * not exported, or exported but not deleted, and a new table cannot ship unclassified (its guard test fails).
 *
 * DELETE /api/v1/me/account
 *   Phase 1 (services/privacy/deleteAthleteAccount.ts): one small transaction marks the account as deleting and writes
 *   the receipt; from then on every request of theirs is refused (410 account_deleting) and no turn or job writes for
 *   them. Their workflow runs and running Mila turns are cancelled and their provider grants revoked and tokens cleared
 *   before this answers 202 with the receipt id. Phase 2 (the account_deletion workflow) purges every manifest table in
 *   batches, deletes and verifies the external copies (storage, sign-in user, Langfuse) with retries, and
 *   finishes only when everything is confirmed. No soft-delete window: the restricted-scope commitment is a real purge
 *   (backups age out within 7 days). 409 while a payment holds money (with the deal it belongs to, so the app can open
 *   it). Body (optional): { apple_authorization_code } — a fresh Sign in with Apple code; the app asks Apple for one at
 *   delete time when they signed in with Apple, and phase 1 revokes that grant (lib/privacy/appleRevoke.ts). When the
 *   purge is verified done, the run emails them "your account is deleted" (lib/privacy/deletionCompleteEmail.ts).
 *   Called by Settings › Account › Delete account (client/screens/settings/DeleteAccountScreen.tsx); the public web
 *   page for people without the app is server/routes/accountDeletePage.ts (a request form, never a delete).
 *
 * GET /api/v1/me/export
 *   Her data as one JSON document (tokens, other athletes, shared brand research and email text excluded).
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { AccountDeletionBlocked, requestAccountDeletion } from "../services/privacy/deleteAthleteAccount";
import { buildAthleteExport } from "../services/privacy/exportAthleteData";

const logger = createLogger("routes/account");
const router = Router();

// ─── DELETE /api/v1/me/account ────────────────────────────────────────────────

router.delete("/account", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const raw = (req.body as { apple_authorization_code?: unknown } | undefined)?.apple_authorization_code;
  if (raw !== undefined && raw !== null && (typeof raw !== "string" || raw.length > 4096)) {
    res.status(400).json({ error: "apple_authorization_code must be a string" });
    return;
  }
  const appleAuthorizationCode = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  try {
    const result = await requestAccountDeletion(athleteId, {}, { appleAuthorizationCode });
    if (!result) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    // 202: the account is closed now; the purge finishes in the background (status on the receipt).
    res.status(202).json({ ok: true, deleting: true, receipt_id: result.receipt_id, status: result.status });
  } catch (err: any) {
    if (err instanceof AccountDeletionBlocked) {
      const dealIds = Array.isArray(err.detail.deal_ids) ? (err.detail.deal_ids as string[]) : [];
      res.status(409).json({ error: err.message, code: err.code, ...(dealIds[0] ? { deal_id: dealIds[0] } : {}) });
      return;
    }
    logger.error({ athleteId, error: err.message }, "Account deletion failed");
    res.status(500).json({ error: "Account deletion failed — please try again" });
  }
});

// ─── GET /api/v1/me/export ────────────────────────────────────────────────────

router.get("/export", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  try {
    const doc = await buildAthleteExport(athleteId);
    if (!doc) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="nomila-data-${doc.generated_at.slice(0, 10)}.json"`);
    res.json(doc);
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "Data export failed");
    res.status(500).json({ error: "Export failed — please try again" });
  }
});

export default router;
