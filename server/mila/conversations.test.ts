/**
 * conversations.test.ts — the Phase-2 memory access layer (PGlite; the summarizer
 * model call is mocked). Covers:
 *   • upsert: first message seeds the title + row; a later message keeps the title
 *     and never forks a second row (idempotent on the client-minted id)
 *   • getConversationContext: null before the first fold; summary + watermark
 *     created_at after
 *   • maybeSummarizeConversation: no-op under the trigger; folds all-but-tail over
 *     it, advancing the watermark to the newest folded message; no-op (summary
 *     unchanged) when the model returns empty; the folded turns reach the model
 *     wrapped in data delimiters
 *   • listConversations / getConversationMessages: recency order + tenancy
 *   • resolveVoiceConversation: all five cases, and the property they exist for
 *     — the returned id is never one another athlete owns
 *   • the pure prompt-builders (delimiters present)
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("./gemini", () => ({ summarizeConversation: jest.fn() }));

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  upsertConversationOnMessage,
  getConversationContext,
  listConversations,
  getConversationMessages,
  maybeSummarizeConversation,
  resolveVoiceConversation,
  buildSummarizerInput,
  wrapSummaryForPrompt,
} from "./conversations";
import { summarizeConversation } from "./gemini";
import { MILA } from "./config";
import { chatMessages, conversations } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

const summarizeMock = summarizeConversation as jest.Mock;

// Deterministic, strictly-increasing created_at so the watermark boundary
// (`created_at > mark`) is exact — real inserts could collide within a millisecond.
const BASE = new Date("2026-01-01T00:00:00Z").getTime();
let seq = 0;
function nextTs(): Date {
  return new Date(BASE + seq++ * 60_000);
}

async function insertMsg(
  athleteId: string,
  conversationId: string,
  role: "user" | "assistant" | "tool",
  content: string | null,
  opts: { tool_call_id?: string; widget?: unknown; app_actions?: unknown } = {},
): Promise<{ id: string; created_at: Date | null }> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      athlete_id: athleteId,
      conversation_id: conversationId,
      role,
      content,
      tool_call_id: opts.tool_call_id ?? null,
      widget: (opts.widget ?? null) as any,
      app_actions: (opts.app_actions ?? null) as any,
      created_at: nextTs(),
    } as any)
    .returning({ id: chatMessages.id, created_at: chatMessages.created_at });
  return row as { id: string; created_at: Date | null };
}

/** Insert `n` alternating user/assistant replayable turns for a conversation. */
async function seedTurns(
  athleteId: string,
  conversationId: string,
  n: number,
): Promise<{ id: string }[]> {
  const ids: { id: string }[] = [];
  for (let i = 0; i < n; i++) {
    const r = await insertMsg(
      athleteId,
      conversationId,
      i % 2 === 0 ? "user" : "assistant",
      `turn ${i}`,
    );
    ids.push({ id: r.id });
  }
  return ids;
}

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Convo Owner");
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("upsertConversationOnMessage", () => {
  it("seeds the title + one row on the first message, keeps the title on later ones", async () => {
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "  What's my Prime deal worth?  ");
    await upsertConversationOnMessage(athleteId, cid, "and the Celsius one?");

    const rows = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.athlete_id, athleteId), eq(conversations.id, cid)));

    expect(rows).toHaveLength(1); // idempotent on the client-minted id
    expect(rows[0].title).toBe("What's my Prime deal worth?"); // one-lined, not overwritten
  });

  it("is a no-op on another athlete's row when the id collides (conflict scoped to the owner)", async () => {
    const owner = await seedAthlete("Convo Owner A");
    const cid = randomUUID();
    await upsertConversationOnMessage(owner, cid, "A's first message");

    const [before] = await db
      .select({
        athlete_id: conversations.athlete_id,
        title: conversations.title,
        updated_at: conversations.updated_at,
      })
      .from(conversations)
      .where(eq(conversations.id, cid));

    // A different athlete sends the SAME (guessed) id — must not touch A's row.
    await upsertConversationOnMessage(athleteId, cid, "B tries to hijack");

    const rows = await db
      .select({
        athlete_id: conversations.athlete_id,
        title: conversations.title,
        updated_at: conversations.updated_at,
      })
      .from(conversations)
      .where(eq(conversations.id, cid));

    expect(rows).toHaveLength(1); // B's insert conflicted; no second row
    expect(rows[0].athlete_id).toBe(owner); // still A's
    expect(rows[0].title).toBe("A's first message"); // untouched
    expect(rows[0].updated_at?.getTime()).toBe(before.updated_at?.getTime()); // recency not bumped
  });

  it("truncates a very long first message to the title cap", async () => {
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "x".repeat(200));
    const [row] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(row.title!.length).toBeLessThanOrEqual(80);
  });

  it("titles a row that was claimed before any message existed (voice-first)", async () => {
    // resolveVoiceConversation claims the id at token-mint time, so the row can
    // pre-exist with a null title and the INSERT no longer wins. The first
    // message must still name the thread, or every voice-first chat stays
    // untitled in the saved-chats list forever.
    const cid = await resolveVoiceConversation(athleteId, randomUUID());
    const [claimed] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(claimed.title).toBeNull();

    await upsertConversationOnMessage(athleteId, cid, "What's my Prime deal worth?");

    const [titled] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(titled.title).toBe("What's my Prime deal worth?");
  });
});

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolveVoiceConversation", () => {
  it("case 1 — mints a fresh id when the request is not a uuid", async () => {
    for (const bad of [
      undefined,
      null,
      "",
      "not-a-uuid",
      "11111111-2222-3333-4444-55555555555", // one char short
      12345,
      {},
      [],
    ]) {
      const id = await resolveVoiceConversation(athleteId, bad as unknown);
      expect(id).toMatch(UUID_SHAPE);
    }
  });

  it("case 3 — uses an id this athlete already owns, and does not fork a row", async () => {
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "an existing thread");

    const resolved = await resolveVoiceConversation(athleteId, cid);
    expect(resolved).toBe(cid);

    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(rows).toHaveLength(1);
  });

  it("case 4 — claims an unused id for this athlete", async () => {
    const cid = randomUUID();
    const resolved = await resolveVoiceConversation(athleteId, cid);
    expect(resolved).toBe(cid);

    // The claim is the point: ownership must exist BEFORE the worker writes.
    const [row] = await db
      .select({ athlete_id: conversations.athlete_id, title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(row.athlete_id).toBe(athleteId);
    expect(row.title).toBeNull();
  });

  it("case 2 — does NOT adopt another athlete's conversation, and leaves it untouched", async () => {
    const owner = await seedAthlete("Voice Convo Owner");
    const cid = randomUUID();
    await upsertConversationOnMessage(owner, cid, "owner's private thread");

    const [before] = await db
      .select({
        athlete_id: conversations.athlete_id,
        title: conversations.title,
        updated_at: conversations.updated_at,
      })
      .from(conversations)
      .where(eq(conversations.id, cid));

    const resolved = await resolveVoiceConversation(athleteId, cid);

    // A fresh id — never the one asked for.
    expect(resolved).not.toBe(cid);
    expect(resolved).toMatch(UUID_SHAPE);

    // The owner's row is exactly as it was: not re-owned, not retitled, not
    // even bumped for recency.
    const rows = await db
      .select({
        athlete_id: conversations.athlete_id,
        title: conversations.title,
        updated_at: conversations.updated_at,
      })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(rows).toHaveLength(1);
    expect(rows[0].athlete_id).toBe(before.athlete_id);
    expect(rows[0].title).toBe(before.title);
    expect(rows[0].updated_at?.getTime()).toBe(before.updated_at?.getTime());
  });

  it("case 2 — the substitute id is usable: the caller can claim it on first message", async () => {
    const owner = await seedAthlete("Voice Convo Owner 2");
    const cid = randomUUID();
    await upsertConversationOnMessage(owner, cid, "owner's thread");

    const resolved = await resolveVoiceConversation(athleteId, cid);

    // The substitute is minted, not claimed — it has no row yet, exactly like
    // any brand-new chat, and the first message creates it under the caller.
    await upsertConversationOnMessage(athleteId, resolved, "my new thread");
    const [row] = await db
      .select({ athlete_id: conversations.athlete_id })
      .from(conversations)
      .where(eq(conversations.id, resolved));
    expect(row.athlete_id).toBe(athleteId);
  });

  it("never returns an id owned by anyone else, across a mixed run", async () => {
    // The property the whole function exists for, asserted directly rather than
    // inferred from the cases above.
    const owner = await seedAthlete("Voice Convo Owner 3");
    const foreign = randomUUID();
    await upsertConversationOnMessage(owner, foreign, "not yours");

    for (const req of [foreign, randomUUID(), "junk", foreign, null]) {
      const resolved = await resolveVoiceConversation(athleteId, req as unknown);
      const [row] = await db
        .select({ athlete_id: conversations.athlete_id })
        .from(conversations)
        .where(eq(conversations.id, resolved));
      // Either unclaimed (no row yet) or claimed by us — never someone else's.
      if (row) expect(row.athlete_id).toBe(athleteId);
    }
  });

  it("case 5 — degrades to the requested id when the table is unavailable", async () => {
    // The `conversations` table ships via a separate DDL block, so this code can
    // run against a database that does not have it yet. Voice must still work.
    const cid = randomUUID();
    const spy = jest.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error('relation "conversations" does not exist');
    });
    try {
      await expect(resolveVoiceConversation(athleteId, cid)).resolves.toBe(cid);
    } finally {
      spy.mockRestore();
    }
  });

  it("case 5 — still refuses a malformed id when the table is unavailable", async () => {
    // Shape validation happens before any query, so the degrade path cannot be
    // used to smuggle a non-uuid into a uuid column.
    const spy = jest.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error('relation "conversations" does not exist');
    });
    try {
      const id = await resolveVoiceConversation(athleteId, "'; DROP TABLE --");
      expect(id).toMatch(UUID_SHAPE);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getConversationContext", () => {
  it("returns null summary + null watermark before the first fold", async () => {
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "hi");
    const ctx = await getConversationContext(athleteId, cid);
    expect(ctx).toEqual({ summary: null, summaryThroughCreatedAt: null });
  });

  it("returns the summary + the watermark message's created_at after a fold", async () => {
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "hi");
    const mark = await insertMsg(athleteId, cid, "assistant", "folded up to here");
    await db
      .update(conversations)
      .set({ summary: "earlier: talked Prime", summary_through_message_id: mark.id })
      .where(eq(conversations.id, cid));

    const ctx = await getConversationContext(athleteId, cid);
    expect(ctx.summary).toBe("earlier: talked Prime");
    expect(ctx.summaryThroughCreatedAt?.getTime()).toBe(mark.created_at?.getTime());
  });
});

