/**
 * weekLogic — pure-function unit tests (no React, no RN, no network).
 * Covers The Week's receipt core:
 *   - buildReceipt: set-aside itemization, undo eligibility, empty-receipt state
 *   - track-record % (reopened / filed)
 *   - formatHoldRemaining: the 24h auto-decline hold countdown (undo-window framing)
 *   - categorizeDeal / sectionDeals: the Arrived / You moved / Still waiting split
 *   - buildTheBar: the 0-"great" → "held your line at $X" reframe
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/week
 */

import {
  buildReceipt,
  buildTheBar,
  categorizeDeal,
  sectionDeals,
  formatHoldRemaining,
  greatCount,
  highestOffer,
  parseMoney,
  formatMoney,
  weekIsQuiet,
  RECAP_WINDOW_MS,
} from "./weekLogic";
import type { AgentActionRow } from "../../../hooks/use-agent-actions";
import type { DealItem } from "../DealCard";

const NOW = Date.UTC(2026, 6, 25); // fixed clock
const daysAgoISO  = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
const hoursFromNowISO = (n: number) => new Date(NOW + n * 60 * 60 * 1000).toISOString();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function action(over: Partial<AgentActionRow> = {}): AgentActionRow {
  return {
    id:         "a1",
    athlete_id: "ath1",
    action:     "file",
    deal_id:    "d1",
    thread_id:  "t1",
    reason:     null,
    reversible: true,
    held_until: null,
    undone_at:  null,
    payload:    null,
    result:     null,
    created_at: daysAgoISO(2),
    ...over,
  };
}

function deal(over: Partial<DealItem> = {}): DealItem {
  return {
    id:         "d1",
    brandName:  "Playermaker",
    category:   "PAID",
    status:     "detected",
    verdict:    "good",
    source:     "gmail",
    sourceType: "Email",
    score:      7,
    timeAgo:    "2d ago",
    aiSummary:  "They want a launch post.",
    detectedAt: daysAgoISO(2),
    ...over,
  };
}

// ─── buildReceipt — set aside + empty state ─────────────────────────────────────

describe("buildReceipt — set aside by Nomila", () => {
  it("itemizes file + auto_decline rows, newest first", () => {
    const rows = [
      action({ id: "old", action: "file",         created_at: daysAgoISO(3) }),
      action({ id: "new", action: "auto_decline", created_at: daysAgoISO(1) }),
    ];
    const r = buildReceipt(rows, NOW);
    expect(r.setAside.map((s) => s.id)).toEqual(["new", "old"]);
    expect(r.isEmpty).toBe(false);
  });

  it("excludes an already-undone filing from the set-aside list", () => {
    const rows = [action({ id: "u", undone_at: daysAgoISO(1) })];
    const r = buildReceipt(rows, NOW);
    expect(r.setAside).toHaveLength(0);
  });

  it("only offers Undo for a reversible, not-yet-undone action", () => {
    const rows = [
      action({ id: "rev", reversible: true }),
      action({ id: "fixed", reversible: false }),
    ];
    const r = buildReceipt(rows, NOW);
    expect(r.setAside.find((s) => s.id === "rev")?.undoable).toBe(true);
    expect(r.setAside.find((s) => s.id === "fixed")?.undoable).toBe(false);
  });

  it("never lists her own act as Nomila's: a receipt marked actor athlete is hers", () => {
    const rows = [
      action({ id: "hers", action: "file", payload: { actor: "athlete" } }),
      action({ id: "nomila", action: "file" }),
    ];
    const r = buildReceipt(rows, NOW);
    expect(r.setAside.map((s) => s.id)).toEqual(["nomila"]);
    expect(r.trackRecord?.filed).toBe(1);
  });

  it("ignores non-set-aside kinds (reclassify / mute / reopen) in the list", () => {
    const rows = [
      action({ id: "rc", action: "reclassify" }),
      action({ id: "mt", action: "mute_sender" }),
    ];
    const r = buildReceipt(rows, NOW);
    expect(r.setAside).toHaveLength(0);
  });

  it("uses a payload brand label but never fabricates one", () => {
    const withBrand = buildReceipt([action({ payload: { brand_name: "Hisense" } })], NOW);
    expect(withBrand.setAside[0].subject).toBe("Hisense");
    const noBrand = buildReceipt([action({ payload: null, deal_id: "d9" })], NOW);
    expect(noBrand.setAside[0].subject).toBe("a deal");
  });
});

