/**
 * Outlook push (OUTLOOK_PUSH): Graph change notifications as a "sync now" signal over the existing delta sync.
 *
 * Real: the webhook routes, the subscription manager, the outlook_subscriptions rows (PGlite), the disconnect route.
 * Mocked: Microsoft Graph (a fake behind global fetch — nothing reaches Microsoft) and outlook.ts's token + delta
 * entry points (getAccessToken, syncRecent), which this PR reuses rather than changes.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
const mockSyncRecent = jest.fn(async (_connectionId: string, _athleteId: string) => ({ detected: 0, skipped: 0 }));
jest.mock("./outlook", () => ({
  getAccessToken: async () => "graph-token",
  syncRecent:     (connectionId: string, athleteId: string) => mockSyncRecent(connectionId, athleteId),
}));
jest.mock("../auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../oauthRevoke", () => ({ revokeProviderToken: async () => {} }));

import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { connectedAccounts, outlookSubscriptions } from "../../../shared/schema";
import {
  configureOutlookPush, ensureSubscription, hashClientState, runOutlookSubscriptionCron, pushCoveredConnectionIds,
  OUTLOOK_RESOURCE, runPendingSync,
} from "./outlookPush";
import outlookWebhooksRouter from "../../routes/webhooks.outlook";
import connectionsRouter from "../../routes/connections";

// ─── Fake Graph ──────────────────────────────────────────────────────────────

interface FakeSub { id: string; resource: string; notificationUrl: string; changeType: string; expirationDateTime: string; clientState?: string }
const graph = {
  subs: new Map<string, FakeSub>(),
  calls: [] as Array<{ method: string; path: string; body: any; prefer: string | null }>,
  conflictNext: false,
  seq: 0,
  reset() { this.subs.clear(); this.calls = []; this.conflictNext = false; },
  count(method: string, pathPrefix = "/subscriptions") { return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length; },
};
const realFetch = globalThis.fetch;
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeGraph(url: string, init: RequestInit = {}): Promise<Response> {
  const path = url.replace("https://graph.microsoft.com/v1.0", "");
  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const prefer = new Headers(init.headers).get("prefer");
  graph.calls.push({ method, path, body, prefer });
  const id = decodeURIComponent(path.split("/")[2] ?? "");

  if (method === "POST" && path === "/subscriptions") {
    if (graph.conflictNext) { graph.conflictNext = false; return json(409, { error: { message: "duplicate subscription" } }); }
    const sub: FakeSub = { id: `graph-sub-${++graph.seq}`, resource: body.resource, notificationUrl: body.notificationUrl,
      changeType: body.changeType, expirationDateTime: body.expirationDateTime, clientState: body.clientState };
    graph.subs.set(sub.id, sub);
    return json(201, sub);
  }
  if (method === "GET" && path === "/subscriptions") return json(200, { value: [...graph.subs.values()] });
  if (method === "PATCH") {
    const sub = graph.subs.get(id);
    if (!sub) return json(404, { error: { message: "not found" } });
    sub.expirationDateTime = body.expirationDateTime;
    return json(200, sub);
  }
  if (method === "DELETE") return graph.subs.delete(id) ? new Response(null, { status: 204 }) : json(404, { error: { message: "not found" } });
  return json(400, { error: { message: `unhandled ${method} ${path}` } });
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let server: Server; let base: string;
const API = "https://api.test.example";

beforeAll(async () => {
  process.env.API_BASE_URL = API;
  process.env.OUTLOOK_WEBHOOK_SECRET = "test-outlook-secret";
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    return url.startsWith("https://graph.microsoft.com/") ? fakeGraph(url, init) : realFetch(input, init);
  }) as typeof fetch;
  await initTestDb();
  const app = express();
  app.use("/api/v1/webhooks/outlook", express.json({ type: () => true }), outlookWebhooksRouter);
  app.use("/api/v1/me", express.json(), connectionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureOutlookPush({ debounceMs: 60 });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  delete process.env.OUTLOOK_PUSH;
  delete process.env.OUTLOOK_WEBHOOK_SECRET;
});

beforeEach(() => {
  process.env.OUTLOOK_PUSH = "true";
  graph.reset();
  mockSyncRecent.mockClear();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await sleep(20); }
  throw new Error("waitFor timed out");
}

const post = (path: string, body?: unknown, query = "") =>
  realFetch(`${base}/api/v1/webhooks/outlook${path}${query}`, {
    method: "POST",
    headers: { "content-type": body === undefined ? "text/plain" : "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const subRow = async (connectionId: string) =>
  (await db.select().from(outlookSubscriptions).where(eq(outlookSubscriptions.connected_account_id, connectionId)))[0];

/** An Outlook connection with a live subscription; returns the clientState Graph would echo. */
async function subscribed(label: string) {
  const athleteId = await seedAthlete(label);
  const connectionId = await seedConnection({ athleteId, platform: "outlook", email: `${label.replace(/\W/g, "")}@outlook.test` });
  await ensureSubscription(connectionId);
  const row = await subRow(connectionId);
  const clientState = graph.subs.get(row.graph_subscription_id)!.clientState!;
  graph.calls = [];
  return { athleteId, connectionId, row, clientState };
}

