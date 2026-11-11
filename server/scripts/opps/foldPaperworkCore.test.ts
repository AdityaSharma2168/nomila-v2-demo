/**
 * foldPaperworkCore — the gorjana data fix, against PGlite: the plan is read-only; apply folds pre-#777 e-sign
 * pseudo-deals into paperwork markers on the REAL deal (prior values kept), splits the folded-in chain through the
 * governed split, never marks anything signed, and leaves the brand page right (one real deal + paperwork, then
 * the pitch as its own section). No provider is reached.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));

import { eq } from "drizzle-orm";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { applyFold, planFold, renderFold } from "./foldPaperworkCore";
import { readSigning } from "../../skills/dealSigning";

let athleteId = "";
let oppId = "";
let realDeal = "";
const pseudo: string[] = [];

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  const [b] = await db.insert(inboxBrands).values({ name: "gorjana", normalized_name: "gorjana" } as any).returning({ id: inboxBrands.id });
  const at = new Date("2026-07-29T00:00:00Z");
  const [o] = await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
  oppId = o.id;
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_id: b.id, brand_name: "gorjana", status: "accepted", opportunity_id: o.id } as any).returning({ id: deals.id });
  realDeal = d.id;
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: d.id, brand_id: b.id, status: "deal_detected", message_count: 3, external_thread_id: "19fac",
    alias_thread_ids: ["1a10dc60"], classification: { category: "PAID" } } as any).returning({ id: inboxThreads.id });
  for (const [dir, g, when] of [["inbound", "19fac", "2026-07-29"], ["outbound", "1a10dc60", "2026-10-05"], ["inbound", "1a10dc60", "2026-10-06"]] as const) {
    await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: dir, gmail_thread_id: g, received_at: new Date(when) } as any);
  }
  for (const [stage, summary] of [["signed", "Completed: agreement signed"], [null, "Signature requested"]] as const) {
    const [p] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "gorjana", status: "detected", opportunity_id: o.id, deal_group_id: o.id } as any).returning({ id: deals.id });
    await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: p.id, status: "archived", message_count: 1, summary,
      classification: { category: "PAID", brand_domain: "adobesign.com" }, conversation_state: stage ? { deal_stage: stage } : {} } as any);
    pseudo.push(p.id);
  }
});
afterAll(async () => { await closeTestDb(); });

it("plans without writing; apply folds the pseudo-deals onto the real deal, splits the chain, and never signs", async () => {
  const plan = await planFold(db, athleteId, { splitChain: "1a10dc60" });
  expect(plan.folds.map((f) => f.target_deal_id)).toEqual([realDeal, realDeal]);
  expect(plan.folds.map((f) => f.event).sort()).toEqual(["completed", "signature_requested"]);
  expect(plan.split).toMatchObject({ deal_id: realDeal, chain: "1a10dc60", messages: 2, first_direction: "outbound" });
  expect(renderFold(plan, "dry-run")).toMatch(/Pitched by you/);
  const [untouched] = await db.select().from(deals).where(eq(deals.id, pseudo[0]));
  expect(untouched.status).toBe("detected");

  const done = await applyFold(db, plan);
  expect((done.applied!.split as any).ok).toBe(true);
  for (const id of pseudo) {
    const [d] = await db.select().from(deals).where(eq(deals.id, id));
    expect(d).toMatchObject({ status: "rejected", opportunity_id: null, deal_group_id: null });
    expect((d.raw_data as any).retired).toMatchObject({ as: "paperwork", target_deal_id: realDeal });
  }
  const s = await readSigning(athleteId, oppId);
  expect(s.signed).toBeNull();
  expect(s.looks_signed).toBe(true);
  expect(s.evidence.map((e) => e.kind)).toEqual(["paperwork"]);
  const [real] = await db.select().from(deals).where(eq(deals.id, realDeal));
  expect(real.signed_at).toBeNull();
});
