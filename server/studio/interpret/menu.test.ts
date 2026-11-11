/**
 * menu.test.ts — the interpreter's menu is the rules' own vocabulary, and every kind renders to a
 * clause the rules read back as exactly that kind (the interpreter, I.2). Pure: no network, no rows.
 *
 * The properties asserted hardest:
 *
 *   1. EVERY MENU KIND ROUND-TRIPS. Each renders to C, and `route(C)` — the real classifier — reads it
 *      back as the one step it means. A kind the rules stop reading goes red here, not in a preview.
 *   2. THE VOCABULARIES ARE THE RULES'. Every look is a word rules 3 and 5¾ read; every brand is one BRANDS
 *      reads; every swap item round-trips through rule 4c, per item (N3). Lists are pinned by HAND,
 *      so a deletion is red (the runbook's GARMENT_NOUNS lesson).
 *   3. THE SLOTS REFUSE THE SMUGGLES: her body, a pronoun, a joiner, a verb, a negation, a body
 *      modification, and anything past the rules' own bounds.
 */
import {
  HER_PLACEMENT_PREPS,
  NOTHING_ATTACHED,
  isBrandName,
} from "../classify";
import { canonicalSentence, roundTrip } from "./canonical";
import {
  ADD_PREPOSITIONS,
  BRAND_WORDS,
  LOOK_TERMS,
  SWAP_ITEMS,
  addOk,
  colourOk,
  editOk,
  settingOk,
  targetOk,
  textOk,
  type Edit,
} from "./menu";

const ONE_PHOTO = { objects: 1 };

function withDisplayText<T>(fn: () => T): T {
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  process.env.STUDIO_DISPLAY_TEXT = "true";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
  }
}

const trips = (edits: Edit[], attached = NOTHING_ATTACHED) =>
  roundTrip(edits, attached).ok;

describe("every menu kind renders to a clause the rules read back as exactly that kind", () => {
  const cases: [string, Edit, typeof NOTHING_ATTACHED][] = [
    [
      "recolor",
      { kind: "recolor", target: "jersey", colour: "light blue" },
      NOTHING_ATTACHED,
    ],
    ["remove", { kind: "remove", target: "soccer ball" }, NOTHING_ATTACHED],
    [
      "remove a brand's mark",
      { kind: "remove", target: "nike logo" },
      NOTHING_ATTACHED,
    ],
    [
      "brand_swap",
      {
        kind: "brand_swap",
        item: "uniform",
        descriptors: ["black"],
        brand: "adidas",
      },
      NOTHING_ATTACHED,
    ],
    [
      "brand_swap, a two-word item",
      {
        kind: "brand_swap",
        item: "sports bra",
        descriptors: [],
        brand: "nike",
      },
      NOTHING_ATTACHED,
    ],
    [
      "pointed_swap",
      { kind: "pointed_swap", target: "earrings", what: "gold hoops" },
      ONE_PHOTO,
    ],
    [
      "add, spatial",
      {
        kind: "add",
        thing: "soccer ball",
        preposition: "between",
        place: "my cleats",
      },
      NOTHING_ATTACHED,
    ],
    [
      "add, worn onto her (M3)",
      { kind: "add", thing: "gold hoops", preposition: "to", place: "my ears" },
      ONE_PHOTO,
    ],
    [
      "design",
      { kind: "design", design: "adidas logo", target: "jersey" },
      NOTHING_ATTACHED,
    ],
    [
      "background",
      { kind: "background", setting: "stadium at night under the lights" },
      NOTHING_ATTACHED,
    ],
    ["look", { kind: "look", term: "golden hour" }, NOTHING_ATTACHED],
  ];
  it.each(cases)("%s", (_name, edit, attached) => {
    expect(roundTrip([edit], attached)).toMatchObject({ ok: true });
  });

  it("text, behind STUDIO_DISPLAY_TEXT — and not without it", () => {
    const headline: Edit = { kind: "text", content: "OWN THE MOMENT" };
    expect(withDisplayText(() => trips([headline]))).toBe(true);
    expect(trips([headline])).toBe(false);
  });

  it("renders a background as '…to the <setting>' so rule 2's article never eats a letter", () => {
    // Before the wave-1 fixes, "change the background to an arena" froze "n arena" and "…to athletics
    // track" froze "thletics track" (measured at $0 on 7bbe608). C always says "the", and round-trips.
    for (const setting of [
      "arena",
      "athletics track",
      "empty arena at night",
      "theater stage",
    ]) {
      expect({ setting, ok: trips([{ kind: "background", setting }]) }).toEqual(
        {
          setting,
          ok: true,
        },
      );
    }
  });
});

