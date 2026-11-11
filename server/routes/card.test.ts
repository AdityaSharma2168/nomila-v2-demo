/**
 * card.test.ts — security fix A1: the Nomi Card read routes (server/routes/card.ts).
 *
 * Before A1, GET /card/:athleteId (HTML) and GET /api/card/:athleteId (JSON) were public by
 * athlete id: anyone holding a UUID got her brand-tailored pitches, every rate, the cards she had
 * removed, and could start the paid multi-model kit build (?refresh=1, or any cache miss).
 *
 * Under test: /api/card needs auth + ownership (401 / 403 / 200 same shape); /card answers 404 to
 * everyone but the owner; no unauthenticated request ever reaches the builder; /c/:shareId still
 * serves (snapshot + cached live) and never builds — a live share with no cached kit reads
 * "unavailable" instead of building one.
 *
 * DB is PGlite (real SQL, real kitCache/kitShare/cardOverrides). The builder (assembleMediaKit),
 * the GCS signer and the HTML renderer are mocked — no provider is ever reached.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
// Auth: "Bearer <athleteId>" authenticates as that athlete; anything else fails as requireAuth would.
jest.mock("../lib/auth", () => {
  const authenticateRequest = async (req: any) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return { status: 401, body: { error: "Missing or malformed Authorization header" } };
    const id = h.slice(7);
    if (id === "bad-token") return { status: 401, body: { error: "Invalid or expired token" } };
    req.athleteId = id;
    return null;
  };
  return {
    authenticateRequest,
    requireAuth: async (req: any, res: any, next: any) => {
      const f = await authenticateRequest(req);
      if (f) { res.status(f.status).json(f.body); return; }
      next();
    },
  };
});
jest.mock("../services/mediaKitService", () => ({
  assembleMediaKit: jest.fn(async (athleteId: string, opts: { brandId?: number } = {}) => ({
    identity: { name: "Built Fresh" },
    cards: [{ id: "c1", type: "cover", image: "kits/built.jpg" }],
    deck: ["c1"],
    tokens: { theme: "campaign" },
    _builtFor: { athleteId, brandId: opts.brandId ?? 0 },
  })),
}));
jest.mock("../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));
// The brand book's engine draws the Luxe / Campaign looks (NOMI_ENGINE_V1, always on since 2 Nov 2026): stubbed the same
// way as the legacy renderer, so a share is read from its frozen copy whichever renderer draws it.
jest.mock("../services/nomiDeck/index.js", () => ({
  ...jest.requireActual("../services/nomiDeck/index.js"),
  renderNomiForWeb: jest.fn(async (kit: any) => `<!doctype html><html><body>CARD:${kit.identity?.name}</body></html>`),
}));
jest.mock("../services/kitRenderer", () => ({
  renderKitHtml: jest.fn((kit: any) => `<!doctype html><html><body>CARD:${kit.identity?.name}</body></html>`),
  listThemes: jest.fn(() => ["nomila", "luxe", "broadcast"]),
  listPickableThemes: jest.fn(() => ["nomila", "luxe", "broadcast"]),
}));

import express from "express";
import { trustProxyHops } from "../lib/trustProxy";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import cardRouter from "./card";
import { assembleMediaKit } from "../services/mediaKitService";
import { mediaKits, cardShares, cardShareViews } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const buildMock = assembleMediaKit as unknown as jest.Mock;

let server: Server;
let base: string;
let ownerId: string;
let otherId: string;
let uncachedId: string;

const cachedKit = (name: string) => ({
  identity: { name, tier: "Established", tierDisplay: "Established" },
  cards: [
    { id: "c1", type: "cover", image: "kits/cover.jpg" },
    // Cached before phase 2: the legacy /850 index (tier word + capitals rings) and the "Inside the score" mix card.
    { id: "i1", type: "index", bg: "kits/index.jpg", value: 691, max: 850, tierDisplay: "Established", rings: { audience: 72 }, verdict: "v" },
    { id: "m1", type: "mix", bg: "kits/mix.jpg", rows: [], tagline: "t", reframe: "r" },
    { id: "a1", type: "audience", bg: "kits/audience.jpg" },
    // A kit cached before legacy retirement (phase 1) still holds a rates card; it must never be served.
    { id: "r1", type: "rates", bg: "kits/rates.jpg", headline: { value: "$22K", range: "$14K – $31K · verified" } },
  ],
  deck: ["c1", "i1", "m1", "a1", "r1"],
  tokens: { theme: "campaign" },
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = undefined; }
  return { status: res.status, body, raw };
}
const as = (id: string) => ({ Authorization: `Bearer ${id}` });

beforeAll(async () => {
  await initTestDb();
  ownerId = await seedAthlete("Owner Athlete");
  otherId = await seedAthlete("Other Athlete");
  uncachedId = await seedAthlete("Uncached Athlete");
  await db.insert(mediaKits).values([
    { athlete_id: ownerId, brand_id: 0, data: cachedKit("Owner Generic") as any },
    { athlete_id: ownerId, brand_id: 7, data: cachedKit("Owner For Brand 7") as any },
    { athlete_id: otherId, brand_id: 0, data: cachedKit("Other Generic") as any },
  ]);
  await db.insert(cardShares).values([
    { id: "live-share", athlete_id: ownerId, mode: "live" },
    { id: "brand-share", athlete_id: ownerId, mode: "live", tailoring: "brand", brand_id: "7" },
    { id: "snap-share", athlete_id: uncachedId, mode: "snapshot", snapshot_data: cachedKit("Frozen Snapshot") as any },
    { id: "uncached-live", athlete_id: uncachedId, mode: "live" },
    { id: "revoked-share", athlete_id: ownerId, mode: "live", revoked: true },
  ]);

  const app = express();
  app.set("trust proxy", trustProxyHops());   // as server/index.ts sets it
  app.use(cardRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => buildMock.mockClear());

describe("GET /api/card/:athleteId — auth + ownership", () => {
  it("401 without a token, and never builds", async () => {
    const r = await get(`/api/card/${ownerId}`);
    expect(r.status).toBe(401);
    expect(r.raw).not.toContain("Owner Generic");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("401 with an invalid token", async () => {
    expect((await get(`/api/card/${ownerId}`, as("bad-token"))).status).toBe(401);
  });

  it("403 for another athlete's card (generic and brand-tailored)", async () => {
    const r = await get(`/api/card/${ownerId}`, as(otherId));
    expect(r.status).toBe(403);
    expect(r.raw).not.toContain("Owner");
    const b = await get(`/api/card/${ownerId}?brandId=7`, as(otherId));
    expect(b.status).toBe(403);
    expect(b.raw).not.toContain("Brand 7");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("200 for the owner, same MediaKitData shape, images signed, from the cache", async () => {
    const r = await get(`/api/card/${ownerId}`, as(ownerId));
    expect(r.status).toBe(200);
    expect(r.body.identity.name).toBe("Owner Generic");
    // The retired rates card is dropped from cards AND deck order (legacy retirement, phase 1), and so are the
    // legacy /850 index card and the mix card (phase 2) — and the tier word on the identity.
    expect(r.body.deck).toEqual(["c1", "a1"]);
    expect(r.body.cards.map((c: any) => c.type)).toEqual(["cover", "audience"]);
    expect(r.body.identity).toEqual({ name: "Owner Generic" });
    expect(r.raw).not.toContain("691");
    expect(r.raw).not.toContain("Established");
    expect(r.body.cards[0].image).toBe("https://signed.example/kits/cover.jpg");
    expect(r.body.cards[1].bg).toBe("https://signed.example/kits/audience.jpg");
    expect(r.raw).not.toContain("$22K");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("the owner still gets her brand-tailored deck via ?brandId", async () => {
    const r = await get(`/api/card/${ownerId}?brandId=7`, as(ownerId));
    expect(r.status).toBe(200);
    expect(r.body.identity.name).toBe("Owner For Brand 7");
  });

  it("/api/card/themes stays public and is not read as an athlete id", async () => {
    const r = await get(`/api/card/themes`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ themes: ["nomila", "luxe", "broadcast"] });
  });
});

describe("GET /card/:athleteId — owner preview only", () => {
  it("404 without a token (same as an unknown id)", async () => {
    const r = await get(`/card/${ownerId}`);
    expect(r.status).toBe(404);
    expect(r.raw).toContain("Card not found.");
    expect(r.raw).not.toContain("Owner Generic");
  });

  it("404 with an invalid token, and 404 for another athlete", async () => {
    expect((await get(`/card/${ownerId}`, as("bad-token"))).status).toBe(404);
    const r = await get(`/card/${ownerId}?brandId=7`, as(otherId));
    expect(r.status).toBe(404);
    expect(r.raw).not.toContain("Brand 7");
  });

  it("?refresh=1 / ?brandId unauthenticated never call the builder", async () => {
    expect((await get(`/card/${ownerId}?refresh=1`)).status).toBe(404);
    expect((await get(`/card/${ownerId}?refresh=1&brandId=99`)).status).toBe(404);
    expect((await get(`/card/${uncachedId}`)).status).toBe(404); // a cache miss used to build too
    expect((await get(`/card/${ownerId}?refresh=1`, as(otherId))).status).toBe(404);
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("the owner gets the HTML preview from the cache", async () => {
    const r = await get(`/card/${ownerId}`, as(ownerId));
    expect(r.status).toBe(200);
    expect(r.raw).toContain("CARD:Owner Generic");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("the owner's ?refresh=1 is still honoured (builds)", async () => {
    const r = await get(`/card/${ownerId}?refresh=1`, as(ownerId));
    expect(r.status).toBe(200);
    expect(r.raw).toContain("CARD:Built Fresh");
    expect(buildMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /c/:shareId — the public share route never builds", () => {
  it("serves a live share from the cached kit and logs the open", async () => {
    const before = await db.select().from(cardShareViews).where(eq(cardShareViews.share_id, "live-share"));
    const r = await get(`/c/live-share`);
    expect(r.status).toBe(200);
    expect(r.raw).toContain("CARD:");
    expect(r.raw).toContain("/c/live-share/beat");
    const after = await db.select().from(cardShareViews).where(eq(cardShareViews.share_id, "live-share"));
    expect(after.length).toBe(before.length + 1);
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("serves a brand-tailored live share from that brand's cache", async () => {
    const r = await get(`/c/brand-share`);
    expect(r.status).toBe(200);
    expect(r.raw).toContain("CARD:Owner For Brand 7");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("serves a snapshot share from its frozen copy", async () => {
    const r = await get(`/c/snap-share`);
    expect(r.status).toBe(200);
    expect(r.raw).toContain("CARD:Frozen Snapshot");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("a live share with NO cached kit reads 'unavailable' (503) rather than building", async () => {
    const r = await get(`/c/uncached-live`);
    expect(r.status).toBe(503);
    expect(r.raw).toContain("being refreshed");
    expect(buildMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(mediaKits).where(eq(mediaKits.athlete_id, uncachedId));
    expect(row).toBeUndefined();
  });

  it("keeps the gates: revoked → 410, unknown → 404", async () => {
    expect((await get(`/c/revoked-share`)).status).toBe(410);
    expect((await get(`/c/no-such-share`)).status).toBe(404);
    expect(buildMock).not.toHaveBeenCalled();
  });
});
