/**
 * dealVoice — pure-function unit tests (no db, no LLM). Covers:
 *  - composeDealVoice() — no opinion (the deal score is gone), money-safe
 *  - resolveSpokenAmount precedence, incl. the never-emit-deals.amount rule
 *  - detectAmountConflict at the 15% boundary
 *  - assertNoUnbackedFigures ($-post-check)
 */

import {
  composeDealVoice,
  resolveSpokenAmount,
  detectAmountConflict,
  assertNoUnbackedFigures,
  type ThreadLike,
  type DealLike,
} from "./dealVoice";

// ── fixture builders ──────────────────────────────────────────────────────────

function thread(over: Partial<ThreadLike> = {}): ThreadLike {
  return { conversation_state: null, summary: null, ...over };
}

/** conversation_state JSONB with the given knobs. */
function convo(over: {
  status?: string | null;
  offer_display?: string | null;
  offer_struct_amount?: number | null;
  amounts?: number[];
  summary?: string | null;
} = {}): ThreadLike["conversation_state"] {
  return {
    conversation_state: over.status ?? null,
    offer_display: over.offer_display ?? null,
    summary: over.summary ?? null,
    key_details: {
      offer_struct: { amount: over.offer_struct_amount ?? null },
      amounts: over.amounts ?? [],
      awaiting_response_from: "athlete",
    },
  };
}

// ── resolveSpokenAmount ───────────────────────────────────────────────────────

describe("resolveSpokenAmount — precedence & money safety", () => {
  it("offer_struct.amount wins over everything", () => {
    const t = thread({
      conversation_state: convo({
        offer_struct_amount: 950,
        amounts: [500],
        offer_display: "$1/yr",
      }),
    });
    expect(resolveSpokenAmount(t)).toBe("$950");
  });

  it("amounts[] renders as a range when there are two", () => {
    const t = thread({ conversation_state: convo({ amounts: [950, 1000] }) });
    expect(resolveSpokenAmount(t)).toBe("$950–$1,000");
  });

  it("amounts[] renders a single value when there is one", () => {
    const t = thread({ conversation_state: convo({ amounts: [1200] }) });
    expect(resolveSpokenAmount(t)).toBe("$1,200");
  });

  it("collapses a two-element range with equal values to a single figure", () => {
    const t = thread({ conversation_state: convo({ amounts: [800, 800] }) });
    expect(resolveSpokenAmount(t)).toBe("$800");
  });

  it("falls back to offer_display verbatim", () => {
    const t = thread({
      conversation_state: convo({ offer_display: "$75/creative · 15% commission" }),
    });
    expect(resolveSpokenAmount(t)).toBe("$75/creative · 15% commission");
  });

  it("returns null when there is no structured figure (caller goes relational)", () => {
    expect(resolveSpokenAmount(thread({ conversation_state: convo({}) }))).toBeNull();
    expect(resolveSpokenAmount(thread())).toBeNull();
  });

  it("NEVER emits a stale deals.amount ($200) when the structured offer is $950–$1,000", () => {
    // The stale snapshot lives on the deal row; the resolver only sees the thread.
    const deal: DealLike = { amount: 200 };
    const t = thread({ conversation_state: convo({ amounts: [950, 1000] }) });

    const spoken = resolveSpokenAmount(t);
    expect(spoken).toBe("$950–$1,000");
    expect(spoken).not.toContain("200");

    // And the full composed voice never leaks $200 either.
    const { line, factLine } = composeDealVoice(deal, thread({
      conversation_state: convo({ status: "They came back with a revised number.", amounts: [950, 1000] }),
    }));
    expect(line).not.toContain("$200");
    expect(line).not.toMatch(/\b200\b/);
    expect(factLine).toBe("On the table: $950–$1,000.");
  });
});

// ── detectAmountConflict ──────────────────────────────────────────────────────

