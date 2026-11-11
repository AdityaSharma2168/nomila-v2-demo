/**
 * backfillOpportunitiesCore — the backfill against PGlite. The dry-run runs under a READ-ONLY
 * session (any write would throw) and changes nothing; --apply groups by brand (stored groups move
 * whole, ONE opportunity per agency), files every open opportunity quiet since before 1 Aug —
 * negotiating included — with one reversible receipt each, and a re-run places nothing twice.
 * Kimi is mocked to throw: the backfill never calls a model.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/kimi", () => ({ kimiInstant: jest.fn(async () => { throw new Error("the backfill must not call a model"); }) }));

import { eq, sql } from "drizzle-orm";
import { applyBackfill, planBackfill, renderMarkdown } from "./backfillOpportunitiesCore";
import { agentActions, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../../shared/schema";
import { db, client, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

let athleteId: string;
let otherAthlete: string;
let seq = 0;
const b: Record<string, number> = {};
const d: Record<string, { dealId: string; threadId: string | null }> = {};

async function brand(name: string, agency = false) {
  const [r] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase(), is_agency: agency } as any).returning({ id: inboxBrands.id });
  b[name] = r.id;
}
async function deal(key: string, o: { brand: string | null; status: string; sent: Date; threadStatus?: string; group?: string; athlete?: string; opp?: string; autoArchived?: boolean }) {
  const athlete = o.athlete ?? athleteId;
  const [row] = await db.insert(deals).values({
    athlete_id: athlete, brand_id: o.brand ? b[o.brand] : null, brand_name: o.brand ?? "Unknown Brand", status: o.status,
    deal_group_id: o.group ?? null, opportunity_id: o.opp ?? null, detected_at: o.sent, source: "inbox_scan",
  } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athlete, deal_id: row.id, subject: key, status: o.threadStatus ?? "deal_detected",
    last_message_at: NOW,   // ingest time: deliberately NOT what the backfill reads
  } as any).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athlete, direction: "inbound", subject: key, body: key,
    received_at: o.sent, external_message_id: `bf-${++seq}`, platform: "gmail",
  } as any);
  if (o.autoArchived) {
    await db.insert(agentActions).values({ athlete_id: athlete, action: "auto_archive", thread_id: t.id, deal_id: row.id, reversible: true, payload: { from_status: "read", to_status: "archived" } } as any);
  }
  d[key] = { dealId: row.id, threadId: t.id };
}

async function snapshot() {
  const r: any = await db.execute(sql`
    select (select count(*) from opportunities)::int as opps,
           (select count(*) from agent_actions)::int as actions,
           (select coalesce(string_agg(coalesce(opportunity_id::text,'-') || coalesce(deal_group_id::text,'-') || status, '|' order by id), '') from deals) as deals,
           (select coalesce(string_agg(status, '|' order by id), '') from inbox_threads) as threads`);
  return (r.rows ?? r)[0];
}

const G = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Backfilled");
  otherAthlete = await seedAthlete("Not in --athlete");
  for (const n of ["Groupco", "Oldco", "Declinedco", "Expiredco", "Mintedco"]) await brand(n);
  await brand("Agencyco", true);

  // A stored group of three (the sweep had buried two member threads) + a loose live deal: one open opportunity.
  await deal("g-lead", { brand: "Groupco", status: "accepted", sent: day("2026-08-20"), group: G });
  await deal("g-sig", { brand: "Groupco", status: "detected", sent: day("2026-08-22"), group: G, threadStatus: "archived", autoArchived: true });
  await deal("g-done", { brand: "Groupco", status: "detected", sent: day("2026-09-15"), group: G, threadStatus: "archived", autoArchived: true });
  await deal("g-loose", { brand: "Groupco", status: "detected", sent: day("2026-09-01") });
  // Negotiating, but quiet since July: filed.
  await deal("old", { brand: "Oldco", status: "negotiating", sent: day("2026-07-09") });
  // An agency that never named its advertiser, twice: ONE opportunity.
  await deal("ag-1", { brand: "Agencyco", status: "detected", sent: day("2026-09-02") });
  await deal("ag-2", { brand: "Agencyco", status: "detected", sent: day("2026-09-12") });
  // History.
  await deal("declined", { brand: "Declinedco", status: "rejected", sent: day("2026-05-01"), threadStatus: "archived" });
  await deal("expired", { brand: "Expiredco", status: "detected", sent: day("2026-04-01"), threadStatus: "archived", autoArchived: true });
  // No brand at all, live and recent: its own opportunity.
  await deal("nobrand", { brand: null, status: "detected", sent: day("2026-09-20") });
  // Minted after the deploy (already placed) + an older unplaced live deal of the same brand: it attaches.
  const [minted] = await db.insert(opportunities).values({
    athlete_id: athleteId, brand_id: b.Mintedco, status: "open", opened_at: day("2026-10-01"), last_activity_at: day("2026-10-01"),
  } as any).returning({ id: opportunities.id });
  await deal("minted", { brand: "Mintedco", status: "detected", sent: day("2026-10-01"), opp: minted.id });
  await deal("minted-old", { brand: "Mintedco", status: "pending", sent: day("2026-09-05") });
  // Another athlete's deal: never touched.
  await deal("other", { brand: "Oldco", status: "detected", sent: day("2026-06-01"), athlete: otherAthlete });
});

afterAll(async () => { await closeTestDb(); });

describe("dry-run", () => {
  it("plans under a READ-ONLY session and writes nothing", async () => {
    const before = await snapshot();
    await client.exec("SET default_transaction_read_only = on");
    let plan;
    try {
      plan = await planBackfill(db, athleteId, { now: NOW, mirrorGroups: true });
    } finally {
      await client.exec("SET default_transaction_read_only = off");
    }
    expect(await snapshot()).toEqual(before);

    expect(plan.counts).toMatchObject({ deals: 12, deals_to_place: 11, create_open: 4, create_closed: 2, attach_to_existing: 1, file: 1, threads_to_archive: 1 });
    const filed = plan.opportunities.filter((p) => p.file);
    expect(filed.map((p) => p.brand_name)).toEqual(["Oldco"]);
    expect(filed[0].deals[0].status).toBe("negotiating");
    const md = renderMarkdown(plan, "dry-run");
    expect(md).toContain("DRY RUN (read-only session; nothing written)");
    expect(md).toContain("open → FILED (closed · expired)");
  });
});

describe("apply", () => {
  it("creates opportunities per brand, files pre-August ones with receipts, and mirrors the groups", async () => {
    const plan = await applyBackfill(db, athleteId, { now: NOW, mirrorGroups: true });
    const dealOf = async (k: string) => (await db.select().from(deals).where(eq(deals.id, d[k].dealId)))[0];
    const oppOf = async (k: string) => (await db.select().from(opportunities).where(eq(opportunities.id, (await dealOf(k)).opportunity_id!)))[0];

    // The stored group moved whole, with the loose live deal: one open opportunity, times from SENT mail.
    const g = await oppOf("g-lead");
    for (const k of ["g-sig", "g-done", "g-loose"]) expect((await dealOf(k)).opportunity_id).toBe(g.id);
    expect(g).toMatchObject({ status: "open", brand_id: b.Groupco, lead_thread_id: d["g-lead"].threadId, opened_at: day("2026-08-20"), last_activity_at: day("2026-09-15") });
    expect((await dealOf("g-loose")).deal_group_id).toBe(g.id);   // mirrored: today's screens show one card

    // Filed: closed · expired, thread archived, ONE reversible receipt; the deal itself keeps its status.
    const old = await oppOf("old");
    expect(old).toMatchObject({ status: "closed", close_reason: "expired", closed_at: NOW });
    expect((await dealOf("old")).status).toBe("negotiating");
    expect((await db.select().from(inboxThreads).where(eq(inboxThreads.id, d.old.threadId!)))[0].status).toBe("archived");
    const receipts = (await db.select().from(agentActions).where(eq(agentActions.athlete_id, athleteId)))
      .filter((r) => (r.payload as any)?.opportunity_id === old.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ action: "auto_archive", reversible: true, thread_id: d.old.threadId });
    expect(receipts[0].payload).toMatchObject({ from_status: "deal_detected", to_status: "archived", by: "opps_backfill" });

    // One opportunity for the agency.
    expect((await dealOf("ag-1")).opportunity_id).toBe((await dealOf("ag-2")).opportunity_id);
    expect((await oppOf("ag-1")).status).toBe("open");

    // History, with honest reasons.
    expect(await oppOf("declined")).toMatchObject({ status: "closed", close_reason: "declined" });
    expect(await oppOf("expired")).toMatchObject({ status: "closed", close_reason: "expired" });
    // No brand: its own opportunity. Minted: the old live deal joined the existing one.
    expect(await oppOf("nobrand")).toMatchObject({ status: "open", brand_id: null });
    expect((await dealOf("minted-old")).opportunity_id).toBe((await dealOf("minted")).opportunity_id);

    // Another athlete is never touched.
    expect((await dealOf("other")).opportunity_id).toBeNull();
    expect(plan.counts.file).toBe(1);
  });

  it("a re-run places nothing twice and files nothing twice", async () => {
    const before = await snapshot();
    const plan = await applyBackfill(db, athleteId, { now: NOW, mirrorGroups: true });
    expect(plan.counts).toMatchObject({ deals_to_place: 0, create_open: 0, create_closed: 0, file: 0, mirror: 0 });
    expect(await snapshot()).toEqual(before);
  });
});
