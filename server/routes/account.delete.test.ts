/**
 * DELETE /api/v1/me/account, driven by the athlete data manifest — on PGlite, providers mocked.
 *
 * Two athletes each get a row in EVERY manifest table. The request (phase 1) answers 202 with the receipt and closes the
 * account at once; phase 2 (the account_deletion workflow run) then leaves zero rows for her (by the manifest's own
 * predicate AND by plain table counts), leaves the second byte-for-byte untouched, revokes her grants while the tokens
 * still exist, purges her GCS prefixes and legacy paths (not his), scrubs her id out of the shared
 * research_planner_runs telemetry, deletes her sign-in user and Langfuse traces (mocked), and
 * finishes only when each is confirmed. Concurrency, retries and idempotency: services/privacy/accountDeletion.test.ts.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
const deleteUser = jest.fn().mockResolvedValue(undefined);
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
  firebaseAuth: { deleteUser: (...a: unknown[]) => deleteUser(...a) },
}));

// In-memory GCS: bucket → object names.
const objects = new Map<string, Set<string>>();
const failingPaths = new Set<string>();
const memStore = {
  list: async (bucket: string, prefix: string) => [...(objects.get(bucket) ?? [])].filter((n) => n.startsWith(prefix)),
  remove: async (bucket: string, name: string) => {
    if (failingPaths.has(name)) throw new Error("gcs 503");
    objects.get(bucket)?.delete(name);
  },
};
jest.mock("../lib/privacy/objectStore", () => ({ gcsObjectStore: () => memStore }));

// Revocation is mocked; it records whether her connection (and its token) still existed at call time.
const revokeCalls: Array<{ id: string; platform: string; token: string | null; rowExisted: boolean }> = [];
jest.mock("../lib/privacy/revokeGrants", () => ({
  revokeGrantForDeletion: async (g: any) => {
    const { db } = require("../testUtils/pgliteDb");
    const { sql } = require("drizzle-orm");
    const res = await db.execute(sql`SELECT access_token FROM connected_accounts WHERE id = ${g.id}::uuid`);
    revokeCalls.push({ id: g.id, platform: g.platform, token: g.access_token, rowExisted: (res.rows ?? res).length === 1 });
    return { connection_id: g.id, platform: g.platform, outcome: "revoked" };
  },
}));

// Langfuse is a provider: never reached from a test. It deletes asynchronously: the first look submits the deletion,
// a later look finds none — only then is it confirmed.
const purgeTraces = jest.fn()
  .mockResolvedValueOnce({ outcome: "deleted", traces: 3 })
  .mockResolvedValue({ outcome: "none_found", traces: 0 });
jest.mock("../lib/privacy/langfuseTraces", () => ({ deleteAthleteTraces: (...a: unknown[]) => purgeTraces(...a) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { dropCheckConstraints, seedAthleteEverywhere, countRows, type SeededAthlete } from "../testUtils/seedAthleteEverywhere";
import { ATHLETE_DATA_MANIFEST, athleteWhere, mediaBucketName, attachmentBucketName } from "../lib/athleteDataManifest";
import { resolveAthleteScope, type ResolvedScope } from "../services/privacy/athleteScope";
import { accountDeletionReport, deleteAthleteAccount, driveAccountDeletion } from "../services/privacy/deleteAthleteAccount";
import accountRouter from "./account";

let server: Server; let base: string;
const rows = (r: any) => (r.rows ?? r) as any[];

beforeAll(async () => {
  await initTestDb();
  await dropCheckConstraints();
  const app = express();
  app.use(express.json());
  app.use("/", accountRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });

const del = (athleteId: string) => { (globalThis as any).__TEST_ATHLETE_ID = athleteId; return fetch(`${base}/account`, { method: "DELETE" }); };

const put = (bucket: string, name: string) => { if (!objects.has(bucket)) objects.set(bucket, new Set()); objects.get(bucket)!.add(name); };
const has = (bucket: string, name: string) => objects.get(bucket)?.has(name) ?? false;

/** Seeded runs start 'running'; mark them finished so phase 2's fence does not wait on them. */
const finishSeededRuns = (athleteId: string) => db.execute(sql`UPDATE agent_runs SET status = 'completed' WHERE athlete_id = ${athleteId}::uuid`);

