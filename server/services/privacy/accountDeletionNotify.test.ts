/**
 * accountDeletionNotify.test.ts — what the in-app delete adds to the two-phase deletion (5 Nov 2026), on PGlite with
 * every provider faked:
 *
 *   N1  the completion email: phase 1 keeps their sign-in address on the receipt; the finish step sends "your account
 *       is deleted" exactly once when the purge is verified, then removes the address from the receipt.
 *   N2  a failed completion email never fails the deletion (the address still goes).
 *   N3  no completion email while the deletion is not verified (the run fails; nothing is sent).
 *   N4  Sign in with Apple: a fresh code is revoked in phase 1 and recorded as confirmed; a revoke that cannot happen
 *       (missing Apple config) is recorded as skipped with its outcome and does not hold the deletion up.
 *   N5  the 409 names the deal whose payment is held.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../../services/push/events", () => ({ pushWaiting: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
// The real sender is never reached: any send that is not the injected fake fails the test.
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => { throw new Error("tests never send real email"); }) }));

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dropCheckConstraints } from "../../testUtils/seedAthleteEverywhere";
import { AccountDeletionBlocked, APPLE_GRANT_REF, driveAccountDeletion, requestAccountDeletion, type AccountDeletionDeps } from "./deleteAthleteAccount";

const rows = (r: any) => (r.rows ?? r) as any[];

beforeAll(async () => { await initTestDb(); await dropCheckConstraints(); }, 120_000);
afterAll(async () => { await closeTestDb(); });

function fakes(over: Partial<AccountDeletionDeps> = {}) {
  const sent: Array<{ to: string; receiptId: string }> = [];
  const deps: AccountDeletionDeps = {
    store: { list: async () => [], remove: async () => {} },
    revoke: async (g) => ({ connection_id: g.id, platform: g.platform, outcome: "revoked" }),
    deleteAuthUser: async () => {},
    purgeTraces: async () => ({ outcome: "none_found", traces: 0 }),
    sendCompletionEmail: async (to, receiptId) => { sent.push({ to, receiptId }); return { sent: true }; },
    kick: false,
    ...over,
  };
  return { deps, sent };
}

async function settle(runId: string, rounds = 40): Promise<string> {
  for (let i = 0; i < rounds; i++) {
    const status = await driveAccountDeletion(runId);
    if (status !== "running") return status;
    await db.execute(sql`UPDATE workflow_steps SET ready_at = now() - interval '1 second' WHERE run_id = ${runId}::uuid AND status = 'ready'`);
  }
  return "running";
}

const inputOf = async (runId: string) => rows(await db.execute(sql`SELECT input FROM workflow_runs WHERE id = ${runId}::uuid`))[0].input;
const appleItem = async (runId: string) =>
  rows(await db.execute(sql`SELECT status, outcome FROM account_deletion_items WHERE run_id = ${runId}::uuid AND system = 'provider_grants' AND ref = ${APPLE_GRANT_REF}`))[0];

describe("completion email", () => {
  it("N1: keeps the address in phase 1, sends once when verified done, then removes it from the receipt", async () => {
    const id = await seedAthlete("Notify Test", { auth_id: `auth-${randomUUID()}`, email: "notify.test@example.com" });
    const f = fakes();
    const req = (await requestAccountDeletion(id, f.deps))!;
    expect((await inputOf(req.receipt_id)).notify_email).toBe("notify.test@example.com");
    expect(f.sent).toHaveLength(0);
    expect(await settle(req.receipt_id)).toBe("done");
    expect(f.sent).toEqual([{ to: "notify.test@example.com", receiptId: req.receipt_id }]);
    expect((await inputOf(req.receipt_id)).notify_email).toBeUndefined();
  }, 120_000);

  it("N2: a failed email never fails the deletion, and the address still goes", async () => {
    const id = await seedAthlete("Notify Fail", { auth_id: `auth-${randomUUID()}`, email: "notify.fail@example.com" });
    const f = fakes({ sendCompletionEmail: async () => { throw new Error("gmail 503"); } });
    const req = (await requestAccountDeletion(id, f.deps))!;
    expect(await settle(req.receipt_id)).toBe("done");
    expect((await inputOf(req.receipt_id)).notify_email).toBeUndefined();
  }, 120_000);

  it("N3: sends nothing while the deletion is not verified", async () => {
    const id = await seedAthlete("Notify Unverified", { auth_id: `auth-${randomUUID()}`, email: "notify.unverified@example.com" });
    const f = fakes({ deleteAuthUser: async () => { throw Object.assign(new Error("auth/internal-error"), { code: "auth/internal-error" }); } });
    const req = (await requestAccountDeletion(id, f.deps))!;
    expect(await settle(req.receipt_id)).toBe("failed");
    expect((await inputOf(req.receipt_id)).notify_email).toBe("notify.unverified@example.com");   // kept for an operator
    expect(f.sent).toHaveLength(0);
  }, 180_000);
});

describe("Sign in with Apple", () => {
  it("N4: revokes with the fresh code in phase 1 and records it confirmed", async () => {
    const id = await seedAthlete("Apple Test", { auth_id: `auth-${randomUUID()}` });
    const codes: string[] = [];
    const f = fakes({ revokeApple: async (c) => { codes.push(c); return { outcome: "revoked" }; } });
    const req = (await requestAccountDeletion(id, f.deps, { appleAuthorizationCode: "c0de-fresh" }))!;
    expect(codes).toEqual(["c0de-fresh"]);
    expect(await appleItem(req.receipt_id)).toEqual({ status: "confirmed", outcome: "revoked" });
    expect(JSON.stringify(await inputOf(req.receipt_id))).not.toContain("c0de-fresh");
  }, 120_000);

  it("N4: missing Apple config is recorded as skipped and the deletion still completes", async () => {
    const id = await seedAthlete("Apple Unconfigured", { auth_id: `auth-${randomUUID()}` });
    const f = fakes({ revokeApple: async () => ({ outcome: "not_configured", detail: "missing APPLE_TEAM_ID" }) });
    const req = (await requestAccountDeletion(id, f.deps, { appleAuthorizationCode: "code-x" }))!;
    expect(await appleItem(req.receipt_id)).toEqual({ status: "skipped", outcome: "apple_not_configured" });
    expect(await settle(req.receipt_id)).toBe("done");
  }, 120_000);

  it("does nothing for Apple without a code", async () => {
    const id = await seedAthlete("No Apple", { auth_id: `auth-${randomUUID()}` });
    const revokeApple = jest.fn();
    const req = (await requestAccountDeletion(id, fakes({ revokeApple }).deps))!;
    expect(revokeApple).not.toHaveBeenCalled();
    expect(await appleItem(req.receipt_id)).toBeUndefined();
  }, 120_000);
});

describe("payment block", () => {
  it("N5: the 409 carries the deal whose payment is held", async () => {
    const id = await seedAthlete("Escrow Notify", { auth_id: `auth-${randomUUID()}` });
    const [deal] = rows(await db.execute(sql`INSERT INTO deals (athlete_id, brand_name) VALUES (${id}::uuid, 'Test Brand') RETURNING id::text AS id`));
    await db.execute(sql`INSERT INTO payments (athlete_id, deal_id, kind, status) VALUES (${id}::uuid, ${deal.id}::uuid, 'deal_payment', 'funded')`);
    const err = await requestAccountDeletion(id, fakes().deps).catch((e) => e);
    expect(err).toBeInstanceOf(AccountDeletionBlocked);
    expect(err.detail.deal_ids).toEqual([deal.id]);
  }, 120_000);
});
