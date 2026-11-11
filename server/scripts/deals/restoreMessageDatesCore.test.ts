/**
 * restoreMessageDatesCore — against PGlite. A thread re-stamped with a processing time and an opportunity left with
 * the newest date of a chain that was split away are planned (dry run, under a READ-ONLY session: nothing written)
 * and restored from the messages' own dates on --apply, for the selected athlete only. Rows within the ingest-lag
 * tolerance, and rows with no message, are left alone. A re-run plans nothing. No model is called.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { deals, inboxMessages, inboxThreads, opportunities } from "../../../shared/schema";
import { db, client, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { applyRestore, planRestore, renderMarkdown } from "./restoreMessageDatesCore";

const STAMP = new Date("2026-10-08T03:28:52.063Z");   // the processing time a re-process wrote
let athleteId = "";
let otherAthlete = "";

async function engagement(who: string, o: { threadAt: Date; oppAt: Date; messages: string[]; paperwork?: string }) {
  const first = new Date(o.messages[0]);
  const [opp] = await db.insert(opportunities).values({ athlete_id: who, status: "open", opened_at: first, last_activity_at: o.oppAt } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: "Brandco", status: "accepted", opportunity_id: opp.id, detected_at: first } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({ athlete_id: who, deal_id: d.id, status: "deal_detected", message_count: o.messages.length, last_message_at: o.threadAt } as any).returning({ id: inboxThreads.id });
  for (const at of o.messages) await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", received_at: new Date(at) } as any);
  let paperId: string | null = null;
  if (o.paperwork) {
    const [p] = await db.insert(inboxThreads).values({ athlete_id: who, status: "read", message_count: 1, last_message_at: new Date(o.paperwork),
      classification: { paperwork: { state: "matched", event: "completed", deal_id: d.id, opportunity_id: opp.id } } } as any).returning({ id: inboxThreads.id });
    await db.insert(inboxMessages).values({ athlete_id: who, thread_id: p.id, direction: "inbound", received_at: new Date(o.paperwork) } as any);
    paperId = p.id;
  }
  return { oppId: opp.id, dealId: d.id, threadId: t.id, paperId };
}

let stale: Awaited<ReturnType<typeof engagement>>;
let fine: Awaited<ReturnType<typeof engagement>>;
let elsewhere: Awaited<ReturnType<typeof engagement>>;
let empty = "";

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Restored");
  otherAthlete = await seedAthlete("Not selected");
  // Conversation Jul 29 → Sep 30; signed paperwork Aug 15; thread and opportunity both re-stamped Oct 8.
  stale = await engagement(athleteId, { threadAt: STAMP, oppAt: STAMP, messages: ["2026-07-29T05:02:08Z", "2026-09-30T21:45:05Z"], paperwork: "2026-08-15T02:02:45Z" });
  // Ingest lag of seconds: within tolerance, untouched.
  fine = await engagement(athleteId, { threadAt: new Date("2026-09-01T00:00:25Z"), oppAt: new Date("2026-09-01T00:00:00Z"), messages: ["2026-09-01T00:00:00Z"] });
  // A thread with no message keeps what it has.
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, status: "read", message_count: 0, last_message_at: STAMP } as any).returning({ id: inboxThreads.id });
  empty = t.id;
  elsewhere = await engagement(otherAthlete, { threadAt: STAMP, oppAt: STAMP, messages: ["2026-08-01T00:00:00Z"] });
});
afterAll(async () => { await closeTestDb(); });

const threadAt = async (id: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0].last_message_at!.toISOString();
const oppAt = async (id: string) => (await db.select().from(opportunities).where(eq(opportunities.id, id)))[0].last_activity_at!.toISOString();

it("dry run (read-only session) plans the drifted thread and opportunity, with old values, and writes nothing", async () => {
  await client.exec("SET default_transaction_read_only = on");
  let plan;
  try {
    plan = await planRestore(db, athleteId, new Date("2026-10-08T12:00:00Z"));
  } finally {
    await client.exec("SET default_transaction_read_only = off");
  }
  expect(plan.threads).toEqual([{ id: stale.threadId, stored: STAMP.toISOString(), actual: "2026-09-30T21:45:05.000Z" }]);
  expect(plan.opportunities).toEqual([{ id: stale.oppId, stored: STAMP.toISOString(), actual: "2026-09-30T21:45:05.000Z" }]);
  expect(plan.deal_ids).toEqual([stale.dealId]);
  expect(plan.counts).toEqual({ threads: 1, opportunities: 1, deals: 1 });
  expect(renderMarkdown(plan, "dry-run")).toContain("Deals showing a wrong date: **1**");
  expect(await threadAt(stale.threadId)).toBe(STAMP.toISOString());
  expect(await oppAt(stale.oppId)).toBe(STAMP.toISOString());
});

it("--apply restores from the messages' own dates for the selected athlete only; a re-run plans nothing", async () => {
  const plan = await applyRestore(db, athleteId);
  expect(plan.counts).toEqual({ threads: 1, opportunities: 1, deals: 1 });
  expect(await threadAt(stale.threadId)).toBe("2026-09-30T21:45:05.000Z");
  expect(await oppAt(stale.oppId)).toBe("2026-09-30T21:45:05.000Z");
  expect(await threadAt(stale.paperId!)).toBe("2026-08-15T02:02:45.000Z");
  expect(await threadAt(fine.threadId)).toBe("2026-09-01T00:00:25.000Z");
  expect(await threadAt(empty)).toBe(STAMP.toISOString());
  expect(await threadAt(elsewhere.threadId)).toBe(STAMP.toISOString());
  expect(await oppAt(elsewhere.oppId)).toBe(STAMP.toISOString());
  expect((await planRestore(db, athleteId)).counts).toEqual({ threads: 0, opportunities: 0, deals: 0 });
});