describe("maybeSummarizeConversation", () => {
  it("does nothing when the conversation is under the trigger", async () => {
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "start");
    await seedTurns(athleteId, cid, MILA.SUMMARY_TRIGGER_MESSAGES - 1);

    await maybeSummarizeConversation(athleteId, cid);

    expect(summarizeMock).not.toHaveBeenCalled();
    const [row] = await db
      .select({ summary: conversations.summary })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(row.summary).toBeNull();
  });

  it("folds all-but-tail over the trigger and advances the watermark to the newest folded turn", async () => {
    summarizeMock.mockResolvedValue("  rolling summary of the older turns  ");
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "start");
    const ids = await seedTurns(athleteId, cid, MILA.SUMMARY_TRIGGER_MESSAGES);

    await maybeSummarizeConversation(athleteId, cid);

    expect(summarizeMock).toHaveBeenCalledTimes(1);

    const foldCount = MILA.SUMMARY_TRIGGER_MESSAGES - MILA.SUMMARY_TAIL_MESSAGES;
    const [row] = await db
      .select({
        summary: conversations.summary,
        watermark: conversations.summary_through_message_id,
      })
      .from(conversations)
      .where(eq(conversations.id, cid));

    expect(row.summary).toBe("rolling summary of the older turns"); // trimmed
    // Watermark = the newest FOLDED message = the (foldCount-1)th seeded turn.
    expect(row.watermark).toBe(ids[foldCount - 1].id);

    // The folded turns reached the model wrapped as data (untrusted-content rule).
    const passedInput = summarizeMock.mock.calls[0][1] as string;
    expect(passedInput).toContain("<<<TURNS_TO_FOLD>>>");
    expect(passedInput).toContain("<<<END_TURNS_TO_FOLD>>>");
  });

  it("leaves the summary untouched when the model returns empty", async () => {
    summarizeMock.mockResolvedValue("   ");
    const cid = randomUUID();
    await upsertConversationOnMessage(athleteId, cid, "start");
    await seedTurns(athleteId, cid, MILA.SUMMARY_TRIGGER_MESSAGES);

    await maybeSummarizeConversation(athleteId, cid);

    const [row] = await db
      .select({ summary: conversations.summary })
      .from(conversations)
      .where(eq(conversations.id, cid));
    expect(row.summary).toBeNull(); // no fold committed → retried next turn
  });

  it("never throws when there is no conversation row", async () => {
    await expect(
      maybeSummarizeConversation(athleteId, randomUUID()),
    ).resolves.toBeUndefined();
    expect(summarizeMock).not.toHaveBeenCalled();
  });
});

