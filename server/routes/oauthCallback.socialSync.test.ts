/**
 * oauthCallback.socialSync.test.ts — the connect-triggered social_sync enqueue
 * (server/workflow/definitions/socialSync.ts), against the real route on a real HTTP server.
 *
 * Problem this covers: `trigger: "connect"` was a valid SyncTrigger that nothing ever passed —
 * the first substrate write for a newly connected account waited for the 04:30 nightly cron.
 * This pins that the OAuth callback now enqueues a social_sync run for instagram, tiktok AND
 * youtube — including instagram, whose OAuth callback branch is `INBOX.onConnected`, so the
 * enqueue has to be wired independently of that branch (see the comment in oauthCallback.ts).
 * Instagram also starts first_look from that branch, like tiktok and youtube.
 *
 * Providers (OAUTH/INBOX) and the workflow runner are mocked at their module boundary — this
 * suite is about the wiring in oauthCallback.ts, not the providers' own network calls or the
 * runner's own execution (covered in socialSync.test.ts and runner.test.ts).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));

const startRun = jest.fn().mockResolvedValue({ run: { id: "run-1" }, created: true });
jest.mock("../workflow/runner", () => ({ startRun: (...a: unknown[]) => startRun(...a) }));

const requestRefresh = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/intelligence/research/triggers", () => ({ requestRefresh: (...a: unknown[]) => requestRefresh(...a) }));

// A connected social account re-checks a held identity (agent/researchRefresh/identityRecheck.ts; its guards are pinned
// in identityRecheck.db.test.ts): only the wiring here.
const recheck = jest.fn();
jest.mock("../agent/researchRefresh/identityRecheck", () => ({ recheckIdentityInBackground: (...a: unknown[]) => recheck(...a) }));
const fetchSocialData = jest.fn().mockResolvedValue(undefined);
jest.mock("../skills/fetchSocialData", () => ({ fetchSocialData: (...a: unknown[]) => fetchSocialData(...a) }));

const igOnConnected = jest.fn().mockResolvedValue(undefined);
const handleCallback = jest.fn();
jest.mock("../lib/integrations/registry", () => ({
  OAUTH: {
    instagram: { handleCallback: (...a: unknown[]) => handleCallback(...a) },
    tiktok:    { handleCallback: (...a: unknown[]) => handleCallback(...a) },
    youtube:   { handleCallback: (...a: unknown[]) => handleCallback(...a) },
    spotify:   { handleCallback: (...a: unknown[]) => handleCallback(...a) },
  },
  // Mirrors production: instagram is BOTH an OAuth provider and an inbox provider (DM
  // ingestion); tiktok/youtube are not in INBOX at all.
  INBOX: {
    instagram: { handleCallback: (...a: unknown[]) => handleCallback(...a), onConnected: (...a: unknown[]) => igOnConnected(...a) },
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { connectedAccounts } from "../../shared/schema";
import { signOAuthState, verifyOAuthState } from "../lib/oauthState";
import { recordConnectState } from "../lib/oauthConnectState";
import oauthCallbackRouter from "./oauthCallback";

let server: Server; let base: string;

beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/", oauthCallbackRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
afterEach(() => { jest.clearAllMocks(); handleCallback.mockReset(); startRun.mockResolvedValue({ run: { id: "run-1" }, created: true }); });

/** handleCallback's real job (per provider) is exchanging the code and activating the account's
 * connected_accounts row (activateConnection) — that part is mocked here, so the test creates the row
 * itself and has handleCallback return it, exactly as the provider would. */
