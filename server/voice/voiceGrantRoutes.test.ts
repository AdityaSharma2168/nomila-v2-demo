/**
 * voiceGrantRoutes.test.ts — EVERY /api/internal/voice route enforces the
 * athlete-bound grant (server/voice/auth.ts), driven over real HTTP against the
 * real routers.
 *
 * With VOICE_GRANT_ENFORCE on, a caller holding the service secret and a valid
 * grant for athlete A, who puts athlete B in the path, gets 403 on every route;
 * the secret alone gets 401. A positive control per route (grant matches the
 * path) proves the guard reads the PATH id: it lets the request through to the
 * route's own id validation (400), so no DB is needed. In observe mode the
 * mismatched request is let through and logged.
 *
 * The DELETION FENCE (voiceAuthorized, after the secret and the grant): with a
 * valid grant, an athlete whose account is being deleted — or whose row is gone —
 * gets 410 account_deleting on every route, and no table gains a row.
 *
 * A ratchet at the bottom fails if a route is added to any voice router without
 * being listed here — a new route cannot ship without this coverage.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

const mockWarn = jest.fn();
jest.mock("../logger", () => {
  const noop = () => {};
  const make = (): any => ({
    warn: (...args: unknown[]) => mockWarn(...args),
    info: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => make(),
  });
  return { createLogger: () => make(), logger: make(), default: make() };
});

import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import { db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mintVoiceGrant, VOICE_GRANT_HEADER } from "./auth";
import brandBriefRouter from "./brandBriefRoute";
import brandKnowledgeRouter from "./brandKnowledgeRoute";
import dealBriefRouter from "./dealBriefRoute";
import dealRouter from "./dealRoutes";
import draftIntentRouter from "./draftIntentRoute";
import onboardingRouter from "./onboardingRoute";
import profileRouter from "./profileRoute";
import scoreRouter from "./scoreRoute";
import seedRouter from "./seedRoute";
import shareSignalsRouter from "./shareSignalsRoute";
import threadRouter from "./threadRoutes";
import transcriptRouter from "./transcriptRoute";
import voiceContextRouter from "./voiceContextRoute";
import webSearchRouter from "./webSearchRoute";

const ROUTERS: Router[] = [
  brandBriefRouter,
  brandKnowledgeRouter,
  dealBriefRouter,
  dealRouter,
  draftIntentRouter,
  onboardingRouter,
  profileRouter,
  scoreRouter,
  seedRouter,
  shareSignalsRouter,
  threadRouter,
  transcriptRouter,
  voiceContextRouter,
  webSearchRouter,
];

const SECRET = "voice-service-secret-0123456789";
const GRANT_SECRET = "voice-grant-secret-abcdefghijklmnopqrstuvwxyz";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const DEAL = "44444444-4444-4444-8444-444444444444";
/** Passes the guard when the grant names it, then fails the route's own UUID check. */
const BAD_ID = "not-a-uuid";

/** Every route, as `[method, express path, concrete path for athlete id]`. */
const ROUTES: Array<[string, string, (id: string) => string]> = [
  ["post", "/athletes/:id/brand-brief", (id) => `/athletes/${id}/brand-brief`],
  ["post", "/athletes/:id/brand-knowledge", (id) => `/athletes/${id}/brand-knowledge`],
  ["post", "/athletes/:id/deal-brief", (id) => `/athletes/${id}/deal-brief`],
  ["get", "/athletes/:id/deals", (id) => `/athletes/${id}/deals`],
  ["get", "/athletes/:id/deals/:dealId", (id) => `/athletes/${id}/deals/${DEAL}`],
  ["post", "/athletes/:id/draft-intent", (id) => `/athletes/${id}/draft-intent`],
  ["get", "/athletes/:id/onboarding", (id) => `/athletes/${id}/onboarding`],
  [
    "post",
    "/athletes/:id/onboarding/steps/:step/complete",
    (id) => `/athletes/${id}/onboarding/steps/identity/complete`,
  ],
  ["get", "/athletes/:id/profile", (id) => `/athletes/${id}/profile`],
  ["get", "/athletes/:id/score", (id) => `/athletes/${id}/score`],
  ["get", "/athletes/:id/voice-seed", (id) => `/athletes/${id}/voice-seed`],
  ["get", "/athletes/:id/share-signals", (id) => `/athletes/${id}/share-signals`],
  [
    "get",
    "/athletes/:id/deals/:dealId/thread",
    (id) => `/athletes/${id}/deals/${DEAL}/thread`,
  ],
  ["post", "/athletes/:id/transcript", (id) => `/athletes/${id}/transcript`],
  ["post", "/athletes/:id/voice-context", (id) => `/athletes/${id}/voice-context`],
  ["post", "/athletes/:id/web-search", (id) => `/athletes/${id}/web-search`],
];

