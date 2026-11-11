/**
 * suggest.test.ts — the Board's suggestion: her row sentences in, one track and its reason out, and
 * never a track that may not go under a brand's video when the video is for one.
 */
import {
  OWN_CONTENT_OBJECTIVES,
  brandSignalsFrom,
  brandWorkFor,
  isBrandWork,
  suggestMusic,
  type MusicSuggestion,
} from "./suggest";
import type { TrackDefinition } from "./tracks";

const ok = (out: ReturnType<typeof suggestMusic>): MusicSuggestion => {
  if ("error" in out) throw new Error(out.error);
  return out;
};

describe("the suggestion for her board", () => {
  it("warm, slow, golden light → walking-around, with a reason that says warm", () => {
    const { top } = ok(
      suggestMusic({
        feel: ["warm, slow, golden light"],
        objective: "grow-following",
      }),
    );
    expect(top?.name).toBe("walking-around");
    expect(top?.label).toBe("Walking Around");
    expect(top?.reason).toMatch(/\bwarm\b/);
  });

  it("reads the words across every row, not only the first", () => {
    const { top } = ok(
      suggestMusic({
        feel: ["her walking onto the court", "hype crowd, fast cuts"],
        objective: "grow-following",
      }),
    );
    expect(top?.reason).toMatch(/\bhype\b/);
  });

  it("suggests nothing when her words name no feel — no pick on a guess", () => {
    const out = ok(
      suggestMusic({
        feel: ["her walking onto the court", ""],
        objective: "grow-following",
      }),
    );
    expect(out.top).toBeNull();
    expect(out.ranked.length).toBeGreaterThan(0);
  });

  it("refuses a body that is not a list of sentences, or is past a board's size", () => {
    for (const feel of [
      undefined,
      "warm",
      [1],
      Array(51).fill("x"),
      ["x".repeat(5001)],
    ]) {
      expect("error" in suggestMusic({ feel, objective: "recap" })).toBe(true);
    }
  });
});

describe("brand work is decided fail-closed, off the objective", () => {
  it("treats only her own-content objectives as not brand work", () => {
    expect([...OWN_CONTENT_OBJECTIVES].sort()).toEqual([
      "concept",
      "grow-following",
      "recap",
    ]);
    for (const own of OWN_CONTENT_OBJECTIVES)
      expect([own, isBrandWork(own)]).toEqual([own, false]);
  });

  it("treats a brand objective, an unknown one and a missing one as brand work", () => {
    for (const o of [
      "showcase-product",
      "announce",
      "thank-partner",
      "something-new",
      undefined,
      null,
      7,
    ]) {
      expect([o, isBrandWork(o)]).toEqual([o, true]);
    }
  });

  const base: Omit<TrackDefinition, "title" | "brandSafe" | "moods"> = {
    author: "x",
    license: "CC0-1.0",
    planHolder: null,
    sourceUrl: "https://example.test/x",
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/x.m4a",
    sha256: "0".repeat(64),
    durationSec: 120,
    bpm: 84,
    firstBeatSec: 0,
    energy: 2,
  };
  const catalogue: Record<string, TrackDefinition> = {
    uncleared: {
      ...base,
      title: "Uncleared",
      moods: ["warm", "reflective"],
      brandSafe: false,
    },
    cleared: { ...base, title: "Cleared", moods: ["dark"], brandSafe: true },
  };

  it("never suggests or lists a track that is not brandSafe on a deal-linked edit", () => {
    const own = ok(
      suggestMusic(
        { feel: ["warm golden slow"], objective: "grow-following" },
        catalogue,
      ),
    );
    expect(own.top?.name).toBe("uncleared");

    for (const objective of [
      "showcase-product",
      "announce",
      "thank-partner",
      undefined,
    ]) {
      const brand = ok(
        suggestMusic({ feel: ["warm golden slow"], objective }, catalogue),
      );
      expect([objective, brand.top?.name]).toEqual([objective, "cleared"]);
      expect([objective, brand.ranked.map((r) => r.name)]).toEqual([
        objective,
        ["cleared"],
      ]);
    }
  });
});