async function connect(athleteId: string, platform: string): Promise<{ status: number; connectionId: string; connectedAt: Date }> {
  const connectedAt  = new Date();
  const connectionId = await seedConnection({ athleteId, platform, email: `${platform}@example.com`, connectedAt });
  handleCallback.mockResolvedValue({ connectionId, connectedAt, reactivated: false });
  const state = await freshState(athleteId, platform);
  const r = await fetch(`${base}/callback/${platform}?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  return { status: r.status, connectionId, connectedAt };
}

/** A signed state recorded as the connect start records it (native: no cookie), so the callback accepts it ONCE. */
async function freshState(athleteId: string, platform: string): Promise<string> {
  const state = signOAuthState(athleteId);
  await recordConnectState({ append: () => {} } as any, { nonce: verifyOAuthState(state)!.nonce!, athleteId, platform });
  return state;
}

const keyFor = (connectionId: string, connectedAt: Date) => `connect:${connectionId}:${connectedAt.getTime()}`;

test("instagram: onConnected runs AND first_look AND social_sync are enqueued, each keyed to the connect", async () => {
  const athleteId = await seedAthlete("IG Athlete");
  const { status, connectionId, connectedAt } = await connect(athleteId, "instagram");
  expect(status).toBe(200);

  // onConnected is instagram's own branch (DM backfill + fetchSocialData) — it still runs.
  await new Promise((r) => setImmediate(r));
  expect(igOnConnected).toHaveBeenCalledWith(connectionId, athleteId);

  // social_sync is enqueued independently of that branch.
  const socialSyncCall = startRun.mock.calls.find(([opts]) => opts.process === "social_sync");
  expect(socialSyncCall).toBeDefined();
  expect(socialSyncCall![0]).toMatchObject({
    process: "social_sync", athleteId, createdBy: "connect",
    input: { connectionId, platform: "instagram" },
    idempotencyKey: keyFor(connectionId, connectedAt),
  });
  // first_look is started for instagram too (decided Oct 2026), exactly as for tiktok/youtube.
  const firstLookCalls = startRun.mock.calls.filter(([opts]) => opts.process === "first_look");
  expect(firstLookCalls).toHaveLength(1);
  expect(firstLookCalls[0][0]).toMatchObject({
    process: "first_look", athleteId, createdBy: "connect",
    input: { connectionId, platform: "instagram" },
    idempotencyKey: keyFor(connectionId, connectedAt),
  });
});

test("every social connect (instagram, tiktok, youtube) queues the same research refresh request", async () => {
  for (const platform of ["instagram", "tiktok", "youtube"]) {
    requestRefresh.mockClear();
    const athleteId = await seedAthlete(`research ${platform}`);
    const { status } = await connect(athleteId, platform);
    expect(status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(requestRefresh).toHaveBeenCalledWith(athleteId, ["identity", "social_handles"], "event", `connect:${platform}`);
  }
});

test("a social connect (instagram, tiktok, youtube) asks for an identity re-check; a music account does not", async () => {
  for (const platform of ["instagram", "tiktok", "youtube"]) {
    recheck.mockClear();
    const athleteId = await seedAthlete(`identity ${platform}`);
    expect((await connect(athleteId, platform)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith(athleteId, "account", `connect:${platform}`);
  }
  recheck.mockClear();
  const athleteId = await seedAthlete("identity spotify");
  expect((await connect(athleteId, "spotify")).status).toBe(200);
  await new Promise((r) => setTimeout(r, 20));
  expect(recheck).not.toHaveBeenCalled();
});

for (const platform of ["tiktok", "youtube"]) {
  test(`${platform}: first_look AND social_sync are both enqueued, each keyed to the connect (id + connected_at)`, async () => {
    const athleteId = await seedAthlete(`${platform} athlete`);
    const { status, connectionId, connectedAt } = await connect(athleteId, platform);
    expect(status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const firstLookCall  = startRun.mock.calls.find(([opts]) => opts.process === "first_look");
    const socialSyncCall = startRun.mock.calls.find(([opts]) => opts.process === "social_sync");
    expect(firstLookCall).toBeDefined();
    expect(socialSyncCall).toBeDefined();
    expect(firstLookCall![0].idempotencyKey).toBe(keyFor(connectionId, connectedAt));
    expect(socialSyncCall![0]).toMatchObject({
      process: "social_sync", athleteId, createdBy: "connect",
      input: { connectionId, platform },
      idempotencyKey: keyFor(connectionId, connectedAt),
    });
  });
}

test("the OAuth response is NOT blocked on the social_sync enqueue — it returns while startRun is still pending", async () => {
  let resolveStartRun!: (v: unknown) => void;
  startRun.mockImplementation(() => new Promise((resolve) => { resolveStartRun = resolve; }));

  const athleteId = await seedAthlete("Non-blocking Athlete");
  const before = Date.now();
  const { status } = await connect(athleteId, "tiktok");
  const elapsedMs = Date.now() - before;

  expect(status).toBe(200);
  expect(elapsedMs).toBeLessThan(2000); // the response came back long before any timeout could matter
  expect(startRun).toHaveBeenCalled();  // the enqueue call was made...
  // ...but its promise had not resolved when the response was already sent.
  resolveStartRun({ run: { id: "later" }, created: true });
});

test("a REPLAYED callback (the same state twice) is refused at the route: one enqueue, the provider called once", async () => {
  const athleteId = await seedAthlete("Repeat Connect Athlete");
  const connectedAt  = new Date();
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "repeat@example.com", connectedAt });
  handleCallback.mockResolvedValue({ connectionId, connectedAt, reactivated: false });
  const state = await freshState(athleteId, "instagram");

  const first = await fetch(`${base}/callback/instagram?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  const replay = await fetch(`${base}/callback/instagram?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  await new Promise((r) => setImmediate(r));

  expect([first.status, replay.status]).toEqual([200, 400]);
  expect(handleCallback).toHaveBeenCalledTimes(1);
  const socialSyncCalls = startRun.mock.calls.filter(([opts]) => opts.process === "social_sync");
  expect(socialSyncCalls).toHaveLength(1);
  expect(socialSyncCalls[0][0].idempotencyKey).toBe(keyFor(connectionId, connectedAt));
});

test("two callbacks for the same connect generation (two recorded states) enqueue with the SAME key — the runner collapses them", async () => {
  const athleteId = await seedAthlete("Same Generation Athlete");
  const connectedAt  = new Date();
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "samegen@example.com", connectedAt });
  handleCallback.mockResolvedValue({ connectionId, connectedAt, reactivated: false });
  for (let i = 0; i < 2; i++) {
    const state = await freshState(athleteId, "instagram");
    await fetch(`${base}/callback/instagram?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  }
  await new Promise((r) => setImmediate(r));
  const keys = startRun.mock.calls.filter(([opts]) => opts.process === "social_sync").map(([opts]) => opts.idempotencyKey);
  expect(keys).toEqual([keyFor(connectionId, connectedAt), keyFor(connectionId, connectedAt)]);
});

