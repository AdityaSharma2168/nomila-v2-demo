/**
 * PR 19 — the sentence door's rules (STUDIO_IMAGE_OPS; docs/probes/image-ops.md). $0: rules only, no model.
 *
 * The registered set (the ledger's P-1, `probe-out/image-ops/registry.json`) is pinned here by id: each row routes to
 * its target with the switch on, and EVERY row routes exactly as Phase R measured it with the switch off. The
 * CR rows are the crop's, pinned in its own suite. The walk's sentences (ADI-R19-W) are pinned verbatim at the end.
 */
import {
  route,
  validate,
  type Attached,
  type Classification,
  type Routed,
} from "./classify";
import { ANGLE_SUGGESTIONS, VAGUE_SUGGESTIONS } from "./imageOps";

const FLAGS = [
  "STUDIO_IMAGE_OPS",
  "STUDIO_DISPLAY_TEXT",
  "STUDIO_MOVE_OBJECT",
] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  // Phase R measured with the headline and the move switched on, as dev runs; the rows are pinned the same way.
  process.env.STUDIO_DISPLAY_TEXT = "true";
  process.env.STUDIO_MOVE_OBJECT = "true";
});
afterEach(() => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});
const on = () => {
  process.env.STUDIO_IMAGE_OPS = "true";
};
const off = () => {
  delete process.env.STUDIO_IMAGE_OPS;
};

/** The harness's own rendering of an answer, so a row reads the same here as in the ledger. */
function shown(r: Routed): string {
  if (r.initialPath === "ASK") return `ASK ${r.reason}`;
  return r.steps
    .map((x) => `${x.op}[${x.targets.join("|")}]=${x.value}`)
    .join(" ; ");
}
const read = (s: string, attached: Attached = { objects: 0 }, photo = true) =>
  route(s, photo, attached);

