/**
 * chatV2Stream.test.ts — chat v2's allow-list filter and card DTOs, with FORGED parts: whatever an upstream part
 * carries, only the known part types come out, rebuilt field by field; tool input deltas, raw tool payloads, reasoning,
 * sources, files and Mastra's own data parts are dropped; a card goes out only as a valid DTO, once.
 */
import { toMilaCardDto, checkMilaCardDto } from "../../../../shared/milaCards";
import { ALLOWED_PART_TYPES, filterPart, STREAM_ERROR_TEXT, type FilterState } from "./chatV2Stream";

const SECRET = "RAW-SECRET-42";
const state = (): FilterState => ({ runId: () => "run-1", sent: new Set(), started: true });
const actionCard = {
  id: "action:pa-1", kind: "action", title: "Save this?", runId: "run-1", links: [],
  payload: { approvalId: "pa-1", verb: "save_memory", body: "Afternoon shoots only.", money: null, buttons: ["approve", "decline"], args: { secret: SECRET } },
};

describe("filterPart", () => {
  it("drops every forged part that could carry raw tool args, results or internals", () => {
    const st = state();
    const forged = [
      { type: "tool-input-start", toolCallId: "c1", toolName: SECRET },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: `{"q":"${SECRET}"}` },
      { type: "tool-output-error", toolCallId: "c1", errorText: SECRET },
      { type: "tool-input-error", toolCallId: "c1", input: { q: SECRET }, errorText: SECRET },
      { type: "tool-approval-request", toolCallId: "c1", approvalId: SECRET },
      { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: SECRET }, { type: "reasoning-end", id: "r" },
      { type: "source-url", sourceId: "s", url: `https://x/${SECRET}` },
      { type: "file", url: `data:${SECRET}`, mediaType: "text/plain" },
      { type: "data-tool-call-approval", data: { args: { q: SECRET } } },
      { type: "data-tool-call-suspended", data: { suspendPayload: SECRET } },
      { type: "data-tripwire", data: { reason: SECRET } },
      { type: "data-anything", data: SECRET },
      { type: "custom", value: SECRET },
      { type: "message-metadata", messageMetadata: { secret: SECRET } },
      { type: "finish", finishReason: "stop", messageMetadata: { secret: SECRET } },
      { type: "abort", reason: SECRET },
      { type: "raw", rawValue: SECRET },
      { type: SECRET },
      null, 42, "text-delta",
    ];
    const out = forged.flatMap((p) => filterPart(p, st));
    expect(JSON.stringify(out)).not.toContain(SECRET);
    for (const p of out) expect(ALLOWED_PART_TYPES.has(p.type)).toBe(true);
  });

  it("a tool's input is only ever a fixed status line; its raw output never passes", () => {
    const st = state();
    const running = new Set<string>();
    const a = filterPart({ type: "tool-input-available", toolCallId: "c1", toolName: "recall_facts", input: { label: "Checking what I know…", q: SECRET } }, st, running);
    expect(a).toEqual([{ type: "data-mila-status", id: "status", data: { label: "Checking what I know…", phase: "tool" } }]);
    // an unknown label (or raw args in place of the display rule) becomes the fallback line
    const b = filterPart({ type: "tool-input-available", toolCallId: "c2", toolName: "x", input: { query: SECRET, label: SECRET } }, st, running);
    expect(b).toEqual([{ type: "data-mila-status", id: "status", data: { label: "Working on it…", phase: "tool" } }]);
    const c = filterPart({ type: "tool-output-available", toolCallId: "c1", output: `{"facts":"${SECRET}"}` }, st, running);
    expect(c).toEqual([]);
    const d = filterPart({ type: "tool-output-available", toolCallId: "c2", output: { cards: [{ type: "action", data: { secret: SECRET } }], raw: SECRET } }, st, running);
    // the bad card is dropped; the round is over, so Mila is thinking again
    expect(d).toEqual([{ type: "data-mila-status", id: "status", data: { label: "Thinking…", phase: "thinking" } }]);
  });

  it("rebuilds text, steps and errors field by field", () => {
    const st = state();
    expect(filterPart({ type: "text-start", id: "t1", providerMetadata: { secret: SECRET } }, st)).toEqual([{ type: "text-start", id: "t1" }]);
    expect(filterPart({ type: "text-delta", id: "t1", delta: "Hi", providerMetadata: { secret: SECRET } }, st)).toEqual([{ type: "text-delta", id: "t1", delta: "Hi" }]);
    expect(filterPart({ type: "start-step", request: { body: SECRET } }, st)).toEqual([{ type: "start-step" }]);
    expect(filterPart({ type: "finish-step", response: { secret: SECRET } }, st)).toEqual([{ type: "finish-step" }]);
    expect(filterPart({ type: "error", errorText: `provider said ${SECRET}` }, st)).toEqual([{ type: "error", errorText: STREAM_ERROR_TEXT }]);
  });

  it("a forged data-mila-card goes out only as a valid DTO (extra fields stripped), once per card id", () => {
    const st = state();
    const dto = toMilaCardDto(actionCard);
    expect(dto.ok).toBe(true);
    const forged = { type: "data-mila-card", id: "x", data: { ...(dto as any).dto, data: { ...(dto as any).dto.data, raw: SECRET } } };
    const once = filterPart(forged, st);
    expect(once).toHaveLength(1);
    expect(JSON.stringify(once)).not.toContain(SECRET);
    expect(filterPart(forged, st)).toEqual([]);
    expect(filterPart({ type: "data-mila-card", data: { type: "deal", data: { id: "d1", title: SECRET } } }, st)).toEqual([]);
    expect(filterPart({ type: "data-mila-status", id: "status", data: { label: SECRET, phase: "tool" } }, st)).toEqual([]);
  });

  it("the first part of a stream is always start (with the run id) and Thinking…", () => {
    const st: FilterState = { runId: () => "run-9", sent: new Set(), started: false };
    expect(filterPart({ type: "start", messageId: SECRET }, st)).toEqual([
      { type: "start", messageId: "run-9", messageMetadata: { runId: "run-9" } },
      { type: "data-mila-status", id: "status", data: { label: "Thinking…", phase: "thinking" } },
    ]);
    expect(filterPart({ type: "start", messageId: SECRET }, st)).toEqual([]);
  });
});

