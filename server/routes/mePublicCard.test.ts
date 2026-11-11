/**
 * routes/mePublicCard.test.ts — her public card routes end to end through Express against PGlite (design-public-card-v3
 * §10–§11, PR 2), with the public JSON read and her shelf routes mounted beside them. Made-up athletes in different
 * sports (a rower, a fencer, a climber). The only stand-ins are the auth signature check, the identity / record /
 * M.I.A. reads (their own suites cover them), the bucket signer and the model module the shop routes import —
 * nothing reaches a provider or the network.
 *
 *   M1 auth: every route answers 401 without a session
 *   M2 draft → decisions → preview → publish → the public read serves exactly the preview, approved by her user
 *   M3 tenancy: another athlete never sees, approves or publishes her items; their actions never touch her page
 *   M4 switches: validation; show_mia on → next publish; off → pulled at once; Shop off → picks pulled at once;
 *      indexable read live
 *   M5 handle: reserved / taken (409), once a month (429 + nextChangeAt), the old handle redirects
 *   M6 pulled at once: an undone signed deal (reconcile) and a pick deleted through her shelf route
 *   M7 publish guard: a grid that would repeat a tile → 422 with the plain reason; unpublish → 404; flag off → 404
 */
process.env.PUBLIC_CARD = "true";
process.env.SHOP_V1 = "true";
process.env.BOOKINGS_ENABLED = "true";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const g = globalThis as any;
    if (!g.__TEST_ATHLETE_ID) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.athleteId = g.__TEST_ATHLETE_ID; req.userId = g.__TEST_USER_ID ?? undefined; next();
  },
}));
jest.mock("../lib/rateLimit", () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { publicCardLimiter: pass, shopLinkLimiter: pass, shopRedirectLimiter: pass };
});
jest.mock("../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://storage.googleapis.com/test/${p}`) }));
jest.mock("../lib/models", () => ({ GEMINI: { flashLite: "test-model", flash: "test-model", pro: "test-model" }, genai: () => { throw new Error("no model in this suite"); } }));
// Read seams covered by their own suites: her identity view, her Record, her M.I.A.
const views = new Map<string, unknown>();
const names = new Map<string, { name: string; nickname?: string }>();
jest.mock("../services/intelligence/identityIntelligence/view", () => ({
  buildIdentityIntelligenceView: jest.fn(async (id: string) => views.get(id) ?? require("../testUtils/publicCardFixtures").fakeIdentityView()),
}));
jest.mock("../services/athleteRecord", () => ({
  getAthleteRecord: jest.fn(async (id: string) => {
    const n = names.get(id);
    return n ? { athleteId: id, header: { name: n.name }, groups: n.nickname ? [{ key: "who", title: "", entries: [{ field: "nickname", kind: "said", value: n.nickname }] }] : [] } : null;
  }),
}));
jest.mock("../services/intelligence/views/myIntelligence", () => ({
  buildMyIntelligence: jest.fn(async () => ({ assessment: { score: 68, overall: { level: "MEDIUM" }, evidenceAsOf: "2026-10-01T00:00:00.000Z" } })),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { athletes, connectAccounts, connectedAccounts, deals, inboxBrands, mediaAssets, offers, publicCardSnapshots, shopItems, shopSettings, users } from "../../shared/schema";
import type { PublicCardDraftResponse, PublicCardPage, PublicCardPreviewResponse, PublicCardPublishResponse } from "../../shared/publicCard";
import { closeTestDb, db, initTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { fakeIdentityView } from "../testUtils/publicCardFixtures";
import mePublicCardRouter from "./mePublicCard";
import publicCardRouter from "./publicCard";
import shopRouter from "./shop";
import { reconcilePublishedCard } from "../services/publicCard/reconcile";
import { DUPLICATE_TILES_REASON } from "../services/publicCard/types";
import { opaqueItemKey } from "../services/publicCard/mediaKey";

let server: Server; let base: string;
const g = globalThis as any;
const as = (id: string | null, userId?: string) => { g.__TEST_ATHLETE_ID = id; g.__TEST_USER_ID = userId; };
async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? (undefined as T) : await res.json().catch(() => undefined) };
}
async function pub(handle: string): Promise<{ status: number; body: PublicCardPage; headers: Headers }> {
  const res = await fetch(`${base}/api/public/cards/${handle}`, { redirect: "manual" });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const said = (id: string) => ({ kind: "assertion" as const, id });

let rower: string; let fencer: string; let climber: string; let rowerUser: string;
let rowerDeal: string; let rowerPick: string;

beforeAll(async () => {
  await initTestDb();
  rower = await seedAthlete("Hana Vesely");
  fencer = await seedAthlete("Teo Marchand");
  climber = await seedAthlete("Ama Fenwick");
  names.set(rower, { name: "Hana Vesely" });
  names.set(fencer, { name: "Teo Marchand" });
  names.set(climber, { name: "Ama Fenwick", nickname: "Mae" });
  process.env.BOOKINGS_PILOT_ATHLETE_IDS = rower;
  const [u] = await db.insert(users).values({ provider: "firebase", provider_uid: "uid-rower" }).returning({ id: users.id });
  rowerUser = u.id;
  await db.update(athletes).set({ auth_id: "uid-rower" }).where(eq(athletes.id, rower));

  // The rower: her words, a signed partner, three photos, an offer with payouts ready, a live pick, an Instagram account.
  views.set(rower, fakeIdentityView({
    howToBeUnderstood: { value: "x", said: "I row for the quiet before the race.", basis: [said("a1")] },
    chapters: {
      origin: { text: "Learned to row on a reservoir club's spare boat.", basis: [{ kind: "fact", id: "f1" }], strength: "reported" },
      rise: { text: "Moved from the novice eight to single sculls in a season.", basis: [{ kind: "fact", id: "f2" }], strength: "reported" },
      defining: null, now: null, next: null,
    },
    causes: [{ text: "Free learn-to-row days", basis: [said("a2")], strength: "established" }],
    audience: { measured: { platforms: [{ platform: "instagram", followers: 9100, engagementPerFollower: null, topGeographies: [], age: [], gender: [], basis: [{ kind: "social_feature", key: "instagram.followers_latest" }] }] } },
  }));
  const [brand] = await db.insert(inboxBrands).values({ name: "Example Oars", normalized_name: "example oars" } as any).returning({ id: inboxBrands.id });
  const [d] = await db.insert(deals).values({ athlete_id: rower, brand_name: "Example Oars", brand_id: brand.id, status: "accepted", signed_at: new Date("2026-03-04T00:00:00Z"), signed_source: "confirmed" } as any).returning({ id: deals.id });
  rowerDeal = d.id;
  for (const n of [1, 2, 3]) {
    await db.insert(mediaAssets).values({ athlete_id: rower, platform: "upload", origin: "upload", media_type: "IMAGE", status: "stored", gcs_path: `athletes/${rower}/uploads/p${n}.jpg`, content_type: "image/jpeg", posted_at: new Date(`2026-0${n}-01T00:00:00Z`) } as any);
  }
  await db.insert(offers).values({ athlete_id: rower, public_id: "rowcall1", format: "video_call", title: "Technique call", price_cents: 15000, duration_minutes: 30, location_mode: "virtual", status: "published" } as any);
  await db.insert(connectAccounts).values({ athlete_id: rower, stripe_account_id: "acct_test_rower", payouts_enabled: true, charges_enabled: true } as any);
  await db.insert(shopSettings).values({ athlete_id: rower, adult_confirmed_at: new Date(), international_student: false });
  const [p] = await db.insert(shopItems).values({ athlete_id: rower, code: "rowpick00001", url: "https://shop.example/gloves", url_host: "shop.example", source: "link", title: "Rowing gloves", status: "live", blurb: "Saved my hands all winter." } as any).returning({ id: shopItems.id });
  rowerPick = p.id;
  const ig = await seedConnection({ athleteId: rower, platform: "instagram" });
  await db.update(connectedAccounts).set({ platform_username: "example.hana" }).where(eq(connectedAccounts.id, ig));

  // The fencer: one proof point she said, nothing else.
  views.set(fencer, fakeIdentityView({ proofPoints: [{ key: "p1", kind: "honour", text: "National junior épée finalist", basis: [said("b1")], strength: "established", asOf: "2025-05-01" }] }));

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", mePublicCardRouter);
  app.use("/api/v1/me", shopRouter);
  app.use(publicCardRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await closeTestDb(); });
beforeEach(() => { process.env.PUBLIC_CARD = "true"; as(null); });

it("M1 every route needs her session", async () => {
  for (const [m, path] of [["GET", "/public-card/draft"], ["PUT", "/public-card/draft"], ["GET", "/public-card/preview"], ["POST", "/public-card/publish"],
    ["POST", "/public-card/unpublish"], ["PATCH", "/public-card/switches"], ["PUT", "/public-card/handle"]] as const) {
    expect((await api(m, path, m === "GET" ? undefined : {})).status).toBe(401);
  }
});

it("M2 draft → decisions → preview → publish; the public read serves exactly the preview", async () => {
  as(rower, rowerUser);
  // Book and Shop wait until she turns them on
  let r = await api<PublicCardDraftResponse>("GET", "/public-card/draft");
  expect(r.status).toBe(200);
  expect(r.body.card).toMatchObject({ handle: null, status: "draft", switches: { partner: true, book: false, shop: false, create: true, askMila: true, showMia: false, indexable: false } });
  expect(r.body.availability).toEqual({ book: true, shop: true });
  const byKey = new Map([...r.body.chapters.flatMap((c) => c.items), ...r.body.offers, ...r.body.picks].map((i) => [i.key, i]));
  expect(byKey.get(opaqueItemKey(rower, `partner:${rowerDeal}`))).toMatchObject({ basis: "proof", state: "proposed", publishable: false, blockedBy: "needs_approval", sources: [{ kind: "deal", id: rowerDeal }] });
  expect(byKey.get("story.origin")).toMatchObject({ basis: "made", blockedBy: "needs_approval" });
  // her "how to be understood" words are a note to Mila: never a line on her page
  expect(byKey.get("hl.identity:said")).toBeUndefined();
  expect(JSON.stringify(r.body)).not.toContain("I row for the quiet");
  expect(byKey.get("offer:rowcall1")).toMatchObject({ totalCents: expect.any(Number), priceCents: 15000 });
  expect(r.body.canPublish).toBe(true);

  // her decisions: the partner, three photos, both beats (exact text), the stat; then Book and Shop on
  const media = r.body.chapters.find((c) => c.key === "media")!.items.map((i) => i.key);
  expect(media).toHaveLength(3);
  const story = r.body.chapters.find((c) => c.key === "story")!.items;
  const decisions = { items: Object.fromEntries([
    [opaqueItemKey(rower, `partner:${rowerDeal}`), { state: "approved" }], ["hl.stat:instagram.followers", { state: "approved" }],
    ...media.map((k) => [k, { state: "approved" }]),
    ...story.map((b) => [b.key, { state: "approved", textHash: b.textHash }]),
  ]) };
  expect((await api("PUT", "/public-card/draft", { items: { bad: { state: "maybe" } } })).status).toBe(400);
  r = await api<PublicCardDraftResponse>("PUT", "/public-card/draft", decisions);
  expect(r.status).toBe(200);
  expect(r.body.chapters.map((c) => [c.key, c.meetsMinimum])).toEqual(expect.arrayContaining([["story", true], ["media", true], ["partnerships", true], ["impact", true]]));
  expect((await api("PATCH", "/public-card/switches", { book: true, shop: true })).body).toMatchObject({ switches: { book: true, shop: true }, removalVersion: null });

  const preview = await api<PublicCardPreviewResponse>("GET", "/public-card/preview");
  expect(preview.status).toBe(200);
  const c = preview.body.content;
  expect(c.chapters.map((ch) => ch.key)).toEqual(["highlights", "story", "partnerships", "media", "impact"]);
  expect(c.tiles.map((t) => t.intent)).toEqual(["partner", "book", "shop", "create"]);
  expect(c.offers.map((o) => o.key)).toEqual(["offer:rowcall1"]);
  expect(c.picks.map((p) => [p.key, p.blurb])).toEqual([["pick:rowpick00001", "Saved my hands all winter."]]);
  expect(c.socials).toEqual([{ network: "Instagram", url: "https://www.instagram.com/example.hana", handle: "example.hana" }]);
  expect(c.verified).toBe(true);
  expect(c.mia).toBeNull();
  // no internal id, bucket path or account reference anywhere in what goes public
  const raw = JSON.stringify(c);
  for (const secret of [rower, rowerDeal, rowerPick, "athletes/", "acct_", "assertion", "social_feature"]) expect(raw).not.toContain(secret);

  const p = await api<PublicCardPublishResponse>("POST", "/public-card/publish");
  expect(p.status).toBe(200);
  expect(p.body).toMatchObject({ version: 1, handle: "hana-vesely" });
  expect(p.body.page.content).toEqual(c);
  const live = await pub("hana-vesely");
  expect(live.status).toBe(200);
  expect(live.body).toEqual(p.body.page);
  const [snap] = await db.select().from(publicCardSnapshots).where(eq(publicCardSnapshots.athlete_id, rower));
  expect(snap).toMatchObject({ version: 1, kind: "full", approved_by_user_id: rowerUser });
  expect(Object.keys(snap.media as object)).toHaveLength(3);
});

it("M3 another athlete never sees, approves or publishes her items, and never touches her page", async () => {
  as(fencer);
  const r = await api<PublicCardDraftResponse>("GET", "/public-card/draft");
  expect(JSON.stringify(r.body)).not.toMatch(/Example Oars|rowcall1|rowpick|Hana|example\.hana/);
  // approving the rower's partner key from the fencer's session does nothing for anyone
  await api("PUT", "/public-card/draft", { items: { [opaqueItemKey(rower, `partner:${rowerDeal}`)]: { state: "approved" } } });
  const p = await api<PublicCardPublishResponse>("POST", "/public-card/publish");
  expect(p.status).toBe(200);
  expect(p.body.handle).toBe("teo-marchand");
  expect(JSON.stringify(p.body.page)).not.toMatch(/Example Oars|Hana/);
  expect(p.body.page.content.chapters.map((c) => c.key)).toEqual(["highlights", "competition"]);
  await api("POST", "/public-card/unpublish");
  await api("PATCH", "/public-card/switches", { partner: false });
  const rowerPage = await pub("hana-vesely");
  expect(rowerPage.status).toBe(200);
  expect(rowerPage.body.status === "ok" && rowerPage.body.version).toBe(1);
  expect(rowerPage.body.status === "ok" && rowerPage.body.content.doors.partner).toBe(true);
});

it("M4 switches: validated; show_mia on waits for publish, off pulls at once; Shop off pulls picks; indexable is live", async () => {
  as(rower, rowerUser);
  expect((await api("PATCH", "/public-card/switches", {})).status).toBe(400);
  expect((await api("PATCH", "/public-card/switches", { partner: "yes" })).status).toBe(400);
  expect((await api("PATCH", "/public-card/switches", { door_partner: false })).status).toBe(400);

  expect((await api("PATCH", "/public-card/switches", { showMia: true })).body.removalVersion).toBeNull();
  let live = await pub("hana-vesely");
  expect(live.body.status === "ok" && live.body.content.mia).toBeNull();        // not until she publishes
  const p = await api<PublicCardPublishResponse>("POST", "/public-card/publish");
  expect(p.body.page.content.mia).toEqual({ score: 68, band: "MEDIUM", asOf: "2026-10-01T00:00:00.000Z" });
  const off = await api("PATCH", "/public-card/switches", { showMia: false });
  expect(off.body.removalVersion).toBe(p.body.version + 1);
  live = await pub("hana-vesely");
  expect(live.body.status === "ok" && live.body.content.mia).toBeNull();

  const shopOff = await api("PATCH", "/public-card/switches", { shop: false });
  expect(shopOff.body.removalVersion).toBeGreaterThan(off.body.removalVersion);
  live = await pub("hana-vesely");
  if (live.body.status !== "ok") throw new Error("not ok");
  expect(live.body.content.picks).toEqual([]);
  expect(live.body.content.tiles[2].intent).not.toBe("shop");
  const [note] = await db.select({ note: publicCardSnapshots.note }).from(publicCardSnapshots).where(eq(publicCardSnapshots.version, shopOff.body.removalVersion));
  expect(note.note).toMatch(/switched this off/);

  expect(live.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  await api("PATCH", "/public-card/switches", { indexable: true, shop: true });
  expect((await pub("hana-vesely")).headers.get("x-robots-tag")).toBeNull();
  await api("POST", "/public-card/publish");   // Shop back on: only a new publish brings it back
  live = await pub("hana-vesely");
  expect(live.body.status === "ok" && live.body.content.picks.length).toBe(1);
});

it("M5 handle rules through the route", async () => {
  as(fencer);
  expect((await api("PUT", "/public-card/handle", { handle: "admin" })).body).toMatchObject({ code: "reserved" });
  expect((await api("PUT", "/public-card/handle", { handle: "hana-vesely" }))).toMatchObject({ status: 409, body: { code: "taken" } });
  expect((await api("PUT", "/public-card/handle", { handle: "x!" }))).toMatchObject({ status: 422, body: { code: "invalid" } });
  expect((await api("PUT", "/public-card/handle", { handle: 7 })).status).toBe(400);
  as(rower, rowerUser);
  const ok = await api("PUT", "/public-card/handle", { handle: "hana-rows" });
  expect(ok).toMatchObject({ status: 200, body: { handle: "hana-rows", handleChangeAvailableAt: expect.any(String) } });
  const soon = await api("PUT", "/public-card/handle", { handle: "hana-v" });
  expect(soon).toMatchObject({ status: 429, body: { code: "too_soon", nextChangeAt: ok.body.handleChangeAvailableAt } });
  const old = await pub("hana-vesely");
  expect(old).toMatchObject({ status: 301, body: { status: "redirect", to: "hana-rows" } });
});

it("M6 pulled at once: an undone signed deal and a pick deleted through her shelf", async () => {
  as(rower, rowerUser);
  let live = await pub("hana-rows");
  if (live.body.status !== "ok") throw new Error("not ok");
  const before = live.body.version;
  expect(live.body.content.chapters.some((c) => c.key === "partnerships")).toBe(true);

  await db.update(deals).set({ signed_at: null, signed_source: null }).where(eq(deals.id, rowerDeal));
  expect(await reconcilePublishedCard(rower, "You marked a deal as not signed.")).toBe(before + 1);
  live = await pub("hana-rows");
  if (live.body.status !== "ok") throw new Error("not ok");
  expect(live.body.content.chapters.some((c) => c.key === "partnerships")).toBe(false);
  expect(JSON.stringify(live.body)).not.toContain("Example Oars");

  // her shelf route: deleting her only pick pulls it and closes Shop on the live page
  expect((await api("DELETE", `/shop/items/${rowerPick}`)).status).toBe(204);
  live = await pub("hana-rows");
  if (live.body.status !== "ok") throw new Error("not ok");
  expect(live.body.version).toBe(before + 2);
  expect(live.body.content.picks).toEqual([]);
  expect(live.body.content.doors.shop).toBe(false);
  // nothing else to pull: no new version
  expect(await reconcilePublishedCard(rower, "again")).toBeNull();
  // another athlete's reconcile never touches her page
  expect(await reconcilePublishedCard(fencer, "x")).toBeNull();
});

it("M7 the grid guard, unpublish, and the flag", async () => {
  as(climber);
  await api("PATCH", "/public-card/switches", { partner: false });
  const d = await api<PublicCardDraftResponse>("GET", "/public-card/draft");
  expect(d.body).toMatchObject({ canPublish: false, blockedReason: DUPLICATE_TILES_REASON });
  expect(await api("POST", "/public-card/publish")).toMatchObject({ status: 422, body: { code: "invalid", error: DUPLICATE_TILES_REASON } });
  await api("PATCH", "/public-card/switches", { partner: true });
  const p = await api<PublicCardPublishResponse>("POST", "/public-card/publish");
  expect(p.body.page.content).toMatchObject({ firstName: "Mae", lastName: "Fenwick" });

  as(rower, rowerUser);
  expect((await api("POST", "/public-card/unpublish")).body).toEqual({ unpublished: true });
  expect((await pub("hana-rows")).status).toBe(404);
  expect((await api("POST", "/public-card/unpublish")).body).toEqual({ unpublished: false });
  process.env.PUBLIC_CARD = "false";
  expect(await api("GET", "/public-card/draft")).toMatchObject({ status: 404, body: { code: "disabled" } });
  expect((await pub("mae-fenwick")).status).toBe(404);
});
