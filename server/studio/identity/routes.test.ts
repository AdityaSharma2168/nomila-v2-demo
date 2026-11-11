/**
 * identity/routes.test — the pack door (PR 17): off is a 404; on, the gate refuses by name, the
 * pack is hers alone, and the calibration writes a band that is on record and NOT asserted.
 *
 * REVERT CHECK, red by name:
 *   "pack surface renders with STUDIO_IDENTITY_PACK off" (server half) → drop `requirePack`
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: async (p: string) => `https://signed/${p}`,
  readObject: async (p: string) => ({
    buf: Buffer.from(p),
    contentType: "image/jpeg",
  }),
}));
const measureFacesMock = jest.fn();
jest.mock("./calibrate", () => ({
  ...jest.requireActual("./calibrate"),
  measureFaces: (...a: unknown[]) => measureFacesMock(...a),
}));
jest.mock("../qa/embed", () => ({
  embeddingDistance: (a: number[], b: number[]) => Math.abs(a[0] - b[0]),
  embedImageBytes: jest.fn(),
  cosine: jest.fn(),
}));

import express, { type RequestHandler } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { mediaAssets } from "../../../shared/schema";
import { registerIdentityRoutes } from "./routes";
import { readProfile } from "./profile";

let server: Server;
let base: string;
let A: string;
let B: string;

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("A");
  B = await seedAthlete("B");
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const gate: RequestHandler = (req, _res, next) => {
    req.athleteId = A;
    next();
  };
  registerIdentityRoutes(router, [gate]);
  app.use("/api/v1/me", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});
beforeEach(() => {
  process.env.STUDIO_IDENTITY_PACK = "true";
  measureFacesMock.mockReset();
});
afterEach(() => {
  delete process.env.STUDIO_IDENTITY_PACK;
});

const get = (p: string) => fetch(`${base}${p}`);
const send = (method: string, p: string, body?: unknown) =>
  fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

async function photo(
  athleteId: string,
  n: number,
  over: Partial<{
    origin: string;
    face: string;
    subject: string;
    disposition: string;
    shot: string;
  }> = {},
) {
  const id = uuid(n);
  await db.insert(mediaAssets).values({
    id,
    athlete_id: athleteId,
    platform: "upload",
    origin: over.origin ?? "upload",
    media_type: "IMAGE",
    status: "stored",
    gcs_path: `p/${n}.jpg`,
    metadata: {
      vision: {
        subject: over.subject ?? "the_athlete",
        athlete_present: (over.subject ?? "the_athlete") === "the_athlete",
        athlete_prominence: 0.9,
        disposition: over.disposition ?? "as_is",
        face_visibility: over.face ?? "clear",
        shot_type: over.shot ?? "portrait",
      },
    },
  } as never);
  return id;
}

describe("off is a 404", () => {
  it("pack surface renders with STUDIO_IDENTITY_PACK off — every door answers 404", async () => {
    delete process.env.STUDIO_IDENTITY_PACK;
    expect((await get("/studio/identity/profile")).status).toBe(404);
    expect((await get("/studio/identity/candidates")).status).toBe(404);
    expect(
      (await send("PUT", "/studio/identity/pack", { assetIds: [] })).status,
    ).toBe(404);
    expect((await send("POST", "/studio/identity/calibrate")).status).toBe(404);
  });
});

describe("candidates and the pack", () => {
  let hers: string[];
  let gen: string;
  let them: string;
  let noface: string;
  let theirs: string;

  beforeAll(async () => {
    hers = [];
    for (let i = 1; i <= 12; i++) hers.push(await photo(A, i));
    gen = await photo(A, 20, { origin: "generated" });
    them = await photo(A, 21, { subject: "another_person" });
    noface = await photo(A, 22, { face: "none" });
    theirs = await photo(B, 30);
  });

  it("lists HER photographs only, each judged, with the reason on the refused ones", async () => {
    const r = await get("/studio/identity/candidates");
    expect(r.status).toBe(200);
    const { candidates } = (await r.json()) as {
      candidates: {
        assetId: string;
        eligible: boolean;
        refusal: string | null;
        reason: string | null;
        thumbUrl: string;
      }[];
    };
    const ids = candidates.map((c) => c.assetId);
    expect(ids).not.toContain(theirs);
    expect(ids).toEqual(expect.arrayContaining([...hers, gen, them, noface]));
    const by = Object.fromEntries(candidates.map((c) => [c.assetId, c]));
    expect(by[gen]).toMatchObject({ eligible: false, refusal: "generated" });
    expect(by[them]).toMatchObject({ eligible: false, refusal: "not_you" });
    expect(by[noface]).toMatchObject({
      eligible: false,
      refusal: "likeness_no_face",
    });
    expect(by[hers[0]]).toMatchObject({
      eligible: true,
      refusal: null,
      reason: null,
    });
    expect(by[hers[0]].thumbUrl).toMatch(/^https:\/\/signed\//);
    expect(by[gen].reason).toMatch(/made here/);
    // #584's tiers: usable first, then the refused with unread before someone-else / made-here.
    const order = candidates.map((c) => c.refusal);
    const firstRefused = order.findIndex((r) => r !== null);
    expect(order.slice(0, firstRefused).every((r) => r === null)).toBe(true);
    expect(candidates.slice(firstRefused).map((c) => c.assetId)).toEqual(
      expect.arrayContaining([gen, them, noface]),
    );
  });

  it("PUT saves what passes, names what does not, and never takes another athlete's row", async () => {
    const r = await send("PUT", "/studio/identity/pack", {
      assetIds: [...hers, gen, them, noface, theirs],
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      profile: { pack: { assetId: string }[]; incomplete: boolean };
      refused: { assetId: string; refusal: string }[];
    };
    expect(j.profile.pack.map((e) => e.assetId)).toEqual(hers);
    expect(j.profile.incomplete).toBe(false);
    expect(j.refused).toEqual(
      expect.arrayContaining([
        { assetId: gen, refusal: "generated", reason: expect.any(String) },
        { assetId: them, refusal: "not_you", reason: expect.any(String) },
        {
          assetId: noface,
          refusal: "likeness_no_face",
          reason: expect.any(String),
        },
        { assetId: theirs, refusal: "not_yours", reason: expect.any(String) },
      ]),
    );
    expect(await readProfile(B)).toBeNull();
  });

  it("pack saves silently with no body shot — a close-up-only pack saves with the nudge; one action shot clears it", async () => {
    const r1 = await send("PUT", "/studio/identity/pack", { assetIds: hers });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { nudge: string | null }).nudge).toMatch(
      /full-length photo/,
    );
    const action = await photo(A, 40, { shot: "action" });
    const r2 = await send("PUT", "/studio/identity/pack", {
      assetIds: [...hers, action],
    });
    expect(((await r2.json()) as { nudge: string | null }).nudge).toBeNull();
  });

  it("a short list is saved as incomplete and the standing sentence says so", async () => {
    const r = await send("PUT", "/studio/identity/pack", {
      assetIds: hers.slice(0, 3),
    });
    const j = (await r.json()) as {
      profile: { incomplete: boolean; standing: string };
    };
    expect(j.profile.incomplete).toBe(true);
    expect(j.profile.standing).toMatch(/incomplete/i);
  });

  it("refuses a body that is not a list of uuids", async () => {
    expect(
      (await send("PUT", "/studio/identity/pack", { assetIds: ["nope"] }))
        .status,
    ).toBe(400);
  });

  it("calibrate measures her pack, writes the band ON RECORD, and asserts nothing", async () => {
    await send("PUT", "/studio/identity/pack", { assetIds: hers });
    measureFacesMock.mockImplementation(
      async (photos: { assetId: string }[]) => ({
        faces: photos.map((p, i) => ({
          assetId: p.assetId,
          vector: [i * 0.05],
          faceSizeFrac: 0.2 + i / 100,
          miss: null,
        })),
        visionCalls: photos.length,
        embedCalls: photos.length,
      }),
    );
    const r = await send("POST", "/studio/identity/calibrate");
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      profile: {
        band: { min: number; max: number; pairs: number } | null;
        controlPassed: boolean | null;
        standing: string;
      };
      measured: { photos: number; pairs: number; usd: number };
    };
    expect(j.measured.photos).toBe(12);
    expect(j.measured.pairs).toBe(66);
    expect(j.profile.band).toMatchObject({ min: 0.05, max: 0.55, pairs: 66 });
    expect(j.profile.controlPassed).toBeNull();
    expect(j.profile.standing).toMatch(/not asserted/);
    expect(j.measured.usd).toBeGreaterThan(0);
    const p = await readProfile(A);
    expect(p?.pack[3].faceSizeFrac).toBe(0.23);
  });

  it("calibrate with no pack is a 409, not a measurement", async () => {
    await send("PUT", "/studio/identity/pack", { assetIds: [] });
    expect((await send("POST", "/studio/identity/calibrate")).status).toBe(409);
    expect(measureFacesMock).not.toHaveBeenCalled();
  });

  it("GET profile carries the quote for the pack as saved", async () => {
    await send("PUT", "/studio/identity/pack", { assetIds: hers });
    const j = (await (await get("/studio/identity/profile")).json()) as {
      quote: { usd: number };
    };
    expect(j.quote.usd).toBeCloseTo(0.0077, 4);
  });
});
