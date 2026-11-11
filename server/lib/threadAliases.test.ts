/**
 * Cross-mailbox alias registration against PGlite.
 *
 * Aliases now live in the dedicated inbox_threads.alias_thread_ids column (H1/H4),
 * not the classification JSONB — so a re-classification can't clobber them and the
 * append is a single atomic statement.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { findThreadByExternalId, registerThreadAlias } from "./threadAliases";
import { inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
});

afterAll(async () => {
  await closeTestDb();
});

describe("threadAliases", () => {
  it("finds by primary external_thread_id and by registered alias", async () => {
    const [thread] = await db
      .insert(inboxThreads)
      .values({
        athlete_id:         athleteId,
        subject:            "Dual inbox deal",
        external_thread_id: "gmail-thread-A",
        classification:     { category: "PAID", confidence: 0.9 },
      } as any)
      .returning();

    const byPrimary = await findThreadByExternalId(athleteId, "gmail-thread-A");
    expect(byPrimary?.id).toBe(thread.id);

    await registerThreadAlias(thread.id, "gmail-thread-B");
    await registerThreadAlias(thread.id, "gmail-thread-B"); // idempotent

    const byAlias = await findThreadByExternalId(athleteId, "gmail-thread-B");
    expect(byAlias?.id).toBe(thread.id);

    const [stored] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, thread.id));
    // Alias stored in the dedicated column (no dupes), classification untouched.
    expect(stored.alias_thread_ids).toEqual(["gmail-thread-B"]);
    expect((stored.classification as any).category).toBe("PAID");
  });

  it("does not re-alias the primary id", async () => {
    const [thread] = await db
      .insert(inboxThreads)
      .values({
        athlete_id:         athleteId,
        subject:            "No self-alias",
        external_thread_id: "primary-only",
        classification:     { category: "MEDIA" },
      } as any)
      .returning();

    await registerThreadAlias(thread.id, "primary-only");
    const [stored] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, thread.id));
    expect(stored.alias_thread_ids).toBeNull();
  });

  it("a registered alias SURVIVES a re-classification/upgrade (H1)", async () => {
    const [thread] = await db
      .insert(inboxThreads)
      .values({
        athlete_id:         athleteId,
        subject:            "Upgrade path",
        external_thread_id: "gmail-thread-C",
        classification:     { category: "GIFTING", confidence: 0.6 },
      } as any)
      .returning();

    await registerThreadAlias(thread.id, "gmail-thread-C-alias");

    // Simulate detectDeal's wholesale classification overwrite on a follow-up/upgrade —
    // this used to clobber the aliases when they lived inside the JSONB.
    await db
      .update(inboxThreads)
      .set({ classification: { category: "PAID", confidence: 0.95, offer_amount: 5000 } })
      .where(eq(inboxThreads.id, thread.id));

    // The alias must still resolve to the same thread after the overwrite.
    const stillFound = await findThreadByExternalId(athleteId, "gmail-thread-C-alias");
    expect(stillFound?.id).toBe(thread.id);

    const [stored] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, thread.id));
    expect(stored.alias_thread_ids).toEqual(["gmail-thread-C-alias"]);
    expect((stored.classification as any).category).toBe("PAID"); // the upgrade landed
  });

  it("appends multiple distinct aliases without dropping earlier ones", async () => {
    const [thread] = await db
      .insert(inboxThreads)
      .values({
        athlete_id:         athleteId,
        subject:            "Three inboxes",
        external_thread_id: "gmail-thread-D",
        classification:     { category: "PAID" },
      } as any)
      .returning();

    await registerThreadAlias(thread.id, "alias-1");
    await registerThreadAlias(thread.id, "alias-2");
    await registerThreadAlias(thread.id, "alias-1"); // dup, ignored

    const [stored] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, thread.id));
    expect(stored.alias_thread_ids?.sort()).toEqual(["alias-1", "alias-2"]);
  });
});
