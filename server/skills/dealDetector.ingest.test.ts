/**
 * dealDetector ingestion tests — real SQL against in-memory Postgres (PGlite),
 * no Cloud SQL. Kimi (LLM), brand resolution, and thread summarization are
 * mocked at the module boundary; everything else (pre-filter, idempotency
 * gate, thread/message/deal persistence) runs for real.
 *
 * Focus: every ingest write records which connected inbox received the
 * message (connected_account_id), including the preserved-thread reply path.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));
// Classification runs on Gemini, not Kimi. Without this mock `genai()` picks up Application
// Default Credentials and this suite issues real, billed calls to production Vertex — which
// is what it did until 24d84d0. See dealDetector.classifyRetry.test.ts for the full account.
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

import { and, eq, inArray, isNull } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { kimiInstant } from "../lib/kimi";
import { genai } from "../lib/models";
import { inboxThreads, inboxMessages, deals } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { bodySha256 } from "../../shared/bodyHash";

const kimiMock = kimiInstant as jest.Mock;
/** Classification's actual transport since the migration off Kimi. */
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

// What the classifier / scorer "return" for the next message — switched per test.
let nextClassification: Record<string, unknown>;
let nextScoreResponse: Record<string, unknown>;

const PAID_CLASSIFICATION = {
  category: "PAID", confidence: 0.9, is_deal: true,
  brand_name: "Acme", brand_domain: "acme.com", advertiser: "Acme",
  agency_name: null, via_agency: false,
  summary: "Paid sponsorship offer", offer_amount: 500,
  deliverables: ["1 IG post"], deadline: null,
  contact_name: "Sarah", contact_email: "sarah@acme.com",
};

const NOISE_CLASSIFICATION = {
  category: "NOISE", confidence: 0.2,
  brand_name: null, brand_domain: null, advertiser: null,
  agency_name: null, via_agency: false,
  summary: "Short reply", offer_amount: null,
  deliverables: [], deadline: null, contact_name: null, contact_email: null,
};

const SCORE_RESPONSE = {
  verdict: "good", scoreNumeric: 6, dollarAmount: 500,
  factors: { rateComparison: "n/a", brandRelevance: "fits", deliverableScope: "light", exclusivity: "none" },
  factorRatings: null,
  reasons: ["solid offer"], redFlags: [],
  fitRead: { rating: "good", label: "Good fit" },
  economicsState: { state: "priced", read: "$500 stated" },
  recommendation: "negotiate", recommendation_ui: "Counter at $600",
  recommendation_agent: "Push on rate.", negotiate_terms: ["$600 flat"],
  recommendation_confidence: "medium", urgency: "medium",
  autopilot_safe: false, draft_points: ["mention the post"],
  brandAnalysis: null,
};

function gmailMessage(id: string, threadId: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId:  id,
    gmailThreadId:   threadId,
    subject:         "Sponsorship opportunity",
    from:            "Sarah <sarah@acme.com>",
    body:            "We'd love to pay you $500 for one Instagram post.",
    date:            "2026-07-01T10:00:00Z",
    messageIdHeader: `<${id}@mail.acme.com>`,
    ...over,
  };
}

let athleteId: string;
let inboxA: string;
let inboxB: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  inboxA = await seedConnection({ athleteId, email: "inbox-a@gmail.com" });
  inboxB = await seedConnection({ athleteId, email: "inbox-b@gmail.com" });

  // Classification — Gemini. The classifier reads `.text`, not an OpenAI envelope.
  classifyMock.mockImplementation(async () => ({ text: JSON.stringify(nextClassification) }));
  // Scoring — still Kimi, reached only after classification succeeds.
  kimiMock.mockImplementation(async () => ({
    choices: [{
      message: {
        content: JSON.stringify(
          nextScoreResponse,
        ),
      },
    }],
  }));
});

beforeEach(() => {
  nextScoreResponse = SCORE_RESPONSE;
});

