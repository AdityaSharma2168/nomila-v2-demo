/**
 * accountDeletionSteps.ts — account deletion PHASE 2: the steps of the account_deletion workflow run
 * (workflow/definitions/accountDeletion.ts) and its reconciliation report.
 *
 * Phase 1 (deleteAthleteAccount.ts requestAccountDeletion) has already, in one small transaction, marked the athlete
 * as deleting (athletes.deletion_requested_at) and written this run; then cancelled their workflow runs and in-flight
 * Mila turns and revoked and cleared their provider tokens. Every step here is idempotent (a step may run twice) and
 * none holds a transaction open across an external call or a running turn:
 *
 *   fence              cancel any of their workflow runs still active; wait (by retrying) until no Mila turn of theirs
 *                      is still running, up to the longest a turn may run
 *   snapshot           record what must be cleaned up outside the database, BEFORE the rows that name it go: their
 *                      storage prefixes and legacy objects, the sign-in user, their Langfuse traces. (Their Mila
 *                      sessions and transcripts are our own rows, purged below; TrueForge, which once held copies, is
 *                      gone, PR 3 of the Mastra-only move.)
 *   financial_records  the de-identified financial record, in one short transaction, exactly once
 *   purge_rows         the Mastra engine's rows (its own schema, engine/mastra/lifecycle.ts), then
 *                      every manifest table in manifest order, in batches of PURGE_BATCH rows, each batch its own short
 *                      statement (a deadlock or serialization failure is retried); shared rows scrubbed
 *   purge_external     each recorded item: deleted and VERIFIED (confirmed), or left pending for the next attempt
 *                      (the runner's backoff), or failed when it cannot succeed; on the last attempt what is still
 *                      pending becomes failed. A "trueforge" item a run recorded before TrueForge was removed,
 *                      pending or already failed, is skipped (trueforge_removed): there is no TrueForge left to
 *                      delete from, so it must not hold the run up.
 *   verify             recount every manifest table for them; a straggler (a write that raced the fence) is purged
 *                      again; anything left fails the attempt
 *   finish             the report; complete only when every item is confirmed (or skipped as not ours). Then the
 *                      items (opaque ids and paths) are removed and the receipt keeps counts only, the "your account
 *                      is deleted" email goes to the address phase 1 kept, and that address is removed from the
 *                      receipt. Otherwise the run fails with the report, and the items (and the address) stay for an
 *                      operator.
 *
 * The ledger (account_deletion_items) is the reconciliation: per system, attempted / confirmed / pending / failed /
 * skipped. Nothing unverified is ever counted as done.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  ATHLETE_DATA_MANIFEST, ATHLETE_STORAGE_COLUMNS, DELETED_ATHLETE_MARKER, SCRUBBED_REFERENCES, athleteWhere, manifestEntry,
  type AthleteScope,
} from "../../lib/athleteDataManifest";
import { deleteAthleteTraces, type TracePurgeResult } from "../../lib/privacy/langfuseTraces";
import { gcsObjectStore, type ObjectStore } from "../../lib/privacy/objectStore";
import { athleteStoragePrefixes, stragglers, type RetryOptions, type StoragePath } from "../../lib/privacy/storagePurge";
import { revokeGrantForDeletion, type GrantToRevoke, type RevokeResult } from "../../lib/privacy/revokeGrants";
import { keepDeidentifiedFinancialRecords, type FinancialRecordResult } from "../../lib/privacy/financialRecords";
import { rowsOf } from "./athleteScope";
import type { AppleRevokeResult } from "../../lib/privacy/appleRevoke";
import { countMastraFootprint, deleteMastraFootprint } from "../../agent/engine/mastra/lifecycle";
import { createLogger } from "../../logger";

const logger = createLogger("privacy/accountDeletion");

export const DELETION_PROCESS = "account_deletion";

/** Rows deleted per statement. Small enough that no statement holds many locks for long. */
export const PURGE_BATCH = 500;

/** How long phase 2 waits for a turn that was running at the fence: past the longest a turn may run, it is stale. */
export const TURN_WINDOW_MS = 6 * 60_000;

/**
 * Systems on the ledger. "trueforge" is no longer recorded (TrueForge is gone); it stays in the type for the items a run
 * recorded before, which purge_external skips.
 */
