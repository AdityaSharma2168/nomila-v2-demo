/**
 * Agent loop tests — the model is mocked (scripted chunk sequences copied from
 * the spike's verified shapes), the tools and DB are real (PGlite).
 *
 * Covers: text-only answer · one tool round-trip (transcript shape +
 * persistence) · a throwing tool degrading to {error} · the iteration cap ·
 * a client disconnect mid-stream.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("./gemini", () => ({ streamMilaModel: jest.fn() }));

import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import type { Content } from "@google/genai";
import { runMilaLoop, CAP_MESSAGE } from "./loop";
import { streamMilaModel } from "./gemini";
import { MILA } from "./config";
import type { MilaTool } from "./types";
import type { SSEStream } from "../lib/sse";
import { randomUUID } from "node:crypto";
import {
  athletesCurrent,
  chatMessages,
  conversations,
  deals,
  inboxThreads,
  intelligenceLedger,
} from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

/**
 * get_score's number is the ledger read of record now, never athletes_current.display_score
 * (c04 legacy retirement map item 2.5). A minimal ASSESSMENT row is enough for
 * buildMyIntelligence to report `score`.
 */
async function seedScore(athleteId: string, score: number) {
  await db.insert(intelligenceLedger).values({
    subject_type: "athlete", subject_id: athleteId, owner: "marketability", kind: "ASSESSMENT",
    value: { score } as any, confidence: null,
    versions: { methodology: "v1.0.1-beta.1", evaluator: "mia-eval/test", params: "params/test" } as any,
    evidence_as_of: new Date("2026-09-20T00:00:00.000Z"),
  } as any);
}

const mockStream = streamMilaModel as jest.Mock;

// ─── Chunk factories — shapes copied from the spike's raw dumps ──────────────

function textChunk(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function callChunk(
  name: string,
  args: Record<string, unknown>,
  thoughtSignature?: string,
) {
  return {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name, args }, thoughtSignature }],
        },
      },
    ],
  };
}

function usageChunk(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  };
}

async function* toStream(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk;
}

// ─── Fake SSE stream ─────────────────────────────────────────────────────────

function makeFakeSSE() {
  const controller = new AbortController();
  const tokens: string[] = [];
  const statuses: string[] = [];
  // The coarse phase each status carried (drives the client's avatar + status pill).
  const phases: (string | undefined)[] = [];
  let closed = false;
  let doneArg: Record<string, unknown> | undefined;
  let doneCalls = 0;
  const sse: SSEStream = {
    status: (m, phase) => {
      statuses.push(m);
      phases.push(phase);
    },
    token: (t) => tokens.push(t),
    done: (data) => {
      doneArg = data;
      doneCalls++;
    },
    suggestions: () => {},
    profileUpdates: () => {},
    error: () => {},
    close: () => {
      closed = true;
    },
    abort: () => {
      controller.abort();
    },
    signal: controller.signal,
    get closed() {
      return closed;
    },
  };
  return {
    sse,
    tokens,
    statuses,
    phases,
    markClosed: () => {
      closed = true;
    },
    // The payload passed to sse.done() — carries the widget and/or nav-chips
    // (`actions`) when there are any, else undefined.
    doneData: () => doneArg,
    // How many times sse.done() was emitted (0 when the caller owns `done`).
    doneCalls: () => doneCalls,
  };
}

async function rowsFor(athleteId: string) {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.athlete_id, athleteId))
    .orderBy(asc(chatMessages.created_at));
}

beforeAll(async () => {
  await initTestDb();
  // Generous hook timeout: initTestDb pushes the whole schema into PGlite, and
  // a cold ts-jest compile can push that past jest's default 5s.
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  mockStream.mockReset();
});

