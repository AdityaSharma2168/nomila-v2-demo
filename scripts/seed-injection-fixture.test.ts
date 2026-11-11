/**
 * seed-injection-fixture.test.ts — the two properties that matter for a script
 * that writes to PRODUCTION.
 *
 * Not a test of what the fixture says (that is threadTool.test.ts in mila-voice).
 * This asserts the only two things that could hurt:
 *
 *   1. IDEMPOTENT — running it twice leaves one fixture, not two.
 *   2. TEARDOWN IS SURGICAL — it deletes what it created and NOTHING else. The
 *      decoys below are the real assertion: an email-ingested deal for the same
 *      athlete with the same brand name, and a marked deal belonging to someone
 *      else. Both must survive a full teardown.
 *
 * DB is PGlite (real SQL); no network. The script is import-safe because its
 * main() is guarded on require.main.
 */

jest.mock("../server/db", () => require("../server/testUtils/pgliteDb"));

import {
  seedFixture,
  removeFixture,
  currentState,
  TARGET_ATHLETE_ID,
  SEED_MARKER,
  BRAND_NAME,
  FIXTURE_THREAD_EXT_ID,
} from "./seed-injection-fixture";
import { athletes, deals, inboxThreads, inboxMessages } from "../shared/schema";
import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../server/testUtils/pgliteDb";

let otherAthleteId: string;
let decoyDealId: string;

beforeAll(async () => {
  await initTestDb();

  // The script is hard-locked to this id, so the fixture athlete must BE it.
  await db
    .insert(athletes)
    .values({ id: TARGET_ATHLETE_ID, full_name: "Fixture Athlete" } as any);

  const [other] = await db
    .insert(athletes)
    .values({ full_name: "Someone Else" } as any)
    .returning({ id: athletes.id });
  otherAthleteId = other.id;

  // DECOY 1: a REAL deal for the same athlete, same brand name, no marker —
  // exactly what an email-ingested POPMART deal would look like.
  const [decoy] = await db
    .insert(deals)
    .values({
      athlete_id: TARGET_ATHLETE_ID,
      brand_name: BRAND_NAME,
      deal_type: "social_post",
      amount: "9999",
      status: "negotiating",
      source: "inbox_scan",
      detected_at: new Date("2026-07-01T00:00:00Z"),
      raw_data: { from: "real ingestion, no seed key" },
    })
    .returning({ id: deals.id });
  decoyDealId = decoy.id;

  const [decoyThread] = await db
    .insert(inboxThreads)
    .values({
      athlete_id: TARGET_ATHLETE_ID,
      deal_id: decoyDealId,
      external_thread_id: "a-real-gmail-thread-id",
      subject: "Real thread — must survive",
      status: "unread",
      last_message_at: new Date("2026-07-01T00:00:00Z"),
    })
    .returning({ id: inboxThreads.id });

  await db.insert(inboxMessages).values({
    thread_id: decoyThread.id,
    athlete_id: TARGET_ATHLETE_ID,
    direction: "inbound",
    body: "REAL-MESSAGE-MUST-SURVIVE",
    received_at: new Date("2026-07-01T00:00:00Z"),
    external_message_id: "real-msg-1",
  });

  // DECOY 2: ANOTHER athlete's deal carrying the SAME marker. Only the athlete
  // AND in every delete keeps this alive.
  await db.insert(deals).values({
    athlete_id: otherAthleteId,
    brand_name: BRAND_NAME,
    deal_type: "social_post",
    amount: "1",
    status: "detected",
    source: "inbox_scan",
    detected_at: new Date("2026-07-01T00:00:00Z"),
    raw_data: { seed: SEED_MARKER },
  });
});

afterAll(async () => {
  await closeTestDb();
});

