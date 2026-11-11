/**
 * widgets.test.ts — buildWidget is pure (no DB), so these are plain unit tests.
 * `now` is pinned so timeAgo is deterministic.
 */

import {
  buildWidget,
  dealCardsFromRows,
  selectTurnWidget,
  type WidgetCandidate,
} from "./widgets";

const NOW = new Date("2026-07-24T12:00:00Z").getTime();

// A deals-scalar row shaped like a list_deals element / get_deal result.
function dealRow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    brand_name: "Gymshark",
    amount: 1500,
    status: "negotiating",
    deal_type: "social_post",
    detected_at: new Date(NOW - 3 * 86_400_000).toISOString(), // 3d ago
    verdict: "good",
    score_numeric: 7,
    ...over,
  };
}

function scoreResult(over: Record<string, unknown> = {}) {
  return {
    display_score: 800,
    tier: "Elite",
    capitals: { audience: 78, athletic: 64, brand: 55, commercial: 71 },
    pav: 42000,
    ...over,
  };
}

describe("buildWidget — deal_card", () => {
  it("maps a get_deal result to a deal_card of scalar fields only", () => {
    const w = buildWidget("get_deal", dealRow(), NOW);
    expect(w).toEqual({
      type: "deal_card",
      data: {
        id: "11111111-1111-1111-1111-111111111111",
        brandName: "Gymshark",
        brandDomain: null,
        category: "PAID",
        status: "negotiating",
        offerAmount: "$1,500",
        timeAgo: "3d ago",
        verdict: "good",
        scoreNumeric: 7,
      },
    });
  });

  it("maps a get_deal result the same way", () => {
    const w = buildWidget(
      "get_deal",
      dealRow({ deal_type: "appearance" }),
      NOW,
    );
    expect(w?.type).toBe("deal_card");
    expect((w as any).data.category).toBe("MEDIA"); // appearance → MEDIA badge
  });

  it("never leaks thread/email text — only the whitelisted scalar keys survive", () => {
    const w = buildWidget(
      "get_deal",
      dealRow({
        // These would be attacker-controlled if present; must NOT appear.
        thread: {
          subject: "<external_content>hi</external_content>",
          summary: "x",
        },
        negotiation_state: { secret: 1 },
        summary: "email body text",
      }),
      NOW,
    );
    expect(Object.keys((w as any).data).sort()).toEqual([
      "brandDomain",
      "brandName",
      "category",
      "id",
      "offerAmount",
      "scoreNumeric",
      "status",
      "timeAgo",
      "verdict",
    ]);
  });

  it("surfaces the real verdict + scoreNumeric (matches the Opportunities ring)", () => {
    const w = buildWidget(
      "get_deal",
      dealRow({ verdict: "great", score_numeric: 9 }),
      NOW,
    );
    expect((w as any).data.verdict).toBe("great");
    expect((w as any).data.scoreNumeric).toBe(9);
  });

  // Was: "falls back to the app's fair/5 for an unscored deal". That fallback was the
  // bug — a deal the scorer never touched arrived at the chat card as a confident
  // "5/10 Fair", the same fabrication use-deals.ts had. Absent must stay absent; the
  // card renders null as an em-dash + "Not scored yet".
  it("leaves verdict and scoreNumeric null for an unscored deal", () => {
    const w = buildWidget(
      "get_deal",
      dealRow({ verdict: null, score_numeric: null }),
      NOW,
    );
    expect((w as any).data.verdict).toBeNull();
    expect((w as any).data.scoreNumeric).toBeNull();
  });

  // An unrecognised non-empty verdict is a real scorer output we can't map — that still
  // coerces to "fair" rather than dropping the assessment entirely.
  it("still coerces an unrecognised verdict string to fair", () => {
    const w = buildWidget(
      "get_deal",
      dealRow({ verdict: "spectacular", score_numeric: 8 }),
      NOW,
    );
    expect((w as any).data.verdict).toBe("fair");
    expect((w as any).data.scoreNumeric).toBe(8);
  });

  it("returns null offerAmount for a missing/zero amount", () => {
    expect(
      (buildWidget("get_deal", dealRow({ amount: 0 }), NOW) as any).data
        .offerAmount,
    ).toBeNull();
    expect(
      (buildWidget("get_deal", dealRow({ amount: null }), NOW) as any).data
        .offerAmount,
    ).toBeNull();
  });

  it("returns null for a null get_deal (not found / not this athlete)", () => {
    expect(buildWidget("get_deal", null, NOW)).toBeNull();
  });
});

