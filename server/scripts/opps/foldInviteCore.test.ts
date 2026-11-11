/**
 * foldInviteCore — a calendar invite that became its own deal (gorjana a60a3835) folded into the ThetaBreakers deal as
 * a meeting, against PGlite: the plan is read-only and reads the meeting off the stored subject; apply retires the
 * pseudo-deal, links the thread as a meeting on the target, closes the invite-only opportunity; the brand page then
 * shows "Call · Mon 12 Oct, 11am" on the target; undo restores every prior value. No provider is reached.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/dealGrouping", () => ({ partitionOrNull: jest.fn(async () => null) }));

import { eq } from "drizzle-orm";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { applyInviteFold, planInviteFold, renderInviteFold, undoInviteFold } from "./foldInviteCore";
import { readBrandPage } from "../../services/brandPage";

let athleteId = "";
let target = { dealId: "", oppId: "" };
let invite = { dealId: "", oppId: "", threadId: "" };
const at = (s: string) => new Date(s);

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  const [b] = await db.insert(inboxBrands).values({ name: "gorjana", normalized_name: "gorjana", domain: "gorjana.test" } as any).returning({ id: inboxBrands.id });
  const opp = async (when: string) => (await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: at(when), last_activity_at: at(when) } as any).returning({ id: opportunities.id }))[0].id;
  target.oppId = await opp("2026-10-05T00:00:00Z");
  const [td] = await db.insert(deals).values({ athlete_id: athleteId, brand_id: b.id, brand_name: "gorjana", status: "detected", direction: "outbound", opportunity_id: target.oppId, deal_group_id: target.oppId } as any).returning({ id: deals.id });
  target.dealId = td.id;
  await db.insert(inboxThreads).values({ athlete_id: athleteId, brand_id: b.id, deal_id: td.id, status: "deal_detected", message_count: 6, external_thread_id: "1a10dc60", classification: { category: "PAID" } } as any);

  invite.oppId = await opp("2026-10-08T03:32:11Z");
  const [id] = await db.insert(deals).values({ athlete_id: athleteId, brand_id: b.id, brand_name: "gorjana", status: "detected", deal_type: "social_post", opportunity_id: invite.oppId, deal_group_id: invite.oppId } as any).returning({ id: deals.id });
  invite.dealId = id.id;
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, brand_id: b.id, deal_id: id.id, status: "deal_detected", message_count: 1, external_thread_id: "1a119918",
    subject: "Invitation: gorjana x Mia Bhuta Connect @ Mon Oct 12, 2026 11am - 11:30am (PDT) (mia@example.com)", classification: { category: "PAID" },
    last_message_at: at("2026-10-08T03:32:29Z") } as any).returning({ id: inboxThreads.id });
  invite.threadId = t.id;
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, invite.oppId));
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", sender_email: "michelle@gorjana.test", received_at: at("2026-10-08T03:32:11Z") } as any);
});
afterAll(async () => { await closeTestDb(); });

it("plans read-only, applies as a meeting on the target, shows on the brand page, and undoes", async () => {
  const plan = await planInviteFold(db, athleteId, invite.dealId, target.dealId);
  expect(plan.problems).toEqual([]);
  expect(plan).toMatchObject({
    thread_id: invite.threadId, close_opportunity: true,
    meeting: { event: "invited", label: "Call · Mon 12 Oct, 11am", start: { date: "2026-10-12", time: "11:00" }, title: "gorjana x Mia Bhuta Connect" },
    prior: { deal: { status: "detected", opportunity_id: invite.oppId, deal_group_id: invite.oppId }, thread: { deal_id: invite.dealId, meeting: null } },
  });
  expect(renderInviteFold(plan, "dry-run")).toContain(`meeting "Call · Mon 12 Oct, 11am"`);
  // The plan wrote nothing.
  expect((await db.select().from(deals).where(eq(deals.id, invite.dealId)))[0].status).toBe("detected");

  const applied = await applyInviteFold(db, plan);
  const [d] = await db.select().from(deals).where(eq(deals.id, invite.dealId));
  expect(d).toMatchObject({ status: "rejected", opportunity_id: null, deal_group_id: null });
  expect((d.raw_data as any).retired).toMatchObject({ as: "meeting", target_deal_id: target.dealId });
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, invite.threadId));
  expect(t.deal_id).toBeNull();
  expect((t.classification as any).meeting).toMatchObject({ state: "matched", deal_id: target.dealId, opportunity_id: target.oppId, matched_by: "legacy_fold" });
  const [o] = await db.select().from(opportunities).where(eq(opportunities.id, invite.oppId));
  expect(o).toMatchObject({ status: "closed", close_reason: "not_relevant", lead_thread_id: null });
  const [tgt] = await db.select().from(deals).where(eq(deals.id, target.dealId));
  expect(tgt).toMatchObject({ status: "detected", opportunity_id: target.oppId });

  const page = (await readBrandPage(athleteId, target.oppId, at("2026-10-08T12:00:00Z")))!;
  expect(page.sections.map((s) => s.deal_id)).toEqual([target.dealId]);
  expect(page.sections[0].paperwork).toEqual([expect.objectContaining({ event: "meeting", label: "Call · Mon 12 Oct, 11am" })]);

  // Applying twice is refused by the plan (already retired).
  expect((await planInviteFold(db, athleteId, invite.dealId, target.dealId)).problems).toContain("the invite deal is already retired");

  await undoInviteFold(db, applied);
  const [d2] = await db.select().from(deals).where(eq(deals.id, invite.dealId));
  expect(d2).toMatchObject({ status: "detected", opportunity_id: invite.oppId, deal_group_id: invite.oppId });
  expect((d2.raw_data as any)?.retired).toBeUndefined();
  const [t2] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, invite.threadId));
  expect(t2.deal_id).toBe(invite.dealId);
  expect((t2.classification as any).meeting).toBeUndefined();
  const [o2] = await db.select().from(opportunities).where(eq(opportunities.id, invite.oppId));
  expect(o2).toMatchObject({ status: "open", close_reason: null, closed_at: null, lead_thread_id: invite.threadId });
});

it("refuses what is not hers, the same deal, and a thread that is not an invite", async () => {
  const other = await seedAthlete("Other");
  expect((await planInviteFold(db, other, invite.dealId, target.dealId)).problems).toEqual(expect.arrayContaining(["the invite deal is not hers", "the target deal is not hers"]));
  expect((await planInviteFold(db, athleteId, target.dealId, target.dealId)).problems).toEqual(expect.arrayContaining([
    "the invite deal and the target are the same deal", "the thread does not read as a calendar invite (subject shape)",
  ]));
  await expect(applyInviteFold(db, await planInviteFold(db, athleteId, target.dealId, target.dealId))).rejects.toThrow(/not applying/);
});