afterAll(async () => {
  // Let fire-and-forget summarize/rescore chains settle before tearing down.
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

describe("detectDeal ingestion — connected_account_id provenance", () => {
  it("persists the receiving connection on a new thread, its message, and creates the deal", async () => {
    nextClassification = PAID_CLASSIFICATION;

    const result = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m1", "t1") });

    expect(result.skipped).toBe(false);
    expect(result.threadId).toBeDefined();

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, result.threadId!));
    expect(thread.connected_account_id).toBe(inboxA);
    expect(thread.external_thread_id).toBe("t1");
    expect(thread.status).toBe("deal_detected");
    expect(thread.deal_id).toBeTruthy();

    const [msg] = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m1"));
    expect(msg.connected_account_id).toBe(inboxA);
    expect(msg.gmail_thread_id).toBe("t1");
    expect(msg.gmail_message_id_header).toBe("<m1@mail.acme.com>");

    const [deal] = await db.select().from(deals).where(eq(deals.id, thread.deal_id!));
    expect(deal.brand_name).toBe("Acme");
  });

  it("threads from different inboxes each record their own receiving connection", async () => {
    nextClassification = PAID_CLASSIFICATION;

    const result = await detectDeal({ athleteId, connectionId: inboxB, message: gmailMessage("m2", "t2") });

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, result.threadId!));
    expect(thread.connected_account_id).toBe(inboxB);
  });

  it("preserved-thread follow-up records the connection and self-heals a legacy thread", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m3", "t3") });

    // Simulate a thread ingested before the column existed.
    await db.update(inboxThreads).set({ connected_account_id: null }).where(eq(inboxThreads.id, first.threadId!));

    // A weak follow-up on a known PAID thread takes the preserved path
    // (message recorded, classification untouched).
    nextClassification = NOISE_CLASSIFICATION;
    const followUp = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m4", "t3", { subject: "Re: Sponsorship opportunity", body: "Sounds good, when?" }),
    });

    expect(followUp.skipped).toBe(false);
    expect(followUp.reason).toBe("reply_recorded");

    const [msg] = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m4"));
    expect(msg.connected_account_id).toBe(inboxA);

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, first.threadId!));
    expect(thread.connected_account_id).toBe(inboxA); // healed
    expect((thread.classification as any).category).toBe("PAID"); // preserved

    // Let the fire-and-forget summarize/rescore chain settle inside the test.
    await new Promise((r) => setTimeout(r, 50));
  });

  it("idempotency gate skips an already-processed gmail message id", async () => {
    nextClassification = PAID_CLASSIFICATION;
    kimiMock.mockClear();

    const result = await detectDeal({ athleteId, connectionId: inboxB, message: gmailMessage("m1", "t1") });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("already_processed");
    expect(result.threadId).toBeDefined();
    expect(kimiMock).not.toHaveBeenCalled();

    const rows = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].connected_account_id).toBe(inboxA); // not overwritten by the dupe from inboxB
  });

  it("echo gate skips the athlete's own app-sent reply arriving back through ingest", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-echo-1", "t-echo") });
    expect(first.skipped).toBe(false);

    // The app's reply endpoint records the outbound send with the Message-ID
    // Gmail assigned it. Gmail can then redeliver that same email through
    // ingest (fresh per-mailbox gmail message id, same RFC 2822 Message-ID) —
    // gate 1a can't catch it, so it used to land as a phantom inbound row.
    await db.insert(inboxMessages).values({
      thread_id:               first.threadId!,
      athlete_id:              athleteId,
      direction:               "outbound",
      body:                    "Thanks, sounds great!",
      received_at:             new Date(),
      platform:                "gmail",
      gmail_thread_id:         "t-echo",
      gmail_message_id_header: "<our-reply@mail.gmail.com>",
      connected_account_id:    inboxA,
    } as any);

    kimiMock.mockClear();
    const echo = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-echo-2", "t-echo", {
        from:            "Mia <athlete@own-domain.com>",
        body:            "Thanks, sounds great!",
        messageIdHeader: "<our-reply@mail.gmail.com>",
      }),
    });

    expect(echo.skipped).toBe(true);
    expect(echo.reason).toBe("message_id_echo");
    expect(kimiMock).not.toHaveBeenCalled(); // gated before any LLM cost

    // No phantom inbound row — the outbound record stands alone.
    const rows = await db.select().from(inboxMessages)
      .where(eq(inboxMessages.gmail_message_id_header, "<our-reply@mail.gmail.com>"));
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("outbound");
  });

  it("pre-filter drops school email without NIL context before any LLM call", async () => {
    kimiMock.mockClear();

    const result = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m5", "t5", { from: "Registrar <registrar@university.edu>", subject: "Course enrollment", body: "Your schedule." }),
    });

    expect(result.skipped).toBe(true);
    expect(kimiMock).not.toHaveBeenCalled();

    const rows = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m5"));
    expect(rows).toHaveLength(0);
  });

  it("links thread → deal and stores no score (the deal score is retired)", async () => {
    nextClassification = PAID_CLASSIFICATION;

    const result = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m6", "t6") });

    expect(result.skipped).toBe(false);
    expect(result.dealId).toBeDefined();

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, result.threadId!));
    expect(thread.deal_id).toBe(result.dealId); // the link the scored path always wrote
  });

  it("migration 0009 backfills the thread link for existing orphaned deals", async () => {
    // Simulate a pre-fix orphan: deal exists with the thread id only in raw_data.
    const [thread] = await db
      .insert(inboxThreads)
      .values({ athlete_id: athleteId, subject: "Orphan", connected_account_id: inboxA } as any)
      .returning();
    const [deal] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId, brand_name: "Acme", deal_type: "social_post",
        status: "detected", source: "inbox_scan",
        raw_data: { thread_id: thread.id, gmail_thread_id: "t-orphan" },
      } as any)
      .returning();

    const fs = await import("node:fs");
    const path = await import("node:path");
    const sql = fs.readFileSync(path.join(__dirname, "../../migrations/0009_link_orphan_deals.sql"), "utf-8");
    const { client } = await import("../testUtils/pgliteDb");
    await client.exec(sql);

    const [linked] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, thread.id));
    expect(linked.deal_id).toBe(deal.id);

    // Idempotent + non-destructive: re-running must not repoint already-linked threads.
    await client.exec(sql);
    const [still] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, thread.id));
    expect(still.deal_id).toBe(deal.id);
  });

  it("self-sender gate heals the app-sent outbound twin instead of recording a phantom inbound", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-self-1", "t-self") });
    expect(first.skipped).toBe(false);

    // The reply endpoint stored the send, but the Message-ID readback failed —
    // gmail_message_id_header is NULL, so the echo gate (1a′) can't match it.
    await db.insert(inboxMessages).values({
      thread_id:            first.threadId!,
      athlete_id:           athleteId,
      direction:            "outbound",
      body:                 "Perfect — send the contract over.",
      received_at:          new Date(),
      platform:             "gmail",
      gmail_thread_id:      "t-self",
      connected_account_id: inboxA,
    } as any);

    kimiMock.mockClear();
    const echo = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-self-2", "t-self", {
        from:            "Mia <inbox-a@gmail.com>", // the athlete's own connected address
        body:            "Perfect — send the contract over.",
        messageIdHeader: "<native-echo@mail.gmail.com>",
      }),
    });

    expect(echo).toEqual({ skipped: true, reason: "self_echo_healed", threadId: first.threadId });
    expect(kimiMock).not.toHaveBeenCalled(); // gated before any LLM cost

    // The outbound row adopted the ids from the ingest copy…
    const out = await db.select().from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, first.threadId!), eq(inboxMessages.direction, "outbound")));
    expect(out).toHaveLength(1);
    expect(out[0].gmail_message_id_header).toBe("<native-echo@mail.gmail.com>");
    expect(out[0].external_message_id).toBe("m-self-2"); // future redeliveries now hit gate 1a

    // …and no inbound copy of the athlete's own words exists.
    const inbound = await db.select().from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, first.threadId!), eq(inboxMessages.direction, "inbound")));
    expect(inbound).toHaveLength(1); // just the original brand outreach
  });

  it("self-sender gate matches the app-sent twin on its text fingerprint — no stored body needed", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-fp-1", "t-fp") });
    expect(first.skipped).toBe(false);

    // Ingest writes the fingerprint on the row it inserts (0086).
    const [inbound] = await db.select().from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, first.threadId!), eq(inboxMessages.direction, "inbound")));
    expect(inbound.body_sha256).toBe(bodySha256("We'd love to pay you $500 for one Instagram post."));

    // The app-sent twin carries only the fingerprint — its body is gone.
    await db.insert(inboxMessages).values({
      thread_id:            first.threadId!,
      athlete_id:           athleteId,
      direction:            "outbound",
      body:                 null,
      body_sha256:          bodySha256("Works for me — Tuesday it is."),
      received_at:          new Date(),
      platform:             "gmail",
      gmail_thread_id:      "t-fp",
      connected_account_id: inboxA,
    } as any);

    kimiMock.mockClear();
    const echo = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-fp-2", "t-fp", {
        from:            "Athlete <inbox-a@gmail.com>",
        body:            "Works for me — Tuesday it is.\r\n\r\n", // the mailbox's copy, trailing whitespace and all
        messageIdHeader: "<fp-echo@mail.gmail.com>",
      }),
    });

    expect(echo).toEqual({ skipped: true, reason: "self_echo_healed", threadId: first.threadId });
    expect(kimiMock).not.toHaveBeenCalled();
    const out = await db.select().from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, first.threadId!), eq(inboxMessages.direction, "outbound")));
    expect(out).toHaveLength(1);
    expect(out[0].external_message_id).toBe("m-fp-2");
  });

  it("self-sender gate compares stored bodies only for legacy rows — a fingerprinted row is matched on its fingerprint alone", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-fp-3", "t-fp-legacy") });

    // Same body text, but the row's fingerprint says it is a different message.
    await db.insert(inboxMessages).values({
      thread_id:            first.threadId!,
      athlete_id:           athleteId,
      direction:            "outbound",
      body:                 "Thanks, talk soon.",
      body_sha256:          bodySha256("a different message"),
      received_at:          new Date(),
      platform:             "gmail",
      gmail_thread_id:      "t-fp-legacy",
      connected_account_id: inboxA,
    } as any);

    const r = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-fp-4", "t-fp-legacy", {
        from:            "Athlete <inbox-a@gmail.com>",
        body:            "Thanks, talk soon.",
        messageIdHeader: "<fp-native@mail.gmail.com>",
      }),
    });

    expect(r.reason).toBe("self_reply_recorded"); // not healed onto the mismatched row
    const out = await db.select().from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, first.threadId!), eq(inboxMessages.direction, "outbound")));
    expect(out).toHaveLength(2);
    const recorded = out.find((m) => m.external_message_id === "m-fp-4");
    expect(recorded?.body_sha256).toBe(bodySha256("Thanks, talk soon."));
    await new Promise((res) => setTimeout(res, 50));
  });

  it("self-sender gate records a native-client reply as OUTBOUND and keeps message_count honest", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-native-1", "t-native") });

    kimiMock.mockClear();
    const r = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-native-2", "t-native", {
        from:            "Mia <INBOX-A@gmail.com>", // case-insensitive match on the connected address
        body:            "Replying from the Gmail app on my phone.",
        messageIdHeader: "<from-phone@mail.gmail.com>",
      }),
    });

    expect(r.skipped).toBe(false);
    expect(r.reason).toBe("self_reply_recorded");
    expect(kimiMock).not.toHaveBeenCalled(); // never classified or scored

    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, first.threadId!));
    const out  = msgs.filter((m) => m.direction === "outbound");
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("Replying from the Gmail app");
    expect(out[0].connected_account_id).toBe(inboxA);

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, first.threadId!));
    expect(thread.message_count).toBe(msgs.length); // counter == actual rows

    // Let the fire-and-forget summarize chain settle inside the test.
    await new Promise((res) => setTimeout(res, 50));
  });

  it("self-sender gate lets a brand-new thread from the athlete's own address through to classification", async () => {
    nextClassification = PAID_CLASSIFICATION;
    kimiMock.mockClear();

    const r = await detectDeal({
      athleteId,
      connectionId: inboxB,
      message: gmailMessage("m-self-new", "t-self-new", { from: "Mia <inbox-b@gmail.com>" }),
    });

    expect(r.skipped).toBe(false);
    expect(classifyMock).toHaveBeenCalled(); // classified like any other outreach

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
    expect(thread.message_count).toBe(1); // 0-then-bump lands on the truth
  });

  it("cross-mailbox: same Message-ID on a different Gmail thread id joins one deal", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-dual-a", "thread-mailbox-A", {
        messageIdHeader: "<same-phys-mail@acme.com>",
      }),
    });
    expect(first.skipped).toBe(false);
    expect(first.dealId).toBeDefined();

    // Same physical email to the second connected inbox: different Gmail id +
    // different thread id, identical Message-ID header.
    kimiMock.mockClear();
    const echo = await detectDeal({
      athleteId,
      connectionId: inboxB,
      message: gmailMessage("m-dual-b", "thread-mailbox-B", {
        messageIdHeader: "<same-phys-mail@acme.com>",
      }),
    });
    expect(echo.skipped).toBe(true);
    expect(echo.reason).toBe("message_id_echo");
    expect(echo.threadId).toBe(first.threadId);

    // Follow-up only arrives on mailbox B's Gmail thread id — must land on the
    // same deal, not mint a second card.
    nextClassification = NOISE_CLASSIFICATION;
    const follow = await detectDeal({
      athleteId,
      connectionId: inboxB,
      message: gmailMessage("m-dual-b2", "thread-mailbox-B", {
        subject: "Re: Sponsorship opportunity",
        body:    "Can you do Tuesday?",
        messageIdHeader: "<reply-from-brand@acme.com>",
      }),
    });
    expect(follow.skipped).toBe(false);
    expect(follow.threadId).toBe(first.threadId);

    const dealsForAthlete = await db.select().from(deals).where(eq(deals.athlete_id, athleteId));
    const dualDeals = dealsForAthlete.filter((d) => d.brand_name === "Acme" && d.id === first.dealId);
    expect(dualDeals).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 50));
  });

  it("H2: a new-thread forward is no longer blanket-dropped — it flows to the classifier", async () => {
    nextClassification = PAID_CLASSIFICATION;
    kimiMock.mockClear();
    const r = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-fwd", "t-fwd", {
        subject: "Fwd: Sponsorship opportunity",
        body:    "See below — $2k for one post",
      }),
    });
    // The forward reaches the classifier (the real noise gate) instead of being dropped
    // on the subject prefix alone; a genuine forwarded proposal now creates the deal.
    expect(classifyMock).toHaveBeenCalled();
    expect(r.skipped).toBe(false);
    expect(r.reason).toBe("processed");
  });

  it("H2: a forward on a LIVE deal thread is recorded, not dropped", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-fwd-live-1", "t-fwd-live") });
    expect(first.skipped).toBe(false);

    // A forward that lands inside the existing deal conversation must be RECORDED so the
    // card updates / flips turns — not silently discarded by the old blanket drop.
    nextClassification = NOISE_CLASSIFICATION;
    const fwd = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-fwd-live-2", "t-fwd-live", {
        subject: "Fwd: Sponsorship opportunity",
        body:    "Fwd: are we still on?",
      }),
    });
    expect(fwd.skipped).toBe(false);
    expect(fwd.reason).toBe("reply_recorded");
    expect(fwd.threadId).toBe(first.threadId);

    const [msg] = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m-fwd-live-2"));
    expect(msg).toBeDefined();

    await new Promise((r) => setTimeout(r, 50));
  });

  it("C2: concurrent dual-inbox delivery of the same Message-ID creates ONE deal", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const header = "<concurrent-dup@mail.acme.com>";

    // Same physical email hits two connected inboxes at once: identical Message-ID,
    // different per-mailbox gmail message ids AND thread ids. Both webhooks race past
    // the echo gate (neither row exists yet) — only the partial unique index on
    // (athlete_id, gmail_message_id_header) can stop a second deal.
    const [rA, rB] = await Promise.all([
      detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("cm-a", "tc-a", { messageIdHeader: header }) }),
      detectDeal({ athleteId, connectionId: inboxB, message: gmailMessage("cm-b", "tc-b", { messageIdHeader: header }) }),
    ]);

    // Exactly one landed as a real deal; the other deduped on the Message-ID unique index.
    expect([rA, rB].filter((r) => r.skipped)).toHaveLength(1);

    // Only ONE message row carries that Message-ID.
    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.gmail_message_id_header, header));
    expect(msgs).toHaveLength(1);

    const winnerThreadId = msgs[0].thread_id;
    const [winnerThread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, winnerThreadId));
    expect(winnerThread.deal_id).toBeTruthy();

    // Only one of the two per-mailbox threads survives as a real row; the loser's empty
    // orphan thread was deleted, and its gmail thread id is registered as an alias.
    const survivors = await db
      .select()
      .from(inboxThreads)
      .where(inArray(inboxThreads.external_thread_id, ["tc-a", "tc-b"]));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe(winnerThreadId);
    expect(winnerThread.alias_thread_ids).toHaveLength(1); // the loser mailbox's thread id

    await new Promise((r) => setTimeout(r, 50));
  });

  it("records a SENT-only self reply on a known thread as outbound", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-sent-1", "t-sent"),
    });

    kimiMock.mockClear();
    const r = await detectDeal({
      athleteId,
      connectionId: inboxA,
      message: gmailMessage("m-sent-2", "t-sent", {
        from:            "Mia <inbox-a@gmail.com>",
        body:            "Replying from native Gmail",
        messageIdHeader: "<native-gmail-send@mail.gmail.com>",
        labelIds:        ["SENT"],
      }),
    });

    expect(r.skipped).toBe(false);
    expect(r.reason).toBe("self_reply_recorded");
    const rows = await db
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.external_message_id, "m-sent-2"));
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("outbound");
    expect(kimiMock).not.toHaveBeenCalled();
    await new Promise((res) => setTimeout(res, 50));
    void first;
  });

  it("no ingest path leaves connected_account_id NULL on new rows", async () => {
    const orphanMsgs = await db
      .select({ id: inboxMessages.id })
      .from(inboxMessages)
      .where(isNull(inboxMessages.connected_account_id));
    const orphanThreads = await db
      .select({ id: inboxThreads.id })
      .from(inboxThreads)
      .where(and(isNull(inboxThreads.connected_account_id)));
    expect(orphanMsgs).toHaveLength(0);
    expect(orphanThreads).toHaveLength(0);
  });
});


