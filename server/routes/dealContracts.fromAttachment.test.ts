/**
 * Reading a contract that already arrived by email, and putting its terms on the deal it
 * belongs to rather than beside it.
 *
 * gorjana's signed agreement reached the app on 15 Aug as an email attachment. It went
 * into the bucket, was parsed, and showed up in the deal's Attachments section — where the
 * only thing anyone could do with it was download it. The one route into extraction was
 * the + button, which always INSERTS, so taking it would have listed gorjana twice on the
 * Opportunities screen: the group of six the mailbox found, and a lone row holding the
 * real schedule.
 *
 * Real Express router against PGlite; auth, GCS and the model mocked.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/inboxAttachmentStore", () => ({
  ...jest.requireActual("../lib/inboxAttachmentStore"),
  getAttachment: jest.fn(async () => Buffer.from("%PDF-1.4 pretend")),
  signedAttachmentUploadUrl: jest.fn(),
}));
jest.mock("../services/contractExtract", () => ({
  ...jest.requireActual("../services/contractExtract"),
  extractContract: jest.fn(),
}));
jest.mock("../lib/brandResolver", () => ({ resolveBrand: jest.fn(async () => null) }));
jest.mock("../skills/dealGrouping", () => ({ adoptGroupForNewDeal: jest.fn(async () => null) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, isNull, and } from "drizzle-orm";
import contractsRouter from "./dealContracts";
import { extractContract } from "../services/contractExtract";
import { getAttachment } from "../lib/inboxAttachmentStore";
import { deals, dealPeriods, inboxThreads, inboxMessages, opportunities, type InboxAttachment } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

function asUser(id: string) { (globalThis as any).__TEST_ATHLETE_ID = id; }

const SIGNED: InboxAttachment = {
  filename: "GORJANA_Athlete_Endorsement_Release_signed.pdf",
  content_type: "application/pdf", bytes: 466_694,
  gcs_path: "athletes/a/inbox/82aea2cd/GORJANA_signed.pdf", parsed: true,
};

/** The shape extractContract returns for gorjana, reduced to what these routes read. */
const GORJANA_EXTRACT = {
  brand: "GORJANA & GRIFFIN, LLC",
  term_start: "2026-08-12", term_end: "2027-08-11",
  term_conditional: false, term_note: null,
  cash_schedule: [{ period: "Aug 2026 - Aug 2027", amount: 7500, conditional: false, product: 6500 }],
  product_per_year: 6500, product_directed_per_year: null, product_note: null,
  contingent: [], deliverables: [],
  exclusivity: { exists: true, scope: "jewelry" },
  signed: true, signature_evidence: "none" as const,
  truncated: false, chars_seen: 16_580, chars_total: 16_580,
  caveat: null, agreement: null,
  deal_type: "ambassador",
  deal_type_reason: "Wears the product exclusively, hosts, gives interviews and posts.",
};

async function seedDeal(aid: string, attachments: InboxAttachment[] | null) {
  const [d] = await db.insert(deals).values({
    athlete_id: aid, brand_name: "gorjana", status: "detected", source: "inbox_scan",
    deal_type: "social_post", raw_data: { origin: "inbox_scan", summary: "Partnership proposal" },
  }).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: aid, deal_id: d.id, subject: "Partnership", status: "deal_detected",
  }).returning({ id: inboxThreads.id });
  const [m] = await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: aid, direction: "inbound", subject: "Signature request",
    body: "Please countersign.", received_at: new Date(), attachments,
  }).returning({ id: inboxMessages.id });
  return { dealId: d.id, messageId: m.id };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

const livePeriods = (dealId: string) =>
  db.select().from(dealPeriods)
    .where(and(eq(dealPeriods.deal_id, dealId), isNull(dealPeriods.superseded_at)));

