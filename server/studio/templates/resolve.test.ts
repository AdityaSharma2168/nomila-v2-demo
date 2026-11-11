/**
 * resolve.test.ts — the rules-only resolver (quality-scrappy pieces 8 and 9, ADI-QS-3): the base key every image brief
 * compiles from, and the variants a published row may be written for, most specific first. That it picks TODAY'S
 * template on every golden cell is compile/golden.test.ts's (P9); that the first published candidate is what freezes is
 * templates/freeze.test.ts's.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M9b — a variant applies whatever the brief holds: "a variant is a candidate only where its condition holds" reds.
 *   M9c — two changes resolve to the first one's key: "two or more changes are a compound" reds.
 *   M9d — the ad's treatment is not read: "the ad treatment's intent is an ad, ahead of compound" reds.
 */
import type { CreativeBrief } from "../brief";
import type { FrozenEditIntent, NativeChange } from "../nativeEdit";
import { NATIVE_OP_KEYS, imageTemplateKey, resolveTemplate } from "./resolve";
import { REGISTRY_TEMPLATES } from "./render";

const brief = (
  job: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) =>
  ({
    job: { mode: "edit", references: [], ...job },
    brand: null,
    ...over,
  }) as unknown as CreativeBrief;
const intent = (...changes: Partial<NativeChange>[]): FrozenEditIntent =>
  ({
    version: 1,
    initialPath: "FULL_IMAGE",
    steps: [],
    changes: changes.map((c) => ({ target: null, change: null, ...c })),
    imageSize: "2K",
  }) as unknown as FrozenEditIntent;
const TREATMENT = {
  interpretation: {
    spans: [
      { quote: "a nike ad", reads: "treatment", edits: [], constraints: [] },
    ],
  },
};

describe("the base key (piece 8)", () => {
  it("a generate, a box she drew, and each operation a model is sent — every one a key the registry knows", () => {
    expect(imageTemplateKey(brief({ mode: "generate" }), null)).toBe(
      "studio.image.generate",
    );
    expect(imageTemplateKey(brief(), null)).toBe("studio.image.edit.masked");
    for (const [op, key] of Object.entries(NATIVE_OP_KEYS)) {
      expect(
        imageTemplateKey(brief(), intent({ op: op as NativeChange["op"] })),
      ).toBe(key);
      expect(key in REGISTRY_TEMPLATES).toBe(true);
    }
  });

  it("two or more changes are a compound", () => {
    expect(
      imageTemplateKey(
        brief(),
        intent({ op: "RECOLOR" }, { op: "CHANGE_BACKGROUND" }),
      ),
    ).toBe("studio.image.edit.compound");
  });

  it("the ad treatment's intent is an ad, ahead of compound — a typed sentence that reads like one is not", () => {
    const ad = intent(
      { op: "DISPLAY_TEXT" },
      { op: "CHANGE_BACKGROUND" },
      { op: "BRAND_MARK" },
    );
    expect(imageTemplateKey(brief(TREATMENT), ad)).toBe("studio.image.edit.ad");
    expect(imageTemplateKey(brief(), ad)).toBe("studio.image.edit.compound");
  });

  it("a crop is never sent to a model, so it has no key", () => {
    expect(
      imageTemplateKey(brief(), intent({ op: "CROP", change: "4:5" })),
    ).toBeNull();
  });
});

describe("the resolver's candidates (piece 9)", () => {
  const ALL = brief(
    {
      mode: "generate",
      references: [
        { role: "person", ref: "a" },
        { role: "person", ref: "b" },
        { role: "product", ref: "c" },
        { role: "style_reference", ref: "d", style: { look: "grain" } },
      ],
    },
    { brand: { name: "Brand" } },
  );

  it("most specific first — style, brand, product, her — and the base key last", () => {
    expect(resolveTemplate(ALL, null, "studio.image.generate")).toEqual({
      candidates: [
        "studio.image.generate+style",
        "studio.image.generate+brand",
        "studio.image.generate+product",
        "studio.image.generate+her",
        "studio.image.generate",
      ],
      inputs: {
        ops: ["generate"],
        ad: false,
        roles: ["person", "product", "style_reference"],
        brand: true,
        styleSpec: true,
      },
    });
  });

  it("a variant is a candidate only where its condition holds", () => {
    expect(
      resolveTemplate(
        brief({ mode: "generate" }),
        null,
        "studio.image.generate",
      ).candidates,
    ).toEqual(["studio.image.generate"]);
    // A style reference with no reading yet is not a style spec.
    const unread = brief({
      mode: "generate",
      references: [{ role: "style_reference", ref: "d" }],
    });
    expect(
      resolveTemplate(unread, null, "studio.image.generate").candidates,
    ).toEqual(["studio.image.generate"]);
  });

  it("records what it read: an edit's operations, and whether the ad treatment wrote them", () => {
    const ad = intent({ op: "DISPLAY_TEXT" }, { op: "BRAND_MARK" });
    expect(
      resolveTemplate(brief(TREATMENT), ad, "studio.image.edit.ad").inputs,
    ).toMatchObject({
      ops: ["DISPLAY_TEXT", "BRAND_MARK"],
      ad: true,
    });
    expect(
      resolveTemplate(brief(), null, "studio.image.edit.masked").inputs.ops,
    ).toEqual(["masked"]);
  });

  it("a clip's key stands alone — no variants — and records itself as a clip", () => {
    expect(
      resolveTemplate(ALL, null, "studio.video.identity-static"),
    ).toMatchObject({
      candidates: ["studio.video.identity-static"],
      inputs: { ops: ["clip"] },
    });
  });
});
