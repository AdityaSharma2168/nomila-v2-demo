/**
 * ops.test.ts — the five typed ops become sentences the rules read (PR 9, Lane 1).
 *
 * Every op's sentence is pinned AGAINST `route`: it routes, to the EditOperation the op means, with no ASK
 * and no GENERATE step. A phrasing the rules stop reading is a red here, not a silent refusal at the door.
 */
import { route } from "../classify";
import {
  campaignBlockFor,
  groundedHeadline,
  bannerText,
  headlineOfName,
  isStudioEditOp,
  opRefusal,
  parseOp,
  planOp,
  STUDIO_EDIT_OPS,
  type OpParams,
} from "./ops";
import { CAMPAIGN_CLOSE, CAMPAIGN_OPEN } from "../agent/plan";

const PRODUCT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  process.env.STUDIO_DISPLAY_TEXT = "true";
});
afterEach(() => {
  delete process.env.STUDIO_DISPLAY_TEXT;
});

const plan = (op: string, params: unknown) => {
  const parsed = parseOp(op, params);
  if (!parsed.ok) throw new Error(parsed.error);
  return planOp(parsed.op, parsed.params);
};

const routed = (sentence: string, objects = 0) =>
  route(sentence, true, { objects });

describe("the five ops, and no sixth", () => {
  it("names exactly the five", () => {
    expect([...STUDIO_EDIT_OPS]).toEqual([
      "recolour",
      "garment",
      "product",
      "background_clean",
      "ad",
    ]);
    expect(isStudioEditOp("upscale")).toBe(false);
    expect(parseOp("upscale", {})).toEqual({
      ok: false,
      error: expect.stringContaining("op must be one of"),
    });
  });

  it("refuses params outside an op's closed shape, naming the field", () => {
    expect(parseOp("recolour", { target: "jersey" })).toEqual({
      ok: false,
      error: expect.stringMatching(/^recolour params: colour/),
    });
    expect(
      parseOp("recolour", { target: "jersey", colour: "red", extra: 1 }),
    ).toEqual({ ok: false, error: expect.stringContaining("recolour params") });
    expect(parseOp("garment", { garment: "jersey" })).toEqual({
      ok: false,
      error: expect.stringContaining("brand OR a design"),
    });
    expect(
      parseOp("garment", {
        garment: "jersey",
        brand: "adidas",
        design: "stripe",
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("brand OR a design"),
    });
    expect(parseOp("product", { thing: "ball" })).toEqual({
      ok: false,
      error: expect.stringMatching(/productAssetId/),
    });
    // The other two modes take no photo and refuse one — a remove has a target, an add a thing.
    expect(parseOp("product", { mode: "remove", thing: "ball" })).toMatchObject(
      {
        ok: false,
      },
    );
    expect(
      parseOp("product", {
        mode: "add",
        thing: "ball",
        productAssetId: PRODUCT,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseOp("product", { mode: "remove", target: "water bottle" }),
    ).toEqual({
      ok: true,
      op: "product",
      params: { mode: "remove", target: "water bottle" },
    });
    expect(parseOp("recolour", { target: "<script>", colour: "red" })).toEqual({
      ok: false,
      error: expect.stringContaining("letters"),
    });
  });

  it("fills the defaults: a placed add lands on the ground, a clean background keeps the place", () => {
    const p = parseOp("product", { productAssetId: PRODUCT, thing: "ball" });
    const placed = p.ok ? (p.params as OpParams["product"]) : null;
    expect(placed?.mode === "place" && placed.place).toEqual({
      preposition: "on the ground next to",
      place: "me",
    });
    const b = parseOp("background_clean", {});
    expect(b.ok && (b.params as OpParams["background_clean"]).setting).toBe(
      "same place with nobody else and no signs",
    );
    expect("same place with nobody else and no signs").toHaveLength(40);
  });
});

describe("each op's sentence routes, to the operation the op means", () => {
  it("recolour → RECOLOR on the target, with the colour", () => {
    const p = plan("recolour", { target: "jersey", colour: "red" });
    expect(p.sentence).toBe("make the jersey red");
    expect(p.regions).toBe("derived");
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => [s.op, s.targets, s.value])).toEqual([
      ["RECOLOR", ["jersey"], "red"],
    ]);
  });

  it("garment with a brand → rule 4c's brand change (REPLACE_OBJECT to the brand's garment)", () => {
    const p = plan("garment", { garment: "jersey", brand: "adidas" });
    expect(p.sentence).toBe("change my jersey to an adidas jersey");
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => [s.op, s.targets, s.value])).toEqual([
      ["REPLACE_OBJECT", ["jersey"], "adidas jersey"],
    ]);
  });

  it("garment with a design → APPLY_DESIGN on the garment", () => {
    const p = plan("garment", { garment: "jersey", design: "stripe" });
    expect(p.sentence).toBe("add a stripe to the jersey");
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => [s.op, s.targets])).toEqual([
      ["APPLY_DESIGN", ["jersey"]],
    ]);
  });

  it('product → a placed ADD_OBJECT pointing at her product photo ("this ball"), region-free', () => {
    const p = plan("product", { productAssetId: PRODUCT, thing: "ball" });
    expect(p.sentence).toBe("add this ball on the ground next to me");
    expect(p.productAssetId).toBe(PRODUCT);
    expect(p.regions).toBe("region-free");
    const r = routed(p.sentence, 1);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => s.op)).toEqual(["ADD_OBJECT"]);
    expect(r.steps[0].targets).toContain("ball");
  });

  // Adi, 23 Sep 2026: "there should be a remove or add object too" — as modes of the product op, not new
  // ops (the table's CHECK stays on five values; no migration).
  it('product mode "add" → a drawn ADD_OBJECT with no photo ("a soccer ball"), region-free', () => {
    const p = plan("product", { mode: "add", thing: "soccer ball" });
    expect(p.sentence).toBe("add a soccer ball on the ground next to me");
    expect(p.productAssetId).toBeNull();
    expect(p.regions).toBe("region-free");
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => s.op)).toEqual(["ADD_OBJECT"]);
  });

  it('product mode "remove" → REMOVE_OBJECT on the named thing, region-bound', () => {
    const p = plan("product", { mode: "remove", target: "water bottle" });
    expect(p.sentence).toBe("remove the water bottle");
    expect(p.productAssetId).toBeNull();
    expect(p.regions).toBe("derived");
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => [s.op, s.targets])).toEqual([
      ["REMOVE_OBJECT", ["water bottle"]],
    ]);
  });

  it("background_clean → CHANGE_BACKGROUND, the subject preserved, the whole setting kept as the value", () => {
    const p = plan("background_clean", {});
    expect(p.sentence).toBe(
      "change the background to the same place with nobody else and no signs",
    );
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => [s.op, s.targets, s.value])).toEqual([
      [
        "CHANGE_BACKGROUND",
        ["person"],
        "same place with nobody else and no signs",
      ],
    ]);
  });

  it("ad → a headline across the top (DISPLAY_TEXT), a setting when given, and the CAMPAIGN block", () => {
    const p = plan("ad", {
      brand: "adidas",
      headline: "Predator boots",
      setting: "the stadium at dusk",
      campaign: { product: "the new predator boots" },
    });
    expect(p.sentence).toBe(
      'add the headline "Predator boots" across the top, and change the background to the stadium at dusk',
    );
    expect(p.regions).toBe("region-free");
    expect(p.constraints).toEqual([]);
    expect(p.campaignBlock).toContain(CAMPAIGN_OPEN);
    expect(p.campaignBlock).toContain("product: the new predator boots");
    expect(p.campaignBlock).toContain(CAMPAIGN_CLOSE);
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => s.op)).toEqual([
      "DISPLAY_TEXT",
      "CHANGE_BACKGROUND",
    ]);
    expect(r.steps[0].value).toBe("PREDATOR BOOTS");
  });

  // Adi's device walk, 23 Sep 2026: "ad params: brand — letters, digits, spaces and hyphens only" on
  // "Sunrise Oats Co. (SEED)". A brand's name is not a sentence slot; it takes a name's characters.
  it("ad for an UNKNOWN brand whose name has punctuation: the name parses, and the headline is the name as a banner writes it", () => {
    const parsed = parseOp("ad", {
      brand: "Sunrise Oats Co. (SEED)",
      instruction: "an ad for the brand",
    });
    expect(parsed.ok).toBe(true);
    const p = plan("ad", {
      brand: "Sunrise Oats Co. (SEED)",
      instruction: "an ad for the brand",
    });
    expect(p.refusal).toBeNull();
    expect(p.sentence).toBe(
      'add the headline "SUNRISE OATS CO SEED" across the top',
    );
    expect(p.notes.join(" ")).toContain("SUNRISE OATS CO SEED");
    expect(p.campaignBlock).toContain("brand: Sunrise Oats Co. (SEED)");
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => [s.op, s.value])).toEqual([
      ["DISPLAY_TEXT", "SUNRISE OATS CO SEED"],
    ]);
    // With a setting the sentence is a compound, and a period inside the quotes broke it on the device
    // ("That edit can't be read as a change to this photo"). No period, two steps.
    const withSetting = plan("ad", {
      brand: "Sunrise Oats Co. (SEED)",
      setting: "stadium pitch at night",
      instruction: "an ad for the brand",
    });
    expect(withSetting.sentence).not.toMatch(/\./);
    const rs = routed(withSetting.sentence);
    expect(rs.initialPath).not.toBe("ASK");
    expect(rs.steps.map((s) => s.op)).toEqual([
      "DISPLAY_TEXT",
      "CHANGE_BACKGROUND",
    ]);
    expect(bannerText("Match day.")).toBe("Match day");
    const bj = plan("ad", { brand: "Ben & Jerry's", instruction: "an ad" });
    expect(bj.sentence).toBe(
      'add the headline "BEN & JERRY\'S" across the top',
    );
    expect(routed(bj.sentence).steps.map((s) => s.value)).toEqual([
      "BEN & JERRY'S",
    ]);
    expect(headlineOfName("(((")).toBeNull();
  });

  it("ad for an UNKNOWN brand whose name is longer than a headline refuses, asking for a headline", () => {
    const p = plan("ad", {
      brand: "Sunrise Oats Company of Northern California",
      instruction: "an ad",
    });
    expect(p.refusal).toMatch(/needs a headline/);
    expect(p.refusal).toMatch(/longer than a headline/);
    expect(parseOp("ad", { brand: "<b>x</b>", instruction: "an ad" })).toEqual({
      ok: false,
      error: expect.stringContaining("letters"),
    });
  });

  it("ad for a KNOWN brand with no headline refuses: the brand's name is a mark, not display text", () => {
    const p = plan("ad", { brand: "adidas" });
    expect(p.refusal).toMatch(/needs a headline/);
    expect(p.sentence).toBe("");
    // The rules themselves refuse a brand's name as a headline — which is why the op does not write one.
    expect(routed('add the headline "adidas" across the top')).toMatchObject({
      initialPath: "ASK",
      reason: "headline_bounds",
    });
  });

  /**
   * ADI-R19 F2 (parity R-8 / C-2): an adidas ad compiled "DO NOT: show a adidas logo anywhere in the photograph" — it
   * forbade the one mark the ad exists to carry. Straight fix, not flag-gated: no known brand excludes its own marks.
   * ⚠️ MUTATION M-F2a: exclude the known brand again (ops.ts) — this reds by name.
   */
  it("an ad never excludes its own brand's marks", () => {
    for (const brand of ["adidas", "nike", "new balance"]) {
      const p = plan("ad", {
        brand,
        headline: "Own the moment",
        instruction: "own the moment",
      });
      expect(p.refusal).toBeNull();
      expect(p.constraints).toEqual([]);
    }
  });

  it("ad for a brand the rules do not know: no exclude_marks constraint, and a note saying so", () => {
    const p = plan("ad", { brand: "Jane Street" });
    expect(p.constraints).toEqual([]);
    expect(p.notes).toEqual([
      expect.stringContaining("not a brand the rules know"),
    ]);
    const r = routed(p.sentence);
    expect(r.initialPath).not.toBe("ASK");
    expect(r.steps.map((s) => [s.op, s.value])).toEqual([
      ["DISPLAY_TEXT", "JANE STREET"],
    ]);
  });

  it("no op's sentence ever carries a GENERATE step", () => {
    const all = [
      plan("recolour", { target: "shorts", colour: "navy blue" }),
      plan("garment", { garment: "socks", brand: "nike" }),
      plan("product", {
        productAssetId: PRODUCT,
        thing: "water bottle",
        place: { preposition: "on", place: "the bench" },
      }),
      plan("product", { mode: "add", thing: "cone" }),
      plan("product", { mode: "remove", target: "cone" }),
      plan("background_clean", { setting: "the same pitch with nobody else" }),
      plan("ad", {
        brand: "nike",
        headline: "Match day",
        instruction: "an ad for match day",
      }),
    ];
    for (const p of all) {
      const r = routed(p.sentence, p.productAssetId ? 1 : 0);
      expect({
        sentence: p.sentence,
        path: r.initialPath,
        reason: r.reason ?? null,
      }).toEqual({
        sentence: p.sentence,
        path: expect.not.stringMatching(/^(ASK|GENERATE)$/),
        reason: null,
      });
      expect(r.steps.some((s) => s.op === "GENERATE")).toBe(false);
    }
  });
});