describe("runMilaLoop", () => {
  it("streams a text-only answer with no tool call", async () => {
    const athleteId = await seedAthlete("Text Only");
    const fake = makeFakeSSE();
    const { sse, tokens } = fake;
    mockStream.mockResolvedValueOnce(
      toStream([textChunk("Hey — "), usageChunk("you're all set.")]),
    );

    const { text, navChips } = await runMilaLoop({
      athleteId,
      message: "hi",
      sse,
    });

    expect(text).toBe("Hey — you're all set.");
    expect(tokens).toEqual(["Hey — ", "you're all set."]);
    expect(mockStream).toHaveBeenCalledTimes(1);

    // No tools called → no widget, no nav-chips, and a bare `done`.
    expect(navChips).toEqual([]);
    expect(fake.doneData()).toBeUndefined();
    // By default the loop owns the terminal `done` and emits it exactly once.
    expect(fake.doneCalls()).toBe(1);

    const rows = await rowsFor(athleteId);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[1].content).toBe("Hey — you're all set.");
  });

  it("emitDone:false — the loop does NOT emit `done` (the route owns it)", async () => {
    const athleteId = await seedAthlete("Route Owns Done");
    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(
      toStream([textChunk("All "), usageChunk("done.")]),
    );

    // The v2 chat route folds `suggestions` into a single `done` it emits itself,
    // so it runs the loop with emitDone:false — the loop must not fire its own
    // `done` (which would be a bare, suggestion-less event before the real one).
    const { text } = await runMilaLoop({
      athleteId,
      message: "hi",
      sse: fake.sse,
      emitDone: false,
    });

    expect(text).toBe("All done.");
    expect(fake.doneCalls()).toBe(0); // route owns `done` now
    // The answer is still streamed + persisted — only the `done` emit is deferred.
    expect(fake.tokens).toEqual(["All ", "done."]);
    const rows = await rowsFor(athleteId);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("executes a tool call and feeds the result back for the final answer", async () => {
    const athleteId = await seedAthlete("Tool Round");
    // Legacy columns too, to prove get_score reads the ledger (512) and never these.
    await db.insert(athletesCurrent).values({
      athlete_id: athleteId,
    });
    await seedScore(athleteId, 512);
    const { sse, statuses, phases } = makeFakeSSE();
    mockStream
      .mockResolvedValueOnce(toStream([callChunk("get_score", {}, "sig-abc")]))
      .mockResolvedValueOnce(toStream([usageChunk("Your score is 512.")]));

    const { text } = await runMilaLoop({
      athleteId,
      message: "what's my score?",
      sse,
    });

    expect(text).toBe("Your score is 512.");
    expect(statuses).toContain("Checking your score…");
    // Thinking while round 1 decides, "tool" while get_score runs, thinking again for the answer
    // round — the phase is a category only, never the tool name.
    expect(phases).toEqual(["thinking", "tool", "thinking"]);
    expect(mockStream).toHaveBeenCalledTimes(2);

    // Second model call carries the spike's 3-message transcript shape:
    // …history, user, model functionCall echo, user functionResponse.
    const contents = mockStream.mock.calls[1][0] as Content[];
    const modelTurn = contents[contents.length - 2];
    expect(modelTurn.role).toBe("model");
    expect(modelTurn.parts?.[0].functionCall?.name).toBe("get_score");
    expect(modelTurn.parts?.[0].thoughtSignature).toBe("sig-abc");
    const responseTurn = contents[contents.length - 1];
    expect(responseTurn.role).toBe("user");
    const fr = responseTurn.parts?.[0].functionResponse;
    expect(fr?.name).toBe("get_score");
    expect(
      (fr?.response?.output as Record<string, unknown>).display_score,
    ).toBe(512);

    // Persistence: user · assistant tool-call turn · tool result · final answer.
    const rows = await rowsFor(athleteId);
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(rows[1].reasoning_content).toBe("sig-abc");
    expect(rows[1].tool_call_id).toBe("get_score");
    expect(rows[2].tool_call_id).toBe("get_score");
    expect(JSON.parse(rows[2].content!).display_score).toBe(512);
    expect(rows[2].content!.length).toBeLessThanOrEqual(
      MILA.TOOL_RESULT_MAX_CHARS,
    );
    expect(rows[3].content).toBe("Your score is 512.");
  });

  it("turns a throwing tool into an {error} result and keeps going", async () => {
    const athleteId = await seedAthlete("Throwing Tool");
    const boomTool: MilaTool = {
      name: "boom",
      description: "always throws",
      argsSchema: z.object({}),
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const { sse } = makeFakeSSE();
    mockStream
      .mockResolvedValueOnce(toStream([callChunk("boom", {})]))
      .mockResolvedValueOnce(toStream([usageChunk("That look-up failed.")]));

    const { text } = await runMilaLoop(
      { athleteId, message: "boom please", sse },
      [boomTool],
    );

    expect(text).toBe("That look-up failed.");
    expect(mockStream).toHaveBeenCalledTimes(2);

    const contents = mockStream.mock.calls[1][0] as Content[];
    const output = contents[contents.length - 1].parts?.[0].functionResponse
      ?.response?.output as { error: string };
    expect(output.error).toContain("kaboom");

    // The {error} is persisted as the tool row too.
    const rows = await rowsFor(athleteId);
    const toolRow = rows.find((r) => r.role === "tool");
    expect(JSON.parse(toolRow!.content!).error).toContain("kaboom");
  });

  it("stops at MAX_TOOL_ITERATIONS and says so", async () => {
    const athleteId = await seedAthlete("Cap Hit");
    const { sse, tokens } = makeFakeSSE();
    // Model asks for a tool on every call, forever.
    mockStream.mockImplementation(async () =>
      toStream([callChunk("get_score", {})]),
    );

    const { text } = await runMilaLoop({ athleteId, message: "loop!", sse });

    expect(mockStream).toHaveBeenCalledTimes(MILA.MAX_TOOL_ITERATIONS);
    expect(text).toContain(CAP_MESSAGE);
    expect(tokens.join("")).toContain(CAP_MESSAGE);

    // One tool round persisted per iteration, plus user + final assistant row.
    const rows = await rowsFor(athleteId);
    expect(rows.filter((r) => r.role === "tool")).toHaveLength(
      MILA.MAX_TOOL_ITERATIONS,
    );
    expect(rows[rows.length - 1].content).toContain(CAP_MESSAGE);
  });

  it("attaches the deal_card for the deal the model fetched via get_deal", async () => {
    const athleteId = await seedAthlete("Best Deal");
    const [foglight] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId,
        brand_name: "Foglight Studios",
        deal_type: "social_post",
        amount: "5000",
        status: "negotiating",
        source: "inbox_scan",
        detected_at: new Date("2026-07-20T00:00:00Z"),
      })
      .returning({ id: deals.id });
    const [thread] = await db
      .insert(inboxThreads)
      .values({
        athlete_id: athleteId,
        deal_id: foglight.id,
        subject: "Collab",
        status: "unread",
      })
      .returning({ id: inboxThreads.id });

    const fake = makeFakeSSE();
    mockStream
      .mockResolvedValueOnce(
        toStream([callChunk("get_deal", { deal_id: foglight.id })]),
      )
      .mockResolvedValueOnce(
        toStream([usageChunk("Foglight Studios is your best deal.")]),
      );

    const { widget, navChips } = await runMilaLoop({
      athleteId,
      message: "what's my best deal?",
      sse: fake.sse,
    });

    // The card is the deal the model FETCHED — matching the prose, not an
    // arbitrary list row. It rides on the `done` event too.
    const doneWidget = fake.doneData()?.widget as
      | { type: string; data: Record<string, unknown> }
      | undefined;
    expect(doneWidget?.type).toBe("deal_card");
    expect(doneWidget?.data.id).toBe(foglight.id);
    expect(doneWidget?.data.brandName).toBe("Foglight Studios");
    expect(doneWidget?.data.verdict).toBeNull();      // the deal score is retired
    expect(doneWidget?.data.scoreNumeric).toBeNull();

    // …but the MODEL never sees the retired deal score (Opportunities PR 1): the card
    // renders from the raw result, the functionResponse and the persisted tool row don't
    // carry verdict / score_numeric. Everything else still does.
    const contents = mockStream.mock.calls[1][0] as Content[];
    const output = contents[contents.length - 1].parts?.[0].functionResponse
      ?.response?.output as Record<string, unknown>;
    expect(output.id).toBe(foglight.id);
    expect(output.brand_name).toBe("Foglight Studios");
    expect(output).not.toHaveProperty("verdict");
    expect(output).not.toHaveProperty("score_numeric");
    const toolRow = (await rowsFor(athleteId)).find((r) => r.role === "tool");
    expect(toolRow?.content).not.toContain("score_numeric");
    expect(toolRow?.content).not.toContain("\"verdict\"");
    // Same widget is returned from the loop (for persistence).
    expect((widget as { data: { id: string } } | null)?.data.id).toBe(
      foglight.id,
    );

    // A read-only nav-chip opens that exact deal (its Thread screen), riding on
    // `done` as an additive field and returned from the loop for persistence.
    const doneActions = fake.doneData()?.actions;
    expect(doneActions).toEqual([
      {
        label: "Open this deal",
        target: {
          screen: "deal",
          threadId: thread.id,
          brandName: "Foglight Studios",
        },
      },
    ]);
    expect(navChips).toEqual(doneActions);

    // Persisted to the app_actions column on the assistant answer row.
    const rows = await rowsFor(athleteId);
    const answerRow = rows[rows.length - 1];
    expect(answerRow.role).toBe("assistant");
    expect(answerRow.app_actions).toEqual(doneActions);
  });

  it("renders a deal_list card for a list_deals survey; no overflow chip at ≤5", async () => {
    const athleteId = await seedAthlete("Just A List");
    await db.insert(deals).values({
      athlete_id: athleteId,
      brand_name: "Prime Hydration",
      deal_type: "social_post",
      amount: "3000",
      status: "detected",
      detected_at: new Date("2026-07-22T00:00:00Z"),
    });

    const fake = makeFakeSSE();
    mockStream
      .mockResolvedValueOnce(toStream([callChunk("list_deals", {})]))
      .mockResolvedValueOnce(toStream([usageChunk("Here are your deals.")]));

    const { widget, navChips } = await runMilaLoop({
      athleteId,
      message: "list my deals",
      sse: fake.sse,
    });

    // list_deals now renders its rows as a deal_list (a stack of deal_cards),
    // riding on the `done` event and returned from the loop for persistence.
    const doneWidget = fake.doneData()?.widget as
      | { type: string; data: { deals: { brandName: string }[] } }
      | undefined;
    expect(doneWidget?.type).toBe("deal_list");
    expect(doneWidget?.data.deals.map((d) => d.brandName)).toEqual([
      "Prime Hydration",
    ]);
    expect((widget as { type: string } | null)?.type).toBe("deal_list");

    // One deal, all shown → NO redundant "See all my deals" overflow chip.
    expect(navChips).toEqual([]);
    expect(fake.doneData()?.actions).toBeUndefined();
  });

  it("caps the deal_list at 5 and adds a 'See all my deals' chip when list_deals returns more", async () => {
    const athleteId = await seedAthlete("Big List");
    // Six distinct deals, ascending detected_at → recency sort makes the order
    // deterministic; more than the 5-card cap, so the overflow chip appears.
    await db.insert(deals).values(
      Array.from({ length: 6 }, (_, i) => ({
        athlete_id: athleteId,
        brand_name: `Brand ${i}`,
        deal_type: "social_post",
        amount: "1000",
        status: "detected" as const,
        detected_at: new Date(Date.UTC(2026, 6, 20, 0, 0, i)),
      })),
    );

    const fake = makeFakeSSE();
    mockStream
      .mockResolvedValueOnce(toStream([callChunk("list_deals", {})]))
      .mockResolvedValueOnce(
        toStream([usageChunk("Here are your top deals.")]),
      );

    const { widget, navChips } = await runMilaLoop({
      athleteId,
      message: "list my deals",
      sse: fake.sse,
    });

    // deal_list capped at 5 items.
    const doneWidget = fake.doneData()?.widget as
      | { type: string; data: { deals: unknown[] } }
      | undefined;
    expect(doneWidget?.type).toBe("deal_list");
    expect(doneWidget?.data.deals).toHaveLength(5);
    expect(
      (widget as { data: { deals: unknown[] } } | null)?.data.deals,
    ).toHaveLength(5);

    // >5 returned → overflow chip to the full deals screen.
    expect(navChips).toEqual([
      { label: "See all my deals", target: { screen: "deals" } },
    ]);
    expect(fake.doneData()?.actions).toEqual(navChips);
  });

  // ─── Conversation memory (Phase 1, conversation_id) ────────────────────────

  const textsOf = (contents: Content[]): (string | undefined)[] =>
    contents.map((c) => c.parts?.[0]?.text);

  it("loads the FULL conversation by id, not a time window", async () => {
    const athleteId = await seedAthlete("Memory Full");
    const conversationId = "11111111-1111-1111-1111-111111111111";
    // Prior turns dated 2 HOURS ago — outside the old 30-min window, proving the
    // load is keyed by conversation, not recency.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.insert(chatMessages).values([
      {
        athlete_id: athleteId,
        role: "user",
        content: "earlier question",
        conversation_id: conversationId,
        created_at: old,
      },
      {
        athlete_id: athleteId,
        role: "assistant",
        content: "earlier answer",
        conversation_id: conversationId,
        created_at: new Date(old.getTime() + 1000),
      },
    ]);

    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(toStream([usageChunk("Following up.")]));
    await runMilaLoop({
      athleteId,
      message: "follow up",
      conversationId,
      sse: fake.sse,
    });

    const texts = textsOf(mockStream.mock.calls[0][0] as Content[]);
    expect(texts).toContain("earlier question"); // 2h-old turn still replayed
    expect(texts).toContain("earlier answer");
    expect(texts).toContain("follow up"); // + the current turn
  });

  it("scopes history to the conversation_id — another conversation doesn't bleed in", async () => {
    const athleteId = await seedAthlete("Memory Scope");
    const convA = "22222222-2222-2222-2222-222222222222";
    const convB = "33333333-3333-3333-3333-333333333333";
    await db.insert(chatMessages).values([
      {
        athlete_id: athleteId,
        role: "user",
        content: "belongs to conv A",
        conversation_id: convA,
      },
      {
        athlete_id: athleteId,
        role: "user",
        content: "belongs to conv B",
        conversation_id: convB,
      },
    ]);

    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(toStream([usageChunk("ok")]));
    await runMilaLoop({
      athleteId,
      message: "current",
      conversationId: convA,
      sse: fake.sse,
    });

    const texts = textsOf(mockStream.mock.calls[0][0] as Content[]);
    expect(texts).toContain("belongs to conv A");
    expect(texts).not.toContain("belongs to conv B");
  });

  it("tenancy: same conversation_id, different athlete → no cross-athlete history", async () => {
    const athleteA = await seedAthlete("Memory Tenant A");
    const athleteB = await seedAthlete("Memory Tenant B");
    const conversationId = "44444444-4444-4444-4444-444444444444";
    // Athlete B has a turn under the SAME (client-minted) conversation id.
    await db.insert(chatMessages).values({
      athlete_id: athleteB,
      role: "user",
      content: "athlete B private turn",
      conversation_id: conversationId,
    });

    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(toStream([usageChunk("ok")]));
    await runMilaLoop({
      athleteId: athleteA,
      message: "A asks",
      conversationId,
      sse: fake.sse,
    });

    const texts = textsOf(mockStream.mock.calls[0][0] as Content[]);
    // The athlete_id filter is what actually scopes it — B's turn never loads.
    expect(texts).not.toContain("athlete B private turn");
  });

  it("stamps conversation_id on every v2 insert (user, tool round, assistant)", async () => {
    const athleteId = await seedAthlete("Memory Stamp");
    await db.insert(athletesCurrent).values({
      athlete_id: athleteId,
    });
    const conversationId = "55555555-5555-5555-5555-555555555555";

    const fake = makeFakeSSE();
    mockStream
      .mockResolvedValueOnce(toStream([callChunk("get_score", {})]))
      .mockResolvedValueOnce(toStream([usageChunk("Your score is 512.")]));
    await runMilaLoop({
      athleteId,
      message: "score?",
      conversationId,
      sse: fake.sse,
    });

    const rows = await rowsFor(athleteId);
    // user · assistant tool-call · tool · assistant answer — all four stamped.
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(rows.every((r) => r.conversation_id === conversationId)).toBe(true);
  });

  it("leaves conversation_id NULL and loads no history when none is supplied", async () => {
    const athleteId = await seedAthlete("Memory None");
    // A prior turn exists for this athlete but under a real conversation id.
    await db.insert(chatMessages).values({
      athlete_id: athleteId,
      role: "user",
      content: "orphan prior turn",
      conversation_id: "66666666-6666-6666-6666-666666666666",
    });

    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(toStream([usageChunk("stateless.")]));
    // No conversationId → stateless (pre-memory behavior).
    await runMilaLoop({ athleteId, message: "no convo", sse: fake.sse });

    const texts = textsOf(mockStream.mock.calls[0][0] as Content[]);
    expect(texts).not.toContain("orphan prior turn"); // nothing replayed
    const inserted = (await rowsFor(athleteId)).filter(
      (r) => r.content === "no convo",
    );
    expect(inserted[0].conversation_id).toBeNull(); // stamped NULL
  });

  // ─── Prose bracket-leak strip + over-fetch backstop + widget subject-match ──

  it("strips bracket-leaks from prose when no web grounding occurred", async () => {
    const athleteId = await seedAthlete("Strip Leak");
    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(
      toStream([
        usageChunk(
          "Your top deal is Prime Hydration [4], not [402bb00c-8fef-44bd-9f1e-1234567890ab]. From [get_score, x].",
        ),
      ]),
    );

    const { text } = await runMilaLoop({
      athleteId,
      message: "best deal?",
      sse: fake.sse,
    });

    expect(text).not.toMatch(/\[/); // no bracket markers survive
    expect(text).toContain("Prime Hydration");
    // The stripped text is what was streamed AND what's returned/persisted.
    expect(fake.tokens.join("")).toBe(text);
  });

  it("strips a bracket-leak even when split across stream chunks", async () => {
    const athleteId = await seedAthlete("Split Leak");
    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(
      toStream([
        textChunk("Your deal [402bb00c-8fef-"),
        usageChunk("44bd-9f1e-1234567890ab] is strong."),
      ]),
    );

    const { text } = await runMilaLoop({
      athleteId,
      message: "deal?",
      sse: fake.sse,
    });

    expect(text).not.toMatch(/\[/);
    expect(text).toContain("Your deal");
    expect(text).toContain("is strong");
    expect(fake.tokens.join("")).toBe(text);
  });

  it("MAX_TOOL_ITERATIONS backstop is 8", () => {
    expect(MILA.MAX_TOOL_ITERATIONS).toBe(8);
  });

  it("a ranking turn renders the recommended deal's card, not the last one opened", async () => {
    const athleteId = await seedAthlete("Ranking Widget");
    const [prime] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId,
        brand_name: "Prime Hydration",
        amount: "5000",
        status: "negotiating",
        detected_at: new Date("2026-07-22T00:00:00Z"),
      })
      .returning({ id: deals.id });
    const [bay] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId,
        brand_name: "Bay Area Smoothie",
        amount: "400",
        status: "detected",
        detected_at: new Date("2026-07-21T00:00:00Z"),
      })
      .returning({ id: deals.id });

    const fake = makeFakeSSE();
    // list_deals, then get_deal on Prime, then get_deal on Bay Area LAST (the stray
    // she pulled in passing), then an answer recommending Prime.
    mockStream
      .mockResolvedValueOnce(toStream([callChunk("list_deals", {})]))
      .mockResolvedValueOnce(
        toStream([callChunk("get_deal", { deal_id: prime.id })]),
      )
      .mockResolvedValueOnce(
        toStream([callChunk("get_deal", { deal_id: bay.id })]),
      )
      .mockResolvedValueOnce(
        toStream([usageChunk("I'd prioritize the Prime Hydration deal.")]),
      );

    const { widget } = await runMilaLoop({
      athleteId,
      message: "which deal should I prioritize?",
      sse: fake.sse,
    });

    // Last-wins would render Bay Area (opened last); subject-match renders Prime.
    const w = fake.doneData()?.widget as
      | { type: string; data: { brandName: string } }
      | undefined;
    expect(w?.type).toBe("deal_card");
    expect(w?.data.brandName).toBe("Prime Hydration");
    expect(
      (widget as { data: { brandName: string } } | null)?.data.brandName,
    ).toBe("Prime Hydration");
  });

  it("renders the model's DECLARED deal_list directive, stripped from the answer", async () => {
    const athleteId = await seedAthlete("Declared Widget");
    const [prime] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId,
        brand_name: "Prime Hydration",
        amount: "5000",
        status: "negotiating",
        detected_at: new Date("2026-07-22T00:00:00Z"),
      })
      .returning({ id: deals.id });
    const [celsius] = await db
      .insert(deals)
      .values({
        athlete_id: athleteId,
        brand_name: "Celsius",
        amount: "3000",
        status: "detected",
        detected_at: new Date("2026-07-21T00:00:00Z"),
      })
      .returning({ id: deals.id });

    const fake = makeFakeSSE();
    mockStream
      .mockResolvedValueOnce(toStream([callChunk("list_deals", {})]))
      .mockResolvedValueOnce(
        toStream([
          usageChunk(
            `Your top 2: Prime, then Celsius. <<widget:deal_list:${prime.id},${celsius.id}>>`,
          ),
        ]),
      );

    const { text } = await runMilaLoop({
      athleteId,
      message: "show me my top 2 deals",
      sse: fake.sse,
    });

    // The directive is stripped from the visible answer.
    expect(text).not.toMatch(/<</);
    expect(text).toContain("Your top 2");
    // Rendered EXACTLY the declared deals, in declared order.
    const w = fake.doneData()?.widget as
      | { type: string; data: { deals: { brandName: string }[] } }
      | undefined;
    expect(w?.type).toBe("deal_list");
    expect(w?.data.deals.map((d) => d.brandName)).toEqual([
      "Prime Hydration",
      "Celsius",
    ]);
  });

  it("bails out cleanly when the client disconnects mid-stream", async () => {
    const athleteId = await seedAthlete("Disconnect");
    const fake = makeFakeSSE();
    // Stream yields a tool call, then the client vanishes before execution.
    mockStream.mockImplementationOnce(async () =>
      (async function* () {
        yield callChunk("get_score", {});
        fake.markClosed();
      })(),
    );

    const { text } = await runMilaLoop({
      athleteId,
      message: "still there?",
      sse: fake.sse,
    });

    expect(text).toBe("");
    expect(mockStream).toHaveBeenCalledTimes(1);

    // No tool executed, no tool round persisted, no final answer row.
    const rows = await rowsFor(athleteId);
    expect(rows.map((r) => r.role)).toEqual(["user"]);
  });
});