describe("buildWidget — deal_list", () => {
  it("maps a list_deals array to a deal_list of deal_card items", () => {
    const w = buildWidget(
      "list_deals",
      [
        dealRow({ id: "d1", brand_name: "Gymshark" }),
        dealRow({ id: "d2", brand_name: "Alo Yoga" }),
      ],
      NOW,
    );
    expect(w?.type).toBe("deal_list");
    const deals = (w as any).data.deals;
    expect(deals).toHaveLength(2);
    // Each item is the SAME scalar projection a single deal_card uses.
    expect(deals[0]).toEqual(
      (
        buildWidget(
          "get_deal",
          dealRow({ id: "d1", brand_name: "Gymshark" }),
          NOW,
        ) as any
      ).data,
    );
  });

  it("preserves list_deals order and binds each card to its OWN brand — never another's", () => {
    // The core per-card isolation guarantee. The client renders these positionally
    // (deals.map → DealCardWidget) and each card's Reply CTA submits its own
    // data.brandName, so proving item i carries row i's brand IS the guarantee
    // that card N's chip can't submit card M's brand.
    const brands = ["Gymshark", "Alo Yoga", "Nike", "Celsius"];
    const rows = brands.map((b, i) => dealRow({ id: `d${i}`, brand_name: b }));
    const deals = (buildWidget("list_deals", rows, NOW) as any).data.deals;
    expect(deals.map((d: any) => d.brandName)).toEqual(brands);
    // Every card holds a distinct, correctly-positioned brand (no cross-wiring).
    deals.forEach((d: any, i: number) => expect(d.brandName).toBe(brands[i]));
  });

  it("caps at 5 items, keeping the first 5 in order", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      dealRow({ id: `d${i}`, brand_name: `Brand ${i}` }),
    );
    const deals = (buildWidget("list_deals", rows, NOW) as any).data.deals;
    expect(deals).toHaveLength(5);
    expect(deals.map((d: any) => d.brandName)).toEqual([
      "Brand 0",
      "Brand 1",
      "Brand 2",
      "Brand 3",
      "Brand 4",
    ]);
  });

  it("skips rows with no id and renders the rest", () => {
    const w = buildWidget(
      "list_deals",
      [dealRow({ id: "ok" }), { brand_name: "No Id" }, dealRow({ id: "ok2" })],
      NOW,
    );
    const deals = (w as any).data.deals;
    expect(deals.map((d: any) => d.id)).toEqual(["ok", "ok2"]);
  });

  it("returns null for an empty list, an all-invalid list, or a non-array", () => {
    expect(buildWidget("list_deals", [], NOW)).toBeNull();
    expect(
      buildWidget("list_deals", [{ brand_name: "No Id" }], NOW),
    ).toBeNull();
    expect(buildWidget("list_deals", { not: "an array" }, NOW)).toBeNull();
  });
});

describe("buildWidget — get_score", () => {
  it("builds no card: the legacy score_breakdown ring is retired (get_score no longer returns capitals)", () => {
    expect(buildWidget("get_score", scoreResult(), NOW)).toBeNull();
    expect(buildWidget("get_score", null, NOW)).toBeNull();
  });
});

// A draft_reply tool result — brand-facing draft + scalars only.
// `has_inbound` mirrors the real tool. The card RE-DERIVES the send gate and
// cannot re-derive a term it was never given — which is exactly how the inbound
// check went missing from the text card. Omitting it here now yields
// sendable:false, by design; see the no-inbound case below.
function replyResult(over: Record<string, unknown> = {}) {
  return {
    deal_id: "33333333-3333-3333-3333-333333333333",
    thread_id: "44444444-4444-4444-4444-444444444444",
    platform: "gmail",
    has_inbound: true,
    sendable: true,
    brand_name: "Gymshark",
    draft:
      "Hi Sarah,\n\nThanks so much — I'd love to explore this.\n\nBest,\nJordan",
    refusal: null,
    reply_intent: "accept",
    style: "friendly",
    voice: "athlete",
    selected_terms: [],
    include_media_kit: false,
    ...over,
  };
}

