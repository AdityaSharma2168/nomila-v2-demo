/**
 * workflow.test.ts — the research_v2_shadow step end to end on the one search provider (OpenAI web search): the real
 * shadowStep → runNarrowResearch → openaiDiscover → our fetcher → extract (runSkill). Every outside call is mocked:
 * the structured model call, the page fetches, the store and the athlete reads. No test reaches a provider.
 */
import { createMemoryStore } from "../store";

const mockStore = createMemoryStore();
jest.mock("../dbStore", () => ({ dbStore: mockStore }));
jest.mock("../connected", () => ({ loadConnectedChannels: async () => [] }));
jest.mock("../../../services/intelligence/context/legacyAdapter", () => ({ readLegacyRow: async () => ({ school: "Example University" }) }));

const callStructuredMock = jest.fn();
jest.mock("../llm", () => ({ ...jest.requireActual("../llm"), callStructured: (...a: unknown[]) => callStructuredMock(...a) }));

import { shadowStep } from "./workflow";

const ROSTER = "https://team.example.edu/riley";
const para = (s: string) => Array.from({ length: 6 }, () => s).join(" ");
const PAGE = `<html><head><title>Roster</title></head><body><article><h1>Riley Example</h1><p>${para("Riley Example scored twice for the Example University soccer team in the final and was named captain.")}</p></article></body></html>`;
const cost = (microUsd: number, webSearchCalls = 0) => ({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, webSearchCalls, microUsd });

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  callStructuredMock.mockReset();
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation((async (u: any) =>
    String(u).endsWith("robots.txt") ? new Response("", { status: 404 }) : new Response(PAGE, { headers: { "content-type": "text/html" } })) as any);
});
afterEach(() => fetchSpy.mockRestore());

test("the shadow runs end to end on OpenAI discovery: provider recorded, the page the search saw read, a fact kept", async () => {
  callStructuredMock.mockImplementation(async (req: any) => {
    if (req.skill.id === "research/v2-discover") {
      return { json: { pages: [] }, text: "", queries: [req.input], sources: [{ url: ROSTER, title: "Roster" }], cost: cost(11_000, 1), status: "completed", responseId: null, usage: {}, durationMs: 1 };
    }
    return {
      json: { identity: { resolved: true, description: "", ambiguity: "", candidates: [] }, gaps: [], narrative: "", facts: [
        { claim: "Riley Example was named captain.", topic: "team", source_url: ROSTER, source_title: "Roster", source_type: "official", date: "2026", confidence: 0.9, subject_kind: "athlete", subject_name: "Riley Example", sensitivity: "none", never_reason: "none", care_kind: "none" },
      ] },
      text: "", queries: [], sources: [], cost: cost(50_000), status: "completed", responseId: null, usage: {}, durationMs: 1,
    };
  });
  const out = await shadowStep({ athleteId: "a1", runId: "run1", runInput: { name: "Riley Example", sport: "soccer", signup_run_id: "s1" } } as any);

  const discoverCalls = callStructuredMock.mock.calls.filter(([r]) => r.skill.id === "research/v2-discover");
  expect(discoverCalls.length).toBeGreaterThan(0);
  for (const [r] of discoverCalls) {
    expect(r.model.provider).toBe("openai");
    expect(r.webSearch).toEqual({ maxCalls: 1, contextSize: "low" });
  }
  expect(out.provider).toBe("openai_search");
  expect(out.signup_run_id).toBe("s1");
  expect(out.sources).toEqual([ROSTER]);
  expect(out.facts.map((f) => f.claim)).toEqual(["Riley Example was named captain."]);
  expect(out.metrics.outcome).toBe("confirmed");
  expect(out.metrics.costMicroUsd.discover).toBe(discoverCalls.length * 11_000);
  // Nothing went anywhere but the mocks: every fetch was our fetcher reading the one page the search saw.
  for (const [u] of fetchSpy.mock.calls) expect(String(u)).toMatch(/^https:\/\/team\.example\.edu\//);
});