export type DeletionSystem = "trueforge" | "storage" | "firebase_auth" | "langfuse" | "provider_grants" | "database" | "financial_records";
export const EXTERNAL_SYSTEMS: readonly DeletionSystem[] = ["storage", "firebase_auth", "langfuse", "provider_grants"];

export type ItemStatus = "pending" | "confirmed" | "failed" | "skipped";

/** What the steps call outside the database. Tests inject fakes; the defaults are the real clients. */
export interface AccountDeletionDeps {
  store?:           ObjectStore;
  revoke?:          (g: GrantToRevoke) => Promise<RevokeResult>;
  deleteAuthUser?:  (authId: string) => Promise<void>;
  purgeTraces?:     (athleteId: string) => Promise<TracePurgeResult>;
  retry?:           RetryOptions;
  /** Phase 1: run phase 2 now in the background (default true). */
  kick?:            boolean;
  /** Phase 1: revoke the Sign in with Apple grant with a fresh authorization code. Default: lib/privacy/appleRevoke. */
  revokeApple?:     (authorizationCode: string) => Promise<AppleRevokeResult>;
  /** finish: send the "your account is deleted" email. Default: deletionCompleteEmail.sendDeletionCompleteEmail. */
  sendCompletionEmail?: (to: string, receiptId: string) => Promise<{ sent: boolean }>;
}

/** Deps for one run, set by the caller that started it in this process (tests, scripts). The tick uses the defaults. */
const runDeps = new Map<string, AccountDeletionDeps>();
export function setRunDeps(runId: string, deps: AccountDeletionDeps): void { runDeps.set(runId, deps); }
export const depsFor = (runId: string): AccountDeletionDeps => runDeps.get(runId) ?? {};

export interface DeletionRunInput {
  subject_athlete_id: string;
  user_ids: string[];
  /** Her deal ids (ids only, at most DEAL_IDS_KEPT), so verifyDeletion can look for them after the delete. */
  deal_ids?: string[];
  deal_ids_truncated?: boolean;
  requested_at: string;
  /**
   * Where the "your account is deleted" email goes (their sign-in address, read in phase 1 before anything is purged).
   * The one piece of content the receipt holds, and only until finish has sent the email: then it is removed.
   */
  notify_email?: string;
  /** An admin-run deletion (POST /admin/athletes/:id/delete): the acting admin's id. An id only, never content. */
  requested_by_admin_id?: string;
}

export const scopeOf = (input: DeletionRunInput): AthleteScope => ({ athleteId: input.subject_athlete_id, userIds: input.user_ids ?? [] });

const msg = (err: unknown) => String((err as any)?.message ?? err).slice(0, 300);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── The ledger ───────────────────────────────────────────────────────────────

export async function recordItem(runId: string, system: DeletionSystem, ref: string, status: ItemStatus = "pending", outcome: string | null = null): Promise<void> {
  await db.execute(sql`
    INSERT INTO account_deletion_items (run_id, system, ref, status, outcome)
    VALUES (${runId}::uuid, ${system}, ${ref}, ${status}, ${outcome})
    ON CONFLICT (run_id, system, ref) DO NOTHING
  `);
}

