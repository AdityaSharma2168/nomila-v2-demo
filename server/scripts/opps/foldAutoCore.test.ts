/**
 * foldAutoCore — the all-athlete auto-detect fold, against PGlite, over two synthetic athletes with different sports
 * and brands (made-up names). Detection is per athlete and uses the live classifiers (legacy e-sign domain, calendar
 * invite subject); the dry-run runs under a read-only session and changes no row; one reviewed plan applies for its
 * athlete only, in one transaction; a stale or already-applied plan is refused; undo restores every prior value.
 * No provider is reached.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/dealGrouping", () => ({ partitionOrNull: jest.fn(async () => null) }));
jest.mock("../../skills/threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));

import { asc, eq } from "drizzle-orm";
import { athletes, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../../shared/schema";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { applyAutoFold, isEmptyPlan, planAutoFold, renderAutoFold, undoAutoFold, type AutoFoldPlan } from "./foldAutoCore";
import { forEachAthlete, parseAthleteSelection, resolveAthletes } from "../athleteSelection";

const at = (s: string) => new Date(s);

interface Seeded { athleteId: string; realDeal: string; realOpp: string; esignDeal: string; inviteDeal: string; inviteThread: string }

async function brand(name: string, domain: string): Promise<number> {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase(), domain } as any).returning({ id: inboxBrands.id });
  return b.id;
}
async function opp(athleteId: string, brandId: number, when: string): Promise<string> {
  const [o] = await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: brandId, status: "open", opened_at: at(when), last_activity_at: at(when) } as any).returning({ id: opportunities.id });
  return o.id;
}
async function deal(athleteId: string, brandId: number, brandName: string, oppId: string, status: string): Promise<string> {
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_id: brandId, brand_name: brandName, status, opportunity_id: oppId, deal_group_id: oppId } as any).returning({ id: deals.id });
  return d.id;
}
async function thread(athleteId: string, dealId: string, v: Record<string, unknown>, sender: string, when: string): Promise<string> {
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: dealId, status: "deal_detected", message_count: 1, last_message_at: at(when), ...v } as any).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", sender_email: sender, received_at: at(when) } as any);
  return t.id;
}

/** One athlete: a real deal with its counterparty's mail, an e-sign pseudo-deal beside it, and an invite that became a deal. */
async function seed(p: { name: string; sport: string; brand: string; domain: string; contact: string; esign: string; inviteSender: string; inviteSubject: string }): Promise<Seeded> {
  const athleteId = await seedAthlete(p.name);
  await db.update(athletes).set({ sport: p.sport } as any).where(eq(athletes.id, athleteId));
  const b = await brand(p.brand, p.domain);
  const realOpp = await opp(athleteId, b, "2026-09-01T00:00:00Z");
  const realDeal = await deal(athleteId, b, p.brand, realOpp, "negotiating");
  await thread(athleteId, realDeal, { brand_id: b, message_count: 4, classification: { category: "PAID" } }, p.contact, "2026-09-02T00:00:00Z");
  const esignDeal = await deal(athleteId, b, p.brand, realOpp, "detected");
  await thread(athleteId, esignDeal, { status: "archived", summary: "Signature requested", classification: { category: "PAID", brand_domain: p.esign } }, `dse@${p.esign}`, "2026-09-10T00:00:00Z");
  const inviteOpp = await opp(athleteId, b, "2026-10-01T00:00:00Z");
  const inviteDeal = await deal(athleteId, b, p.brand, inviteOpp, "detected");
  const inviteThread = await thread(athleteId, inviteDeal, { brand_id: b, subject: p.inviteSubject, classification: { category: "PAID" } }, p.inviteSender, "2026-10-01T00:00:00Z");
  return { athleteId, realDeal, realOpp, esignDeal, inviteDeal, inviteThread };
}

async function snapshot() {
  return JSON.stringify({
    deals: await db.select().from(deals).orderBy(asc(deals.id)),
    threads: await db.select().from(inboxThreads).orderBy(asc(inboxThreads.id)),
    opps: await db.select().from(opportunities).orderBy(asc(opportunities.id)),
  });
}
const idsOf = (p: AutoFoldPlan) => [
  ...p.paperwork.folds.flatMap((f) => [f.pseudo_deal_id, f.target_deal_id, f.thread_id]),
  ...p.invites.flatMap((i) => [i.pseudo_deal_id, i.target_deal_id, i.thread_id]),
];

let swimmer: Seeded;
let climber: Seeded;
let unmatchedInvite = "";
let quietAthlete = "";

