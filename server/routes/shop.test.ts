/**
 * routes/shop.test.ts — Her picks against PGlite (docs/design/shop-her-picks.md). No test reaches a provider or the
 * network: safeFetch and the model (genai) are replaced.
 *
 *   T1 tenancy: another athlete's pick is a 404 to read, edit, delete or reorder; lists are hers only
 *   T2 add: a draft with what the page said; her link kept; the same link again is the same pick; Mila's suggestion is
 *      stored apart and never public
 *   T3 the shelf opens only on her answers: 18+, the international question (acknowledged if yes); a known minor never
 *   T4 supplements are off until she opts in
 *   T5 exclusivity: a signed deal's competitor needs her confirmation (recorded); her sponsor's own domain doesn't; with
 *      the model down, a contract that says exclusivity still warns
 *   T6 her school's apparel sponsor warns on competing footwear
 *   T7 /go/:code: a live pick → 302 to her link, one click today, nothing about the fan; every miss the same 404
 *   T8 the public read: live picks only, her words only, "Paid link" on each, Amazon's statement when an Amazon pick is live
 *   T9 NIL Go: signed brand deals per brand against $600, college only, her affiliate income explicitly not counted
 *   T10 her order and delete (click days go with the pick)
 */
process.env.SHOP_V1 = "true";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/rateLimit", () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { shopLinkLimiter: pass, shopRedirectLimiter: pass };
});
// The page fetch: a map of URL → page. Robots is a 404 (allowed) unless a test sets one.
const pages = new Map<string, { body: string; type?: string; status?: number }>();
jest.mock("../lib/safeFetch", () => {
  const actual = jest.requireActual("../lib/safeFetch");
  return {
    ...actual,
    safeFetch: jest.fn(async (url: string) => {
      const p = pages.get(url);
      if (!p) return new Response("", { status: 404 });
      return new Response(p.body, { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html" } });
    }),
  };
});
// The model: a queued JSON answer per call, or a throw.
const judgeAnswers: Array<object | Error> = [];
const judgeCalls: string[] = [];
jest.mock("../lib/models", () => ({
  GEMINI: { flashLite: "test-model", flash: "test-model" },
  genai: () => ({ models: { generateContent: async (req: any) => {
    judgeCalls.push(req.contents[0].parts[0].text);
    const a = judgeAnswers.shift() ?? { category: "apparel", brands: [], sponsor: null };
    if (a instanceof Error) throw a;
    return { text: JSON.stringify(a) };
  } } }),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import shopRouter from "./shop";
import shopRedirectRouter from "./shopRedirect";
import { athleteFacts, athletes, deals, inboxBrands, shopClickDays, shopItems } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { _clearRobotsCache } from "../services/shop/linkMeta";

let server: Server; let base: string; let a1: string; let a2: string;
const g = globalThis as any;
const as = (id: string) => { g.__TEST_ATHLETE_ID = id; };
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
};
const page = (url: string, title: string, extra = "") => pages.set(url, { body: `<meta property="og:title" content="${title}">${extra}` });
const open = async (id: string) => { as(id); return api("PUT", "/shop/settings", { adult_confirmed: true, international_student: false }); };

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Shop One");
  a2 = await seedAthlete("Shop Two");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", shopRouter);
  app.use(shopRedirectRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); await closeTestDb(); });
beforeEach(() => { pages.clear(); judgeAnswers.length = 0; judgeCalls.length = 0; _clearRobotsCache(); });

describe("T2 add", () => {
  it("a draft with what the page said; her link kept; same link again → the same pick; the suggestion is apart", async () => {
    as(a1);
    page("https://store.example.com/p/1?ref=HER", "Court Shoe", `<meta property="og:image" content="https://cdn.example.com/1.jpg">`);
    judgeAnswers.push({ category: "footwear", brands: [], sponsor: null });
    const r = await api("POST", "/shop/items", { url: "https://store.example.com/p/1?ref=HER", suggested_blurb: "Mila's idea" });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ url: "https://store.example.com/p/1?ref=HER", title: "Court Shoe", status: "draft", category: "footwear", blurb: null, blurbSuggestion: "Mila's idea", imageUrl: "https://cdn.example.com/1.jpg", source: "link" });
    const again = await api("POST", "/shop/items", { url: "https://store.example.com/p/1?ref=HER" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existing: true, item: { id: r.body.item.id } });
    expect((await api("POST", "/shop/items", { url: "ftp://x.example.com" })).status).toBe(400);
  });
  it("a page that can't be read still makes a pick titled by its host", async () => {
    as(a1);
    const r = await api("POST", "/shop/items", { url: "https://unreadable.example.com/x" });
    expect(r.body.item).toMatchObject({ title: "unreadable.example.com", status: "draft" });
  });
  it("preview writes nothing", async () => {
    as(a2);
    page("https://store.example.com/p/preview", "Preview Thing");
    const before = (await db.select().from(shopItems).where(eq(shopItems.athlete_id, a2))).length;
    const r = await api("POST", "/shop/preview", { url: "https://store.example.com/p/preview" });
    expect(r.status).toBe(200);
    expect(r.body.link).toMatchObject({ title: "Preview Thing", url: "https://store.example.com/p/preview" });
    expect((await db.select().from(shopItems).where(eq(shopItems.athlete_id, a2))).length).toBe(before);
  });
});

