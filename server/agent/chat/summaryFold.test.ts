/**
 * summaryFold.test.ts — the rolling summary fold after a chat turn (chat/summary.ts maybeFoldAgentConversation) is
 * BOUNDED in production, not only switched off in tests (`fold: false` in the Mastra turn suites). No database, no
 * provider: the fold's work and the model are scripted; the run's trace is in memory.
 *
 *   F1  a model call that never answers is aborted at the bound and the fold settles ("timeout"); its signal fired
 *   F2  a model that ignores the abort still lets the fold settle at the bound, and its late answer is never written
 *   F3  one fold at a time per conversation: a second while one runs is skipped ("busy"); another conversation is not
 *   F4  the deletion fence: a fenced athlete starts nothing; fencing during the call drops the answer (nothing written);
 *       a failed fence check counts as fenced
 *   F5  never rejects: a throwing fold's work settles as "failed" (no unhandled rejection)
 */
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("tests here never touch the database"); } }) }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import type { TextSkillRuntime } from "../engine/textSkill";
import type { AgentModelProvider, ProviderTurnRequest } from "../provider";
import { memoryTraceSink } from "../trace";
import { FOLD_TIMEOUT_MS, maybeFoldAgentConversation, type FoldOptions } from "./summary";

const A = "00000000-0000-4000-a000-0000000000f1";
const CONV = "00000000-0000-4000-a000-0000000000c1";
const runtime = (): TextSkillRuntime => ({ trace: memoryTraceSink(), spentTodayMicroUsd: async () => 0 });

function model(turn: (req: ProviderTurnRequest) => Promise<string>): AgentModelProvider & { signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    id: "openai", signals,
    userMessage: (text) => ({ role: "user", content: text }),
    assistantMessage: (text) => ({ role: "assistant", content: text }),
    toolOutput: (callId, output) => ({ type: "function_call_output", call_id: callId, output }),
    async turn(req) {
      if (req.signal) signals.push(req.signal);
      const text = await turn(req);
      req.onText?.(text);   // runTextSkill keeps only streamed text
      return { text, functionCalls: [], webSearches: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, webSearchCalls: 0 }, outputItems: [] };
    },
  };
}

/** The fold's work as maybeSummarizeConversation does it: one summarizing call, then a write unless it came back "". */
function work(written: string[]): NonNullable<FoldOptions["work"]> {
  return async (_a, _c, summarize) => { const s = await summarize("PRIOR … TURNS …"); if (s.trim()) written.push(s); };
}

const live: FoldOptions = { isDeleting: async () => false };

it("F0: the production bound is set and finite", () => {
  expect(FOLD_TIMEOUT_MS).toBeGreaterThan(0);
  expect(FOLD_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
});

it("F1: a model call that never answers is aborted at the bound; the fold settles", async () => {
  const m = model((req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
  const written: string[] = [];
  const t0 = Date.now();
  const out = await maybeFoldAgentConversation(A, CONV, { provider: m, runtime: runtime() }, { ...live, timeoutMs: 80, work: work(written) });
  expect(out).toBe("timeout");
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(m.signals[0]?.aborted).toBe(true);
  expect(written).toEqual([]);
});

it("F2: a model that ignores the abort: the fold still settles at the bound and the late answer is never written", async () => {
  let answer: (s: string) => void = () => undefined;
  const m = model(() => new Promise<string>((resolve) => { answer = resolve; }));
  const written: string[] = [];
  const w = work(written);
  let workDone: Promise<void> = Promise.resolve();
  const out = await maybeFoldAgentConversation(A, CONV, { provider: m, runtime: runtime() }, {
    ...live, timeoutMs: 50, work: (a, c, s) => (workDone = w(a, c, s)),
  });
  expect(out).toBe("timeout");
  answer("a late summary");
  await workDone;
  expect(written).toEqual([]);
});

it("F3: one fold at a time per conversation", async () => {
  let release: () => void = () => undefined;
  const slow: FoldOptions = { ...live, timeoutMs: 5_000, work: () => new Promise<void>((r) => { release = r; }) };
  const first = maybeFoldAgentConversation(A, CONV, {}, slow);
  await new Promise((r) => setImmediate(r));
  expect(await maybeFoldAgentConversation(A, CONV, {}, { ...live, work: async () => undefined })).toBe("busy");
  expect(await maybeFoldAgentConversation(A, "00000000-0000-4000-a000-0000000000c2", {}, { ...live, work: async () => undefined })).toBe("done");
  release();
  expect(await first).toBe("done");
  // Released: the next turn's fold runs.
  expect(await maybeFoldAgentConversation(A, CONV, {}, { ...live, work: async () => undefined })).toBe("done");
});

it("F4: the deletion fence", async () => {
  const workFn = jest.fn(async () => undefined);
  expect(await maybeFoldAgentConversation(A, CONV, {}, { isDeleting: async () => true, work: workFn })).toBe("fenced");
  expect(await maybeFoldAgentConversation(A, CONV, {}, { isDeleting: async () => { throw new Error("db down"); }, work: workFn })).toBe("fenced");
  expect(workFn).not.toHaveBeenCalled();

  // Fenced while the model call ran: the answer is dropped, nothing is written.
  let deleting = false;
  const m = model(async () => { deleting = true; return "a summary"; });
  const written: string[] = [];
  const out = await maybeFoldAgentConversation(A, CONV, { provider: m, runtime: runtime() }, { isDeleting: async () => deleting, timeoutMs: 2_000, work: work(written) });
  expect(out).toBe("done");
  expect(written).toEqual([]);

  // Not fenced: the same fold writes.
  const ok = model(async () => "a summary");
  const written2: string[] = [];
  expect(await maybeFoldAgentConversation(A, CONV, { provider: ok, runtime: runtime() }, { ...live, timeoutMs: 2_000, work: work(written2) })).toBe("done");
  expect(written2).toEqual(["a summary"]);
});

it("F5: never rejects", async () => {
  await expect(maybeFoldAgentConversation(A, CONV, {}, { ...live, work: async () => { throw new Error("boom"); } })).resolves.toBe("failed");
});