describe("the canonical sentences the plan names are what the menu renders", () => {
  it("cell 1a's C — per-item kit swaps and a headline (v2 §4) — word for word", () => {
    const edits: Edit[] = [
      { kind: "brand_swap", item: "jersey", descriptors: [], brand: "adidas" },
      { kind: "brand_swap", item: "socks", descriptors: [], brand: "adidas" },
      { kind: "brand_swap", item: "cleats", descriptors: [], brand: "adidas" },
      { kind: "text", content: "OWN THE MOMENT" },
    ];
    expect(canonicalSentence(edits, NOTHING_ATTACHED)).toBe(
      'change my jersey to an adidas jersey, change my socks to adidas socks, change my cleats to adidas cleats, and add the headline "OWN THE MOMENT" across the top',
    );
    expect(withDisplayText(() => trips(edits))).toBe(true);
  });

  it("sentence 4's C (v1 §4) — word for word", () => {
    const edits: Edit[] = [
      {
        kind: "brand_swap",
        item: "uniform",
        descriptors: ["black"],
        brand: "adidas",
      },
      {
        kind: "brand_swap",
        item: "cleats",
        descriptors: ["pink"],
        brand: "adidas",
      },
    ];
    expect(canonicalSentence(edits, NOTHING_ATTACHED)).toBe(
      "change my uniform to a black adidas uniform, and change my cleats to pink adidas cleats",
    );
    expect(trips(edits)).toBe(true);
  });

  it("cell 3's C (v2 §10) — the routed form she would type, her hoops photo attached", () => {
    const edits: Edit[] = [
      { kind: "add", thing: "gold hoops", preposition: "to", place: "my ears" },
    ];
    expect(canonicalSentence(edits, ONE_PHOTO)).toBe(
      "add these gold hoops to my ears",
    );
    expect(trips(edits, ONE_PHOTO)).toBe(true);
  });

  it("a sentence of only recolours goes back to rule 5 whole, and still round-trips", () => {
    // ⚠️ AND SINCE CARD 2 THIS IS ALSO THE PIN ON `whole`'s PER-TARGET COLOURS. C renders these two
    // clauses as "make the jersey blue, and make the socks red", which rule 5 now pairs — so
    // `roundTrip`'s `whole` must predict `values` or `stepKey` sees a difference and every
    // multi-recolour interpretation becomes a round_trip_mismatch. Measured: deleting rule 5's
    // `values` turns THIS test red, alongside core.test.ts's "two recolours survive card 2's
    // per-target colours", which asserts the step shape it round-trips to.
    expect(
      trips([
        { kind: "recolor", target: "jersey", colour: "blue" },
        { kind: "recolor", target: "socks", colour: "red" },
      ]),
    ).toBe(true);
  });
});

describe("the vocabularies are the rules' own, pinned by hand", () => {
  it("has exactly v1's eleven looks and the style vocabulary's sixteen words, each one a term that round-trips", () => {
    // v1's eleven, each still in its place among its look's words, and the style vocabulary's sixteen
    // (V.3) — her words, so "moody" is a term beside "moodier".
    expect(LOOK_TERMS).toEqual([
      "black and white",
      "monochrome",
      "sepia",
      "golden hour",
      "film look",
      "vintage look",
      "vintage",
      "retro",
      "warmer",
      "cooler",
      "brighter",
      "darker",
      "more contrast",
      "higher contrast",
      "high contrast",
      "moodier",
      "moody",
      "dramatic",
      "softer",
      "soft",
      "muted",
      "faded",
      "vibrant",
      "punchy",
      "punchier",
      "cinematic",
      "editorial",
    ]);
    // Main's words that name the act, not a look — the rules read them; a slot never holds them.
    for (const term of ["b&w", "colour grade", "color grade", "grading"]) {
      expect({ term, ok: editOk({ kind: "look", term }, 0) }).toEqual({
        term,
        ok: false,
      });
    }
    for (const term of LOOK_TERMS) {
      expect({ term, ok: trips([{ kind: "look", term }]) }).toEqual({
        term,
        ok: true,
      });
    }
  });

  it("names exactly the brands BRANDS reads, each one a kit rule 4c swaps to", () => {
    expect(BRAND_WORDS).toHaveLength(14);
    for (const brand of BRAND_WORDS) {
      expect({ brand, name: isBrandName(brand) }).toEqual({
        brand,
        name: true,
      });
      const swap: Edit = {
        kind: "brand_swap",
        item: "jersey",
        descriptors: [],
        brand,
      };
      expect({ brand, ok: trips([swap]) }).toEqual({ brand, ok: true });
    }
  });

  it("lists the garments and footwear a mark sits on, head to feet — and swaps each one per item (N3)", () => {
    expect(SWAP_ITEMS).toEqual([
      "cap",
      "hat",
      "headband",
      "jersey",
      "shirt",
      "top",
      "tank top",
      "crop top",
      "sports bra",
      "jacket",
      "hoodie",
      "gloves",
      "shorts",
      "pants",
      "leggings",
      "socks",
      "cleats",
      "shoes",
      "boots",
      "sneakers",
    ]);
    for (const item of SWAP_ITEMS) {
      const swap: Edit = {
        kind: "brand_swap",
        item,
        descriptors: [],
        brand: "adidas",
      };
      expect({ item, ok: editOk(swap, 0) && trips([swap]) }).toEqual({
        item,
        ok: true,
      });
    }
  });
});