describe("the ad's headline is grounded — the claim lexicon", () => {
  /** ⚠️ MUTATION "ad headline claims what the inputs do not say": skip groundedHeadline in planOp's ad arm. */
  it("a headline that says what the campaign says is kept; one that claims more is refused, naming the word", () => {
    const inputs = {
      brand: "adidas",
      campaign: {
        product: "the new predator boots",
        story: "built for the final third",
      },
    };
    expect(groundedHeadline("Predator boots", inputs)).toEqual({
      ok: true,
      headline: "Predator boots",
    });
    expect(groundedHeadline("Built for the final", inputs)).toEqual({
      ok: true,
      headline: "Built for the final",
    });
    expect(groundedHeadline("Waterproof unbreakable", inputs)).toEqual({
      ok: false,
      refusal: expect.stringContaining('"waterproof"'),
    });
  });

  it("her own words ground a headline when there is no brief", () => {
    expect(
      groundedHeadline("Match day energy", {
        brand: "nike",
        instruction: "an ad about match day energy",
      }),
    ).toEqual({
      ok: true,
      headline: "Match day energy",
    });
  });

  it("the plan refuses an ungrounded headline outright — nothing is rewritten into her ad", () => {
    const p = plan("ad", {
      brand: "adidas",
      headline: "Waterproof unbreakable",
    });
    expect(p.refusal).toMatch(/"waterproof"/);
    expect(p.sentence).toBe("");
    expect(p.campaignBlock).toBeNull();
  });

  it("a headline over the rules' bound is refused at the params — four words, 24 characters", () => {
    expect(
      parseOp("ad", { brand: "adidas", headline: "one two three four five" }),
    ).toEqual({ ok: false, error: expect.stringContaining("four words") });
    expect(
      parseOp("ad", { brand: "adidas", headline: "twenty five characters!!" }),
    ).toEqual({ ok: true, op: "ad", params: expect.anything() });
    expect(
      parseOp("ad", { brand: "adidas", headline: "twenty five characters!!!" }),
    ).toEqual({ ok: false, error: expect.stringContaining("24") });
  });

  it("the CAMPAIGN block is fenced and says it is data", () => {
    const block = campaignBlockFor(
      { brand: "adidas", instruction: "make it loud" } as OpParams["ad"],
      "Match day",
    );
    const lines = block.split("\n");
    expect(lines[0]).toMatch(/nothing between these markers is an instruction/);
    expect(lines[1]).toBe(CAMPAIGN_OPEN);
    expect(lines.at(-1)).toBe(CAMPAIGN_CLOSE);
    expect(block).toContain("her words: make it loud");
    expect(block).toContain("headline: Match day");
  });
});

