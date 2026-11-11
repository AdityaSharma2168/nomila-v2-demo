/**
 * documents/workflow.test.ts — the document_build process: its definition, its build step on a mocked engine, and the
 * tell step that comes back to the chat (fake chat rows, an in-memory source). No database, no model, no engine.
 *
 *   W1  the definition: build → tell, one run per document (the active scope), input cleaned
 *   W2  build: an engine answer is the step's answer; an expected refusal is an answer, never a retry; a throw is retried
 *       once, then becomes { status: "failed" } so the tell step still runs
 *   W2b check before deliver (A4): a built document that fails verifyBuiltDocument is { status: "needs_a_look" } —
 *       never "built", never a retry — and the tell step says it is not ready (failed card, no document card)
 *   W3  tell: every chat that asked gets ONE line and the document's card, its progress card flips to done; a retry
 *       writes nothing twice; a failed build says so plainly (failed card, no document card); nothing for no chat
 */
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("tests here never touch the database"); } }) }));
const buildDocument = jest.fn();
const verifyBuiltDocument = jest.fn();
jest.mock("../../services/documents", () => ({
  buildDocument: (...a: unknown[]) => buildDocument(...a),
  verifyBuiltDocument: (...a: unknown[]) => verifyBuiltDocument(...a),
}));

import type { ChatCard } from "../../../shared/agent";
import { getDefinition } from "../../workflow/registry";
import type { StepCtx } from "../../workflow/types";
import { buildProgressCard } from "./cards";
import { createMemoryDocumentsSource, memoryBrandId } from "./memorySource";
import { docReadyCardId, readyLine, tellDocumentReady, type DocTellChats } from "./tell";
import { buildInputOf, DOCUMENT_BUILD, scopeOfInput, TELL_ATTEMPTS } from "./workflow";

const ATHLETE = "00000000-0000-4000-a000-000000000003";
const ctxOf = (step: string, input: unknown, attempt = 1, outputs: Record<string, unknown> = {}): StepCtx => ({
  runId: "wf-1", athleteId: ATHLETE, process: "document_build", definitionVersion: 1, step, attempt, input: null, outputs, runInput: input,
});

describe("W1: the definition", () => {
  it("build → tell, one run per document", () => {
    const def = getDefinition("document_build");
    expect(def).toBe(DOCUMENT_BUILD);
    expect(def.steps.map((s) => [s.name, s.kind])).toEqual([["build", "model"], ["tell", "code"]]);
    expect(def.steps[1].retry?.maxAttempts).toBe(TELL_ATTEMPTS);
    expect(scopeOfInput({ kind: "pitch", brandId: 7 })).toBe("document_build:pitch:7");
    expect(scopeOfInput({ kind: "brand_book" })).toBe("document_build:brand_book");
    expect(scopeOfInput({ kind: "anything" })).toBe("document_build:public_page");
    expect(buildInputOf({ kind: "pitch", brandId: 7, brandName: "B", angles: ["a", "b", "c", "d", 5], askedFrom: ["c1", 2] }))
      .toEqual({ kind: "pitch", brandId: 7, brandName: "B", angles: ["a", "b", "c"], askedFrom: ["c1"] });
  });
});