describe("detectAmountConflict — fires strictly above 15%", () => {
  const base = 1000;
  const t = thread({ conversation_state: convo({ offer_struct_amount: base }) });

  it.each([
    [1000, false], // identical
    [1150, false], // exactly +15% → NOT a conflict (strict >)
    [850, false], // exactly −15% → NOT a conflict
    [1151, true], // just over +15%
    [849, true], // just over −15%
    [200, true], // the $200-vs-$1000 stale-snapshot case
    [5000, true],
  ])("deals.amount=$%i → conflict=%s", (dealAmt, expected) => {
    expect(detectAmountConflict({ amount: dealAmt }, t)).toBe(expected);
  });

  it("handles the numeric column arriving as a string", () => {
    expect(detectAmountConflict({ amount: "1151" }, t)).toBe(true);
    expect(detectAmountConflict({ amount: "1000" }, t)).toBe(false);
  });

  it("returns false when either side is missing (nothing to reconcile)", () => {
    expect(detectAmountConflict({ amount: 500 }, thread({ conversation_state: convo({}) }))).toBe(false);
    expect(detectAmountConflict({ amount: null }, t)).toBe(false);
    expect(detectAmountConflict(null, t)).toBe(false);
  });
});

// ── assertNoUnbackedFigures ($-post-check) ────────────────────────────────────

describe("assertNoUnbackedFigures — strips figures not present in a structured field", () => {
  it("keeps a figure that appears verbatim in a structured field", () => {
    const out = assertNoUnbackedFigures("They've offered $950 for the post.", ["$950"]);
    expect(out).toBe("They've offered $950 for the post.");
  });

  it("keeps a figure backed by a raw numeric field (comma-normalized)", () => {
    const out = assertNoUnbackedFigures("They've offered $1,000.", [1000]);
    expect(out).toBe("They've offered $1,000.");
  });

  it("strips an unbacked figure to relational phrasing", () => {
    const out = assertNoUnbackedFigures("I'd counter at $5,000/mo.", ["$950"]);
    expect(out).toBe("I'd counter at their number.");
    expect(out).not.toContain("5,000");
  });

  it("strips a range when only part of it is backed", () => {
    const out = assertNoUnbackedFigures("Counter at $400-500.", ["$400"]);
    expect(out).toBe("Counter at their number.");
  });

  it("keeps a fully-backed range", () => {
    const out = assertNoUnbackedFigures("Counter at $400-500.", [400, 500]);
    expect(out).toBe("Counter at $400-500.");
  });

  it("leaves text with no figures untouched", () => {
    expect(assertNoUnbackedFigures("Let's ask for their budget.", [])).toBe(
      "Let's ask for their budget.",
    );
  });
});

// ── composeDealVoice — no opinion ─────────────────────────────────────────────

describe("composeDealVoice — states the situation, never a verdict", () => {
  const deal: DealLike = { brand_name: "Acme", amount: 200, status: "detected" };

  it("with a conversation_state → the situation, then an offer to look", () => {
    const t = thread({ conversation_state: convo({ status: "Playermaker sent an intro about a partnership." }) });
    const v = composeDealVoice(deal, t);
    expect(v.line).toMatch(/^Playermaker sent an intro/);
    expect(v.line).toMatch(/haven't sized this one up yet/i);
    expect(v.line).not.toMatch(/I'd (counter|accept|decline)/i);
    expect(v.primaryActionLabel).toBe("Take a look");
  });

  it("with no conversation_state → the generic line", () => {
    const v = composeDealVoice(deal, thread());
    expect(v.line).toMatch(/just came in and I haven't sized it up yet/i);
    expect(v.primaryActionLabel).toBe("Take a look");
    expect(v.factLine).toBeNull();
  });

  it("states the structured offer as the fact line", () => {
    const v = composeDealVoice(deal, thread({ conversation_state: convo({ status: "They named a fee.", offer_struct_amount: 750 }) }));
    expect(v.factLine).toBe("On the table: $750.");
  });
});