const change = (subscriptionId: string, clientState?: string) => ({
  value: [{ subscriptionId, clientState, changeType: "created", resource: "Users/x/Messages/y", tenantId: "t" }],
});
const lifecycle = (subscriptionId: string, clientState: string, lifecycleEvent: string) => ({
  value: [{ subscriptionId, clientState, lifecycleEvent, subscriptionExpirationDateTime: new Date().toISOString() }],
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("validation handshake", () => {
  it.each(["", "/lifecycle"])("POST %s?validationToken echoes the decoded token as 200 text/plain", async (path) => {
    const res = await post(path, undefined, `?validationToken=${encodeURIComponent("Validation: Token+/=ab c")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Validation: Token+/=ab c");
  });
});

describe("subscription create", () => {
  it("creates `created` on the Inbox with both URLs, immutable ids, and stores only the clientState hash", async () => {
    const athleteId = await seedAthlete("Create");
    const connectionId = await seedConnection({ athleteId, platform: "outlook" });
    await ensureSubscription(connectionId);

    const call = graph.calls.find((c) => c.method === "POST")!;
    expect(call.body).toMatchObject({
      changeType: "created",
      resource: OUTLOOK_RESOURCE,
      notificationUrl: `${API}/api/v1/webhooks/outlook`,
      lifecycleNotificationUrl: `${API}/api/v1/webhooks/outlook/lifecycle`,
    });
    expect(call.prefer).toBe('IdType="ImmutableId"');
    expect(new Date(call.body.expirationDateTime).getTime() - Date.now()).toBeLessThanOrEqual(10_080 * 60_000);
    const clientState: string = call.body.clientState;
    expect(clientState.length).toBeGreaterThan(20);
    expect(clientState.length).toBeLessThanOrEqual(128);

    const row = await subRow(connectionId);
    expect(row.status).toBe("active");
    expect(row.client_state_hash).toBe(hashClientState(clientState));
    expect(JSON.stringify(row)).not.toContain(clientState);
  });

  it("a 409 duplicate: removes the orphaned subscription and creates once more", async () => {
    const athleteId = await seedAthlete("Conflict");
    const connectionId = await seedConnection({ athleteId, platform: "outlook" });
    graph.subs.set("orphan-1", { id: "orphan-1", resource: OUTLOOK_RESOURCE, notificationUrl: `${API}/api/v1/webhooks/outlook`,
      changeType: "created", expirationDateTime: new Date(Date.now() + 864e5).toISOString() });
    graph.conflictNext = true;

    await ensureSubscription(connectionId);
    expect(graph.count("POST")).toBe(2);
    expect(graph.calls.some((c) => c.method === "DELETE" && c.path === "/subscriptions/orphan-1")).toBe(true);
    const row = await subRow(connectionId);
    expect(row.graph_subscription_id).not.toBe("orphan-1");
    expect(graph.subs.has(row.graph_subscription_id)).toBe(true);
  });

  it("a reconnect replaces the earlier subscription (one row per connection)", async () => {
    const { connectionId, row } = await subscribed("Reconnect");
    await ensureSubscription(connectionId);
    const after = await subRow(connectionId);
    expect(after.id).toBe(row.id);
    expect(after.graph_subscription_id).not.toBe(row.graph_subscription_id);
    expect(graph.subs.has(row.graph_subscription_id)).toBe(false);
  });
});

describe("change notifications", () => {
  it("bad or missing clientState → 403 and nothing enqueued", async () => {
    const { connectionId, row } = await subscribed("Forged");
    expect((await post("", change(row.graph_subscription_id, "not-the-client-state"))).status).toBe(403);
    expect((await post("", change(row.graph_subscription_id))).status).toBe(403);
    const after = await subRow(connectionId);
    expect(after.sync_requested_at).toBeNull();
    expect(after.last_notification_at).toBeNull();
    await sleep(200);
    expect(mockSyncRecent).not.toHaveBeenCalled();
  });

  it("a malformed body → 400; an unknown subscription → 202 and nothing enqueued", async () => {
    expect((await post("", { nope: true })).status).toBe(400);
    expect((await post("", change("no-such-subscription", "x"))).status).toBe(202);
    await sleep(200);
    expect(mockSyncRecent).not.toHaveBeenCalled();
  });

  it("valid → 202 fast and enqueued; a burst of duplicates runs the existing delta sync ONCE", async () => {
    const { athleteId, connectionId, row, clientState } = await subscribed("Burst");

    const t0 = Date.now();
    const first = await post("", change(row.graph_subscription_id, clientState));
    expect(first.status).toBe(202);
    expect(Date.now() - t0).toBeLessThan(1000);
    const queued = await subRow(connectionId);
    expect(queued.sync_requested_at).not.toBeNull();
    expect(queued.last_notification_at).not.toBeNull();

    // Graph retries and duplicates inside the window — including a batch that names the subscription twice.
    await Promise.all([1, 2, 3].map(() => post("", change(row.graph_subscription_id, clientState))));
    await post("", { value: [...change(row.graph_subscription_id, clientState).value, ...change(row.graph_subscription_id, clientState).value] });
    expect((await subRow(connectionId)).sync_requested_at?.getTime()).toBe(queued.sync_requested_at?.getTime());   // first in the burst wins

    await waitFor(() => mockSyncRecent.mock.calls.length > 0);
    await sleep(250);
    expect(mockSyncRecent).toHaveBeenCalledTimes(1);
    expect(mockSyncRecent).toHaveBeenCalledWith(connectionId, athleteId);
    const done = await subRow(connectionId);
    expect(done.sync_requested_at).toBeNull();
    expect(done.sync_started_at).toBeNull();
    expect(graph.calls).toEqual([]);   // the webhook path never calls Graph
  });

  it("a signal that lands during a sync triggers exactly one more run", async () => {
    const { connectionId, row, clientState } = await subscribed("During");
    let release!: () => void;
    mockSyncRecent.mockImplementationOnce(() => new Promise((r) => { release = () => r({ detected: 0, skipped: 0 }); }));
    await post("", change(row.graph_subscription_id, clientState));
    await waitFor(() => mockSyncRecent.mock.calls.length === 1);
    await post("", change(row.graph_subscription_id, clientState));   // arrives mid-sync
    expect(await runPendingSync(connectionId)).toBe(false);           // the lease holds: no concurrent replay
    release();
    await waitFor(() => mockSyncRecent.mock.calls.length === 2);
    await sleep(250);
    expect(mockSyncRecent).toHaveBeenCalledTimes(2);
  });
});

describe("lifecycle notifications", () => {
  it("missed → runs delta", async () => {
    const { row, clientState } = await subscribed("Missed");
    expect((await post("/lifecycle", lifecycle(row.graph_subscription_id, clientState, "missed"))).status).toBe(202);
    await waitFor(() => mockSyncRecent.mock.calls.length === 1);
  });

  it("reauthorizationRequired → one PATCH with a new expiry (never /reauthorize too), status back to active", async () => {
    const { connectionId, row, clientState } = await subscribed("Reauth");
    await db.update(outlookSubscriptions).set({ expires_at: new Date(Date.now() + 3600_000) }).where(eq(outlookSubscriptions.id, row.id));
    expect((await post("/lifecycle", lifecycle(row.graph_subscription_id, clientState, "reauthorizationRequired"))).status).toBe(202);
    await waitFor(async () => (await subRow(connectionId)).status === "active" && graph.count("PATCH") === 1);
    expect(graph.calls.some((c) => c.path.includes("reauthorize"))).toBe(false);
    expect((await subRow(connectionId)).expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 864e5);
  });

  it("subscriptionRemoved → recreates the subscription, then runs delta", async () => {
    const { connectionId, row, clientState } = await subscribed("Removed");
    graph.subs.delete(row.graph_subscription_id);   // Graph already dropped it
    expect((await post("/lifecycle", lifecycle(row.graph_subscription_id, clientState, "subscriptionRemoved"))).status).toBe(202);
    await waitFor(() => mockSyncRecent.mock.calls.length === 1);
    const after = await subRow(connectionId);
    expect(after.status).toBe("active");
    expect(after.graph_subscription_id).not.toBe(row.graph_subscription_id);
    expect(graph.count("POST")).toBe(1);
  });

  it("a lifecycle event with a wrong clientState → 403, no Graph call", async () => {
    const { row } = await subscribed("LifeForged");
    expect((await post("/lifecycle", lifecycle(row.graph_subscription_id, "wrong", "subscriptionRemoved"))).status).toBe(403);
    await sleep(150);
    expect(graph.calls).toEqual([]);
  });
});

describe("renewal cron", () => {
  it("renews only subscriptions expiring within 48 h", async () => {
    await db.delete(outlookSubscriptions);
    const soon = await subscribed("Soon");
    const later = await subscribed("Later");
    await db.update(outlookSubscriptions).set({ expires_at: new Date(Date.now() + 24 * 3600_000) }).where(eq(outlookSubscriptions.id, soon.row.id));
    await db.update(outlookSubscriptions).set({ expires_at: new Date(Date.now() + 6 * 864e5) }).where(eq(outlookSubscriptions.id, later.row.id));

    const r = await runOutlookSubscriptionCron();
    expect(r).toMatchObject({ enabled: true, renewed: 1, recreated: 0, failed: 0 });
    expect(graph.calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual([`/subscriptions/${soon.row.graph_subscription_id}`]);
    expect((await subRow(soon.connectionId)).expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 864e5);
  });

  it("a subscription Graph no longer has (404 on PATCH) is recreated and delta runs", async () => {
    await db.delete(outlookSubscriptions);
    const s = await subscribed("Gone");
    await db.update(outlookSubscriptions).set({ expires_at: new Date(Date.now() + 3600_000) }).where(eq(outlookSubscriptions.id, s.row.id));
    graph.subs.delete(s.row.graph_subscription_id);
    const r = await runOutlookSubscriptionCron();
    expect(r).toMatchObject({ renewed: 0, recreated: 1 });
    await waitFor(() => mockSyncRecent.mock.calls.length === 1);
  });

  it("drains a signal whose in-process timer was lost", async () => {
    await db.delete(outlookSubscriptions);
    const s = await subscribed("Lost");
    await db.update(outlookSubscriptions).set({ sync_requested_at: sql`now() - interval '5 minutes'` }).where(eq(outlookSubscriptions.id, s.row.id));
    const r = await runOutlookSubscriptionCron();
    expect(r.drained).toBe(1);
    expect(mockSyncRecent).toHaveBeenCalledTimes(1);
  });
});

describe("disconnect", () => {
  it("DELETE /connect/:id deletes the Graph subscription and its row", async () => {
    const s = await subscribed("Disconnect");
    (globalThis as any).__TEST_ATHLETE_ID = s.athleteId;
    const res = await realFetch(`${base}/api/v1/me/connect/${s.connectionId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(graph.calls).toEqual([expect.objectContaining({ method: "DELETE", path: `/subscriptions/${s.row.graph_subscription_id}` })]);
    expect(await subRow(s.connectionId)).toBeUndefined();
    expect((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, s.connectionId)))[0].status).toBe("revoked");
  });

  it("DELETE /disconnect/outlook does the same; a connection without a subscription makes no Graph call", async () => {
    const s = await subscribed("DisconnectByPlatform");
    (globalThis as any).__TEST_ATHLETE_ID = s.athleteId;
    expect((await realFetch(`${base}/api/v1/me/disconnect/outlook`, { method: "DELETE" })).status).toBe(200);
    expect(graph.count("DELETE")).toBe(1);
    expect(await subRow(s.connectionId)).toBeUndefined();

    const athleteId = await seedAthlete("NoSub");
    await seedConnection({ athleteId, platform: "outlook" });
    (globalThis as any).__TEST_ATHLETE_ID = athleteId;
    graph.calls = [];
    expect((await realFetch(`${base}/api/v1/me/disconnect/outlook`, { method: "DELETE" })).status).toBe(200);
    expect(graph.calls).toEqual([]);
  });
});

describe("flag off (OUTLOOK_PUSH unset)", () => {
  it("no subscription calls, notifications ignored, cron a no-op, nothing skips the poll", async () => {
    const s = await subscribed("FlagOff");
    await db.update(connectedAccounts).set({ last_fetched_at: new Date() }).where(eq(connectedAccounts.id, s.connectionId));
    expect((await pushCoveredConnectionIds()).has(s.connectionId)).toBe(true);   // sanity: covered while on

    delete process.env.OUTLOOK_PUSH;
    const athleteId = await seedAthlete("FlagOffNew");
    const fresh = await seedConnection({ athleteId, platform: "outlook" });
    expect(await ensureSubscription(fresh)).toBeNull();
    await db.update(outlookSubscriptions).set({ expires_at: new Date(Date.now() + 3600_000) }).where(eq(outlookSubscriptions.id, s.row.id));
    expect(await runOutlookSubscriptionCron()).toMatchObject({ enabled: false, renewed: 0 });
    expect((await post("", change(s.row.graph_subscription_id, s.clientState))).status).toBe(202);
    await sleep(200);
    expect(graph.calls).toEqual([]);
    expect(mockSyncRecent).not.toHaveBeenCalled();
    expect((await subRow(s.connectionId)).sync_requested_at).toBeNull();
    expect((await pushCoveredConnectionIds()).size).toBe(0);
  });
});

it("clientState is an HMAC of the row id with OUTLOOK_WEBHOOK_SECRET", async () => {
  const s = await subscribed("Hmac");
  const expected = crypto.createHmac("sha256", "test-outlook-secret").update(`outlook-subscription:${s.row.id}`).digest("base64url");
  expect(s.clientState).toBe(expected);
});