test("a real RECONNECT of the same row (new connected_at) gets a NEW key, so first_look and social_sync run again", async () => {
  const athleteId = await seedAthlete("Reconnect Athlete");
  const firstAt   = new Date(Date.now() - 60_000);
  const connectionId = await seedConnection({ athleteId, platform: "youtube", email: "yt@example.com", connectedAt: firstAt });

  handleCallback.mockResolvedValueOnce({ connectionId, connectedAt: firstAt, reactivated: false });
  await fetch(`${base}/callback/youtube?code=abc&state=${encodeURIComponent(await freshState(athleteId, "youtube"))}`, { redirect: "manual" });
  const secondAt = new Date();
  handleCallback.mockResolvedValueOnce({ connectionId, connectedAt: secondAt, reactivated: true });
  await fetch(`${base}/callback/youtube?code=abc&state=${encodeURIComponent(await freshState(athleteId, "youtube"))}`, { redirect: "manual" });
  await new Promise((r) => setImmediate(r));

  for (const proc of ["first_look", "social_sync"]) {
    const keys = startRun.mock.calls.filter(([opts]) => opts.process === proc).map(([opts]) => opts.idempotencyKey);
    expect(keys).toEqual([keyFor(connectionId, firstAt), keyFor(connectionId, secondAt)]);
    // Same connection id both times — the row is the account's for life.
    expect(startRun.mock.calls.filter(([opts]) => opts.process === proc).every(([opts]) => opts.input.connectionId === connectionId)).toBe(true);
  }
});

test("follow-up work uses the id handleCallback RETURNED, not the newest active row", async () => {
  const athleteId = await seedAthlete("Two Rows Athlete");
  const returned  = await seedConnection({ athleteId, platform: "tiktok", email: "a@example.com", createdAt: new Date(Date.now() - 3_600_000) });
  await seedConnection({ athleteId, platform: "tiktok", email: "b@example.com" });   // newer active sibling
  const connectedAt = new Date();
  handleCallback.mockResolvedValue({ connectionId: returned, connectedAt, reactivated: true });

  const state = await freshState(athleteId, "tiktok");
  await fetch(`${base}/callback/tiktok?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  await new Promise((r) => setImmediate(r));

  const socialSyncCall = startRun.mock.calls.find(([opts]) => opts.process === "social_sync");
  expect(socialSyncCall![0].input.connectionId).toBe(returned);
});
