/**
 * disclosure.db.test.ts — the athlete's material connections on the real tables (agent/postKit/disclosure.ts
 * dbMaterialConnections), on PGlite. Made-up athletes and brands only.
 *
 *   D1 deals: accepted, completed with its term running, or signed → a connection (paid "deal", product-only "gift",
 *      commission-only "affiliate"); proposed, rejected or finished deals are not; another athlete's never
 *   D2 shop links: a live one with a merchant is an affiliate connection, with its discount code; a draft is not
 *   D3 disclosureFor on what was read: a match is "required" (with the code), a named brand without one is "ask"
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { deals, shopItems } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dbMaterialConnections, disclosureFor } from "./disclosure";

let A = "";
let B = "";
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Pat Example");
  B = await seedAthlete("Rival Private");
  await db.insert(deals).values([
    { athlete_id: A, brand_name: "Paid Co", status: "accepted", amount_cash: "500" },
    { athlete_id: A, brand_name: "Gift Co", status: "completed", term_end: day(30), amount_product: "80" },
    { athlete_id: A, brand_name: "Commission Co", status: "accepted", commission_pct: "10" },
    { athlete_id: A, brand_name: "Signed Co", status: "negotiating", signed_at: new Date(), signed_source: "confirmed" },
    { athlete_id: A, brand_name: "Talking Co", status: "negotiating" },
    { athlete_id: A, brand_name: "Ended Co", status: "completed", term_end: day(-30) },
    { athlete_id: A, brand_name: "Rejected Co", status: "rejected" },
    { athlete_id: B, brand_name: "Theirs Co", status: "accepted" },
  ] as any);
  await db.insert(shopItems).values([
    { athlete_id: A, code: "DISCLOSE0001", url: "https://shop.example.com/1", url_host: "shop.example.com", source: "link", title: "Shoes", merchant: "Shoe Co", discount_code: "run10", status: "live" },
    { athlete_id: A, code: "DISCLOSE0002", url: "https://shop.example.com/2", url_host: "shop.example.com", source: "link", title: "Draft", merchant: "Draft Co", status: "draft" },
  ] as any);
}, 60_000);
afterAll(async () => { await closeTestDb(); });

test("D1 + D2: only real, current connections of this athlete's — with their kind and codes", async () => {
  const got = await dbMaterialConnections(A);
  expect(got.map((c) => [c.brand, c.kind, c.codes]).sort()).toEqual([
    ["Commission Co", "affiliate", []],
    ["Gift Co", "gift", []],
    ["Paid Co", "deal", []],
    ["Shoe Co", "affiliate", ["RUN10"]],
    ["Signed Co", "deal", []],
  ]);
  // Each carries its own record (what a sponsored rights confirmation is keyed on) and when it was made.
  for (const c of got) {
    expect(c.ref).toMatch(c.brand === "Shoe Co" ? /^shop:[0-9a-f-]{36}$/ : /^deal:[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(c.since ?? ""))).toBe(true);
  }
  expect(new Set(got.map((c) => c.ref)).size).toBe(got.length);
});

test("D3: disclosure from what was read", async () => {
  const got = await dbMaterialConnections(A);
  expect(disclosureFor({ subjectKind: "brand", name: "shoe co" }, got)).toEqual({ need: "required", codes: ["RUN10"] });
  expect(disclosureFor({ subjectKind: "brand", name: "Talking Co" }, got)).toEqual({ need: "ask", codes: [] });
  expect(disclosureFor({ subjectKind: "brand", name: "Theirs Co" }, got)).toEqual({ need: "ask", codes: [] });
});