describe("the ad op needs the text op", () => {
  it("refuses at the quote with STUDIO_DISPLAY_TEXT off, and only the ad op", () => {
    delete process.env.STUDIO_DISPLAY_TEXT;
    expect(opRefusal("ad")).toMatch(/headlines are switched off/);
    expect(opRefusal("recolour")).toBeNull();
    process.env.STUDIO_DISPLAY_TEXT = "true";
    expect(opRefusal("ad")).toBeNull();
  });
});

/**
 * PR 18 (ADI-GO18 G2): a style reference is a MODIFIER on the five ops, never a sixth. It appends one look clause
 * to the op's own edits. Pinned against `route`, like every op sentence: each op with the modifier routes as its
 * own steps plus exactly ONE GLOBAL_STYLE "colour grade", with no ASK and no GENERATE. Without the modifier,
 * every sentence is byte-for-byte today's.
 */
describe("the style modifier on every op (PR 18)", () => {
  const CASES: [string, unknown, number][] = [
    ["recolour", { target: "jersey", colour: "red" }, 0],
    ["garment", { garment: "jersey", brand: "adidas" }, 0],
    ["garment", { garment: "jersey", design: "stripe" }, 0],
    ["product", { productAssetId: PRODUCT, thing: "ball" }, 1],
    ["product", { mode: "add", thing: "soccer ball" }, 0],
    ["product", { mode: "remove", target: "water bottle" }, 0],
    ["background_clean", {}, 0],
    ["ad", { brand: "Sunrise Oats Co", headline: "SUNRISE OATS" }, 0],
    [
      "ad",
      {
        brand: "Sunrise Oats Co",
        headline: "SUNRISE OATS",
        setting: "a sunny track",
      },
      0,
    ],
  ];

  const styled = (op: string, params: unknown) => {
    const parsed = parseOp(op, params);
    if (!parsed.ok) throw new Error(parsed.error);
    return planOp(parsed.op, parsed.params, { style: true });
  };

  it.each(CASES)(
    "%s %j with the modifier routes as its own steps plus one GLOBAL_STYLE",
    (op, params, objects) => {
      const bare = plan(op, params);
      const withLook = styled(op, params);
      expect(withLook.sentence).toMatch(/, and make it colour grade$/);
      const base = routed(bare.sentence, objects);
      const r = routed(withLook.sentence, objects);
      expect(r.initialPath).not.toBe("ASK");
      expect(r.steps.some((s) => s.op === "GENERATE")).toBe(false);
      const looks = r.steps.filter((s) => s.op === "GLOBAL_STYLE");
      expect(looks.map((s) => s.value)).toEqual(["colour grade"]);
      expect(
        r.steps
          .filter((s) => s.op !== "GLOBAL_STYLE")
          .map((s) => s.op)
          .sort(),
      ).toEqual(base.steps.map((s) => s.op).sort());
      // Everything else about the plan is the op's own.
      expect({ ...withLook, sentence: "" }).toEqual({ ...bare, sentence: "" });
    },
  );

  it.each(CASES)(
    "%s %j without the modifier writes exactly today's sentence",
    (op, params) => {
      const parsed = parseOp(op, params);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(planOp(parsed.op, parsed.params, {})).toEqual(
        planOp(parsed.op, parsed.params),
      );
      expect(planOp(parsed.op, parsed.params).sentence).not.toContain(
        "colour grade",
      );
    },
  );
});

