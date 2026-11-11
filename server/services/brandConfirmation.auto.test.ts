/**
 * autoConfirmBrand against PGlite: strong evidence settles who a brand is without asking her; weak evidence, an
 * unverifiable sender or her "Not this brand" never does; and "Not this brand" undoes a system settlement.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { inboxBrands, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { autoConfirmBrand, rejectBrandCandidate } from "./brandConfirmation";
import { identitySettled } from "../lib/brandIdentity";

const NOW = new Date("2026-10-22T12:00:00Z");
let athleteId = "";

const candidate = (domain: string, evidence: string, source = "web_search_verified") =>
  ({ candidate: { domain, name: "x", source, proposed_at: "2026-10-20T00:00:00Z", confidence: "high", evidence } });

async function brand(name: string, o: { domain?: string; enrichment?: unknown; channel?: string } = {}): Promise<number> {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase(), domain: o.domain ?? null, enrichment: o.enrichment ?? null } as any).returning({ id: inboxBrands.id });
  await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: NOW, last_activity_at: NOW } as any);
  await db.insert(inboxThreads).values({ athlete_id: athleteId, brand_id: b.id, subject: name, status: "deal_detected", classification: { channel: o.channel ?? "agency" } } as any);
  return b.id;
}
const row = async (id: number) => (await db.select().from(inboxBrands).where(eq(inboxBrands.id, id)))[0];

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete(); });
afterAll(async () => { await closeTestDb(); });

it("a verified official site settles the brand and fills its domain; Not this brand undoes both", async () => {
  const id = await brand("Remedy Organics", { enrichment: candidate("remedyorganics.com", "homepage: Remedy Organics") });
  expect(await autoConfirmBrand(id, NOW)).toEqual({ confirmed: true, domain: "remedyorganics.com", basis: "verified_official_site", filled: true });
  let r = await row(id);
  expect(r.domain).toBe("remedyorganics.com");
  expect(identitySettled(r.enrichment)).toBe(true);
  expect(await autoConfirmBrand(id, NOW)).toEqual({ confirmed: false, reason: "already_settled" });

  expect((await rejectBrandCandidate(athleteId, id, "remedyorganics.com")).ok).toBe(true);
  r = await row(id);
  expect(r.domain).toBeNull();
  expect(identitySettled(r.enrichment)).toBe(false);
  // Her "not this" stands: the system never re-settles that domain.
  await db.update(inboxBrands).set({ enrichment: candidate("remedyorganics.com", "homepage: Remedy Organics") } as any).where(eq(inboxBrands.id, id));
  expect(await autoConfirmBrand(id, NOW)).toEqual({ confirmed: false, reason: "rejected_by_athlete" });
});

it("the brand's own email domain settles it; weak evidence and an unverifiable sender do not", async () => {
  const own = await brand("StartXYZ", { domain: "startxyz.com", channel: "direct" });
  expect(await autoConfirmBrand(own, NOW)).toMatchObject({ confirmed: true, basis: "sender_domain", filled: false });
  const weak = await brand("Chevy", { enrichment: candidate("chevrolet.com", "homepage: Chevy", "name_search") });
  expect(await autoConfirmBrand(weak, NOW)).toEqual({ confirmed: false, reason: "weak_evidence" });
  const other = await brand("Insight Co", { enrichment: candidate("insightco.ai", "homepage: Agentic Phone") });
  expect(await autoConfirmBrand(other, NOW)).toEqual({ confirmed: false, reason: "weak_evidence" });
  const scam = await brand("Jaambu Co", { channel: "unverifiable", enrichment: candidate("jaambuco.com", "homepage: Jaambu Co") });
  expect(await autoConfirmBrand(scam, NOW)).toEqual({ confirmed: false, reason: "unverifiable_sender" });
  expect((await row(scam)).domain).toBeNull();
});
