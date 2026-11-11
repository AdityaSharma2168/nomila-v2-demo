/**
 * display.test.ts — CI GUARD for chat v2 (docs/design/mila-chat-v2.md): every tool Mila can call on Mastra (the tools
 * of every skill but the echo plumbing, as a pass offers them, plus Mastra's own agent-skill
 * tools skill / skill_read / skill_search: mastra/skills.ts) has a display rule (a fixed status line and its
 * card types), every tool that can make a card (card / cards / an approval) lists its card types, and every card type
 * listed (and the turn's own) has a DTO schema in shared/milaCards.ts. A new tool or card without one fails here.
 */
jest.mock("../../../db", () => ({ db: {} }));

import { isMilaCardType } from "../../../../shared/milaCards";
import { passRegistry, passSkill } from "../tools/registry";
import { listJobs, loadJob } from "../../jobs";
import { TOOL_STATUS_LABELS } from "../toolStatus";
import { displayChunk, hasDisplayRule, MILA_TOOL_CARDS, TOOL_ERROR_PLACEHOLDER, TURN_CARDS } from "./display";
import { MASTRA_SKILL_TOOLS } from "./skills";

const registry = passRegistry();
const milaSkills = listJobs().map((s) => s.id).filter((id) => !id.startsWith("echo/"));
/** What Mila can call on Mastra: the passes' tools and Mastra's skill tools. */
const milaTools = [...new Set([
  ...milaSkills.flatMap((id) => passSkill(loadJob(id), registry).tools),
  ...MASTRA_SKILL_TOOLS,
])].sort();

describe("chat v2 display rules (CI guard)", () => {
  it("covers some skills and tools (the guard is not vacuous)", () => {
    expect(milaSkills).toContain("chat");
    expect(milaTools.length).toBeGreaterThan(20);
  });

  it("every tool Mila can call has a display rule: a fixed status line and its card types", () => {
    const missing = milaTools.filter((n) => !hasDisplayRule(n));
    expect(missing).toEqual([]);
  });

  it("every tool that can make a card lists its card types", () => {
    const silent = registry.all()
      .filter((t) => t.kind !== "builtin" && (t.card || t.cards || t.approval))
      .filter((t) => !(MILA_TOOL_CARDS[t.name]?.length))
      .map((t) => t.name);
    expect(silent).toEqual([]);
  });

  it("every card type a tool or the turn can make has a DTO schema", () => {
    const kinds = [...new Set([...Object.values(MILA_TOOL_CARDS).flat(), ...TURN_CARDS])];
    expect(kinds.filter((k) => !isMilaCardType(k))).toEqual([]);
  });

  it("the display rules name only registry tools or Mastra's skill tools, each with a status line (no stale entries)", () => {
    const known = (n: string) => !!registry.get(n) || (MASTRA_SKILL_TOOLS as readonly string[]).includes(n);
    expect(Object.keys(MILA_TOOL_CARDS).filter((n) => !known(n) || !(n in TOOL_STATUS_LABELS))).toEqual([]);
    // get_playbook went with TrueForge (Mastra-only PR 3): no tool of that name, and no display rule for it
    expect(registry.get("get_playbook")).toBeUndefined();
    expect(hasDisplayRule("get_playbook")).toBe(false);
  });

  it("Mastra's skill tools show the fixed status line and no output: the playbook text they return never reaches the client", () => {
    const display = (c: any) => c.metadata?.mastra?.toolPayloadTransform?.display;
    const playbook = "# Deals\n\nThe whole playbook text, model-facing only.";
    for (const toolName of MASTRA_SKILL_TOOLS) {
      expect(MILA_TOOL_CARDS[toolName]).toEqual([]);
      const call = displayChunk({ type: "tool-call", payload: { toolCallId: "s1", toolName, args: { name: "deals", query: "secret" } } }, () => []);
      expect(display(call)).toEqual({ "input-available": { transformed: { label: TOOL_STATUS_LABELS[toolName] } } });
      const out = displayChunk({ type: "tool-result", payload: { toolCallId: "s1", toolName, result: playbook } }, () => []);
      expect(display(out)["output-available"]).toEqual({ transformed: null });
      expect(JSON.stringify(display(out))).not.toContain("playbook text");
    }
  });

  it("Mila's read tools (agent/reads) have a rule, make no card, and their result (her rows) never reaches the client", () => {
    const display = (c: any) => c.metadata?.mastra?.toolPayloadTransform?.display;
    const rows = JSON.stringify({ status: "ok", media: [{ id: "asset-7", what: "celebrating the win" }], earned_this_year: "$1,250" });
    for (const toolName of ["media_search", "posts_performance", "money_summary", "whats_next"]) {
      expect(milaTools).toContain(toolName);
      expect(hasDisplayRule(toolName)).toBe(true);
      expect(MILA_TOOL_CARDS[toolName]).toEqual([]);
      const call = displayChunk({ type: "tool-call", payload: { toolCallId: "r1", toolName, args: { query: "secret words" } } }, () => []);
      expect(display(call)).toEqual({ "input-available": { transformed: { label: TOOL_STATUS_LABELS[toolName] } } });
      const out = displayChunk({ type: "tool-result", payload: { toolCallId: "r1", toolName, result: rows } }, () => []);
      expect(display(out)["output-available"]).toEqual({ transformed: null });
      expect(JSON.stringify(display(out))).not.toMatch(/asset-7|celebrating|1,250|secret words/);
    }
  });

  it("chat v2's copy of a chunk carries the status line for the input and only DTOs for the output; Mastra's chunk is untouched", () => {
    const cards = new Map<string, unknown[]>([["c1", [{ id: "q:1", kind: "quick-question", title: "Quick question", links: [], payload: { question: "Which?", options: ["A"], why: "", raw: "x" } }]]]);
    const take = (id: string) => { const c = cards.get(id) ?? []; cards.delete(id); return c; };
    const label = { transformed: { label: TOOL_STATUS_LABELS.ask_quick_question } };
    const display = (c: any) => c.metadata?.mastra?.toolPayloadTransform?.display;

    const call = { type: "tool-call", payload: { toolCallId: "c1", toolName: "ask_quick_question", args: { question: "secret args" } } };
    expect(display(displayChunk(call, take))).toEqual({ "input-available": label });
    expect(display(displayChunk({ type: "tool-call-delta", payload: { toolCallId: "c1", toolName: "ask_quick_question", argsTextDelta: "{" } }, take))).toEqual({ "input-delta": { suppress: true } });

    const result = { type: "tool-result", payload: { toolCallId: "c1", toolName: "ask_quick_question", result: "model-facing text" } };
    const out = displayChunk(result, take);
    expect(display(out)).toEqual({
      "input-available": label,
      "output-available": { transformed: { cards: [{ type: "quick-question", data: { id: "q:1", title: "Quick question", links: [], fields: { question: "Which?", options: ["A"], why: "" } } }] } },
    });
    expect(out.payload).toBe(result.payload);
    expect(result).not.toHaveProperty("metadata");   // the chunk Mastra keeps is never written
    // the cards are handed over once; a call with none shows null
    expect(display(displayChunk(result, take))["output-available"]).toEqual({ transformed: null });
    expect(display(displayChunk({ type: "tool-error", payload: { toolCallId: "c2", toolName: "recall_facts", error: "raw" } }, take)).error).toEqual({ transformed: TOOL_ERROR_PLACEHOLDER });
    const text = { type: "text-delta", payload: { text: "hi" } };
    expect(displayChunk(text, take)).toBe(text);
  });
});
