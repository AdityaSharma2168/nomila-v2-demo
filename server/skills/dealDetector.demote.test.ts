/**
 * dealDetector.demote.test.ts — the WS5 recovery (add) + demote (set-aside) helpers,
 * against in-memory Postgres (PGlite). No LLM: these helpers operate on the DB only
 * (the reclassify endpoint's classify/score calls are covered separately/mocked).
 *
 * Covers:
 *   - upsertDealForThread: creates + links a deal, and is idempotent (one deal/thread)
 *   - demoteDealThread: archives the thread + appends a reversible receipt
 *   - maybeAutoDemote gates: category (non-commercial only), confidence, untouched-only
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { deals, inboxThreads, agentActions, opportunities } from "../../shared/schema";
import {
  upsertDealForThread,
  demoteDealThread,
  maybeAutoDemote,
  type Classification,
} from "./dealDetector";

let athleteId: string;

function cls(overrides: Partial<Classification> = {}): Classification {
  return {
    category: "PAID", confidence: 1, brand_name: "Acme", brand_domain: null,
    advertiser: null, agency_name: null, via_agency: false, summary: "an offer",
    offer_amount: 500, deliverables: [], deadline: null, contact_name: null, contact_email: null,
    ...overrides,
  };
}

async function mkThread(status = "deal_detected") {
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, subject: "S", status } as any).returning();
  return t;
}
async function mkDeal(status = "detected") {
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", status, source: "inbox_scan" } as any).returning();
  return d;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Owner");
});
afterAll(async () => { await closeTestDb(); });

describe("upsertDealForThread", () => {
  it("creates a deal and links the thread when none exists", async () => {
    const t = await mkThread();
    const dealId = await upsertDealForThread(athleteId, t.id, cls(), { gmailThreadId: "" });
    expect(dealId).toBeTruthy();
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.deal_id).toBe(dealId);
  });

  it("is idempotent — a second call updates the same deal, never a second row", async () => {
    const t = await mkThread();
    // First call creates + links; the helper now re-reads thread.deal_id fresh, so a
    // second call finds the linked deal and updates it in place (one deal per thread).
    const first = await upsertDealForThread(athleteId, t.id, cls({ offer_amount: 100 }), { gmailThreadId: "" });
    const second = await upsertDealForThread(athleteId, t.id, cls({ offer_amount: 999 }), { gmailThreadId: "" });
    expect(second).toBe(first);
    const rows = await db.select().from(deals).where(eq(deals.id, first!));
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("999"); // updated in place
  });
});

describe("demoteDealThread", () => {
  it("archives the thread and appends a reversible receipt", async () => {
    const t = await mkThread("deal_detected");
    const d = await mkDeal("detected");
    await demoteDealThread(athleteId, t.id, { dealId: d.id, fromStatus: "deal_detected", brandName: "Acme", toCategory: "FAN" });

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.status).toBe("archived");

    const acts = await db.select().from(agentActions).where(eq(agentActions.thread_id, t.id));
    expect(acts).toHaveLength(1);
    expect(acts[0].action).toBe("reclassify");
    expect(acts[0].reversible).toBe(true);
    expect((acts[0].payload as any).from_status).toBe("deal_detected");
    expect((acts[0].payload as any).to_status).toBe("archived");
  });

  async function mkOpp() {
    const now = new Date("2026-10-15T12:00:00Z");
    const [o] = await db.insert(opportunities).values({ athlete_id: athleteId, status: "open", opened_at: now, last_activity_at: now } as any).returning();
    return o.id as string;
  }
  async function mkDealOn(oppId: string, threadStatus: string) {
    const d = await mkDeal("detected");
    await db.update(deals).set({ opportunity_id: oppId } as any).where(eq(deals.id, d.id));
    const t = await mkThread(threadStatus);
    await db.update(inboxThreads).set({ deal_id: d.id }).where(eq(inboxThreads.id, t.id));
    return { deal: d, thread: t };
  }

  it("closes the opportunity when its last live deal is set aside, and the receipt names it for Undo", async () => {
    const oppId = await mkOpp();
    const { deal, thread } = await mkDealOn(oppId, "deal_detected");
    await mkDealOn(oppId, "archived");
    await demoteDealThread(athleteId, thread.id, { dealId: deal.id, toCategory: "NOISE" });
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, oppId));
    expect(o).toMatchObject({ status: "closed", close_reason: "not_relevant" });
    const [act] = await db.select().from(agentActions).where(eq(agentActions.thread_id, thread.id));
    expect((act.payload as any).opportunity_id).toBe(oppId);
  });

  it("keeps the opportunity open while another deal under it is live", async () => {
    const oppId = await mkOpp();
    const { deal, thread } = await mkDealOn(oppId, "deal_detected");
    await mkDealOn(oppId, "deal_detected");
    await demoteDealThread(athleteId, thread.id, { dealId: deal.id, toCategory: "NOISE" });
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, oppId));
    expect(o.status).toBe("open");
    const [act] = await db.select().from(agentActions).where(eq(agentActions.thread_id, thread.id));
    expect((act.payload as any).opportunity_id).toBeUndefined();
  });
});

describe("maybeAutoDemote gates", () => {
  it("demotes an UNTOUCHED deal that re-reads as high-confidence FAN", async () => {
    const t = await mkThread("deal_detected");
    const d = await mkDeal("detected");
    await db.update(inboxThreads).set({ deal_id: d.id }).where(eq(inboxThreads.id, t.id));
    const did = await maybeAutoDemote(athleteId, t.id, d.id, cls({ category: "FAN", confidence: 0.95 }));
    expect(did).toBe(true);
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.status).toBe("archived");
  });

  it("does NOT demote on low confidence", async () => {
    const t = await mkThread();
    const d = await mkDeal("detected");
    const did = await maybeAutoDemote(athleteId, t.id, d.id, cls({ category: "FAN", confidence: 0.5 }));
    expect(did).toBe(false);
  });

  it("does NOT demote a commercial category (a real, merely-low deal is safe)", async () => {
    const t = await mkThread();
    const d = await mkDeal("detected");
    const did = await maybeAutoDemote(athleteId, t.id, d.id, cls({ category: "PAID", confidence: 0.99 }));
    expect(did).toBe(false);
  });

  it("does NOT demote a deal the athlete has ENGAGED (status past 'detected')", async () => {
    const t = await mkThread();
    const d = await mkDeal("negotiating");
    const did = await maybeAutoDemote(athleteId, t.id, d.id, cls({ category: "FAN", confidence: 0.99 }));
    expect(did).toBe(false);
  });

  it("does NOT demote a deal qualified workable — stated terms (a benign follow-up can misread)", async () => {
    const t = await mkThread("deal_detected");
    await db.update(inboxThreads).set({ classification: { qualification: "workable", channel: "direct", qualification_reason: "Terms stated." } as any }).where(eq(inboxThreads.id, t.id));
    const d = await mkDeal("detected");
    await db.update(inboxThreads).set({ deal_id: d.id }).where(eq(inboxThreads.id, t.id));
    const did = await maybeAutoDemote(athleteId, t.id, d.id, cls({ category: "FAN", confidence: 0.99 }));
    expect(did).toBe(false);
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.status).toBe("deal_detected"); // untouched
  });
});
