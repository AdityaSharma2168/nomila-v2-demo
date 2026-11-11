/**
 * archiveStaleDeals.test.ts — the auto-archive sweep, against in-memory Postgres
 * (PGlite). Locks the gates: only dormant (60+ days), untouched (detected/pending),
 * not-already-archived deal-threads get archived, and each writes a REVERSIBLE
 * `auto_archive` receipt carrying payload.from_status so Undo can un-archive it.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(async () => { throw new Error("tests never reach Kimi"); }) }));

import { and, eq } from "drizzle-orm";
import { athletes, deals, inboxThreads, agentActions, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { archiveStaleDeals, ARCHIVE_DORMANT_DAYS } from "./archiveStaleDeals";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const DORMANT = daysAgo(ARCHIVE_DORMANT_DAYS + 10); // safely past the cutoff
const RECENT  = daysAgo(10);

let athleteId: string;

// Insert a deal + its thread; return { dealId, threadId }.
async function mkDealThread(opts: {
  dealStatus: string;
  threadStatus: string;
  lastMessageAt: Date | null;
  brand?: string;
}) {
  const [d] = await db
    .insert(deals)
    .values({ athlete_id: athleteId, brand_name: opts.brand ?? "Acme", status: opts.dealStatus } as any)
    .returning();
  const [t] = await db
    .insert(inboxThreads)
    .values({
      athlete_id: athleteId,
      deal_id: d.id,
      subject: opts.brand ?? "Acme",
      status: opts.threadStatus,
      last_message_at: opts.lastMessageAt,
    } as any)
    .returning();
  return { dealId: d.id as string, threadId: t.id as string };
}

async function threadStatus(id: string): Promise<string | null> {
  const [t] = await db.select({ s: inboxThreads.status }).from(inboxThreads).where(eq(inboxThreads.id, id));
  return t?.s ?? null;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Owner");
});

afterAll(async () => {
  await closeTestDb();
});

describe("archiveStaleDeals — gates", () => {
  it("archives only dormant, untouched, not-already-archived deal-threads", async () => {
    const dormantDetected = await mkDealThread({ dealStatus: "detected", threadStatus: "read",     lastMessageAt: DORMANT, brand: "Dormant" });
    const dormantPending  = await mkDealThread({ dealStatus: "pending",  threadStatus: "read",     lastMessageAt: DORMANT, brand: "Pending" });
    const activeNegotiate = await mkDealThread({ dealStatus: "negotiating", threadStatus: "read",  lastMessageAt: DORMANT, brand: "Negotiating" });
    const accepted        = await mkDealThread({ dealStatus: "accepted", threadStatus: "read",     lastMessageAt: DORMANT, brand: "Accepted" });
    const recentDetected  = await mkDealThread({ dealStatus: "detected", threadStatus: "read",     lastMessageAt: RECENT,  brand: "Recent" });
    const alreadyArchived = await mkDealThread({ dealStatus: "detected", threadStatus: "archived", lastMessageAt: DORMANT, brand: "Archived" });

    const result = await archiveStaleDeals(NOW);

    // Only the two dormant/untouched ones.
    expect(result.archived).toBe(2);
    expect(await threadStatus(dormantDetected.threadId)).toBe("archived");
    expect(await threadStatus(dormantPending.threadId)).toBe("archived");

    // Everything else is untouched.
    expect(await threadStatus(activeNegotiate.threadId)).toBe("read");
    expect(await threadStatus(accepted.threadId)).toBe("read");
    expect(await threadStatus(recentDetected.threadId)).toBe("read");
    expect(await threadStatus(alreadyArchived.threadId)).toBe("archived"); // was already

    // Each archive wrote a reversible auto_archive receipt carrying from_status.
    const receipts = await db.select().from(agentActions).where(eq(agentActions.action, "auto_archive"));
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.reversible).toBe(true);
      expect((r.payload as any)?.from_status).toBe("read");
      expect((r.payload as any)?.to_status).toBe("archived");
      expect(r.thread_id).toBeTruthy();
      expect(r.deal_id).toBeTruthy();
    }
  });

  it("is idempotent — a second run archives nothing new", async () => {
    const before = (await db.select().from(agentActions).where(eq(agentActions.action, "auto_archive"))).length;
    const result = await archiveStaleDeals(NOW);
    expect(result.archived).toBe(0);
    const after = (await db.select().from(agentActions).where(eq(agentActions.action, "auto_archive"))).length;
    expect(after).toBe(before);
  });
});

// ─── The sweep works per opportunity (OPPS_ONE_PER_BRAND, retired 2 Nov 2026: always on) ─────

describe("archiveStaleDeals — per opportunity", () => {
  let owner: string;

  /** An open opportunity, quiet since `lastActivity`, with one deal + thread per member spec. */
  async function mkOpp(lastActivity: Date, members: { status?: string; classification?: object; cash?: number; type?: string }[]) {
    const [o] = await db.insert(opportunities).values({
      athlete_id: owner, status: "open", opened_at: lastActivity, last_activity_at: lastActivity,
    } as any).returning();
    const threads: string[] = [];
    for (const m of members) {
      const [d] = await db.insert(deals).values({
        athlete_id: owner, brand_name: "Oppco", status: m.status ?? "detected", deal_type: m.type ?? "social_post",
        amount_cash: m.cash != null ? String(m.cash) : null, opportunity_id: o.id,
      } as any).returning();
      const [t] = await db.insert(inboxThreads).values({
        athlete_id: owner, deal_id: d.id, subject: "Oppco", status: "deal_detected",
        // The per-thread pass keys on ingest time; dormant here too, so only the flag keeps it away.
        last_message_at: DORMANT, classification: m.classification ?? null,
      } as any).returning();
      threads.push(t.id);
    }
    if (threads[0]) await db.update(opportunities).set({ lead_thread_id: threads[0] }).where(eq(opportunities.id, o.id));
    return { id: o.id as string, threads };
  }
  const opp = async (id: string) => (await db.select().from(opportunities).where(eq(opportunities.id, id)))[0];
  const qual = (qualification: string, channel = "direct") => ({ qualification, channel, qualification_version: "opps-qual/1" });

  beforeAll(async () => {
    owner = await seedAthlete("Opp owner");
    await db.update(athletes).set({ deal_preferences: { minimum_rates: { socialPost: 1000 } } } as any).where(eq(athletes.id, owner));
  });
  it("closes a quiet, NON-valuable opportunity: every member thread archived together, ONE reversible receipt", async () => {
    const notValuable = await mkOpp(DORMANT, [
      {},                                                  // detected, unqualified, no price
      { classification: qual("needs_terms", "agency") },   // an agency asking, no price
      { cash: 400 },                                       // stated cash under her $1,000 floor
      { status: "rejected" },
    ]);
    const recent = await mkOpp(RECENT, [{}]);

    const result = await archiveStaleDeals(NOW);
    expect(result.opportunitiesClosed).toBeGreaterThanOrEqual(1);
    expect(await opp(notValuable.id)).toMatchObject({ status: "closed", close_reason: "expired", closed_at: NOW });
    for (const t of notValuable.threads) expect(await threadStatus(t)).toBe("archived");
    expect((await opp(recent.id)).status).toBe("open");

    const receipts = (await db.select().from(agentActions).where(eq(agentActions.action, "auto_archive")))
      .filter((r) => (r.payload as any)?.opportunity_id === notValuable.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ reversible: true, thread_id: notValuable.threads[0] });
    expect(receipts[0].payload).toMatchObject({ from_status: "deal_detected", to_status: "archived", by: "sweep" });
    expect((receipts[0].payload as any).threads.map((t: any) => t.id).sort()).toEqual([...notValuable.threads].sort());
  });

  it("keeps a VALUABLE opportunity open, marks it going quiet once, and never archives its threads one at a time", async () => {
    const valuable = [
      await mkOpp(DORMANT, [{}, { status: "negotiating" }]),             // a member past detected
      await mkOpp(DORMANT, [{ classification: qual("workable") }]),       // workable
      await mkOpp(DORMANT, [{ classification: qual("needs_terms") }]),    // a direct brand asking
      await mkOpp(DORMANT, [{ cash: 1500 }]),                             // stated cash at/above her floor
    ];
    await archiveStaleDeals(NOW);
    for (const v of valuable) {
      expect(await opp(v.id)).toMatchObject({ status: "open", going_quiet_at: NOW });
      for (const t of v.threads) expect(await threadStatus(t)).toBe("deal_detected");   // the dormant detected member too
    }

    // One-time: a later run neither re-marks nor closes it.
    await archiveStaleDeals(new Date(NOW.getTime() + 7 * 86_400_000));
    for (const v of valuable) expect(await opp(v.id)).toMatchObject({ status: "open", going_quiet_at: NOW });
  });

  it("an unplaced deal is still swept per thread under the flag", async () => {
    const loose = await mkDealThread({ dealStatus: "detected", threadStatus: "read", lastMessageAt: DORMANT, brand: "Loose" });
    await archiveStaleDeals(NOW);
    expect(await threadStatus(loose.threadId)).toBe("archived");
  });

  it("verify_first stays exempt", async () => {
    const vf = await mkOpp(DORMANT, [{ classification: qual("verify_first", "unverifiable") }]);
    await archiveStaleDeals(NOW);
    expect(await opp(vf.id)).toMatchObject({ status: "open", going_quiet_at: null });
    expect(await threadStatus(vf.threads[0])).toBe("deal_detected");
  });
});

describe("her turn blocks the sweep (12 Oct 2026)", () => {
  it("never files a conversation where the brand is waiting on her reply; an unanswered pitch is still filed", async () => {
    const { inboxMessages } = await import("../../shared/schema");
    const herTurn = await mkDealThread({ dealStatus: "detected", threadStatus: "read", lastMessageAt: DORMANT, brand: "Waiting" });
    const pitchOnly = await mkDealThread({ dealStatus: "detected", threadStatus: "read", lastMessageAt: DORMANT, brand: "Pitch" });
    for (const t of [herTurn, pitchOnly]) {
      await db.update(inboxThreads).set({ conversation_state: { key_details: { awaiting_response_from: "athlete" } } as any })
        .where(eq(inboxThreads.id, t.threadId));
    }
    // She replied once on the first; the brand wrote back last.
    await db.insert(inboxMessages).values({
      thread_id: herTurn.threadId, athlete_id: athleteId, direction: "outbound", body: "Tell me more",
      platform: "gmail", external_message_id: "her-turn-out", received_at: DORMANT,
    } as any);

    await archiveStaleDeals(NOW);

    expect(await threadStatus(herTurn.threadId)).toBe("read");
    expect(await threadStatus(pitchOnly.threadId)).toBe("archived");
  });
});
