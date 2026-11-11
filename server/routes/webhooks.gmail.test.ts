/**
 * Gmail webhook OIDC verification (N1). When PUBSUB_PUSH_SA is set, a push must
 * carry a Google-signed ID token for that service account, else it's rejected
 * before the cursor can be advanced by a forged historyId.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

const mockVerify = jest.fn();
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerify })),
}));

// Push routing (§4.5): the history fetch is the provider's network call — mocked; the routing and the
// per-row cursor writes are real (PGlite).
const mockFetchHistory = jest.fn();
const mockRecover = jest.fn();
jest.mock("../lib/integrations/gmail", () => ({
  fetchMessagesByHistoryId: (...a: unknown[]) => mockFetchHistory(...a),
  recoverHistoryGap: (...a: unknown[]) => mockRecover(...a),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { connectedAccounts } from "../../shared/schema";

let server: Server;
let base: string;

const PUSH_SA = "push@proj.iam.gserviceaccount.com";

function envelope(payload: object): string {
  return JSON.stringify({ message: { data: Buffer.from(JSON.stringify(payload)).toString("base64") } });
}

async function postGmail(body: string, authHeader?: string) {
  const res = await fetch(`${base}/api/webhooks/gmail`, {
    method:  "POST",
    headers: { "content-type": "application/json", ...(authHeader ? { authorization: authHeader } : {}) },
    body,
  });
  return res.status;
}

beforeAll(async () => {
  process.env.PUBSUB_PUSH_SA = PUSH_SA;
  process.env.PUBSUB_PUSH_AUDIENCE = "https://x/api/webhooks/gmail";
  await initTestDb();
  const { default: webhooksRouter } = await import("./webhooks");
  const app = express();
  app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  delete process.env.PUBSUB_PUSH_SA;
  delete process.env.PUBSUB_PUSH_AUDIENCE;
});

beforeEach(() => mockVerify.mockReset());

it("rejects a push with no bearer token (403)", async () => {
  const status = await postGmail(envelope({ emailAddress: "x@gmail.com", historyId: "1" }));
  expect(status).toBe(403);
  expect(mockVerify).not.toHaveBeenCalled();
});

it("rejects a push whose token verifies to a different service account (403)", async () => {
  mockVerify.mockResolvedValue({ getPayload: () => ({ email: "attacker@evil.com", email_verified: true }) });
  const status = await postGmail(envelope({ emailAddress: "x@gmail.com", historyId: "1" }), "Bearer forged");
  expect(status).toBe(403);
});

it("accepts a push from the configured service account (200)", async () => {
  mockVerify.mockResolvedValue({ getPayload: () => ({ email: PUSH_SA, email_verified: true }) });
  const status = await postGmail(envelope({ emailAddress: "nobody@gmail.com", historyId: "1" }), "Bearer good");
  expect(status).toBe(200); // acked; no matching account → no processing, but auth passed
});

// ─── Push routing: EVERY active row on the mailbox, each on its own cursor (plan §4.5) ─────────────

async function cursorOf(id: string): Promise<string | null> {
  const [row] = await db.select({ h: connectedAccounts.gmail_history_id }).from(connectedAccounts).where(eq(connectedAccounts.id, id));
  return row.h;
}

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting for the webhook's background work");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("routing", () => {
  beforeEach(() => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ email: PUSH_SA, email_verified: true }) });
    mockFetchHistory.mockReset();
  });

  it("a mailbox shared by two athletes processes BOTH rows (case-insensitive), each from its own cursor; a revoked row is skipped", async () => {
    const a1 = await seedAthlete("Shared Mailbox One");
    const a2 = await seedAthlete("Shared Mailbox Two");
    const row1 = await seedConnection({ athleteId: a1, platform: "gmail", email: "Shared@Example.com" });
    const row2 = await seedConnection({ athleteId: a2, platform: "gmail", email: "shared@example.com" });
    const gone = await seedConnection({ athleteId: a2, platform: "gmail", email: "shared@example.com", status: "revoked" });
    await db.update(connectedAccounts).set({ gmail_history_id: "100" }).where(eq(connectedAccounts.id, row1));
    await db.update(connectedAccounts).set({ gmail_history_id: "200" }).where(eq(connectedAccounts.id, row2));
    await db.update(connectedAccounts).set({ gmail_history_id: "300" }).where(eq(connectedAccounts.id, gone));
    mockFetchHistory.mockResolvedValue([]);

    const status = await postGmail(envelope({ emailAddress: "shared@example.com", historyId: "500" }), "Bearer good");
    expect(status).toBe(200);
    await waitFor(async () => (await cursorOf(row1)) === "500" && (await cursorOf(row2)) === "500");

    expect(mockFetchHistory).toHaveBeenCalledTimes(2);
    expect(mockFetchHistory).toHaveBeenCalledWith(row1, "100");
    expect(mockFetchHistory).toHaveBeenCalledWith(row2, "200");
    expect(await cursorOf(gone)).toBe("300");
  });

  it("a row with no cursor yet bootstraps its own, without blocking the other row", async () => {
    const a1 = await seedAthlete("Bootstrap One");
    const a2 = await seedAthlete("Bootstrap Two");
    const fresh = await seedConnection({ athleteId: a1, platform: "gmail", email: "boot@example.com" });
    const warm  = await seedConnection({ athleteId: a2, platform: "gmail", email: "boot@example.com" });
    await db.update(connectedAccounts).set({ gmail_history_id: "10" }).where(eq(connectedAccounts.id, warm));
    mockFetchHistory.mockResolvedValue([]);

    await postGmail(envelope({ emailAddress: "boot@example.com", historyId: "42" }), "Bearer good");
    await waitFor(async () => (await cursorOf(fresh)) === "42" && (await cursorOf(warm)) === "42");

    expect(mockFetchHistory).toHaveBeenCalledTimes(1);          // only the warm row fetches history
    expect(mockFetchHistory).toHaveBeenCalledWith(warm, "10");
  });
});

describe("an expired history cursor is recovered ONCE (compare-and-set)", () => {
  beforeEach(() => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ email: PUSH_SA, email_verified: true }) });
    mockFetchHistory.mockReset();
    mockRecover.mockReset();
  });

  it("two pushes on the same expired cursor run one recovery, and the cursor moves to a push's historyId", async () => {
    const a = await seedAthlete("Gap Owner");
    const row = await seedConnection({ athleteId: a, platform: "gmail", email: "gap@example.com" });
    await db.update(connectedAccounts).set({ gmail_history_id: "10" }).where(eq(connectedAccounts.id, row));
    // Only the old cursor has expired; a cursor a push set is fresh.
    mockFetchHistory.mockImplementation(async (_c: string, from: string) => { if (from !== "10") return Object.assign([], { failedIds: [] }); const e = new Error("expired"); e.name = "HistoryExpiredError"; throw e; });
    mockRecover.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 150)); return { processed: 0, deadLettered: 0 }; });

    const [s1, s2] = await Promise.all([
      postGmail(envelope({ emailAddress: "gap@example.com", historyId: "900" }), "Bearer good"),
      postGmail(envelope({ emailAddress: "gap@example.com", historyId: "901" }), "Bearer good"),
    ]);
    expect([s1, s2]).toEqual([200, 200]);
    await waitFor(async () => mockRecover.mock.calls.length >= 1 && ["900", "901"].includes(String(await cursorOf(row))));
    await new Promise((r) => setTimeout(r, 300));
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });
});

describe("a failed gap recovery hands the claim back (review of #990)", () => {
  beforeEach(() => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ email: PUSH_SA, email_verified: true }) });
    mockFetchHistory.mockReset();
    mockRecover.mockReset();
  });

  it("when the recovery throws, the cursor goes back to the expired value so the next push recovers the gap", async () => {
    const a = await seedAthlete("Gap Retry");
    const row = await seedConnection({ athleteId: a, platform: "gmail", email: "gapretry@example.com" });
    await db.update(connectedAccounts).set({ gmail_history_id: "10" }).where(eq(connectedAccounts.id, row));
    mockFetchHistory.mockImplementation(async () => { const e = new Error("expired"); e.name = "HistoryExpiredError"; throw e; });
    mockRecover.mockRejectedValueOnce(new Error("Gmail list failed")).mockResolvedValue({ processed: 0, deadLettered: 0 });

    await postGmail(envelope({ emailAddress: "gapretry@example.com", historyId: "900" }), "Bearer good");
    await waitFor(async () => mockRecover.mock.calls.length === 1);
    await waitFor(async () => (await cursorOf(row)) === "10");

    await postGmail(envelope({ emailAddress: "gapretry@example.com", historyId: "950" }), "Bearer good");
    await waitFor(async () => mockRecover.mock.calls.length === 2 && (await cursorOf(row)) === "950");
  });
});