describe("a slot refuses the smuggles", () => {
  it("never names her, points, joins, acts or negates in a target", () => {
    for (const target of [
      "arms",
      "her face",
      "it",
      "this",
      "jersey and ball",
      "remove ball",
      "not jersey",
      "tattoo",
      "the jersey",
      "red jersey",
      "adidas jersey",
      "background",
      "photo",
      "one big long target",
    ]) {
      expect({ target, ok: targetOk(target) }).toEqual({ target, ok: false });
    }
    expect(targetOk("soccer ball")).toBe(true);
  });

  it("reads a colour only as rule 5 does", () => {
    expect(colourOk("black and green")).toBe(true);
    expect(colourOk("light blue")).toBe(true);
    for (const colour of [
      "sparkly",
      "and blue",
      "blue and",
      "light",
      "blue jersey",
    ]) {
      expect({ colour, ok: colourOk(colour) }).toEqual({ colour, ok: false });
    }
  });

  it("holds a setting to rule 2's forty characters, and puts nobody in it", () => {
    expect(settingOk("stadium at night")).toBe(true);
    for (const setting of [
      "a stadium at night",
      "stadium full of people",
      "stadium with her in it",
      "beach and remove the ball",
      "stadium at night under the floodlights here",
    ]) {
      expect({ setting, ok: settingOk(setting) }).toEqual({
        setting,
        ok: false,
      });
    }
  });

  it("lets an add name her only where a worn thing is worn (M3, N5)", () => {
    expect(addOk("gold hoops", "to", "my ears")).toBe(true);
    expect(addOk("watch", "on", "my left wrist")).toBe(true);
    expect(addOk("earrings", "on", "me")).toBe(true);
    // A ring on her lip is a piercing Mia has not opened; a tattoo is a body modification.
    expect(addOk("ring", "to", "my lip")).toBe(false);
    expect(addOk("tattoo", "on", "my arm")).toBe(false);
    // A thing that is not worn, onto her, is an edit to her.
    expect(addOk("soccer ball", "on", "my head")).toBe(false);
    expect(addOk("soccer ball", "on", "me")).toBe(false);
  });

  it("holds a headline to rule ⅛'s own bounds", () => {
    expect(textOk("OWN THE MOMENT")).toBe(true);
    for (const content of [
      "JUST DO IT",
      "NIKE FOREVER",
      "WE RUN THIS CITY TONIGHT",
      "GET <LOUD>",
    ]) {
      expect({ content, ok: textOk(content) }).toEqual({ content, ok: false });
    }
  });
});

describe("a worn thing is read as rule 3¾b reads it — colours and one brand before its name (R1)", () => {
  it("refuses a word the rule does not read, so C is never rendered to ask", () => {
    expect(addOk("small gold hoops", "to", "my ears")).toBe(false);
    expect(addOk("baseball cap", "on", "my head")).toBe(false);
    expect(addOk("gold hoops", "to", "my ears")).toBe(true);
    expect(addOk("black adidas cap", "on", "my head")).toBe(true);
    expect(addOk("pink hair tie", "in", "my hair")).toBe(true);
    // Two brands, even as descriptors' neighbours, are not one.
    expect(addOk("nike adidas cap", "on", "my head")).toBe(false);
  });
});

describe("G1's placements are the rules', not the menu's (wave A)", () => {
  it("adds none of G1's prepositions to the menu — interpret/5's words do not move", () => {
    for (const prep of HER_PLACEMENT_PREPS.map((p) => p.join(" "))) {
      expect({ prep, offered: ADD_PREPOSITIONS.includes(prep) }).toEqual({
        prep,
        offered: false,
      });
    }
  });

  it("still refuses a thing she does not wear onto a part of her — the interpreter reads these as it did", () => {
    expect(addOk("water bottle", "on", "my head")).toBe(false);
    expect(addOk("soccer ball", "at", "my feet")).toBe(false);
  });
});
