/**
 * opportunityBoard — one card per brand speaks for its OPEN opportunity, against PGlite. A brand with a running-won
 * engagement (signed, still delivering) and an open one gets one card: the open one's line, state and whose move. The
 * signed deal's stale "waiting on you" never makes the brand's card hers.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { readOpportunityBoard } from "./opportunityBoard";

const NOW = new Date("2026-10-13T12:00:00Z");
let athleteId = "";
let brandId = 0;
const ids: Record<string, string> = {};

async function opp(key: string, o: { won: boolean; awaiting: string; read: string; lastIn: string }) {
  const at = new Date(o.lastIn);
  const [row] = await db.insert(opportunities).values({
    athlete_id: athleteId, brand_id: brandId, status: o.won ? "closed" : "open", opened_at: at, last_activity_at: at,
    ...(o.won ? { close_reason: "won", closed_at: new Date("2026-10-12") } : {}),
  } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_name: "Acme", status: o.won ? "accepted" : "detected", opportunity_id: row.id,
    ...(o.won ? { signed_at: new Date("2026-10-12"), signed_source: "confirmed" } : {}),
  } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, brand_id: brandId, subject: `${key} subject`, status: "deal_detected",
    classification: { qualification: "needs_terms", channel: "direct" },
    conversation_state: { conversation_state: o.read, key_details: { awaiting_response_from: o.awaiting } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(require("drizzle-orm").eq(opportunities.id, row.id));
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", received_at: at } as any);
  ids[key] = row.id;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  const [b] = await db.insert(inboxBrands).values({ name: "Acme", normalized_name: "acme" } as any).returning({ id: inboxBrands.id });
  brandId = b.id;
  // The signed engagement still reads "waiting on you" from before the call; the open one waits on the brand.
  await opp("won", { won: true, awaiting: "athlete", read: "They agreed to a call next Monday.", lastIn: "2026-09-30" });
  await opp("open", { won: false, awaiting: "brand", read: "You followed up after the call; they haven't replied.", lastIn: "2026-10-08" });
});
afterAll(async () => { await closeTestDb(); });

it("shows one card for the brand, speaking for the open opportunity and folding the signed one in", async () => {
  const b = await readOpportunityBoard(athleteId, NOW);
  // Every card on the board, from every section (a card may sit in more than one: What matters is part of Needs you).
  const all = new Map<string, any>();
  for (const v of Object.values(b)) if (Array.isArray(v)) for (const i of v) if (i && typeof i === "object" && i.brand) all.set(i.opportunity_id, i);
  const cards = [...all.values()].filter((i: any) => i.brand.name === "Acme");
  expect(cards).toHaveLength(1);
  const card = cards[0] as any;
  expect(card.opportunity_id).toBe(ids.open);
  expect(card.brand_opportunity_ids).toEqual(expect.arrayContaining([ids.open, ids.won]));
  // The open opportunity waits on the brand, so the brand is not "needs you" because of the signed deal's old line.
  expect(b.needsYou.map((i: any) => i.brand.name)).not.toContain("Acme");
});