const ENV = [
  "VOICE_SERVICE_SECRET",
  "VOICE_GRANT_SECRET",
  "VOICE_GRANT_ENFORCE",
] as const;
const saved: Record<string, string | undefined> = {};
let server: Server;
let base: string;

beforeAll(async () => {
  await initTestDb();
  for (const k of ENV) saved[k] = process.env[k];
  const app = express();
  app.use(express.json());
  for (const r of ROUTERS) app.use("/api/internal/voice", r);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  // ~100 sequential requests over keep-alive: outlast Node's 5s default so a
  // socket fetch is about to reuse is never closed under it (ECONNRESET).
  server.keepAliveTimeout = 60_000;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/voice`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  process.env.VOICE_SERVICE_SECRET = SECRET;
  process.env.VOICE_GRANT_SECRET = GRANT_SECRET;
  delete process.env.VOICE_GRANT_ENFORCE;
  mockWarn.mockReset();
});

async function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: { "content-type": "application/json", ...headers },
    body: method === "post" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return (await send(method, path, headers)).status;
}

const grantFor = (id: string) => mintVoiceGrant(id, "")!.grant;

describe.each(ROUTES)("%s %s", (method, _pattern, at) => {
  describe("VOICE_GRANT_ENFORCE=true", () => {
    beforeEach(() => {
      process.env.VOICE_GRANT_ENFORCE = "true";
    });

    it("403s a grant for A used against athlete B's path", async () => {
      expect(
        await call(method, at(B), {
          "x-voice-secret": SECRET,
          [VOICE_GRANT_HEADER]: grantFor(A),
        }),
      ).toBe(403);
    });

    it("401s the secret alone", async () => {
      expect(await call(method, at(A), { "x-voice-secret": SECRET })).toBe(401);
    });

    it("401s a grant without the secret", async () => {
      expect(
        await call(method, at(A), { [VOICE_GRANT_HEADER]: grantFor(A) }),
      ).toBe(401);
    });

    it("lets a grant for the PATH athlete through the guard", async () => {
      // Reaches the route's own id validation → 400: the guard compared the
      // grant against the path id, not something else.
      expect(
        await call(method, at(BAD_ID), {
          "x-voice-secret": SECRET,
          [VOICE_GRANT_HEADER]: grantFor(BAD_ID),
        }),
      ).toBe(400);
    });
  });

  describe("observe mode (flag unset)", () => {
    it("lets the mismatched request through, and logs athlete_mismatch", async () => {
      const status = await call(method, at(BAD_ID), {
        "x-voice-secret": SECRET,
        [VOICE_GRANT_HEADER]: grantFor(A),
      });
      expect(status).toBe(400); // past the guard, stopped by id validation
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "athlete_mismatch",
          enforced: false,
          pathAthleteId: BAD_ID,
          grantAthleteId: A,
        }),
        "Voice grant check failed",
      );
    });

    it("still 401s without the secret", async () => {
      expect(
        await call(method, at(A), { [VOICE_GRANT_HEADER]: grantFor(A) }),
      ).toBe(401);
    });
  });
});

// ─── the deletion fence, on every route ──────────────────────────────────────

/** A body each write route would act on, so "nothing was written" is a real claim (reads ignore it). */
const BODY: Record<string, unknown> = {
  "/athletes/:id/transcript": { role: "user", content: "Reply to Prime and ask about timing" },
  "/athletes/:id/voice-context": { deals: [DEAL], brands: [], openThreads: [], draftsOpened: [] },
  "/athletes/:id/draft-intent": { brand: "Prime", replyIntent: "ask_question" },
  "/athletes/:id/onboarding/steps/:step/complete": { fields: { sport: "soccer" } },
  "/athletes/:id/brand-brief": { brand: "Prime" },
  "/athletes/:id/brand-knowledge": { brand: "Prime" },
  "/athletes/:id/deal-brief": { brand: "Prime" },
  "/athletes/:id/web-search": { query: "Prime Hydration NIL" },
};

/** Row count of every table in the test DB: the fence must leave all of them unchanged. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = ((await db.execute(sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `)) as any).rows as Array<{ table_name: string }>;
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const r = ((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table_name}"`))) as any).rows;
    out[table_name] = r[0].n;
  }
  return out;
}

