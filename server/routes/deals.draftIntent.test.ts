/**
 * deals.draftIntent.test.ts — WS3 §3.1 intent validation on the draft route.
 *
 * Asserts the newly-wired `request_terms` is a first-class, routable draft intent
 * (accepted) and that junk is rejected. Kimi is mocked so the valid path completes
 * without a real LLM call.
 *
 * The mock yields ONE body chunk and must keep doing so. It used to be an empty
 * stream, which worked only while an empty body still returned ok — generateDealDraft
 * now fails that as `empty_body` instead of shipping the bare greeting/sign-off frame
 * (see services/dealDraft.ts), so an empty mock here sends `error` rather than `done`
 * and this suite would be asserting the failure path while claiming to test intent
 * routing. The chunk's content is irrelevant; only its non-emptiness is.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
// The burst limiter (6 a minute) is not what this suite tests; more than six requests here would read as 429.
jest.mock("../lib/rateLimit", () => ({ ...jest.requireActual("../lib/rateLimit"), draftLimiter: (_req: any, _res: any, next: any) => next() }));
jest.mock("../lib/kimi", () => ({
  // One body chunk → the SSE handler runs end-to-end and reaches `done`. Must not
  // go back to an empty stream; see the header.
  kimiStream: jest.fn(async () =>
    (async function* () {
      yield { choices: [{ delta: { content: "Happy to talk — what's the scope?" } }] };
    })(),
  ),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import dealsRouter from "./deals";
import { kimiStream } from "../lib/kimi";
import { deals, inboxThreads, inboxMessages } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const kimiMock = kimiStream as jest.Mock;

let server: Server;
let base: string;
let athleteId: string;
let dealId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Draft Tester");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;

  const [deal] = await db
    .insert(deals)
    .values({ athlete_id: athleteId, brand_name: "Acme", status: "detected", amount: null } as any)
    .returning();
  dealId = deal.id;
  const [thread] = await db
    .insert(inboxThreads)
    .values({ athlete_id: athleteId, subject: "Collab?", deal_id: dealId } as any)
    .returning();
  await db.insert(inboxMessages).values({
    thread_id: thread.id, athlete_id: athleteId, direction: "inbound",
    sender_email: "brand@acme.com", body: "Interested in working together?",
    platform: "gmail", received_at: new Date(),
  } as any);

  const app = express();
  app.use(express.json());
  app.use("/", dealsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => jest.clearAllMocks());

async function draft(reply_intent: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/deals/${dealId}/draft`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ reply_intent, ...extra }),
  });
  return { status: res.status, text: await res.text() };
}

describe("draft intent validation (§3.1)", () => {
  it("accepts request_terms as a first-class intent", async () => {
    const r = await draft("request_terms");
    expect(r.status).toBe(200);           // SSE opened, not a 400 rejection
    expect(kimiMock).toHaveBeenCalledTimes(1);
    expect(r.text).toContain("done");     // stream ran to completion
    // The final event names the thread the draft was written for, so the screen proposes on it.
    expect(r.text).toMatch(/"done":true,"thread_id":"[0-9a-f-]{36}"/);
  });

  it("still accepts the existing intents", async () => {
    for (const intent of ["accept", "negotiate", "decline"]) {
      const r = await draft(intent);
      expect(r.status).toBe(200);
    }
  });

  it("rejects a junk intent with 400 and lists request_terms as valid", async () => {
    const r = await draft("banana");
    expect(r.status).toBe(400);
    expect(r.text).toContain("request_terms");
    expect(kimiMock).not.toHaveBeenCalled();
  });

  it("the reply sheet's type intent, term rows and figure are validated before any model call", async () => {
    for (const extra of [{ intent: "banana" }, { term_asks: "3 months" }, { term_asks: [{ term: "usage" }] }, { figure: -5 }, { figure: "1800" }]) {
      const r = await draft("negotiate", extra);
      expect(r.status).toBe(400);
    }
    expect(kimiMock).not.toHaveBeenCalled();
  });

  it("accepts a well-formed type intent with term rows and her figure (legacy drafter still answers)", async () => {
    const r = await draft("negotiate", { intent: "counter", term_asks: [{ term: "usage", ask: "3 months" }], figure: 1800 });
    expect(r.status).toBe(200);
    expect(r.text).toContain("done");
  });
});