describe("runMilaLoop — Phase-2 rolling summary", () => {
  // Strictly-increasing created_at so the watermark boundary is exact.
  const T0 = new Date("2026-02-01T00:00:00Z").getTime();
  async function insertConvoMsg(
    athleteId: string,
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    tsOffsetMin: number,
  ) {
    const [row] = await db
      .insert(chatMessages)
      .values({
        athlete_id: athleteId,
        conversation_id: conversationId,
        role,
        content,
        created_at: new Date(T0 + tsOffsetMin * 60_000),
      } as any)
      .returning({ id: chatMessages.id });
    return row.id as string;
  }

  it("prepends the summary as a delimited data block and replays only the un-summarized tail", async () => {
    const athleteId = await seedAthlete("Summary Reader");
    const conversationId = randomUUID();

    // Two folded turns (covered by the summary), then the watermark, then a tail
    // turn the summary does NOT cover.
    await insertConvoMsg(athleteId, conversationId, "user", "FOLDED_QUESTION", 0);
    const watermarkId = await insertConvoMsg(
      athleteId,
      conversationId,
      "assistant",
      "FOLDED_ANSWER",
      1,
    );
    await insertConvoMsg(athleteId, conversationId, "user", "TAIL_QUESTION", 2);

    await db.insert(conversations).values({
      id: conversationId,
      athlete_id: athleteId,
      title: "older chat",
      summary: "Earlier they discussed the Prime deal.",
      summary_through_message_id: watermarkId,
    } as any);

    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(toStream([usageChunk("On it.")]));

    await runMilaLoop({
      athleteId,
      message: "and now?",
      conversationId,
      sse: fake.sse,
    });

    const [contents, , , systemInstruction] = mockStream.mock.calls[0] as any[];

    // Summary injected into the system prompt as fenced, labelled data.
    expect(systemInstruction).toContain("<<<CONVERSATION_SUMMARY>>>");
    expect(systemInstruction).toContain("Earlier they discussed the Prime deal.");

    // Replayed history = the tail after the watermark only; the folded turns are
    // NOT replayed (the summary already carries them).
    const serialized = JSON.stringify(contents);
    expect(serialized).toContain("TAIL_QUESTION");
    expect(serialized).not.toContain("FOLDED_QUESTION");
    expect(serialized).not.toContain("FOLDED_ANSWER");
  });

  it("upserts a conversation row on the first message (seeds the saved-chats title)", async () => {
    const athleteId = await seedAthlete("Upsert Trigger");
    const conversationId = randomUUID();

    const fake = makeFakeSSE();
    mockStream.mockResolvedValueOnce(toStream([usageChunk("Sure.")]));

    await runMilaLoop({
      athleteId,
      message: "What's my top deal?",
      conversationId,
      sse: fake.sse,
    });

    const [row] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(row?.title).toBe("What's my top deal?");
  });
});
