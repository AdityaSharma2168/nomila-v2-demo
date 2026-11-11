/**
 * mePublicCard.metrics.test.ts — GET /api/v1/me/public-card/metrics, her metrics rail on the Front Door page, over HTTP
 * on PGlite (Express + the real router; only the auth check is replaced, and no provider is reachable).
 *
 *   auth      401 without a session
 *   flag      PUBLIC_CARD off → 404 (disabled)
 *   counts    the last 30 days, today included: views (per-day counts), likes, partner requests that reached her
 *             (confirmed), bookings past the buyer's email check, clicks on her picks. Anything older, a request still
 *             being drafted, an unverified booking and another athlete's rows are not counted
 *   tenancy   the athlete is the token's; another athlete's page counts never show
 *
 * Made-up athletes and brands.
 */
process.env.PUBLIC_CARD = "true";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = (globalThis as any).__TEST_ATHLETE_ID;
    if (!id) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeTestDb, client, db, initTestDb } from "../testUtils/pgliteDb";
import { athletes, deals, partnerRequests, shopClickDays, shopItems } from "../../shared/schema";
import { seedBooking, seedOffer } from "../testUtils/seedBookings";
import mePublicCardRouter from "./mePublicCard";
import { pageMetrics } from "../services/publicPage/stats";

jest.setTimeout(180_000);

let server: Server; let base = "";
const g = globalThis as any;
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
let A = ""; let B = "";

async function request(athleteId: string, ago: number, confirmed: boolean) {
  const [d] = confirmed ? await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Brand Example", status: "detected", source: "public_profile" } as any).returning({ id: deals.id }) : [null];
  await db.insert(partnerRequests).values({
    athlete_id: athleteId, public_ref: Math.random().toString(36).slice(2, 8).toUpperCase(), kind: "content", brand_name: "Brand Example", display_name: "F",
    brief: {}, contact_email_hash: "h", draft_token_hash: Math.random().toString(36), token_nonce: "n", expires_at: new Date(Date.now() + DAY),
    status: confirmed ? "confirmed" : "drafting",
    ...(confirmed ? { deal_id: d!.id, confirmed_at: new Date(Date.now() - ago), status_token_hash: Math.random().toString(36) } : {}),
  } as any);
}

beforeAll(async () => {
  await initTestDb();
  [{ id: A }] = await db.insert(athletes).values({ full_name: "Avery Example" } as any).returning({ id: athletes.id });
  [{ id: B }] = await db.insert(athletes).values({ full_name: "Blake Example" } as any).returning({ id: athletes.id });
  for (const [who, day, views] of [[A, iso(0), 5], [A, iso(10 * DAY), 7], [A, iso(29 * DAY), 1], [A, iso(31 * DAY), 100], [B, iso(0), 50]] as const) {
    await client.query(`INSERT INTO public_page_view_days (athlete_id, day, views) VALUES ($1, $2, $3)`, [who, day, views]);
  }
  for (const [who, hash, ago] of [[A, "l1", 0], [A, "l2", 3 * DAY], [A, "l3", 40 * DAY], [B, "l4", 0]] as const) {
    await client.query(`INSERT INTO public_page_likes (athlete_id, visitor_hash, created_at) VALUES ($1, $2, $3)`, [who, hash, new Date(Date.now() - ago).toISOString()]);
  }
  await request(A, 2 * DAY, true);
  await request(A, 45 * DAY, true);
  await request(A, 0, false);
  await request(B, 0, true);
  const offer = await seedOffer(A);
  await seedBooking(offer, { status: "requested" });
  await seedBooking(offer, { status: "confirmed" });
  await seedBooking(offer, { status: "unverified" });
  await seedBooking(offer, { status: "requested", created_at: new Date(Date.now() - 60 * DAY) } as any);
  const [item] = await db.insert(shopItems).values({ athlete_id: A, code: "c0de1", url: "https://shop.example/a", url_host: "shop.example", source: "link", title: "A pick" } as any).returning({ id: shopItems.id });
  await db.insert(shopClickDays).values([{ item_id: item.id, day: iso(1 * DAY), clicks: 4 }, { item_id: item.id, day: iso(50 * DAY), clicks: 9 }] as any);

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", mePublicCardRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});
beforeEach(() => { process.env.PUBLIC_CARD = "true"; });

const get = async (athleteId: string | null) => {
  g.__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me/public-card/metrics`);
  return { status: r.status, body: await r.json().catch(() => undefined) as any, headers: r.headers };
};

describe("GET /me/public-card/metrics", () => {
  it("401 without a session", async () => {
    expect((await get(null)).status).toBe(401);
  });

  it("404 while PUBLIC_CARD is off", async () => {
    process.env.PUBLIC_CARD = "false";
    const r = await get(A);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("disabled");
  });

  it("her last 30 days: views · likes · requests · bookings · shop", async () => {
    const r = await get(A);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toEqual({ windowDays: 30, since: iso(29 * DAY), views: 13, likes: 2, requests: 1, bookings: 2, shop: 4 });
  });

  it("another athlete sees only their own counts", async () => {
    const r = await get(B);
    expect(r.body).toMatchObject({ views: 50, likes: 1, requests: 1, bookings: 0, shop: 0 });
  });

  it("an athlete with nothing yet reads zeros", async () => {
    const [{ id }] = await db.insert(athletes).values({ full_name: "Casey Example" } as any).returning({ id: athletes.id });
    expect(await pageMetrics(id)).toMatchObject({ views: 0, likes: 0, requests: 0, bookings: 0, shop: 0 });
  });
});