async function setItem(id: number, status: ItemStatus, outcome: string | null, error: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE account_deletion_items
    SET status = ${status}, outcome = ${outcome}, last_error = ${error}, attempts = attempts + 1, updated_at = now()
    WHERE id = ${id}
  `);
}

interface ItemRow { id: number; system: DeletionSystem; ref: string; status: ItemStatus; outcome: string | null; rows: number; attempts: number; last_error: string | null }

async function itemsOf(runId: string, where = sql`TRUE`): Promise<ItemRow[]> {
  return rowsOf<ItemRow>(await db.execute(sql`
    SELECT id, system, ref, status, outcome, rows, attempts, last_error FROM account_deletion_items
    WHERE run_id = ${runId}::uuid AND ${where} ORDER BY id
  `));
}

// ─── The report ───────────────────────────────────────────────────────────────

export interface SystemTally { attempted: number; confirmed: number; pending: number; failed: number; skipped: number }

export interface DeletionReport {
  /** True only when every external item is confirmed (or skipped as not ours) and the rows are verified gone. */
  complete: boolean;
  systems: Partial<Record<DeletionSystem, SystemTally>>;
  database: { tables: number; rows: number };
}

const emptyTally = (): SystemTally => ({ attempted: 0, confirmed: 0, pending: 0, failed: 0, skipped: 0 });

export function reportOf(items: ItemRow[]): DeletionReport {
  const systems: DeletionReport["systems"] = {};
  let tables = 0, rows = 0;
  for (const it of items) {
    if (it.system === "database") { tables++; rows += Number(it.rows); continue; }
    if (it.system === "financial_records") continue;
    const t = (systems[it.system] ??= emptyTally());
    if (Number(it.attempts) > 0) t.attempted++;
    t[it.status]++;
  }
  const complete = Object.values(systems).every((t) => t!.pending === 0 && t!.failed === 0);
  return { complete, systems, database: { tables, rows } };
}

/** The reconciliation report of a deletion run: from the ledger while it runs, from the finish step once it is done. */
export async function accountDeletionReport(runId: string): Promise<(DeletionReport & { status: string }) | null> {
  const [run] = rowsOf<{ status: string; process: string }>(await db.execute(sql`SELECT status, process FROM workflow_runs WHERE id = ${runId}::uuid`));
  if (!run || run.process !== DELETION_PROCESS) return null;
  const [fin] = rowsOf<{ output: any }>(await db.execute(sql`
    SELECT output FROM workflow_steps WHERE run_id = ${runId}::uuid AND step = 'finish' AND status = 'done' ORDER BY attempt DESC LIMIT 1
  `));
  if (fin?.output?.report) return { status: run.status, ...(fin.output.report as DeletionReport) };
  return { status: run.status, ...reportOf(await itemsOf(runId)), complete: false };
}

// ─── Phase 1 helpers (also the fence step's safety net) ─────────────────────────

/** Revoke each provider grant that still holds a token (a few quick tries), then clear the tokens. Never throws. */
export async function revokeAndClearGrants(runId: string, athleteId: string, deps: AccountDeletionDeps): Promise<RevokeResult[]> {
  const revoke = deps.revoke ?? revokeGrantForDeletion;
  const grants = rowsOf<GrantToRevoke>(await db.execute(sql`
    SELECT id, platform, access_token, refresh_token FROM connected_accounts
    WHERE athlete_id = ${athleteId}::uuid AND (access_token IS NOT NULL OR refresh_token IS NOT NULL)
  `));
  const results: RevokeResult[] = [];
  for (const g of grants) {
    let r: RevokeResult = { connection_id: g.id, platform: g.platform, outcome: "failed" };
    for (let i = 0; i < 3; i++) {
      r = await revoke(g).catch((err): RevokeResult => ({ connection_id: g.id, platform: g.platform, outcome: "failed", detail: msg(err) }));
      if (r.outcome !== "failed") break;
      if (i < 2) await sleep(250 * 2 ** i);
    }
    results.push(r);
    // The token goes whatever the provider said: it is what lets Nomila act for them.
    await db.execute(sql`UPDATE connected_accounts SET access_token = NULL, refresh_token = NULL WHERE id = ${g.id}::uuid`);
    const status: ItemStatus = r.outcome === "failed" ? "failed" : r.outcome === "not_supported" ? "skipped" : "confirmed";
    await recordItem(runId, "provider_grants", g.id, status, r.outcome);
    await db.execute(sql`UPDATE account_deletion_items SET attempts = attempts + 1, last_error = ${r.detail ?? null}
      WHERE run_id = ${runId}::uuid AND system = 'provider_grants' AND ref = ${g.id}`);
  }
  return results;
}

/** Cancel every active workflow run of theirs (steps not started are skipped; a running step stops at its checkpoint). */
export async function cancelAthleteRuns(athleteId: string): Promise<number> {
  const runs = rowsOf<{ id: string }>(await db.execute(sql`
    SELECT id FROM workflow_runs WHERE athlete_id = ${athleteId}::uuid AND status IN ('running', 'waiting')
  `));
  if (!runs.length) return 0;
  const ids = sql.join(runs.map((r) => sql`${r.id}::uuid`), sql`, `);
  await db.execute(sql`UPDATE workflow_steps SET status = 'skipped', finished_at = now() WHERE run_id IN (${ids}) AND status IN ('ready', 'waiting')`);
  await db.execute(sql`UPDATE workflow_runs SET status = 'canceled', finished_at = now(), last_error = 'account deletion' WHERE id IN (${ids}) AND status IN ('running', 'waiting')`);
  return runs.length;
}

/** Their Mila turns that are still running and not yet stale. */
async function runningTurns(athleteId: string): Promise<number> {
  const since = new Date(Date.now() - TURN_WINDOW_MS);
  const [r] = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM agent_runs WHERE athlete_id = ${athleteId}::uuid AND status = 'running' AND started_at > ${since}
  `));
  return Number(r?.n ?? 0);
}