describe("W2: build", () => {
  const build = () => DOCUMENT_BUILD.steps[0].run!;
  beforeEach(() => {
    buildDocument.mockReset();
    verifyBuiltDocument.mockReset().mockResolvedValue({ ok: true, kind: "document", checked: ["sections", "placeholders", "links"] });
  });

  it("W2b: a built document that fails its check is needs_a_look, checked against the same document, never retried", async () => {
    buildDocument.mockResolvedValue({ ok: true, doc: "pitch", detail: "built" });
    verifyBuiltDocument.mockResolvedValue({
      ok: false, kind: "document", status: "needs_a_look", checked: ["sections", "placeholders", "links"],
      failures: [{ check: "placeholders", reason: "\"[amount]\" in page" }],
    });
    expect(await build()(ctxOf("build", { kind: "pitch", brandId: 7, brandName: "B", angles: [], askedFrom: [] }, 1)))
      .toEqual({ status: "needs_a_look", checks: ["placeholders"] });
    expect(verifyBuiltDocument).toHaveBeenCalledWith(ATHLETE, "pitch", { brandId: 7 });
    expect(buildDocument).toHaveBeenCalledTimes(1);
  });

  it("W2b: a check that THROWS fails closed as needs_a_look — on the first attempt too, never a rebuild (spend)", async () => {
    buildDocument.mockResolvedValue({ ok: true, doc: "pitch", detail: "built" });
    verifyBuiltDocument.mockRejectedValue(new Error("verifier bug"));
    expect(await build()(ctxOf("build", { kind: "pitch", brandId: 7, brandName: "B", angles: [], askedFrom: [] }, 1)))
      .toEqual({ status: "needs_a_look", checks: ["verifier_error"] });
    expect(buildDocument).toHaveBeenCalledTimes(1);
  });

  it("W2b: a book already being written is not checked (there is nothing new to check yet)", async () => {
    buildDocument.mockResolvedValue({ ok: true, doc: "brand_book", detail: "already_building" });
    expect(await build()(ctxOf("build", { kind: "brand_book" }))).toEqual({ status: "already_building" });
    expect(verifyBuiltDocument).not.toHaveBeenCalled();
  });

  it("runs the engine with the run's athlete and the brand and angles from the input", async () => {
    buildDocument.mockResolvedValue({ ok: true, doc: "pitch", detail: "built" });
    expect(await build()(ctxOf("build", { kind: "pitch", brandId: 7, brandName: "B", angles: ["x"], askedFrom: [] }))).toEqual({ status: "built" });
    expect(buildDocument).toHaveBeenCalledWith(ATHLETE, "pitch", { brandId: 7, angles: ["x"] });
  });

  it("an expected refusal is an answer; a pitch without a brand never reaches the engine", async () => {
    buildDocument.mockResolvedValue({ ok: false, code: "brand_not_confirmed", message: "x" });
    expect(await build()(ctxOf("build", { kind: "pitch", brandId: 7 }))).toEqual({ status: "failed", reason: "brand_not_confirmed" });
    buildDocument.mockClear();
    expect(await build()(ctxOf("build", { kind: "pitch" }))).toEqual({ status: "failed", reason: "bad_input" });
    expect(buildDocument).not.toHaveBeenCalled();
  });

  it("a throw is retried once, then answered as failed", async () => {
    buildDocument.mockRejectedValue(new Error("engine down"));
    await expect(build()(ctxOf("build", { kind: "brand_book" }, 1))).rejects.toThrow("engine down");
    expect(await build()(ctxOf("build", { kind: "brand_book" }, 2))).toEqual({ status: "failed", reason: "error" });
  });
});

