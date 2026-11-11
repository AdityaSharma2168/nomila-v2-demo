/**
 * dealDraft.test.ts — the shared draft core (extracted from POST /me/deals/:id/draft).
 *
 * Real SQL against in-memory Postgres (PGlite), Kimi mocked. Proves the core the route
 * and Mila's draft_reply tool both call: deterministic greeting/signature framing, the
 * onToken stream contract (greeting first, then body deltas), tenancy (foreign/missing
 * deal → not_found), latest_draft persistence, and the negotiate leak-lint refusal.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiStream: jest.fn() }));

import { generateDealDraft, DRAFT_LEAK_REFUSAL } from "./dealDraft";
import { kimiStream } from "../lib/kimi";
import {
  deals,
  inboxThreads,
  inboxMessages,
  athletes,
} from "../../shared/schema";
import { eq } from "drizzle-orm";
import {
  client,
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

const kimiMock = kimiStream as jest.Mock;

async function* streamOf(parts: string[]) {
  for (const p of parts) yield { choices: [{ delta: { content: p } }] } as any;
}

let athleteA: string;
let athleteB: string;
let dealA: string;
let threadA: string;

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Jordan Rivers");
  athleteB = await seedAthlete("Someone Else");
  await db
    .update(athletes)
    .set({ deal_preferences: { minimum_rate: 2000 } as any })
    .where(eq(athletes.id, athleteA));

  const [deal] = await db
    .insert(deals)
    .values({
      athlete_id: athleteA,
      brand_name: "Acme",
      status: "detected",
      amount: "800",
    } as any)
    .returning({ id: deals.id });
  dealA = deal.id;
  const [thread] = await db
    .insert(inboxThreads)
    .values({
      athlete_id: athleteA,
      subject: "Collab?",
      deal_id: dealA,
      last_message_at: new Date(),
    } as any)
    .returning({ id: inboxThreads.id });
  threadA = thread.id;
  await db.insert(inboxMessages).values({
    thread_id: threadA,
    athlete_id: athleteA,
    direction: "inbound",
    sender_email: "brand@acme.com",
    sender_name: "Sarah",
    body: "Want to work together?",
    platform: "gmail",
    received_at: new Date(),
  } as any);
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
  kimiMock.mockImplementation(async () =>
    streamOf([
      "Thanks so much for reaching out — ",
      "I'd love to explore this together.",
    ]),
  );
});

describe("generateDealDraft", () => {
  it("assembles greeting + body + signature and streams the greeting first via onToken", async () => {
    const tokens: string[] = [];
    const result = await generateDealDraft({
      athleteId: athleteA,
      dealId: dealA,
      replyIntent: "accept",
      style: "friendly",
      voice: "athlete",
      onToken: (t) => tokens.push(t),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Greeting uses the inbound sender's first name; body + code-composed sign-off follow.
    expect(result.fullText.startsWith("Hi Sarah,")).toBe(true);
    expect(result.fullText).toContain("explore this together");
    // The deterministic greeting is the FIRST streamed token. She has a floor set, so the body
    // is BUFFERED and leak-checked before anything else reaches the caller — every intent, not
    // only negotiate (12 Oct 2026). The caller gets the body in the final text.
    expect(tokens[0]).toBe("Hi Sarah,\n\n");
    expect(tokens.slice(1).join("")).toBe("");
    expect(result.threadId).toBe(threadA);

    // Persisted as the thread's latest_draft.
    const [row] = await db
      .select({ latest_draft: inboxThreads.latest_draft })
      .from(inboxThreads)
      .where(eq(inboxThreads.id, threadA));
    expect((row.latest_draft as any).body).toBe(result.fullText);
  });

  it("foreign deal → not_found (tenancy), and never calls the model", async () => {
    const result = await generateDealDraft({
      athleteId: athleteB,
      dealId: dealA,
      replyIntent: "accept",
      style: "friendly",
      voice: "athlete",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(kimiMock).not.toHaveBeenCalled();
  });

  it("malformed dealId → not_found (no DB cast error)", async () => {
    const result = await generateDealDraft({
      athleteId: athleteA,
      dealId: "not-a-uuid",
      replyIntent: "accept",
      style: "friendly",
      voice: "athlete",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("negotiate leak that survives a retry → refusal (never returns the leaking copy)", async () => {
    kimiMock.mockImplementation(async () =>
      streamOf(["Your offer is below market and my minimum rate is higher."]),
    );
    const result = await generateDealDraft({
      athleteId: athleteA,
      dealId: dealA,
      replyIntent: "negotiate",
      style: "friendly",
      voice: "athlete",
      selectedTerms: ["Rate"],
    });
    expect(result).toEqual({
      ok: false,
      reason: "refusal",
      message: DRAFT_LEAK_REFUSAL,
    });
    expect(kimiMock).toHaveBeenCalledTimes(2); // first attempt + one retry
  });

  // Regression (live bug, Mia): the model completed normally and streamed nothing,
  // so `body` was "" — and we shipped ok anyway. assembleReplyEmail filters empty
  // parts, so fullText collapsed to the code-composed frame with no letter in it,
  // the route sent it as replace + done, and the card rendered "Hi Sarah, / Best,"
  // as a finished email with a Review & Send button. An empty body is a failure.
  //
  // Both shapes matter: a stream with no chunks at all, and one that yields only
  // whitespace (sanitizeDraftBody can return whitespace, which is truthy and
  // survives runOnce's `|| raw.trim()`).
  it.each([
    ["no chunks at all", [] as string[]],
    ["whitespace only", ["  ", "\n\n", "\t"]],
  ])(
    "model returns %s → not ok, and never ships the bare greeting",
    async (_label, parts) => {
      const [before] = await db
        .select({ latest_draft: inboxThreads.latest_draft })
        .from(inboxThreads)
        .where(eq(inboxThreads.id, threadA));

      kimiMock.mockImplementation(async () => streamOf(parts as string[]));

      const result = await generateDealDraft({
        athleteId: athleteA,
        dealId: dealA,
        replyIntent: "accept",
        style: "friendly",
        voice: "athlete",
      });

      expect(result).toEqual({ ok: false, reason: "empty_body" });
      // The whole point: no fullText, so nothing can render as a finished draft.
      expect(result).not.toHaveProperty("fullText");

      // And the empty frame must not have overwritten the thread's stored draft.
      const [after] = await db
        .select({ latest_draft: inboxThreads.latest_draft })
        .from(inboxThreads)
        .where(eq(inboxThreads.id, threadA));
      expect(after.latest_draft).toEqual(before.latest_draft);
    },
  );

  // The near-miss the guard must NOT swallow: the model replied with only a
  // greeting and a sign-off. sanitizeDraftBody strips both to "", but runOnce's
  // `|| raw.trim()` fallback rescues the raw text, so this is a real (if poor)
  // body and must still succeed — otherwise the guard turns a weak draft into a
  // hard failure.
  it("greeting-and-signoff-only reply still succeeds (the || raw.trim() fallback)", async () => {
    kimiMock.mockImplementation(async () =>
      streamOf(["Hi Sarah,\n\nBest,\nJordan"]),
    );
    const result = await generateDealDraft({
      athleteId: athleteA,
      dealId: dealA,
      replyIntent: "accept",
      style: "friendly",
      voice: "athlete",
    });
    expect(result.ok).toBe(true);
  });

  // Regression (live bug): a bare select().from(deals) expands to EVERY schema
  // column, so a column the local Postgres is behind on (payment_status /
  // deposit_status from the payments engine) crashed the whole draft path. Drop
  // those columns to simulate the lagging DB — with a NARROW projection drafting
  // still works; if a select-all ever creeps back, this throws "column ... does
  // not exist" and fails. Do the thread select too (id/score/summary only).
  it("drafts when the DB is behind on payments columns (narrow select, not select-all)", async () => {
    await client.exec(
      "ALTER TABLE deals DROP COLUMN IF EXISTS payment_status CASCADE",
    );
    await client.exec(
      "ALTER TABLE deals DROP COLUMN IF EXISTS deposit_status CASCADE",
    );
    // A column the narrow thread select must NOT pull (it reads id, summary, classification,
    // conversation_state and last_message_at — the last two for the LATEST offer).
    await client.exec(
      "ALTER TABLE inbox_threads DROP COLUMN IF EXISTS message_count CASCADE",
    );

    await expect(
      generateDealDraft({
        athleteId: athleteA,
        dealId: dealA,
        replyIntent: "accept",
        style: "friendly",
        voice: "athlete",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("an accept draft that states her floor is regenerated, then refused — every intent is linted", async () => {
    kimiMock.mockImplementation(async () => streamOf(["Happy to do it — my rate is $2,000 for this."]));
    const result = await generateDealDraft({
      athleteId: athleteA,
      dealId: dealA,
      replyIntent: "accept",
      style: "friendly",
      voice: "athlete",
    });
    expect(result).toEqual({ ok: false, reason: "refusal", message: DRAFT_LEAK_REFUSAL });
    expect(kimiMock).toHaveBeenCalledTimes(2);
  });

  it("negotiate with no counter never proposes her floor; with her counter, states only that", async () => {
    let system = "";
    kimiMock.mockImplementation(async (msgs: any[]) => {
      system = msgs[0].content;
      return streamOf(["We'd love to make this work."]);
    });
    await generateDealDraft({
      athleteId: athleteA, dealId: dealA, replyIntent: "negotiate", style: "friendly", voice: "athlete",
    });
    expect(system).not.toMatch(/2,?000/);
    expect(system).toMatch(/State NO dollar figure/);

    await generateDealDraft({
      athleteId: athleteA, dealId: dealA, replyIntent: "negotiate", style: "friendly", voice: "athlete",
      customInstruction: "Counter at $2,600 for this work and hold that as my rate. Do not go below $2,000; keep the tone collaborative.",
    });
    expect(system).toContain("Rate to propose: $2,600");
    expect(system).not.toMatch(/2,000/);
  });

  it("a model-written instruction carries no figure into the prompt", async () => {
    let system = "";
    kimiMock.mockImplementation(async (msgs: any[]) => {
      system = msgs[0].content;
      return streamOf(["Thanks, looking forward to it."]);
    });
    await generateDealDraft({
      athleteId: athleteA, dealId: dealA, replyIntent: "accept", style: "friendly", voice: "athlete",
      customInstruction: "confirm her minimum of $2,000", instructionSource: "model",
    });
    expect(system).not.toMatch(/2,?000/);
    expect(system).toMatch(/not the athlete's words/);
  });

  it("'my team' with no team member named signs as her, never an invented agency", async () => {
    kimiMock.mockImplementation(async () => streamOf(["Thanks for thinking of us."]));
    const result = await generateDealDraft({
      athleteId: athleteA, dealId: dealA, replyIntent: "decline", style: "friendly", voice: "agent",
    });
    // The floor is set, so the decline is linted (and passes: no figure).
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fullText).not.toMatch(/Management/);
    expect(result.params.voice).toBe("athlete");
  });

  it("anchors on the LATEST offer on the thread, not the detection-time deals.amount", async () => {
    // Raw SQL: an earlier case drops columns a drizzle insert would name.
    const { rows: [d] } = await client.query<{ id: string }>(
      "INSERT INTO deals (athlete_id, brand_name, status, amount) VALUES ($1, 'Moved', 'detected', 200) RETURNING id",
      [athleteA],
    );
    const { rows: [t] } = await client.query<{ id: string }>(
      "INSERT INTO inbox_threads (athlete_id, subject, deal_id, last_message_at, conversation_state) VALUES ($1, 'Offer', $2, now(), $3) RETURNING id",
      [athleteA, d.id, JSON.stringify({ key_details: { offer_struct: { amount: 950 } } })],
    );
    await db.insert(inboxMessages).values({
      thread_id: t.id, athlete_id: athleteA, direction: "inbound", sender_email: "a@moved.com",
      sender_name: "Ana", body: "We can do $950.", platform: "gmail", received_at: new Date(),
    } as any);
    let prompt = "";
    kimiMock.mockImplementation(async (msgs: any[]) => {
      prompt = msgs.map((m: any) => m.content).join(" ");
      return streamOf(["Thanks, that works for me."]);
    });
    const result = await generateDealDraft({
      athleteId: athleteA, dealId: d.id, replyIntent: "accept", style: "friendly", voice: "athlete",
    });
    expect(result.ok).toBe(true);
    expect(prompt).toContain("Offered: $950");
    expect(prompt).not.toMatch(/Offered: \$200/);
  });
});
