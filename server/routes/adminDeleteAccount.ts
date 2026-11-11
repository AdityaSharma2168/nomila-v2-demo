/**
 * adminDeleteAccount.ts — staff run the app's real account deletion for an athlete (owner approved 10 Nov 2026).
 *
 * The public page (routes/accountDeletePage.ts) promises people without the app that "a person at Nomila" runs their
 * deletion. This is that person's button: the SAME two-phase delete the app's Settings › Delete account runs
 * (services/privacy/deleteAthleteAccount.ts), never a second implementation.
 *
 *   POST /api/v1/admin/athletes/:athleteId/delete   body: { confirmEmail }
 *     Mounted inside the admin router, after requireAdmin: only callers holding the 'admin' role reach it.
 *     400  confirmEmail missing, or not the athlete's sign-in email (any case) — a typed confirmation, so the wrong row
 *          cannot be deleted by a mis-click.
 *     403  SELF_DELETE — the acting admin's own athlete (they delete their own account in the app).
 *     403  PROTECTED_ACCOUNT — anyone holding the admin role (account_roles, user_roles, or a Firebase custom claim
 *          roles: ["admin"] on their sign-in user), or a sign-in email on ADMIN_DELETE_PROTECTED_EMAILS
 *          (comma-separated; default "tester@nomila.co", the App Review account) or equal to REVIEW_LOGIN_EMAIL.
 *     404  no such athlete (or a malformed id).
 *     503  their Firebase sign-in user could not be read (so the claim / Apple checks could not run): nothing deleted.
 *     409  PAYMENTS_IN_FLIGHT — money is held for one of their deals; release or refund it first.
 *     202  phase 1 done: the account is closed now; phase 2 purges in the background, then emails them "your account is
 *          deleted". { ok, receipt_id, status, already } — a repeat while it runs returns the same receipt (already).
 *     One Firebase Admin read of their sign-in user (athletes.auth_id; Microsoft sign-ins have none) gives the custom
 *     claims and the providers. An admin request has no Sign in with Apple code (only their device can get one): when
 *     the providers include apple.com the grant is recorded on the receipt as skipped (apple_no_code_admin_request);
 *     otherwise there is no Apple line. The sign-in user itself is still deleted and verified in phase 2.
 *     The receipt input carries requested_by_admin_id; the audit line holds ids only (admin, athlete, receipt) — never
 *     the email or any content.
 */

import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../logger";
import { AccountDeletionBlocked, requestAccountDeletion } from "../services/privacy/deleteAthleteAccount";
import { resolveAthleteScope, rowsOf } from "../services/privacy/athleteScope";
import { firebaseAuth } from "../lib/auth";

const logger = createLogger("routes/adminDeleteAccount");
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/** Sign-in emails that can never be deleted from the admin page (the App Review account by default). */
export function protectedEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const list = (env.ADMIN_DELETE_PROTECTED_EMAILS ?? "tester@nomila.co").split(",").map(norm).filter(Boolean);
  if (env.REVIEW_LOGIN_EMAIL) list.push(norm(env.REVIEW_LOGIN_EMAIL));
  return new Set(list);
}

/** Their Firebase sign-in user: admin by custom claim? signed in with Apple? No sign-in user (none, Microsoft, not found): neither. Any other read failure throws (the route answers 503 and deletes nothing). */
async function firebaseFacts(authId: string | null): Promise<{ claimAdmin: boolean; apple: boolean }> {
  if (!authId || authId.startsWith("microsoft:")) return { claimAdmin: false, apple: false };
  try {
    const u = await firebaseAuth.getUser(authId);
    const roles = (u.customClaims as { roles?: unknown } | undefined)?.roles;
    return {
      claimAdmin: Array.isArray(roles) && roles.includes("admin"),
      apple: (u.providerData ?? []).some((p) => p?.providerId === "apple.com"),
    };
  } catch (err: any) {
    if (err?.code === "auth/user-not-found") return { claimAdmin: false, apple: false };
    throw Object.assign(new Error("firebase user lookup failed"), { firebaseLookup: true, cause: err });
  }
}