// ─── Phase R's measurement, per registered sentence (flag off) ──────────────────────────────────────────
const TODAY: readonly (readonly [string, string, boolean, string])[] = [
  ["E1", "make the uniform white and adidas", true, "ASK brand_change"],
  ["E2", "make the socks white and adidas", true, "ASK brand_change"],
  ["E3", "make the cleats blue and adidas", true, "ASK brand_change"],
  ["W1", "make it rain", true, "ASK fast_path_declined"],
  ["W2", "change the weather to snow", true, "ASK fast_path_declined"],
  ["W3", "make it sunny", true, "ASK fast_path_declined"],
  ["W4", "make it a rainy day", true, "ASK fast_path_declined"],
  ["AD1", "make this into an ad for stanford", true, "ASK fast_path_declined"],
  ["AD2", "make this an ad for adidas", true, "ASK brand_change"],
  ["AD3", "make an ad for adidas", true, "GENERATE[]=null"],
  ["AD4", "make this a magazine cover for nike", true, "ASK brand_change"],
  ["AD5", "make it for nike", true, "ASK brand_change"],
  ["AD6", "make it production quality for adidas", true, "ASK brand_change"],
  [
    "AD7",
    "make this an ad for zephyr hydration",
    true,
    "ASK fast_path_declined",
  ],
  ["AD8", "make an ad for adidas", false, "GENERATE[]=null"],
  ["V1", "make it better", true, "ASK fast_path_declined"],
  ["V2", "make it pop", true, "ASK fast_path_declined"],
  ["V3", "make it look good", true, "ASK fast_path_declined"],
  ["V4", "clean it up", true, "ASK fast_path_declined"],
  ["V5", "make it production quality", true, "ASK fast_path_declined"],
  ["T1", "make the jersy red", true, "RECOLOR[jersy]=red"],
  ["T2", "make the jersey rd", true, "ASK fast_path_declined"],
  ["T3", "make the kicks red", true, "RECOLOR[kicks]=red"],
  ["T4", "make my drip black", true, "RECOLOR[drip]=black"],
  ["P1", "make me jump", true, "ASK fast_path_declined"],
  ["P2", "change my pose", true, "ASK fast_path_declined"],
  ["P3", "make me face the camera", true, "ASK fast_path_declined"],
  ["P4", "raise my arms", true, "ASK person_mentioned"],
  ["P5", "make me smile", true, "ASK fast_path_declined"],
  ["L1", "match this look", true, "ASK fast_path_declined"],
  ["L2", "in this style", true, "ASK fast_path_declined"],
  ["L3", "same vibe as the second one", true, "ASK fast_path_declined"],
  [
    "L4",
    "make this picture match the style of the second",
    true,
    "ASK fast_path_declined",
  ],
  ["L5", "make it look like the second photo", true, "ASK fast_path_declined"],
  [
    "L6",
    "make this picture match the style of the second",
    true,
    "ASK fast_path_declined",
  ],
  ["K1", "swap my jersey to lululemon", true, "ASK fast_path_declined"],
  [
    "K2",
    "change my jersey to a lululemon jersey",
    true,
    "ASK fast_path_declined",
  ],
  ["K3", "swap my cleats to hoka", true, "ASK fast_path_declined"],
  ["K4", "change my jersey to stanford", true, "ASK fast_path_declined"],
  ["B1", "add a nike ball", true, "ASK fast_path_declined"],
  ["B2", "add a nike ball between my cleats", true, "ASK fast_path_declined"],
  [
    "B3",
    "add this nike ball on the ground next to me",
    true,
    "APPLY_DESIGN[ground next]=this nike ball",
  ],
  [
    "M1",
    "add 'shop now' at the bottom",
    true,
    "ADD_OBJECT[shop now]=at the bottom",
  ],
  [
    "M2",
    "put me in the middle of the frame",
    true,
    "CHANGE_BACKGROUND[person]=middle of the frame",
  ],
  ["CR1", "crop to 4:5", true, "ASK fast_path_declined"],
  ["CR2", "crop it square", true, "ASK fast_path_declined"],
  ["CR3", "make it 9:16", true, "ASK fast_path_declined"],
  ["CR4", "reformat for stories", true, "ASK fast_path_declined"],
  ["CR5", "zoom in on me", true, "ASK fast_path_declined"],
  ["CR6", "zoom out", true, "ASK fast_path_declined"],
  ["CA1", "make it a low angle shot", true, "ASK fast_path_declined"],
  ["CA2", "shoot it from below", true, "ASK fast_path_declined"],
  ["CA3", "make it an overhead shot", true, "ASK fast_path_declined"],
  ["CA4", "change the angle to from above", true, "ASK fast_path_declined"],
  [
    "LI1",
    "change the lighting to golden hour",
    true,
    "RECOLOR[lighting]=golden",
  ],
  ["LI2", "add studio lighting", true, "ASK add_unclear"],
  ["LI3", "add rim lighting", true, "ASK add_unclear"],
  ["LI4", "relight it with soft light", true, "ASK fast_path_declined"],
  ["LI5", "add stadium lighting", true, "ASK add_unclear"],
  ["X1", "make my jersey red", true, "RECOLOR[jersey]=red"],
  ["X2", "make it golden hour", true, "GLOBAL_STYLE[]=golden hour"],
  ["X3", "make the lighting dramatic", true, "GLOBAL_STYLE[]=dramatic"],
  ["X4", "remove my hat", true, "REMOVE_OBJECT[hat]=null"],
  ["X5", "add sunglasses", true, "ADD_OBJECT[sunglasses]=on my face"],
  [
    "X6",
    "change my jersey to adidas",
    true,
    "REPLACE_OBJECT[jersey]=adidas jersey",
  ],
  [
    "X7",
    "put a lululemon logo on my jersey",
    true,
    "APPLY_DESIGN[jersey]=lululemon logo",
  ],
  [
    "X8",
    "add a gatorade bottle next to me",
    true,
    "ADD_OBJECT[gatorade bottle]=next to me",
  ],
];

describe("flag off: every registered sentence routes exactly as Phase R measured it", () => {
  it.each(TODAY)("%s %s", (id, sentence, photo, today) => {
    off();
    expect(shown(read(sentence, { objects: id === "B3" ? 1 : 0 }, photo))).toBe(
      today,
    );
  });
});

