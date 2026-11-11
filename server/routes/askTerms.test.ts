/**
 * askTerms.test.ts — WS4 batch PROPOSE endpoint, end to end against in-memory Postgres
 * (PGlite) with Gmail/auth/summarizer mocked (same harness as pendingActions.test.ts).
 *
 * The co-pilot invariant under test: POST /deals/ask-terms-batch creates N
 * `pending_action`s and sends NOTHING — approve (the existing path) is the only thing
 * that sends. Also: ownership, the batch cap, priced/filed/settled deals are skipped,
 * the composed request_terms body NEVER names a rate, and the per-row edit endpoint
 * updates the exact body that a later approve would send.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/integrations/gmail", () => ({
  fetchMessageThreadingInfo: jest.fn(),
  sendGmailReply:            jest.fn(),
}));
jest.mock("../lib/integrations/instagram", () => ({
  sendInstagramDM: jest.fn(),
}));
jest.mock("../skills/threadSummarizer", () => ({
  summarizeThread:              jest.fn(async () => null),
  updateMechanicalThreadState:  jest.fn(async () => undefined),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import askTermsRouter from "./askTerms";
import pendingActionsRouter from "./pendingActions";
import { composeRequestTermsBody, segmentFor, computeMissingTerms, askingLabels, needsTermsSkip } from "./askTerms";
import { sendGmailReply } from "../lib/integrations/gmail";
import { deals, inboxThreads, inboxMessages, pendingActions } from "../../shared/schema";
import { bodySha256 } from "../../shared/bodyHash";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const sendMock = sendGmailReply as jest.Mock;
let sentSeq = 0;
let fixtureSeq = 0;

let server: Server;
let base: string;
let athleteId: string, otherAthleteId: string, inbox: string;

function asUser(id: string) {
  (globalThis as any).__TEST_ATHLETE_ID = id;
}

/** Seed an unpriced deal + thread + one inbound gmail message. */
async function seedUnpriced(
  owner: string,
  over: { amount?: string | null; status?: string; threadStatus?: string; classification?: any; conversationState?: any; lastMessageAt?: Date; noInbound?: boolean } = {},
) {
  const [deal] = await db
    .insert(deals)
    .values({ athlete_id: owner, brand_name: "Acme", status: over.status ?? "detected", amount: over.amount ?? null } as any)
    .returning();
  const [thread] = await db
    .insert(inboxThreads)
    .values({
      athlete_id:           owner,
      subject:              "Collab?",
      deal_id:              deal.id,
      status:               over.threadStatus ?? "unread",
      connected_account_id: inbox,
      classification:       over.classification ?? null,
      conversation_state:   over.conversationState ?? null,
      last_message_at:      over.lastMessageAt ?? new Date(),
    } as any)
    .returning();
  if (!over.noInbound) {
    await db.insert(inboxMessages).values({
      thread_id:               thread.id,
      athlete_id:              owner,
      direction:               "inbound",
      sender_email:            "brand@acme.com",
      sender_name:             "Jordan Lee",
      subject:                 "Collab?",
      body:                    "We'd love to work with you!",
      platform:                "gmail",
      connected_account_id:    inbox,
      gmail_thread_id:         "gt-1",
      gmail_message_id_header: `<orig-${++fixtureSeq}@acme>`,
      received_at:             new Date(Date.UTC(2026, 0, 1)),
    } as any);
  }
  return { dealId: deal.id, threadId: thread.id };
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId      = await seedAthlete("Jamie Fox");
  otherAthleteId = await seedAthlete("Someone Else");
  inbox          = await seedConnection({ athleteId, email: "me@gmail.com" });

  const app = express();
  app.use(express.json());
  app.use("/", askTermsRouter);
  app.use("/", pendingActionsRouter); // for the approve-sends leg
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Gmail assigns a DISTINCT Message-ID to every message it sends. A constant here
  // made two sends in one suite collide on inbox_messages_athlete_msgid_uniq.
  sendMock.mockImplementation(async () => `<sent-${++sentSeq}@mail.gmail.com>`);
  asUser(athleteId);
});

