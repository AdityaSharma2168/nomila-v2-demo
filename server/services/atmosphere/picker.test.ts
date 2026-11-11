/**
 * picker.test.ts — the atmosphere picker and its route, over HTTP on PGlite. Every provider is a fake (PickerDeps): no
 * call reaches OpenAI, Pixabay, Vertex or GCS, and the real provider modules throw if anything reaches them.
 *
 *   flag     404 while ATMOSPHERE_IMAGERY is not exactly "true", and nothing runs
 *   input    401 without a session; 400 for a bad screen, slot type, purpose, too many or repeated slots
 *   fetch    queries → search → download → check: a rejected candidate is recorded with its reason and no copy; the
 *            accepted one is stored with credit, licence, source URL, query, purpose and check result; the screen gets
 *            OUR signed URL, never Pixabay's
 *   reuse    the same slot keeps its image with no provider call; another screen reuses the stored image with no
 *            provider call; a second slot on the same screen never repeats an image; the choice is deterministic
 *   fallback no Pixabay → a generated image, checked the same way; a rejected generation → the category default
 *   caps     the athlete day cap and the generation cap stop paid work; spend is recorded per athlete per day
 *   tenancy  one athlete never gets another's images
 *
 * Made-up athletes and sports; nothing here is a real person, sport or brand.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = (globalThis as any).__TEST_ATHLETE_ID;
    if (!id) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));
const never = () => { throw new Error("a real provider was reached"); };
jest.mock("../../lib/mediaStore", () => ({ saveBuffer: never, signedUrl: never }));
jest.mock("../../studio/router", () => ({ generate: never }));
jest.mock("./model", () => ({ ...jest.requireActual("./model"), writeQueries: never, checkImage: never }));
jest.mock("./pixabay", () => ({ ...jest.requireActual("./pixabay"), searchPixabay: never, downloadHit: never, pixabayConfigured: () => false }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb } from "../../testUtils/pgliteDb";
import { athletes, atmosphereImages, atmospherePlacements, atmosphereSpendDays, memoryFacts } from "../../../shared/schema";
import { createAtmosphereRouter } from "../../routes/meAtmosphere";
import { purposeKeyOf, resetPickerState, slotIndex, type PickerDeps } from "./picker";
import type { CheckResult } from "./model";
import type { PixabayHit } from "./pixabay";

jest.setTimeout(120_000);

const ZERO = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0 };
const cost = (microUsd: number) => ({ ...ZERO, microUsd });
const hit = (id: number): PixabayHit => ({ id, pageURL: `https://pixabay.com/photos/scene-${id}/`, tags: "scene", largeImageURL: `https://pixabay.com/get/${id}.jpg`, webformatURL: "", imageWidth: 4000, imageHeight: 3000, user: `user${id}`, user_id: id });
let lastScene: unknown = null;
const clean = { person: false, face: false, logo: false, text: false, watermark: false, fits_purpose: true, reason: "an empty venue" };

/** Fakes with counters. `bad` lists image ids (pixabay ids, or "gen") the check rejects for a person. */
function fakes(opts: { pixabay?: boolean; hits?: number[]; bad?: Array<number | "gen">; generate?: boolean } = {}) {
  const calls = { queries: 0, search: 0, download: 0, check: 0, generate: 0, save: 0 };
  const bad = new Set(opts.bad ?? []);
  const deps: PickerDeps = {
    writeQueries: async (athlete) => { calls.queries++; lastScene = athlete; return { queries: ["empty venue", "venue light"], imagePrompt: "An empty venue at dusk. No people.", model: "m", cost: cost(300) }; },
    checkImage: async (img) => {
      calls.check++;
      const id = img.bytes.toString();
      const isBad = bad.has(id === "gen" ? "gen" : Number(id));
      const answer = isBad ? { ...clean, person: true, reason: "a figure in the stand" } : clean;
      return { accepted: !isBad, rejectReason: isBad ? "person" : null, answer, model: "m", skillVersion: "1.0.0", cost: cost(200) } as CheckResult;
    },
    pixabayConfigured: () => opts.pixabay ?? true,
    searchPixabay: async () => { calls.search++; return { hits: (opts.hits ?? [1, 2, 3, 4]).map(hit), cached: false }; },
    downloadHit: async (h) => { calls.download++; return { bytes: Buffer.from(String(h.id)), contentType: "image/jpeg" }; },
    generateImage: async () => { calls.generate++; return opts.generate === false ? null : { bytes: Buffer.from("gen"), contentType: "image/png", costMicroUsd: 67_000 }; },
    saveImage: async (bytes, base, ct) => { calls.save++; return { gcs_path: `${base}.${ct === "image/png" ? "png" : "jpg"}`, content_type: ct, bytes: bytes.length }; },
    signedUrl: async (p) => `https://storage.example/${p}?sig=1`,
    now: () => new Date("2026-10-10T12:00:00Z"),
  };
  return { deps, calls };
}

