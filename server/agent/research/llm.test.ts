/**
 * llm.test.ts — the structured-call adapter: parsing sources (searches + citations), usage → cost, and a broken
 * answer recorded as a failed run with what it cost. The model is mocked.
 */
jest.mock("../../db", () => ({ db: {} }));

import { fakeResponses } from "../../testUtils/agentModel";
import { cleanUrl, normalizeUrl, parseStructuredResponse, setResponsesTransport } from "./llm";
import { runSkill } from "./runSkill";
import { createMemoryStore } from "./store";
import { RESEARCH_PASS_SCHEMA } from "./schemas";

afterEach(() => setResponsesTransport(null));

test("sources come from search actions and url citations, de-duplicated; usage is read", () => {
  const r = parseStructuredResponse({
    id: "resp_1", status: "completed",
    output: [
      { type: "web_search_call", action: { query: "q1", sources: [{ url: "https://www.a.example/x?utm_source=openai", title: "A" }] } },
      { type: "web_search_call", action: { queries: ["q2", "q3"], sources: [{ url: "https://a.example/x" }] } },
      { type: "message", content: [{ type: "output_text", text: "```json\n{\"ok\":true}\n```", annotations: [{ type: "url_citation", url: "https://b.example/y#frag", title: "B" }] }] },
    ],
    usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 4000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } },
  });
  expect(r.json).toEqual({ ok: true });
  expect(r.queries).toEqual(["q1", "q2", "q3"]);
  expect(r.sources).toEqual([{ url: "https://www.a.example/x", title: "A" }, { url: "https://b.example/y", title: "B" }]);
  expect(r.usage).toEqual({ inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 300, reasoningTokens: 100, webSearchCalls: 2 });
  expect(cleanUrl("https://www.a.example/x?utm_source=openai&id=2")).toBe("https://www.a.example/x?id=2");
  expect(normalizeUrl("https://WWW.A.example/x/")).toBe("https://a.example/x");
});

test("a broken answer is a failed run that still records its cost", async () => {
  const store = createMemoryStore();
  setResponsesTransport(fakeResponses(() => ({ json: null, rawText: "not json at all", usage: { input: 2000, output: 100 } })));
  await expect(runSkill({ store, athleteId: "a1", skillId: "research", trigger: "test", parentRef: "p:1", input: "x", schemaName: "research_pass", schema: RESEARCH_PASS_SCHEMA }))
    .rejects.toThrow(/no valid JSON/);
  const [run] = (store as any).dump().runs;
  expect(run).toMatchObject({ status: "failed", stopReason: "error" });
  expect(run.cost.microUsd).toBeGreaterThan(0);
  expect(run.steps.map((s: any) => s.type)).toEqual(["skill", "model", "error"]);
  // A failed run is never reused: the retry pays again, deliberately.
  expect(await store.findCompletedRun("a1", "p:1")).toBeNull();
});

/**
 * The sign-up's time budget (runSkill `cut`): a stream that searched, wrote one whole fact and half of a second, then
 * stalls until it is aborted. The cut keeps the whole fact only, finishes the run COMPLETED (so the merge reuses it
 * instead of calling the model again), and counts the searches it saw.
 */
test("a cut run keeps the facts it had streamed and finishes completed for reuse", async () => {
  const store = createMemoryStore();
  const fact = { claim: "Riley Athlete captains the team.", topic: "team", source_url: "https://news.example/riley", source_title: "News", sensitivity: "public" };
  const streamed = `{"identity":{"resolved":true,"description":"the athlete","ambiguity":""},"facts":[${JSON.stringify(fact)},{"claim":"half a fa`;
  setResponsesTransport({
    create: async (_params: Record<string, unknown>, options?: { signal?: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_item.done", item: { type: "web_search_call", action: { query: "riley", sources: [{ url: "https://news.example/riley", title: "News" }] } } };
        yield { type: "response.output_text.delta", delta: streamed };
        await new Promise<void>((resolve) => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    }),
  });
  const { salvagePassJson } = await import("./research");
  const r = await runSkill({
    store, athleteId: "a1", skillId: "research", trigger: "test", parentRef: "p:cut", input: "x", schemaName: "research_pass", schema: RESEARCH_PASS_SCHEMA,
    webSearch: { maxCalls: 10 }, cut: { check: async () => true, everyMs: 5, salvage: salvagePassJson },
  });
  expect(r.cut).toBe(true);
  expect(r.json.facts).toEqual([fact]);
  expect(r.json.identity).toMatchObject({ resolved: true });
  expect(r.sources).toEqual([{ url: "https://news.example/riley", title: "News" }]);
  const [run] = (store as any).dump().runs;
  expect(run).toMatchObject({ status: "completed", stopReason: "aborted" });
  expect(run.output.cut).toBe(true);
  expect(run.cost.webSearchCalls).toBe(1);
  expect(await store.findCompletedRun("a1", "p:cut")).not.toBeNull();
});

test("salvagePassJson: only whole objects, escapes and braces inside strings respected; nothing streamed is null", async () => {
  const { salvagePassJson } = await import("./research");
  expect(salvagePassJson("")).toBeNull();
  expect(salvagePassJson(`{"identity":{"resolved":tr`)).toBeNull();
  const tricky = { claim: "She said \"go {big}\" [twice]", topic: "story", source_url: "https://x.example/a" };
  const out = salvagePassJson(`{"identity":{"resolved":false,"description":"","ambiguity":"two people"},"facts":[${JSON.stringify(tricky)},{"claim":"cut`)!;
  expect(out.identity).toEqual({ resolved: false, description: "", ambiguity: "two people" });
  expect(out.facts).toEqual([tricky]);
  expect(out.gaps).toEqual([]);
  expect(out.narrative).toBe("");
});

test("a stream that fails WITHOUT a cut is still a failed run (the cut never hides an error)", async () => {
  const store = createMemoryStore();
  setResponsesTransport({
    create: async () => ({ async *[Symbol.asyncIterator]() { yield { type: "error", message: "boom" }; } }),
  });
  await expect(runSkill({
    store, athleteId: "a1", skillId: "research", trigger: "test", parentRef: "p:err", input: "x", schemaName: "research_pass", schema: RESEARCH_PASS_SCHEMA,
    cut: { check: async () => false, everyMs: 5, salvage: () => ({ facts: [] }) },
  })).rejects.toThrow(/boom/);
  const [run] = (store as any).dump().runs;
  expect(run).toMatchObject({ status: "failed", stopReason: "error" });
});