describe("buildWidget — reply_action", () => {
  it("maps a draft_reply result to a reply_action, keeping the draft as the one free-text field", () => {
    const w = buildWidget("draft_reply", replyResult(), NOW);
    expect(w).toEqual({
      type: "reply_action",
      data: {
        dealId: "33333333-3333-3333-3333-333333333333",
        threadId: "44444444-4444-4444-4444-444444444444",
        platform: "gmail",
        sendable: true,
        brandName: "Gymshark",
        draft:
          "Hi Sarah,\n\nThanks so much — I'd love to explore this.\n\nBest,\nJordan",
        refusal: null,
        params: {
          replyIntent: "accept",
          style: "friendly",
          voice: "athlete",
          selectedTerms: [],
          includeMediaKit: false,
        },
      },
    });
  });

  // Regression (live bug): this builder hand-copied the send gate and left out
  // the INBOUND term, so a thread the brand had never written into rendered
  // "Review & Send". Tapping it hit sendThreadReply's `if (!lastInbound)` → 400
  // "No inbound messages to reply to", surfaced as a generic "couldn't send, try
  // again" that retrying can never fix. Voice kept the term and disagreed about
  // the same deal. Shape taken from live data: the Prime Hydration thread is real
  // and gmail, but all three of its messages are outbound.
  it("refuses Send on a thread with no inbound, however good the draft", () => {
    const w = buildWidget(
      "draft_reply",
      replyResult({ has_inbound: false, sendable: true }),
      NOW,
    );
    expect((w as any).data.sendable).toBe(false);
    // The card still renders — the athlete reads and copies it; it just cannot
    // offer an in-app Send the server would refuse.
    expect((w as any).data.draft).toContain("Thanks so much");
  });

  // A stale producer must fail CLOSED. The old draft_reply result had no
  // has_inbound field at all, and an absent term read as satisfied.
  it("refuses Send when the tool result omits has_inbound entirely", () => {
    const { has_inbound: _omitted, ...legacy } = replyResult();
    const w = buildWidget("draft_reply", legacy, NOW);
    expect((w as any).data.sendable).toBe(false);
  });

  it("recomputes sendable from the gates — never trusts a tool-claimed sendable on Outlook", () => {
    // Even if a result claims sendable:true, Outlook has no send path → false.
    const w = buildWidget(
      "draft_reply",
      replyResult({ platform: "outlook", sendable: true }),
      NOW,
    );
    expect((w as any).data.sendable).toBe(false);
  });

  it("no thread → not sendable, even with a draft", () => {
    const w = buildWidget(
      "draft_reply",
      replyResult({ thread_id: null, sendable: true }),
      NOW,
    );
    expect((w as any).data.sendable).toBe(false);
  });

  it("refusal → a card with no draft and no Send", () => {
    const w = buildWidget(
      "draft_reply",
      replyResult({
        draft: null,
        refusal:
          "Couldn't draft a safe reply — please write this one manually.",
        sendable: false,
      }),
      NOW,
    );
    expect(w?.type).toBe("reply_action");
    expect((w as any).data.draft).toBeNull();
    expect((w as any).data.refusal).toContain("write this one manually");
    expect((w as any).data.sendable).toBe(false);
  });

  it("nothing to render (no draft, no refusal) → no card", () => {
    expect(
      buildWidget(
        "draft_reply",
        replyResult({ draft: null, refusal: null }),
        NOW,
      ),
    ).toBeNull();
  });

  it("a degraded draft_reply { error } result → no card", () => {
    expect(buildWidget("draft_reply", { error: "gen failed" }, NOW)).toBeNull();
  });
});