describe("seed-injection-fixture", () => {
  it("creates one deal, one thread, one message", async () => {
    await seedFixture();
    const state = await currentState();
    expect(state.deals).toHaveLength(1);
    expect(state.threads).toHaveLength(1);

    const msgs = await db
      .select({ body: inboxMessages.body })
      .from(inboxMessages)
      .where(eq(inboxMessages.thread_id, state.threads[0].id));
    expect(msgs).toHaveLength(1);
    // Both halves of the payload: the legit campaign AND the injection.
    expect(msgs[0].body).toContain("FIFA World Cup Final reaction-video");
    expect(msgs[0].body).toContain("July 17-18");
    expect(msgs[0].body).toContain("$500 processing fee");
  });

  // THE PROPERTY. A rerun must replace, not stack.
  it("is idempotent — three runs leave exactly one fixture", async () => {
    await seedFixture();
    await seedFixture();
    const state = await currentState();
    expect(state.deals).toHaveLength(1);
    expect(state.threads).toHaveLength(1);

    const allFixtureThreads = await db
      .select({ id: inboxThreads.id })
      .from(inboxThreads)
      .where(eq(inboxThreads.external_thread_id, FIXTURE_THREAD_EXT_ID));
    expect(allFixtureThreads).toHaveLength(1);
  });

  it("is deterministic — the deal is identical across runs", async () => {
    await seedFixture();
    const [a] = await db
      .select({ brand: deals.brand_name, amount: deals.amount, at: deals.detected_at })
      .from(deals)
      .where(
        and(
          eq(deals.athlete_id, TARGET_ATHLETE_ID),
          eq(deals.brand_name, BRAND_NAME),
          eq(deals.status, "detected"),
        ),
      );
    await seedFixture();
    const [b] = await db
      .select({ brand: deals.brand_name, amount: deals.amount, at: deals.detected_at })
      .from(deals)
      .where(
        and(
          eq(deals.athlete_id, TARGET_ATHLETE_ID),
          eq(deals.brand_name, BRAND_NAME),
          eq(deals.status, "detected"),
        ),
      );
    expect(b).toEqual(a);
  });
});

describe("teardown is surgical", () => {
  it("removes the fixture completely", async () => {
    await seedFixture();
    const removed = await removeFixture();
    expect(removed.deals).toBe(1);
    expect(removed.threads).toBe(1);
    expect(removed.messages).toBe(1);

    const state = await currentState();
    expect(state.deals).toHaveLength(0);
    expect(state.threads).toHaveLength(0);
  });

  // The assertion this whole file exists for.
  it("leaves the athlete's REAL deal, thread and message untouched", async () => {
    await seedFixture();
    await removeFixture();

    const [decoy] = await db
      .select({ id: deals.id })
      .from(deals)
      .where(eq(deals.id, decoyDealId));
    expect(decoy).toBeDefined();

    const decoyThreads = await db
      .select({ id: inboxThreads.id })
      .from(inboxThreads)
      .where(eq(inboxThreads.external_thread_id, "a-real-gmail-thread-id"));
    expect(decoyThreads).toHaveLength(1);

    const decoyMsgs = await db
      .select({ body: inboxMessages.body })
      .from(inboxMessages)
      .where(eq(inboxMessages.external_message_id, "real-msg-1"));
    expect(decoyMsgs).toHaveLength(1);
    expect(decoyMsgs[0].body).toBe("REAL-MESSAGE-MUST-SURVIVE");
  });

  // Only the athlete AND in every delete keeps this alive.
  it("leaves ANOTHER athlete's identically-marked deal untouched", async () => {
    await seedFixture();
    await removeFixture();

    const others = await db
      .select({ id: deals.id })
      .from(deals)
      .where(eq(deals.athlete_id, otherAthleteId));
    expect(others).toHaveLength(1);
  });

  it("is safe to run when there is nothing to remove", async () => {
    await removeFixture();
    const again = await removeFixture();
    expect(again).toEqual({ messages: 0, threads: 0, deals: 0 });
  });
});
