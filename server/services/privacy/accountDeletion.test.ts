/**
 * accountDeletion.test.ts — account deletion in two phases, on PGlite. Every provider is a fake (storage, Firebase,
 * Langfuse, grant revocation); made-up test athletes only.
 *
 *   D1  in-flight turn: a Mila turn is running when the delete arrives. Phase 1 returns while it still runs (no long
 *       transaction, nothing to deadlock on); phase 2 waits it out, then purges everything. (What the turn itself does
 *       at the fence is the Mastra turn's: engine/mastra/mastraTurn.db.test.ts M4.)
 *   D2  fence: after phase 1 no workflow run starts for them and a claimed step stops at its checkpoint.
 *   D3  partial external failure: a Langfuse clean-up that keeps failing is reported pending (never confirmed), the run
 *       retries with backoff and finishes only once it is confirmed; a sign-in user that can never be deleted ends
 *       the run failed with the report, and the ledger keeps the id for an operator.
 *   D4  idempotent: a second request returns the same receipt; every phase 2 step can run again without changing
 *       anything (no second financial record, nothing more deleted).
 *   D5  TrueForge is gone (Mastra-only, PR 3): the snapshot records no TrueForge item, and one a run recorded before the
 *       removal, pending or already failed, is skipped (trueforge_removed), so it does not block completion.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../../services/push/events", () => ({ pushWaiting: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dropCheckConstraints, seedAthleteEverywhere } from "../../testUtils/seedAthleteEverywhere";
import { ATHLETE_DATA_MANIFEST, athleteWhere } from "../../lib/athleteDataManifest";
import { isAthleteDeleting } from "../../lib/privacy/deletionFence";
import { defineWorkflow } from "../../workflow/registry";
import { kick, startRun } from "../../workflow/runner";
import { resolveAthleteScope, type ResolvedScope } from "./athleteScope";
import { accountDeletionReport, driveAccountDeletion, requestAccountDeletion, type AccountDeletionDeps } from "./deleteAthleteAccount";
import { financialRecordsStep, purgeRowsStep, recordItem, snapshotStep, verifyStep, type DeletionRunInput } from "./accountDeletionSteps";
import { PURGE_EXTERNAL_ATTEMPTS } from "../../workflow/definitions/accountDeletion";

const rows = (r: any) => (r.rows ?? r) as any[];

// A step whose run this suite starts for an athlete (the fence must stop it).
const PROBE = defineWorkflow({ process: "deletion_fence_probe", version: 1, steps: [{ name: "touch", kind: "code", run: async () => ({ ran: true }) }] });

beforeAll(async () => {
  await initTestDb();
  await dropCheckConstraints();
}, 120_000);
afterAll(async () => {
  await closeTestDb();
});

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Fake providers. */
function fakes(over: Partial<AccountDeletionDeps> = {}) {
  const authDeleted: string[] = [];
  const deps: AccountDeletionDeps = {
    store: { list: async () => [], remove: async () => {} },
    revoke: async (g) => ({ connection_id: g.id, platform: g.platform, outcome: "revoked" }),
    deleteAuthUser: async (id) => { authDeleted.push(id); },
    purgeTraces: async () => ({ outcome: "none_found", traces: 0 }),
    kick: false,
    ...over,
  };
  return { deps, authDeleted };
}

/** Phase 2 to its end: run what is ready; when a retry is scheduled for later, bring it forward (the backoff, in fast). */
async function settle(runId: string, rounds = 40): Promise<string> {
  for (let i = 0; i < rounds; i++) {
    const status = await driveAccountDeletion(runId);
    if (status !== "running") return status;
    await db.execute(sql`UPDATE workflow_steps SET ready_at = now() - interval '1 second' WHERE run_id = ${runId}::uuid AND status = 'ready'`);
  }
  return "running";
}

