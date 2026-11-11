/**
 * geminiProvider.test.ts — the Gemini (Vertex) adapter with its client replaced; nothing reaches Vertex or OpenAI:
 *   - a harness turn: system instruction, function declarations (JSON schema), thinking level from the effort; text
 *     streamed to onText (thoughts never are); function calls come back with a call id that carries the name, and the
 *     tool output goes back as a functionResponse the model can match; the model's parts (thought signatures included)
 *     are replayed as is; consecutive tool answers are merged into one turn; usage maps to the OpenAI shape;
 *   - web search is refused loudly, before any call: a built-in on a turn, webSearch on a structured call, and a
 *     searching skill resolved to a Gemini model (modelFor);
 *   - a structured call: JSON schema + mime type, a data-URL image as inline data, cost from the Gemini price, and
 *     callStructured routes a Gemini ModelChoice here (no valid JSON is a ModelCallError, as on OpenAI).
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { buildTurnRequest, callGeminiStructured, contentsOf, createGeminiProvider, GeminiWebSearchRefused, mergeToolResponses, setGeminiClient, usageOf, type GeminiClient } from "./geminiProvider";
import { costOf, modelFor } from "./models";
import { callStructured, ModelCallError, setResponsesTransport } from "./research/llm";
import type { ProviderTurnRequest } from "./provider";

const FLASH = { provider: "gemini" as const, model: "gemini-3.5-flash", effort: "low" as const };

/** A client that streams the given chunks for each call, in order, and records each request. */
function fakeClient(...answers: any[][]): GeminiClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    models: {
      generateContentStream: async (params) => {
        calls.push(params);
        const chunks = answers.shift() ?? [];
        return (async function* () { for (const c of chunks) yield c; })();
      },
    },
  };
}

const chunk = (parts: any[], extra: Record<string, any> = {}) => ({ candidates: [{ content: { role: "model", parts }, ...(extra.finishReason ? { finishReason: extra.finishReason } : {}) }], ...(extra.usage ? { usageMetadata: extra.usage } : {}) });

const baseReq = (over: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest => ({
  model: FLASH, instructions: "RULES", input: [], functions: [], builtins: [], ...over,
});

afterEach(() => { setGeminiClient(null); setResponsesTransport(null); });

describe("harness turn", () => {
  it("builds the request: system instruction, function declarations with the JSON schema, thinking level", () => {
    const body = buildTurnRequest(baseReq({
      model: { ...FLASH, effort: "minimal" },
      input: [{ role: "user", parts: [{ text: "hi" }] }],
      functions: [{ name: "health_check", description: "ok?", parameters: { type: "object", properties: {} } }],
    }));
    expect(body).toEqual({
      model: "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: {
        systemInstruction: "RULES",
        tools: [{ functionDeclarations: [{ name: "health_check", description: "ok?", parametersJsonSchema: { type: "object", properties: {} } }] }],
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      },
    });
    expect(buildTurnRequest(baseReq()).config.tools).toBeUndefined();
  });

  it("streams text (never thoughts), returns function calls whose id carries the name, and replays the parts as is", async () => {
    const sig = "c2lnbmF0dXJl";
    const client = fakeClient([
      chunk([{ text: "thinking about it", thought: true }]),
      chunk([{ text: "Let me " }]),
      chunk([{ text: "check." }, { functionCall: { name: "read_own", args: { a: 1 } }, thoughtSignature: sig }], { finishReason: "STOP", usage: { promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 70 } }),
    ]);
    const p = createGeminiProvider({ client });
    const deltas: string[] = [];
    const r = await p.turn(baseReq({ input: [p.userMessage("go")], onText: (d) => deltas.push(d) }));
    expect(deltas.join("")).toBe("Let me check.");
    expect(r.text).toBe("Let me check.");
    expect(r.functionCalls).toEqual([{ callId: "read_own#3", name: "read_own", arguments: JSON.stringify({ a: 1 }) }]);
    expect(r.webSearches).toEqual([]);
    expect(r.usage).toEqual({ inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 100, reasoningTokens: 70, webSearchCalls: 0 });
    const replay = r.outputItems[0] as any;
    expect(replay.role).toBe("model");
    expect(replay.parts.find((x: any) => x.functionCall)).toEqual({ functionCall: { name: "read_own", args: { a: 1 } }, thoughtSignature: sig });

    // The tool answer goes back as a functionResponse under the model's function name.
    expect(p.toolOutput("read_own#3", JSON.stringify({ athlete: "x" }))).toEqual({ role: "user", parts: [{ functionResponse: { name: "read_own", response: { athlete: "x" } } }] });
    expect(p.toolOutput("read_own#3", "plain")).toEqual({ role: "user", parts: [{ functionResponse: { name: "read_own", response: { output: "plain" } } }] });
    expect(p.toolOutput("a#b#7", "[1]")).toEqual({ role: "user", parts: [{ functionResponse: { name: "a#b", response: { output: [1] } } }] });
    expect(p.assistantMessage("earlier")).toEqual({ role: "model", parts: [{ text: "earlier" }] });
  });

  it("a model-given call id is kept; answers to one turn's calls are merged into one user turn", async () => {
    const client = fakeClient([chunk([{ functionCall: { id: "fc1", name: "a", args: {} } }, { functionCall: { id: "fc2", name: "b" } }])]);
    const p = createGeminiProvider({ client });
    const r = await p.turn(baseReq());
    expect(r.functionCalls.map((c) => c.callId)).toEqual(["a#fc1", "b#fc2"]);
    expect(r.functionCalls[1].arguments).toBe("{}");
    const merged = mergeToolResponses([p.userMessage("go"), ...r.outputItems, p.toolOutput("a#fc1", "{}"), p.toolOutput("b#fc2", "{}")]);
    expect(merged).toHaveLength(3);
    expect((merged[2] as any).parts.map((x: any) => x.functionResponse.name)).toEqual(["a", "b"]);
  });

  it("refuses a built-in (web_search) before any call is made", async () => {
    const client = fakeClient([]);
    const p = createGeminiProvider({ client });
    await expect(p.turn(baseReq({ builtins: ["web_search"] }))).rejects.toThrow(GeminiWebSearchRefused);
    await expect(p.turn(baseReq({ builtins: ["web_search"] }))).rejects.toThrow(/search stays on OpenAI/);
    expect(client.calls).toHaveLength(0);
  });

  it("a blocked response with nothing in it is an error, not an empty answer", async () => {
    const p = createGeminiProvider({ client: fakeClient([chunk([], { finishReason: "SAFETY" })]) });
    await expect(p.turn(baseReq())).rejects.toThrow(/SAFETY/);
  });

  it("usage: missing metadata is zero, never NaN", () => {
    expect(usageOf(undefined)).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0 });
  });
});

