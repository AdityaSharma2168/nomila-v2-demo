/**
 * routes.test.ts — the Studio library route over HTTP (agent/studio/routes.ts), with its deps mocked: it is a thin
 * wire (requireAuth, the athlete id, the JSON shape); items.ts's own logic is covered on the in-memory store by
 * items.test.ts. Also: the route is mounted only while AGENT_V3 is on (server/index.ts), so while it is off the
 * client's 404 fallback to the pitches list still works, unchanged.
 *
 *   R1 the route: GET answers { items }, scoped to the signed-in athlete id, never a body or a path param
 *   R2 a failure in the deps answers 500, not a crash
 */
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("./deps", () => ({ dbStudioItemsDeps: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { agentStudioRouter } from "./routes";

let server: Server;
let base = "";
const savedPostKits = process.env.AGENT_POST_KITS;

async function call(athleteId: string) {
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const res = await fetch(`${base}/api/v1/me/agent/studio/items`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  delete process.env.AGENT_POST_KITS; // so the fake store (never queried) is never reached
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", agentStudioRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (savedPostKits === undefined) delete process.env.AGENT_POST_KITS; else process.env.AGENT_POST_KITS = savedPostKits;
  await new Promise((r) => server.close(r));
});

test("R1: answers { items }, built from the athlete id the token carries", async () => {
  const { dbStudioItemsDeps } = await import("./deps");
  const seen: string[] = [];
  (dbStudioItemsDeps as jest.Mock).mockImplementation(() => ({
    store: {} as never,
    media: {} as never,
    pitches: async (athleteId: string) => { seen.push(athleteId); return []; },
  }));
  // listStudioItems (the real, unmocked module) calls deps.pitches(athleteId); AGENT_POST_KITS is off, so the store
  // (which would 500 if actually queried) is never reached.
  const r = await call("athlete-1");
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ items: [] });
  expect(seen).toEqual(["athlete-1"]);
});

test("R2: a failure in the deps answers 500, not a crash", async () => {
  const { dbStudioItemsDeps } = await import("./deps");
  (dbStudioItemsDeps as jest.Mock).mockImplementation(() => { throw new Error("boom"); });
  const r = await call("athlete-1");
  expect(r.status).toBe(500);
  expect(r.body).toEqual({ error: "Internal server error" });
});
