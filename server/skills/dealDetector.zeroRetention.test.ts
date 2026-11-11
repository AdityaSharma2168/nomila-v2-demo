/**
 * MAILBOX_ZERO_RETENTION end to end — ingest through detectDeal with BOTH flags on
 * (MAILBOX_LIVE_READS + MAILBOX_ZERO_RETENTION), real SQL on PGlite. Every provider boundary
 * is mocked: classify (Gemini via lib/models), Kimi (summarizer + same-deal partition), brand
 * research, the Gmail integration (send), and the MAILBOX ADAPTER (an in-memory fake). No test
 * reaches a provider.
 *
 * With both flags on, ingest stores no body, no subject, no sender name, and no full address for
 * a sender who is not a counterparty — and still:
 *   · classifies, and writes the derived classification;
 *   · groups two threads of one brand into ONE opportunity;
 *   · places paperwork (an e-sign provider's mail) on the brand's deal;
 *   · summarizes via the LIVE read (the adapter is called, conversation_state is written);
 *   · sends a reply whose subject is read live, stores the outbound row without its text,
 *     and de-duplicates that reply's echo by body_sha256;
 *   · reads no stored body / subject / sender name anywhere on the way (SQL capture).
 * Flag off (either flag) = today's storage, unchanged.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(), kimiStream: jest.fn() }));
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
jest.mock("./researchBrand", () => ({ researchBrand: jest.fn(async () => undefined) }));
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));
// The phone hook (PR D): recorded here; its own rules (24 h, coalescing, the cap) are tested in services/push.
const pushBrandReplyMock = jest.fn();
jest.mock("../services/push/events", () => ({ pushBrandReply: (...a: unknown[]) => pushBrandReplyMock(...a) }));
jest.mock("../lib/integrations/gmail", () => ({
  fetchMessageThreadingInfo: jest.fn(async () => null),
  sendGmailReply:            jest.fn(async () => "<sent-reply-1@mail.gmail.com>"),
  deleteGmailDraft:          jest.fn(async () => true),
  refreshTokenIfNeeded:      jest.fn(async () => { throw new Error("tests never reach Gmail"); }),
}));

import { eq } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { sendThreadReply } from "../services/threadReply";
import { kimiInstant } from "../lib/kimi";
import { genai } from "../lib/models";
import { resolveBrandIdentity } from "../lib/brandResolver";
import { sendGmailReply } from "../lib/integrations/gmail";
import {
  directionFor,
  setMailboxAdapterForTests,
  type MailboxAdapter,
  type MailboxMessage,
} from "../lib/mailbox";
import { isPseudonymousSender, pseudonymousSender } from "../lib/mailbox/retention";
import { inboxBodyFingerprint } from "../lib/inboxBodyFingerprint";
import { deals, inboxBrands, inboxMessages, inboxThreads } from "../../shared/schema";
import { client, db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
const resolverMock = resolveBrandIdentity as jest.Mock;
const sendMock = sendGmailReply as jest.Mock;
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

const ATHLETE_EMAIL = "athlete@example.com";

// ─── The fake mailbox (the provider boundary) ────────────────────────────────

interface Rec { account: string; id: string; conv: string; from: string; subject: string; sentAt: string; text: string }
const records: Rec[] = [];
const calls = { conversation: 0, message: 0 };

function toMsg(r: Rec): MailboxMessage {
  const m = r.from.match(/<([^>]+)>/);
  const fromEmail = (m ? m[1] : r.from).toLowerCase();
  return {
    ref: { provider: "gmail", accountId: r.account, messageRef: r.id, conversationRef: r.conv, internetMessageId: `<${r.id}@x>` },
    from: r.from, fromEmail, fromName: r.from.match(/^([^<]+)</)?.[1].trim() ?? null,
    subject: r.subject, sentAt: r.sentAt, direction: directionFor(fromEmail, [ATHLETE_EMAIL]),
    text: r.text, attachments: [],
  };
}

const fakeAdapter: MailboxAdapter = {
  provider: "gmail",
  async fetchMessage(accountId, messageRef) {
    calls.message++;
    const r = records.find((x) => x.account === accountId && x.id === messageRef);
    if (!r) throw new Error("not in the fake mailbox");
    return toMsg(r);
  },
  async fetchConversation(accountId, conversationRef) {
    calls.conversation++;
    return records.filter((x) => x.account === accountId && x.conv === conversationRef).map(toMsg);
  },
  async fetchAttachment() { return { kind: "not_downloadable", reason: "link" }; },
  async search() { return []; },
};

// ─── Model stubs ─────────────────────────────────────────────────────────────

let nextClassification: Record<string, unknown>;
const PAID = {
  category: "PAID", confidence: 0.92, is_deal: true,
  brand_name: "Acme", brand_domain: "acme.com", advertiser: "Acme",
  agency_name: null, via_agency: false, advertiser_named: true,
  summary: "Acme proposes a paid Instagram partnership.", offer_amount: 5000,
  deliverables: ["2 reels"], deadline: null,
  contact_name: "Sarah", contact_email: "sarah@acme.com",
  channel: "direct", claims_known_brand: false,
  qualification: "workable", qualification_reason: "Acme states a cash offer.",
  cash_amount: 5000, comp_kind: "cash", work_kind: "social_post", work_units: 2,
};

const SUMMARY = {
  conversation_state: "Acme offered $5K for 2 reels; awaiting the athlete.",
  offer_display: "$5K · 2 reels",
  deal_stage: "negotiating",
  key_details: { offer: "$5K for 2 reels", offer_struct: { amount: 5000, unit: "total" }, ask: "2 reels", deadlines: [], amounts: [5000] },
  summary: "Acme wants two reels for $5,000.",
};

// ─── SQL capture ─────────────────────────────────────────────────────────────

async function captureSql<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const seen: string[] = [];
  const orig = client.query.bind(client);
  const spy = jest.spyOn(client, "query").mockImplementation(((q: any, ...rest: any[]) => {
    seen.push(String(q));
    return (orig as any)(q, ...rest);
  }) as any);
  try {
    return { result: await fn(), sql: seen };
  } finally {
    spy.mockRestore();
  }
}

/**
 * A SELECT (or a raw SQL read) that touches stored mail content: inbox_messages body / subject
 * / sender_name, or inbox_threads subject. sender_email is allowed on purpose (counterparty
 * address or pseudonym — decision 3); body_sha256 is a fingerprint, not content.
 */