describe("buildWidget — guards", () => {
  it("never builds a widget from a tool { error } result", () => {
    expect(buildWidget("list_deals", { error: "boom" }, NOW)).toBeNull();
    expect(buildWidget("get_deal", { error: "boom" }, NOW)).toBeNull();
    expect(buildWidget("get_score", { error: "boom" }, NOW)).toBeNull();
  });

  it("returns null for tools that don't surface a widget", () => {
    expect(buildWidget("get_profile", { anything: 1 }, NOW)).toBeNull();
    expect(buildWidget("get_analytics", [1, 2, 3], NOW)).toBeNull();
  });
});

// ─── selectTurnWidget — subject-matched selection (not last-tool-wins) ──────────

const cand = (name: string, result: unknown): WidgetCandidate => ({
  name,
  widget: buildWidget(name, result, NOW)!,
});

const fiveDeals = () => [
  dealRow({ id: "d1", brand_name: "Prime Hydration" }),
  dealRow({ id: "d2", brand_name: "Celsius" }),
  dealRow({ id: "d3", brand_name: "Gymshark" }),
  dealRow({ id: "d4", brand_name: "Alo Yoga" }),
  dealRow({ id: "d5", brand_name: "Nike" }),
];

describe("selectTurnWidget", () => {
  it("returns null when nothing was produced", () => {
    expect(selectTurnWidget([], "any answer", [], "any question")).toBeNull();
  });

  it("'top 3' list question → deal_list of EXACTLY the 3 the prose ranks, in order", () => {
    // The full table has 5; the prose ranks 3. We must render those 3, not all 5.
    const list = cand("list_deals", fiveDeals());
    const answer =
      "Your top 3: Prime Hydration is strongest, then Celsius, then Gymshark.";

    const w = selectTurnWidget(
      [list],
      answer,
      ["list_deals"],
      "show me my top 3",
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list")
      expect(w.data.deals.map((d) => d.brandName)).toEqual([
        "Prime Hydration",
        "Celsius",
        "Gymshark",
      ]);
  });

  it("'show me my top 3 deals' → deal_list of 3, never a single card (even if prose names one)", () => {
    // The exact live string. Prose names only ONE deal — must still render 3.
    const list = cand("list_deals", fiveDeals());
    const answer = "Your standout is Prime Hydration — clearly the strongest.";
    const w = selectTurnWidget(
      [list],
      answer,
      ["list_deals"],
      "show me my top 3 deals",
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list") {
      expect(w.data.deals).toHaveLength(3);
      expect(w.data.deals[0].brandName).toBe("Prime Hydration"); // prose-ranked first
    }
  });

  it("bare 'top 3' → deal_list (list branch), never a single card", () => {
    const list = cand("list_deals", fiveDeals());
    const w = selectTurnWidget(
      [list],
      "Prime Hydration leads.",
      ["list_deals"],
      "top 3",
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list") expect(w.data.deals).toHaveLength(3);
  });

  it("'which deal should I prioritize' → ONE card (the recommended deal), not a list", () => {
    // list_deals + a fan-out of get_deal; the LAST opened is the stray.
    const list = cand("list_deals", [
      dealRow({ id: "d1", brand_name: "Prime Hydration" }),
      dealRow({ id: "d2", brand_name: "Bay Area Smoothie" }),
    ]);
    const prime = cand(
      "get_deal",
      dealRow({ id: "d1", brand_name: "Prime Hydration" }),
    );
    const bay = cand(
      "get_deal",
      dealRow({ id: "d2", brand_name: "Bay Area Smoothie" }),
    );
    const answer =
      "Of these, I'd prioritize the Prime Hydration deal — strongest on money.";

    const w = selectTurnWidget(
      [list, prime, bay],
      answer,
      ["list_deals", "get_deal", "get_deal"],
      "which deal should I prioritize?",
    );
    expect(w?.type).toBe("deal_card");
    if (w?.type === "deal_card")
      expect(w.data.brandName).toBe("Prime Hydration");
  });

  it("plain 'show me my deals' (no N) → deal_list at the default cap", () => {
    const list = cand("list_deals", fiveDeals());
    const w = selectTurnWidget(
      [list],
      "Here are your deals.", // terse prose names none → fall back to the list
      ["list_deals"],
      "show me my deals",
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list") expect(w.data.deals).toHaveLength(5);
  });

  it("a single-deal turn renders that deal's card", () => {
    const foglight = cand(
      "get_deal",
      dealRow({ id: "d1", brand_name: "Foglight" }),
    );
    const w = selectTurnWidget(
      [foglight],
      "Foglight is your best deal.",
      ["get_deal"],
      "what's my best deal?",
    );
    expect(w?.type).toBe("deal_card");
    if (w?.type === "deal_card") expect(w.data.brandName).toBe("Foglight");
  });

  it("an explicit draft_reply action always wins", () => {
    const deal = cand(
      "get_deal",
      dealRow({ id: "d1", brand_name: "Prime Hydration" }),
    );
    const reply = cand("draft_reply", {
      deal_id: "d1",
      brand_name: "Prime Hydration",
      draft: "Hi there —",
      thread_id: "t1",
      platform: "gmail",
    });
    const w = selectTurnWidget(
      [deal, reply],
      "Drafted your reply to Prime.",
      ["get_deal", "draft_reply"],
      "draft a reply to Prime",
    );
    expect(w?.type).toBe("reply_action");
  });

  // ─── model-declared directive (Option A) ─────────────────────────────────

  it("renders the DECLARED deal_list ids in declared order, overriding the heuristic", () => {
    const list = cand("list_deals", fiveDeals()); // d1..d5
    // Question is singular AND prose names only one — the directive still wins.
    const w = selectTurnWidget(
      [list],
      "I'd prioritize Prime Hydration.",
      ["list_deals"],
      "which deal should I prioritize?",
      { widget: "deal_list", ids: ["d3", "d1", "d2"] }, // Gymshark, Prime, Celsius
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list")
      expect(w.data.deals.map((d) => d.brandName)).toEqual([
        "Gymshark",
        "Prime Hydration",
        "Celsius",
      ]);
  });

  it("renders the DECLARED deal_card id", () => {
    const list = cand("list_deals", fiveDeals());
    const w = selectTurnWidget(
      [list],
      "Here are your deals.",
      ["list_deals"],
      "show me my deals",
      { widget: "deal_card", ids: ["d2"] },
    );
    expect(w?.type).toBe("deal_card");
    if (w?.type === "deal_card") expect(w.data.brandName).toBe("Celsius");
  });

  it("a DECLARED score card falls back to the heuristic (no score card exists)", () => {
    const deal = cand("get_deal", dealRow({ id: "d1", brand_name: "Prime Hydration" }));
    const w = selectTurnWidget(
      [deal],
      "Prime Hydration is your best bet.",
      ["get_deal", "get_score"],
      "what's my score?",
      { widget: "score", ids: [] },
    );
    expect(w?.type).toBe("deal_card");
  });

  it("draft_reply still wins even when a deal directive is declared", () => {
    const reply = cand("draft_reply", {
      deal_id: "d1",
      brand_name: "Prime Hydration",
      draft: "Hi there —",
      thread_id: "t1",
      platform: "gmail",
    });
    const deal = cand("get_deal", dealRow({ id: "d2", brand_name: "Celsius" }));
    const w = selectTurnWidget(
      [reply, deal],
      "Drafted your reply.",
      ["draft_reply", "get_deal"],
      "reply to Prime",
      { widget: "deal_card", ids: ["d2"] },
    );
    expect(w?.type).toBe("reply_action");
  });

  it("drops declared ids not in the pool, keeping only valid ones (tenancy-safe)", () => {
    const list = cand("list_deals", [
      dealRow({ id: "d1", brand_name: "Prime Hydration" }),
      dealRow({ id: "d2", brand_name: "Celsius" }),
      dealRow({ id: "d3", brand_name: "Gymshark" }),
    ]);
    const w = selectTurnWidget(
      [list],
      "top deals",
      ["list_deals"],
      "show me my top 3",
      { widget: "deal_list", ids: ["d3", "not-in-pool", "d1"] },
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list")
      expect(w.data.deals.map((d) => d.brandName)).toEqual([
        "Gymshark",
        "Prime Hydration",
      ]);
  });

  it("falls back to the heuristic when NO declared id is in the pool", () => {
    const list = cand("list_deals", [
      dealRow({ id: "d1", brand_name: "Prime Hydration" }),
      dealRow({ id: "d2", brand_name: "Celsius" }),
    ]);
    const w = selectTurnWidget(
      [list],
      "Here are your deals.",
      ["list_deals"],
      "show me my deals",
      { widget: "deal_list", ids: ["hallucinated-1", "hallucinated-2"] },
    );
    // Directive unusable → heuristic list path still renders from the pool.
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list")
      expect(w.data.deals.map((d) => d.brandName)).toEqual([
        "Prime Hydration",
        "Celsius",
      ]);
  });

  // ─── declared-id pool from list rows (over-fetch fix regression) ───────────
  // The over-fetch fix makes Mila rank from ONE list_deals and deep-dive only 1-2
  // deals, so a declared deal_list names deals she never get_deal'd. Those must
  // still render — the pool carries card data for every listed deal.
  const sixDeals = () => [
    dealRow({ id: "d1", brand_name: "Prime Hydration" }),
    dealRow({ id: "d2", brand_name: "Celsius" }),
    dealRow({ id: "d3", brand_name: "Gymshark" }),
    dealRow({ id: "d4", brand_name: "Alo Yoga" }),
    dealRow({ id: "d5", brand_name: "Nike" }),
    dealRow({ id: "d6", brand_name: "Adidas" }),
  ];

  it("declared deal_list renders deals named from the list but never get_deal'd", () => {
    // Only ONE deep-dive (get_deal d1), but the athlete asked for 5 — the other 4
    // come from the list pool, not from opening each deal.
    const list = cand("list_deals", sixDeals());
    const d1 = cand(
      "get_deal",
      dealRow({ id: "d1", brand_name: "Prime Hydration" }),
    );
    const w = selectTurnWidget(
      [list, d1],
      "Here are your five deals.",
      ["list_deals", "get_deal"],
      "show me my 5 deals",
      { widget: "deal_list", ids: ["d1", "d2", "d3", "d4", "d5"] },
      dealCardsFromRows(sixDeals(), NOW),
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list")
      expect(w.data.deals.map((d) => d.brandName)).toEqual([
        "Prime Hydration",
        "Celsius",
        "Gymshark",
        "Alo Yoga",
        "Nike",
      ]);
  });

  it("declared id past the rendered DEAL_LIST_MAX still resolves from the pool", () => {
    // d6 is the 6th list row — dropped by the deal_list widget's 5-cap, but present
    // in the uncapped pool, so a directive naming it renders it.
    const list = cand("list_deals", sixDeals());
    const w = selectTurnWidget(
      [list],
      "Prime and Adidas are your two best fits.",
      ["list_deals"],
      "which two deals fit me best?",
      { widget: "deal_list", ids: ["d1", "d6"] },
      dealCardsFromRows(sixDeals(), NOW),
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list")
      expect(w.data.deals.map((d) => d.brandName)).toEqual([
        "Prime Hydration",
        "Adidas",
      ]);
  });

  it("a declared deal_list still renders at most DEAL_LIST_MAX cards", () => {
    const list = cand("list_deals", sixDeals());
    const w = selectTurnWidget(
      [list],
      "All six.",
      ["list_deals"],
      "show me all my deals",
      { widget: "deal_list", ids: ["d1", "d2", "d3", "d4", "d5", "d6"] },
      dealCardsFromRows(sixDeals(), NOW),
    );
    expect(w?.type).toBe("deal_list");
    if (w?.type === "deal_list") expect(w.data.deals).toHaveLength(5);
  });

  it("single-deal question still renders ONE card despite a full pool", () => {
    const list = cand("list_deals", sixDeals());
    const d1 = cand(
      "get_deal",
      dealRow({ id: "d1", brand_name: "Prime Hydration" }),
    );
    const w = selectTurnWidget(
      [list, d1],
      "I'd prioritize Prime Hydration.",
      ["list_deals", "get_deal"],
      "which deal should I prioritize?",
      { widget: "deal_card", ids: ["d1"] },
      dealCardsFromRows(sixDeals(), NOW),
    );
    expect(w?.type).toBe("deal_card");
    if (w?.type === "deal_card")
      expect(w.data.brandName).toBe("Prime Hydration");
  });
});