const g = globalThis as any;
let server: Server; let base = "";
let current: PickerDeps;
const proxy: PickerDeps = new Proxy({} as PickerDeps, { get: (_t, k) => (current as any)[k] });
const pick = async (athleteId: string | null, body: unknown) => {
  g.__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me/atmosphere/pick`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => undefined) as any };
};
const slot = (key: string, purpose = "commercial", type = "goal") => ({ key, type, purpose, category: "commercial" });

let A = ""; let B = ""; let C = "";
const ENV = ["ATMOSPHERE_IMAGERY", "ATMOSPHERE_ATHLETE_DAY_CAP_USD", "ATMOSPHERE_GENERATIONS_PER_ATHLETE_DAY"];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  await initTestDb();
  const seed = async (name: string) => (await db.insert(athletes).values({ full_name: name, sport: "Sport Q", school: "School R" } as any).returning({ id: athletes.id }))[0].id;
  A = await seed("Ari Test"); B = await seed("Bo Test"); C = await seed("Cy Test");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", createAtmosphereRouter(proxy));
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const k of ENV) saved[k] = process.env[k];
});
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await new Promise((r) => server.close(r)); await closeTestDb();
});
beforeEach(() => { for (const k of ENV) delete process.env[k]; process.env.ATMOSPHERE_IMAGERY = "true"; resetPickerState(); });

test("flag: 404 unless exactly \"true\", and nothing runs", async () => {
  const f = fakes(); current = f.deps;
  for (const v of [undefined, "false", "TRUE", "1"]) {
    if (v === undefined) delete process.env.ATMOSPHERE_IMAGERY; else process.env.ATMOSPHERE_IMAGERY = v;
    expect((await pick(A, { screen: "home", slots: [slot("h")] })).status).toBe(404);
  }
  expect(Object.values(f.calls).every((n) => n === 0)).toBe(true);
});

test("input: 401 without a session; 400 for bad input", async () => {
  const f = fakes(); current = f.deps;
  expect((await pick(null, { screen: "home", slots: [slot("h")] })).status).toBe(401);
  for (const body of [
    { screen: "home", slots: [] },
    { screen: "home", slots: Array.from({ length: 13 }, (_, i) => slot(`s${i}`)) },
    { screen: "bad screen!", slots: [slot("h")] },
    { screen: "home", slots: [{ key: "h", type: "hero", purpose: "x" }] },
    { screen: "home", slots: [{ key: "h", type: "goal", purpose: "" }] },
    { screen: "home", slots: [slot("h"), slot("h")] },
  ]) expect((await pick(A, body)).status).toBe(400);
  expect(f.calls.queries).toBe(0);
});

test("fetch: a rejected candidate is recorded with its reason; the accepted one is stored with everything; the screen gets our URL", async () => {
  const f = fakes({ bad: [1] }); current = f.deps;
  const r = await pick(A, { screen: "goals", slots: [slot("goal:1")] });
  expect(r.status).toBe(200);
  const img = r.body.images[0];
  expect(img).toMatchObject({ key: "goal:1", kind: "image" });
  // No credit line or source link reaches a screen (owner decision 10 Oct 2026); the row keeps them.
  expect(Object.keys(img).sort()).toEqual(["height", "imageId", "key", "kind", "url", "width"]);
  expect(img.url).toMatch(/^https:\/\/storage\.example\/athletes\/.+\/atmosphere\/.+\.jpg\?sig=1$/);
  expect(img.url).not.toContain("pixabay");
  expect(f.calls).toMatchObject({ queries: 1, search: 1, download: 2, check: 2, save: 1, generate: 0 });

  const rows = await db.select().from(atmosphereImages).where(eq(atmosphereImages.athlete_id, A));
  const rejected = rows.find((x) => x.source_id === "1")!;
  expect(rejected).toMatchObject({ status: "rejected", gcs_path: null, reject_reason: "person", credit: "Photo: user1 / Pixabay" });
  expect((rejected.check_result as any).reason).toBe("a figure in the stand");
  const accepted = rows.find((x) => x.source_id === "2")!;
  expect(accepted).toMatchObject({
    status: "accepted", licence: "pixabay-content-license", source_url: "https://pixabay.com/photos/scene-2/", query: "empty venue",
    slot_type: "goal", purpose: "commercial", purpose_key: purposeKeyOf("goal", "commercial"), reject_reason: null, cost_micro_usd: 200,
  });
  expect(accepted.gcs_path).toMatch(new RegExp(`^athletes/${A}/atmosphere/`));
  expect(accepted.check_result).toMatchObject({ ...clean, model: "m", skill_version: "1.0.0" });

  const [spend] = await db.select().from(atmosphereSpendDays).where(eq(atmosphereSpendDays.athlete_id, A));
  expect(spend).toMatchObject({ day: "2026-10-10", micro_usd: 300 + 200 + 200, model_calls: 3, pixabay_calls: 1, generations: 0 });
});

test("reuse: a slot keeps its image; another screen reuses the stored one; a second slot on a screen never repeats", async () => {
  const f = fakes({ bad: [1] }); current = f.deps;
  const first = (await pick(A, { screen: "goals", slots: [slot("goal:1")] })).body.images[0];
  expect(first.kind).toBe("image");   // stored by the previous test, so no provider call at all
  expect(f.calls).toMatchObject({ queries: 0, search: 0, check: 0 });

  const other = (await pick(A, { screen: "strategy", slots: [slot("plan")] })).body.images[0];
  expect(other.imageId).toBe(first.imageId);
  expect(f.calls.check).toBe(0);

  // Two slots, same purpose, one screen: the second needs a new image (2 is placed; 1 was rejected; 3 is next).
  const both = (await pick(A, { screen: "strategy", slots: [slot("plan"), slot("plan-2")] })).body.images;
  expect(both[0].imageId).toBe(first.imageId);
  expect(both[1].kind).toBe("image");
  expect(both[1].imageId).not.toBe(first.imageId);
  expect(f.calls.download).toBe(1);   // only hit 3: the seen ones are never downloaded again
  const placed = await db.select().from(atmospherePlacements).where(eq(atmospherePlacements.athlete_id, A));
  expect(new Set(placed.filter((p) => p.screen === "strategy").map((p) => p.image_id)).size).toBe(2);
});

test("deterministic: the slot index is a pure function of athlete, screen and slot", () => {
  expect(slotIndex("a", "s", "k", 7)).toBe(slotIndex("a", "s", "k", 7));
  const spread = new Set(Array.from({ length: 50 }, (_, i) => slotIndex("a", "s", `k${i}`, 5)));
  expect(spread.size).toBe(5);
});

test("fallback: without Pixabay a generated image is checked and stored; a rejected generation gives the category default", async () => {
  const f = fakes({ pixabay: false }); current = f.deps;
  const img = (await pick(B, { screen: "home", slots: [slot("empty", "audience", "empty_state")] })).body.images[0];
  expect(img).toMatchObject({ kind: "image" });
  expect(f.calls).toMatchObject({ search: 0, generate: 1, check: 1, save: 1 });
  const [row] = await db.select().from(atmosphereImages).where(eq(atmosphereImages.athlete_id, B));
  expect(row).toMatchObject({ source: "generated", licence: "generated", query: "An empty venue at dusk. No people.", cost_micro_usd: 67_200 });

  const g2 = fakes({ pixabay: false, bad: ["gen"] }); current = g2.deps;
  const d = (await pick(B, { screen: "home", slots: [slot("pitch", "pitch deck cover", "pitch")] })).body.images[0];
  expect(d).toEqual({ key: "pitch", kind: "default", category: "commercial", reason: "generation_rejected" });
  const rejected = (await db.select().from(atmosphereImages).where(eq(atmosphereImages.athlete_id, B))).filter((x) => x.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ source: "generated", reject_reason: "person", gcs_path: null });
});

test("caps: the athlete day cap stops all paid work; the generation cap stops generation", async () => {
  process.env.ATMOSPHERE_ATHLETE_DAY_CAP_USD = "0";
  const f = fakes(); current = f.deps;
  expect((await pick(C, { screen: "home", slots: [slot("h", "impact")] })).body.images[0]).toMatchObject({ kind: "default", reason: "athlete_day_cap" });
  expect(f.calls.queries).toBe(0);

  delete process.env.ATMOSPHERE_ATHLETE_DAY_CAP_USD;
  process.env.ATMOSPHERE_GENERATIONS_PER_ATHLETE_DAY = "0";
  const g2 = fakes({ pixabay: false }); current = g2.deps;
  expect((await pick(C, { screen: "home", slots: [slot("h", "impact")] })).body.images[0]).toMatchObject({ kind: "default", reason: "generation_cap" });
  expect(g2.calls.generate).toBe(0);
});

test("tenancy: one athlete never gets another's images", async () => {
  const f = fakes({ pixabay: false, generate: false }); current = f.deps;
  // A has a stored "commercial" goal image; C asking for the same purpose gets nothing of A's.
  const r = (await pick(C, { screen: "goals", slots: [slot("goal:1")] })).body.images[0];
  expect(r).toMatchObject({ kind: "default", reason: "generation_failed" });
  const cs = await db.select().from(atmospherePlacements).where(eq(atmospherePlacements.athlete_id, C));
  expect(cs).toHaveLength(0);
});

test("scene: the query writer gets the sport and the athlete's team/level facts from memory, never the name or others' facts", async () => {
  const [{ id: D }] = await db.insert(athletes).values({ full_name: "Dee Example", sport: "Sport Q", school: "Legacy Column School" } as any).returning({ id: athletes.id });
  const fact = (o: Record<string, unknown>) => ({ athlete_id: D, subject_kind: "athlete", subject_name: "Dee Example", type: "found", source_url: "https://example.org/x", confidence: 0.8, ...o });
  await db.insert(memoryFacts).values([
    fact({ claim: "Dee Example's team plays home games in an indoor arena.", topic: "team", confidence: 0.9 }),
    fact({ claim: "Dee plays in a spring league.", topic: "competition" }),
    fact({ claim: "A teammate signed with a brand.", topic: "team", subject_kind: "person", subject_name: "Someone Else" }),
    fact({ claim: "Dee Example has a private matter.", topic: "status", sensitive: true }),
    fact({ claim: "Dee Example had a sponsor.", topic: "sponsor" }),
    fact({ claim: "An old fact.", topic: "team", status: "superseded" }),
  ] as any);
  const f = fakes({ pixabay: false, generate: false }); current = f.deps;
  await pick(D, { screen: "home", slots: [slot("h", "impact")] });
  expect(lastScene).toEqual({
    sport: "Sport Q",
    facts: [
      { topic: "team", claim: "the athlete team plays home games in an indoor arena." },
      { topic: "competition", claim: "the athlete plays in a spring league." },
    ],
  });
  expect(JSON.stringify(lastScene)).not.toMatch(/Dee|Example|Legacy Column School/);
});