// ─── Pure composer ─────────────────────────────────────────────────────────────

const ALL_MISSING: ("price" | "deliverables" | "timeline")[] = ["price", "deliverables", "timeline"];

describe("composeRequestTermsBody — money-safe, variant-aware, gap-targeted", () => {
  it("never names a dollar figure, in any variant", () => {
    for (const segment of ["fresh", "agency", "quiet", "old"] as const) {
      const body = composeRequestTermsBody({
        segment, missing: ALL_MISSING, includeUsage: true,
        brandName: "Acme", senderName: "Jordan Lee",
        athleteFullName: "Jamie Fox", signaturePref: null,
      });
      expect(body).not.toMatch(/\$\s?\d/);      // no "$500"
      expect(body).not.toMatch(/\b\d{3,}\b/);   // no bare 3+ digit number
      expect(body.length).toBeGreaterThan(40);
      expect(body).toContain("Jordan");         // greeting used the sender name
    }
  });
  it("asks for budget + timeline when both are missing", () => {
    const body = composeRequestTermsBody({
      segment: "fresh", missing: ALL_MISSING, includeUsage: false,
      brandName: "Acme", senderName: null, athleteFullName: "Jamie Fox", signaturePref: null,
    });
    expect(body.toLowerCase()).toContain("budget");
    expect(body.toLowerCase()).toContain("timeline");
  });
  it("asks ONLY for the missing term — no re-asking what they gave", () => {
    // Only timeline missing → mentions timeline, NOT budget or deliverables.
    const body = composeRequestTermsBody({
      segment: "fresh", missing: ["timeline"], includeUsage: false,
      brandName: "Acme", senderName: null, athleteFullName: "Jamie Fox", signaturePref: null,
    });
    expect(body.toLowerCase()).toContain("timeline");
    expect(body.toLowerCase()).not.toContain("budget");
    expect(body.toLowerCase()).not.toContain("deliverables");
  });
  it("includeUsage toggles the usage/exclusivity confirm line", () => {
    const withUsage = composeRequestTermsBody({ segment: "fresh", missing: ["price"], includeUsage: true,  brandName: "Acme", senderName: null, athleteFullName: "J", signaturePref: null });
    const without   = composeRequestTermsBody({ segment: "fresh", missing: ["price"], includeUsage: false, brandName: "Acme", senderName: null, athleteFullName: "J", signaturePref: null });
    expect(withUsage.toLowerCase()).toContain("usage rights");
    expect(without.toLowerCase()).not.toContain("usage rights");
  });
});

describe("computeMissingTerms — per-deal gap detection from structured fields", () => {
  it("all three missing on a bare thread (no offer, no deliverables, no deadline)", () => {
    const r = computeMissingTerms({ offer_amount: null, deliverables: [], deadline: null }, {});
    expect(r.missing.sort()).toEqual(["deliverables", "price", "timeline"]);
    expect(r.includeUsage).toBe(true);
  });
  it("PRICE not missing when a guaranteed cash amount is in offer_struct", () => {
    const r = computeMissingTerms(
      { offer_amount: null, deliverables: [], deadline: null },
      { key_details: { offer_struct: { amount: 500, unit: "per_post" } } },
    );
    expect(r.missing).not.toContain("price");
  });
  it("PRICE still missing for gifting_only / commission_only (no cash)", () => {
    const gifting = computeMissingTerms(
      { offer_amount: null, deliverables: ["1 reel"], deadline: "2026-08-01" },
      { key_details: { offer_struct: { amount: null, unit: "gifting_only" } } },
    );
    expect(gifting.missing).toEqual(["price"]);
    expect(gifting.includeUsage).toBe(false); // gifting-only omits the usage line
  });
  it("DELIVERABLES not missing when classification lists them", () => {
    const r = computeMissingTerms({ offer_amount: null, deliverables: ["2 posts"], deadline: null }, {});
    expect(r.missing).not.toContain("deliverables");
  });
  it("DELIVERABLES not missing when offer_struct.deliverable_counts is populated", () => {
    const r = computeMissingTerms(
      { offer_amount: null, deliverables: [], deadline: null },
      { key_details: { offer_struct: { deliverable_counts: { posts: 3 } } } },
    );
    expect(r.missing).not.toContain("deliverables");
  });
  it("TIMELINE not missing when a deadline exists (classification OR thread deadlines)", () => {
    expect(computeMissingTerms({ offer_amount: null, deliverables: [], deadline: "2026-09-01" }, {}).missing).not.toContain("timeline");
    expect(computeMissingTerms({ offer_amount: null, deliverables: [], deadline: null }, { key_details: { deadlines: ["2026-09-01"] } }).missing).not.toContain("timeline");
  });
});