router.post("/athletes/:athleteId/delete", async (req: Request, res: Response): Promise<void> => {
  const { athleteId } = req.params;
  const adminId = req.athleteId ?? req.userId ?? null;
  const raw = (req.body as { confirmEmail?: unknown } | undefined)?.confirmEmail;
  const confirmEmail = typeof raw === "string" ? norm(raw) : "";
  if (!confirmEmail || confirmEmail.length > 254) {
    res.status(400).json({ error: "Type the athlete's sign-in email to confirm", code: "CONFIRM_EMAIL_REQUIRED" });
    return;
  }
  if (!UUID_RE.test(athleteId)) { res.status(404).json({ error: "Athlete not found" }); return; }
  if (req.athleteId && req.athleteId.toLowerCase() === athleteId.toLowerCase()) {
    res.status(403).json({ error: "Delete your own account in the app", code: "SELF_DELETE" });
    return;
  }

  try {
    const scope = await resolveAthleteScope(db, athleteId);
    if (!scope) { res.status(404).json({ error: "Athlete not found" }); return; }

    // Their sign-in emails: the athlete row's and those of the sign-in users that are theirs alone.
    const [a] = rowsOf<{ email: string | null }>(await db.execute(sql`SELECT email FROM athletes WHERE id = ${athleteId}::uuid`));
    const emails = new Set<string>([norm(a?.email)].filter(Boolean));
    if (scope.userIds.length) {
      const users = rowsOf<{ email: string | null }>(await db.execute(sql`
        SELECT email FROM users WHERE id IN (${sql.join(scope.userIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `));
      for (const u of users) if (norm(u.email)) emails.add(norm(u.email));
    }

    // Protected accounts first (a matching email must not reveal more than a mismatching one about them).
    const guarded = protectedEmails();
    const roles = rowsOf<{ role: string }>(await db.execute(sql`
      SELECT role FROM account_roles WHERE account_id = ${athleteId}::uuid
      ${scope.userIds.length ? sql`UNION SELECT role FROM user_roles WHERE user_id IN (${sql.join(scope.userIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
    `)).map((r) => r.role);
    const fb = await firebaseFacts(scope.authId);
    if (roles.includes("admin") || fb.claimAdmin || [...emails].some((e) => guarded.has(e))) {
      logger.warn({ adminId, athleteId }, "admin delete refused: protected account");
      res.status(403).json({ error: "This is a protected staff or review account and cannot be deleted here", code: "PROTECTED_ACCOUNT" });
      return;
    }

    if (!emails.has(confirmEmail)) {
      res.status(400).json({ error: emails.size ? "That is not this athlete's sign-in email" : "This athlete has no sign-in email to confirm against", code: "CONFIRM_EMAIL_MISMATCH" });
      return;
    }

    const result = await requestAccountDeletion(athleteId, {}, { requestedBy: "admin", requestedByAdminId: adminId, signedInWithApple: fb.apple });
    if (!result) { res.status(404).json({ error: "Athlete not found" }); return; }
    logger.info({ adminId, athleteId, receiptId: result.receipt_id, already: result.already }, "admin account deletion requested");
    res.status(202).json({ ok: true, receipt_id: result.receipt_id, status: result.status, already: result.already });
  } catch (err: any) {
    if (err instanceof AccountDeletionBlocked) {
      const dealIds = Array.isArray(err.detail.deal_ids) ? (err.detail.deal_ids as string[]) : [];
      res.status(409).json({ error: err.message, code: err.code, ...(dealIds.length ? { deal_ids: dealIds } : {}) });
      return;
    }
    if (err?.firebaseLookup) {
      logger.warn({ adminId, athleteId, error: String(err.cause?.code ?? err.cause?.message ?? "").slice(0, 80) }, "admin delete: Firebase user lookup failed; nothing deleted");
      res.status(503).json({ error: "Could not check their sign-in account — nothing was deleted; try again", code: "SIGN_IN_LOOKUP_FAILED" });
      return;
    }
    logger.error({ adminId, athleteId, error: err?.message }, "admin account deletion failed");
    res.status(500).json({ error: "Account deletion failed — please try again" });
  }
});

export default router;