describe("T1 tenancy", () => {
  it("another athlete's pick is not found to read, edit, delete or reorder", async () => {
    as(a1);
    page("https://store.example.com/p/mine", "Mine");
    const mine = (await api("POST", "/shop/items", { url: "https://store.example.com/p/mine" })).body.item;
    as(a2);
    expect((await api("PATCH", `/shop/items/${mine.id}`, { title: "Stolen" })).status).toBe(404);
    expect((await api("DELETE", `/shop/items/${mine.id}`)).status).toBe(404);
    expect((await api("POST", "/shop/items/order", { ids: [mine.id] })).status).toBe(400);
    expect((await api("GET", "/shop")).body.items.some((i: any) => i.id === mine.id)).toBe(false);
    expect((await api("PATCH", "/shop/items/not-a-uuid", { title: "x" })).status).toBe(404);
    const [row] = await db.select().from(shopItems).where(eq(shopItems.id, mine.id));
    expect(row.title).toBe("Mine");
  });
});

describe("T3 the shelf opens only on her answers", () => {
  it("publishing waits for 18+ and the international answer; a yes needs her acknowledgement", async () => {
    const a = await seedAthlete("Gate");
    as(a);
    page("https://store.example.com/p/gate", "Gate Tee");
    const item = (await api("POST", "/shop/items", { url: "https://store.example.com/p/gate" })).body.item;
    let r = await api("PATCH", `/shop/items/${item.id}`, { status: "live" });
    expect(r).toMatchObject({ status: 409, body: { code: "not_eligible", needs: ["adult_confirmation", "international_answer"] } });
    await api("PUT", "/shop/settings", { adult_confirmed: true, international_student: true });
    r = await api("PATCH", `/shop/items/${item.id}`, { status: "live" });
    expect(r.body).toMatchObject({ code: "not_eligible", needs: ["international_ack"] });
    const s = await api("PUT", "/shop/settings", { international_ack: true });
    expect(s.body.settings).toMatchObject({ eligible: true, internationalStudent: true, internationalAcknowledged: true });
    r = await api("PATCH", `/shop/items/${item.id}`, { status: "live" });
    expect(r.status).toBe(200);
    expect(r.body.item.status).toBe("live");
  });
  it("a known minor (a current birth year, or a high-school level) is never eligible", async () => {
    const a = await seedAthlete("Young");
    await db.insert(athleteFacts).values({ athlete_id: a, fact_key: "birth_year", value: 2012, value_text: "2012", status: "current", retrieved_at: new Date(), origin: "research", source_class: "web_researched", confidence: "0.90", provenance: {}, freshness_family: "static", resolver_version: "t", registry_version: "t" } as any);
    const r = await open(a);
    expect(r.body.settings).toMatchObject({ eligible: false, needs: ["minor"] });
    const hs = await seedAthlete("HS");
    await db.update(athletes).set({ division: "HS" } as any).where(eq(athletes.id, hs));
    expect((await open(hs)).body.settings.needs).toEqual(["minor"]);
  });
});

describe("T4 supplements", () => {
  it("a supplement can't go live until she opts in", async () => {
    const a = await seedAthlete("Supp");
    await open(a);
    page("https://store.example.com/p/protein", "Whey Protein");
    judgeAnswers.push({ category: "supplements", brands: [], sponsor: null });
    const item = (await api("POST", "/shop/items", { url: "https://store.example.com/p/protein" })).body.item;
    expect(item.category).toBe("supplements");
    let r = await api("PATCH", `/shop/items/${item.id}`, { status: "live" });
    expect(r).toMatchObject({ status: 409, body: { code: "supplements_off" } });
    await api("PUT", "/shop/settings", { supplements_opt_in: true });
    r = await api("PATCH", `/shop/items/${item.id}`, { status: "live" });
    expect(r.body.item.status).toBe("live");
  });
});