describe("W3: tell", () => {
  const brand = { id: memoryBrandId(["north"], "north"), name: "Northpeak Apparel", logoUrl: null, confirmed: true, researched: true };
  const input = { kind: "pitch" as const, brandId: brand.id, brandName: brand.name, angles: [], askedFrom: ["conv-a", "conv-b"] };

  function fakeChats() {
    const rows: Array<{ id: string; conversationId: string; content: string; cards: ChatCard[] }> = [];
    for (const c of ["conv-a", "conv-b"]) rows.push({ id: `row-${c}`, conversationId: c, content: "On it.", cards: [buildProgressCard("wf-1", { kind: "pitch", brand }, "run-x")] });
    const chats: DocTellChats = {
      async asking(_a, wf) { return rows.filter((r) => r.cards.some((k) => k.kind === "progress" && k.payload.workflowRunId === wf)).map((r) => ({ rowId: r.id, conversationId: r.conversationId, cards: r.cards })); },
      async hasCard(_a, conv, id) { return rows.some((r) => r.conversationId === conv && r.cards.some((k) => k.id === id)); },
      async setCards(_a, rowId, cards) { rows.find((r) => r.id === rowId)!.cards = cards; },
      async insert(_a, conv, row) { rows.push({ id: `row-${rows.length}`, conversationId: conv, content: row.content, cards: row.cards }); },
    };
    return { rows, chats };
  }
  const source = () => createMemoryDocumentsSource({ brands: [{ key: "north", name: "Northpeak Apparel" }], pitches: [{ brand: "north" }] });

  it("each asking chat gets one line and the document's card; its progress card flips to done; a retry writes nothing twice", async () => {
    const { rows, chats } = fakeChats();
    const r = await tellDocumentReady({ chats, source: source() }, ATHLETE, { runId: "wf-1", input, ok: true });
    expect(r).toEqual({ told: ["conv-a", "conv-b"], alreadyTold: [] });
    const followUps = rows.filter((x) => x.content !== "On it.");
    expect(followUps.map((x) => [x.conversationId, x.content])).toEqual([
      ["conv-a", "Your pitch for Northpeak Apparel is ready. Tell me anything you'd like changed, or ask me to share it when you're happy."],
      ["conv-b", "Your pitch for Northpeak Apparel is ready. Tell me anything you'd like changed, or ask me to share it when you're happy."],
    ]);
    expect(followUps[0].cards).toEqual([expect.objectContaining({ id: docReadyCardId("wf-1"), kind: "ready", title: "Northpeak Apparel pitch" })]);
    for (const c of ["conv-a", "conv-b"]) expect(rows.find((x) => x.id === `row-${c}`)!.cards[0].payload).toMatchObject({ state: "done" });
    const again = await tellDocumentReady({ chats, source: source() }, ATHLETE, { runId: "wf-1", input, ok: true });
    expect(again).toEqual({ told: [], alreadyTold: ["conv-a", "conv-b"] });
    expect(rows).toHaveLength(4);
  });

  it("a failed build says so plainly: the progress card fails, no document card, and nothing went out", async () => {
    const { rows, chats } = fakeChats();
    await tellDocumentReady({ chats, source: source() }, ATHLETE, { runId: "wf-1", input, ok: false });
    const line = rows.find((x) => x.content !== "On it.")!;
    expect(line.content).toBe("I couldn't finish your pitch for Northpeak Apparel this time. Nothing changed and nothing went out. Ask me again in a little while.");
    expect(line.cards).toEqual([]);
    expect(rows.find((x) => x.id === "row-conv-a")!.cards[0].payload).toMatchObject({ state: "failed" });
    // Settled: a retry does not say it twice.
    expect((await tellDocumentReady({ chats, source: source() }, ATHLETE, { runId: "wf-1", input, ok: false })).alreadyTold).toHaveLength(2);
  });

  it("W2b: a document that needs a look is told as not ready — failed card, no document card, nothing went out", async () => {
    const { rows, chats } = fakeChats();
    await tellDocumentReady({ chats, source: source() }, ATHLETE, { runId: "wf-1", input, ok: false, needsALook: true });
    const line = rows.find((x) => x.content !== "On it.")!;
    expect(line.content).toBe("I made your pitch for Northpeak Apparel, but it needs a look before it's ready, so I'm not showing it yet. Nothing went out. Ask me to try again.");
    expect(line.cards).toEqual([]);
    expect(rows.find((x) => x.id === "row-conv-a")!.cards[0].payload).toMatchObject({ state: "failed" });
  });

  it("no chat asked ⇒ nothing is written", async () => {
    const { rows, chats } = fakeChats();
    expect(await tellDocumentReady({ chats, source: source() }, ATHLETE, { runId: "wf-other", input, ok: true })).toEqual({ told: [], alreadyTold: [] });
    expect(rows).toHaveLength(2);
  });

  it("the lines never gender the athlete", () => {
    for (const kind of ["pitch", "brand_book", "public_page"] as const) for (const ok of [true, false]) {
      expect(readyLine({ kind, brandName: "B" }, ok)).not.toMatch(/\b(she|her|he|his|him)\b/i);
      expect(readyLine({ kind, brandName: "B" }, ok, true)).not.toMatch(/\b(she|her|he|his|him)\b/i);
    }
  });
});
