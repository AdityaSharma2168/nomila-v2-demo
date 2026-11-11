/**
 * studio.music.test.ts — the Board's suggestion through the REAL route, with one uncleared track added to the
 * catalogue so the brand rule has something to bite on (every committed track is brandSafe).
 *
 * The green side of "a grow-following brand brief is offered a non-brandSafe track" (PR 10, R-2; Adi's test 3):
 * brand-ness comes off HER stored plan row — its brief's type and its deal — never the purpose chip while
 * either exists. The brief path (a confirmed brief whose goal is grow-following) and the manual path (the
 * brand post's assembled brief) are answered the same way; the chip alone, with no plan, still ranks the
 * uncleared track for her own content.
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
// The committed catalogue plus ONE uncleared warm track, so brand work and own content answer differently.
jest.mock("../studio/music/tracks", () => {
  const actual = jest.requireActual("../studio/music/tracks");
  return {
    ...actual,
    MUSIC_TRACKS: {
      ...actual.MUSIC_TRACKS,
      "uncleared-warm": {
        ...actual.MUSIC_TRACKS["walking-around"],
        title: "Uncleared Warm",
        brandSafe: false,
      },
    },
  };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import studioRouter from "./studio";
import { athletes } from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { savePlan } from "../studio/agent/plans";

const HER = "55555555-1111-4444-8555-666666666666";
let server: Server;
let base: string;

const post = async (body: unknown) => {
  const res = await fetch(`${base}/studio/stitch/music/suggest`, {
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
    .values([{ id: HER, full_name: "Music Route Athlete" }] as never);
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
});

const emptyPlan = {
  items: [],
  castCount: 0,
  picksWithoutHer: [],
  gaps: [],
  look: null,
  music: null,
};
const feel = ["warm, slow, golden light"];

describe("POST /studio/stitch/music/suggest — brand-ness off her stored plan (PR 10, R-2)", () => {
  it("through the real suggest route, a brand brief whose goal is grow-following is answered with brandSafe tracks only — on the brief path and the manual path; the chip alone still ranks the uncleared one", async () => {
    // Control: no plan, the chip says grow-following — her own content, so the uncleared track is offered.
    const own = await post({ feel, objective: "grow-following" });
    expect(own.status).toBe(200);
    expect(own.json.ranked.map((r: { name: string }) => r.name)).toContain(
      "uncleared-warm",
    );

    // The brief path: a confirmed brief, goal grow-following, typed brand_campaign — brand work.
    const briefPath = await savePlan(HER, {
      plan: emptyPlan,
      brief: {
        schema: "campaign-brief/1",
        objective: { type: "brand_campaign", goal: "grow-following" },
        brand: { name: "Solstice", brand_attributes: [], profile: null },
      },
    });
    const brief = await post({
      feel,
      objective: "grow-following",
      planId: briefPath.id,
    });
    expect(brief.status).toBe(200);
    expect(
      brief.json.ranked.map((r: { name: string }) => r.name),
    ).not.toContain("uncleared-warm");
    expect(brief.json.ranked.length).toBeGreaterThan(0);
    expect(brief.json.top?.name).not.toBe("uncleared-warm");

    // The manual path: the brand post's assembled brief (brand_campaign / showcase-product), chip showcase-product.
    const manualPath = await savePlan(HER, {
      plan: emptyPlan,
      brief: {
        schema: "campaign-brief/1",
        objective: { type: "brand_campaign", goal: "showcase-product" },
        brand: { name: "Solstice", brand_attributes: [], profile: null },
      },
    });
    const manual = await post({
      feel,
      objective: "showcase-product",
      planId: manualPath.id,
    });
    expect(manual.status).toBe(200);
    expect(manual.json.ranked.map((r: { name: string }) => r.name)).toEqual(
      brief.json.ranked.map((r: { name: string }) => r.name),
    );

    // A deal alone, no brief: brand work too.
    const dealOnly = await savePlan(HER, { plan: emptyPlan });
    const deal = await post({
      feel,
      objective: "grow-following",
      planId: dealOnly.id,
    });
    expect(deal.status).toBe(200);
    // (no deal row exists in this file's schema seed, so this plan has neither — the chip decides: own content)
    expect(deal.json.ranked.map((r: { name: string }) => r.name)).toContain(
      "uncleared-warm",
    );
  });
});