describe("needsTermsSkip — an unverifiable sender is never in the batch", () => {
  it("skips channel unverifiable whatever the qualification", () => {
    expect(needsTermsSkip({ qualification: "needs_terms", channel: "unverifiable" }, null, null)).toBe("unverifiable_sender");
    expect(needsTermsSkip({ qualification: "needs_terms", channel: "agency" }, null, null)).toBeNull();
  });
  it("never asks an interview or school request for terms", () => {
    expect(needsTermsSkip({ qualification: "needs_terms", category: "MEDIA" }, null, null)).toBe("not_needs_terms");
    expect(needsTermsSkip({ qualification: "needs_terms", category: "SCHOOL_NIL" }, null, null)).toBe("not_needs_terms");
  });
});

describe("needsTermsSkip — qualification first, the old unpriced rule as fallback", () => {
  it("a needs_terms thread is a candidate even when an amount is on the deal", () => {
    expect(needsTermsSkip({ qualification: "needs_terms" }, "800", null)).toBeNull();
  });
  it("termed qualifications are already priced; the rest are not a terms conversation", () => {
    expect(needsTermsSkip({ qualification: "workable" }, null, null)).toBe("already_priced");
    expect(needsTermsSkip({ qualification: "below_floor" }, null, null)).toBe("already_priced");
    expect(needsTermsSkip({ qualification: "verify_first" }, null, null)).toBe("not_needs_terms");
    expect(needsTermsSkip({ qualification: "not_relevant" }, null, null)).toBe("not_needs_terms");
  });
  it("a stored workable that is paid with no amount (cash plus product, no figure) is a candidate (23 Oct)", () => {
    const cls = { qualification: "workable", qualification_reason: "Terms are stated (cash plus product); it isn't a cash-only offer, so it isn't measured against your floor." };
    expect(needsTermsSkip(cls, null, null)).toBeNull();
    // Any stated figure keeps it priced.
    expect(needsTermsSkip(cls, "500", null)).toBe("already_priced");
    expect(needsTermsSkip(cls, null, { key_details: { offer_struct: { amount: 500 } } })).toBe("already_priced");
    expect(needsTermsSkip({ ...cls, offer_amount: 500 }, null, null)).toBe("already_priced");
  });
  it("threads without a qualification keep the old rule", () => {
    expect(needsTermsSkip({}, null, null)).toBeNull();
    expect(needsTermsSkip(null, "800", null)).toBe("already_priced");
    expect(needsTermsSkip({}, null, { key_details: { amounts: [500] } })).toBe("already_priced");
    expect(needsTermsSkip({}, null, { key_details: { offer_struct: { amount: 6500 } } })).toBe("already_priced");
    expect(needsTermsSkip({}, null, { key_details: { offer_struct: { amount: null }, amounts: [] } })).toBeNull();
  });
});

describe("askingLabels", () => {
  it("maps missing terms to friendly labels + appends usage when on", () => {
    expect(askingLabels(["price", "timeline"], true)).toEqual(["budget", "timeline", "usage"]);
    expect(askingLabels(["deliverables"], false)).toEqual(["deliverables"]);
  });
});

