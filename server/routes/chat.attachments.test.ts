/**
 * chat.attachments.test.ts — the composer's ＋ at the chat route.
 *
 * The Mila turn (runMilaTurn, on Mastra) is mocked; what is pinned is the route's gate: a malformed
 * attachments array is a 400 before anything runs, an asset the athlete does not own is a 404 for the
 * whole turn, an owned asset passes the gate and goes with the turn (id and role), and an
 * attachments-only turn reads as "Take a look at this.". A turn with no message and no attachments is
 * still a 400.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../agent/engine", () => ({ runMilaTurn: jest.fn() }));
jest.mock("../lib/kimi", () => ({ kimiStream: jest.fn() }));
jest.mock("../lib/mediaStore", () => ({ readObject: jest.fn(), signedUrl: jest.fn(async (p: string) => p) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import chatRouter from "./chat";
import { runMilaTurn } from "../agent/engine";
import { mediaAssets } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const turn = runMilaTurn as jest.Mock;

let server: Server;
let base: string;
let athleteId: string;
let ownId: string;
let foreignId: string;

async function post(body: unknown) {
  const res = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, json, text };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Attach Route");
  const otherId = await seedAthlete("Attach Other");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const insert = async (aid: string) => (await db.insert(mediaAssets).values({
    athlete_id: aid, platform: "upload", origin: "upload", status: "stored", media_type: "IMAGE",
    gcs_path: `athletes/${aid}/uploads/a.jpg`, content_type: "image/jpeg",
    metadata: { vision: { shot_type: "portrait", brands_visible: [], brand_safe: true } },
  } as any).returning({ id: mediaAssets.id }))[0].id;
  ownId = await insert(athleteId);
  foreignId = await insert(otherId);

  const app = express();
  app.use(express.json());
  app.use("/", chatRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
  turn.mockImplementation(async (p: any) => { p.sse.token("Got it."); p.sse.done(); });
});

test("a malformed attachments array is a 400 before the turn runs", async () => {
  expect((await post({ message: "look", attachments: [{ asset_id: "nope", role: "photo" }] })).status).toBe(400);
  expect((await post({ message: "look", attachments: [{ asset_id: ownId, role: "contract" }] })).status).toBe(400);
  expect((await post({ message: "look", attachments: "photo" })).status).toBe(400);
  expect(turn).not.toHaveBeenCalled();
});

test("an asset the athlete does not own is a 404 for the whole turn", async () => {
  const r = await post({ message: "look", attachments: [{ asset_id: ownId, role: "photo" }, { asset_id: foreignId, role: "photo" }] });
  expect(r.status).toBe(404);
  expect(turn).not.toHaveBeenCalled();
});

test("an owned asset passes the gate; an attachments-only turn reads as the default line", async () => {
  const r = await post({ message: "", attachments: [{ asset_id: ownId, role: "product" }] });
  expect(r.status).toBe(200);
  expect(turn).toHaveBeenCalledTimes(1);
  expect(turn.mock.calls[0][0].message).toBe("Take a look at this.");
  expect(turn.mock.calls[0][0].attachments).toEqual([{ asset_id: ownId, role: "product" }]);
});

test("no message and no attachments is still a 400; a plain message runs the turn", async () => {
  expect((await post({ message: "" })).status).toBe(400);
  const r = await post({ message: "hi" });
  expect(r.status).toBe(200);
  expect(turn.mock.calls[0][0].message).toBe("hi");
});

test("a message over 8,000 characters is a 400 before anything runs; exactly 8,000 is accepted past the check", async () => {
  const long = await post({ message: "a".repeat(8_001) });
  expect(long.status).toBe(400);
  expect(long.json.error).toBe("message_too_long");
  expect((await post({ message: 42 })).status).toBe(400);
  expect(turn).not.toHaveBeenCalled();
  const atCap = await post({ message: "a".repeat(8_000), attachments: [{ asset_id: "nope", role: "photo" }] });
  expect(atCap.json?.error).not.toBe("message_too_long");                                      // stopped later, by the attachment check
});
