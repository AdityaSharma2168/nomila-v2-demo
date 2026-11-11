/**
 * resummarizeOpenOpportunitiesCore — selection follows the board's "open" (status = 'open', member
 * deals of the same athlete, their threads), across athletes. PGlite; nothing reaches a model.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/models", () => ({
  genai: () => { throw new Error("tests must never reach a provider"); },
  GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
  KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
}));

import { deals, inboxBrands, inboxThreads, opportunities } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { selectOpenOpportunityThreads, thirdPersonHits } from "./resummarizeOpenOpportunitiesCore";

const AT = new Date("2026-10-01T00:00:00Z");
const threads: Record<string, string> = {};

async function seed(athleteId: string, name: string, o: { status?: "open" | "closed"; threads?: number; noOpp?: boolean } = {}) {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase() } as any).returning({ id: inboxBrands.id });
  let oppId: string | null = null;
  if (!o.noOpp) {
    const [opp] = await db.insert(opportunities).values({
      athlete_id: athleteId, brand_id: b.id, status: o.status ?? "open", opened_at: AT, last_activity_at: AT,
      ...(o.status === "closed" ? { close_reason: "expired", closed_at: AT } : {}),
    } as any).returning({ id: opportunities.id });
    oppId = opp.id;
  }
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: name, status: "detected", opportunity_id: oppId } as any).returning({ id: deals.id });
  for (let i = 0; i < (o.threads ?? 1); i++) {
    const [t] = await db.insert(inboxThreads).values({
      athlete_id: athleteId, deal_id: d.id, brand_id: b.id, subject: `${name} ${i}`, status: "deal_detected", message_count: 2,
      conversation_state: { conversation_state: `${name} wrote to the athlete.` },
    } as any).returning({ id: inboxThreads.id });
    threads[`${name}${i}`] = t.id;
  }
}

beforeAll(async () => {
  await initTestDb();
  const a = await seedAthlete("Ada Lovelace");
  const b = await seedAthlete("Grace Hopper");
  await seed(a, "OpenCo", { threads: 2 });
  await seed(a, "ClosedCo", { status: "closed" });
  await seed(a, "LooseDeal", { noOpp: true });
  await seed(b, "OtherAthleteCo");
});
afterAll(async () => { await closeTestDb(); });

it("selects every thread behind an open opportunity, for every athlete, and nothing else", async () => {
  const rows = await selectOpenOpportunityThreads();
  expect(rows.map((r) => r.thread_id).sort()).toEqual([threads.OpenCo0, threads.OpenCo1, threads.OtherAthleteCo0].sort());
  const open = rows.find((r) => r.thread_id === threads.OpenCo0)!;
  expect(open).toMatchObject({ brand_name: "OpenCo", athlete_name: "Ada Lovelace", message_count: 2, current_state: "OpenCo wrote to the athlete." });
});

it("flags third-person phrasing and her name, not second person", () => {
  expect(thirdPersonHits("Brand pitched the athlete; Ada hasn't replied.", ["Ada Lovelace"])).toEqual(["the athlete", "Ada"]);
  expect(thirdPersonHits("They want the athlete's rates.", ["Ada Lovelace"])).toEqual(["the athlete", "athlete's"]);
  expect(thirdPersonHits("Brand sent 3 emails; you haven't replied.", ["Ada Lovelace"])).toEqual([]);
  expect(thirdPersonHits(null, ["Ada"])).toEqual([]);
});