describe("modelFor never puts search on Gemini", () => {
  const saved = process.env.AGENT_SKILL_MODELS;
  afterEach(() => { if (saved === undefined) delete process.env.AGENT_SKILL_MODELS; else process.env.AGENT_SKILL_MODELS = saved; });

  it("throws for a web_search skill resolved to a Gemini model", () => {
    process.env.AGENT_SKILL_MODELS = JSON.stringify({ research: { model: "gemini-3.5-flash" } });
    expect(() => modelFor({ id: "research", model: "reasoning", effort: "high", tools: ["web_search"] })).toThrow(/web_search.*OpenAI/);
    expect(modelFor({ id: "research", model: "reasoning", effort: "high", tools: [] }).provider).toBe("gemini");
  });
});

describe("structured call", () => {
  const SCHEMA = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const SKILL = { id: "test/structured", version: "1.0.0", instructions: "Answer ok." };

  it("sends the JSON schema, translates a data-URL image, prices on Gemini rates", async () => {
    const client = fakeClient([chunk([{ text: '{"ok":' }]), chunk([{ text: "true}" }], { finishReason: "STOP", usage: { promptTokenCount: 1000, candidatesTokenCount: 10, thoughtsTokenCount: 90 } })]);
    setGeminiClient(client);
    const seen: string[] = [];
    const r = await callGeminiStructured({
      skill: SKILL, model: FLASH, schema: SCHEMA, maxOutputTokens: 300, onText: (t) => seen.push(t),
      input: [{ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "high" }] }],
    });
    expect(r.json).toEqual({ ok: true });
    expect(r.status).toBe("completed");
    expect(seen[seen.length - 1]).toBe('{"ok":true}');
    const body = client.calls[0];
    expect(body.config).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: SCHEMA, maxOutputTokens: 300, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(body.config.systemInstruction).toContain("# Skill: test/structured v1.0.0");
    expect(body.config.tools).toBeUndefined();
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] }]);
    // 1000 × 1.5 + 100 × 9 = 2400 micro-dollars
    expect(r.cost.microUsd).toBe(2400);
    expect(r.cost).toEqual(costOf("gemini-3.5-flash", r.usage));
  });

  it("refuses webSearch before any call, and an image URL it would have to fetch", async () => {
    const client = fakeClient([]);
    setGeminiClient(client);
    await expect(callGeminiStructured({ skill: SKILL, model: FLASH, schema: SCHEMA, input: "x", webSearch: { maxCalls: 2 } })).rejects.toThrow(GeminiWebSearchRefused);
    expect(() => contentsOf([{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.jpg" }] }])).toThrow(/data URL/);
    expect(client.calls).toHaveLength(0);
  });

  it("callStructured routes a Gemini choice here, never to OpenAI; no valid JSON is a ModelCallError with its cost", async () => {
    setResponsesTransport({ create: async () => { throw new Error("must not reach OpenAI"); } });
    setGeminiClient(fakeClient([chunk([{ text: '{"ok":false}' }], { finishReason: "STOP" })], [chunk([{ text: "not json" }], { finishReason: "STOP", usage: { promptTokenCount: 500, candidatesTokenCount: 5 } })]));
    const ok = await callStructured({ skill: SKILL, model: FLASH, input: "x", schemaName: "s", schema: SCHEMA });
    expect(ok).toMatchObject({ json: { ok: false }, queries: [], sources: [] });
    const err = await callStructured({ skill: SKILL, model: FLASH, input: "x", schemaName: "s", schema: SCHEMA }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.partial.cost.microUsd).toBeGreaterThan(0);
  });
});
