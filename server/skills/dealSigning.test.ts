/**
 * dealSigning — "Looks signed — confirm?" reads EVERY member deal (summary, matched paperwork, pre-#777 e-sign
 * pseudo-deals, signed PDFs), never targets a pseudo-deal, and only her Yes writes: signed_at + won close +
 * a reversible receipt. After a won close the next new deal for the brand opens its own opportunity; an agency's
 * one open opportunity is unaffected. Tenancy holds. Against PGlite; no provider is reached.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
// The same-engagement partition calls a model; these tests never reach one.
jest.mock("./dealGrouping", () => ({ partitionOrNull: jest.fn(async () => null) }));

import { and, eq } from "drizzle-orm";
import { agentActions, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { confirmSigned, looksLikeSignedFile, readSigning, undoConfirmSigned } from "./dealSigning";
import { placeNewDeal } from "./opportunities";
import { readOpportunityBoard } from "../services/opportunityBoard";

const NOW = new Date("2026-10-07T12:00:00Z");
let athleteId = "";
let other = "";
let seq = 0;

async function brand(name: string, isAgency = false) {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${++seq}`, is_agency: isAgency } as any).returning({ id: inboxBrands.id });
  return b.id;
}
async function opportunity(who: string, brandId: number | null) {
  const at = new Date("2026-09-20T12:00:00Z");
  const [o] = await db.insert(opportunities).values({ athlete_id: who, brand_id: brandId, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
  return o.id;
}
async function deal(who: string, oppId: string, o: { status?: string; stage?: string; domain?: string; messages?: number; attachments?: any[] } = {}) {
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: "x", status: o.status ?? "detected", opportunity_id: oppId, detected_at: new Date("2026-08-01T00:00:00Z") } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: who, deal_id: d.id, subject: null, status: "deal_detected", message_count: o.messages ?? 1, last_message_at: new Date("2026-08-15T02:02:00Z"),
    classification: { category: "PAID", ...(o.domain ? { brand_domain: o.domain } : {}) },
    conversation_state: o.stage ? { deal_stage: o.stage } : {},
  } as any).returning({ id: inboxThreads.id });
  const [m] = await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", received_at: new Date("2026-08-15T02:02:00Z"), attachments: o.attachments ?? null } as any).returning({ id: inboxMessages.id });
  return { dealId: d.id, threadId: t.id, messageId: m.id };
}
async function paperworkThread(who: string, dealId: string, oppId: string, event: string, attachments: any[] | null = null) {
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: who, subject: null, status: "unread", message_count: 1, last_message_at: new Date("2026-08-16T00:00:00Z"),
    classification: { category: "PAID", paperwork: { state: "matched", kind: "status", event, deal_id: dealId, opportunity_id: oppId, source_message_ids: [], observed_at: "" } },
  } as any).returning({ id: inboxThreads.id });
  const [m] = await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", received_at: new Date("2026-08-16T00:00:00Z"), attachments } as any).returning({ id: inboxMessages.id });
  return { threadId: t.id, messageId: m.id };
}
const PDF = (filename: string) => ({ filename, content_type: "application/pdf", bytes: 10, parsed: true, gcs_path: "x" });

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  other = await seedAthlete("Other");
});
afterAll(async () => { await closeTestDb(); });

it("a signed-looking filename: signed / executed, never unsigned; PDFs only", () => {
  expect(looksLikeSignedFile(PDF("GORJANA_Release 2026_2027 2 (1) (2) - signed.pdf"))).toBe(true);
  expect(looksLikeSignedFile(PDF("Agreement_fully-executed.pdf"))).toBe(true);
  expect(looksLikeSignedFile(PDF("unsigned draft.pdf"))).toBe(false);
  expect(looksLikeSignedFile({ filename: "signed.png", content_type: "image/png" })).toBe(false);
});

it("gorjana's shape: the lead is accepted and reads outreach; a pre-#777 e-sign pseudo-deal reads signed and holds the PDF → asked, targeting the REAL deal", async () => {
  const b = await brand("gorjana");
  const o = await opportunity(athleteId, b);
  const lead = await deal(athleteId, o, { status: "accepted", stage: "outreach", messages: 65 });
  await db.update(opportunities).set({ lead_thread_id: lead.threadId } as any).where(eq(opportunities.id, o));
  const esign = await deal(athleteId, o, { status: "detected", stage: "signed", domain: "adobesign.com", attachments: [PDF("Release - signed.pdf")] });
  await deal(athleteId, o, { status: "detected", stage: "signed", domain: "echosign.com" });

  const s = await readSigning(athleteId, o);
  expect(s.looks_signed).toBe(true);
  expect(s.target_deal_id).toBe(lead.dealId);
  expect(new Set(s.evidence.map((e) => e.kind))).toEqual(new Set(["legacy_esign", "attachment"]));
  expect(s.evidence.every((e) => e.deal_id === lead.dealId)).toBe(true);
  expect(s.contract_candidate).toMatchObject({ message_id: esign.messageId, index: 0, filename: "Release - signed.pdf" });

  // Reading is a flag: nothing changed.
  const [row] = await db.select().from(deals).where(eq(deals.id, lead.dealId));
  expect(row.signed_at).toBeNull();

  // Her Yes.
  const out = await confirmSigned(athleteId, o, null, NOW);
  expect(out).toMatchObject({ ok: true, deal_id: lead.dealId, opportunity_id: o });
  const [after] = await db.select().from(deals).where(eq(deals.id, lead.dealId));
  expect(after.signed_source).toBe("confirmed");
  expect(after.status).toBe("accepted");
  const [closed] = await db.select().from(opportunities).where(eq(opportunities.id, o));
  expect(closed).toMatchObject({ status: "closed", close_reason: "won" });
  const receipts = await db.select().from(agentActions).where(and(eq(agentActions.athlete_id, athleteId), eq(agentActions.action, "confirm_signed")));
  expect(receipts).toHaveLength(1);
  expect(receipts[0].reversible).toBe(true);
  expect((receipts[0].payload as any).opportunity_id).toBe(o);

  // A second tap does not close twice or write a second receipt.
  expect(await confirmSigned(athleteId, o, null, NOW)).toMatchObject({ ok: false, status: 409 });

  // The signed endorsement still runs: In motion, "Signed".
  const board = await readOpportunityBoard(athleteId, NOW);
  const card = board.inMotion.find((i) => i.opportunity_id === o)!;
  expect(card.stage).toBe("Signed");
  expect(card.line.startsWith("Signed")).toBe(true);

  // After the won close, the next new deal for this brand opens its OWN opportunity.
  const nd = await deal(athleteId, o, {});
  await db.update(deals).set({ opportunity_id: null } as any).where(eq(deals.id, nd.dealId));
  const placed = await placeNewDeal({ athleteId, dealId: nd.dealId, threadId: nd.threadId, brandId: b });
  expect(placed).not.toBeNull();
  expect(placed).not.toBe(o);
});

it("matched e-sign paperwork (event completed) on a NON-lead member is evidence; a negotiating deal is lifted to accepted; undo restores it", async () => {
  const b = await brand("Acme");
  const o = await opportunity(athleteId, b);
  const a = await deal(athleteId, o, { status: "negotiating", messages: 4 });
  const side = await deal(athleteId, o, { status: "detected", messages: 1 });
  await paperworkThread(athleteId, side.dealId, o, "completed", [PDF("Contract executed.pdf")]);
  await paperworkThread(athleteId, a.dealId, o, "signature_requested");

  const s = await readSigning(athleteId, o);
  expect(s.looks_signed).toBe(true);
  expect(s.evidence.map((e) => e.kind).sort()).toEqual(["attachment", "paperwork"]);

  const out = await confirmSigned(athleteId, o, a.dealId, NOW);
  expect(out.ok).toBe(true);
  const [row] = await db.select().from(deals).where(eq(deals.id, a.dealId));
  expect(row.status).toBe("accepted");
  const [r] = await db.select().from(agentActions).where(eq(agentActions.id, (out as any).receipt_id));
  await undoConfirmSigned(athleteId, r.payload as any);
  const [back] = await db.select().from(deals).where(eq(deals.id, a.dealId));
  expect(back.signed_at).toBeNull();
  expect(back.signed_source).toBeNull();
  expect(back.status).toBe("negotiating");
});

it("nothing reads signed → no prompt; an agency's one open opportunity still absorbs its next deal", async () => {
  const ag = await brand("Some Agency", true);
  const o = await opportunity(athleteId, ag);
  await deal(athleteId, o, { status: "negotiating", stage: "negotiating" });
  expect((await readSigning(athleteId, o)).looks_signed).toBe(false);
  const nd = await deal(athleteId, o, {});
  await db.update(deals).set({ opportunity_id: null } as any).where(eq(deals.id, nd.dealId));
  expect(await placeNewDeal({ athleteId, dealId: nd.dealId, threadId: nd.threadId, brandId: ag })).toBe(o);
});

it("tenancy: another athlete cannot confirm or read her opportunity, and cannot target her deal", async () => {
  const b = await brand("Mine");
  const o = await opportunity(athleteId, b);
  const d = await deal(athleteId, o, { status: "negotiating", stage: "signed" });
  expect(await confirmSigned(other, o, null, NOW)).toMatchObject({ ok: false, status: 404 });
  expect((await readSigning(other, o)).looks_signed).toBe(false);
  const theirs = await opportunity(other, await brand("Theirs"));
  expect(await confirmSigned(other, theirs, d.dealId, NOW)).toMatchObject({ ok: false, status: 404 });
  const [row] = await db.select().from(deals).where(eq(deals.id, d.dealId));
  expect(row.signed_at).toBeNull();
});

it("a won engagement whose signed deal is past its term leaves the board", async () => {
  const o = await opportunity(athleteId, await brand("Oldco"));
  const d = await deal(athleteId, o, { status: "accepted", stage: "signed" });
  expect((await confirmSigned(athleteId, o, null, NOW)).ok).toBe(true);
  await db.update(deals).set({ term_end: "2026-01-31" } as any).where(eq(deals.id, d.dealId));
  const board = await readOpportunityBoard(athleteId, NOW);
  expect(board.order).not.toContain(o);
});