// ─── Steps ────────────────────────────────────────────────────────────────────

export async function fenceStep(runId: string, input: DeletionRunInput): Promise<{ canceled_runs: number; grants_revoked: number }> {
  const athleteId = input.subject_athlete_id;
  const canceled_runs = await cancelAthleteRuns(athleteId);
  // Safety net: phase 1 revokes and clears the tokens; a crash between its transaction and that leaves them here.
  const grants = await revokeAndClearGrants(runId, athleteId, depsFor(runId));
  const running = await runningTurns(athleteId);
  if (running > 0) throw new Error(`waiting for ${running} Mila turn(s) to end before the purge`);
  return { canceled_runs, grants_revoked: grants.length };
}

export async function snapshotStep(runId: string, input: DeletionRunInput): Promise<Record<string, number>> {
  const athleteId = input.subject_athlete_id;
  const scope = scopeOf(input);
  const out: Record<string, number> = { storage: 0, firebase_auth: 0, langfuse: 0 };

  // Storage: her prefixes, plus legacy objects her rows name outside them.
  for (const p of athleteStoragePrefixes(athleteId)) { await recordItem(runId, "storage", `prefix:${p.bucket}/${p.prefix}`); out.storage++; }
  const explicit: StoragePath[] = [];
  for (const c of ATHLETE_STORAGE_COLUMNS) {
    const entry = manifestEntry(c.table);
    const rows = rowsOf<{ p: string }>(await db.execute(
      sql`SELECT ${sql.identifier(c.column)} AS p FROM ${entry.table} WHERE ${athleteWhere(entry, scope)} AND ${sql.identifier(c.column)} IS NOT NULL`,
    ));
    for (const r of rows) explicit.push({ bucket: c.bucket(), path: r.p });
  }
  for (const s of stragglers(athleteId, explicit)) { await recordItem(runId, "storage", `object:${s.bucket}/${s.path}`); out.storage++; }

  // The sign-in user (a Microsoft sign-in has no Firebase user).
  const [a] = rowsOf<{ auth_id: string | null }>(await db.execute(sql`SELECT auth_id FROM athletes WHERE id = ${athleteId}::uuid`));
  if (a?.auth_id && !a.auth_id.startsWith("microsoft:")) { await recordItem(runId, "firebase_auth", a.auth_id); out.firebase_auth++; }

  // Langfuse traces are found by her athlete id (one item).
  await recordItem(runId, "langfuse", "traces");
  out.langfuse++;
  return out;
}

export async function financialRecordsStep(runId: string, input: DeletionRunInput): Promise<FinancialRecordResult & { already: boolean }> {
  const athleteId = input.subject_athlete_id;
  let result: FinancialRecordResult = { ledger_rows: 0, events_minimized: 0 };
  let already = false;
  await db.transaction(async (tx) => {
    // Exactly once: the marker item is written in the same transaction as the ledger rows.
    const done = rowsOf(await tx.execute(sql`
      SELECT 1 FROM account_deletion_items WHERE run_id = ${runId}::uuid AND system = 'financial_records' AND ref = 'ledger'
    `));
    if (done.length) { already = true; return; }
    result = await keepDeidentifiedFinancialRecords(tx, athleteId);
    await tx.execute(sql`
      INSERT INTO account_deletion_items (run_id, system, ref, status, outcome, rows, attempts)
      VALUES (${runId}::uuid, 'financial_records', 'ledger', 'confirmed', ${`events_minimized:${result.events_minimized}`}, ${result.ledger_rows}, 1)
    `);
  });
  if (already) {
    const [it] = await itemsOf(runId, sql`system = 'financial_records'`);
    const ev = Number(String(it?.outcome ?? "").split(":")[1] ?? 0);
    result = { ledger_rows: Number(it?.rows ?? 0), events_minimized: Number.isFinite(ev) ? ev : 0 };
  }
  return { ...result, already };
}

