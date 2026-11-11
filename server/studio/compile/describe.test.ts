/**
 * describe.test.ts — the card's plain-words lines (the interpreter, I.1). Pure: no network, no rows.
 *
 * The properties asserted hardest:
 *
 *   1. EVERY WORD OF WHAT CHANGES IS THE FROZEN INTENT'S. Provenance tags a line and may group lines; it
 *      never supplies a word. A recolour reads its frozen, detection-paired colour.
 *   2. A run of brand-required swaps reads as ONE line only when each swap compiles to exactly
 *      "<brand> <item>" — so "for adidas ones" is true of what the model is sent. Anything else stands
 *      on its own line.
 *   3. `preserve_person` names her face, hair, body and pose and never her clothes (Mia's M2): the line
 *      must not contradict a kit swap on the same card (plan v2's conflict C-4).
 */
import type { FrozenEditIntent, NativeChange } from "../nativeEdit";
import { describeIntent, type LineProvenance } from "./describe";

function intent(
  changes: NativeChange[],
  constraints?: FrozenEditIntent["constraints"],
): FrozenEditIntent {
  return {
    version: constraints ? 2 : 1,
    initialPath: "MASKED",
    steps: [],
    changes,
    imageSize: "2K",
    ...(constraints ? { constraints } : {}),
  };
}

const swap = (target: string, change: string): NativeChange => ({
  op: "REPLACE_OBJECT",
  target,
  change,
});

const byBrand = (away: string[] = ["nike"]) => ({
  source: "brand" as const,
  reason: { brand: "adidas", away },
});

const texts = (i: FrozenEditIntent, p?: LineProvenance) =>
  describeIntent(i, p).map((l) => [l.text, l.source]);

describe("the card's lines — the frozen intent's words, tagged by where they came from", () => {
  it("reads a recolour's FROZEN colour, whatever tagged it", () => {
    // The frozen change is detection's pairing ("navy"); the line can only say what compiles.
    const i = intent([{ op: "RECOLOR", target: "jersey", change: "navy" }]);
    expect(
      texts(i, { changes: [{ source: "yours" }], constraints: [] }),
    ).toEqual([["Make the jersey navy", "yours"]]);
  });

  it("leaves a line bare when nothing tagged it — a deterministic preview's card", () => {
    const i = intent([swap("jersey", "adidas jersey")]);
    expect(texts(i)).toEqual([["Swap your jersey for an adidas jersey", null]]);
  });

  it("groups a run of brand-required swaps for one brand into one line, with the brand's reason", () => {
    const i = intent([
      swap("jersey", "adidas jersey"),
      swap("socks", "adidas socks"),
      swap("cleats", "adidas cleats"),
    ]);
    const p: LineProvenance = {
      changes: [byBrand(), byBrand(), byBrand()],
      constraints: [],
    };
    expect(texts(i, p)).toEqual([
      [
        "Swap your jersey, socks and cleats for adidas ones — adidas ads can't show Nike",
        "brand",
      ],
    ]);
  });

  it("says a single brand-required swap as itself, with the reason", () => {
    const i = intent([swap("jersey", "adidas jersey")]);
    expect(texts(i, { changes: [byBrand()], constraints: [] })).toEqual([
      [
        "Swap your jersey for an adidas jersey — adidas ads can't show Nike",
        "brand",
      ],
    ]);
  });

  it("never groups a swap whose value is not exactly '<brand> <item>' — the line would claim what does not compile", () => {
    const i = intent([
      swap("jersey", "adidas jersey"),
      swap("socks", "black adidas socks"),
    ]);
    const p: LineProvenance = {
      changes: [byBrand(), byBrand()],
      constraints: [],
    };
    expect(texts(i, p)).toEqual([
      [
        "Swap your jersey for an adidas jersey — adidas ads can't show Nike",
        "brand",
      ],
      ["Swap your socks for black adidas socks", "brand"],
    ]);
  });

  it("never groups a swap of hers with the brand's", () => {
    const i = intent([
      swap("uniform", "adidas uniform"),
      swap("socks", "adidas socks"),
    ]);
    const p: LineProvenance = {
      changes: [{ source: "yours" }, byBrand()],
      constraints: [],
    };
    expect(texts(i, p)).toEqual([
      ["Swap your uniform for an adidas uniform", "yours"],
      [
        "Swap your socks for adidas socks — adidas ads can't show Nike",
        "brand",
      ],
    ]);
  });

  it("drops the reason when no brand's marks were named, and keeps the swap", () => {
    const i = intent([swap("jersey", "adidas jersey")]);
    expect(texts(i, { changes: [byBrand([])], constraints: [] })).toEqual([
      ["Swap your jersey for an adidas jersey", "brand"],
    ]);
  });

  it("keeps her face, hair, body and pose — never her clothes — and names a brand's logos in its own casing", () => {
    const i = intent(
      [swap("jersey", "adidas jersey")],
      [{ kind: "preserve_person" }, { kind: "exclude_marks", brand: "nike" }],
    );
    const lines = describeIntent(i, {
      changes: [byBrand()],
      constraints: ["suggested", "yours"],
    });
    expect(lines.filter((l) => l.kind === "constraint")).toEqual([
      {
        kind: "constraint",
        text: "Keep your face, hair, body and pose as they are",
        source: "suggested",
      },
      {
        kind: "constraint",
        text: "No Nike logos anywhere in the photo",
        source: "yours",
      },
    ]);
    // C-4: the keep line names no garment, so it cannot contradict the swap above it.
    expect(lines[1].text).not.toMatch(/cloth|kit|jersey|wear/i);
  });
});

describe("the card says placed or worn by the THING (wave A, G1)", () => {
  const add = (thing: string, place: string): NativeChange => ({
    op: "ADD_OBJECT",
    target: null,
    change: null,
    add: { thing, place, objectAssetId: null },
  });

  it("reads a bottle onto her head as placed, and a cap there as worn", () => {
    expect(texts(intent([add("water bottle", "onto my head")]))).toEqual([
      ["Add a water bottle onto your head", null],
    ]);
    expect(texts(intent([add("cap", "onto my head")]))).toEqual([
      ["Add a cap, worn on your head", null],
    ]);
  });
});
