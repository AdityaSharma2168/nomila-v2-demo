/**
 * studio.caption.test.ts — the caption suggestion through the REAL route (PR 15, R-5), and the flag
 * that is its door: with STUDIO_COMPOSER off the route is not there.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const who = (globalThis as any).__TEST_ATHLETE_ID;
    if (who === undefined) {
      res
        .status(401)
        .json({ error: "Missing or malformed Authorization header" });
      return;
    }
    req.athleteId = who;
    next();
  },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(),
  rehostFromUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: [] },
    video: { max: 200 * 1024 * 1024, types: [] },
  },
}));
jest.mock("../studio/stitchRunner", () => ({
  stitchTick: jest.fn(async () => ({})),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import studioRouter from "./studio";
import { athletes } from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const HER = "55555555-1111-4444-8555-777777777777";
let server: Server;
let base: string;

const post = async (body: unknown) => {
  const res = await fetch(`${base}/studio/stitch/caption/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
};

beforeAll(async () => {
  await initTestDb();
  await db
    .insert(athletes)
    .values([{ id: HER, full_name: "Caption Route Athlete" }] as never);
  process.env.STUDIO_ENABLED = "true";
  (globalThis as any).__TEST_ATHLETE_ID = HER;
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", studioRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb();
  delete process.env.STUDIO_ENABLED;
  delete process.env.STUDIO_COMPOSER;
});

describe("POST /studio/stitch/caption/suggest", () => {
  /** ⚠️ MUTATION: drop the flag check in the route — this reds by name. */
  it("composer renders with STUDIO_COMPOSER off — never: the route is a 404 with the flag off", async () => {
    delete process.env.STUDIO_COMPOSER;
    const r = await post({ feel: ["She walks off the court, smiling."] });
    expect(r.status).toBe(404);
  });

  it("with the flag on, answers the first sentence's clause, and null for a board with no words", async () => {
    process.env.STUDIO_COMPOSER = "true";
    const r = await post({
      feel: ["She walks off the court, smiling."],
      objective: "recap",
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ suggestion: "She walks off the court" });
    const none = await post({ feel: [], objective: "recap" });
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ suggestion: null });
  });

  it("refuses a body that is not a sentence list", async () => {
    process.env.STUDIO_COMPOSER = "true";
    const r = await post({ feel: "one sentence" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/feel is a list/);
  });

  it("needs auth like every studio route", async () => {
    process.env.STUDIO_COMPOSER = "true";
    (globalThis as any).__TEST_ATHLETE_ID = undefined;
    try {
      const r = await post({ feel: ["x"] });
      expect(r.status).toBe(401);
    } finally {
      (globalThis as any).__TEST_ATHLETE_ID = HER;
    }
  });
});