const RETRYABLE_PG = new Set(["40P01", "40001", "55P03"]);   // deadlock, serialization failure, lock not available

/** One statement, retried on a deadlock / serialization failure (another writer took the locks first). */
async function withLockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (!RETRYABLE_PG.has(code) || i >= 4) throw err;
      await sleep(100 * 2 ** i);
    }
  }
}

/** Delete their rows of every manifest table, in manifest order, in batches. Returns rows deleted per table. */
export async function purgeRows(scope: AthleteScope, batch = PURGE_BATCH): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  // The Mastra engine's rows (its own schema, outside the manifest) FIRST: its thread ids are our mila_tf_sessions row
  // ids, which the manifest purge removes (engine/mastra/lifecycle.ts). Counted as "mastra.<table>".
  for (const [table, n] of Object.entries(await withLockRetry(() => deleteMastraFootprint(scope.athleteId)))) deleted[`mastra.${table}`] = n;
  for (const entry of ATHLETE_DATA_MANIFEST) {
    let total = 0;
    for (;;) {
      const [row] = rowsOf<{ n: number }>(await withLockRetry(() => db.execute(sql`
        WITH d AS (
          DELETE FROM ${entry.table} WHERE ctid IN (SELECT ctid FROM ${entry.table} WHERE ${athleteWhere(entry, scope)} LIMIT ${batch})
          RETURNING 1
        ) SELECT count(*)::int AS n FROM d
      `)));
      const n = Number(row?.n ?? 0);
      total += n;
      if (n < batch) break;
    }
    if (total > 0) deleted[entry.name] = total;
  }
  return deleted;
}

/** Remove their entries from shared jsonb (SCRUBBED_REFERENCES). One statement per table. */
export async function scrubSharedReferences(athleteId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const like = `%${athleteId}%`;
  for (const ref of SCRUBBED_REFERENCES) {
    const sets = ref.columns.map((c) => {
      const drop = ref.dropArrayEntries?.column === c ? ref.dropArrayEntries : undefined;
      const col = sql.identifier(c);
      // Drop their array entries first (a plan entry is wholly theirs), then replace any remaining mention.
      const value = drop
        ? sql`CASE WHEN jsonb_typeof(${col}) = 'array'
                   THEN COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(${col}) e WHERE e->>${drop.entryKey} IS DISTINCT FROM ${athleteId}), '[]'::jsonb)
                   ELSE ${col} END`
        : col;
      return sql`${col} = replace((${value})::text, ${athleteId}, ${DELETED_ATHLETE_MARKER})::jsonb`;
    });
    const mentions = sql.join(ref.columns.map((c) => sql`${sql.identifier(c)}::text LIKE ${like}`), sql` OR `);
    const [row] = rowsOf<{ n: number }>(await withLockRetry(() => db.execute(sql`
      WITH u AS (UPDATE ${sql.identifier(ref.table)} SET ${sql.join(sets, sql`, `)} WHERE ${mentions} RETURNING 1)
      SELECT count(*)::int AS n FROM u
    `)));
    if (Number(row?.n ?? 0) > 0) out[ref.table] = Number(row.n);
  }
  return out;
}

async function addDatabaseCounts(runId: string, deleted: Record<string, number>): Promise<void> {
  for (const [table, n] of Object.entries(deleted)) {
    await db.execute(sql`
      INSERT INTO account_deletion_items (run_id, system, ref, status, outcome, rows, attempts)
      VALUES (${runId}::uuid, 'database', ${table}, 'confirmed', 'deleted', ${n}, 1)
      ON CONFLICT (run_id, system, ref) DO UPDATE SET rows = account_deletion_items.rows + EXCLUDED.rows,
        attempts = account_deletion_items.attempts + 1, updated_at = now()
    `);
  }
}

export async function purgeRowsStep(runId: string, input: DeletionRunInput): Promise<{ total_rows: number; tables: number; deleted_rows: Record<string, number>; scrubbed_rows: Record<string, number> }> {
  const deleted = await purgeRows(scopeOf(input));
  await addDatabaseCounts(runId, deleted);
  const scrubbed_rows = await scrubSharedReferences(input.subject_athlete_id);
  return { total_rows: Object.values(deleted).reduce((a, b) => a + b, 0), tables: Object.keys(deleted).length, deleted_rows: deleted, scrubbed_rows };
}

