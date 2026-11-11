/**
 * deleteAthleteAccount.ts — the account delete, in two phases (28 Oct 2026).
 *
 * Why two phases: the delete used to run every manifest table in ONE transaction. With a Mila turn in flight (writing
 * agent_runs / chat_messages for the same athlete) it deadlocked and rolled back, and the turn then wrote new rows
 * (Mastra POC T10). Now no transaction is ever held open across an external call or a running turn.
 *
 * PHASE 1 — requestAccountDeletion (the request; fast):
 *   1. Resolve the scope (athlete row, sign-in users). Refuse while a payment holds money (authorized / funded /
 *      disputed): deleting the deal under live escrow would strand the money.
 *   2. ONE small transaction: set athletes.deletion_requested_at (the fence) and write the receipt — the
 *      account_deletion workflow run (athlete_id NULL, input.subject_athlete_id) with its first step ready. From the
 *      commit on, requireAuth refuses the athlete (410 account_deleting), no workflow run starts for them, a claimed
 *      step stops at its checkpoint, no Mila turn starts or writes, and Mila's tools refuse their pass
 *      (lib/privacy/deletionFence.ts).
 *   3. After commit: cancel their active workflow runs (a Mila turn on Mastra stops writing at the fence; phase 2
 *      waits it out); revoke each provider grant and clear the tokens at once; with a fresh Apple authorization code from the app
 *      (Sign in with Apple users re-confirm with Apple at delete time), revoke the Sign in with Apple grant
 *      (lib/privacy/appleRevoke.ts). The code is single-use, so that revoke is tried once, here, and recorded.
 *   4. Hand phase 2 to the runner (kick now; the minute tick otherwise).
 *
 * PHASE 2 — the account_deletion workflow (accountDeletionSteps.ts): wait out running turns, record what lives outside
 * the database, keep the de-identified financial record, purge the rows in batches, delete and VERIFY the external
 * copies (storage, sign-in user, Langfuse traces) with retries and backoff, recount, and finish only
 * when everything is confirmed. The receipt carries the reconciliation report (attempted / confirmed / pending / failed
 * / skipped per external system); unverified clean-up is never counted as done.
 *
 * The receipt keeps their (dangling) athlete id, sign-in user ids, deal ids and counts only — ids, never content — so a
 * deletion can be proved and server/scripts/privacy/verifyDeletion.ts can find it. The one exception is their sign-in
 * email (input.notify_email), read here before anything is purged and removed by the finish step once the "your account
 * is deleted" email has gone.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { workflowRuns, workflowSteps } from "../../../shared/schema";
import { getRun, kick } from "../../workflow/runner";
import { ACCOUNT_DELETION } from "../../workflow/definitions/accountDeletion";
import type { FinancialRecordResult } from "../../lib/privacy/financialRecords";
import { resolveAthleteScope, rowsOf } from "./athleteScope";
import {
  DELETION_PROCESS, accountDeletionReport, cancelAthleteRuns, revokeAndClearGrants, setRunDeps,
  type AccountDeletionDeps, type DeletionReport, type DeletionRunInput,
} from "./accountDeletionSteps";
import { revokeAppleSignIn } from "../../lib/privacy/appleRevoke";
import { recordItem } from "./accountDeletionSteps";
import { createLogger } from "../../logger";

export { DELETION_PROCESS, accountDeletionReport, type AccountDeletionDeps, type DeletionReport } from "./accountDeletionSteps";

const logger = createLogger("privacy/deleteAthleteAccount");

/** Payment states in which money is held for them (escrow / auth hold / dispute). Terminal or unpaid states don't block. */
export const PAYMENT_STATES_IN_FLIGHT = ["authorized", "reauthorized", "funded", "disputed"] as const;

/** Deal ids kept on the receipt (the run input is capped at 8 KB); beyond this the receipt says it was truncated. */
export const DEAL_IDS_KEPT = 120;