beforeAll(async () => {
  await initTestDb();
  // A swimmer whose brand contact sends the invite herself (placed by counterparty).
  swimmer = await seed({
    name: "Rowan Vale", sport: "swimming", brand: "Tidewater Goggles", domain: "tidewater.test", contact: "lena@tidewater.test",
    esign: "docusign.net", inviteSender: "lena@tidewater.test",
    inviteSubject: "Invitation: Tidewater x Rowan kickoff @ Wed Oct 14, 2026 10am - 10:30am (EDT) (rowan@example.com)",
  });
  // A climber whose invite came from the Google Calendar notifier (placed by the brand already on the invite deal).
  climber = await seed({
    name: "Kai Ortega", sport: "climbing", brand: "Granite Chalk Co", domain: "granitechalk.test", contact: "sam@granitechalk.test",
    esign: "hellosign.com", inviteSender: "calendar-notification@google.com",
    inviteSubject: "Invitation: Granite Chalk sync @ Tue Oct 13, 2026 2pm - 2:30pm (PDT) (kai@example.com)",
  });
  // The climber also has an invite for a brand with no real deal: nothing to fold it into, so it is left alone.
  const lone = await brand("Summit Rope Works", "summitrope.test");
  const loneOpp = await opp(climber.athleteId, lone, "2026-10-02T00:00:00Z");
  unmatchedInvite = await deal(climber.athleteId, lone, "Summit Rope Works", loneOpp, "detected");
  await thread(climber.athleteId, unmatchedInvite, { brand_id: lone, subject: "Invitation: Summit Rope intro @ Fri Oct 16, 2026 9am - 9:30am (MDT) (kai@example.com)" }, "calendar-notification@google.com", "2026-10-02T00:00:00Z");
  quietAthlete = await seedAthlete("Noor Halden");
});
afterAll(async () => { await closeTestDb(); });

