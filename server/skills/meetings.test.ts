/**
 * Calendar invites are meetings, never deals (skills/meetings + the dealDetector gate). Against PGlite with mocked
 * messages; the classifier, Kimi, the summarizer, brand research and the brand resolver are mocked at their
 * boundaries and asserted NOT called — an invite costs no model call.
 *
 *   · the gorjana invite lands as a meeting on her most recently active open gorjana deal: no deal, no opportunity
 *   · the brand page lists it on that deal's timeline as "Call · Mon 12 Oct, 11am"
 *   · an organisation-domain match when the organiser has not written before; closed deals are skipped
 *   · no deal with that brand → the thread is kept with an unmatched marker and no deal
 *   · an updated invite on the same calendar thread re-records the meeting, still no deal
 *   · zero retention: the title (the invite's own words) is not stored
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(async () => ({ choices: [{ message: { content: "{}" } }] })) }));
jest.mock("../lib/models", () => {
  const generateContent = jest.fn();
  const client = { models: { generateContent } };
  return {
    genai: () => client,
    GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
    KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
  };
});
jest.mock("../lib/brandResolver", () => ({ resolveBrandIdentity: jest.fn(async () => null) }));
jest.mock("./threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));
jest.mock("./researchBrand", () => ({ researchBrand: jest.fn(async () => undefined) }));
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));
jest.mock("./dealGrouping", () => ({ partitionOrNull: jest.fn(async () => null), adoptGroupForNewDeal: jest.fn(async () => null) }));

import { eq, sql } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { placeMeeting } from "./meetings";
import { readBrandPage } from "../services/brandPage";
import { genai } from "../lib/models";
import { kimiInstant } from "../lib/kimi";
import { resolveBrandIdentity } from "../lib/brandResolver";
import { summarizeThread } from "./threadSummarizer";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;
const noModel = () => {
  expect(classifyMock).not.toHaveBeenCalled();
  expect(kimiInstant as jest.Mock).not.toHaveBeenCalled();
  expect(summarizeThread as jest.Mock).not.toHaveBeenCalled();
  expect(resolveBrandIdentity as jest.Mock).not.toHaveBeenCalled();
};

let seq = 0;
const at = (iso: string) => new Date(iso);
const INVITE = "Invitation: gorjana x Mia Bhuta Connect @ Mon Oct 12, 2026 11am - 11:30am (PDT) (mia@example.com)";
const BODY = "gorjana x Mia Bhuta Connect\nMonday Oct 12, 2026 ⋅ 11am – 11:30am\n\nOrganizer\nMichelle Garcia\nmichelle@gorjana.test\n";

async function brand(name: string, domain: string): Promise<number> {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name}-${++seq}`, domain } as any).returning({ id: inboxBrands.id });
  return b.id;
}

/** An open opportunity with one deal whose thread holds mail from `from` at `last`. */
async function deal(athleteId: string, brandId: number, o: { from: string; last: string; status?: string; oppStatus?: "open" | "closed" }) {
  const closed = o.oppStatus === "closed";
  const [opp] = await db.insert(opportunities).values({
    athlete_id: athleteId, brand_id: brandId, status: closed ? "closed" : "open", close_reason: closed ? "expired" : null, closed_at: closed ? at(o.last) : null,
    opened_at: at("2026-07-01T00:00:00Z"), last_activity_at: at(o.last),
  } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_id: brandId, brand_name: "gorjana", status: o.status ?? "detected", opportunity_id: opp.id,
    detected_at: at("2026-07-01T00:00:00Z"), source: "inbox_scan",
  } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, brand_id: brandId, deal_id: d.id, status: "deal_detected", message_count: 1, last_message_at: at(o.last),
    external_thread_id: `deal-${++seq}`, classification: { category: "PAID" },
  } as any).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", sender_email: o.from, received_at: at(o.last) } as any);
  return { dealId: d.id as string, oppId: opp.id as string };
}

const send = (athleteId: string, connectionId: string, id: string, thread: string, subject = INVITE, from = "Michelle Garcia <michelle@gorjana.test>") =>
  detectDeal({
    athleteId, connectionId,
    message: { gmailMessageId: id, gmailThreadId: thread, subject, from, body: BODY, date: "2026-10-08T03:32:11Z", messageIdHeader: `<${id}@x>`, labelIds: ["INBOX"] },
  });

const count = async (table: any, athleteId: string) =>
  Number((await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.athlete_id, athleteId)))[0].n);

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });
beforeEach(() => jest.clearAllMocks());