beforeAll(async () => {
  await initTestDb();
  athleteId      = await seedAthlete();
  otherAthleteId = await seedAthlete();
  asUser(athleteId);
  const app = express();
  app.use(express.json());
  app.use("/", contractsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  asUser(athleteId);
  (extractContract as jest.Mock).mockReset();
  (getAttachment as jest.Mock).mockClear();
  (extractContract as jest.Mock).mockResolvedValue({
    status: "parsed", extract: GORJANA_EXTRACT, text: "ATHLETE ENDORSEMENT AGREEMENT",
  });
});

describe("POST /deals/:id/contract/from-attachment", () => {
  it("reads a contract already on the deal's own thread", async () => {
    const { dealId, messageId } = await seedDeal(athleteId, [SIGNED]);
    const { status, json } = await post(`/deals/${dealId}/contract/from-attachment`, { messageId, index: 0 });

    expect(status).toBe(200);
    expect(json.readable).toBe(true);
    expect(json.parsed).toBe(true);
    expect(json.filename).toBe("GORJANA_Athlete_Endorsement_Release_signed.pdf");
    // The model's own reading, and the sentence behind it — both go to the review screen.
    expect(json.dealType).toBe("ambassador");
    expect(json.dealTypeReason).toMatch(/wears the product exclusively/i);
    // The client never names the object; the path is resolved here from the message row.
    expect(getAttachment).toHaveBeenCalledWith(SIGNED.gcs_path);
  });

  it("writes nothing — this is the extract step", async () => {
    const { dealId, messageId } = await seedDeal(athleteId, [SIGNED]);
    await post(`/deals/${dealId}/contract/from-attachment`, { messageId, index: 0 });
    expect(await livePeriods(dealId)).toHaveLength(0);
  });

  it("never leaks the GCS path to the caller", async () => {
    const { dealId, messageId } = await seedDeal(athleteId, [SIGNED]);
    const { json } = await post(`/deals/${dealId}/contract/from-attachment`, { messageId, index: 0 });
    expect(JSON.stringify(json)).not.toContain("athletes/a/inbox");
  });

  it("refuses an attachment on another athlete's deal", async () => {
    const theirs = await seedDeal(otherAthleteId, [SIGNED]);
    asUser(athleteId);
    const { status } = await post(
      `/deals/${theirs.dealId}/contract/from-attachment`, { messageId: theirs.messageId, index: 0 });
    expect(status).toBe(404);
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it("refuses a message that rides no thread of this deal", async () => {
    const a = await seedDeal(athleteId, [SIGNED]);
    const b = await seedDeal(athleteId, [SIGNED]);
    // b's message is hers, but it belongs to a different deal.
    const { status } = await post(`/deals/${a.dealId}/contract/from-attachment`, { messageId: b.messageId, index: 0 });
    expect(status).toBe(404);
  });

  it("404s on an index past the end rather than reading something else", async () => {
    const { dealId, messageId } = await seedDeal(athleteId, [SIGNED]);
    expect((await post(`/deals/${dealId}/contract/from-attachment`, { messageId, index: 7 })).status).toBe(404);
    expect((await post(`/deals/${dealId}/contract/from-attachment`, { messageId, index: -1 })).status).toBe(404);
  });

  it("reports an unreadable scan as a fact, not an error", async () => {
    (extractContract as jest.Mock).mockResolvedValue({ status: "unreadable", reason: "Could not read that file" });
    const { dealId, messageId } = await seedDeal(athleteId, [SIGNED]);
    const { status, json } = await post(`/deals/${dealId}/contract/from-attachment`, { messageId, index: 0 });

    // 200: she fills the form herself. Extraction is an accelerator, never a dependency.
    expect(status).toBe(200);
    expect(json.readable).toBe(false);
    expect(json.extract).toBeNull();
  });
});

describe("POST /deals/:id/contract — terms onto a deal that already exists", () => {
  const CONFIRMED = {
    extract: GORJANA_EXTRACT,
    signed: true,
    deal_type: "social_post",
    periods: [{
      label: "Aug 2026 – Aug 2027", starts_on: "2026-08-12", ends_on: "2027-08-11",
      cash: 7500, product: 6500, product_directed: null,
      conditional: false, condition: null, source_quote: "Seven Thousand five hundred dollars ($7,500)",
    }],
  };

  it("puts the schedule on the existing deal instead of minting a second one", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    const before = await db.select().from(deals);

    const { status, json } = await post(`/deals/${dealId}/contract`, CONFIRMED);
    expect(status).toBe(200);
    expect(json.periods).toBe(1);

    // The whole point: no new row.
    expect(await db.select().from(deals)).toHaveLength(before.length);

    const [period] = await livePeriods(dealId);
    expect(period.cash_cents).toBe(750_000);
    expect(period.product_cents).toBe(650_000);
    expect(period.guaranteed).toBe(true);
  });

  it("takes her chosen type over the model's", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    await post(`/deals/${dealId}/contract`, CONFIRMED);   // she said social_post; model said ambassador
    const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.deal_type).toBe("social_post");
  });

  it("supersedes an earlier schedule rather than deleting it", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    await post(`/deals/${dealId}/contract`, CONFIRMED);
    const first = await livePeriods(dealId);
    expect(first).toHaveLength(1);

    // An amendment: the same year, renegotiated upward.
    await post(`/deals/${dealId}/contract`, {
      ...CONFIRMED,
      periods: [{ ...CONFIRMED.periods[0], cash: 9000 }],
    });

    const live = await livePeriods(dealId);
    expect(live).toHaveLength(1);
    expect(live[0].cash_cents).toBe(900_000);

    // The replaced row is stamped, not gone — a payment reconciled against it still resolves.
    const all = await db.select().from(dealPeriods).where(eq(dealPeriods.deal_id, dealId));
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.superseded_at != null)).toHaveLength(1);
  });

  it("carries the term across and marks a signed contract accepted", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    await post(`/deals/${dealId}/contract`, CONFIRMED);
    const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.term_start).toBe("2026-08-12");
    expect(d.term_end).toBe("2027-08-11");
    expect(d.status).toBe("accepted");
  });

  it("keeps deals.source — it records how the deal was FOUND, not what we know about it", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    await post(`/deals/${dealId}/contract`, CONFIRMED);
    const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.source).toBe("inbox_scan");
  });

  it("merges raw_data rather than overwriting how the deal was detected", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    await post(`/deals/${dealId}/contract`, CONFIRMED);
    const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    const rd = d.raw_data as Record<string, any>;
    expect(rd.summary).toBe("Partnership proposal");   // the detector's account survives
    expect(rd.contract).not.toBeNull();
  });

  it("refuses a type the deals CHECK constraint would reject", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    const { status } = await post(`/deals/${dealId}/contract`, { ...CONFIRMED, deal_type: "sponsorship" });
    expect(status).toBe(400);
  });

  it("will not write onto another athlete's deal", async () => {
    const theirs = await seedDeal(otherAthleteId, [SIGNED]);
    asUser(athleteId);
    const { status } = await post(`/deals/${theirs.dealId}/contract`, CONFIRMED);
    expect(status).toBe(404);
    expect(await livePeriods(theirs.dealId)).toHaveLength(0);
  });
});