describe("athlete selection", () => {
  it("parses --all, lists and files; refuses empty, mixed and malformed selections", async () => {
    expect(parseAthleteSelection(["--all"])).toEqual({ all: true, ids: [] });
    expect(parseAthleteSelection(["--athlete", swimmer.athleteId, "--athletes", `${climber.athleteId},${swimmer.athleteId}`]))
      .toEqual({ all: false, ids: [swimmer.athleteId, climber.athleteId] });
    expect(parseAthleteSelection(["--ids-file", "x"], () => `# reviewed\n${climber.athleteId}\n\n`)).toEqual({ all: false, ids: [climber.athleteId] });
    expect(() => parseAthleteSelection([])).toThrow(/no athletes selected/);
    expect(() => parseAthleteSelection(["--all", "--athlete", swimmer.athleteId])).toThrow(/either --all/);
    expect(() => parseAthleteSelection(["--athlete", "rowan"])).toThrow(/not an athlete uuid/);
    expect((await resolveAthletes(db, { all: true, ids: [] })).sort()).toEqual([swimmer.athleteId, climber.athleteId, quietAthlete].sort());
    await expect(resolveAthletes(db, { all: false, ids: ["00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(/not found/);
  });
});

describe("auto-detect fold planner", () => {
  let plans: Map<string, AutoFoldPlan>;

  it("plans every athlete, read-only, one plan each, and writes nothing", async () => {
    const before = await snapshot();
    const ids = await resolveAthletes(db, { all: true, ids: [] });
    // Read-only by construction, as the CLI's dry-run session is: any write in planning would throw.
    await client.exec("SET default_transaction_read_only = on");
    let outcomes;
    try {
      // The guard is real: a write in this session fails.
      await expect(db.update(deals).set({ status: "accepted" } as any).where(eq(deals.id, swimmer.realDeal))).rejects.toThrow(/read-only/);
      outcomes = await forEachAthlete(ids, (id) => planAutoFold(db, id));
    }
    finally { await client.exec("SET default_transaction_read_only = off"); }
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(await snapshot()).toBe(before);

    plans = new Map(outcomes.map((o) => [o.athlete_id, o.result!]));
    expect([...plans.values()].map((p) => p.athlete_id).sort()).toEqual(ids.sort());
    expect(isEmptyPlan(plans.get(quietAthlete)!)).toBe(true);

    const s = plans.get(swimmer.athleteId)!;
    expect(s.paperwork.folds).toEqual([expect.objectContaining({ pseudo_deal_id: swimmer.esignDeal, target_deal_id: swimmer.realDeal, event: "signature_requested" })]);
    expect(s.invites).toEqual([expect.objectContaining({ pseudo_deal_id: swimmer.inviteDeal, target_deal_id: swimmer.realDeal, thread_id: swimmer.inviteThread, close_opportunity: true })]);
    expect(s.invites[0].meeting).toMatchObject({ event: "invited", start: { date: "2026-10-14", time: "10:00" } });
    expect(s.invite_unresolved).toEqual([]);

    const c = plans.get(climber.athleteId)!;
    expect(c.paperwork.folds.map((f) => [f.pseudo_deal_id, f.target_deal_id])).toEqual([[climber.esignDeal, climber.realDeal]]);
    expect(c.invites.map((i) => [i.pseudo_deal_id, i.target_deal_id])).toEqual([[climber.inviteDeal, climber.realDeal]]);
    expect(c.invite_unresolved).toEqual([expect.objectContaining({ pseudo_deal_id: unmatchedInvite, reason: expect.stringMatching(/no open deal/) })]);

    // Per athlete: no plan names another athlete's rows.
    const swimmerIds = Object.values(swimmer).filter((v) => v !== swimmer.athleteId);
    const climberIds = Object.values(climber).filter((v) => v !== climber.athleteId);
    expect(idsOf(s).some((id) => climberIds.includes(id))).toBe(false);
    expect(idsOf(c).some((id) => swimmerIds.includes(id))).toBe(false);
    expect(renderAutoFold(s, "dry-run")).toContain("Split: not auto-detected");
  });

  it("applies one reviewed plan for its athlete only, refuses replays, and undoes", async () => {
    const reviewed: AutoFoldPlan = JSON.parse(JSON.stringify(plans.get(swimmer.athleteId)!));
    const climberBefore = JSON.stringify(await db.select().from(deals).where(eq(deals.athlete_id, climber.athleteId)).orderBy(asc(deals.id)));

    const receipt = await applyAutoFold(db, reviewed);
    expect(receipt.applied).toMatchObject({ paperwork_folded: 1, invites_folded: 1 });
    const [esign] = await db.select().from(deals).where(eq(deals.id, swimmer.esignDeal));
    expect(esign).toMatchObject({ status: "rejected", opportunity_id: null });
    expect((esign.raw_data as any).retired).toMatchObject({ as: "paperwork", target_deal_id: swimmer.realDeal });
    const [inv] = await db.select().from(deals).where(eq(deals.id, swimmer.inviteDeal));
    expect((inv.raw_data as any).retired).toMatchObject({ as: "meeting", target_deal_id: swimmer.realDeal });
    const [invThread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, swimmer.inviteThread));
    expect(invThread.deal_id).toBeNull();
    expect((invThread.classification as any).meeting).toMatchObject({ state: "matched", deal_id: swimmer.realDeal, matched_by: "legacy_fold" });
    const [real] = await db.select().from(deals).where(eq(deals.id, swimmer.realDeal));
    expect(real).toMatchObject({ status: "negotiating", opportunity_id: swimmer.realOpp });
    // The other athlete is untouched.
    expect(JSON.stringify(await db.select().from(deals).where(eq(deals.athlete_id, climber.athleteId)).orderBy(asc(deals.id)))).toBe(climberBefore);

    // A receipt is not a plan; the reviewed plan is now stale (nothing is detected any more).
    await expect(applyAutoFold(db, receipt)).rejects.toThrow(/already applied/);
    await expect(applyAutoFold(db, reviewed)).rejects.toThrow(/stale plan/);
    expect(isEmptyPlan(await planAutoFold(db, swimmer.athleteId))).toBe(true);

    await undoAutoFold(db, receipt);
    const [esign2] = await db.select().from(deals).where(eq(deals.id, swimmer.esignDeal));
    expect(esign2).toMatchObject({ status: "detected", opportunity_id: swimmer.realOpp });
    expect((esign2.raw_data as any)?.retired).toBeUndefined();
    const [inv2] = await db.select().from(deals).where(eq(deals.id, swimmer.inviteDeal));
    expect(inv2.status).toBe("detected");
    const [invThread2] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, swimmer.inviteThread));
    expect(invThread2.deal_id).toBe(swimmer.inviteDeal);
    // Undone, the same candidates are detected again.
    const again = await planAutoFold(db, swimmer.athleteId);
    expect(again.paperwork.folds.map((f) => f.pseudo_deal_id)).toEqual([swimmer.esignDeal]);
    expect(again.invites.map((i) => i.pseudo_deal_id)).toEqual([swimmer.inviteDeal]);
  });
});