export class AccountDeletionBlocked extends Error {
  constructor(public code: "PAYMENTS_IN_FLIGHT", message: string, public detail: Record<string, unknown> = {}) { super(message); }
}

/** What the athlete's delete request carries beyond who they are. */
export interface AccountDeletionOptions {
  /** A fresh Sign in with Apple authorization code (the app re-confirms with Apple at delete time). */
  appleAuthorizationCode?: string | null;
  /**
   * Who asked: the athlete in the app (default), or a Nomila admin running the deletion for someone without the app
   * (POST /api/v1/admin/athletes/:id/delete, the person the public delete page promises). Recorded as the receipt's
   * created_by. An admin request carries no Apple code (only the athlete's device can get one): when they signed in with
   * Apple (signedInWithApple) the grant is recorded as skipped (apple_no_code_admin_request) rather than silently absent.
   */
  requestedBy?: "athlete" | "admin";
  /** Admin requests: the acting admin's id (athlete or sign-in user id; an id only), kept on the receipt input. */
  requestedByAdminId?: string | null;
  /** Admin requests: their Firebase sign-in user lists apple.com among its providers (read by the admin route). */
  signedInWithApple?: boolean;
}

/** The ledger outcome of the Sign in with Apple grant on an admin-run deletion: no fresh code, so no revoke was possible. */
export const APPLE_ADMIN_NO_CODE = "apple_no_code_admin_request";