/**
 * R-25 (PR 19, STUDIO_IMAGE_OPS; ADI-R19-S): the typed product op's `add` of a thing she wears, left at the default
 * place, put it "on the ground next to me". ⚠️ MUTATION M-R25: drop the anchor — this reds by name.
 */
describe("R-25: a worn thing at the default place is worn, never put on the ground", () => {
  const add = (thing: string) =>
    plan("product", {
      mode: "add",
      thing,
      place: { preposition: "on the ground next to", place: "me" },
    });
  afterEach(() => {
    delete process.env.STUDIO_IMAGE_OPS;
  });
  it("with STUDIO_IMAGE_OPS on, a worn thing takes its own anchor, and routes as a worn add", () => {
    process.env.STUDIO_IMAGE_OPS = "true";
    for (const [thing, sentence] of [
      ["sunglasses", "add sunglasses on my face"],
      ["hat", "add a hat on my head"],
      ["necklace", "add a necklace around my neck"],
    ] as const) {
      const p = add(thing);
      expect(p.sentence).toBe(sentence);
      expect(routed(p.sentence).steps.map((s) => [s.op, s.targets])).toEqual([
        ["ADD_OBJECT", [thing]],
      ]);
    }
    // A thing she does not wear keeps the default place, and a place she chose is hers.
    expect(add("soccer ball").sentence).toBe(
      "add a soccer ball on the ground next to me",
    );
    expect(
      plan("product", {
        mode: "add",
        thing: "sunglasses",
        place: { preposition: "on", place: "the bench" },
      }).sentence,
    ).toBe("add sunglasses on the bench");
  });
  it("with it off, the sentence is today's", () => {
    expect(add("sunglasses").sentence).toBe(
      "add sunglasses on the ground next to me",
    );
  });
});

