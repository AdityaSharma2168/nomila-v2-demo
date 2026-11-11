/**
 * PR 19's freeze (STUDIO_IMAGE_OPS): K9's colour, the carried brand, RELIGHT and CAMERA, and the frozen shape's new
 * fields refused where they do not belong. $0: the real classifier and freeze, synthetic detection labels.
 */
// brief.ts reads the database at assembly; this suite never assembles, so the module is stubbed (nativeIntent.test's).
jest.mock("../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import type { CreativeBrief, EditRegion, SourceAsset } from "./brief";
import { freezeEditIntent } from "./nativeIntent";
import { readNativeIntent, type FrozenEditIntent } from "./nativeEdit";

const region = (label: string): EditRegion => ({
  label,
  left: 10,
  top: 10,
  width: 200,
  height: 200,
});
const source = (labels: string[] = []): SourceAsset => ({
  mediaAssetId: "11111111-1111-4111-8111-111111111111",
  ref: "athletes/synthetic/frame.jpg",
  width: 1000,
  height: 1500,
  orientation: 1,
  editRegions: labels.map(region),
});
const freeze = (ask: string, labels: string[] = []) =>
  freezeEditIntent({ ask, origin: "system", source: source(labels) });
const changesOf = (ask: string, labels: string[] = []) => {
  const r = freeze(ask, labels);
  if (!r.ok) throw new Error(`"${ask}" did not freeze: ${r.reason}`);
  return r.intent.changes;
};

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.STUDIO_IMAGE_OPS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.STUDIO_IMAGE_OPS;
  else process.env.STUDIO_IMAGE_OPS = saved;
});

describe("K9: her colour, never the detector's", () => {
  it.each([
    ["make my jersey teal", ["blue jersey"], "blue", "teal"],
    [
      "make the jersey navy blue",
      ["navy blue jersey"],
      "navy blue",
      "navy blue",
    ],
    ["make the jersey navy blue", ["blue jersey"], "blue", "navy blue"],
    // F-WB7's control: every word of the label is hers, and it holds her colour — the label still wins.
    [
      "make the shorts black and green",
      ["black and green shorts"],
      "black and green",
      "black and green",
    ],
  ])("%s over %j — off: %s, on: %s", (ask, labels, off, on) => {
    delete process.env.STUDIO_IMAGE_OPS;
    expect(changesOf(ask, labels).map((c) => c.change)).toEqual([off]);
    process.env.STUDIO_IMAGE_OPS = "true";
    expect(changesOf(ask, labels).map((c) => c.change)).toEqual([on]);
  });
});

describe("the new operations and fields freeze, with the switch on", () => {
  beforeEach(() => {
    process.env.STUDIO_IMAGE_OPS = "true";
  });
  it("RELIGHT and CAMERA freeze a member with no target", () => {
    expect(changesOf("add studio lighting")).toEqual([
      { op: "RELIGHT", target: null, change: "studio" },
    ]);
    expect(changesOf("shoot it from below")).toEqual([
      { op: "CAMERA", target: null, change: "low_angle" },
    ]);
  });
  it("K33's brand rides on the replacement as the span to fence, in her words", () => {
    expect(changesOf("swap my jersey to Lululemon", ["blue jersey"])).toEqual([
      {
        op: "REPLACE_OBJECT",
        target: "jersey",
        change: "lululemon jersey",
        fenced: "Lululemon",
      },
    ]);
  });
  it("R-22's brand rides on the add", () => {
    expect(changesOf("add a nike ball between my cleats")).toEqual([
      {
        op: "ADD_OBJECT",
        target: null,
        change: null,
        add: {
          thing: "ball",
          place: "between my cleats",
          objectAssetId: null,
          brand: "nike",
        },
      },
    ]);
  });
});

describe("the frozen shape refuses the new fields where they do not belong", () => {
  const brief = (changes: unknown[]): CreativeBrief =>
    ({
      job: {
        mode: "edit",
        source: source(),
        editIntent: {
          version: 1,
          initialPath: "FULL_IMAGE",
          steps: [],
          changes,
        } as unknown as FrozenEditIntent,
      },
    }) as unknown as CreativeBrief;
  it("a fenced span outside its change, or on anything but a replacement, is not well-formed", () => {
    expect(
      readNativeIntent(
        brief([
          {
            op: "REPLACE_OBJECT",
            target: "jersey",
            change: "nike jersey",
            fenced: "puma",
          },
        ]),
      ).kind,
    ).toBe("invalid");
    expect(
      readNativeIntent(
        brief([
          { op: "RECOLOR", target: "jersey", change: "red", fenced: "red" },
        ]),
      ).kind,
    ).toBe("invalid");
  });
  it("a relight or a camera move names a member of its closed vocabulary, never free text", () => {
    expect(
      readNativeIntent(
        brief([{ op: "RELIGHT", target: null, change: "moonlight" }]),
      ).kind,
    ).toBe("invalid");
    expect(
      readNativeIntent(
        brief([{ op: "CAMERA", target: null, change: "dutch_angle" }]),
      ).kind,
    ).toBe("invalid");
  });
});
