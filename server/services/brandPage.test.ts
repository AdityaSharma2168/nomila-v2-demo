/**
 * brandPage + the board's one-card-per-brand fold (docs/design/brand-page-deals.md D4, D5), against PGlite.
 * gorjana's shape: a signed (won) endorsement with old e-sign pseudo-deals as paperwork, and a separate pitch she
 * wrote — two sections, one card with "2 deals · 1 signed …". A single-deal brand has one section and no line.
 * Tenancy holds. No provider is reached; nothing writes.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../skills/dealGrouping", () => ({ partitionOrNull: jest.fn(async () => null) }));

import { eq } from "drizzle-orm";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { readBrandPage } from "./brandPage";
import { dealPositions, readOpportunityBoard } from "./opportunityBoard";
import { confirmSigned } from "../skills/dealSigning";

const NOW = new Date("2026-10-07T12:00:00Z");
let athleteId = "";
let other = "";
let seq = 0;
const PDF = (filename: string) => ({ filename, content_type: "application/pdf", bytes: 10, parsed: true, gcs_path: "x" });

async function brand(name: string) {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${++seq}` } as any).returning({ id: inboxBrands.id });
  return b.id;
}
async function opportunity(who: string, brandId: number) {
  const at = new Date("2026-09-20T12:00:00Z");
  const [o] = await db.insert(opportunities).values({ athlete_id: who, brand_id: brandId, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
  return o.id;
}
async function deal(who: string, oppId: string, o: {
  status?: string; stage?: string; domain?: string; awaiting?: string; ext?: string; summary?: string; direction?: string;
  messages?: Array<{ dir: "inbound" | "outbound"; at: string; chain?: string; attachments?: any[] }>;
}) {
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: "gorjana", status: o.status ?? "detected", opportunity_id: oppId, direction: o.direction ?? null, detected_at: new Date("2026-08-01T00:00:00Z") } as any).returning({ id: deals.id });
  const msgs = o.messages ?? [{ dir: "inbound", at: "2026-08-10T00:00:00Z" }];
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: who, deal_id: d.id, subject: null, status: "deal_detected", message_count: msgs.length, external_thread_id: o.ext ?? `ext-${++seq}`,
    last_message_at: new Date(msgs[msgs.length - 1].at), summary: o.summary ?? null,
    classification: { category: "PAID", qualification: "workable", ...(o.domain ? { brand_domain: o.domain } : {}) },
    conversation_state: { ...(o.stage ? { deal_stage: o.stage } : {}), key_details: { awaiting_response_from: o.awaiting ?? "brand" } },
  } as any).returning({ id: inboxThreads.id });
  for (const m of msgs) {
    await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: m.dir, received_at: new Date(m.at), gmail_thread_id: m.chain ?? o.ext ?? null, attachments: m.attachments ?? null } as any);
  }
  return { dealId: d.id, threadId: t.id };
}

let gorjana = 0;
let endorsementOpp = "";
let pitchOpp = "";
let endorsement = { dealId: "", threadId: "" };
let pitch = { dealId: "", threadId: "" };
let soloOpp = "";

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  other = await seedAthlete("Other");

  gorjana = await brand("gorjana");
  endorsementOpp = await opportunity(athleteId, gorjana);
  endorsement = await deal(athleteId, endorsementOpp, { status: "accepted", ext: "19fac", messages: [
    { dir: "inbound", at: "2026-07-29T00:00:00Z" }, { dir: "outbound", at: "2026-07-30T00:00:00Z" },
    { dir: "outbound", at: "2026-10-05T00:00:00Z", chain: "1a10dc60" }, { dir: "inbound", at: "2026-10-06T00:00:00Z", chain: "1a10dc60" },
  ] });
  await db.update(opportunities).set({ lead_thread_id: endorsement.threadId } as any).where(eq(opportunities.id, endorsementOpp));
  // Pre-#777 Adobe Sign pseudo-deals: paperwork, never sections.
  await deal(athleteId, endorsementOpp, { stage: "signed", domain: "adobesign.com", summary: "Completed: agreement signed", messages: [{ dir: "inbound", at: "2026-08-15T02:02:00Z", attachments: [PDF("Release - signed.pdf")] }] });
  await deal(athleteId, endorsementOpp, { domain: "adobesign.com", summary: "Signature requested on the release", messages: [{ dir: "inbound", at: "2026-08-12T00:00:00Z" }] });
  expect((await confirmSigned(athleteId, endorsementOpp, null, NOW)).ok).toBe(true);

  // The new pitch she wrote: its own opportunity of the same brand, her move.
  pitchOpp = await opportunity(athleteId, gorjana);
  pitch = await deal(athleteId, pitchOpp, { status: "detected", awaiting: "athlete", messages: [
    { dir: "outbound", at: "2026-10-05T00:00:00Z" }, { dir: "inbound", at: "2026-10-06T00:00:00Z" },
  ] });
  await db.update(opportunities).set({ lead_thread_id: pitch.threadId, last_activity_at: new Date("2026-10-06T00:00:00Z") } as any).where(eq(opportunities.id, pitchOpp));

  soloOpp = await opportunity(athleteId, await brand("Solo"));
  const solo = await deal(athleteId, soloOpp, { status: "negotiating", messages: [{ dir: "inbound", at: "2026-09-01T00:00:00Z" }] });
  await db.update(opportunities).set({ lead_thread_id: solo.threadId } as any).where(eq(opportunities.id, soloOpp));
});
afterAll(async () => { await closeTestDb(); });

it("gorjana: two sections (the pitch that needs her, the signed endorsement); e-sign mail is the endorsement's paperwork", async () => {
  const page = (await readBrandPage(athleteId, endorsementOpp, NOW))!;
  expect(page.brand).toEqual({ id: gorjana, name: "gorjana" });
  expect(page.sections.map((s) => s.deal_id)).toEqual([pitch.dealId, endorsement.dealId]);
  expect(page.open_section).toBe(pitch.dealId);

  const [p, e] = page.sections;
  expect(p).toMatchObject({ opportunity_status: "open", label: "New", pitched_by_you: true, needs_her: true, paperwork: [] });
  expect(e).toMatchObject({ opportunity_status: "won", label: "Signed", pitched_by_you: false, looks_signed: false });
  expect(e.signed?.source).toBe("confirmed");
  expect(e.paperwork.map((r) => r.label)).toEqual(["Signed by all parties", "Sent for signature"]);
  expect(e.paperwork[0].files).toEqual([expect.objectContaining({ filename: "Release - signed.pdf", index: 0, signed: true })]);
  expect(e.contract_candidate?.filename).toBe("Release - signed.pdf");
  // The folded-in chain is listed (counts, dates, who wrote first) — never a subject.
  expect(e.conversation?.chains).toEqual([
    expect.objectContaining({ chain_id: "19fac", main: true, message_count: 2, first_direction: "inbound" }),
    expect.objectContaining({ chain_id: "1a10dc60", main: false, message_count: 2, first_direction: "outbound" }),
  ]);
  expect(JSON.stringify(page)).not.toMatch(/subject/i);
});

it("the board keeps ONE gorjana card with the brand line, and still places every gorjana deal", async () => {
  const board = await readOpportunityBoard(athleteId, NOW);
  const all = [...board.whatMatters, ...board.needsTermsBatch, ...board.inMotion, ...board.explore, ...board.toVerify];
  const cards = all.filter((i) => i.brand.id === gorjana);
  expect(cards).toHaveLength(1);
  expect(cards[0].brand_rollup?.line).toBe("2 deals · 1 signed");
  expect(cards[0].opportunity_id).toBe(pitchOpp);
  expect(cards[0].pitched_by_you).toBe(true); // she wrote first
  expect(new Set(cards[0].brand_opportunity_ids)).toEqual(new Set([endorsementOpp, pitchOpp]));
  const pos = dealPositions(board);
  expect(pos.get(endorsement.dealId)).toBe(pos.get(pitch.dealId));
});

it("a single-deal brand: one section, no brand line", async () => {
  const page = (await readBrandPage(athleteId, soloOpp, NOW))!;
  expect(page.sections).toHaveLength(1);
  expect(page.sections[0]).toMatchObject({ label: "Negotiating", shares_opportunity: false });
  const board = await readOpportunityBoard(athleteId, NOW);
  const card = [...board.whatMatters, ...board.needsTermsBatch, ...board.inMotion, ...board.explore].find((i) => i.opportunity_id === soloOpp)!;
  expect(card.brand_rollup).toBeNull();
});

it("tenancy: another athlete gets nothing for her opportunity", async () => {
  expect(await readBrandPage(other, endorsementOpp, NOW)).toBeNull();
  expect(await readBrandPage(other, pitchOpp, NOW)).toBeNull();
});

it("section dates come from the messages: started = first message of every chain, never a re-stamped row; signed when signed", async () => {
  const oppId = await opportunity(athleteId, await brand("Datesco"));
  const d = await deal(athleteId, oppId, { status: "accepted", ext: "dates-main", messages: [
    { dir: "inbound", at: "2026-08-02T00:00:00Z" }, { dir: "outbound", at: "2026-09-30T21:45:05Z" },
    { dir: "inbound", at: "2026-07-31T00:00:00Z", chain: "dates-folded" },
  ] });
  // As a re-process left them: the thread, the deal row and the opportunity all read "today".
  await db.update(inboxThreads).set({ last_message_at: NOW } as any).where(eq(inboxThreads.id, d.threadId));
  await db.update(deals).set({ detected_at: NOW, signed_at: new Date("2026-08-15T02:02:45Z"), signed_source: "confirmed" } as any).where(eq(deals.id, d.dealId));
  await db.update(opportunities).set({ lead_thread_id: d.threadId, last_activity_at: NOW } as any).where(eq(opportunities.id, oppId));

  const [s] = (await readBrandPage(athleteId, oppId, NOW))!.sections;
  expect(s.started_at).toBe("2026-07-31T00:00:00.000Z");
  expect(s.last_activity_at).toBe("2026-09-30T21:45:05.000Z");
  expect(s.conversation?.last_at).toBe("2026-09-30T21:45:05.000Z");
  expect(s.signed?.at).toBe("2026-08-15T02:02:45.000Z");
});

it("a deal with no conversation starts when it was detected", async () => {
  const oppId = await opportunity(athleteId, await brand("Manualco"));
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Manualco", status: "accepted", opportunity_id: oppId, detected_at: new Date("2026-08-20T00:00:00Z") } as any).returning({ id: deals.id });
  const [s] = (await readBrandPage(athleteId, oppId, NOW))!.sections.filter((x) => x.deal_id === d.id);
  expect(s.started_at).toBe("2026-08-20T00:00:00.000Z");
});