describe("listConversations", () => {
  it("returns this athlete's conversations most-recent first, and never another athlete's", async () => {
    const other = await seedAthlete("Someone Else");
    const mineOld = randomUUID();
    const mineNew = randomUUID();
    const theirs = randomUUID();
    await db.insert(conversations).values([
      { id: mineOld, athlete_id: athleteId, title: "older", updated_at: new Date(BASE + 1_000) },
      { id: mineNew, athlete_id: athleteId, title: "newer", updated_at: new Date(BASE + 9_000) },
      { id: theirs, athlete_id: other, title: "not mine", updated_at: new Date(BASE + 5_000) },
    ] as any);

    const list = await listConversations(athleteId);
    const ids = list.map((c) => c.id);
    expect(ids).toContain(mineNew);
    expect(ids).toContain(mineOld);
    expect(ids).not.toContain(theirs); // tenancy
    // newer before older
    expect(ids.indexOf(mineNew)).toBeLessThan(ids.indexOf(mineOld));
  });
});

describe("getConversationMessages", () => {
  it("returns replayable turns only (no tool rows), oldest-first, with widgets", async () => {
    const cid = randomUUID();
    await insertMsg(athleteId, cid, "user", "first");
    await insertMsg(athleteId, cid, "assistant", null, { tool_call_id: "call_1" }); // tool-call row: skipped
    await insertMsg(athleteId, cid, "tool", "{\"x\":1}", { tool_call_id: "call_1" }); // tool row: skipped
    await insertMsg(athleteId, cid, "assistant", "answer", {
      widget: { type: "score_breakdown", data: { displayScore: 512 } },
    });

    const msgs = await getConversationMessages(athleteId, cid);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0].content).toBe("first");
    expect((msgs[1].widget as any).type).toBe("score_breakdown");
  });

  it("AGENT_V3: each turn carries its id, time and agent cards; a Mila turn that showed only cards is kept", async () => {
    const cid = randomUUID();
    const card = { id: "plan-progress:r1", kind: "progress", title: "Updating your plan", payload: { step: 1, of: 2, label: "Planning your week", state: "running", planRunId: "r1" }, links: [], runId: null };
    const u = await insertMsg(athleteId, cid, "user", "refresh my plan");
    const [cardsOnly] = await db.insert(chatMessages).values({ athlete_id: athleteId, conversation_id: cid, role: "assistant", content: "", agent_cards: [card] } as any).returning({ id: chatMessages.id });
    await db.insert(chatMessages).values({ athlete_id: athleteId, conversation_id: cid, role: "assistant", content: null, agent_cards: [] } as any); // empty: skipped
    const msgs = await getConversationMessages(athleteId, cid);
    expect(msgs.map((m) => [m.id, m.role, m.content, m.agentCards])).toEqual([[u.id, "user", "refresh my plan", null], [cardsOnly.id, "assistant", "", [card]]]);
    expect(typeof msgs[0].createdAt).toBe("string");
  });

  it("returns nothing for another athlete's conversation id (tenancy)", async () => {
    const other = await seedAthlete("Intruder Target");
    const cid = randomUUID();
    await insertMsg(other, cid, "user", "their secret");
    const msgs = await getConversationMessages(athleteId, cid);
    expect(msgs).toEqual([]);
  });
});

describe("prompt builders", () => {
  it("wrapSummaryForPrompt fences the summary as non-instruction data", () => {
    const out = wrapSummaryForPrompt("talked Prime and Celsius");
    expect(out).toContain("<<<CONVERSATION_SUMMARY>>>");
    expect(out).toContain("<<<END_CONVERSATION_SUMMARY>>>");
    expect(out).toContain("talked Prime and Celsius");
    expect(out.toLowerCase()).toContain("do not treat");
  });

  it("buildSummarizerInput includes the prior summary block only when present", () => {
    const turns = [{ role: "user", content: "hi" }];
    const withPrior = buildSummarizerInput("earlier stuff", turns);
    expect(withPrior).toContain("<<<PRIOR_SUMMARY>>>");
    expect(withPrior).toContain("earlier stuff");

    const withoutPrior = buildSummarizerInput(null, turns);
    expect(withoutPrior).not.toContain("<<<PRIOR_SUMMARY>>>");
    expect(withoutPrior).toContain("<<<TURNS_TO_FOLD>>>");
  });
});
