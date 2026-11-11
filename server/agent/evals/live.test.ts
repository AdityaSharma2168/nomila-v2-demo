/**
 * live.test.ts — the paid run's engine, with NO provider: the plan is the chat skill's own, the estimate is positive
 * and priced off the model table, a fake provider's turn is graded by the offline grader, and the script refuses under
 * CI before it loads anything. Nothing here reaches a model.
 */
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("the evals never touch the database"); } }) }));

import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";
import type { AgentModelProvider, ProviderTurnRequest } from "../provider";
import { estimateLiveCost, livePlan, playToolChoice } from "./live";
import { TOOL_CHOICE_CASES } from "./offline/toolChoice.cases";
import { buildMilaInstructions } from "../mila/build";
import { PLAYBOOKS_LEAD } from "../engine/mastra/skills";

const execFileP = promisify(execFile);

function fakeProvider(answer: (q: string) => { name: string; arguments: string }[]): AgentModelProvider & { calls: ProviderTurnRequest[] } {
  const calls: ProviderTurnRequest[] = [];
  return {
    id: "openai", calls,
    async turn(req) {
      calls.push(req);
      const q = String((req.input[0] as { text?: string }).text);
      return {
        text: "", webSearches: [], outputItems: [],
        functionCalls: answer(q).map((f, i) => ({ callId: `c${i}`, ...f })),
        usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, webSearchCalls: 0 },
      };
    },
    userMessage: (text) => ({ text }),
    assistantMessage: (text) => ({ text }),
    toolOutput: (callId, output) => ({ callId, output }),
  };
}

test("the plan is what live Mila on Mastra gets: its text and playbooks message, the chat skill's tools as Mastra offers them, its model", () => {
  const plan = livePlan();
  expect(plan.instructions.startsWith(buildMilaInstructions({ surface: "chat", engine: "mastra" }).trimEnd())).toBe(true);
  expect(plan.instructions).toContain(PLAYBOOKS_LEAD);
  expect(plan.instructions).toContain("call the skill tool with the area's name");
  expect(plan.instructions).not.toContain("get_playbook");
  expect(plan.instructions).not.toContain("# Skill: chat");
  const names = plan.functions.map((f) => f.name);
  for (const n of ["recall_facts", "deals_find", "deals_draft_reply", "documents_status", "bookings_list", "skill", "skill_read", "skill_search"]) expect(names).toContain(n);
  expect(names).not.toContain("get_playbook");
  expect(plan.lookup.offered).toEqual(expect.arrayContaining(["skill", "skill_read", "skill_search"]));
  expect(plan.lookup.get("skill")!.args.safeParse({ name: "deals" }).success).toBe(true);
  expect(plan.builtins).toContain("web_search");
  expect(plan.model.model).toBeTruthy();
});

test("the estimate is positive and grows with the cases", () => {
  const plan = livePlan();
  const all = estimateLiveCost(plan);
  const one = estimateLiveCost(plan, TOOL_CHOICE_CASES.slice(0, 1));
  expect(all.cases).toBe(TOOL_CHOICE_CASES.length);
  expect(all.usd).toBeGreaterThan(one.usd);
  expect(one.usd).toBeGreaterThan(0);
});

test("a played turn is graded on its first step: the scripted answers pass, a wrong one fails", async () => {
  const plan = livePlan();
  const right = fakeProvider((q) => {
    const c = TOOL_CHOICE_CASES.find((x) => x.question === q)!;
    return c.scripted.map((s) => ({ name: s.name, arguments: JSON.stringify(s.args) }));
  });
  const results = await playToolChoice(right, plan);
  expect(results.map((r) => [r.id, r.grade.pass])).toEqual(TOOL_CHOICE_CASES.map((c) => [c.id, true]));
  expect(right.calls).toHaveLength(TOOL_CHOICE_CASES.length);
  expect(right.calls[0].input).toEqual([{ text: TOOL_CHOICE_CASES[0].question }]);
  expect(results[0].microUsd).toBeGreaterThan(0);

  const wrong = fakeProvider(() => [{ name: "deals_mark", arguments: "not json" }]);
  const bad = await playToolChoice(wrong, plan, TOOL_CHOICE_CASES.slice(0, 1));
  expect(bad[0].grade.pass).toBe(false);
});

test("the script refuses under CI, before it loads the engine", async () => {
  const root = join(__dirname, "..", "..", "..");
  const r = await execFileP(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "scripts", "evals-live.ts")], {
    cwd: root, env: { ...process.env, CI: "true", NODE_OPTIONS: "" },
  }).then(() => ({ code: 0, stderr: "" }), (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("paid runs never run in CI");
}, 60_000);
