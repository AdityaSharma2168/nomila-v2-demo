/**
 * toolChoice.test.ts — the tool-choice eval, offline (CI): the scripted right turn for each top question passes the
 * grader against the REAL registry, the chat skill's own tool list and every tool's own argument schema; the scripted
 * wrong turn fails it. No model, no provider, no database.
 */
jest.mock("../../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("the offline evals never touch the database"); } }) }));

import { createDefaultRegistry } from "../../coreTools";
import { MILA_TOOL_CARDS } from "../../engine/mastra/display";
import { loadJob } from "../../jobs";
import { gradeToolChoice, type ToolLookup } from "./grade";
import { TOOL_CHOICE_CASES } from "./toolChoice.cases";

const registry = createDefaultRegistry();
const tools: ToolLookup = { get: (n) => registry.get(n), offered: loadJob("chat").tools };

test("the top athlete questions are all here, ids unique", () => {
  expect(TOOL_CHOICE_CASES.map((c) => c.id)).toEqual(["photo-for-northpeak", "how-did-my-posts-do", "how-much-have-i-earned", "whats-due", "draft-a-reply"]);
});

test("every tool a case names is real, offered to the chat skill, and has a display rule", () => {
  for (const c of TOOL_CHOICE_CASES) {
    for (const n of [...c.expect.first, ...(c.expect.must ?? []), ...c.expect.never, ...(c.expect.order ?? []).flat()]) {
      expect([c.id, n, !!registry.get(n)]).toEqual([c.id, n, true]);
      expect([c.id, n, tools.offered.includes(n)]).toEqual([c.id, n, true]);
      expect([c.id, n, n in MILA_TOOL_CARDS || n === "web_search"]).toEqual([c.id, n, true]);
    }
  }
});

test.each(TOOL_CHOICE_CASES.map((c) => [c.id, c] as const))("%s: the scripted right turn passes", (_id, c) => {
  expect(gradeToolChoice(c, c.scripted, tools)).toEqual({ pass: true, problems: [] });
  // A live run grades the model's first step only: the right turn's first call passes that too.
  expect(gradeToolChoice(c, c.scripted, tools, "first").pass).toBe(true);
});

test.each(TOOL_CHOICE_CASES.map((c) => [c.id, c] as const))("%s: the scripted wrong turn fails", (_id, c) => {
  const g = gradeToolChoice(c, c.wrong, tools);
  expect(g.pass).toBe(false);
  expect(g.problems.length).toBeGreaterThan(0);
});

describe("the grader itself", () => {
  const draft = TOOL_CHOICE_CASES.find((c) => c.id === "draft-a-reply")!;
  it("refuses an unknown tool, a tool the chat skill is not offered, and arguments its schema rejects", () => {
    expect(gradeToolChoice(draft, [{ name: "send_email", args: {} }], tools).problems).toContain("send_email: no such tool");
    expect(gradeToolChoice(draft, [{ name: "deals_find", args: { filter: "everything" } }], tools).problems.join(" ")).toMatch(/deals_find: arguments invalid \(filter\)/);
    expect(gradeToolChoice(draft, [{ name: "deals_find", args: { filter: "all", brand: "Northpeak" } }], { ...tools, offered: [] }).problems)
      .toContain("deals_find: not offered to the chat skill");
  });
  it("catches the order and the must", () => {
    const g = gradeToolChoice(draft, [
      { name: "deals_find", args: { filter: "all", brand: "Northpeak" } },
      { name: "deals_draft_reply", args: { deal_id: "x", intent: "ask_questions" } },
      { name: "deals_get", args: { deal_id: "x" } },
    ], tools);
    expect(g.problems).toEqual(["deals_get must come before deals_draft_reply"]);
    expect(gradeToolChoice(draft, [{ name: "deals_find", args: { filter: "all", brand: "Northpeak" } }], tools).problems)
      .toEqual(["deals_get was never called", "deals_draft_reply was never called"]);
  });
  it("no call is a fail", () => {
    expect(gradeToolChoice(draft, [], tools)).toEqual({ pass: false, problems: ["no tool was called"] });
  });
});