/**
 * M-2 (PR 19's own miss, recorded in docs/probes/image-ops.md): a guard of step 3 made rule ⅛'s headline and the ad
 * op's compound sentence ASK with STUDIO_IMAGE_OPS on — the carousel's ad would have refused the moment the flag
 * flipped. Every op's sentence routes exactly as it does with the flag off. ⚠️ MUTATION M-2: widen the quoted-add
 * guard back to every quoted add (classify.ts) — this reds by name.
 */
describe("M-2: with STUDIO_IMAGE_OPS on, every op's sentence routes exactly as it does off", () => {
  afterEach(() => {
    delete process.env.STUDIO_IMAGE_OPS;
  });
  it("the ad's headline, its compound with a setting, and every other op's sentence", () => {
    const all = [
      plan("recolour", { target: "jersey", colour: "red" }),
      plan("garment", { garment: "jersey", brand: "adidas" }),
      plan("garment", { garment: "jersey", design: "stripe" }),
      plan("product", { productAssetId: PRODUCT, thing: "ball" }),
      plan("product", { mode: "add", thing: "soccer ball" }),
      plan("product", { mode: "remove", target: "water bottle" }),
      plan("background_clean", {}),
      plan("ad", {
        brand: "adidas",
        headline: "Predator boots",
        setting: "the stadium at dusk",
        campaign: { product: "the new predator boots" },
      }),
      plan("ad", {
        brand: "Sunrise Oats Co. (SEED)",
        setting: "stadium pitch at night",
        instruction: "an ad for the brand",
      }),
      plan("ad", { brand: "Ben & Jerry's", instruction: "an ad" }),
      plan("ad", { brand: "Jane Street" }),
      plan("ad", {
        brand: "nike",
        headline: "Match day",
        instruction: "an ad for match day",
      }),
    ];
    const read = (sentence: string, objects: number) => {
      const r = routed(sentence, objects);
      return { path: r.initialPath, reason: r.reason ?? null, steps: r.steps };
    };
    for (const p of all) {
      expect({ sentence: p.sentence, refusal: p.refusal }).toEqual({
        sentence: expect.stringMatching(/\S/),
        refusal: null,
      });
      const objects = p.productAssetId ? 1 : 0;
      delete process.env.STUDIO_IMAGE_OPS;
      const off = read(p.sentence, objects);
      process.env.STUDIO_IMAGE_OPS = "true";
      expect({ sentence: p.sentence, on: read(p.sentence, objects) }).toEqual({
        sentence: p.sentence,
        on: off,
      });
      expect({ sentence: p.sentence, off: off.path }).toEqual({
        sentence: p.sentence,
        off: expect.not.stringMatching(/^ASK$/),
      });
    }
  });
});