describe("card DTOs (shared/milaCards.ts)", () => {
  it("an approval card carries its pendingActionId and needs_approval; nothing else of the record", () => {
    const r = toMilaCardDto(actionCard);
    expect(r).toEqual({ ok: true, dto: { type: "action", data: {
      id: "action:pa-1", title: "Save this?", links: [],
      fields: { pendingActionId: "pa-1", state: "needs_approval", verb: "save_memory", body: "Afternoon shoots only.", money: null, buttons: ["approve", "decline"] },
    } } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(checkMilaCardDto((r as any).dto)).toEqual((r as any).dto);
  });

  it("ids become strings; a card with no schema, or failing it, is refused", () => {
    const doc = toMilaCardDto({ id: "doc:1", kind: "document", title: "Pitch", links: [{ label: "Open", target: { screen: "document", id: 7 } }], payload: {
      kind: "pitch", brand: { id: 12, name: "Brand", logoUrl: null }, state: "ready", statusLine: "Ready", thumbUrl: null, updatedAt: null, shared: null, published: null, actions: { change: null, share: null },
    } });
    expect(doc.ok && (doc.dto.data as any).fields.brand.id).toBe("12");
    expect(doc.ok && (doc.dto.data as any).links[0].target.id).toBe("7");
    expect(toMilaCardDto({ id: "r", kind: "reveal", title: "x", links: [], payload: {} })).toEqual({ ok: false, kind: "reveal", reason: "unknown_type" });
    expect(toMilaCardDto({ id: "q", kind: "quick-question", title: "x", links: [], payload: { question: 3 } })).toEqual({ ok: false, kind: "quick-question", reason: "invalid" });
  });
});

describe("the stream keeps the model's order: each lead-in sits above its card", () => {
  it("text, card, text, card: the parts go out in that order, each text segment its own text part", async () => {
    const { createChatV2Stream } = await import("./chatV2Stream");
    const { displayChunk } = await import("./display");
    const parts: Array<Record<string, any>> = [];
    const stream = await createChatV2Stream((p) => parts.push(p as never));
    stream.tap.run("run-1");
    const second = { ...actionCard, id: "action:pa-2", payload: { ...actionCard.payload, approvalId: "pa-2" } };
    const cards: Record<string, unknown[]> = { c1: [actionCard], c2: [second] };
    const tool = (id: string) => {
      stream.tap.chunk(displayChunk({ type: "tool-call", runId: "run-1", from: "AGENT", payload: { toolCallId: id, toolName: "save_memory", args: { secret: SECRET } } } as never, () => []));
      stream.tap.chunk(displayChunk({ type: "tool-result", runId: "run-1", from: "AGENT", payload: { toolCallId: id, toolName: "save_memory", args: { secret: SECRET }, result: { status: "ok" } } } as never, (k) => cards[k] ?? []));
    };
    stream.tap.text("Want me to keep this? ");
    tool("c1");
    stream.tap.text("And this one too. ");
    tool("c2");
    stream.tap.text("That's all.");
    await stream.end({ runId: "run-1", status: "completed" }, []);
    const order = parts.flatMap((p) => (p.type === "text-delta" ? [`text:${p.delta.trim()}`] : p.type === "data-mila-card" ? [`card:${p.id}`] : []));
    expect(order).toEqual(["text:Want me to keep this?", "card:action:pa-1", "text:And this one too.", "card:action:pa-2", "text:That's all."]);
    // Each segment is its own text part (a new id), so the app cannot glue them together above the cards.
    const ids = parts.filter((p) => p.type === "text-start").map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    expect(JSON.stringify(parts)).not.toContain(SECRET);
  });
});