/** Phase 2 to its end: run what is ready; when a retry is scheduled for later, bring it forward (the backoff, in fast). */
async function settle(runId: string, rounds = 40): Promise<string> {
  for (let i = 0; i < rounds; i++) {
    const status = await driveAccountDeletion(runId);
    if (status !== "running") return status;
    await db.execute(sql`UPDATE workflow_steps SET ready_at = now() - interval '1 second' WHERE run_id = ${runId}::uuid AND status = 'ready'`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return "running";
}

/** Her rows of every manifest table, by the manifest predicate. */
async function snapshot(scope: ResolvedScope): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  for (const e of ATHLETE_DATA_MANIFEST) {
    out[e.name] = rows(await db.execute(sql`SELECT * FROM ${e.table} WHERE ${athleteWhere(e, scope)} ORDER BY 1`));
  }
  return out;
}

describe("account deletion — every manifest table", () => {
  let her: SeededAthlete; let him: SeededAthlete;
  let herScope: ResolvedScope; let hisScope: ResolvedScope;

  beforeAll(async () => {
    her = await seedAthleteEverywhere("Her");
    him = await seedAthleteEverywhere("Him");
    await finishSeededRuns(her.athleteId);
    // Her connection holds a (sealed, in real life) token: revoked at the provider, then cleared.
    await db.execute(sql`UPDATE connected_accounts SET access_token = 'tok-her', refresh_token = 'rtok-her' WHERE athlete_id = ${her.athleteId}::uuid`);
    herScope = (await resolveAthleteScope(db, her.athleteId))!;
    hisScope = (await resolveAthleteScope(db, him.athleteId))!;

    // Her objects: one under each prefix, plus a legacy path outside them named by a media row.
    await db.execute(sql`UPDATE media_assets SET gcs_path = 'legacy/her-photo.jpg', gcs_thumb_path = ${`athletes/${her.athleteId}/instagram/t.jpg`} WHERE athlete_id = ${her.athleteId}::uuid`);
    put(mediaBucketName(), `athletes/${her.athleteId}/uploads/a.jpg`);
    put(mediaBucketName(), `athletes/${her.athleteId}/instagram/t.jpg`);
    put(mediaBucketName(), "legacy/her-photo.jpg");
    put(attachmentBucketName(), `athletes/${her.athleteId}/contracts/u1/contract.pdf`);
    put(attachmentBucketName(), `studio-briefs/${her.athleteId}/b.pdf`);
    // His.
    put(mediaBucketName(), `athletes/${him.athleteId}/uploads/b.jpg`);
    put(attachmentBucketName(), `studio-briefs/${him.athleteId}/b.pdf`);

    // Shared planner telemetry: one pass that planned both of them, and one that planned only him.
    const plan = (id: string) => ({ athleteId: id, domains: ["identity"], full: false, trigger: "stale", reserveCalls: 1, estUsd: 0.01, reasons: [`due ${id}`] });
    await db.execute(sql`INSERT INTO research_planner_runs (mode, as_of, policy_version, plans, transitions, error)
      VALUES ('dry_run', now(), 'v1', ${JSON.stringify([plan(her.athleteId), plan(him.athleteId)])}::jsonb, ${JSON.stringify({ materialize: 2, note: `last ${her.athleteId}` })}::jsonb, ${JSON.stringify({ message: `boom ${her.athleteId}` })}::jsonb),
             ('dry_run', now(), 'v1', ${JSON.stringify([plan(him.athleteId)])}::jsonb, '{}'::jsonb, NULL)`);
  }, 120_000);

  it("seeds a row in every manifest table for each athlete", async () => {
    expect(her.rows.size).toBe(ATHLETE_DATA_MANIFEST.length);
    for (const e of ATHLETE_DATA_MANIFEST) expect([e.name, await countRows(e.name)]).toEqual([e.name, 2]);
    const s = await snapshot(herScope);
    for (const e of ATHLETE_DATA_MANIFEST) expect([e.name, s[e.name].length]).toEqual([e.name, 1]);
  });

  it("closes the account at once, then deletes all of hers, leaves his untouched, revokes first, purges her storage and verifies each clean-up", async () => {
    const hisBefore = await snapshot(hisScope);
    const herConnection = her.rows.get("connected_accounts")!;

    // Hold phase 2 back (a local server leaves background work to the cloud tick: lib/backgroundHost) so phase 1's
    // state can be read before the runner moves on; settle() then runs it.
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    let res: Response, again: any;
    try {
      res = await del(her.athleteId);
      again = await (await del(her.athleteId)).json();
    } finally { process.env.NODE_ENV = nodeEnv; }
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, deleting: true, status: "deleting" });
    // Phase 1: fenced, grant revoked while her connection and token still existed, token cleared at once.
    expect(rows(await db.execute(sql`SELECT deletion_requested_at FROM athletes WHERE id = ${her.athleteId}::uuid`))[0].deletion_requested_at).not.toBeNull();
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0]).toMatchObject({ id: herConnection.id, rowExisted: true });
    expect(revokeCalls[0].token).toBe("tok-her");
    const tokens = rows(await db.execute(sql`SELECT access_token, refresh_token FROM connected_accounts WHERE id = ${herConnection.id}::uuid`));
    expect(tokens.every((t) => t.access_token === null && t.refresh_token === null)).toBe(true);
    // A second request while it runs returns the same receipt.
    expect(again).toMatchObject({ receipt_id: body.receipt_id, status: "deleting" });

    expect(await settle(body.receipt_id)).toBe("done");

    // Zero rows remain for her — by the manifest predicate …
    const herAfter = await snapshot(herScope);
    for (const e of ATHLETE_DATA_MANIFEST) expect([e.name, herAfter[e.name].length]).toEqual([e.name, 0]);
    // … and by plain counts: only his row is left in each table (the receipt is the one athlete-less run).
    for (const e of ATHLETE_DATA_MANIFEST) {
      const n = e.name === "workflow_runs"
        ? Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM workflow_runs WHERE athlete_id IS NOT NULL`))[0].n)
        : e.name === "workflow_steps"
          ? Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM workflow_steps WHERE run_id IN (SELECT id FROM workflow_runs WHERE athlete_id IS NOT NULL)`))[0].n)
          : await countRows(e.name);
      expect([e.name, n]).toEqual([e.name, 1]);
    }
    // His rows are exactly as they were.
    expect(await snapshot(hisScope)).toEqual(hisBefore);
    // Shared brand research stays.
    expect(await countRows("inbox_brands")).toBe(1);
    // The shared atmosphere library stays (her placements go with her).
    expect(await countRows("atmosphere_library")).toBe(1);

    // Shared planner telemetry: her plan entry and every mention of her id gone; his kept; no pass deleted.
    const planner = rows(await db.execute(sql`SELECT plans, transitions, error FROM research_planner_runs ORDER BY started_at, id`));
    expect(planner).toHaveLength(2);
    for (const r of planner) expect(JSON.stringify(r)).not.toContain(her.athleteId);
    expect(planner.flatMap((r) => r.plans.map((p: any) => p.athleteId)).sort()).toEqual([him.athleteId, him.athleteId]);
    expect(rows(await db.execute(sql`SELECT count(*)::int AS n FROM research_planner_runs WHERE plans::text LIKE ${"%" + him.athleteId + "%"}`))[0].n).toBe(2);

    // Storage: hers gone (prefixes + the legacy path), his kept.
    expect(has(mediaBucketName(), `athletes/${her.athleteId}/uploads/a.jpg`)).toBe(false);
    expect(has(mediaBucketName(), `athletes/${her.athleteId}/instagram/t.jpg`)).toBe(false);
    expect(has(mediaBucketName(), "legacy/her-photo.jpg")).toBe(false);
    expect(has(attachmentBucketName(), `athletes/${her.athleteId}/contracts/u1/contract.pdf`)).toBe(false);
    expect(has(attachmentBucketName(), `studio-briefs/${her.athleteId}/b.pdf`)).toBe(false);
    expect(has(mediaBucketName(), `athletes/${him.athleteId}/uploads/b.jpg`)).toBe(true);
    expect(has(attachmentBucketName(), `studio-briefs/${him.athleteId}/b.pdf`)).toBe(true);

    // The receipt: an athlete-less run, ids and counts only, with the reconciliation report.
    const [run] = rows(await db.execute(sql`SELECT * FROM workflow_runs WHERE id = ${body.receipt_id}::uuid`));
    expect(run).toMatchObject({ process: "account_deletion", definition_version: 2, status: "done", athlete_id: null });
    expect(run.input.subject_athlete_id).toBe(her.athleteId);
    expect(run.input.deal_ids).toEqual([String(her.rows.get("deals")!.id)]);
    const steps = rows(await db.execute(sql`SELECT step, status, output FROM workflow_steps WHERE run_id = ${body.receipt_id}::uuid AND status = 'done' ORDER BY ordinal`));
    expect(steps.map((s) => s.step)).toEqual(["fence", "snapshot", "financial_records", "purge_rows", "purge_external", "verify", "finish"]);
    const purge = steps.find((s) => s.step === "purge_rows")!.output;
    expect(Object.keys(purge.deleted_rows).sort()).toEqual(ATHLETE_DATA_MANIFEST.map((e) => e.name).sort());
    expect(purge.scrubbed_rows).toEqual({ research_planner_runs: 1 });
    // Langfuse deletes asynchronously: submitted on the first try, confirmed on the next look (so purge_external retried).
    expect(rows(await db.execute(sql`SELECT count(*)::int AS n FROM workflow_steps WHERE run_id = ${body.receipt_id}::uuid AND step = 'purge_external' AND status = 'failed'`))[0].n).toBe(1);
    expect(purgeTraces).toHaveBeenCalledWith(her.athleteId);
    const report = await accountDeletionReport(body.receipt_id);
    expect(report).toMatchObject({ status: "done", complete: true, database: { tables: ATHLETE_DATA_MANIFEST.length, rows: ATHLETE_DATA_MANIFEST.length } });
    expect(report!.systems).toEqual({
      provider_grants: { attempted: 1, confirmed: 1, pending: 0, failed: 0, skipped: 0 },
      storage:         { attempted: 4, confirmed: 4, pending: 0, failed: 0, skipped: 0 },   // 3 prefixes + the legacy object
      firebase_auth:   { attempted: 1, confirmed: 1, pending: 0, failed: 0, skipped: 0 },
      langfuse:        { attempted: 1, confirmed: 1, pending: 0, failed: 0, skipped: 0 },
    });
    // Verified complete: the ledger's ids and paths are gone.
    expect(rows(await db.execute(sql`SELECT count(*)::int AS n FROM account_deletion_items WHERE run_id = ${body.receipt_id}::uuid`))[0].n).toBe(0);

    // The sign-in user.
    expect(deleteUser).toHaveBeenCalledWith(her.rows.get("athletes")!.auth_id);

    // Gone is gone.
    expect((await del(her.athleteId)).status).toBe(404);
  }, 120_000);
});

