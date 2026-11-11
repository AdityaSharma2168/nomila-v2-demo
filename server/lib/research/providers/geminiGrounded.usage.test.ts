/** geminiGrounded.groundedSearch — retry usage accounting: every attempt is billed, so tokens are summed; a thrown attempt marks the sum incomplete. No network. */

import { describe, expect, it } from "@jest/globals";
import { groundedSearch, type GeminiGroundingRaw } from "./geminiGrounded";

const ok: GeminiGroundingRaw = { text: "Jane Doe plays.", groundingChunks: [{ uri: "https://a.example/x", title: "t", domain: "a.example" }], groundingSupports: [], webSearchQueries: [], promptTokens: 500, candidateTokens: 300 };
const empty: GeminiGroundingRaw = { text: "", groundingChunks: [], groundingSupports: [], webSearchQueries: [], finishReason: "STOP", promptTokens: 400, candidateTokens: 10 };

describe("groundedSearch usage across retries", () => {
  it("sums prompt and candidate tokens over every attempt and reports the attempt count", async () => {
    let n = 0;
    const r = await groundedSearch("q", { envelopeId: "g0", queryName: "Profile + Social", retryMax: 2, reserve: async () => true, sleep: async () => {}, call: async () => (++n < 3 ? empty : ok) });
    expect(r).toMatchObject({ attempts: 3, completed: true });
    expect(r.envelope.usage).toMatchObject({ promptTokens: 1300, completionTokens: 320, calls: 3 });
    expect(r.envelope.usage?.usageIncomplete).toBeUndefined();
  });

  it("flags the sum as incomplete when an attempt threw before returning usage", async () => {
    let n = 0;
    const r = await groundedSearch("q", { envelopeId: "g0", queryName: "Profile + Social", retryMax: 1, reserve: async () => true, sleep: async () => {}, call: async () => { if (++n === 1) throw new Error("503"); return ok; } });
    expect(r.envelope.usage).toMatchObject({ promptTokens: 500, completionTokens: 300, calls: 2, usageIncomplete: true });
  });

  it("keeps the single-attempt case unchanged", async () => {
    const r = await groundedSearch("q", { envelopeId: "g0", queryName: "Profile + Social", retryMax: 2, reserve: async () => true, sleep: async () => {}, call: async () => ok });
    expect(r.envelope.usage).toEqual({ promptTokens: 500, completionTokens: 300, calls: 1, latencyMs: expect.any(Number) });
  });
});