describe("brand-ness off the brief and the deal, the chip only with neither (PR 10, R-2 — Adi's rule)", () => {
  const base: Omit<TrackDefinition, "title" | "brandSafe" | "moods"> = {
    author: "x",
    license: "CC0-1.0",
    planHolder: null,
    sourceUrl: "https://example.test/x",
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/x.m4a",
    sha256: "0".repeat(64),
    durationSec: 120,
    bpm: 84,
    firstBeatSec: 0,
    energy: 2,
  };
  const catalogue: Record<string, TrackDefinition> = {
    uncleared: { ...base, title: "Uncleared", moods: ["warm", "reflective"], brandSafe: false },
    cleared: { ...base, title: "Cleared", moods: ["dark"], brandSafe: true },
  };
  const brief = (type: string, brand: unknown = { name: "Solstice" }) => ({
    objective: { type, goal: "grow-following" },
    brand,
  });

  it("reads the signals off a validated brief or a stored row alike — defensively", () => {
    expect(brandSignalsFrom(brief("brand_campaign"), false, "recap")).toEqual({
      dealLinked: false, briefType: "brand_campaign", briefHasBrand: true, objective: "recap",
    });
    expect(brandSignalsFrom(brief("social_content", null), true)).toEqual({
      dealLinked: true, briefType: "social_content", briefHasBrand: false, objective: undefined,
    });
    expect(brandSignalsFrom(null, false, "recap")).toEqual({
      dealLinked: false, briefType: null, briefHasBrand: false, objective: "recap",
    });
    // An object with no readable type is a brief of an unknown type — never "no brief".
    expect(brandSignalsFrom({ story: "x" }, false)).toMatchObject({ briefType: "", briefHasBrand: false });
    expect(brandWorkFor(brandSignalsFrom({ story: "x" }, false, "recap"))).toBe(true);
  });

  /** ⚠️ MUTATION "a grow-following brand brief is offered a non-brandSafe track": make brandWorkFor read `isBrandWork(s.objective)` first — this reds by name. */
  it("a grow-following brand brief is offered a non-brandSafe track: never — the suggestion is brandSafe-only whatever the chip says", () => {
    const signals = brandSignalsFrom(brief("brand_campaign"), false);
    const s = ok(suggestMusic({ feel: ["warm golden slow"], objective: "grow-following" }, catalogue, signals));
    expect(s.top?.name).toBe("cleared");
    expect(s.ranked.map((r) => r.name)).toEqual(["cleared"]);
    // The same words with no brief and no deal: her own content, and the uncleared track ranks.
    const own = ok(suggestMusic({ feel: ["warm golden slow"], objective: "grow-following" }, catalogue));
    expect(own.top?.name).toBe("uncleared");
  });

  /** ⚠️ MUTATION "a deal-linked plan with no brief is treated as own content": drop the dealLinked line in brandWorkFor — this reds by name. */
  it("a deal-linked plan with no brief is treated as own content: never", () => {
    expect(brandWorkFor({ dealLinked: true, briefType: null, briefHasBrand: false, objective: "grow-following" })).toBe(true);
    const s = ok(suggestMusic(
      { feel: ["warm golden slow"], objective: "grow-following" },
      catalogue,
      { dealLinked: true, briefType: null, briefHasBrand: false },
    ));
    expect(s.ranked.map((r) => r.name)).toEqual(["cleared"]);
  });

  it("the rule, row by row", () => {
    const row = (briefType: string | null, briefHasBrand: boolean, dealLinked: boolean, objective?: string) =>
      brandWorkFor({ dealLinked, briefType, briefHasBrand, objective });
    expect(row("brand_campaign", false, false)).toBe(true);
    expect(row("ad", false, false)).toBe(true);
    expect(row("social_content", true, false)).toBe(true);
    expect(row("social_content", false, true)).toBe(true);
    expect(row("social_content", false, false)).toBe(false);
    expect(row("new-type", false, false)).toBe(true);
    expect(row(null, false, false, "grow-following")).toBe(false);
    expect(row(null, false, false, "showcase-product")).toBe(true);
    expect(row(null, false, false)).toBe(true);
  });
});