describe("account deletion — refusals and failures that stay visible", () => {
  it("refuses with 409 while a payment holds money, and changes nothing", async () => {
    const a = await seedAthleteEverywhere("Escrow");
    await db.execute(sql`UPDATE payments SET status = 'funded' WHERE athlete_id = ${a.athleteId}::uuid`);
    const res = await del(a.athleteId);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PAYMENTS_IN_FLIGHT");
    expect(rows(await db.execute(sql`SELECT deletion_requested_at FROM athletes WHERE id = ${a.athleteId}::uuid`))).toEqual([{ deletion_requested_at: null }]);
    expect(rows(await db.execute(sql`SELECT id FROM connected_accounts WHERE athlete_id = ${a.athleteId}::uuid`))).toHaveLength(1);
    expect(rows(await db.execute(sql`SELECT count(*)::int AS n FROM workflow_runs WHERE process = 'account_deletion' AND input->>'subject_athlete_id' = ${a.athleteId}`))[0].n).toBe(0);
  }, 120_000);

  it("deletes the rows first, retries a storage object that will not go, and finally reports it failed (never done)", async () => {
    const a = await seedAthleteEverywhere("Flaky");
    await finishSeededRuns(a.athleteId);
    const stuck = `athletes/${a.athleteId}/uploads/stuck.jpg`;
    put(mediaBucketName(), stuck);
    put(mediaBucketName(), `athletes/${a.athleteId}/uploads/fine.jpg`);
    failingPaths.add(stuck);
    let removes = 0;
    const counting = { list: memStore.list, remove: async (b: string, n: string) => { if (n === stuck) removes++; return memStore.remove(b, n); } };

    const result = await deleteAthleteAccount(a.athleteId, {
      store: counting, retry: { attempts: 3, backoffMs: 0 },
      revoke: async (g) => ({ connection_id: g.id, platform: g.platform, outcome: "revoked" }),
      deleteAuthUser: async () => {}, purgeTraces: async () => ({ outcome: "none_found", traces: 0 }),
    });
    // The rows are gone before the external clean-up finishes; the run is still retrying.
    expect(result!.status).toBe("running");
    expect(rows(await db.execute(sql`SELECT id FROM athletes WHERE id = ${a.athleteId}::uuid`))).toHaveLength(0);
    expect((await accountDeletionReport(result!.receipt_id))!.systems.storage).toMatchObject({ pending: 1 });

    expect(await settle(result!.receipt_id)).toBe("failed");
    expect(removes).toBe(3 * 8);   // 3 tries per attempt × 8 attempts
    expect(has(mediaBucketName(), stuck)).toBe(true);
    expect(has(mediaBucketName(), `athletes/${a.athleteId}/uploads/fine.jpg`)).toBe(false);
    const report = await accountDeletionReport(result!.receipt_id);
    expect(report).toMatchObject({ status: "failed", complete: false });
    expect(report!.systems.storage).toMatchObject({ confirmed: 2, failed: 1, pending: 0 });
    const [run] = rows(await db.execute(sql`SELECT status, last_error FROM workflow_runs WHERE id = ${result!.receipt_id}::uuid`));
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("storage: 2 confirmed, 0 pending, 1 failed");
  }, 180_000);

  it("reports a failed Firebase deletion and trace purge per system, and never calls them done", async () => {
    const a = await seedAthleteEverywhere("NoAuth");
    await finishSeededRuns(a.athleteId);
    const result = await deleteAthleteAccount(a.athleteId, {
      store: memStore,
      revoke: async (g) => ({ connection_id: g.id, platform: g.platform, outcome: "revoked" }),
      deleteAuthUser: async () => { throw new Error("auth/internal-error"); },
      purgeTraces: async () => ({ outcome: "failed", traces: 2, detail: "langfuse delete 500 after 0 of 2" }),
    });
    expect(rows(await db.execute(sql`SELECT id FROM athletes WHERE id = ${a.athleteId}::uuid`))).toHaveLength(0);
    expect(await settle(result!.receipt_id)).toBe("failed");
    const report = await accountDeletionReport(result!.receipt_id);
    for (const s of ["firebase_auth", "langfuse"] as const) expect([s, report!.systems[s]]).toEqual([s, { attempted: 1, confirmed: 0, pending: 0, failed: 1, skipped: 0 }]);
    const [run] = rows(await db.execute(sql`SELECT status, last_error FROM workflow_runs WHERE id = ${result!.receipt_id}::uuid`));
    expect(run.status).toBe("failed");
    for (const s of ["firebase_auth", "langfuse"]) expect(run.last_error).toContain(s);
    // What is left to do stays on the ledger for an operator (opaque ids only).
    const left = rows(await db.execute(sql`SELECT system, ref FROM account_deletion_items WHERE run_id = ${result!.receipt_id}::uuid AND status = 'failed' ORDER BY system`));
    expect(left.map((l) => l.system)).toEqual(["firebase_auth", "langfuse"]);
    expect(left.find((l) => l.system === "firebase_auth")!.ref).toBe(String(a.rows.get("athletes")!.auth_id));
  }, 180_000);
});
