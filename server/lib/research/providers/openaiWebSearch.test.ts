/** openaiWebSearch adapter — parsing and envelope mapping on a SYNTHETIC Responses payload; the retry twin with a fake call. No network. */

import { describe, expect, it } from "@jest/globals";
import { validateCitation } from "../../../services/intelligence/research/lineage";
import { GROUNDED_SYSTEM } from "./geminiGrounded";
import { OPENAI_WEB_SEARCH_SYSTEM, parseResponsesOutput, runOnceRequest, toSearchEnvelope, webSearch } from "./openaiWebSearch";

const RESPONSE = {
  id: "resp_1", status: "completed",
  output: [
    { type: "web_search_call", status: "completed", action: { type: "search", query: "Jane Doe basketball Example University" } },
    { type: "message", role: "assistant", content: [{
      type: "output_text",
      text: "Jane Doe plays for Example University. She won the 2025 award.",
      annotations: [
        { type: "url_citation", url: "https://www.example.edu/roster/jane", title: "Roster", start_index: 0, end_index: 38 },
        { type: "url_citation", url: "https://www.espn.com/jane", title: "ESPN", start_index: 39, end_index: 63 },
        { type: "url_citation", url: "https://www.example.edu/roster/jane", title: "Roster", start_index: 39, end_index: 63 },
      ],
    }] },
  ],
  usage: { input_tokens: 900, output_tokens: 120, input_tokens_details: { cached_tokens: 0 } },
};

describe("openaiWebSearch", () => {
  it("compiles the same research intent as the Gemini arm with only the tool name changed", () => {
    expect(OPENAI_WEB_SEARCH_SYSTEM).toBe(GROUNDED_SYSTEM.replace("Always use Google Search", "Always use web search"));
    expect(OPENAI_WEB_SEARCH_SYSTEM).not.toContain("Google");
  });

  it("parses output_text annotations and web_search_call queries", () => {
    const raw = parseResponsesOutput(RESPONSE);
    expect(raw.text).toBe("Jane Doe plays for Example University. She won the 2025 award.");
    expect(raw.citations).toHaveLength(3);
    expect(raw.searchQueries).toEqual(["Jane Doe basketball Example University"]);
    expect(raw).toMatchObject({ promptTokens: 900, completionTokens: 120, cachedTokens: 0, finishReason: "completed" });
  });

  it("maps distinct URLs to chunks whose text is the provider's cited answer spans, and validates a claim quote against them", () => {
    const env = toSearchEnvelope(parseResponsesOutput(RESPONSE), { envelopeId: "o0", queryName: "Profile + Social", query: "q", model: "gpt-test", fetchedAt: "2026-09-13T00:00:00Z" });
    expect(env.provider).toBe("openai_web_search");
    expect(env.chunks.map((c) => c.url)).toEqual(["https://www.example.edu/roster/jane", "https://www.espn.com/jane"]);
    expect(env.chunks[0]).toMatchObject({ id: "o0:c0", domain: "example.edu", textKind: "provider_answer_segments" });
    expect(env.chunks[0].text).toBe("Jane Doe plays for Example University.\nShe won the 2025 award.");
    expect(env.chunks[1].text).toBe("She won the 2025 award.");
    expect(env.supports).toHaveLength(3);
    expect(env.supports[2].chunkIds).toEqual(["o0:c0"]);
    expect(env.supports[0].confidence).toBeUndefined();   // OpenAI carries no per-span confidence (documented difference)
    expect(validateCitation({ chunkIds: ["o0:c1"], quote: "won the 2025 award" }, [env]).status).toBe("cited");
    expect(validateCitation({ chunkIds: ["o0:c1"], quote: "plays for Example University" }, [env]).status).toBe("conflicting");
  });

  it("retries an empty answer with the same cap semantics as the Gemini arm and reserves before every attempt", async () => {
    const calls: string[] = [];
    let reserves = 0;
    const r = await webSearch("Jane Doe", {
      envelopeId: "o0", queryName: "Profile + Social", retryMax: 2, reserve: async () => { reserves++; return true; }, sleep: async () => {},
      call: async (q) => { calls.push(q); return calls.length < 2 ? { text: "", citations: [], searchQueries: [] } : parseResponsesOutput(RESPONSE); },
    });
    expect(r).toMatchObject({ attempts: 2, completed: true, refused: false });
    expect(reserves).toBe(2);
    expect(calls[1]).toMatch(/\[retry-2-ts:\d+\]$/);
    expect(r.envelope.usage?.calls).toBe(2);
    expect(r.envelope.errors).toEqual([]);
  });

  it("sums token usage across retried attempts and flags incompleteness when an attempt threw", async () => {
    let n = 0;
    const r = await webSearch("Jane Doe", {
      envelopeId: "o0", queryName: "Profile + Social", retryMax: 2, reserve: async () => true, sleep: async () => {},
      call: async () => { n++; if (n === 1) return { text: "", citations: [], searchQueries: [], promptTokens: 700, completionTokens: 50 }; return { ...parseResponsesOutput(RESPONSE), cachedTokens: 100 }; },
    });
    expect(r.attempts).toBe(2);
    expect(r.envelope.usage).toMatchObject({ promptTokens: 1600, completionTokens: 170, cachedTokens: 100, calls: 2 });
    expect(r.envelope.usage?.usageIncomplete).toBeUndefined();
    let m = 0;
    const r2 = await webSearch("Jane Doe", {
      envelopeId: "o1", queryName: "Profile + Social", retryMax: 1, reserve: async () => true, sleep: async () => {},
      call: async () => { m++; if (m === 1) throw new Error("socket hang up"); return parseResponsesOutput(RESPONSE); },
    });
    expect(r2.envelope.usage).toMatchObject({ promptTokens: 900, completionTokens: 120, calls: 2, usageIncomplete: true });
  });

  it("makes no call when the reservation is refused", async () => {
    const r = await webSearch("Jane Doe", { envelopeId: "o0", queryName: "Profile + Social", retryMax: 2, reserve: async () => false, call: async () => { throw new Error("must not be called"); } });
    expect(r).toMatchObject({ attempts: 0, completed: false, refused: true });
    expect(r.envelope.errors[0]).toMatchObject({ class: "budget" });
  });

  it("reads every consulted page (action.sources) and asks for them only when includeSources is set", () => {
    const withSources = { ...RESPONSE, output: [{ type: "web_search_call", status: "completed", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://a.example/x" }, { type: "url", url: "" }, { type: "url", url: "https://b.example/y", title: "B" }] } }, ...RESPONSE.output.slice(1)] };
    expect(parseResponsesOutput(withSources).searchSources).toEqual([{ url: "https://a.example/x", title: "" }, { url: "https://b.example/y", title: "B" }]);
    expect(parseResponsesOutput(RESPONSE).searchSources).toEqual([]);
    expect(runOnceRequest("q", "", { includeSources: true })).toMatchObject({ include: ["web_search_call.action.sources"] });
    expect(runOnceRequest("q", "sys")).not.toHaveProperty("include");
    expect(runOnceRequest("q", "", { store: false })).toMatchObject({ store: false });
    expect(runOnceRequest("q", "sys")).not.toHaveProperty("store");
  });
});