describe("buildReceipt — empty receipt (ISSUE-9: no writers wired yet)", () => {
  it("renders a calm empty state for an empty feed", () => {
    for (const feed of [undefined, null, [] as AgentActionRow[]]) {
      const r = buildReceipt(feed, NOW);
      expect(r.isEmpty).toBe(true);
      expect(r.setAside).toHaveLength(0);
      expect(r.trackRecord).toBeNull();
    }
  });
});

// ─── Track record ───────────────────────────────────────────────────────────────

describe("buildReceipt — track record (reopened / filed)", () => {
  it("computes 'reopened 2 of 214 · 99.1%'", () => {
    const rows: AgentActionRow[] = [];
    for (let i = 0; i < 214; i++) {
      rows.push(action({ id: `f${i}`, action: "file", undone_at: i < 2 ? daysAgoISO(1) : null }));
    }
    const r = buildReceipt(rows, NOW);
    expect(r.trackRecord).toEqual({ filed: 214, reopened: 2, pct: "99.1" });
  });

  it("is a perfect 100.0 when nothing was reopened", () => {
    const r = buildReceipt([action(), action({ id: "b" })], NOW);
    expect(r.trackRecord?.pct).toBe("100.0");
    expect(r.trackRecord?.reopened).toBe(0);
  });

  it("counts undone filings even when they've dropped off the visible list", () => {
    const rows = [action({ id: "1", undone_at: daysAgoISO(1) }), action({ id: "2" })];
    const r = buildReceipt(rows, NOW);
    expect(r.trackRecord).toEqual({ filed: 2, reopened: 1, pct: "50.0" });
    expect(r.setAside.map((s) => s.id)).toEqual(["2"]); // undone one hidden from list
  });
});

// ─── 24-hour hold countdown ─────────────────────────────────────────────────────

describe("formatHoldRemaining — the auto-decline hold", () => {
  it("returns null when there is no hold", () => {
    expect(formatHoldRemaining(null, NOW)).toBeNull();
    expect(formatHoldRemaining(undefined, NOW)).toBeNull();
    expect(formatHoldRemaining("not-a-date", NOW)).toBeNull();
  });

  it("frames the remaining time as a window to UNDO (never 'sends in …')", () => {
    const h = formatHoldRemaining(hoursFromNowISO(6), NOW);
    expect(h).toEqual({ label: "6h left to undo", expired: false });
    expect(h!.label).not.toMatch(/send/i);
  });

  it("shows hours + minutes when there's a partial hour", () => {
    const until = new Date(NOW + (6 * 60 + 14) * 60 * 1000).toISOString();
    expect(formatHoldRemaining(until, NOW)?.label).toBe("6h 14m left to undo");
  });

  it("shows minutes only under an hour", () => {
    const until = new Date(NOW + 45 * 60 * 1000).toISOString();
    expect(formatHoldRemaining(until, NOW)?.label).toBe("45m left to undo");
  });

  it("marks an elapsed hold as expired", () => {
    const h = formatHoldRemaining(hoursFromNowISO(-1), NOW);
    expect(h?.expired).toBe(true);
  });

  it("wires the hold onto an auto_decline set-aside line", () => {
    const r = buildReceipt([action({ action: "auto_decline", held_until: hoursFromNowISO(12) })], NOW);
    expect(r.setAside[0].hold?.label).toBe("12h left to undo");
    // a plain filing carries no hold
    const f = buildReceipt([action({ action: "file", held_until: hoursFromNowISO(12) })], NOW);
    expect(f.setAside[0].hold).toBeNull();
  });
});

// ─── Deal-derived sections ──────────────────────────────────────────────────────

describe("categorizeDeal — Arrived / You moved / Still waiting", () => {
  it("a fresh, your-turn deal → Arrived", () => {
    expect(categorizeDeal(deal({ detectedAt: daysAgoISO(1) }), NOW)).toBe("arrived");
  });
  it("brand's turn, recent → You moved (you just replied)", () => {
    expect(categorizeDeal(deal({ awaitingResponseFrom: "brand", detectedAt: daysAgoISO(2) }), NOW)).toBe("youMoved");
  });
  it("brand's turn, stale → Still waiting (they've gone quiet)", () => {
    expect(categorizeDeal(deal({ awaitingResponseFrom: "brand", detectedAt: daysAgoISO(45) }), NOW)).toBe("stillWaiting");
  });
  it("accepted / completed → You moved (you closed it)", () => {
    expect(categorizeDeal(deal({ status: "accepted" }), NOW)).toBe("youMoved");
    expect(categorizeDeal(deal({ status: "completed" }), NOW)).toBe("youMoved");
  });
  it("rejected → not in the motion sections (it's a pass)", () => {
    expect(categorizeDeal(deal({ status: "rejected" }), NOW)).toBeNull();
  });
  it("your-turn but stale → not in this week's receipt", () => {
    expect(categorizeDeal(deal({ detectedAt: daysAgoISO(45) }), NOW)).toBeNull();
  });
  it("the week boundary is inclusive", () => {
    const atEdge = new Date(NOW - RECAP_WINDOW_MS).toISOString();
    expect(categorizeDeal(deal({ detectedAt: atEdge }), NOW)).toBe("arrived");
  });
});