/** Their rows in every manifest table (non-zero only). */
async function herRows(scope: ResolvedScope): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of ATHLETE_DATA_MANIFEST) {
    const n = Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM ${e.table} WHERE ${athleteWhere(e, scope)}`))[0].n);
    if (n) out[e.name] = n;
  }
  return out;
}

/** Seeded runs start 'running'; mark them finished so phase 2's fence does not wait on them. */
const finishSeededRuns = (athleteId: string) => db.execute(sql`UPDATE agent_runs SET status = 'completed' WHERE athlete_id = ${athleteId}::uuid`);

const runInput = async (runId: string): Promise<DeletionRunInput> =>
  rows(await db.execute(sql`SELECT input FROM workflow_runs WHERE id = ${runId}::uuid`))[0].input;

// ── D1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("D1: a Mila turn in flight during the delete", () => {
  it("phase 1 returns while the turn runs; phase 2 waits it out, then purges; the bystander keeps everything", async () => {
    const a = await seedAthleteEverywhere("Inflight Test");
    const B = await seedAthlete("Bystander Test");
    const scope = (await resolveAthleteScope(db, a.athleteId))!;
    // Her seeded runs are finished, except one turn started just now and still running.
    await finishSeededRuns(a.athleteId);
    const [turn] = rows(await db.execute(sql`
      INSERT INTO agent_runs (athlete_id, skill_id, skill_version, trigger, provider, model, effort, status, started_at)
      VALUES (${a.athleteId}::uuid, 'chat', 'x', 'chat', 'mastra', 'm', 'low', 'running', now()) RETURNING id`));

    const { deps } = fakes();
    const req = (await requestAccountDeletion(a.athleteId, deps))!;
    expect(req).toMatchObject({ status: "deleting", already: false });
    expect(await isAthleteDeleting(a.athleteId)).toBe(true);
    // Phase 1 never waited on the turn; phase 2's fence step does, while it runs.
    expect(rows(await db.execute(sql`SELECT status FROM agent_runs WHERE id = ${turn.id}::uuid`))[0].status).toBe("running");
    expect(await driveAccountDeletion(req.receipt_id)).toBe("running");
    expect(Object.keys(await herRows(scope)).length).toBeGreaterThan(0);

    // The turn ends (at the fence the Mastra turn stops and writes nothing more): phase 2 purges.
    await db.execute(sql`UPDATE agent_runs SET status = 'stopped' WHERE id = ${turn.id}::uuid`);
    const bBefore = await herRows((await resolveAthleteScope(db, B))!);
    expect(await settle(req.receipt_id)).toBe("done");
    expect(await herRows(scope)).toEqual({});
    expect(await herRows((await resolveAthleteScope(db, B))!)).toEqual(bBefore);
    const report = await accountDeletionReport(req.receipt_id);
    expect(report).toMatchObject({ status: "done", complete: true });
    expect(report!.systems.trueforge).toBeUndefined();
    // Verified complete: the ledger's ids and paths are gone; the receipt keeps counts only.
    expect(rows(await db.execute(sql`SELECT count(*)::int AS n FROM account_deletion_items WHERE run_id = ${req.receipt_id}::uuid`))[0].n).toBe(0);
  }, 120_000);
});

// ── D2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("D2: the fence", () => {
  it("no run starts and a claimed step stops at its checkpoint", async () => {
    const A = await seedAthlete("Fence Test");
    const before = await startRun({ process: PROBE.process, athleteId: A, kick: false });   // queued before the delete
    await db.execute(sql`UPDATE athletes SET deletion_requested_at = now() WHERE id = ${A}::uuid`);

    await expect(startRun({ process: PROBE.process, athleteId: A, kick: false, idempotencyKey: "after" })).rejects.toMatchObject({ code: "athlete_deleting" });
    await kick(before.run.id);
    expect(rows(await db.execute(sql`SELECT status FROM workflow_runs WHERE id = ${before.run.id}::uuid`))[0].status).toBe("canceled");
    expect(rows(await db.execute(sql`SELECT status FROM workflow_steps WHERE run_id = ${before.run.id}::uuid`)).map((r) => r.status)).toEqual(["skipped"]);
  }, 120_000);
});

// ── D3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("D3: partial external failure", () => {
  it("a failing Langfuse clean-up stays pending (never confirmed), is retried with backoff, and the run finishes only once confirmed", async () => {
    const a = await seedAthleteEverywhere("Flaky Langfuse");
    await finishSeededRuns(a.athleteId);
    let calls = 0;
    const { deps } = fakes({
      purgeTraces: async () => (++calls <= 2 ? { outcome: "failed", traces: 0, detail: "Langfuse HTTP 503" } : { outcome: "none_found", traces: 0 }),
    });

    const req = (await requestAccountDeletion(a.athleteId, deps))!;
    expect(await driveAccountDeletion(req.receipt_id)).toBe("running");   // purge_external failed, retry scheduled
    const mid = await accountDeletionReport(req.receipt_id);
    expect(mid).toMatchObject({ status: "running", complete: false });
    expect(mid!.systems.langfuse).toEqual({ attempted: 1, confirmed: 0, pending: 1, failed: 0, skipped: 0 });
    const [retry] = rows(await db.execute(sql`SELECT attempt, ready_at FROM workflow_steps WHERE run_id = ${req.receipt_id}::uuid AND step = 'purge_external' AND status = 'ready'`));
    expect(retry.attempt).toBe(2);
    expect(new Date(retry.ready_at).getTime()).toBeGreaterThan(Date.now() + 20_000);   // backoff, not a hot loop
    // The rows are already gone while the external clean-up is pending.
    expect(await herRows((await resolveAthleteScope(db, a.athleteId)) ?? { athleteId: a.athleteId, userIds: [], authId: null })).toEqual({});

    expect(await settle(req.receipt_id)).toBe("done");
    const fin = await accountDeletionReport(req.receipt_id);
    expect(fin).toMatchObject({ status: "done", complete: true });
    expect(fin!.systems.langfuse).toEqual({ attempted: 1, confirmed: 1, pending: 0, failed: 0, skipped: 0 });
    // Step attempts 1 and 2 failed; attempt 3 found none.
    expect(calls).toBe(3);
  }, 120_000);

  it("a sign-in user that can never be deleted fails the run after the last retry, with the report; the ledger keeps its id", async () => {
    const a = await seedAthleteEverywhere("Stuck Auth");
    await finishSeededRuns(a.athleteId);
    const authId = String(a.rows.get("athletes")!.auth_id);
    let tries = 0;
    const { deps } = fakes({ deleteAuthUser: async () => { tries++; throw Object.assign(new Error("auth/internal-error"), { code: "auth/internal-error" }); } });
    const req = (await requestAccountDeletion(a.athleteId, deps))!;
    expect(await settle(req.receipt_id)).toBe("failed");
    expect(tries).toBe(PURGE_EXTERNAL_ATTEMPTS);
    const report = await accountDeletionReport(req.receipt_id);
    expect(report).toMatchObject({ status: "failed", complete: false });
    expect(report!.systems.firebase_auth).toEqual({ attempted: 1, confirmed: 0, pending: 0, failed: 1, skipped: 0 });
    expect(report!.systems.storage).toMatchObject({ failed: 0 });
    const [run] = rows(await db.execute(sql`SELECT status, last_error FROM workflow_runs WHERE id = ${req.receipt_id}::uuid`));
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("firebase_auth: 0 confirmed, 0 pending, 1 failed");
    const left = rows(await db.execute(sql`SELECT system, ref, status FROM account_deletion_items WHERE run_id = ${req.receipt_id}::uuid AND system = 'firebase_auth'`));
    expect(left).toEqual([{ system: "firebase_auth", ref: authId, status: "failed" }]);
  }, 180_000);
});

// ── D4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("D4: idempotent", () => {
  it("a second request returns the same receipt; every step can run again without changing anything", async () => {
    const a = await seedAthleteEverywhere("Twice");
    await finishSeededRuns(a.athleteId);
    await db.execute(sql`UPDATE payments SET status = 'settled', stripe_charge_id = ${`ch_${randomUUID()}`} WHERE athlete_id = ${a.athleteId}::uuid`);
    const { deps } = fakes();
    const first = (await requestAccountDeletion(a.athleteId, deps))!;
    const second = (await requestAccountDeletion(a.athleteId, deps))!;
    expect(second).toEqual({ receipt_id: first.receipt_id, status: "deleting", already: true });
    expect(rows(await db.execute(sql`SELECT count(*)::int AS n FROM workflow_runs WHERE process = 'account_deletion' AND input->>'subject_athlete_id' = ${a.athleteId}`))[0].n).toBe(1);

    const input = await runInput(first.receipt_id);
    const ledgerBefore = Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n);
    // Each step twice, by hand (at-least-once execution), before the runner runs them.
    await snapshotStep(first.receipt_id, input);
    await snapshotStep(first.receipt_id, input);
    const f1 = await financialRecordsStep(first.receipt_id, input);
    const f2 = await financialRecordsStep(first.receipt_id, input);
    expect(f1).toMatchObject({ ledger_rows: 1, already: false });
    expect(f2).toMatchObject({ ledger_rows: 1, already: true });
    expect(Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n)).toBe(ledgerBefore + 1);
    const p1 = await purgeRowsStep(first.receipt_id, input);
    const p2 = await purgeRowsStep(first.receipt_id, input);
    expect(p1.total_rows).toBeGreaterThan(ATHLETE_DATA_MANIFEST.length - 1);
    expect(p2.total_rows).toBe(0);
    expect(await verifyStep(first.receipt_id, input)).toEqual({ remaining: 0, repurged: 0 });

    // The runner then runs the whole run (each step again) and it still finishes clean, with the counts of the first pass.
    expect(await settle(first.receipt_id)).toBe("done");
    expect(Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n)).toBe(ledgerBefore + 1);
    const report = await accountDeletionReport(first.receipt_id);
    expect(report!.database.rows).toBe(p1.total_rows);
    expect(report!.complete).toBe(true);
    // Gone is gone: a later request finds no account.
    expect(await requestAccountDeletion(a.athleteId, deps)).toBeNull();
  }, 120_000);
});

// ── D5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("D5: TrueForge is gone", () => {
  it("the snapshot records no TrueForge item; one recorded before the removal is skipped and does not block completion", async () => {
    const a = await seedAthleteEverywhere("Old Ledger");
    await finishSeededRuns(a.athleteId);
    const { deps } = fakes();
    const req = (await requestAccountDeletion(a.athleteId, deps))!;
    const out = await snapshotStep(req.receipt_id, await runInput(req.receipt_id));
    expect(out).not.toHaveProperty("trueforge");
    expect(rows(await db.execute(sql`SELECT count(*)::int AS n FROM account_deletion_items WHERE run_id = ${req.receipt_id}::uuid AND system = 'trueforge'`))[0].n).toBe(0);
    // A run that snapshotted before TrueForge was removed has a pending TrueForge session on its ledger.
    await recordItem(req.receipt_id, "trueforge", "tfs-recorded-before-removal");
    expect(await settle(req.receipt_id)).toBe("done");
    const report = await accountDeletionReport(req.receipt_id);
    expect(report!.systems.trueforge).toEqual({ attempted: 0, confirmed: 0, pending: 0, failed: 0, skipped: 1 });
    expect(report!.complete).toBe(true);
  }, 120_000);

  it("one an earlier attempt already marked failed is skipped too, and the run completes", async () => {
    const a = await seedAthleteEverywhere("Old Failed Ledger");
    await finishSeededRuns(a.athleteId);
    const { deps } = fakes();
    const req = (await requestAccountDeletion(a.athleteId, deps))!;
    // An in-flight run whose TrueForge delete had already failed before this deploy.
    await recordItem(req.receipt_id, "trueforge", "tfs-failed-before-removal", "failed", "failed");
    expect(await settle(req.receipt_id)).toBe("done");
    const report = await accountDeletionReport(req.receipt_id);
    expect(report!.systems.trueforge).toEqual({ attempted: 0, confirmed: 0, pending: 0, failed: 0, skipped: 1 });
    expect(report).toMatchObject({ status: "done", complete: true });
  }, 120_000);
});