async function withCallRetry<T>(fn: () => Promise<T>, { attempts = 3, backoffMs = 250 }: RetryOptions = {}): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) { last = err; if (i < attempts - 1 && backoffMs > 0) await sleep(backoffMs * 2 ** i); }
  }
  throw last;
}

async function defaultDeleteAuthUser(authId: string): Promise<void> {
  const { firebaseAuth } = await import("../../lib/auth.js");
  await firebaseAuth.deleteUser(authId);
}

/** One storage item: delete, then verify (a prefix is re-listed and must be empty). */
async function purgeStorageItem(ref: string, store: ObjectStore, retry: RetryOptions | undefined): Promise<{ status: ItemStatus; outcome: string; error: string | null }> {
  const [kind, rest] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  const bucket = rest.slice(0, rest.indexOf("/"));
  const path = rest.slice(rest.indexOf("/") + 1);
  if (kind === "object") {
    try { await withCallRetry(() => store.remove(bucket, path), retry); return { status: "confirmed", outcome: "deleted", error: null }; }
    catch (err) { return { status: "pending", outcome: "not_deleted", error: msg(err) }; }
  }
  let failed = 0, removed = 0;
  try {
    const names = await withCallRetry(() => store.list(bucket, path), retry);
    for (const name of names) {
      try { await withCallRetry(() => store.remove(bucket, name), retry); removed++; } catch { failed++; }
    }
    const left = await withCallRetry(() => store.list(bucket, path), retry);
    if (left.length === 0) return { status: "confirmed", outcome: removed ? `deleted:${removed}` : "empty", error: null };
    return { status: "pending", outcome: `left:${left.length}`, error: `${left.length} object(s) still under the prefix${failed ? ` (${failed} delete(s) failed)` : ""}` };
  } catch (err) {
    return { status: "pending", outcome: "list_failed", error: msg(err) };
  }
}

export interface PurgeExternalOutput { confirmed: number; pending: number; failed: number; skipped: number }

/**
 * Every unconfirmed external item, once. Throws while anything is pending so the runner retries with backoff; on the
 * last attempt (`final`) what is still pending is marked failed and the step completes, so finish can report it.
 */
export async function purgeExternalStep(runId: string, input: DeletionRunInput, final: boolean): Promise<PurgeExternalOutput> {
  const deps = depsFor(runId);
  const athleteId = input.subject_athlete_id;
  const open = await itemsOf(runId, sql`status = 'pending' AND system IN ('storage', 'firebase_auth', 'langfuse')`);

  // A TrueForge session a run recorded before TrueForge was removed (still pending, or already failed by an earlier
  // attempt that called TrueForge): nothing is left to delete it from, so it is skipped and the run can complete.
  await db.execute(sql`UPDATE account_deletion_items SET status = 'skipped', outcome = 'trueforge_removed', updated_at = now()
    WHERE run_id = ${runId}::uuid AND system = 'trueforge' AND status IN ('pending', 'failed')`);

  // Storage.
  const store = deps.store ?? gcsObjectStore();
  for (const it of open.filter((i) => i.system === "storage")) {
    const r = await purgeStorageItem(it.ref, store, deps.retry);
    await setItem(it.id, r.status, r.outcome, r.error);
  }

  // The sign-in user. "Not found" is confirmed absence.
  for (const it of open.filter((i) => i.system === "firebase_auth")) {
    try {
      await (deps.deleteAuthUser ?? defaultDeleteAuthUser)(it.ref);
      await setItem(it.id, "confirmed", "deleted", null);
    } catch (err: any) {
      if (err?.code === "auth/user-not-found" || err?.errorInfo?.code === "auth/user-not-found") await setItem(it.id, "confirmed", "absent", null);
      else await setItem(it.id, "pending", "not_deleted", msg(err));
    }
  }

  // Langfuse deletes asynchronously: a submitted deletion is confirmed only when a later look finds none.
  for (const it of open.filter((i) => i.system === "langfuse")) {
    const r = await (deps.purgeTraces ?? deleteAthleteTraces)(athleteId)
      .catch((err: any): TracePurgeResult => ({ outcome: "failed", traces: 0, detail: msg(err) }));
    if (r.outcome === "none_found") await setItem(it.id, "confirmed", "none_found", null);
    else if (r.outcome === "not_configured") await setItem(it.id, "skipped", "not_configured", null);
    else if (r.outcome === "deleted") await setItem(it.id, "pending", `submitted:${r.traces}`, "deletion submitted; confirmed when a later look finds none");
    else await setItem(it.id, "pending", "failed", r.detail ?? "Langfuse traces not deleted");
  }

  let report = reportOf(await itemsOf(runId));
  const pending = EXTERNAL_SYSTEMS.reduce((n, s) => n + (report.systems[s]?.pending ?? 0), 0);
  if (pending && !final) {
    const where = EXTERNAL_SYSTEMS.filter((s) => report.systems[s]?.pending).map((s) => `${s} ${report.systems[s]!.pending}`).join(", ");
    throw new Error(`external clean-up pending (${where}); retrying with backoff`);
  }
  if (pending && final) {
    await db.execute(sql`UPDATE account_deletion_items SET status = 'failed', updated_at = now() WHERE run_id = ${runId}::uuid AND status = 'pending'`);
    report = reportOf(await itemsOf(runId));
  }
  const sum = (k: keyof SystemTally) => EXTERNAL_SYSTEMS.reduce((n, s) => n + (report.systems[s]?.[k] ?? 0), 0);
  return { confirmed: sum("confirmed"), pending: sum("pending"), failed: sum("failed"), skipped: sum("skipped") };
}