describe("from-attachment: the signed PDF on a paperwork thread or a sibling deal (brand-page-deals D3)", () => {
  async function sameOpportunity(aid: string) {
    const [o] = await db.insert(opportunities).values({ athlete_id: aid, status: "open", opened_at: new Date(), last_activity_at: new Date() } as any).returning({ id: opportunities.id });
    const real = await seedDeal(aid, null);
    const esign = await seedDeal(aid, [SIGNED]);
    await db.update(deals).set({ opportunity_id: o.id } as any).where(eq(deals.id, real.dealId));
    await db.update(deals).set({ opportunity_id: o.id } as any).where(eq(deals.id, esign.dealId));
    return { real, esign, oppId: o.id };
  }

  it("reads a PDF that rides a sibling deal's thread in the SAME opportunity (a pre-#777 e-sign pseudo-deal)", async () => {
    const { real, esign } = await sameOpportunity(athleteId);
    const { status } = await post(`/deals/${real.dealId}/contract/from-attachment`, { messageId: esign.messageId, index: 0 });
    expect(status).toBe(200);
  });

  it("reads a PDF on a paperwork thread matched to the deal", async () => {
    const real = await seedDeal(athleteId, null);
    const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, subject: null, status: "unread",
      classification: { paperwork: { state: "matched", event: "completed", deal_id: real.dealId } } } as any).returning({ id: inboxThreads.id });
    const [m] = await db.insert(inboxMessages).values({ thread_id: t.id, athlete_id: athleteId, direction: "inbound", received_at: new Date(), attachments: [SIGNED] } as any).returning({ id: inboxMessages.id });
    const { status } = await post(`/deals/${real.dealId}/contract/from-attachment`, { messageId: m.id, index: 0 });
    expect(status).toBe(200);
  });

  it("never crosses tenants: her sibling's PDF is not reachable from another athlete's deal", async () => {
    const { esign } = await sameOpportunity(athleteId);
    const theirs = await seedDeal(otherAthleteId, null);
    asUser(otherAthleteId);
    const { status } = await post(`/deals/${theirs.dealId}/contract/from-attachment`, { messageId: esign.messageId, index: 0 });
    expect(status).toBe(404);
  });

  it("saving terms marked signed records her confirmation (signed_at, source contract) once", async () => {
    const { dealId } = await seedDeal(athleteId, [SIGNED]);
    await post(`/deals/${dealId}/contract`, { signed: true, extract: GORJANA_EXTRACT });
    const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.signed_source).toBe("contract");
    expect(d.signed_at).not.toBeNull();
    const first = d.signed_at;
    await post(`/deals/${dealId}/contract`, { signed: true, extract: GORJANA_EXTRACT });
    const [again] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(again.signed_at).toEqual(first);
  });
});
