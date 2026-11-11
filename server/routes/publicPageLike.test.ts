/**
 * publicPageLike.test.ts — the visitor's heart (POST /p/:handle/like) and the page-view count, over HTTP on PGlite.
 *
 *   flag        PUBLIC_CARD off → the route does not exist (falls through to the app's 404)
 *   CSRF        JSON only (415); the X-Nomila-Like: 1 header and a same-site origin (403); a malformed handle (404)
 *   body        the visitor token's shape and a boolean `liked` (400)
 *   page        only a PUBLISHED page takes likes: unknown, draft and unpublished handles are the same 404
 *   once        liking twice is one like; tap again takes it back; the answer never carries a count
 *   privacy     only a keyed hash is stored (never the token), and the same token hashes differently on another page
 *   views       GET /p/:handle counts one view per load of a published page (never a prefetch, a door page or a 404)
 *   limit       a burst from one IP is answered 429
 *
 * No provider is reached; made-up athletes only.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeTestDb, client, db, initTestDb } from "../testUtils/pgliteDb";
import { athletes, publicCards } from "../../shared/schema";
import { createPublicPageLikeRouter } from "./publicPageLike";
import { createPublicPageRouter } from "./publicPage";
import { recordView } from "../services/publicPage/stats";
import { PUBLIC_CARD_FIXTURES } from "../services/publicCard/fixtures";

jest.setTimeout(180_000);

let server: Server; let base = "";
const ENV = { ...process.env };
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const OTHER = "ZyXwVuTsRqPoNmLkJiHgFe";
let A = ""; let B = "";
const HANDLE = "avery-okafor"; // a fixture page, so GET /p/:handle renders through the real renderer

async function card(athleteId: string, handle: string, status: "draft" | "published" | "unpublished") {
  await db.insert(publicCards).values({ athlete_id: athleteId, handle, status, published_version: status === "published" ? 1 : null, last_version: 1 } as any);
}

beforeAll(async () => {
  await initTestDb();
  [{ id: A }] = await db.insert(athletes).values({ full_name: "Avery Example" } as any).returning({ id: athletes.id });
  [{ id: B }] = await db.insert(athletes).values({ full_name: "Blake Example" } as any).returning({ id: athletes.id });
  const [{ id: C }] = await db.insert(athletes).values({ full_name: "Casey Example" } as any).returning({ id: athletes.id });
  await card(A, HANDLE, "published");
  await card(B, "blake-example", "published");
  await card(C, "casey-example", "draft");
  const app = express();
  app.use(express.json());
  app.use(createPublicPageLikeRouter());
  app.use(createPublicPageRouter({ loadView: async (h) => PUBLIC_CARD_FIXTURES[h] ?? null, mila: false, onView: (h) => recordView(h) }));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  process.env = ENV;
});
beforeEach(() => { process.env.PUBLIC_CARD = "true"; process.env.SESSION_SECRET = "test-secret-for-likes"; });

const like = async (handle: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}/p/${handle}/like`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-nomila-like": "1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => undefined) as any, headers: r.headers };
};
const likes = async (athleteId: string) => (await client.query<any>(`SELECT visitor_hash FROM public_page_likes WHERE athlete_id = $1`, [athleteId])).rows;
const views = async (athleteId: string) => (await client.query<any>(`SELECT COALESCE(SUM(views), 0)::int AS n FROM public_page_view_days WHERE athlete_id = $1`, [athleteId])).rows[0].n;

describe("POST /p/:handle/like", () => {
  it("does not exist while PUBLIC_CARD is off", async () => {
    process.env.PUBLIC_CARD = "false";
    const r = await like(HANDLE, { visitor: TOKEN, liked: true });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Not found" });
    expect(await likes(A)).toEqual([]);
  });

  it("refuses anything but a same-site JSON request with its header", async () => {
    expect((await like(HANDLE, "visitor=x", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await like(HANDLE, { visitor: TOKEN, liked: true }, { "x-nomila-like": "" })).status).toBe(403);
    expect((await like(HANDLE, { visitor: TOKEN, liked: true }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await like(HANDLE, { visitor: TOKEN, liked: true }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await like("Not_A_Handle", { visitor: TOKEN, liked: true })).status).toBe(404);
    expect(await likes(A)).toEqual([]);
  });

  it("checks the body", async () => {
    expect((await like(HANDLE, { visitor: "short", liked: true })).status).toBe(400);
    expect((await like(HANDLE, { visitor: TOKEN, liked: "yes" })).status).toBe(400);
    expect((await like(HANDLE, { liked: true })).status).toBe(400);
  });

  it("answers the same 404 for an unknown or unpublished page", async () => {
    expect((await like("nobody-here", { visitor: TOKEN, liked: true })).status).toBe(404);
    expect((await like("casey-example", { visitor: TOKEN, liked: true })).status).toBe(404);
  });

  it("one like per visitor; tap again takes it back; never a count", async () => {
    const r1 = await like(HANDLE, { visitor: TOKEN, liked: true });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ liked: true });
    expect(r1.headers.get("cache-control")).toBe("no-store");
    expect((await like(HANDLE, { visitor: TOKEN, liked: true })).body).toEqual({ liked: true });
    expect(await likes(A)).toHaveLength(1);
    await like(HANDLE, { visitor: OTHER, liked: true });
    expect(await likes(A)).toHaveLength(2);
    expect((await like(HANDLE, { visitor: TOKEN, liked: false })).body).toEqual({ liked: false });
    expect(await likes(A)).toHaveLength(1);
    expect((await like(HANDLE, { visitor: TOKEN, liked: false })).status).toBe(200); // unliking twice is a no-op
    expect(await likes(A)).toHaveLength(1);
  });

  it("stores only a keyed hash, different on each athlete's page", async () => {
    await like(HANDLE, { visitor: TOKEN, liked: true });
    await like("blake-example", { visitor: TOKEN, liked: true });
    const [a] = (await likes(A)).filter((r: any) => r.visitor_hash);
    const all = [...await likes(A), ...await likes(B)].map((r: any) => r.visitor_hash);
    for (const h of all) expect(h).not.toContain(TOKEN);
    const [b] = await likes(B);
    expect(a.visitor_hash).toBeTruthy();
    expect((await likes(A)).map((r: any) => r.visitor_hash)).not.toContain(b.visitor_hash);
    const cols = (await client.query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'public_page_likes' ORDER BY 1`)).rows.map((r: any) => r.column_name);
    expect(cols).toEqual(["athlete_id", "created_at", "visitor_hash"]); // no IP, user agent or token column
  });
});

describe("page views", () => {
  const settle = () => new Promise((r) => setTimeout(r, 50));
  it("counts each load of a published page, never a prefetch, a door page or a miss", async () => {
    const before = await views(A);
    expect((await fetch(`${base}/p/${HANDLE}`)).status).toBe(200);
    expect((await fetch(`${base}/p/${HANDLE}`)).status).toBe(200);
    await settle();
    expect(await views(A)).toBe(before + 2);
    await fetch(`${base}/p/${HANDLE}`, { headers: { "sec-purpose": "prefetch" } });
    await fetch(`${base}/p/${HANDLE}/book`);
    await fetch(`${base}/p/nobody-here`);
    await settle();
    expect(await views(A)).toBe(before + 2);
  });

  it("the page draws the heart, hidden until its script runs, and no count", async () => {
    const html = await (await fetch(`${base}/p/${HANDLE}`)).text();
    expect(html).toContain(`id="pc-like" hidden aria-pressed="false" aria-label="Like this page"`);
    expect(html).toContain(`data-endpoint="/p/${HANDLE}/like"`);
    expect(html).not.toMatch(/\d+\s+likes?/i);
    expect(html).not.toContain("Verified by Nomila"); // the switch is off
    expect(html).toContain("Follow Avery");
  });
});

describe("rate limit", () => {
  it("a burst from one IP is answered 429", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await like(HANDLE, { visitor: TOKEN, liked: i % 2 === 0 })).status;
    expect(last).toBe(429);
  });
});
