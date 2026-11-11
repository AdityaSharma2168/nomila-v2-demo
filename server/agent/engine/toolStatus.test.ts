/**
 * toolStatus.test.ts (moved from agent/tf/, PR 3 of the Mastra-only move) — the app's `status` events from a scripted
 * stream in the shape the tracker reads (the Mastra turn feeds its chunks in it; the captured streams in
 * __fixtures__/tf-dev-events/ are TrueForge-dev's, kept as the shape's regression). No provider, no database.
 */
jest.mock("../../db", () => ({ db: {} }));   // nothing here touches a database (the registry is only listed)

import { passRegistry } from "./tools/registry";
import { createToolStatus, THINKING_STATUS, TOOL_STATUS_FALLBACK, TOOL_STATUS_LABELS, toolNameOf, toolStatusLabel, type ToolStatusEvent } from "./toolStatus";

/** One stream event: the tracker reads ToolStatusEvent's fields; the rest of the wire shape rides along. */
type StreamEvent = ToolStatusEvent & { id?: string; [k: string]: unknown };

const main = (e: StreamEvent): StreamEvent => ({ ...e, thread_id: "main" });
const delta = (id: string, content: string, extra: Record<string, unknown> = {}) => main({ type: "model.message.delta", id, content, ...extra });
const toolCallOf = (id: string, name: string, args: Record<string, unknown>) =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) }, tool_info: { type: "mcp", server_id: "srv_1", server_name: "nomila", name } });
const toolMsg = (id: string, calls: unknown[]) => main({ type: "model.message", id, tool_calls: calls as StreamEvent["tool_calls"] });
const response = (callId: string, content: string) => main({ type: "tool.response", id: `r_${callId}`, tool_call_id: callId, content });

function run(events: StreamEvent[]) {
  const sent: Array<{ message: string; phase: string }> = [];
  const t = createToolStatus((message, phase) => sent.push({ message, phase }));
  for (const ev of events) t.see(ev);
  return { sent, t };
}

const SECRET_ARGS = { deal_id: "d-9f2c4e1a-7777", query: "Nike contract $25,000", email: "brand@example.com" };