it("the gorjana invite is a meeting on her most recently active open gorjana deal — no deal, no opportunity, no model", async () => {
  const athleteId = await seedAthlete();
  const inbox = await seedConnection({ athleteId, email: `mia${++seq}@example.com` });
  const b = await brand("gorjana", "gorjana.test");
  const older = await deal(athleteId, b, { from: "michelle@gorjana.test", last: "2026-10-05T00:00:00Z", status: "accepted" });
  const newer = await deal(athleteId, b, { from: "michelle@gorjana.test", last: "2026-10-07T00:00:00Z" });
  await deal(athleteId, b, { from: "michelle@gorjana.test", last: "2026-10-08T00:00:00Z", status: "rejected" });
  const deals0 = await count(deals, athleteId);
  const opps0 = await count(opportunities, athleteId);

  const r = await send(athleteId, inbox, "inv-1", "cal-1");
  expect(r).toMatchObject({ skipped: false, reason: "meeting_matched" });
  expect(r.dealId).toBeUndefined();
  expect(await count(deals, athleteId)).toBe(deals0);
  expect(await count(opportunities, athleteId)).toBe(opps0);
  noModel();

  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
  expect(t.deal_id).toBeNull();
  expect((t.classification as any).meeting).toMatchObject({
    state: "matched", event: "invited", deal_id: newer.dealId, opportunity_id: newer.oppId, brand_id: b, matched_by: "counterparty",
    start: { date: "2026-10-12", time: "11:00", tz: "PDT" }, title: "gorjana x Mia Bhuta Connect",
  });

  // The brand page: the call sits on that deal's timeline, not the other one's.
  const page = (await readBrandPage(athleteId, older.oppId, at("2026-10-08T12:00:00Z")))!;
  const sec = (id: string) => page.sections.find((s) => s.deal_id === id)!;
  expect(sec(newer.dealId).paperwork).toEqual([expect.objectContaining({ thread_id: t.id, event: "meeting", label: "Call · Mon 12 Oct, 11am", files: [] })]);
  expect(sec(older.dealId).paperwork).toEqual([]);
  expect(sec(newer.dealId).looks_signed).toBe(false);

  // Google's "Updated invitation" on the same calendar thread: re-recorded, still no deal.
  const u = await send(athleteId, inbox, "inv-2", "cal-1", "Updated invitation: gorjana x Mia Bhuta Connect @ Tue Oct 13, 2026 2pm - 2:30pm (PDT) (mia@example.com)");
  expect(u).toMatchObject({ skipped: false, threadId: t.id });
  expect(await count(deals, athleteId)).toBe(deals0);
  const [t2] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
  expect((t2.classification as any).meeting).toMatchObject({ event: "updated", deal_id: newer.dealId, start: { date: "2026-10-13", time: "14:00" } });
  noModel();
});

it("an organiser who has not written before matches by the brand's domain; closed engagements are skipped", async () => {
  const athleteId = await seedAthlete();
  const inbox = await seedConnection({ athleteId, email: `mia${++seq}@example.com` });
  const b = await brand("gorjana", "gorjana.test");
  const open = await deal(athleteId, b, { from: "someone@gorjana.test", last: "2026-09-01T00:00:00Z" });
  await deal(athleteId, b, { from: "x@gorjana.test", last: "2026-10-01T00:00:00Z", oppStatus: "closed" });
  const r = await send(athleteId, inbox, "inv-3", "cal-3", INVITE, "Casey <casey@gorjana.test>");
  expect(r.reason).toBe("meeting_matched");
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
  expect((t.classification as any).meeting).toMatchObject({ state: "matched", deal_id: open.dealId, matched_by: "brand_domain" });
  noModel();
});

it("no deal with that brand: the invite is kept as a thread with no deal (unmatched)", async () => {
  const athleteId = await seedAthlete();
  const inbox = await seedConnection({ athleteId, email: `mia${++seq}@example.com` });
  const r = await send(athleteId, inbox, "inv-5", "cal-5", INVITE, "Someone <someone@unknownco.test>");
  expect(r).toMatchObject({ skipped: false, reason: "meeting_unmatched" });
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
  expect(t.deal_id).toBeNull();
  expect((t.classification as any).meeting).toMatchObject({ state: "unmatched", event: "invited" });
  expect((t.classification as any).meeting.deal_id).toBeUndefined();
  expect(await count(deals, athleteId)).toBe(0);
  expect(await count(opportunities, athleteId)).toBe(0);
  noModel();
});

it("zero retention: the decision is stored, the invite's own title is not", async () => {
  const athleteId = await seedAthlete();
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, status: "unread" } as any).returning({ id: inboxThreads.id });
  const m = await placeMeeting({
    athleteId, threadId: t.id, senderAddress: "x@nowhere.test", retainContent: false,
    invite: { event: "invited", title: "Secret project sync", start: { date: "2026-10-12", time: "11:00", tz: "PDT" }, organizer: null, signals: ["calendar_part"] },
  });
  expect(m).toMatchObject({ state: "unmatched", title: null, start: { date: "2026-10-12", time: "11:00" } });
  const [row] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
  expect(JSON.stringify(row.classification)).not.toContain("Secret project");
});
