/**
 * eligibility.test.ts — which asks the interpreter may take, and when it may run at all (the interpreter,
 * I.4; plan v1 A4, re-confirmed on 7bbe608). Pure: no network, no rows.
 */
import { NOTHING_ATTACHED, route } from "../classify";
import {
  ASK_DECISIONS,
  EXCLUSION_CLEARED,
  interpretable,
  interpretableAsk,
  interpreterMenu,
  type EligibilityInput,
} from "./eligibility";

const eligible = (
  sentence: string,
  over: Partial<EligibilityInput> = {},
): EligibilityInput => ({
  enabled: true,
  nativeEdit: true,
  hasFrame: true,
  drawn: false,
  origin: "system",
  sentence,
  routed: route(sentence, true, NOTHING_ATTACHED),
  ...over,
});

describe("every code route() can ask with is decided — interpret, or never", () => {
  it("takes exactly A4's seven, as confirmed against main", () => {
    // Hand-written, not read off the constant: a code moved between the lists must be red here.
    const interpret = Object.entries(ASK_DECISIONS)
      .filter(([, d]) => d === "interpret")
      .map(([code]) => code)
      .sort();
    expect(interpret).toEqual([
      "add_unclear",
      "brand_change",
      "brand_removal",
      "compound_partial",
      "conditional",
      "fast_path_declined",
      "worn_add_unclear",
    ]);
  });

  it("never takes a refusal the rules made on purpose, or one only different words could fix", () => {
    const never = Object.entries(ASK_DECISIONS)
      .filter(([, d]) => d === "never")
      .map(([code]) => code)
      .sort();
    expect(never).toEqual([
      // PR 19 (W-5): "change the angle" is answered by its own angle chips.
      "angle_unclear",
      "compound_conflict",
      "generate_not_permitted",
      "headline_bounds",
      "keep_conflict",
      "look_unknown",
      "no_steps",
      "object_photo_missing",
      "person_mentioned",
      "person_target",
      // PR 19: a model cannot attach her Style picture, and "vague" is answered by its own op chips.
      "style_reference_missing",
      "too_many_changes",
      "vague",
    ]);
    for (const code of never) expect(interpretableAsk(code)).toBe(false);
  });

  it("never takes a code it has no decision for, nor a missing one", () => {
    expect(interpretableAsk(undefined)).toBe(false);
    expect(interpretableAsk("")).toBe(false);
    expect(interpretableAsk("add_onto_body")).toBe(false);
    expect(interpretableAsk("text_off_native")).toBe(false);
    expect(interpretableAsk("toString")).toBe(false);
    expect(interpretableAsk("ad_needs_brand")).toBe(false);
  });
});

describe("when the interpreter runs at all", () => {
  // I.0's ask: rule 4c's brand change reads no item, so it asks `brand_change` — on the eligible list.
  const AD = "turn this into an adidas ad. dont change anything about me";

  it("runs on an eligible ask, with everything in place", () => {
    expect(route(AD, true, NOTHING_ATTACHED)).toMatchObject({
      initialPath: "ASK",
      reason: "brand_change",
    });
    expect(interpretable(eligible(AD))).toBe(true);
  });

  it("never runs with a switch off, without a frame, on a box she drew, or on a brand's inbound ask", () => {
    for (const over of [
      { enabled: false },
      { nativeEdit: false },
      { hasFrame: false },
      { drawn: true },
      { origin: "inbound" as const },
    ]) {
      expect({ over, got: interpretable(eligible(AD, over)) }).toEqual({
        over,
        got: false,
      });
    }
  });

  it("never runs on a sentence the rules routed — they keep first claim", () => {
    expect(interpretable(eligible("make the socks blue"))).toBe(false);
  });

  it("never runs on her body — no rephrasing changes what it asks for", () => {
    const s = "make my face thinner";
    expect(route(s, true, NOTHING_ATTACHED).initialPath).toBe("ASK");
    expect(interpretable(eligible(s))).toBe(false);
  });

  it("never runs on nothing, or past detection's own bound", () => {
    expect(interpretable(eligible("   "))).toBe(false);
    const long = `${AD} ${"and please keep it just like that ".repeat(12)}`;
    expect(long.trim().length).toBeGreaterThan(400);
    expect(interpretable(eligible(long))).toBe(false);
  });
});

describe("the menu's switches", () => {
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  afterEach(() => {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
  });

  it("offers a headline only behind the switch route() reads — read at call time", () => {
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(interpreterMenu().text).toBe(false);
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(interpreterMenu().text).toBe(true);
  });

  it("offers the exclusion: R2 cleared it at n=2 (sweep-4 ledger, F-E)", () => {
    expect(EXCLUSION_CLEARED).toBe(true);
    expect(interpreterMenu().exclusion).toBe(true);
  });
});