function readsStoredContent(statements: string[]): string | undefined {
  return statements.find((s) => {
    // `NULL as "subject"` is the masked column, not a read of it.
    const q = s.replace(/\s+/g, " ").replace(/NULL as "\w+"/gi, "NULL");
    if (!/^\s*(select|with)\b/i.test(q)) return false;
    const msgs = /"inbox_messages"|\binbox_messages\b/i.test(q);
    const threads = /"inbox_threads"|\binbox_threads\b/i.test(q);
    if (msgs && /"inbox_messages"\."(body|subject|sender_name)"|[^_a-z]"(body|sender_name)"|\bm\.(body|subject|sender_name)\b|btrim\("inbox_messages"\."body"\)/i.test(q)) return true;
    if (threads && /"inbox_threads"\."subject"|\bt\.subject\b/i.test(q)) return true;
    if (msgs && /"subject"/.test(q) && !threads) return true;
    return false;
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let athleteId: string;
let accountId: string;
let brandId: number;
let seq = 0;

function incoming(id: string, conv: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId:  id,
    gmailThreadId:   conv,
    subject:         "Partnership with Acme — SUBJECT-SENTINEL",
    from:            "Sarah Lee <sarah@acme.com>",
    body:            "BODY-SENTINEL: we'd love two reels for $5,000.",
    date:            new Date(Date.UTC(2026, 9, 1, 0, ++seq)).toISOString(),
    messageIdHeader: `<${id}@mail.acme.com>`,
    labelIds:        ["INBOX"],
    ...over,
  };
}

/** Put the message in the fake mailbox too, as the provider would hold it. */
function deliver(m: ReturnType<typeof incoming>) {
  records.push({ account: accountId, id: m.gmailMessageId, conv: m.gmailThreadId, from: m.from, subject: m.subject, sentAt: m.date, text: m.body });
  return m;
}

const ENV_KEYS = ["MAILBOX_LIVE_READS", "MAILBOX_ZERO_RETENTION"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.MAILBOX_RETRY_BASE_MS = "1";
  await initTestDb();
  setMailboxAdapterForTests("gmail", fakeAdapter);

  classifyMock.mockImplementation(async () => ({ text: JSON.stringify(nextClassification) }));
  kimiMock.mockImplementation(async (system: string, user: string) => {
    if (String(system).includes("concern the SAME underlying brand deal")) {
      const n = String(user).split("\n").filter((l) => /^\[\d+\]/.test(l)).length;
      return { choices: [{ message: { content: JSON.stringify({ groups: [Array.from({ length: n }, (_, i) => i)] }) } }] };
    }
    return { choices: [{ message: { content: JSON.stringify(SUMMARY) } }] };
  });
});

afterAll(async () => {
  setMailboxAdapterForTests("gmail", undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

async function freshAthlete() {
  athleteId = await seedAthlete(`ZR athlete ${++seq}`);
  accountId = await seedConnection({ athleteId, email: ATHLETE_EMAIL });
  if (!brandId) {
    const [b] = await db.insert(inboxBrands).values({ name: "Acme", normalized_name: "acme", domain: "acme.com" } as any)
      .returning({ id: inboxBrands.id });
    brandId = b.id;
  }
  resolverMock.mockImplementation(async () => ({ brand_id: brandId, brand_name: "Acme", brand_domain: "acme.com", logo_url: null, is_new: false }));
}

const msgRows = (threadId: string) => db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, threadId));
const threadRow = async (id: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0];

// ─── Both flags on ───────────────────────────────────────────────────────────

describe("MAILBOX_ZERO_RETENTION + MAILBOX_LIVE_READS — ingest keeps no mail", () => {
  beforeAll(async () => {
    process.env.MAILBOX_LIVE_READS = "true";
    process.env.MAILBOX_ZERO_RETENTION = "true";
    await freshAthlete();
  });

  let threadA: string;
  let dealA: string;

  it("classifies and summarizes via the live read, storing ids, direction, time, hash and derived fields only", async () => {
    nextClassification = PAID;
    const m = deliver(incoming("zr-a1", "conv-a"));
    calls.conversation = 0;

    const { result: r, sql } = await captureSql(() => detectDeal({ athleteId, connectionId: accountId, message: m }));
    expect(r).toMatchObject({ skipped: false, reason: "processed", category: "PAID" });
    threadA = r.threadId!;
    dealA = r.dealId!;

    const [row] = await msgRows(threadA);
    expect(row.body).toBeNull();
    expect(row.subject).toBeNull();
    expect(row.sender_name).toBeNull();
    // The counterparty on an opportunity keeps her full address (decision 3).
    expect(row.sender_email).toBe("sarah@acme.com");
    expect(row.body_sha256).toBe(inboxBodyFingerprint(m.body));
    expect(row).toMatchObject({
      direction: "inbound", platform: "gmail", external_message_id: "zr-a1",
      gmail_thread_id: "conv-a", gmail_message_id_header: "<zr-a1@mail.acme.com>", connected_account_id: accountId,
    });

    const t = await threadRow(threadA);
    expect(t.subject).toBeNull();
    expect((t.classification as any)).toMatchObject({ category: "PAID", brand_name: "Acme", qualification: "workable" });
    // Summarized from the LIVE conversation: the adapter was called and provenance names the message.
    expect(calls.conversation).toBeGreaterThan(0);
    expect((t.conversation_state as any)).toMatchObject({ deal_stage: "negotiating", source_message_ids: ["zr-a1"] });
    expect(JSON.stringify(t)).not.toContain("SENTINEL");

    // Nothing on the way read a stored body / subject / sender name.
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("groups a second thread of the same brand into the SAME opportunity", async () => {
    nextClassification = { ...PAID, summary: "Acme follows up about the same reels campaign." };
    const m = deliver(incoming("zr-b1", "conv-b", { subject: "Acme reels — another SUBJECT-SENTINEL" }));
    const { result: r, sql } = await captureSql(() => detectDeal({ athleteId, connectionId: accountId, message: m }));
    expect(r).toMatchObject({ skipped: false, reason: "processed" });
    expect(r.threadId).not.toBe(threadA);

    const [a] = await db.select().from(deals).where(eq(deals.id, dealA));
    const [b] = await db.select().from(deals).where(eq(deals.id, r.dealId!));
    expect(a.opportunity_id).toBeTruthy();
    expect(b.opportunity_id).toBe(a.opportunity_id);
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("places paperwork on the brand's deal, keeping the provider sender only as a pseudonym", async () => {
    nextClassification = {
      ...PAID, brand_domain: "docusign.net", summary: "Signature request for the Acme agreement",
      contact_name: null, contact_email: null,
    };
    const m = deliver(incoming("zr-p1", "conv-p", {
      from: "Acme via Esign <dse@docusign.net>",
      subject: "Please sign: Acme Athlete Agreement",
      body: "Acme sent you a document to review and sign.",
      messageIdHeader: "<zr-p1@docusign.net>",
    }));
    const { result: r, sql } = await captureSql(() => detectDeal({ athleteId, connectionId: accountId, message: m }));
    expect(r).toMatchObject({ skipped: false, reason: "paperwork_matched" });

    const t = await threadRow(r.threadId!);
    expect(t.deal_id).toBeNull();
    expect(t.subject).toBeNull();
    expect((t.classification as any).paperwork).toMatchObject({ state: "matched", matched_by: "name" });

    const [row] = await msgRows(r.threadId!);
    expect(row.body).toBeNull();
    expect(row.subject).toBeNull();
    expect(row.sender_name).toBeNull();
    // Not a counterparty: domain + hash only, never the address.
    expect(isPseudonymousSender(row.sender_email)).toBe(true);
    expect(row.sender_email).toBe(pseudonymousSender("dse@docusign.net"));
    expect(row.sender_email!.endsWith("@docusign.net")).toBe(true);
    expect(row.sender_email).not.toContain("dse");
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("sends a reply with the subject read live, stores it without text, and de-duplicates its echo by hash", async () => {
    sendMock.mockClear();
    calls.message = 0;
    const replyText = "Thanks Sarah — two reels works for me.";

    const { result: sent, sql: sendSql } = await captureSql(() => sendThreadReply(athleteId, threadA, replyText));
    expect(sent).toMatchObject({ ok: true, sentMessageId: "<sent-reply-1@mail.gmail.com>" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The recipient is the counterparty's kept address; the subject came from the mailbox.
    expect(sendMock.mock.calls[0][0]).toMatchObject({ toEmail: "sarah@acme.com", subject: "Partnership with Acme — SUBJECT-SENTINEL" });
    expect(calls.message).toBeGreaterThan(0);
    expect(readsStoredContent(sendSql)).toBeUndefined();

    const out = (await msgRows(threadA)).find((x) => x.direction === "outbound")!;
    expect(out.body).toBeNull();
    expect(out.subject).toBeNull();
    expect(out.body_sha256).toBe(inboxBodyFingerprint(replyText));

    // The provider's copy of that send comes back through ingest, with no Message-ID readback
    // (so the echo gate can't see it) — the self-sender gate must match the twin by HASH.
    const echo = incoming("zr-a2-echo", "conv-a", {
      from: `Me <${ATHLETE_EMAIL}>`, body: `\n${replyText}\n`, messageIdHeader: null, labelIds: ["SENT"],
    });
    const before = (await msgRows(threadA)).length;
    const { result: r, sql } = await captureSql(() => detectDeal({ athleteId, connectionId: accountId, message: echo }));
    expect(r).toMatchObject({ skipped: true, reason: "self_echo_healed", threadId: threadA });
    expect((await msgRows(threadA)).length).toBe(before);
    const healed = (await msgRows(threadA)).find((x) => x.direction === "outbound")!;
    expect(healed.external_message_id).toBe("zr-a2-echo");
    expect(readsStoredContent(sql)).toBeUndefined();
    expect(sql.some((s) => /btrim/i.test(s))).toBe(false);
  });

  it("a follow-up on the deal thread keeps the counterparty's address and nothing else", async () => {
    nextClassification = { ...PAID, confidence: 0.5 };
    pushBrandReplyMock.mockClear();
    const m = deliver(incoming("zr-a3", "conv-a", { body: "BODY-SENTINEL follow-up: any update?" }));
    const r = await detectDeal({ athleteId, connectionId: accountId, message: m });
    expect(r).toMatchObject({ skipped: false, reason: "reply_recorded", threadId: threadA });
    const row = (await msgRows(threadA)).find((x) => x.external_message_id === "zr-a3")!;
    expect(row).toMatchObject({ body: null, subject: null, sender_name: null, sender_email: "sarah@acme.com" });
    // Her phone hears it once: this deal, this stored message, and the message's own date (the 24 h rule reads it).
    const [t] = await db.select({ deal: inboxThreads.deal_id }).from(inboxThreads).where(eq(inboxThreads.id, threadA));
    expect(pushBrandReplyMock.mock.calls).toEqual([[athleteId, t.deal, row.id, new Date(m.date as string)]]);
    // The same delivery again is already stored: no second push.
    await detectDeal({ athleteId, connectionId: accountId, message: m });
    expect(pushBrandReplyMock).toHaveBeenCalledTimes(1);
  });

  it("a reply that reclassifies the deal thread (a surer read) is still pushed as a brand reply, once", async () => {
    nextClassification = { ...PAID, confidence: 0.99 };
    pushBrandReplyMock.mockClear();
    const m = deliver(incoming("zr-a4", "conv-a", { body: "BODY-SENTINEL: signed and ready, here's the brief." }));
    const r = await detectDeal({ athleteId, connectionId: accountId, message: m });
    expect(r).toMatchObject({ skipped: false, reason: "processed", threadId: threadA });
    const row = (await msgRows(threadA)).find((x) => x.external_message_id === "zr-a4")!;
    expect(pushBrandReplyMock.mock.calls).toEqual([[athleteId, r.dealId, row.id, new Date(m.date as string)]]);
  });

  it("nothing anywhere in the database holds a sentinel", async () => {
    const dump = JSON.stringify({
      m: await db.select().from(inboxMessages).where(eq(inboxMessages.athlete_id, athleteId)),
      t: await db.select().from(inboxThreads).where(eq(inboxThreads.athlete_id, athleteId)),
      d: await db.select().from(deals).where(eq(deals.athlete_id, athleteId)),
    });
    expect(dump).not.toContain("SENTINEL");
    expect(dump).not.toContain("dse@docusign.net");
  });
});

// ─── Flag off = unchanged ────────────────────────────────────────────────────

describe.each([
  { label: "both flags off", live: undefined, zr: undefined },
  { label: "zero retention without live reads (refused: content still stored)", live: undefined, zr: "true" },
])("$label — ingest stores exactly as before", ({ live, zr }) => {
  beforeAll(async () => {
    if (live === undefined) delete process.env.MAILBOX_LIVE_READS; else process.env.MAILBOX_LIVE_READS = live;
    if (zr === undefined) delete process.env.MAILBOX_ZERO_RETENTION; else process.env.MAILBOX_ZERO_RETENTION = zr;
    await freshAthlete();
  });

  it("stores body, subject, sender name and the full sender address", async () => {
    nextClassification = PAID;
    const m = incoming(`off-${seq}-1`, `conv-off-${seq}`);
    const { result: r, sql } = await captureSql(() => detectDeal({ athleteId, connectionId: accountId, message: m }));
    expect(r).toMatchObject({ skipped: false, reason: "processed" });
    // The detector is real: with the flags off the summarizer's stored window IS a body read.
    expect(readsStoredContent(sql)).toBeDefined();
    const [row] = await msgRows(r.threadId!);
    expect(row.body).toBe(m.body);
    expect(row.subject).toBe(m.subject);
    expect(row.sender_name).toBe("Sarah");
    expect(row.sender_email).toBe("sarah@acme.com");
    expect((await threadRow(r.threadId!)).subject).toBe(m.subject);
  });

  it("paperwork senders are stored as their real address", async () => {
    nextClassification = { ...PAID, brand_domain: "docusign.net", contact_name: null, contact_email: null };
    const m = incoming(`off-${seq}-p`, `conv-off-p-${seq}`, {
      from: "Acme via Esign <dse@docusign.net>", subject: "Please sign: Acme Athlete Agreement",
      body: "Acme sent you a document to review and sign.", messageIdHeader: `<off-${seq}-p@docusign.net>`,
    });
    const r = await detectDeal({ athleteId, connectionId: accountId, message: m });
    expect(r.reason).toMatch(/^paperwork_/);
    const [row] = await msgRows(r.threadId!);
    expect(row.sender_email).toBe("dse@docusign.net");
    expect(row.body).toBe(m.body);
  });
});
