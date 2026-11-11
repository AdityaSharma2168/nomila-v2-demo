/**
 * openaiResponses.test.ts — the OpenAI Responses adapter against a FAKE client (never OpenAI): the request carries the
 * model, reasoning effort, our tools as functions plus the native web_search, store:false with encrypted reasoning, and
 * the prompt-cache key; streamed text deltas reach onText; the completed response parses into function calls, web
 * searches (queries + cited sources) and usage; a failed stream throws. The SDK constructor is mocked to throw, so a
 * test that forgot to inject a client fails loudly instead of calling out.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { buildRequest, createOpenAIProvider, parseResponse, type ResponsesClient } from "./openaiResponses";
import type { ProviderTurnRequest } from "./provider";

const req = (over: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest => ({
  model: { provider: "openai", model: "m-1", effort: "high" },
  instructions: "RULES",
  input: [{ role: "user", content: "hi" }],
  functions: [{ name: "health_check", description: "d", parameters: { type: "object", properties: {} } }],
  builtins: ["web_search"],
  cacheKey: "skill:echo/health@1.0.0",
  ...over,
});

const completed = {
  id: "resp_1",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", encrypted_content: "xyz" },
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "who is it", sources: [{ url: "https://a.example/x", title: "A" }] } },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "health_check", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello ", annotations: [{ type: "url_citation", url: "https://b.example/y", title: "B", start_index: 0, end_index: 5 }] }, { type: "output_text", text: "there", annotations: [{ type: "url_citation", url: "https://a.example/x" }] }] },
  ],
  usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } },
};

function fakeClient(events: any[]): ResponsesClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    responses: {
      async create(params, options) {
        calls.push({ params, options });
        return (async function* () { for (const e of events) yield e; })();
      },
    },
  };
}

describe("buildRequest", () => {
  it("sends model, effort, tools, no storage, encrypted reasoning, cache key and streaming", () => {
    expect(buildRequest(req())).toEqual({
      model: "m-1",
      instructions: "RULES",
      input: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", name: "health_check", description: "d", parameters: { type: "object", properties: {} }, strict: false }, { type: "web_search" }],
      reasoning: { effort: "high" },
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "skill:echo/health@1.0.0",
      stream: true,
    });
  });

  it("sends a strict-ready function schema with strict: true", () => {
    const params = { type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"], additionalProperties: false };
    const body = buildRequest(req({ functions: [{ name: "f", description: "d", parameters: params, strict: true }], builtins: [] }));
    expect(body.tools).toEqual([{ type: "function", name: "f", description: "d", parameters: params, strict: true }]);
  });

  it("omits tools and the cache key when there are none", () => {
    const body = buildRequest(req({ functions: [], builtins: [], cacheKey: undefined }));
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("parseResponse", () => {
  it("extracts text, function calls, web searches with deduped sources, usage, and every output item", () => {
    const r = parseResponse(completed);
    expect(r.text).toBe("Hello there");
    expect(r.functionCalls).toEqual([{ callId: "call_1", name: "health_check", arguments: "{}" }]);
    expect(r.webSearches).toEqual([{ queries: ["who is it"], sources: [{ url: "https://a.example/x", title: "A" }, { url: "https://b.example/y", title: "B" }] }]);
    expect(r.usage).toEqual({ inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 300, reasoningTokens: 200, webSearchCalls: 1, cacheWriteTokens: 0 });
    expect(r.outputItems).toHaveLength(4);
    expect(r.responseId).toBe("resp_1");
  });

  it("reads cache writes when the response reports them", () => {
    const r = parseResponse({ ...completed, usage: { ...completed.usage, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 900 } } });
    expect(r.usage).toMatchObject({ cachedInputTokens: 100, cacheWriteTokens: 900 });
  });

  it("an empty response is empty, not an error", () => {
    expect(parseResponse({})).toMatchObject({ text: "", functionCalls: [], webSearches: [], usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0 } });
  });
});

describe("createOpenAIProvider", () => {
  it("streams deltas to onText and returns the parsed completed response", async () => {
    const client = fakeClient([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "there" },
      { type: "response.completed", response: completed },
    ]);
    const deltas: string[] = [];
    const signal = new AbortController().signal;
    const out = await createOpenAIProvider({ client }).turn(req({ onText: (d) => deltas.push(d), signal }));
    expect(deltas).toEqual(["Hello ", "there"]);
    expect(out.functionCalls).toHaveLength(1);
    expect(client.calls[0].params.stream).toBe(true);
    expect(client.calls[0].options).toEqual({ signal });
  });

  it("an incomplete response still parses (e.g. max output tokens)", async () => {
    const client = fakeClient([{ type: "response.incomplete", response: { ...completed, status: "incomplete" } }]);
    await expect(createOpenAIProvider({ client }).turn(req())).resolves.toMatchObject({ text: "Hello there" });
  });

  it("a failed or errored stream throws, and so does a stream with no completion", async () => {
    await expect(createOpenAIProvider({ client: fakeClient([{ type: "response.failed", response: { error: { message: "boom" } } }]) }).turn(req())).rejects.toThrow(/boom/);
    await expect(createOpenAIProvider({ client: fakeClient([{ type: "error", message: "rate" }]) }).turn(req())).rejects.toThrow(/rate/);
    await expect(createOpenAIProvider({ client: fakeClient([]) }).turn(req())).rejects.toThrow(/without a completed response/);
  });

  it("builds provider-native items for the loop", () => {
    const p = createOpenAIProvider({ client: fakeClient([]) });
    expect(p.userMessage("u")).toEqual({ role: "user", content: "u" });
    expect(p.assistantMessage("a")).toEqual({ role: "assistant", content: "a" });
    expect(p.toolOutput("call_1", "{}")).toEqual({ type: "function_call_output", call_id: "call_1", output: "{}" });
  });

  it("without an injected client and without a key it refuses before any network", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(createOpenAIProvider().turn(req())).rejects.toThrow(/OPENAI_API_KEY is not set/);
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });
});