/** The ledger ref of the Sign in with Apple grant (one per account; Nomila holds no Apple token of its own). */
export const APPLE_GRANT_REF = "apple_sign_in";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Their sign-in address for the completion email: the athlete row's, else a linked sign-in user's. null when none. */
async function notifyEmailOf(athleteId: string, userIds: string[]): Promise<string | null> {
  const [a] = rowsOf<{ email: string | null }>(await db.execute(sql`SELECT email FROM athletes WHERE id = ${athleteId}::uuid`));
  let email = a?.email?.trim() || null;
  if (!email && userIds.length) {
    const [u] = rowsOf<{ email: string | null }>(await db.execute(sql`
      SELECT email FROM users WHERE id IN (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND email IS NOT NULL ORDER BY created_at LIMIT 1
    `));
    email = u?.email?.trim() || null;
  }
  return email && EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

export interface AccountDeletionRequest {
  receipt_id: string;
  /** "deleting" while phase 2 runs; the run's final status ("done" / "failed") once it has finished. */
  status: string;
  /** True when this request found a deletion already under way (the same receipt is returned). */
  already: boolean;
}

/**
 * PHASE 1. null when the athlete does not exist. Throws AccountDeletionBlocked when money is in flight. Idempotent: a
 * second request while the deletion runs returns the same receipt.
 */
export async function requestAccountDeletion(athleteId: string, deps: AccountDeletionDeps = {}, opts: AccountDeletionOptions = {}): Promise<AccountDeletionRequest | null> {
  const scope = await resolveAthleteScope(db, athleteId);
  if (!scope) return null;
  const idempotencyKey = `${DELETION_PROCESS}:${athleteId}`;
  const existingReceipt = async (): Promise<AccountDeletionRequest | null> => {
    const [r] = rowsOf<{ id: string; status: string }>(await db.execute(sql`
      SELECT id, status FROM workflow_runs WHERE process = ${DELETION_PROCESS} AND idempotency_key = ${idempotencyKey} LIMIT 1
    `));
    return r ? { receipt_id: r.id, status: r.status === "running" || r.status === "waiting" ? "deleting" : r.status, already: true } : null;
  };

  const [flag] = rowsOf<{ deleting: boolean }>(await db.execute(sql`SELECT deletion_requested_at IS NOT NULL AS deleting FROM athletes WHERE id = ${athleteId}::uuid`));
  if (flag?.deleting) {
    const r = await existingReceipt();
    if (r) return r;
  } else {
    const inFlight = rowsOf<{ id: string; status: string; deal_id: string | null }>(await db.execute(sql`
      SELECT id, status, deal_id::text AS deal_id FROM payments
      WHERE athlete_id = ${athleteId}::uuid AND status IN (${sql.join(PAYMENT_STATES_IN_FLIGHT.map((s) => sql`${s}`), sql`, `)})
    `));
    if (inFlight.length) {
      throw new AccountDeletionBlocked("PAYMENTS_IN_FLIGHT",
        "A payment for one of your deals is still being held. It has to be released or refunded before the account can be deleted.",
        { payment_ids: inFlight.map((p) => p.id), deal_ids: inFlight.map((p) => p.deal_id).filter((d): d is string => !!d) });
    }
  }

  const notifyEmail = await notifyEmailOf(athleteId, scope.userIds);
  const dealIds = rowsOf<{ id: string }>(await db.execute(sql`SELECT id::text FROM deals WHERE athlete_id = ${athleteId}::uuid ORDER BY created_at`)).map((d) => d.id);
  const input: DeletionRunInput = {
    subject_athlete_id: athleteId, user_ids: scope.userIds, deal_ids: dealIds.slice(0, DEAL_IDS_KEPT),
    ...(dealIds.length > DEAL_IDS_KEPT ? { deal_ids_truncated: true } : {}), requested_at: new Date().toISOString(),
    ...(notifyEmail ? { notify_email: notifyEmail } : {}),
    ...(opts.requestedBy === "admin" && opts.requestedByAdminId ? { requested_by_admin_id: opts.requestedByAdminId } : {}),
  };

  // The one transaction of phase 1: the fence and the receipt, together (never one without the other). Two rows.
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE athletes SET deletion_requested_at = COALESCE(deletion_requested_at, now()) WHERE id = ${athleteId}::uuid`);
    const [run] = await tx.insert(workflowRuns).values({
      athlete_id: null, process: DELETION_PROCESS, definition_version: ACCOUNT_DELETION.version, active_scope: DELETION_PROCESS,
      status: "running", current_step: ACCOUNT_DELETION.groups[0].map((s) => s.name).join("+"), input: input as any,
      created_by: opts.requestedBy === "admin" ? "admin" : "athlete", idempotency_key: idempotencyKey,
    }).onConflictDoNothing().returning({ id: workflowRuns.id });
    if (!run) return null;   // a concurrent request wrote the receipt first
    for (const step of ACCOUNT_DELETION.groups[0]) {
      await tx.insert(workflowSteps).values({ run_id: run.id, step: step.name, ordinal: 0, attempt: 1, kind: step.kind, status: "ready", ready_at: new Date(), input: {} });
    }
    return run.id;
  });
  if (!created) return (await existingReceipt())!;
  const runId = created;
  setRunDeps(runId, deps);

  // After commit, nothing here holds a transaction. Each part is repeated by phase 2's fence step if this one fails.
  try {
    const canceled = await cancelAthleteRuns(athleteId);
    const grants = await revokeAndClearGrants(runId, athleteId, deps);
    const apple = await revokeAppleGrant(runId, opts.appleAuthorizationCode, deps, opts.requestedBy === "admin" && opts.signedInWithApple === true);
    logger.info({ athleteId, runId, canceledRuns: canceled, grants: grants.length, apple }, "account deletion requested (phase 1 done)");
  } catch (err: any) {
    logger.warn({ athleteId, runId, error: err?.message }, "account deletion: phase 1 clean-up incomplete; phase 2's fence repeats it");
  }

  if (deps.kick !== false) void kick(runId).catch((err: any) => logger.error({ runId, error: err?.message }, "account deletion: kick failed; the tick runs it"));
  return { receipt_id: runId, status: "deleting", already: false };
}

/**
 * The Sign in with Apple grant, with the fresh code the app sent (none: nothing to do, or skipped on an admin request). Recorded on the ledger as
 * provider_grants / apple_sign_in: confirmed when Apple accepted the revoke. A failure or missing config is recorded
 * as skipped with its outcome, not failed: the code is single-use and cannot be retried by phase 2, and the account
 * itself (the Firebase sign-in user) is still deleted and verified. Never throws.
 */
async function revokeAppleGrant(runId: string, code: string | null | undefined, deps: AccountDeletionDeps, adminAppleNoCode = false): Promise<string | null> {
  if (!code) {
    // An admin-run deletion of a Sign in with Apple user never has a code: the grant is recorded as skipped, not attempted
    // (attempts stays 0). The sign-in user itself is still deleted and verified by phase 2; the athlete can remove Nomila
    // in their Apple ID settings. No Apple sign-in ⇒ no Apple line.
    if (adminAppleNoCode) { await recordItem(runId, "provider_grants", APPLE_GRANT_REF, "skipped", APPLE_ADMIN_NO_CODE); return APPLE_ADMIN_NO_CODE; }
    return null;
  }
  const revoke = deps.revokeApple ?? ((c: string) => revokeAppleSignIn(c));
  const r = await revoke(code).catch((err: any) => ({ outcome: "failed" as const, detail: String(err?.message ?? err).slice(0, 120) }));
  if (r.outcome !== "revoked") logger.warn({ runId, outcome: r.outcome, detail: r.detail }, "account deletion: Sign in with Apple grant not revoked");
  await recordItem(runId, "provider_grants", APPLE_GRANT_REF, r.outcome === "revoked" ? "confirmed" : "skipped", r.outcome === "revoked" ? "revoked" : `apple_${r.outcome}`);
  await db.execute(sql`UPDATE account_deletion_items SET attempts = attempts + 1, last_error = ${r.detail ?? null}
    WHERE run_id = ${runId}::uuid AND system = 'provider_grants' AND ref = ${APPLE_GRANT_REF}`);
  return r.outcome;
}

/** Run phase 2 in this process until it finishes or waits (a retry scheduled for later). Returns the run status. */
export async function driveAccountDeletion(runId: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const ran = await kick(runId);
    const found = await getRun(runId);
    const status = found?.run.status ?? "missing";
    if (status !== "running" || ran === 0) return status;
  }
  return (await getRun(runId))?.run.status ?? "missing";
}

export interface AccountDeletionResult {
  receipt_id:        string;
  /** The receipt's status: "done" only when every clean-up is verified; "running" while a retry is scheduled; "failed". */
  status:            string;
  deleted_rows:      Record<string, number>;
  total_rows:        number;
  /** De-identified ledger rows written and payment_events payloads minimized (retention category financial_record). */
  financial_records: FinancialRecordResult;
  scrubbed_rows:     Record<string, number>;
  report:            (DeletionReport & { status: string }) | null;
}

/**
 * Phase 1, then phase 2 driven in this process as far as it goes now (scripts and tests; the route returns after
 * phase 1 and leaves phase 2 to the runner). null when the athlete does not exist.
 */
export async function deleteAthleteAccount(athleteId: string, deps: AccountDeletionDeps = {}): Promise<AccountDeletionResult | null> {
  const req = await requestAccountDeletion(athleteId, { ...deps, kick: false });
  if (!req) return null;
  setRunDeps(req.receipt_id, deps);
  const status = await driveAccountDeletion(req.receipt_id);
  const steps = (await getRun(req.receipt_id))?.steps ?? [];
  const out = (name: string): any => [...steps].reverse().find((s) => s.step === name && s.status === "done")?.output ?? null;
  const purge = out("purge_rows");
  const fin = out("financial_records");
  return {
    receipt_id: req.receipt_id, status,
    deleted_rows: purge?.deleted_rows ?? {}, total_rows: purge?.total_rows ?? 0, scrubbed_rows: purge?.scrubbed_rows ?? {},
    financial_records: fin ? { ledger_rows: fin.ledger_rows, events_minimized: fin.events_minimized } : { ledger_rows: 0, events_minimized: 0 },
    report: await accountDeletionReport(req.receipt_id),
  };
}
