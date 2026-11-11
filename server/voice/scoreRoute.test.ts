/**
 * scoreRoute.test.ts — GET /athletes/:id/score, the voice worker's read-only
 * score lookup. DB is PGlite (real SQL); no network, no model.
 *
 * `displayScore` is the modern ledger score (via getScoreTool / buildMyIntelligence),
 * never the legacy `athletes_current.display_score`. Since the legacy retirement (P2-5) the wire is
 * `{ displayScore, outOf: 850, strengths }` — no tier, capitals, top area or PAV (the worker no longer reads them).
 *
 * Covers the guard first (missing header · wrong-length header · same-length
 * wrong value · secret unset entirely) because the shared secret is this
 * endpoint's ONLY authorization boundary, then id validation, the no-row path,
 * and the mapped success shape.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import voiceScoreRouter from "./scoreRoute";
import { athletesCurrent, intelligenceLedger, socialAnalyticsSnapshots } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

/** A minimal ledger ASSESSMENT row: just enough for buildMyIntelligence to report `score`. */
async function seedScore(athleteId: string, score: number) {
  await db.insert(intelligenceLedger).values({
    subject_type: "athlete", subject_id: athleteId, owner: "marketability", kind: "ASSESSMENT",
    value: { score } as any, confidence: null,
    versions: { methodology: "v1.0.1-beta.1", evaluator: "mia-eval/test", params: "params/test" } as any,
    evidence_as_of: new Date("2026-09-20T00:00:00.000Z"),
  } as any);
}

const SECRET = "voice-test-secret-0123456789";

let server: Server;
let base: string;
let athleteId: string;
let noScoreAthleteId: string;

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; cacheControl: string | null }> {
  const res = await fetch(`${base}${path}`, { method: "GET", headers });
  return {
    status: res.status,
    body: await res.json().catch(() => undefined),
    cacheControl: res.headers.get("cache-control"),
  };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Voice Athlete");
  noScoreAthleteId = await seedAthlete("Voice Athlete No Score");

  // Legacy display_score/tier/capitals are seeded too, deliberately, so the tests
  // below can prove the route no longer reads them (the modern ledger score wins,
  // and tier/capitals are always null).
  await db.insert(athletesCurrent).values({
    athlete_id: athleteId,
  });
  await seedScore(athleteId, 640);

  const app = express();
  app.use(express.json());
  app.use("/", voiceScoreRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Generous hook timeout: initTestDb pushes the whole schema into PGlite, and
  // a cold ts-jest compile can push that past jest's default 5s.
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  delete process.env.VOICE_SERVICE_SECRET;
});

// Re-armed per test so the fail-closed case can delete it without leaking into
// the next test.
beforeEach(() => {
  process.env.VOICE_SERVICE_SECRET = SECRET;
});

describe("GET /athletes/:id/score — auth guard", () => {
  it("401s with no x-voice-secret header", async () => {
    const res = await get(`/athletes/${athleteId}/score`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("401s on a wrong-length secret (no timingSafeEqual throw)", async () => {
    const res = await get(`/athletes/${athleteId}/score`, {
      "x-voice-secret": "short",
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("401s on a same-length but wrong secret", async () => {
    const wrong = "X".repeat(SECRET.length);
    expect(wrong.length).toBe(SECRET.length);
    const res = await get(`/athletes/${athleteId}/score`, {
      "x-voice-secret": wrong,
    });
    expect(res.status).toBe(401);
  });

  it("401s when VOICE_SERVICE_SECRET is unset, even with a header (fail-closed)", async () => {
    delete process.env.VOICE_SERVICE_SECRET;
    const res = await get(`/athletes/${athleteId}/score`, {
      "x-voice-secret": SECRET,
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("does not leak score data on any rejected request", async () => {
    const res = await get(`/athletes/${athleteId}/score`);
    expect(JSON.stringify(res.body)).not.toContain("640");
    expect(JSON.stringify(res.body)).not.toContain("Rising");
  });
});

describe("GET /athletes/:id/score — lookup", () => {
  it("400s on a non-uuid athlete id", async () => {
    const res = await get("/athletes/not-a-uuid/score", {
      "x-voice-secret": SECRET,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid athlete id" });
  });

  it("404s when the athlete has neither a score nor any follower count", async () => {
    const res = await get(`/athletes/${noScoreAthleteId}/score`, {
      "x-voice-secret": SECRET,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No score" });
  });

  it("200s with the mapped voice shape for a real row", async () => {
    const res = await get(`/athletes/${athleteId}/score`, {
      "x-voice-secret": SECRET,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      // The modern ledger score (640), never the legacy display_score (512). No tier word, no capitals,
      // no top area, no PAV (legacy retirement P2-5); strengths are the M.I.A. dimensions marked strength.
      displayScore: 640,
      outOf: 850,
      strengths: [],
    });
  });

  it("returns only the mapped keys — no model-facing or legacy fields pass through", async () => {
    const res = await get(`/athletes/${athleteId}/score`, {
      "x-voice-secret": SECRET,
    });

    expect(Object.keys(res.body).sort()).toEqual(["displayScore", "outOf", "strengths"]);
    for (const legacy of ["tier", "capitals", "pav", "topArea"]) expect(res.body).not.toHaveProperty(legacy);
    // getScore's own shape must not leak into the voice contract.
    expect(res.body).not.toHaveProperty("display_score");
    expect(res.body).not.toHaveProperty("rate_card_summary");
    expect(res.body).not.toHaveProperty("followers");
    expect(res.body).not.toHaveProperty("truncated");
    // trend is omitted, not invented.
    expect(res.body).not.toHaveProperty("trend");
  });

  it("sets Cache-Control: no-store on success and on rejection", async () => {
    const ok = await get(`/athletes/${athleteId}/score`, {
      "x-voice-secret": SECRET,
    });
    expect(ok.cacheControl).toBe("no-store");

    const denied = await get(`/athletes/${athleteId}/score`);
    expect(denied.cacheControl).toBe("no-store");
  });

  it("displayScore is null with no ledger read, even with a legacy athletes_current row present", async () => {
    const oddId = await seedAthlete("Voice Athlete No Ledger Read");
    await db.insert(athletesCurrent).values({
      athlete_id: oddId,
    });
    // Followers come from the social substrate since P2-3 — one count makes get_score answer (with a null score).
    await db.insert(socialAnalyticsSnapshots).values({ athlete_id: oddId, source: "discovery", platform: "instagram", followers: 100, snapshot_day: "2026-09-19" } as any);

    const res = await get(`/athletes/${oddId}/score`, {
      "x-voice-secret": SECRET,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayScore: null, outOf: 850, strengths: [] });
  });

  it("never returns another athlete's score (path id is the only scope)", async () => {
    const otherId = await seedAthlete("Voice Athlete Other");
    await db.insert(athletesCurrent).values({
      athlete_id: otherId,
    });
    await seedScore(otherId, 900);

    const res = await get(`/athletes/${athleteId}/score`, {
      "x-voice-secret": SECRET,
    });
    expect(res.body.displayScore).toBe(640);
    expect(JSON.stringify(res.body)).not.toContain("900");
    expect(JSON.stringify(res.body)).not.toContain("777");
    expect(JSON.stringify(res.body)).not.toContain("Elite");
  });
});