describe("segmentFor — sender-type wins, else age", () => {
  const now = new Date(Date.UTC(2026, 6, 26));
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  it("agency beats age", () => {
    expect(segmentFor({ viaAgency: true, lastActivity: ago(200), now })).toBe("agency");
  });
  it("fresh/quiet/old by age", () => {
    expect(segmentFor({ viaAgency: false, lastActivity: ago(5),  now })).toBe("fresh");
    expect(segmentFor({ viaAgency: false, lastActivity: ago(45), now })).toBe("quiet");
    expect(segmentFor({ viaAgency: false, lastActivity: ago(120), now })).toBe("old");
  });
});

// ─── The batch endpoint ─────────────────────────────────────────────────────────

describe("POST /deals/ask-terms-batch — proposes, NOTHING sends", () => {
  it("creates N pending_actions in 'pending' and sends nothing", async () => {
    const a = await seedUnpriced(athleteId, { lastMessageAt: new Date() });
    const b = await seedUnpriced(athleteId, { classification: { via_agency: true } });

    const r = await api("POST", "/deals/ask-terms-batch", { dealIds: [a.dealId, b.dealId] });

    expect(r.status).toBe(201);
    expect(r.json.created).toHaveLength(2);
    expect(r.json.skipped).toHaveLength(0);
    for (const pa of r.json.created) {
      expect(pa.status).toBe("pending");
      expect(pa.kind).toBe("send_reply");
      expect(pa.payload.reply_intent).toBe("request_terms");
      expect(pa.payload.source).toBe("ask_terms_batch");
      expect(typeof pa.payload.body).toBe("string");
      expect(pa.payload.body).not.toMatch(/\$\s?\d/); // no rate
      expect(pa.approved_at).toBeNull();
    }
    // The agency deal got the agency variant.
    const agencyPa = r.json.created.find((p: any) => p.deal_id === b.dealId);
    expect(agencyPa.payload.segment).toBe("agency");

    // ← THE INVARIANT: proposing sent nothing.
    expect(sendMock).not.toHaveBeenCalled();

    // Rows really exist, all pending.
    const rows = await db.select().from(pendingActions).where(eq(pendingActions.athlete_id, athleteId));
    expect(rows.filter((x) => x.status === "pending").length).toBeGreaterThanOrEqual(2);
  });

  it("personalizes the ask to THIS brand's gaps (deliverables + deadline known → asks only budget)", async () => {
    const d = await seedUnpriced(athleteId, {
      classification: { deliverables: ["2 IG posts"], deadline: "2026-09-01" }, // deliverables + timeline KNOWN
    });
    const r = await api("POST", "/deals/ask-terms-batch", { dealIds: [d.dealId] });
    const pa = r.json.created[0];
    expect(pa.payload.missing).toEqual(["price"]);           // only price unresolved
    expect(pa.payload.asking).toContain("budget");
    expect(pa.payload.asking).not.toContain("deliverables"); // don't re-ask what they gave
    expect(pa.payload.asking).not.toContain("timeline");
    expect(pa.payload.body.toLowerCase()).toContain("budget");
    expect(pa.payload.body.toLowerCase()).not.toContain("deliverables and scope");
  });

  it("skips priced / filed / settled / no-thread deals with reasons (partial batch)", async () => {
    const ok      = await seedUnpriced(athleteId);
    const priced  = await seedUnpriced(athleteId, { amount: "800" });
    // A figure stated in the summariser's structured offer (the retired scorer's "priced" came from these).
    const scored  = await seedUnpriced(athleteId, { conversationState: { key_details: { amounts: [500] } } });
    const filed   = await seedUnpriced(athleteId, { threadStatus: "archived" });
    const settled = await seedUnpriced(athleteId, { status: "accepted" });
    const noInb   = await seedUnpriced(athleteId, { noInbound: true });

    const r = await api("POST", "/deals/ask-terms-batch", {
      dealIds: [ok.dealId, priced.dealId, scored.dealId, filed.dealId, settled.dealId, noInb.dealId],
    });

    expect(r.status).toBe(201);
    expect(r.json.created).toHaveLength(1);
    expect(r.json.created[0].deal_id).toBe(ok.dealId);

    const reasonFor = (id: string) => r.json.skipped.find((s: any) => s.deal_id === id)?.reason;
    expect(reasonFor(priced.dealId)).toBe("already_priced");
    expect(reasonFor(scored.dealId)).toBe("already_priced");
    expect(reasonFor(filed.dealId)).toBe("filed");
    expect(reasonFor(settled.dealId)).toBe("not_open");
    expect(reasonFor(noInb.dealId)).toBe("no_thread");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips low-value threads defensively (gifting-only / commission-only)", async () => {
    const gifting = await seedUnpriced(athleteId, { conversationState: { key_details: { offer_struct: { unit: "gifting_only" } } } });
    const comm    = await seedUnpriced(athleteId, { conversationState: { key_details: { offer_struct: { unit: "commission_only" } } } });
    const ok      = await seedUnpriced(athleteId);

    const r = await api("POST", "/deals/ask-terms-batch", {
      dealIds: [gifting.dealId, comm.dealId, ok.dealId],
    });
    expect(r.json.created).toHaveLength(1);
    expect(r.json.created[0].deal_id).toBe(ok.dealId);
    const reasonFor = (id: string) => r.json.skipped.find((s: any) => s.deal_id === id)?.reason;
    expect(reasonFor(gifting.dealId)).toBe("gifting_only");
    expect(reasonFor(comm.dealId)).toBe("commission_only");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("reads the thread's qualification (needs_terms) instead of the unpriced rule when it exists", async () => {
    const needs    = await seedUnpriced(athleteId, { amount: "800", classification: { qualification: "needs_terms" } });
    const workable = await seedUnpriced(athleteId, { classification: { qualification: "workable" } });
    const verify   = await seedUnpriced(athleteId, { classification: { qualification: "verify_first" } });
    const legacy   = await seedUnpriced(athleteId);

    const r = await api("POST", "/deals/ask-terms-batch", {
      dealIds: [needs.dealId, workable.dealId, verify.dealId, legacy.dealId],
    });
    expect(r.json.created.map((p: any) => p.deal_id).sort()).toEqual([needs.dealId, legacy.dealId].sort());
    const reasonFor = (id: string) => r.json.skipped.find((s: any) => s.deal_id === id)?.reason;
    expect(reasonFor(workable.dealId)).toBe("already_priced");
    expect(reasonFor(verify.dealId)).toBe("not_needs_terms");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("never proposes on another athlete's deal (ownership → skipped not_found)", async () => {
    const theirs = await seedUnpriced(otherAthleteId);
    asUser(athleteId);
    const r = await api("POST", "/deals/ask-terms-batch", { dealIds: [theirs.dealId] });
    expect(r.status).toBe(201);
    expect(r.json.created).toHaveLength(0);
    expect(r.json.skipped[0].reason).toBe("not_found");
  });

  it("dedups repeated dealIds (one proposal per deal)", async () => {
    const a = await seedUnpriced(athleteId);
    const r = await api("POST", "/deals/ask-terms-batch", { dealIds: [a.dealId, a.dealId, a.dealId] });
    expect(r.json.created).toHaveLength(1);
  });

  it("400s an over-cap batch (> 100)", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    const r = await api("POST", "/deals/ask-terms-batch", { dealIds: ids });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/at most 100/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("400s on a missing / non-array dealIds", async () => {
    expect((await api("POST", "/deals/ask-terms-batch", {})).status).toBe(400);
    expect((await api("POST", "/deals/ask-terms-batch", { dealIds: "nope" })).status).toBe(400);
    expect((await api("POST", "/deals/ask-terms-batch", { dealIds: [] })).status).toBe(400);
  });
});

// ─── Approve is what sends (paced loop leg) ─────────────────────────────────────

describe("approve → the ONLY send path", () => {
  it("a proposed ask sends exactly once through the reply service on approve", async () => {
    const a = await seedUnpriced(athleteId);
    const proposed = await api("POST", "/deals/ask-terms-batch", { dealIds: [a.dealId] });
    const paId = proposed.json.created[0].id;
    const sentBody = proposed.json.created[0].payload.body;
    expect(sendMock).not.toHaveBeenCalled();

    // A batch row needs its own review: without `reviewed: true` it is refused, unsent.
    const unreviewed = await api("POST", `/pending-actions/${paId}/approve`, { body_sha256: bodySha256(sentBody) });
    expect(unreviewed.status).toBe(409);
    expect(unreviewed.json.code).toBe("NOT_REVIEWED");
    expect(sendMock).not.toHaveBeenCalled();

    const r = await api("POST", `/pending-actions/${paId}/approve`, { body_sha256: bodySha256(sentBody), reviewed: true });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("approved");
    expect(typeof r.json.payload.reviewed_at).toBe("string");
    expect(sendMock).toHaveBeenCalledTimes(1);
    // What was read is what was sent — the exact proposed body.
    expect(sendMock.mock.calls[0][0]).toMatchObject({ toEmail: "brand@acme.com", body: sentBody });
  });
});

// ─── Per-row edit endpoint ──────────────────────────────────────────────────────

describe("PATCH /deals/ask-terms/:id — edit the exact body before send", () => {
  it("updates the pending proposal's body (and marks edited); never sends", async () => {
    const a = await seedUnpriced(athleteId);
    const proposed = await api("POST", "/deals/ask-terms-batch", { dealIds: [a.dealId] });
    const paId = proposed.json.created[0].id;

    const edit = await api("PATCH", `/deals/ask-terms/${paId}`, { body: "Hi — quick one: what's your budget and timeline?" });
    expect(edit.status).toBe(200);
    expect(edit.json.payload.body).toContain("quick one");
    expect(edit.json.payload.edited).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();

    // The edited body is what approve sends.
    const r = await api("POST", `/pending-actions/${paId}/approve`, { body_sha256: bodySha256(edit.json.payload.body), reviewed: true });
    expect(r.status).toBe(200);
    expect(sendMock.mock.calls[0][0].body).toContain("quick one");
  });

  it("400s an empty body; 404s another athlete's proposal; 409s a non-pending one", async () => {
    const a = await seedUnpriced(athleteId);
    const proposed = await api("POST", "/deals/ask-terms-batch", { dealIds: [a.dealId] });
    const paId = proposed.json.created[0].id;

    expect((await api("PATCH", `/deals/ask-terms/${paId}`, { body: "   " })).status).toBe(400);

    asUser(otherAthleteId);
    expect((await api("PATCH", `/deals/ask-terms/${paId}`, { body: "hi" })).status).toBe(404);

    asUser(athleteId);
    await api("POST", `/pending-actions/${paId}/approve`, { body_sha256: bodySha256(proposed.json.created[0].payload.body), reviewed: true }); // now approved (terminal)
    expect((await api("PATCH", `/deals/ask-terms/${paId}`, { body: "too late" })).status).toBe(409);
  });

  it("400s editing a non-ask-terms pending action", async () => {
    // Create a plain send_reply proposal via pendingActions (source != ask_terms_batch).
    const a = await seedUnpriced(athleteId);
    const [pa] = await db.insert(pendingActions).values({
      athlete_id: athleteId, deal_id: a.dealId, thread_id: a.threadId,
      kind: "send_reply", status: "pending", payload: { body: "manual" },
    } as any).returning();
    const r = await api("PATCH", `/deals/ask-terms/${pa.id}`, { body: "nope" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/ask-terms/i);
  });
});