/** Rows of theirs still in each manifest table (non-zero only). */
export async function remainingRows(scope: AthleteScope): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, n] of Object.entries(await countMastraFootprint(scope.athleteId))) out[`mastra.${table}`] = n;
  for (const entry of ATHLETE_DATA_MANIFEST) {
    const [row] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ${entry.table} WHERE ${athleteWhere(entry, scope)}`));
    if (Number(row?.n ?? 0) > 0) out[entry.name] = Number(row.n);
  }
  return out;
}

export async function verifyStep(runId: string, input: DeletionRunInput): Promise<{ remaining: number; repurged: number }> {
  const scope = scopeOf(input);
  let left = await remainingRows(scope);
  let repurged = 0;
  if (Object.keys(left).length) {
    // A write that raced the fence: purge again (idempotent), then look once more.
    logger.warn({ runId, tables: Object.keys(left) }, "account deletion: rows found after the purge; purging again");
    const again = await purgeRows(scope);
    await addDatabaseCounts(runId, again);
    repurged = Object.values(again).reduce((a, b) => a + b, 0);
    left = await remainingRows(scope);
  }
  const remaining = Object.values(left).reduce((a, b) => a + b, 0);
  if (remaining) throw new Error(`rows remain after the purge: ${Object.entries(left).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  return { remaining, repurged };
}

export async function finishStep(runId: string, input?: DeletionRunInput): Promise<{ report: DeletionReport; completion_email?: "sent" | "not_sent" }> {
  const report = reportOf(await itemsOf(runId));
  if (!report.complete) {
    const bad = Object.entries(report.systems).filter(([, t]) => t!.pending || t!.failed)
      .map(([s, t]) => `${s}: ${t!.confirmed} confirmed, ${t!.pending} pending, ${t!.failed} failed`).join("; ");
    // The items stay (opaque ids / paths), so an operator can finish the job.
    throw new Error(`deletion not verified complete — ${bad}`);
  }
  // Verified: keep counts only.
  await db.execute(sql`DELETE FROM account_deletion_items WHERE run_id = ${runId}::uuid`);
  logger.info({ runId, rows: report.database.rows }, "account deletion verified complete");
  if (!input?.notify_email) return { report };
  // Apple: "provide a confirmation when the deletion is complete". Best effort: a failed email never fails the
  // deletion, and the address goes from the receipt either way (finish never retries).
  let sent = false;
  try {
    const send = depsFor(runId).sendCompletionEmail
      ?? (async (to: string, id: string) => (await import("../../lib/privacy/deletionCompleteEmail.js")).sendDeletionCompleteEmail(to, id));
    sent = (await send(input.notify_email, runId)).sent;
  } catch (err) {
    logger.warn({ runId, error: msg(err) }, "account deletion: completion email failed");
  }
  await db.execute(sql`UPDATE workflow_runs SET input = input - 'notify_email' WHERE id = ${runId}::uuid`);
  return { report, completion_email: sent ? "sent" : "not_sent" };
}
