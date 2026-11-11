/**
 * The board shows the REAL stage (deals.status), never the summarizer's observed stage (owner, 22 Oct 2026): a deal the
 * summarizer reads as "negotiating" while she has sent nothing stays a new opportunity, with the money and the ask on
 * its line, until she acts.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { readOpportunityBoard } from "./opportunityBoard";

const NOW = new Date("2026-10-22T12:00:00Z");
let athleteId = "";

async function seed(name: string, o: { dealStatus: string; observed: string; outbound?: boolean }) {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase() } as any).returning({ id: inboxBrands.id });
  const at = new Date("2026-10-20T12:00:00Z");
  const [opp] = await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: name, status: o.dealStatus, opportunity_id: opp.id, amount_cash: 625 } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, brand_id: b.id, subject: `${name} subject`, status: "deal_detected",
    classification: { qualification: "workable", channel: "agency", agency_name: "Golden", qualification_reason: "Terms are stated (cash)" },
    conversation_state: { deal_stage: o.observed, key_details: { ask: "1 Instagram Reel + reposting to TikTok.", awaiting_response_from: "athlete", offer_struct: { amount: 625, unit: "total" } } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, opp.id));
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", received_at: at } as any);
  if (o.outbound) await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "outbound", received_at: at } as any);
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  await seed("Remedy", { dealStatus: "detected", observed: "negotiating" });
  await seed("Worked", { dealStatus: "negotiating", observed: "outreach", outbound: true });
});
afterAll(async () => { await closeTestDb(); });

it("reads deals.status, not the observed stage, for the card's stage and section", async () => {
  const b = await readOpportunityBoard(athleteId, NOW);
  const all = [...b.needsYou, ...b.inMotion, ...b.explore, ...b.needsTermsBatch, ...b.toVerify];
  const remedy = all.find((i) => i.brand.name === "Remedy")!;
  expect(remedy.stage ?? null).toBeNull();
  expect(remedy.line).toBe("$625 · 1 Instagram Reel + reposting to TikTok · Waiting on you since Oct 20");
  expect(remedy.line).not.toMatch(/Negotiating/);
  expect(remedy.via).toBe("Golden");
  // A real status move (her reply, an approved action) does show.
  const worked = all.find((i) => i.brand.name === "Worked")!;
  expect(worked.stage).toBe("Negotiating");
  expect(worked.line).toContain("Negotiating");
});
