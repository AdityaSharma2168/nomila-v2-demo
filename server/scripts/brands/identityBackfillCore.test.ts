/**
 * identityBackfillCore — the brand-identity backfill against PGlite. The search is a stub (no provider).
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { inboxBrands, opportunities } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { applyPlan, brandsInScope, planIdentity, renderPlan } from "./identityBackfillCore";
import { storeUnconfirmed } from "../../skills/researchBrand";

jest.mock("../../lib/models", () => ({ genai: () => ({ models: { generateContent: jest.fn() } }), GEMINI: { flash: "x" } }));
jest.mock("../../lib/kimi", () => ({ kimiInstant: jest.fn() }));

const NOW = new Date("2026-10-06T12:00:00Z");
const ids: Record<string, number> = {};

beforeAll(async () => {
  await initTestDb();
  const athlete = await seedAthlete();
  const mk = async (name: string, domain: string | null, extra: Record<string, unknown> = {}, open = true) => {
    const [b] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase(), domain, ...extra } as any).returning({ id: inboxBrands.id });
    ids[name] = b.id;
    await db.insert(opportunities).values({ athlete_id: athlete, brand_id: b.id, status: open ? "open" : "closed",
      ...(open ? {} : { close_reason: "expired", closed_at: NOW }), opened_at: NOW, last_activity_at: NOW } as any);
  };
  const profile = { description: "Profile.", brand_tier: "established", audience_summary: "Aud", image_url: "https://img/x.jpg", enrichment: { industry: "Tech" }, enriched_at: NOW };
  await mk("Mpg", "mpgummies.com", profile);
  await mk("Startx1", "startx1.com", profile);
  await mk("Stan Eats", null, profile);
  await mk("Plain", "plain.example");
  await mk("Closed Only", "closed.example", profile, false);
  await mk("An Agency", "agency.example", { is_agency: true });
});
afterAll(async () => { await closeTestDb(); });

const search = async (_name: string, domain: string) =>
  domain === "mpgummies.com" ? [{ hosts: ["mpgummies.com", "wikipedia.org"] }] : [{ hosts: ["startx.com"] }];

it("plans only brands behind open opportunities, agencies excluded, and never searches without a domain", async () => {
  const rows = await brandsInScope(db);
  expect(rows.map((r) => r.name).sort()).toEqual(["Mpg", "Plain", "Stan Eats", "Startx1"]);
  const calls: string[] = [];
  const plan = await planIdentity(rows, async (n, d) => { calls.push(d); return search(n, d); }, NOW);
  expect(calls.sort()).toEqual(["mpgummies.com", "plain.example", "startx1.com"]);
  const by = Object.fromEntries(plan.map((p) => [p.brand, p]));
  expect(by["Mpg"]).toMatchObject({ domain_evidence: "mpgummies.com", own_domain_sources: ["mpgummies.com"], old_profile: "kept", proposed: "confirmed" });
  expect(by["Startx1"]).toMatchObject({ domain_evidence: "startx1.com", own_domain_sources: [], old_profile: "cleared", proposed: "unconfirmed" });
  expect(by["Stan Eats"]).toMatchObject({ domain_evidence: null, old_profile: "cleared", proposed: "unconfirmed" });
  expect(by["Plain"]).toMatchObject({ old_profile: "nothing stored", proposed: "unconfirmed" });
  expect(renderPlan(plan)).toContain("| Startx1 (#");
});

it("applies exactly the plan: confirmed keeps its profile, unconfirmed is cleared, changed rows are skipped", async () => {
  const plan = await planIdentity(await brandsInScope(db), search, NOW);
  // Plain changes after the plan was reviewed.
  await db.update(inboxBrands).set({ domain: "plain-new.example" }).where(eq(inboxBrands.id, ids["Plain"]));
  const r = await applyPlan(db, plan, storeUnconfirmed);
  expect(r.applied).toBe(3);
  expect(r.skipped).toEqual([{ brand_id: ids["Plain"], brand: "Plain", why: "changed since the reviewed plan" }]);
  const row = async (n: string) => (await db.select().from(inboxBrands).where(eq(inboxBrands.id, ids[n])))[0];
  expect(await row("Mpg")).toMatchObject({ brand_tier: "established", image_url: "https://img/x.jpg" });
  expect(((await row("Mpg")).enrichment as any)).toMatchObject({ industry: "Tech", identity: { status: "confirmed" } });
  expect(await row("Startx1")).toMatchObject({ brand_tier: null, description: null, image_url: null });
  expect(((await row("Startx1")).enrichment as any).identity.status).toBe("unconfirmed");
  expect((await row("Stan Eats")).description).toBeNull();
});