describe("tool status from TrueForge events", () => {
  it("a turn with two tool rounds: tool label, thinking after the results, then the next tool's label", () => {
    const { sent } = run([
      { type: "turn.created", id: "t1", thread_id: null },
      delta("m1", "Let me check. "),
      toolMsg("m1", [toolCallOf("c1", "deals_find", SECRET_ARGS)]),
      response("c1", JSON.stringify({ deals: [{ id: SECRET_ARGS.deal_id }] })),
      toolMsg("m2", [toolCallOf("c2", "deals_terms", SECRET_ARGS)]),
      response("c2", "{\"terms\":[]}"),
      delta("m3", "Here's where it stands."),
      { type: "turn.done", id: "t2", thread_id: null, state: { status: "done" } },
    ]);
    expect(sent).toEqual([
      { message: "Checking your deals…", phase: "tool" },
      { message: THINKING_STATUS, phase: "thinking" },
      { message: "Reading the terms…", phase: "tool" },
      { message: THINKING_STATUS, phase: "thinking" },
    ]);
  });

  it("parallel calls in one round: one label, thinking only once every call has answered", () => {
    const { sent } = run([
      toolMsg("m1", [toolCallOf("c1", "list_goals", {}), toolCallOf("c2", "deals_find", {})]),
      response("c1", "{}"),
      response("c2", "{}"),
    ]);
    expect(sent).toEqual([{ message: "Checking your goals…", phase: "tool" }, { message: THINKING_STATUS, phase: "thinking" }]);
  });

  it("the same tool again after answer text is shown again", () => {
    const { sent } = run([
      toolMsg("m1", [toolCallOf("c1", "deals_get", {})]), response("c1", "{}"),
      delta("m2", "One more look."),
      toolMsg("m2", [toolCallOf("c2", "deals_get", {})]), response("c2", "{}"),
    ]);
    expect(sent.map((s) => s.message)).toEqual(["Checking your deals…", THINKING_STATUS, "Checking your deals…", THINKING_STATUS]);
  });

  it("an unknown tool shows the fallback label, never its name", () => {
    const { sent } = run([toolMsg("m1", [toolCallOf("c1", "brand_new_tool_xyz", SECRET_ARGS)]), response("c1", "{}")]);
    expect(sent[0]).toEqual({ message: TOOL_STATUS_FALLBACK, phase: "tool" });
    expect(JSON.stringify(sent)).not.toContain("brand_new_tool_xyz");
  });

  it("a round labels by the first tool it has a label for", () => {
    const { sent } = run([toolMsg("m1", [toolCallOf("c1", "mystery", {}), toolCallOf("c2", "brand_get", {})])]);
    expect(sent[0].message).toBe("Looking into the brand…");
  });

  it("tools found on demand (TrueForge's call_tool): the label of the tool it calls", () => {
    const call = { id: "c1", type: "function", function: { name: "call_tool", arguments: JSON.stringify({ mcp_server: "nomila", tool_name: "bookings_list", input: SECRET_ARGS }) }, tool_info: { type: "truefoundry-system", name: "call_tool" } };
    expect(toolNameOf(call)).toBe("bookings_list");
    expect(run([toolMsg("m1", [call])]).sent[0].message).toBe("Checking your bookings…");
    expect(toolNameOf({ function: { name: "call_tool", arguments: "{not json" } })).toBeNull();
  });

  it("TrueForge's own web search", () => {
    const call = { id: "c1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"x\"}" }, tool_info: { type: "truefoundry-system", name: "web_search" } };
    expect(run([toolMsg("m1", [call])]).sent[0].message).toBe("Looking that up…");
  });

  it("no argument, id, result or tool name ever reaches the client", () => {
    const { sent } = run([
      toolMsg("m1", [toolCallOf("c1", "deals_get", SECRET_ARGS), toolCallOf("c2", "secret_tool", SECRET_ARGS)]),
      response("c1", JSON.stringify(SECRET_ARGS)), response("c2", JSON.stringify(SECRET_ARGS)),
    ]);
    const wire = JSON.stringify(sent);
    for (const v of [...Object.values(SECRET_ARGS), "c1", "c2", "m1", "deals_get", "secret_tool", "srv_1", "nomila"]) expect(wire).not.toContain(v);
    const allowed = new Set([...Object.values(TOOL_STATUS_LABELS), TOOL_STATUS_FALLBACK, THINKING_STATUS]);
    for (const s of sent) expect(allowed.has(s.message)).toBe(true);
    for (const s of sent) expect(Object.keys(s).sort()).toEqual(["message", "phase"]);
  });

  it("sub-agent threads are ignored", () => {
    expect(run([{ type: "model.message", id: "x", thread_id: "sub_1", tool_calls: [toolCallOf("c1", "deals_find", {})] as StreamEvent["tool_calls"] }]).sent).toEqual([]);
  });

  it("counts reasoning text and notes a TrueForge approval pause, without sending either", () => {
    const { sent, t } = run([
      delta("m1", "", { reasoning_content: "Considering the deal" }),
      delta("m1", "", { reasoning_content: " terms." }),
      { type: "tool.approval_required", id: "a1", thread_id: "main", tool_calls: [{ id: "c1", source_event_id: "m1" }] as unknown as StreamEvent["tool_calls"] },
    ]);
    expect(sent).toEqual([]);
    expect(t.reasoningChars).toBe("Considering the deal terms.".length);
    expect(t.approvalRequired).toBe(true);
  });

  it("streamed call fragments (no finish delta): the label shows by the round's first tool.response", () => {
    const { sent } = run([
      main({ type: "model.message", id: "m1" }),
      delta("m1", "", { content: undefined, tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "call_tool", arguments: "" }, tool_info: { type: "truefoundry-system", name: "call_tool" } }] }),
      delta("m1", "", { content: undefined, tool_calls: [{ index: 0, function: { arguments: "{\"tool_name\":\"list_g" } }] }),
      delta("m1", "", { content: undefined, tool_calls: [{ index: 0, function: { arguments: "oals\",\"input\":{}}" } }] }),
      response("c1", "{}"),
    ]);
    expect(sent).toEqual([{ message: "Checking your goals…", phase: "tool" }, { message: THINKING_STATUS, phase: "thinking" }]);
  });

  it("every tool we serve over MCP has its own label", () => {
    // every registered tool that can be served over MCP, whatever its flag (catalogTools minus the flag check)
    const served = passRegistry().all().filter((tool) => tool.kind !== "builtin" && tool.name !== "health_check").map((tool) => tool.name);
    expect(served.length).toBeGreaterThan(30);
    expect(served.filter((n) => toolStatusLabel(n) === TOOL_STATUS_FALLBACK)).toEqual([]);
    expect(toolStatusLabel("toString")).toBe(TOOL_STATUS_FALLBACK);
  });
});