describe("PR 19 — STUDIO_IMAGE_OPS on", () => {
  beforeEach(on);

  it.each([
    [
      "make the uniform white and adidas",
      "REPLACE_OBJECT[uniform]=white adidas uniform",
    ],
    [
      "make the socks white and adidas",
      "REPLACE_OBJECT[socks]=white adidas socks",
    ],
    [
      "make the cleats blue and adidas",
      "REPLACE_OBJECT[cleats]=blue adidas cleats",
    ],
  ])("E1–E3: 'and' joins her colour to the brand — %s", (s, want) => {
    expect(shown(read(s))).toBe(want);
  });

  it.each([
    ["make it rain", "same place in the rain"],
    ["change the weather to snow", "same place in the snow"],
    ["make it sunny", "same place on a sunny day"],
    ["make it a rainy day", "same place in the rain"],
  ])(
    "weather is a background, the same place in its weather (R-9) — %s",
    (s, value) => {
      const r = read(s);
      expect(r.steps).toEqual([
        {
          op: "CHANGE_BACKGROUND",
          targets: ["person"],
          value,
          scope: "SUBJECT_INVERSE",
        },
      ]);
    },
  );

  it.each([
    "make it better",
    "make it pop",
    "make it look good",
    "clean it up",
    "make it production quality",
  ])("a vague sentence asks `vague`, with the op chips (R-6) — %s", (s) => {
    const r = read(s);
    expect(r.initialPath).toBe("ASK");
    expect(r.reason).toBe("vague");
    expect(r.suggestions).toEqual(VAGUE_SUGGESTIONS);
  });

  it("every op chip is a sentence the rules read as a change on its own", () => {
    for (const s of VAGUE_SUGGESTIONS) {
      expect({ s, path: read(s).initialPath }).not.toEqual({ s, path: "ASK" });
    }
  });

  it.each([
    ["make the jersy red", "RECOLOR[jersey]=red", "make the jersey red"],
    ["make the jersey rd", "RECOLOR[jersey]=red", "make the jersey red"],
    ["make the kicks red", "RECOLOR[shoes]=red", "make the shoes red"],
    ["make my drip black", "RECOLOR[outfit]=black", "make my outfit black"],
  ])(
    "typos and slang read as the words the rules know (R-7) — %s",
    (s, want, readAs) => {
      const r = read(s);
      expect(shown(r)).toBe(want);
      // Detection and the freeze read the mapped words too.
      expect(r.readAs).toBe(readAs);
    },
  );

  it.each([
    "make me jump",
    "change my pose",
    "make me face the camera",
    "raise my arms",
    "make me smile",
  ])("a pose, an action or an expression is GENERATE (R-8) — %s", (s) => {
    const r = read(s);
    expect(r.initialPath).toBe("GENERATE");
    expect(r.steps.map((x) => x.op)).toEqual(["GENERATE"]);
  });

  it("the hard invariant still refuses a GENERATE that is not a pose, with a photo and no explicit ask", () => {
    const gen: Classification = {
      steps: [{ op: "GENERATE", targets: [], value: null, scope: "GLOBAL" }],
    };
    expect(validate(gen, true, "make the socks blue").reason).toBe(
      "generate_not_permitted",
    );
    expect(validate(gen, true, "make me jump").initialPath).toBe("GENERATE");
    off();
    expect(validate(gen, true, "make me jump").reason).toBe(
      "generate_not_permitted",
    );
  });

  it.each([
    "match this look",
    "in this style",
    "same vibe as the second one",
    "make this picture match the style of the second",
    "make it look like the second photo",
  ])(
    "the look pointer asks for a Style reference when none is attached (B) — %s",
    (s) => {
      const r = read(s);
      expect(r.initialPath).toBe("ASK");
      expect(r.reason).toBe("style_reference_missing");
    },
  );

  it("the look pointer routes to the style reference's look when one is attached (B, L6)", () => {
    const r = read("make this picture match the style of the second", {
      objects: 0,
      styles: 1,
    });
    expect(r.steps).toEqual([
      {
        op: "GLOBAL_STYLE",
        targets: [],
        value: "colour grade",
        scope: "GLOBAL",
        reference: "style",
      },
    ]);
  });

  it.each([
    ["swap my jersey to lululemon", "jersey", "lululemon jersey", "lululemon"],
    [
      "change my jersey to a Lululemon jersey",
      "jersey",
      "lululemon jersey",
      "Lululemon",
    ],
    ["swap my cleats to hoka", "cleats", "hoka cleats", "hoka"],
    ["change my jersey to stanford", "jersey", "stanford jersey", "stanford"],
  ])(
    "K33: a swap to a brand the rules do not list routes, her brand carried verbatim — %s",
    (s, target, value, brand) => {
      expect(read(s).steps).toEqual([
        {
          op: "REPLACE_OBJECT",
          targets: [target],
          value,
          scope: "REGION",
          brand,
        },
      ]);
    },
  );

  it("K33 never reads an adjective after `make` as a brand, and leaves a listed brand unfenced", () => {
    expect(read("make my jersey shiny").initialPath).toBe("ASK");
    expect(read("change my jersey to adidas").steps[0].brand).toBeUndefined();
  });

  it.each([
    ["add a nike ball between my cleats", 0, ["ball"], "between my cleats"],
    [
      "add this nike ball on the ground next to me",
      1,
      ["ball", "ground"],
      "on the ground next to me",
    ],
  ])(
    "R-22: a brand on an add is data on the thing, never a design — %s",
    (s, objects, targets, value) => {
      expect(read(s, { objects }).steps).toEqual([
        { op: "ADD_OBJECT", targets, value, scope: "REGION", brand: "nike" },
      ]);
    },
  );

  it("W-4: an add with no place said goes next to her — 'add a nike ball' and 'add a ball' alike (B1, ADI-R19-W)", () => {
    // ⚠️ MUTATION M-placeless: drop the placeless-add fallback — this reds by name.
    expect(read("add a nike ball").steps).toEqual([
      {
        op: "ADD_OBJECT",
        targets: ["ball"],
        value: "next to me",
        scope: "REGION",
        brand: "nike",
      },
    ]);
    expect(shown(read("add a ball"))).toBe("ADD_OBJECT[ball]=next to me");
    // …and a mark is still a design.
    expect(read("add a nike logo to my sleeve").steps[0].op).toBe(
      "APPLY_DESIGN",
    );
  });

  it("the frame-placing misroute still asks (R-25)", () => {
    expect(read("put me in the middle of the frame").initialPath).toBe("ASK");
  });

  it.each([
    ["crop to 4:5", "4:5"],
    ["crop it square", "1:1"],
    ["make it 9:16", "9:16"],
    ["reformat for stories", "9:16"],
    ["zoom in on me", "zoom"],
  ])(
    "a crop is CROP: an aspect, or a tighter window (S-7, R-10, R-11) — %s",
    (s, value) => {
      expect(read(s).steps).toEqual([
        { op: "CROP", targets: [], value, scope: "GLOBAL" },
      ]);
    },
  );

  it("'zoom out' is not a crop: wider than the photo is extend, which is faded", () => {
    expect(read("zoom out").initialPath).toBe("ASK");
  });

  it.each([
    ["make it a low angle shot", "low_angle"],
    ["shoot it from below", "low_angle"],
    ["make it an overhead shot", "overhead"],
    ["change the angle to from above", "high_angle"],
  ])("a camera angle is CAMERA (R-13) — %s", (s, angle) => {
    expect(read(s).steps).toEqual([
      { op: "CAMERA", targets: [], value: angle, scope: "GLOBAL" },
    ]);
  });

  it.each([
    ["change the lighting to golden hour", "golden_hour"],
    ["add studio lighting", "studio"],
    ["add rim lighting", "rim_light"],
    ["relight it with soft light", "soft_light"],
    ["add stadium lighting", "stadium"],
  ])("a lighting sentence is RELIGHT — %s", (s, member) => {
    expect(read(s).steps).toEqual([
      { op: "RELIGHT", targets: [], value: member, scope: "GLOBAL" },
    ]);
  });

  it.each([
    ["make my jersey red", "RECOLOR[jersey]=red"],
    ["make it golden hour", "GLOBAL_STYLE[]=golden hour"],
    ["make the lighting dramatic", "GLOBAL_STYLE[]=dramatic"],
    ["remove my hat", "REMOVE_OBJECT[hat]=null"],
    ["add sunglasses", "ADD_OBJECT[sunglasses]=on my face"],
    ["change my jersey to adidas", "REPLACE_OBJECT[jersey]=adidas jersey"],
    [
      "put a lululemon logo on my jersey",
      "APPLY_DESIGN[jersey]=lululemon logo",
    ],
    [
      "add a gatorade bottle next to me",
      "ADD_OBJECT[gatorade bottle]=next to me",
    ],
  ])("the controls route exactly as they did — %s", (s, want) => {
    expect(shown(read(s))).toBe(want);
  });
});

