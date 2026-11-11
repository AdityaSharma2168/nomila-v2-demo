/** Direct adapters with fake calls — retry on missing marker / bad JSON, reservation before every attempt, lineage bound, usage summed. No network. */

import { describe, expect, it } from "@jest/globals";
import { HYBRID_MARKER } from "../../../services/intelligence/research/spec/directEvidenceV1";
import { QUERIES, sectionsFor } from "../../../services/intelligence/research/spec/researchSpecV1";
import { geminiDirect } from "./geminiDirect";
import { openaiDirect, parseDirectResponse } from "./openaiDirect";

const sections = sectionsFor(false).filter((s) => s.id === "S1" || s.id === "S2");
const prose = "### PART 1\n* Full name: Her full name is Jane Doe. STATUS: FOUND.";
const seg = { startIndex: prose.indexOf("Her full name"), endIndex: prose.indexOf("Jane Doe") + "Jane Doe".length, text: "Her full name is Jane Doe" };
const json = JSON.stringify({ identity: { anchor_match: "matched", confidence: 0.9, namesakes: [] }, sections: { S1: { status: "found_cited", items: { full_name: "found_cited" } } }, claims: [{ section: "S1", item: "full_name", kind: "profile_attribute", factKey: "name", value: { full: "Jane Doe" }, statement: "s", sources: [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x", quote: "Her full name is Jane Doe." }] }] });
const good = { text: `${prose}\n${HYBRID_MARKER}\n${json}`, groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x", title: "Roster", domain: "example.edu" } }], groundingSupports: [{ segment: seg, groundingChunkIndices: [0] }], webSearchQueries: ["jane doe"], promptTokens: 1000, candidateTokens: 3000, thoughtTokens: 5000 };

const response = { id: "resp_1", status: "completed", output: [
  { type: "web_search_call", status: "completed", action: { type: "search", query: "Jane Doe", sources: [{ url: "https://www.ncaa.com/jane", title: "NCAA" }, "https://www.example.edu/roster/jane"] } },
  { type: "message", content: [{ type: "output_text", text: JSON.stringify({ identity: { anchor_match: "matched", confidence: 0.99, namesakes: [] }, sections: { S1: { status: "found_cited", items: { full_name: "found_cited" } } }, claims: [{ section: "S1", item: "full_name", kind: "profile_attribute", factKey: "name", value: { full: "Jane Doe" }, statement: "s", sources: [{ url: "https://example.edu/roster/jane/", quote: "Jane Doe" }] }] }), annotations: [] }] },
], usage: { input_tokens: 9000, output_tokens: 2000, input_tokens_details: { cached_tokens: 100 } } };

describe("geminiDirect", () => {
  it("retries a response without the marker, reserves before every attempt, sums usage, binds lineage from the prose and keeps the bound chunk as the source", async () => {
    let n = 0, reserves = 0;
    const r = await geminiDirect("req", { envelopeId: "gd0", queryName: "Q1", contract: "v1", sections, retryMax: 2, reserve: async () => { reserves++; return true; }, sleep: async () => {}, call: async () => { n++; return n === 1 ? { ...good, text: "prose only, no marker" } : good; } });
    expect(r).toMatchObject({ attempts: 2, completed: true, markerFound: true, nativeSources: 1, searchQueries: 1 });
    expect(reserves).toBe(2);
    expect(r.envelope.usage).toMatchObject({ promptTokens: 2000, completionTokens: 16_000, calls: 2 });
    expect(r.parsed!.claims[0].lineage).toMatchObject({ level: "native_supported", boundChunkIds: ["gd0:c0"], boundSources: [{ domain: "example.edu", title: "Roster" }] });
    expect(r.parsed!.claims[0].citation).toEqual({ chunkIds: ["gd0:c0"], quote: "Her full name is Jane Doe." });
    expect(r.envelope.chunks[0]).toMatchObject({ id: "gd0:c0", domain: "example.edu", text: "Her full name is Jane Doe" });
    expect(r.envelope.answerText).toBe(prose + "\n");
    expect(r.envelope.errors).toEqual([]);
  });
  it("gives up after the retry cap and reports the failure without throwing", async () => {
    const r = await geminiDirect("req", { envelopeId: "gd0", queryName: "Q1", contract: "v1", sections, retryMax: 1, reserve: async () => true, sleep: async () => {}, call: async () => { throw new Error("503"); } });
    expect(r).toMatchObject({ attempts: 2, completed: false, parsed: null });
    expect(r.envelope.errors).toHaveLength(2);
    expect(r.envelope.usage?.usageIncomplete).toBe(true);
  });
  it("bounds every attempt with the client timeout: a timed-out attempt is reserved, counted, recorded and retried", async () => {
    let n = 0, reserves = 0, aborted = 0;
    const r = await geminiDirect("req", { envelopeId: "gd0", queryName: "Q1", contract: "v1", sections, retryMax: 2, timeoutMs: 20, reserve: async () => { reserves++; return true; }, sleep: async () => {},
      call: (_req, signal) => { n++; if (n > 1) return Promise.resolve(good); return new Promise((_, reject) => signal?.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); })); } });
    expect(r).toMatchObject({ attempts: 2, completed: true });
    expect(reserves).toBe(2);
    expect(aborted).toBe(1);
    expect(r.envelope.usage).toMatchObject({ calls: 2, usageIncomplete: true });
  });
  it("records a timeout on every attempt up to the unchanged retry cap and reports it without throwing", async () => {
    const r = await geminiDirect("req", { envelopeId: "gd0", queryName: "Q1", contract: "v1", sections, retryMax: 1, timeoutMs: 10, reserve: async () => true, sleep: async () => {}, call: () => new Promise(() => {}) });
    expect(r).toMatchObject({ attempts: 2, completed: false });
    expect(r.envelope.errors).toEqual([{ step: "attempt-1", message: "provider call timed out after 10 ms", class: "timeout" }, { step: "attempt-2", message: "provider call timed out after 10 ms", class: "timeout" }]);
  });
});

describe("openaiDirect", () => {
  it("parses the retrieved-source list from the search call and matches claim URLs (normalized) to it", async () => {
    const raw = parseDirectResponse(response);
    expect(raw).toMatchObject({ sources: [{ url: "https://www.ncaa.com/jane", title: "NCAA" }, { url: "https://www.example.edu/roster/jane", title: null }], searchQueries: ["Jane Doe"], annotations: 0, promptTokens: 9000, completionTokens: 2000, cachedTokens: 100 });
    const r = await openaiDirect("req", { envelopeId: "od0", queryName: "Q1", contract: "v1", sections, retryMax: 1, reserve: async () => true, sleep: async () => {}, call: async () => raw });
    expect(r).toMatchObject({ attempts: 1, completed: true, nativeSources: 2, searchQueries: 1 });
    expect(r.parsed!.claims[0].lineage).toMatchObject({ level: "native_retrieved", match: "url_normalized", boundChunkIds: ["od0:c1"] });
    expect(r.envelope.chunks).toHaveLength(2);
    expect(r.envelope.request.params).toMatchObject({ include: "web_search_call.action.sources", mode: "direct_json" });
  });
  it("retries unparseable JSON and makes no call when the reservation is refused", async () => {
    let n = 0;
    const r = await openaiDirect("req", { envelopeId: "od0", queryName: "Q1", contract: "v1", sections, retryMax: 1, reserve: async () => true, sleep: async () => {}, call: async () => { n++; return { ...parseDirectResponse(response), text: n === 1 ? "not json" : parseDirectResponse(response).text }; } });
    expect(r).toMatchObject({ attempts: 2, completed: true });
    const refused = await openaiDirect("req", { envelopeId: "od0", queryName: "Q1", contract: "v1", sections, retryMax: 1, reserve: async () => false, call: async () => { throw new Error("must not be called"); } });
    expect(refused).toMatchObject({ attempts: 0, refused: true, completed: false });
  });
});

// ── direct-evidence/2 (default contract): item-centric JSON, lineage bound per finding, bounded reasoning recorded in the envelope ──
const Q1 = QUERIES.find((q) => q.id === "Q1")!;
const v2json = (url: string) => JSON.stringify({ contract: "direct-evidence/2", query: "Q1", identity: { anchor_match: "matched", confidence: 0.9, namesakes: [] }, items: { full_name: { status: "found", findings: [{ value: { full: "Jane Doe" }, statement: "Her full name is Jane Doe.", as_of: "2026-09-13", sources: [{ url, quote: "Her full name is Jane Doe." }] }] }, birth_year: { status: "not_found", findings: [] } } });

describe("direct-evidence/2 through the adapters", () => {
  it("geminiDirect binds each finding to the grounded prose, records the bounded thinking config, and refuses v2 without a query", async () => {
    const r = await geminiDirect("req", { envelopeId: "gd0", queryName: "Q1", query: Q1, sections, retryMax: 1, reserve: async () => true, sleep: async () => {}, call: async () => ({ ...good, text: `${prose}\n${HYBRID_MARKER}\n${v2json("https://vertexaisearch.cloud.google.com/grounding-api-redirect/x")}` }) });
    expect(r).toMatchObject({ attempts: 1, completed: true, markerFound: true, parsed: null });
    expect(r.parsedV2!.parseError).toBeNull();
    expect(r.parsedV2!.items.full_name).toMatchObject({ status: "found", findings: [expect.objectContaining({ section: "S1", item: "full_name", lineage: expect.objectContaining({ level: "native_supported", boundChunkIds: ["gd0:c0"] }) })] });
    expect(r.parsedV2!.items.birth_year).toMatchObject({ status: "not_found", findings: [] });
    const params = r.envelope.request.params as any;
    expect(params).toMatchObject({ contract: "v2", mode: "direct_hybrid", thinking: { includeThoughts: false } });
    expect(params.thinking.thinkingLevel === "MINIMAL" || typeof params.thinking.thinkingBudget === "number").toBe(true);   // explicit bounded thinking, never the model default
    await expect(geminiDirect("req", { envelopeId: "gd1", queryName: "Q1", sections, retryMax: 1, reserve: async () => true, call: async () => good })).rejects.toThrow(/needs opts.query/);
  });
  it("openaiDirect matches each finding's source URL to the retrieved-source list and records reasoning.effort", async () => {
    const raw = { ...parseDirectResponse(response), text: v2json("https://www.ncaa.com/jane") };
    const r = await openaiDirect("req", { envelopeId: "od0", queryName: "Q1", query: Q1, sections, retryMax: 1, reserve: async () => true, sleep: async () => {}, call: async () => raw });
    expect(r).toMatchObject({ attempts: 1, completed: true, nativeSources: 2, parsed: null });
    expect(r.parsedV2!.items.full_name!.findings[0].lineage).toMatchObject({ level: "native_retrieved", match: "url_exact", boundChunkIds: ["od0:c0"] });
    expect(r.envelope.request.params).toMatchObject({ contract: "v2", reasoning: { effort: "low" }, include: "web_search_call.action.sources" });
  });
});