describe("T5 exclusivity", () => {
  let a: string;
  beforeAll(async () => {
    a = await seedAthlete("Signed");
    const [b] = await db.insert(inboxBrands).values({ name: "Brand Oak", normalized_name: "brand oak", domain: "brandoak.com", category: "footwear" } as any).returning();
    await db.insert(deals).values({ athlete_id: a, brand_name: "Brand Oak", brand_id: b.id, status: "accepted", amount: "1000", raw_data: { contract: { exclusivity: { exists: true, scope: "No competing footwear brands" } } } } as any);
  });
  it("a competitor needs her confirmation, and the confirmation is recorded", async () => {
    await open(a);
    page("https://rival.example.com/p/runner", "Rival Runner");
    judgeAnswers.push({ category: "footwear", brands: [], sponsor: null });
    const item = (await api("POST", "/shop/items", { url: "https://rival.example.com/p/runner" })).body.item;
    judgeAnswers.push({ category: "footwear", brands: [{ name: "Brand Oak", verdict: "competes", why: "rival footwear" }], sponsor: null });
    let r = await api("PATCH", `/shop/items/${item.id}`, { status: "live" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("needs_confirmation");
    expect(r.body.warnings[0]).toMatchObject({ code: "exclusivity", brand: "Brand Oak", scope: "No competing footwear brands" });
    expect(judgeCalls.at(-1)).toContain("Brand Oak");
    judgeAnswers.push({ category: "footwear", brands: [{ name: "Brand Oak", verdict: "competes", why: null }], sponsor: null });
    r = await api("PATCH", `/shop/items/${item.id}`, { status: "live", confirm_warnings: true });
    expect(r.body.item.status).toBe("live");
    const [row] = await db.select().from(shopItems).where(eq(shopItems.id, item.id));
    expect(row.warnings_ack_at).not.toBeNull();
  });
  it("her sponsor's own product is not a competitor (same domain); the model is not even asked about it", async () => {
    await open(a);
    page("https://shop.brandoak.com/p/1", "Oak Trainer");
    judgeAnswers.push({ category: "footwear", brands: [], sponsor: null });
    const r = await api("POST", "/shop/preview", { url: "https://shop.brandoak.com/p/1" });
    expect(r.body.warnings).toEqual([]);
    expect(judgeCalls.at(-1)).not.toContain("Brand Oak");
  });
  it("with the model down, a contract that says exclusivity still warns (never a silent pass)", async () => {
    await open(a);
    page("https://rival.example.com/p/down", "Something");
    judgeAnswers.push(new Error("provider down"));
    const r = await api("POST", "/shop/preview", { url: "https://rival.example.com/p/down" });
    expect(r.body.warnings.map((w: any) => w.code)).toEqual(["exclusivity"]);
  });
});

describe("T6 her school's apparel sponsor", () => {
  it("competing footwear warns with her sponsor's name; nothing in code names one", async () => {
    const a = await seedAthlete("Sponsor");
    await open(a);
    await api("PUT", "/shop/settings", { school_apparel_sponsor: "Sponsor Co" });
    page("https://rival.example.com/p/cleat", "Cleat");
    judgeAnswers.push({ category: "footwear", brands: [], sponsor: { verdict: "competes", why: "rival footwear" } });
    const r = await api("POST", "/shop/preview", { url: "https://rival.example.com/p/cleat" });
    expect(r.body.warnings).toEqual([expect.objectContaining({ code: "school_sponsor", sponsor: "Sponsor Co" })]);
    judgeAnswers.push({ category: "tech", brands: [], sponsor: { verdict: "competes", why: null } });
    page("https://rival.example.com/p/earbuds", "Earbuds");
    expect((await api("POST", "/shop/preview", { url: "https://rival.example.com/p/earbuds" })).body.warnings).toEqual([]);
  });
});

describe("T7 /go/:code and T8 the public read", () => {
  it("a live pick redirects to her link and counts one click; hidden, draft and unknown codes are the same 404", async () => {
    const a = await seedAthlete("Clicks");
    await open(a);
    page("https://www.amazon.com/dp/B0TEST?tag=her-20", "Amazon Thing");
    const live = (await api("POST", "/shop/items", { url: "https://www.amazon.com/dp/B0TEST?tag=her-20" })).body.item;
    expect(live).toMatchObject({ source: "amazon", networkTag: "her-20" });
    await api("PATCH", `/shop/items/${live.id}`, { status: "live", blurb: "I train in these." });
    page("https://store.example.com/p/draft", "Draft");
    const draft = (await api("POST", "/shop/items", { url: "https://store.example.com/p/draft" })).body.item;
    const [{ code }] = await db.select({ code: shopItems.code }).from(shopItems).where(eq(shopItems.id, live.id));
    const [{ code: draftCode }] = await db.select({ code: shopItems.code }).from(shopItems).where(eq(shopItems.id, draft.id));

    const hit = await fetch(`${base}/go/${code}`, { redirect: "manual", headers: { referer: "https://social.example/some/post?u=fan" } });
    expect(hit.status).toBe(302);
    expect(hit.headers.get("location")).toBe("https://www.amazon.com/dp/B0TEST?tag=her-20");
    expect(hit.headers.get("cache-control")).toBe("no-store");
    await fetch(`${base}/go/${code}`, { redirect: "manual" });
    const days = await db.select().from(shopClickDays).where(eq(shopClickDays.item_id, live.id));
    expect(days).toEqual([{ item_id: live.id, day: new Date().toISOString().slice(0, 10), clicks: 2 }]);   // a count — nothing else exists to store
    expect((await api("GET", "/shop")).body.items.find((i: any) => i.id === live.id)).toMatchObject({ clicks7d: 2, clicks30d: 2 });

    for (const miss of [draftCode, "AAAAAAAAAAAA", "short", "AAAA-AAAA-AA"]) {
      const r = await fetch(`${base}/go/${miss}`, { redirect: "manual" });
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
    await api("PATCH", `/shop/items/${live.id}`, { status: "hidden" });
    expect((await fetch(`${base}/go/${code}`, { redirect: "manual" })).status).toBe(404);
    await api("PATCH", `/shop/items/${live.id}`, { status: "live" });

    // T8 the public read
    await db.update(shopItems).set({ blurb_suggestion: "MILA SECRET" }).where(eq(shopItems.id, live.id));
    const pub = (await api("GET", "/shop/public-preview")).body;
    expect(pub.picks).toHaveLength(1);
    expect(pub.picks[0]).toMatchObject({ title: "Amazon Thing", blurb: "I train in these.", disclosure: "Paid link" });
    expect(pub.picks[0].href).toMatch(new RegExp(`/go/${code}$`));
    expect(JSON.stringify(pub)).not.toContain("MILA SECRET");
    expect(JSON.stringify(pub)).not.toContain("tag=her-20");   // her raw link stays behind the redirect
    expect(pub.amazonStatement).toBe("As an Amazon Associate I earn from qualifying purchases.");
  });
});

describe("T9 NIL Go", () => {
  it("adds signed brand deals per brand against $600; college only; says her affiliate income is not counted", async () => {
    const a = await seedAthlete("College");
    await db.update(athletes).set({ division: "D1" } as any).where(eq(athletes.id, a));
    await db.insert(deals).values([
      { athlete_id: a, brand_name: "Maple", status: "accepted", amount: "400" },
      { athlete_id: a, brand_name: "maple ", status: "completed", amount: "250" },
      { athlete_id: a, brand_name: "Birch", status: "accepted", amount: "100" },
      { athlete_id: a, brand_name: "Pine", status: "negotiating", amount: "5000" },
    ] as any);
    as(a);
    const nil = (await api("GET", "/shop")).body.nilGo;
    expect(nil.applies).toBe(true);
    expect(nil.brands).toEqual([
      expect.objectContaining({ totalCents: 65000, deals: 2, reportable: true }),
      expect.objectContaining({ brand: "Birch", totalCents: 10000, reportable: false }),
    ]);
    expect(nil.copy.affiliateNote).toMatch(/not counted/);
    as(a2);
    expect((await api("GET", "/shop")).body.nilGo).toMatchObject({ applies: false, brands: [] });
  });
});

describe("T10 her order and delete", () => {
  it("reorders only with every pick of hers once; delete takes the click days", async () => {
    const a = await seedAthlete("Order");
    as(a);
    page("https://store.example.com/o/1", "One"); page("https://store.example.com/o/2", "Two");
    const one = (await api("POST", "/shop/items", { url: "https://store.example.com/o/1" })).body.item;
    const two = (await api("POST", "/shop/items", { url: "https://store.example.com/o/2" })).body.item;
    expect((await api("POST", "/shop/items/order", { ids: [two.id] })).status).toBe(400);
    const r = await api("POST", "/shop/items/order", { ids: [two.id, one.id] });
    expect(r.body.items.map((i: any) => i.title)).toEqual(["Two", "One"]);
    await db.insert(shopClickDays).values({ item_id: one.id, day: "2026-10-01", clicks: 4 });
    expect((await api("DELETE", `/shop/items/${one.id}`)).status).toBe(204);
    expect(await db.select().from(shopClickDays).where(eq(shopClickDays.item_id, one.id))).toEqual([]);
  });
  it("her line is hers: too long is refused, never trimmed silently", async () => {
    const a = await seedAthlete("Words");
    as(a);
    page("https://store.example.com/w/1", "W");
    const item = (await api("POST", "/shop/items", { url: "https://store.example.com/w/1" })).body.item;
    expect((await api("PATCH", `/shop/items/${item.id}`, { blurb: "x".repeat(281) })).status).toBe(400);
    expect((await api("PATCH", `/shop/items/${item.id}`, { blurb: "My go-to." })).body.item.blurb).toBe("My go-to.");
    expect((await api("PATCH", `/shop/items/${item.id}`, { category: "spaceships" })).status).toBe(400);
  });
});