/**
 * Regression from REAL TrueForge-dev streams (mila-dev, MCP preload off; captured 28 Oct 2026 for a test athlete, then
 * sanitized: every id, timestamp, text, tool input and tool result replaced; only event structure and our tool names
 * kept). In these streams `model.message` never carries tool_calls: the calls stream in its deltas, so the tracker as
 * first written (#1154) sent no status line at all.
 */
describe("tool status from captured TrueForge-dev streams", () => {
  const FIXTURES = ["deals-find", "recall-facts", "parallel-calls", "discovery-only"];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fixture = (name: string): StreamEvent[] => require(`./__fixtures__/tf-dev-events/${name}.json`) as StreamEvent[];
  const tool = (message: string) => ({ message, phase: "tool" });
  const generic = tool(TOOL_STATUS_FALLBACK);
  const thinking = { message: THINKING_STATUS, phase: "thinking" };

  it("the captured streams have no tool_calls on model.message (the shape #1154 expected); calls stream in deltas", () => {
    for (const name of FIXTURES) {
      const evs = fixture(name);
      expect(evs.filter((e) => e.type === "model.message" && e.tool_calls)).toEqual([]);
      expect(evs.some((e) => e.type === "model.message.delta" && Array.isArray(e.tool_calls))).toBe(true);
    }
  });

  it("deals: three discovery rounds (generic line), then call_tool → deals_find", () => {
    expect(run(fixture("deals-find")).sent).toEqual([generic, thinking, generic, thinking, generic, thinking, tool("Checking your deals…"), thinking]);
  });

  it("what Mila knows: discovery, then call_tool → recall_facts", () => {
    expect(run(fixture("recall-facts")).sent).toEqual([generic, thinking, generic, thinking, generic, thinking, tool("Checking what I know…"), thinking]);
  });

  it("three parallel calls in one round: one label, thinking only after all three answered", () => {
    const evs = fixture("parallel-calls");
    expect(run(evs).sent).toEqual([generic, thinking, generic, thinking, generic, thinking, tool("Checking your deals…"), thinking]);
    // stop after the last round's second response: still the tool label, no thinking yet
    const responses = evs.map((e, i) => (e.type === "tool.response" ? i : -1)).filter((i) => i >= 0);
    const upToSecondLast = run(evs.slice(0, responses[responses.length - 2] + 1)).sent;
    expect(upToSecondLast[upToSecondLast.length - 1]).toEqual(tool("Checking your deals…"));
  });

  it("discovery only, then a reasoned answer: the generic line only (no tool invented), reasoning counted", () => {
    const { sent, t } = run(fixture("discovery-only"));
    expect(sent).toEqual([generic, thinking, generic, thinking]);
    expect(t.reasoningChars).toBeGreaterThan(0);
  });

  it("fixtures hold no ids, uuids, timestamps or emails", () => {
    for (const name of FIXTURES) {
      const raw = JSON.stringify(fixture(name));
      expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(raw).not.toContain("@");
      expect(raw).not.toContain("created_at");
    }
  });
});
