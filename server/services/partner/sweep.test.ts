/**
 * partner/sweep.test.ts — the hourly housekeeping against PGlite: nothing while the flags are off; unconfirmed requests
 * expire at 72h; brand contact details are redacted 180 days after the opportunity closed and 7 days after an
 * unconfirmed request expired (and never earlier); counters and spent codes are pruned.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { deals, inboxMessages, inboxThreads, opportunities, partnerRequests, partnerVisitorCodes, publicRateCounters } from "../../../shared/schema";
import { runPartnerSweep } from "./sweep";
import { take } from "../../lib/publicRateCounters";

const DAY = 86_400_000;
let a: string;

async function request(over: Partial<typeof partnerRequests.$inferInsert> = {}) {
  const [r] = await db.insert(partnerRequests).values({
    athlete_id: a, public_ref: Math.random().toString(36).slice(2, 8).toUpperCase(), kind: "content", brand_name: "B", display_name: "F",
    brief: {}, contact_name: "N", contact_email: "n@b.example", contact_email_hash: "h", draft_token_hash: Math.random().toString(36),
    token_nonce: "n", expires_at: new Date(Date.now() + 72 * 3_600_000), ...over,
  }).returning();
  return r;
}

beforeAll(async () => { await initTestDb(); a = await seedAthlete("Sweep"); }, 120_000);
afterAll(async () => { delete process.env.PUBLIC_CARD; delete process.env.PARTNER_INTAKE; await closeTestDb(); });

it("does nothing while the flags are off", async () => {
  const r = await request({ expires_at: new Date(Date.now() - DAY) });
  expect(await runPartnerSweep()).toMatchObject({ skipped: true });
  expect((await db.select().from(partnerRequests).where(eq(partnerRequests.id, r.id)))[0].status).toBe("drafting");
});

it("expires, redacts on their clocks only, and prunes", async () => {
  process.env.PUBLIC_CARD = "true"; process.env.PARTNER_INTAKE = "true";
  const now = new Date();
  const stale = await request({ expires_at: new Date(now.getTime() - 10 * DAY) });      // expired long ago → redact
  const fresh = await request({ expires_at: new Date(now.getTime() - 1 * DAY) });       // expired yesterday → keep contact
  const live = await request({ expires_at: new Date(now.getTime() + DAY) });            // still open
  const [d1] = await db.insert(deals).values({ athlete_id: a, brand_name: "Old" }).returning();
  const [o1] = await db.insert(opportunities).values({ athlete_id: a, status: "closed", close_reason: "declined", closed_at: new Date(now.getTime() - 200 * DAY), opened_at: new Date(0), last_activity_at: new Date(0) }).returning();
  await db.update(deals).set({ opportunity_id: o1.id }).where(eq(deals.id, d1.id));
  const [d2] = await db.insert(deals).values({ athlete_id: a, brand_name: "Recent" }).returning();
  const [o2] = await db.insert(opportunities).values({ athlete_id: a, status: "closed", close_reason: "won", closed_at: new Date(now.getTime() - 20 * DAY), opened_at: new Date(0), last_activity_at: new Date(0) }).returning();
  await db.update(deals).set({ opportunity_id: o2.id }).where(eq(deals.id, d2.id));
  const closedOld = await request({ status: "confirmed", deal_id: d1.id, confirmed_at: new Date(0), status_token_hash: "s1" });
  const closedRecent = await request({ status: "confirmed", deal_id: d2.id, confirmed_at: new Date(0), status_token_hash: "s2" });
  await db.insert(partnerVisitorCodes).values([
    { email_hash: "e", code_hash: "c1", expires_at: new Date(now.getTime() - 2 * DAY) },
    { email_hash: "e", code_hash: "c2", expires_at: new Date(now.getTime() + 600_000) },
  ]);
  await take(["old"], 5, "hour", new Date(now.getTime() - 30 * DAY));
  await take(["new"], 5, "hour", now);

  const [t] = await db.insert(inboxThreads).values({ athlete_id: a }).returning();
  await db.insert(inboxMessages).values([
    { thread_id: t.id, athlete_id: a, platform: "nomila", moderation: "blocked", held_body: "old scam", received_at: new Date(now.getTime() - 100 * DAY), external_message_id: "b1" },
    { thread_id: t.id, athlete_id: a, platform: "nomila", moderation: "blocked", held_body: "new scam", received_at: new Date(now.getTime() - 10 * DAY), external_message_id: "b2" },
    { thread_id: t.id, athlete_id: a, platform: "nomila", moderation: "held", held_body: "old held", received_at: new Date(now.getTime() - 100 * DAY), external_message_id: "h1" },
  ]);
  const r = await runPartnerSweep(now);
  expect(r).toMatchObject({ expired: 3, redacted: 2, counters: 1, codes: 1, blockedTexts: 1 });
  expect((await db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, t.id))).map((m) => m.held_body ?? "(none)").sort()).toEqual(["(none)", "new scam", "old held"]);
  const get = async (id: string) => (await db.select().from(partnerRequests).where(eq(partnerRequests.id, id)))[0];
  expect(await get(stale.id)).toMatchObject({ status: "expired", contact_email: null, contact_name: null, contact_redacted_at: expect.any(Date) });
  expect(await get(fresh.id)).toMatchObject({ status: "expired", contact_email: "n@b.example" });
  expect(await get(live.id)).toMatchObject({ status: "drafting", contact_email: "n@b.example" });
  expect(await get(closedOld.id)).toMatchObject({ status: "confirmed", contact_email: null });
  expect(await get(closedRecent.id)).toMatchObject({ contact_email: "n@b.example" });
  expect((await db.select().from(partnerVisitorCodes)).map((c) => c.code_hash)).toEqual(["c2"]);
  expect(await db.select().from(publicRateCounters)).toHaveLength(1);
});
