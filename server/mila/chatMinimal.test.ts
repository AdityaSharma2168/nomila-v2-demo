/**
 * chatMinimal.test.ts — Mila's chat history keeps no email (decision 9).
 *
 * Pure rules (stub, quote trim, draft card) plus the loop end to end: with
 * MILA_CHAT_MINIMAL on, a turn that calls a mail-reading tool persists no email
 * text, the reply's long quote is trimmed, and a draft card is stored without its
 * body. Then the delete paths: one chat, all chats, and never another athlete's.
 * The model is mocked; no test reaches a provider. DB is PGlite.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("./gemini", () => ({ streamMilaModel: jest.fn(), summarizeConversation: jest.fn() }));

import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { runMilaLoop } from "./loop";
import { streamMilaModel } from "./gemini";
import { milaTools } from "./registry";
import type { MilaTool } from "./types";
import type { SSEStream } from "../lib/sse";
import {
  chatMessages,
  conversations,
  deals,
  inboxThreads,
  voiceContext,
} from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import {
  QUOTE_EXCERPT_CHARS,
  chatMinimalEnabled,
  stubToolResult,
  trimQuotes,
  widgetForStorage,
} from "./chatMinimal";
import { deleteAllConversations, deleteConversation } from "./conversations";

const mockStream = streamMilaModel as jest.Mock;

// Sentinels: if any of these reach chat_messages, email text was stored.
const SUBJECT = "SENTINEL-SUBJECT usage rights renewal for the spring campaign";
const SUMMARY = "SENTINEL-SUMMARY the brand offers a paid post and asks for exclusivity";
const DRAFT = "SENTINEL-DRAFT Hi there, thanks for the offer, I'd love to do it.";
const LONG_QUOTE =
  "SENTINEL-QUOTE " +
  "We would like to extend usage rights for twelve months across paid social, " +
  "with a renewal option at the same rate, payable net thirty after the first post " +
  "goes live, and we ask that you not work with competing brands in the category " +
  "for the duration of the campaign window plus sixty days.";

function chunk(parts: unknown[]) {
  return { candidates: [{ content: { parts } }] };
}
async function* toStream(chunks: unknown[]) {
  for (const c of chunks) yield c;
}
function fakeSSE(): SSEStream {
  const controller = new AbortController();
  return {
    status: () => {},
    token: () => {},
    done: () => {},
    suggestions: () => {},
    profileUpdates: () => {},
    error: () => {},
    close: () => {},
    abort: () => controller.abort(),
    signal: controller.signal,
    get closed() {
      return false;
    },
  } as SSEStream;
}

async function rowsFor(athleteId: string) {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.athlete_id, athleteId))
    .orderBy(asc(chatMessages.created_at));
}

let prev: { minimal?: string; zr?: string };

beforeAll(async () => {
  await initTestDb();
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  mockStream.mockReset();
  prev = { minimal: process.env.MILA_CHAT_MINIMAL, zr: process.env.MAILBOX_ZERO_RETENTION };
  process.env.MILA_CHAT_MINIMAL = "true";
  delete process.env.MAILBOX_ZERO_RETENTION;
});

afterEach(() => {
  if (prev.minimal === undefined) delete process.env.MILA_CHAT_MINIMAL;
  else process.env.MILA_CHAT_MINIMAL = prev.minimal;
  if (prev.zr === undefined) delete process.env.MAILBOX_ZERO_RETENTION;
  else process.env.MAILBOX_ZERO_RETENTION = prev.zr;
});

// ─── pure rules ─────────────────────────────────────────────────────────────

describe("the flag", () => {
  it("is on for MILA_CHAT_MINIMAL or MAILBOX_ZERO_RETENTION, off otherwise", () => {
    expect(chatMinimalEnabled()).toBe(true);
    delete process.env.MILA_CHAT_MINIMAL;
    expect(chatMinimalEnabled()).toBe(false);
    process.env.MAILBOX_ZERO_RETENTION = "true";
    expect(chatMinimalEnabled()).toBe(true);
  });
});

describe("stubToolResult", () => {
  it("keeps ids and derived scalars, never subject, summary or body", () => {
    const stub = stubToolResult("get_deal", {
      id: "d0c0ffee-0000-4000-8000-000000000001",
      brand_name: "A Brand",
      amount: 5000,
      status: "negotiating",
      thread_id: "7e1e0000-0000-4000-8000-000000000002",
      thread: { subject: SUBJECT, summary: SUMMARY, external_message_id: "18c2f1a9b7e0d3c4" },
      messages: [{ id: "msg-1", body: LONG_QUOTE }],
    });
    const json = JSON.stringify(stub);
    expect(json).not.toContain("SENTINEL");
    expect(json).not.toContain("A Brand");
    expect(stub.tool).toBe("get_deal");
    expect(stub.stubbed).toBe(true);
    expect(stub.ids).toEqual(
      expect.arrayContaining([
        "d0c0ffee-0000-4000-8000-000000000001",
        "7e1e0000-0000-4000-8000-000000000002",
        "18c2f1a9b7e0d3c4",
        "msg-1",
      ]),
    );
    expect(stub.fields).toEqual({ amount: 5000, status: "negotiating" });
  });

  it("refuses an id-named field that holds prose", () => {
    const stub = stubToolResult("x", { brand_id: "this is a sentence, not an id" });
    expect(stub.ids).toEqual([]);
  });

  it("marks an error without keeping its message", () => {
    const stub = stubToolResult("x", { error: `x failed: ${SUBJECT}` });
    expect(stub.error).toBe(true);
    expect(JSON.stringify(stub)).not.toContain("SENTINEL");
  });
});

describe("trimQuotes", () => {
  it("trims a long quoted span to a short excerpt and keeps Mila's own words", () => {
    const reply = `Here's what they said: "${LONG_QUOTE}" I'd push back on the exclusivity.`;
    const out = trimQuotes(reply);
    const quoted = out.match(/"([^"]+)"/)![1];
    expect(quoted.length).toBeLessThanOrEqual(QUOTE_EXCERPT_CHARS + 1);
    expect(quoted.endsWith("…")).toBe(true);
    expect(out).toContain("Here's what they said:");
    expect(out).toContain("I'd push back on the exclusivity.");
    expect(out).not.toContain("sixty days");
  });

  it("trims curly quotes, blockquotes and fenced blocks", () => {
    for (const reply of [
      `They wrote “${LONG_QUOTE}”.`,
      `They wrote:\n> ${LONG_QUOTE.slice(0, 150)}\n> ${LONG_QUOTE.slice(150)}\nThat's the gist.`,
      "They wrote:\n```\n" + LONG_QUOTE + "\n```\nThat's the gist.",
    ]) {
      const out = trimQuotes(reply);
      expect(out).not.toContain("sixty days");
      expect(out).toContain("…");
    }
  });

  it("leaves short quotes and plain prose alone", () => {
    const reply = 'They said "sounds great" and offered $5,000. ' + "x".repeat(400);
    expect(trimQuotes(reply)).toBe(reply);
  });
});

describe("widgetForStorage", () => {
  it("stores a draft card without its body, as needsDraft", () => {
    const stored = widgetForStorage({
      type: "reply_action",
      data: {
        dealId: "d", threadId: "t", platform: "gmail", sendable: true, brandName: "B",
        draft: DRAFT, refusal: null,
        params: { replyIntent: "accept", style: "friendly", voice: "athlete", selectedTerms: [], includeMediaKit: false },
      },
    });
    expect(JSON.stringify(stored)).not.toContain("SENTINEL");
    expect(stored?.type).toBe("reply_action");
    expect((stored as any).data.needsDraft).toBe(true);
    expect((stored as any).data.draft).toBeNull();
  });
});

// ─── the loop, end to end ───────────────────────────────────────────────────

describe("runMilaLoop with MILA_CHAT_MINIMAL on", () => {
  it("a turn that calls a mail tool (get_deal) persists no email text", async () => {
    const athleteId = await seedAthlete("Minimal Mail");
    const [deal] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId, brand_name: "A Brand", deal_type: "social_post",
        amount: "5000", status: "negotiating", source: "inbox_scan",
      })
      .returning({ id: deals.id });
    const [thread] = await db
      .insert(inboxThreads)
      .values({ athlete_id: athleteId, deal_id: deal.id, subject: SUBJECT, summary: SUMMARY, status: "unread" })
      .returning({ id: inboxThreads.id });

    mockStream
      .mockResolvedValueOnce(toStream([chunk([{ functionCall: { name: "get_deal", args: { deal_id: deal.id } } }])]))
      .mockResolvedValueOnce(toStream([chunk([{ text: `They asked: "${LONG_QUOTE}" Want me to push back?` }])]));

    const conversationId = randomUUID();
    const { text } = await runMilaLoop({ athleteId, message: "what did they say?", sse: fakeSSE(), conversationId });

    // The model DID see the email-derived result this turn (it is live, in memory)…
    const fr = (mockStream.mock.calls[1][0] as any[]).at(-1).parts[0].functionResponse;
    expect(JSON.stringify(fr)).toContain("SENTINEL-SUBJECT");
    // …and she saw the whole answer live.
    expect(text).toContain("sixty days");

    const rows = await rowsFor(athleteId);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain("SENTINEL-SUBJECT");
    expect(stored).not.toContain("SENTINEL-SUMMARY");
    expect(stored).not.toContain("sixty days");

    // The tool row is a reference: tool name + ids.
    const toolRow = JSON.parse(rows[2].content!);
    expect(toolRow).toMatchObject({ tool: "get_deal", stubbed: true });
    expect(toolRow.ids).toEqual(expect.arrayContaining([deal.id, thread.id]));

    // The reply's quote is trimmed; Mila's own words are kept.
    const reply = rows[3].content!;
    expect(reply).toContain("Want me to push back?");
    expect(reply.match(/"([^"]+)"/)![1].length).toBeLessThanOrEqual(QUOTE_EXCERPT_CHARS + 1);
  });

  it("stores a draft card without the draft body", async () => {
    const athleteId = await seedAthlete("Minimal Draft");
    const fakeDraft: MilaTool = {
      name: "draft_reply",
      description: "test draft",
      argsSchema: z.object({}),
      execute: async () => ({
        deal_id: randomUUID(), thread_id: randomUUID(), platform: "gmail", has_inbound: true,
        sendable: true, brand_name: "A Brand", draft: DRAFT, refusal: null,
        reply_intent: "accept", style: "friendly", voice: "athlete", selected_terms: [], include_media_kit: false,
      }),
    } as unknown as MilaTool;
    mockStream
      .mockResolvedValueOnce(toStream([chunk([{ functionCall: { name: "draft_reply", args: {} } }])]))
      .mockResolvedValueOnce(toStream([chunk([{ text: "Here's a draft for you to review." }])]));

    const { widget } = await runMilaLoop(
      { athleteId, message: "draft a reply", sse: fakeSSE(), conversationId: randomUUID() },
      [fakeDraft],
    );
    // Live card still carries the draft for review now.
    expect((widget as any)?.data.draft).toBe(DRAFT);

    const rows = await rowsFor(athleteId);
    expect(JSON.stringify(rows)).not.toContain("SENTINEL-DRAFT");
    const answer = rows.at(-1)!;
    expect((answer.widget as any).data).toMatchObject({ draft: null, needsDraft: true });
  });

  it("flag off: the payload is stored as before (no behaviour change)", async () => {
    delete process.env.MILA_CHAT_MINIMAL;
    const athleteId = await seedAthlete("Flag Off");
    const echo: MilaTool = {
      name: "echo", description: "echo", argsSchema: z.object({}),
      execute: async () => ({ note: "SENTINEL-OFF" }),
    } as unknown as MilaTool;
    mockStream
      .mockResolvedValueOnce(toStream([chunk([{ functionCall: { name: "echo", args: {} } }])]))
      .mockResolvedValueOnce(toStream([chunk([{ text: "done" }])]));
    await runMilaLoop({ athleteId, message: "hi", sse: fakeSSE() }, [echo]);
    const rows = await rowsFor(athleteId);
    expect(rows[2].content).toContain("SENTINEL-OFF");
  });
});

// ─── delete ─────────────────────────────────────────────────────────────────

async function seedChat(athleteId: string, conversationId: string | null) {
  await db.insert(chatMessages).values([
    { athlete_id: athleteId, role: "user", content: "q", conversation_id: conversationId },
    { athlete_id: athleteId, role: "assistant", content: "a", conversation_id: conversationId },
  ]);
  if (conversationId) {
    await db.insert(conversations).values({ id: conversationId, athlete_id: athleteId, title: "t" } as any);
    await db.insert(voiceContext).values({ conversation_id: conversationId, athlete_id: athleteId } as any);
  }
}

async function counts(athleteId: string) {
  const m = await db.select().from(chatMessages).where(eq(chatMessages.athlete_id, athleteId));
  const c = await db.select().from(conversations).where(eq(conversations.athlete_id, athleteId));
  const v = await db.select().from(voiceContext).where(eq(voiceContext.athlete_id, athleteId));
  return { messages: m.length, conversations: c.length, voiceContexts: v.length };
}

describe("deleting chats", () => {
  it("deleteConversation removes that chat's rows for that athlete only", async () => {
    const a = await seedAthlete("Delete A");
    const b = await seedAthlete("Delete B");
    const keep = randomUUID();
    const gone = randomUUID();
    await seedChat(a, gone);
    await seedChat(a, keep);
    await seedChat(b, randomUUID());

    // B cannot delete A's chat by knowing its id.
    expect(await deleteConversation(b, gone)).toEqual({ messages: 0, conversations: 0, voiceContexts: 0 });
    expect(await counts(a)).toEqual({ messages: 4, conversations: 2, voiceContexts: 2 });

    expect(await deleteConversation(a, gone)).toEqual({ messages: 2, conversations: 1, voiceContexts: 1 });
    expect(await counts(a)).toEqual({ messages: 2, conversations: 1, voiceContexts: 1 });
    expect(await counts(b)).toEqual({ messages: 2, conversations: 1, voiceContexts: 1 });
  });

  it("deleteAllConversations removes every chat of that athlete, including id-less turns, and nobody else's", async () => {
    const a = await seedAthlete("All A");
    const b = await seedAthlete("All B");
    await seedChat(a, randomUUID());
    await seedChat(a, null);
    await seedChat(b, randomUUID());

    const r = await deleteAllConversations(a);
    expect(r).toEqual({ messages: 4, conversations: 1, voiceContexts: 1 });
    expect(await counts(a)).toEqual({ messages: 0, conversations: 0, voiceContexts: 0 });
    expect(await counts(b)).toEqual({ messages: 2, conversations: 1, voiceContexts: 1 });
  });
});

// Keep the production registry honest: every tool the loop can call is stubbed by
// the same rule, so a new tool that returns email text is covered on day one.
it("the stub covers every registered tool by construction", () => {
  for (const t of milaTools) {
    const stub = stubToolResult(t.name, { body: "SENTINEL", subject: "SENTINEL", id: "abc" });
    expect(JSON.stringify(stub)).not.toContain("SENTINEL");
  }
});
