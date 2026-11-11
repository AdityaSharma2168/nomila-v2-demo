/**
 * PR 19 (ADI-R19-W3): an ad of her photo in Create Anything is main's operation — the interpreter's ad treatment
 * (interpret/ad.ts): the brand's kit swap, a headline and a background, frozen as ONE edit of her photo. PR 19's rules
 * run with STUDIO_IMAGE_OPS on; this pins what they change about it — and the ONLY change is the logo rec's: a brand the
 * rules list gets its logo, like a watermark, in a slot that is spare. Every recorded ad reply (fixtures/r1.json, the
 * replay recorded.test.ts pins by hand) reads, freezes and compiles byte for byte the same with the switch on as off
 * when the ad is already at the four-change cap, and as main's plus exactly that one logo when it is not. $0: no model
 * is called — the replies ARE the fixture.
 *
 * ⚠️ MUTATION M-adTreatment: widen step 3's quoted-add guard to every quoted add (classify.ts, M-2's shape) — the
 * treatment's own `add the headline "…" across the top, and …` then asks, and the ad cells red by name.
 */
jest.mock("../../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import { readFileSync } from "fs";
import { join } from "path";
import { route } from "../classify";
import { compileNativeInstruction } from "../compile/assemble";
import { freezeEditIntent } from "../nativeIntent";
import { adPlan, adTreatment } from "./ad";
import { frozenConstraints, propose, type InterpretationInput } from "./core";
import type { Recording } from "./recorded";
import { parseReply } from "./reply";

const recording: Recording = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "r1.json"), "utf8"),
);
const ADS = recording.entries.filter((e) => e.brand);

const inputOf = (e: Recording["entries"][number]): InterpretationInput => ({
  sentence: e.sentence,
  attached: { objects: e.objects },
  treatment: e.brand ? adTreatment(e.brand, "Athletic Apparel") : null,
  menu: recording.menu,
});