/**
 * THE WALK (ADI-R19-W): every sentence from Adi's Create Anything walk, verbatim, as a registered case — and the add
 * sweep W-4 asked for. With the switch on each reaches its ruled route; the flag-off table above is unchanged.
 */
describe("PR 19 — the walk's sentences, verbatim (ADI-R19-W)", () => {
  beforeEach(on);

  // W-3 (ADI-R19-W3): an ad of her photo is main's operation — the interpreter's ad treatment — so with the switch on
  // every ad sentence routes EXACTLY as it does off, except the one main made a new image of her photo for.
  it.each([
    "make this an ad for adidas",
    "turn this into an ad for adidas",
    "turn this into an adidas ad",
    "make this a magazine cover for nike",
    "make it for nike",
    "make it production quality for adidas",
    'make this an ad for adidas that says "OWN THE MOMENT"',
    "make this into an ad for stanford",
    "make this an ad",
  ])("W-3: an ad routes as main — %s", (sentence) => {
    off();
    const today = shown(read(sentence));
    on();
    expect(shown(read(sentence))).toBe(today);
    expect(today).toMatch(/^ASK /);
  });

  it("W-3: with her photo, 'make an ad for adidas' is the same ask as 'make this an ad for adidas' — never rule 0's generate", () => {
    off();
    expect(read("make an ad for adidas").steps[0].op).toBe("GENERATE");
    on();
    expect(shown(read("make an ad for adidas"))).toBe(
      shown(read("make this an ad for adidas")),
    );
  });

  it("W-1: with no photo an ad is still rule 0's generate", () => {
    expect(
      read("make an ad for adidas", { objects: 0 }, false).steps[0].op,
    ).toBe("GENERATE");
  });

  // W-3: her words on the photo, where she said, fenced. ⚠️ MUTATION M-text: drop the text-add reader — reds by name.
  it.each([
    ["add 'shop now' at the bottom", "shop now", "bottom"],
    ['put "GAME DAY" in the middle', "GAME DAY", "middle"],
    ["add 'swipe up' at the top", "swipe up", "top"],
  ] as const)("W-3: text on the photo — %s", (sentence, words, placement) => {
    const r = read(sentence);
    expect(r.steps).toEqual([
      expect.objectContaining({
        op: "DISPLAY_TEXT",
        value: words,
        placement,
        fencedText: true,
      }),
    ]);
  });

  // W-4: an add is always an edit. ⚠️ MUTATIONS M-behind, M-hold: drop the add-led BG guard / the hold reader.
  it.each([
    ["add a cone behind me", "ADD_OBJECT[cone]=behind me"],
    [
      "make me hold the gatorade bottle",
      "ADD_OBJECT[gatorade bottle]=in my hand",
    ],
    ["add a ball", "ADD_OBJECT[ball]=next to me"],
    ["add a trophy", "ADD_OBJECT[trophy]=next to me"],
    ["add a soccer ball next to me", "ADD_OBJECT[soccer ball]=next to me"],
    ["add a ball on the ground", "ADD_OBJECT[ball|ground]=on the ground"],
    ["add a phone in my hand", "ADD_OBJECT[phone]=in my hand"],
    ["add a hat", "ADD_OBJECT[hat]=on my head"],
  ])("W-4: an add is an edit — %s", (sentence, want) => {
    expect(shown(read(sentence))).toBe(want);
  });

  it("W-4: an add the rules cannot place asks — on her photo, never a generate", () => {
    for (const s of [
      "put a ball in my hand",
      "have me hold the ball over my head",
    ]) {
      const r = read(s);
      expect({ s, path: r.initialPath, reason: r.reason }).toEqual({
        s,
        path: "ASK",
        reason: "add_unclear",
      });
    }
  });

  // W-5: the camera. ⚠️ MUTATION M-angleAsk: drop the angle ask — "change the angle" reds by name.
  it("W-5: a bare 'change the angle' asks, with the three angle chips", () => {
    const r = read("change the angle");
    expect([r.initialPath, r.reason]).toEqual(["ASK", "angle_unclear"]);
    expect(r.suggestions).toEqual(ANGLE_SUGGESTIONS);
    // Each chip is a sentence the rules read as the angle it names.
    expect(
      ANGLE_SUGGESTIONS.map((c) => read(c).steps.map((x) => x.value)),
    ).toEqual([["low_angle"], ["high_angle"], ["overhead"]]);
  });

  it.each([
    ["shoot this from a low angle", "low_angle"],
    ["from above", "high_angle"],
    ["make it a low angle shot", "low_angle"],
    ["bird's eye view", "overhead"],
    ["shot from below", "low_angle"],
  ])("W-5: the walk's angle sentences are CAMERA — %s", (s, angle) => {
    expect(read(s).steps).toEqual([
      { op: "CAMERA", targets: [], value: angle, scope: "GLOBAL" },
    ]);
  });
});

describe("PR 19 — the ad's brand logo, like a watermark (ADI-R19-W3's logo rec)", () => {
  // ⚠️ MUTATION M-mark: drop the rule (classify.ts) — this reds by name.
  it("add the adidas logo as a watermark is BRAND_MARK — a brand the rules list only, and only with the switch on", () => {
    on();
    expect(read("add the adidas logo as a watermark").steps).toEqual([
      { op: "BRAND_MARK", targets: [], value: "adidas", scope: "GLOBAL" },
    ]);
    expect(read("add the stanford logo as a watermark").initialPath).toBe(
      "ASK",
    );
    off();
    expect(
      read("add the adidas logo as a watermark").steps.some(
        (s) => s.op === "BRAND_MARK",
      ),
    ).toBe(false);
  });
});