describe("detectDeal ingestion — thread dates are the messages' own dates", () => {
  it("stamps a new thread with its message's date and only moves it forward, never to the processing time", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("d1", "t-dates", { date: "2026-07-29T05:02:08Z" }) });
    const read = async () => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, first.threadId!)))[0].last_message_at;
    expect((await read())!.toISOString()).toBe("2026-07-29T05:02:08.000Z");

    // A reply on the known deal thread (the preserved path).
    nextClassification = NOISE_CLASSIFICATION;
    await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("d2", "t-dates", { subject: "Re: Sponsorship opportunity", body: "Sounds good, when?", date: "2026-09-30T21:45:05Z" }) });
    expect((await read())!.toISOString()).toBe("2026-09-30T21:45:05.000Z");

    // An OLDER message processed later (a backfill / re-process / late delivery) leaves the newest date alone.
    await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("d3", "t-dates", { subject: "Re: Sponsorship opportunity", body: "Following up.", date: "2026-08-15T00:12:28Z" }) });
    expect((await read())!.toISOString()).toBe("2026-09-30T21:45:05.000Z");
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("scam signals on the classify call (DEALS_RISK_FLAGS, retired 2 Nov 2026: always on)", () => {
  it("the prompt asks for them and classification.risk_flags stores the valid ones; a later message adds", async () => {
    classifyMock.mockClear();
    nextClassification = { ...PAID_CLASSIFICATION, risk_flags: ["sender_mismatch", "invented_flag"] };
    const r = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-risk-1", "t-risk") });
    expect(r.skipped).toBe(false);
    expect(String(classifyMock.mock.calls[0][0].config.systemInstruction)).toContain('"upfront_fee"');
    let [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
    expect((thread.classification as any).risk_flags).toEqual(["sender_mismatch"]);

    nextClassification = { ...NOISE_CLASSIFICATION, risk_flags: ["upfront_fee"] };
    await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-risk-2", "t-risk", { subject: "Re: Sponsorship opportunity", body: "Please send the $50 registration fee first." }) });
    [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
    expect([...(thread.classification as any).risk_flags].sort()).toEqual(["sender_mismatch", "upfront_fee"]);
  });
});

describe("don't lose mail (12 Oct 2026)", () => {
  it("a reply on a known deal thread is recorded even when its subject would be pre-filtered", async () => {
    nextClassification = PAID_CLASSIFICATION;
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-sign-1", "t-sign") });
    expect(first.skipped).toBe(false);

    nextClassification = NOISE_CLASSIFICATION;
    const reply = await detectDeal({
      athleteId, connectionId: inboxA,
      message: gmailMessage("m-sign-2", "t-sign", { subject: "Re: Contract signing", body: "Here's the contract for signing." }),
    });
    expect(reply.skipped).toBe(false);
    const rows = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m-sign-2"));
    expect(rows).toHaveLength(1);
  });

  it("the same subject on a brand-new thread is still pre-filtered (no model call)", async () => {
    classifyMock.mockClear();
    const r = await detectDeal({
      athleteId, connectionId: inboxA,
      message: gmailMessage("m-sign-new", "t-sign-new", { subject: "Contract signing" }),
    });
    expect(r.skipped).toBe(true);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("e-sign / payment providers reach the paperwork path instead of being dropped at the door", async () => {
    nextClassification = { ...NOISE_CLASSIFICATION, category: "PAID", confidence: 0.7, is_deal: true };
    classifyMock.mockClear();
    const r = await detectDeal({
      athleteId, connectionId: inboxA,
      message: gmailMessage("m-dsign", "t-dsign", { from: "DocuSign <noreply@docusign.net>", subject: "Please sign: Acme agreement" }),
    });
    expect(r.reason).not.toMatch(/^Blocked/);
    expect(classifyMock).toHaveBeenCalled();
  });

  it("an Instagram DM she sent is recorded as HER reply on its conversation; an orphan is skipped with no model call", async () => {
    nextClassification = { ...PAID_CLASSIFICATION, brand_domain: null };
    const dm = (id: string, over: Record<string, unknown> = {}) => ({
      gmailMessageId: id, gmailThreadId: "ig-conv-1", subject: "DM from acme", from: "acme",
      body: "Would love to send you a pair and pay $300 for a post", date: "2026-07-02T10:00:00Z",
      platform: "instagram", senderIgUserId: "acme-ig", messageIdHeader: null, ...over,
    });
    const first = await detectDeal({ athleteId, connectionId: inboxA, message: dm("ig-1") });
    expect(first.skipped).toBe(false);

    classifyMock.mockClear();
    const mine = await detectDeal({
      athleteId, connectionId: inboxA,
      message: dm("ig-2", { from: "me", body: "Yes please!", labelIds: ["SENT"], date: "2026-07-02T11:00:00Z" }),
    });
    expect(mine.reason).toBe("self_reply_recorded");
    expect(classifyMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "ig-2"));
    expect(row.direction).toBe("outbound");

    const orphan = await detectDeal({
      athleteId, connectionId: inboxA,
      message: dm("ig-3", { gmailThreadId: "ig-conv-unknown", from: "me", labelIds: ["SENT"] }),
    });
    expect(orphan).toMatchObject({ skipped: true, reason: "sent_orphan" });
    expect(classifyMock).not.toHaveBeenCalled();
  });
});

describe("D5 Maybe — the 0.35–0.6 band (DEALS_MAYBE)", () => {
  const WEAK = { ...PAID_CLASSIFICATION, confidence: 0.5, offer_amount: null, summary: "What are your rates?" };
  afterEach(() => { delete process.env.DEALS_MAYBE; });

  it("flag off: dropped as before", async () => {
    nextClassification = WEAK;
    const r = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-maybe-off", "t-maybe-off") });
    expect(r.skipped).toBe(true);
  });

  it("flag on: stored with a maybe marker; the brand writing again clears it", async () => {
    process.env.DEALS_MAYBE = "true";
    nextClassification = WEAK;
    const r = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-maybe-1", "t-maybe") });
    expect(r.skipped).toBe(false);
    let [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
    expect((thread.classification as any).maybe).toBe(true);
    expect(thread.deal_id).toBeTruthy();

    nextClassification = { ...WEAK, confidence: 0.4 };
    await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("m-maybe-2", "t-maybe", { subject: "Re: Sponsorship opportunity" }) });
    [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
    expect((thread.classification as any).maybe).toBeUndefined();
  });

  it("flag on: below 0.35, NOISE, or called a non-deal is still dropped", async () => {
    process.env.DEALS_MAYBE = "true";
    for (const [i, cls] of [
      { ...WEAK, confidence: 0.3 },
      { ...NOISE_CLASSIFICATION, confidence: 0.5 },
      { ...WEAK, is_deal: false },
    ].entries()) {
      nextClassification = cls;
      const r = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage(`m-maybe-no-${i}`, `t-maybe-no-${i}`) });
      expect(r.skipped).toBe(true);
    }
  });
});