describe("the deletion fence (voiceAuthorized), every route", () => {
  let deleting: string;
  let live: string;
  let before: Record<string, number>;

  beforeAll(async () => {
    deleting = await seedAthlete("Voice Fence Deleting", { deletion_requested_at: new Date() } as any);
    live = await seedAthlete("Voice Fence Live");
    before = await rowCounts();
  });

  describe.each(ROUTES)("%s %s", (method, pattern, at) => {
    it.each([["enforced", "true"], ["observe mode", undefined]])(
      "410s an athlete whose account is being deleted, with a plain message (%s)",
      async (_label, enforce) => {
        if (enforce) process.env.VOICE_GRANT_ENFORCE = enforce;
        const res = await send(
          method,
          at(deleting),
          { "x-voice-secret": SECRET, [VOICE_GRANT_HEADER]: grantFor(deleting) },
          BODY[pattern] ?? {},
        );
        expect(res.status).toBe(410);
        expect(res.body).toEqual({
          error: "account_deleting",
          message: expect.stringContaining("being deleted"),
        });
      },
    );

    it("410s an athlete whose row is gone (a purged account)", async () => {
      process.env.VOICE_GRANT_ENFORCE = "true";
      const res = await send(
        method,
        at(B),
        { "x-voice-secret": SECRET, [VOICE_GRANT_HEADER]: grantFor(B) },
        BODY[pattern] ?? {},
      );
      expect(res.status).toBe(410);
      expect(res.body?.error).toBe("account_deleting");
    });

    it("never reads the fence for a caller the grant refuses (403 stays 403)", async () => {
      process.env.VOICE_GRANT_ENFORCE = "true";
      const res = await send(
        method,
        at(deleting),
        { "x-voice-secret": SECRET, [VOICE_GRANT_HEADER]: grantFor(live) },
        BODY[pattern] ?? {},
      );
      expect(res.status).toBe(403);
    });
  });

  // Declared last, so it runs after every refusal above.
  it("left every table exactly as it was (nothing was written)", async () => {
    expect(await rowCounts()).toEqual(before);
  });
});

describe("coverage ratchet", () => {
  it("every route on every voice router is in the table above", () => {
    const registered = ROUTERS.flatMap((r) =>
      (r as any).stack
        .filter((layer: any) => layer.route)
        .flatMap((layer: any) =>
          Object.keys(layer.route.methods).map(
            (m) => `${m} ${layer.route.path}`,
          ),
        ),
    ).sort();
    const listed = ROUTES.map(([m, p]) => `${m} ${p}`).sort();
    expect(registered).toEqual(listed);
    expect(listed).toHaveLength(16);   // score-history retired (legacy retirement P2-5)
  });
});