describe("sectionDeals", () => {
  it("splits and sorts each section most-recent first", () => {
    const deals = [
      deal({ id: "a1", detectedAt: daysAgoISO(3) }),                               // arrived
      deal({ id: "a2", detectedAt: daysAgoISO(1) }),                               // arrived (newer)
      deal({ id: "m1", status: "accepted" }),                                      // youMoved
      deal({ id: "w1", awaitingResponseFrom: "brand", detectedAt: daysAgoISO(45) }), // stillWaiting
    ];
    const s = sectionDeals(deals, NOW);
    expect(s.arrived.map((d) => d.id)).toEqual(["a2", "a1"]);
    expect(s.youMoved.map((d) => d.id)).toEqual(["m1"]);
    expect(s.stillWaiting.map((d) => d.id)).toEqual(["w1"]);
  });
});

// ─── The Bar ────────────────────────────────────────────────────────────────────

describe("buildTheBar — the 0-'great' reframe", () => {
  it("reframes a 0-great week as 'held your line at $835'", () => {
    const bar = buildTheBar(835, 0);
    expect(bar.amount).toBe("$835");
    expect(bar.line).toContain("Held your line at $835");
    expect(bar.line.toLowerCase()).toContain("cleared it");
    expect(bar.inferred).toBe(false);
  });

  it("acknowledges offers that DID clear the bar", () => {
    const bar = buildTheBar(835, 2);
    expect(bar.line).toContain("2 offers cleared it");
  });

  it("singularizes one cleared offer", () => {
    expect(buildTheBar(835, 1).line).toContain("1 offer cleared it");
  });

  it("falls back to an inferred line when no floor is set, and flags it", () => {
    const bar = buildTheBar(null, 0, 1200);
    expect(bar.amount).toBe("$1,200");
    expect(bar.inferred).toBe(true);
    expect(bar.line.toLowerCase()).toContain("around $1,200");
  });

  it("invites the athlete to set a floor when there's nothing to hold", () => {
    const bar = buildTheBar(null, 0, null);
    expect(bar.amount).toBeNull();
    expect(bar.line.toLowerCase()).toContain("set a floor");
  });

  it("never claims we declined anything on her behalf", () => {
    expect(buildTheBar(835, 0).line.toLowerCase()).not.toMatch(/declined|rejected|sent/);
  });
});

// ─── Small money helpers ────────────────────────────────────────────────────────

describe("money helpers", () => {
  it("parseMoney strips symbols and commas", () => {
    expect(parseMoney("$2,000")).toBe(2000);
    expect(parseMoney(835)).toBe(835);
    expect(parseMoney("product only")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
  it("formatMoney renders whole dollars", () => {
    expect(formatMoney(835)).toBe("$835");
    expect(formatMoney(1108)).toBe("$1,108");
  });
  it("highestOffer picks the biggest number across deals", () => {
    const deals = [deal({ offerDisplay: "$2,000" }), deal({ id: "d2", offerAmount: "$5,000" }), deal({ id: "d3" })];
    expect(highestOffer(deals)).toBe(5000);
  });
  it("greatCount counts 'great'-verdict deals", () => {
    expect(greatCount([deal({ verdict: "great" }), deal({ id: "x", verdict: "good" })])).toBe(1);
  });
});

// ─── Fully-quiet week ───────────────────────────────────────────────────────────

describe("weekIsQuiet", () => {
  it("true only when both the receipt and every deal section are empty", () => {
    const receipt  = buildReceipt([], NOW);
    const empty    = sectionDeals([], NOW);
    expect(weekIsQuiet(receipt, empty)).toBe(true);

    const withDeal = sectionDeals([deal({ detectedAt: daysAgoISO(1) })], NOW);
    expect(weekIsQuiet(receipt, withDeal)).toBe(false);
  });
});
