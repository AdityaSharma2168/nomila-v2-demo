/**
 * lineage.test.ts — cited / uncited / conflicting (design §3.2, R5). The URL of an evidence row
 * can only ever come from the cited chunk.
 */

import { validateCitation } from "./lineage";
import type { SearchEnvelope } from "./providers";

const env: SearchEnvelope = {
  id: "g0", provider: "gemini_grounded", queryName: "profile", query: "q", fetchedAt: "2026-09-11T00:00:00.000Z",
  answerText: "Mia Bhuta plays midfield for Stanford. She was named All-ACC First Team in 2025. She is from Pittsburgh.",
  chunks: [
    { id: "g0:c0", url: "https://gostanford.com/sports/womens-soccer/roster/mia-bhuta", domain: "gostanford.com", title: "Roster", text: "Mia Bhuta plays midfield for Stanford.", textKind: "provider_answer_segments" },
    { id: "g0:c1", url: "https://theacc.com/news/all-acc-2025", domain: "theacc.com", title: "All-ACC", text: "She was named All-ACC First Team in 2025.", textKind: "provider_answer_segments" },
    { id: "g0:c2", url: "https://example-blog.com/post", domain: "example-blog.com", title: "Blog", text: "", textKind: "provider_answer_segments" },
  ],
  supports: [
    { id: "g0:s0", chunkIds: ["g0:c0"], text: "Mia Bhuta plays midfield for Stanford." },
    { id: "g0:s1", chunkIds: ["g0:c1"], text: "She was named All-ACC First Team in 2025." },
  ],
  raw: null, request: {}, errors: [],
};

describe("validateCitation", () => {
  it("cited: the quote occurs in the cited chunk; url and domain come from that chunk", () => {
    const r = validateCitation({ chunkIds: ["g0:c1"], quote: "named All-ACC First Team in 2025" }, [env]);
    expect(r.status).toBe("cited");
    expect(r.chunk?.url).toBe("https://theacc.com/news/all-acc-2025");
    expect(r.chunk?.domain).toBe("theacc.com");
    expect(r.supports.map((s) => s.id)).toEqual(["g0:s1"]);
    expect(r.quoteKind).toBe("provider_answer");   // grounding text is the provider's answer, not a page excerpt
  });
  it("a chunk that holds real page text yields quoteKind source_excerpt", () => {
    const page = { ...env, chunks: [{ ...env.chunks[0], textKind: "source_excerpt" as const }] };
    expect(validateCitation({ chunkIds: ["g0:c0"], quote: "plays midfield for Stanford" }, [page]).quoteKind).toBe("source_excerpt");
  });
  it("cited is whitespace- and case-insensitive", () => {
    expect(validateCitation({ chunkIds: ["g0:c0"], quote: "  plays MIDFIELD   for Stanford" }, [env]).status).toBe("cited");
  });
  it("conflicting: the quote is in the answer but the provider supports it with a different chunk", () => {
    const r = validateCitation({ chunkIds: ["g0:c0"], quote: "All-ACC First Team in 2025" }, [env]);
    expect(r.status).toBe("conflicting");
    expect(r.chunk).toBeNull();
    expect(r.reason).toMatch(/supported by chunks g0:c1/);
  });
  it("uncited: no citation, no quote, unknown chunk, quote not found, quote in the answer with no support, quote too long", () => {
    expect(validateCitation(null, [env]).status).toBe("uncited");
    expect(validateCitation({ chunkIds: ["g0:c0"], quote: "" }, [env]).status).toBe("uncited");
    expect(validateCitation({ chunkIds: ["g9:c0"], quote: "plays midfield" }, [env])).toMatchObject({ status: "uncited", reason: "unknown chunk id", chunk: null });
    expect(validateCitation({ chunkIds: ["g0:c0"], quote: "won the Ballon d'Or" }, [env]).status).toBe("uncited");
    expect(validateCitation({ chunkIds: ["g0:c2"], quote: "She is from Pittsburgh." }, [env])).toMatchObject({ status: "uncited", reason: expect.stringContaining("no provider support") });
    expect(validateCitation({ chunkIds: ["g0:c0"], quote: "x".repeat(301) }, [env]).status).toBe("uncited");
  });
  it("never returns a url for anything but a cited claim", () => {
    for (const c of [null, { chunkIds: ["g0:c0"], quote: "All-ACC First Team in 2025" }, { chunkIds: ["g0:c2"], quote: "She is from Pittsburgh." }]) expect(validateCitation(c as any, [env]).chunk).toBeNull();
  });
});
