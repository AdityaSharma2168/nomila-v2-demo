/**
 * navChips tests — pure, no DB. Covers the tool→chip mapping, the no-thread and
 * error/null degradations, tools that intentionally emit no chip, and dedupe+cap.
 */

import { buildNavChip, dedupeNavChips, NAV_CHIP_MAX } from "./navChips";
import type { MilaNavChip } from "./types";

describe("buildNavChip", () => {
  it("opens the exact deal when get_deal has a linked thread", () => {
    const chip = buildNavChip("get_deal", {
      id: "deal-1",
      brand_name: "Nike",
      thread_id: "thread-9",
    });
    expect(chip).toEqual({
      label: "Open this deal",
      target: { screen: "deal", threadId: "thread-9", brandName: "Nike" },
    });
  });

  it("falls back to the deals list when the deal has no thread", () => {
    const chip = buildNavChip("get_deal", {
      id: "deal-1",
      brand_name: "Adidas",
      thread_id: null,
    });
    expect(chip).toEqual({
      label: "See all my deals",
      target: { screen: "deals" },
    });
  });

  it("omits brandName when the deal row has none", () => {
    const chip = buildNavChip("get_deal", { id: "deal-1", thread_id: "t-1" });
    expect(chip?.target).toEqual({ screen: "deal", threadId: "t-1" });
  });

  it("returns null when get_deal found nothing (no id)", () => {
    expect(buildNavChip("get_deal", null)).toBeNull();
    expect(buildNavChip("get_deal", {})).toBeNull();
  });

  it("chips list_deals only as an OVERFLOW affordance (>5 rows returned)", () => {
    // list_deals now renders up to 5 rows inline as a deal_list, so the chip is
    // redundant clutter at ≤5 (every deal is a card above) and useful only when
    // there are more deals than the 5 shown.
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}` }));
    expect(buildNavChip("list_deals", rows(6))?.target).toEqual({
      screen: "deals",
    });
    expect(buildNavChip("list_deals", rows(5))).toBeNull(); // all shown → no chip
    expect(buildNavChip("list_deals", rows(1))).toBeNull();
    expect(buildNavChip("list_deals", [])).toBeNull();
    expect(buildNavChip("list_deals", { deals: [] })).toBeNull(); // non-array → no chip
  });

  it("maps get_score → score", () => {
    expect(buildNavChip("get_score", { display_score: 512 })?.target).toEqual({
      screen: "score",
    });
  });

  it("maps get_profile → profile", () => {
    expect(buildNavChip("get_profile", { full_name: "A" })?.target).toEqual({
      screen: "profile",
    });
  });

  it("never chips an { error } result", () => {
    expect(buildNavChip("get_deal", { error: "boom" })).toBeNull();
    expect(buildNavChip("get_score", { error: "boom" })).toBeNull();
  });

  it("emits no chip for tools with an ambiguous destination", () => {
    expect(buildNavChip("get_rate_card", { post: 500 })).toBeNull();
    expect(buildNavChip("get_analytics", { followers: 12000 })).toBeNull();
    expect(buildNavChip("list_tasks_threads", { threads: [] })).toBeNull();
    expect(buildNavChip("something_new", { ok: true })).toBeNull();
  });
});

describe("dedupeNavChips", () => {
  it("drops duplicate targets, keeping the first", () => {
    const chips: MilaNavChip[] = [
      { label: "Open this deal", target: { screen: "deal", threadId: "t-1" } },
      { label: "See all my deals", target: { screen: "deals" } },
      { label: "See all my deals", target: { screen: "deals" } },
    ];
    const out = dedupeNavChips(chips);
    expect(out).toHaveLength(2);
    expect(out[0].target).toEqual({ screen: "deal", threadId: "t-1" });
    expect(out[1].target).toEqual({ screen: "deals" });
  });

  it("treats different threadIds as distinct deal targets", () => {
    const chips: MilaNavChip[] = [
      { label: "Open this deal", target: { screen: "deal", threadId: "t-1" } },
      { label: "Open this deal", target: { screen: "deal", threadId: "t-2" } },
    ];
    expect(dedupeNavChips(chips)).toHaveLength(2);
  });

  it(`caps at NAV_CHIP_MAX (${NAV_CHIP_MAX})`, () => {
    const chips: MilaNavChip[] = [
      { label: "a", target: { screen: "deals" } },
      { label: "b", target: { screen: "score" } },
      { label: "c", target: { screen: "profile" } },
      { label: "d", target: { screen: "studio" } },
    ];
    expect(dedupeNavChips(chips)).toHaveLength(NAV_CHIP_MAX);
  });
});

describe("buildNavChip — navigate", () => {
  const WIRED = [
    "deals",
    "score",
    "signals",
    "profile",
    "studio",
    "pitches",
    "media",
    "deck",
    "rates",
    "facts",
    "story",
  ] as const;

  it("emits a chip to each wired screen the navigate tool resolved", () => {
    for (const screen of WIRED) {
      const chip = buildNavChip("navigate", { navigated: true, screen });
      expect(chip?.target).toEqual({ screen });
      expect(typeof chip?.label).toBe("string");
      expect(chip?.label.length).toBeGreaterThan(0);
    }
  });

  it("returns null when navigate resolved nothing", () => {
    expect(buildNavChip("navigate", { navigated: false })).toBeNull();
    expect(buildNavChip("navigate", {})).toBeNull();
  });

  it("never emits a `deal` (id-bearing) or unknown target — never a broken chip", () => {
    // navigate carries no threadId, so a `deal` screen would be a broken Thread nav.
    expect(
      buildNavChip("navigate", { navigated: true, screen: "deal" }),
    ).toBeNull();
    expect(
      buildNavChip("navigate", { navigated: true, screen: "bogus" }),
    ).toBeNull();
  });

  it("dedupes a navigate chip against a derived chip to the same screen", () => {
    const chips = dedupeNavChips([
      buildNavChip("get_score", { display_score: 512 })!,
      buildNavChip("navigate", { navigated: true, screen: "score" })!,
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0].target).toEqual({ screen: "score" });
  });
});