/** The reading, the frozen intent and the compiled instruction — with STUDIO_IMAGE_OPS on or off. */
function operationOf(e: Recording["entries"][number], imageOps: boolean) {
  const saved = {
    ops: process.env.STUDIO_IMAGE_OPS,
    text: process.env.STUDIO_DISPLAY_TEXT,
  };
  process.env.STUDIO_DISPLAY_TEXT = "true";
  if (imageOps) process.env.STUDIO_IMAGE_OPS = "true";
  else delete process.env.STUDIO_IMAGE_OPS;
  try {
    const out = propose(inputOf(e), e.text, adPlan);
    if (out.kind !== "proposal") return { reading: out.kind };
    const regions = route(out.canonical, true, inputOf(e).attached)
      .steps.filter(
        (s) =>
          s.scope === "REGION" &&
          ![
            "ADD_OBJECT",
            "CHANGE_BACKGROUND",
            "GLOBAL_STYLE",
            "DISPLAY_TEXT",
          ].includes(s.op),
      )
      .map((s, i) => ({
        label: s.targets.join(" "),
        left: 400 + i * 700,
        top: 3500,
        width: 600,
        height: 600,
      }));
    const frozen = freezeEditIntent({
      ask: out.canonical,
      origin: "system",
      source: {
        mediaAssetId: "asset-1",
        ref: "athletes/synthetic/frame.jpg",
        width: 4000,
        height: 6000,
        editRegions: regions,
      },
      references: [],
      constraints: frozenConstraints(out.constraints),
    });
    return {
      reading: `C ${out.canonical}`,
      frozen: frozen.ok ? frozen.intent : `REFUSED ${frozen.reason}`,
      compiled: frozen.ok ? compileNativeInstruction(frozen.intent) : null,
    };
  } finally {
    if (saved.ops === undefined) delete process.env.STUDIO_IMAGE_OPS;
    else process.env.STUDIO_IMAGE_OPS = saved.ops;
    if (saved.text === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved.text;
  }
}

describe("the ad treatment is main's operation with STUDIO_IMAGE_OPS on (ADI-R19-W3)", () => {
  it("covers the ten recorded ad replies", () => {
    expect(ADS).toHaveLength(10);
  });

  it("the logo only takes a spare slot: the two nike cells get one, every cell at the cap does not", () => {
    const withLogo = ADS.filter((e) =>
      (operationOf(e, true).reading ?? "").includes("logo as a watermark"),
    ).map((e) => `${e.sentence} [${e.brand} ad]`);
    expect(withLogo).toEqual([
      "turn this into a nike ad [nike ad]",
      "make it look like a nike commercial [nike ad]",
    ]);
  });

  it.each(ADS.map((e) => [`${e.sentence} [${e.brand} ad]`, e] as const))(
    "%s — reads, freezes and compiles the same, one edit of her photo",
    (_name, e) => {
      const off = operationOf(e, false);
      const on = operationOf(e, true);
      // An edit of her photo that froze — never a new image, never a refusal — on and off.
      expect(off.reading).toMatch(/^C /);
      expect(on.reading).toMatch(/^C /);
      type Changes = { changes: { op: string; change: string | null }[] };
      const offChanges = (off.frozen as unknown as Changes).changes;
      const onChanges = (on.frozen as unknown as Changes).changes;
      if (offChanges.length >= 4) {
        // At the cap: the logo takes no slot, and the ad is main's, byte for byte.
        expect(on).toEqual(off);
        return;
      }
      // A spare slot: main's changes, in main's order, and the brand's logo last (compile/order.ts).
      expect(onChanges.slice(0, -1)).toEqual(offChanges);
      expect(onChanges.at(-1)).toMatchObject({
        op: "BRAND_MARK",
        change: e.brand,
      });
      expect(on.reading).toContain(`add the ${e.brand} logo as a watermark`);
      expect(on.compiled).toContain(
        `add the ${e.brand} logo as a small, clean brand mark`,
      );
    },
  );
});

describe("the logo is code's, for a brand the rules list (ADI-R19-W3's logo rec)", () => {
  const NONE = {
    decline: false,
    newImage: false,
    spans: [],
    edits: [],
    constraints: [],
    visibleMarks: [],
  };
  const planFor = (brand: string, imageOps: boolean) => {
    const saved = process.env.STUDIO_IMAGE_OPS;
    if (imageOps) process.env.STUDIO_IMAGE_OPS = "true";
    else delete process.env.STUDIO_IMAGE_OPS;
    try {
      return adPlan(
        {
          sentence: `turn this into a ${brand} ad`,
          attached: { objects: 0 },
          treatment: adTreatment(brand, "Athletic Apparel"),
          menu: recording.menu,
        },
        NONE,
      );
    } finally {
      if (saved === undefined) delete process.env.STUDIO_IMAGE_OPS;
      else process.env.STUDIO_IMAGE_OPS = saved;
    }
  };

  it("a brand the rules do not list gets no logo; a listed one does, and only with the switch on", () => {
    expect(planFor("nike", true).mark).toEqual({
      kind: "brand_mark",
      brand: "nike",
      source: "brand",
    });
    expect(planFor("Gatorade", true).mark).toBeUndefined();
    expect(planFor("nike", false).mark).toBeUndefined();
  });

  it("a model reply can never name it: a brand_mark edit in a reply is refused", () => {
    const reply = (edit: object) => JSON.stringify({ ...NONE, edits: [edit] });
    // Control: a reply with an edit of HER words parses. Both use "yours", so SUGGESTIBLE cannot be what refuses —
    // only the kind's absence from the model's menu (EDIT_KINDS) can.
    expect(
      parseReply(
        reply({
          kind: "recolor",
          target: "jersey",
          colour: "red",
          source: "yours",
        }),
      ),
    ).not.toBeNull();
    expect(
      parseReply(reply({ kind: "brand_mark", brand: "nike", source: "yours" })),
    ).toBeNull();
  });
});
