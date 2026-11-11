/**
 * identityPack.test — the best-3 chooser (PR 17, R-3), pure.
 *
 * REVERT CHECKS, red by name:
 *   "best-3 picks a small face"                    → sort faceSizeFrac ascending
 *   "pack overrides an explicit user reference"    → put pack picks first, or drop one of hers
 *   "pack competes with a product reference"       → count every role as a person slot
 *   "pack attaches to a product-only still"        → drop hasPersonIntent
 *   "pack attaches with the flag off"              → drop the `enabled` guard in previewBody
 */
import {
  addedFromPack,
  chooseBest,
  isBodyShot,
  hasPersonIntent,
  previewBody,
  rankPack,
  withPackReferences,
  type IdentityProfileWire,
  type PackEntryWire,
} from "./identityPack";
import type { PreviewRequest } from "../hooks/use-studio";

const e = (
  id: string,
  faceSizeFrac: number | null,
  prominence = 0.8,
  faceVisibility: "clear" | "partial" = "clear",
  shotType: string | null = "portrait",
): PackEntryWire => ({
  assetId: id,
  faceSizeFrac,
  prominence,
  faceVisibility,
  shotType,
});

const PACK: PackEntryWire[] = [
  e("small", 0.05, 0.99),
  e("mid", 0.2, 0.7),
  e("big", 0.4, 0.5),
  e("unmeasured", null, 1.0),
  e("bigger", 0.45, 0.4),
  e("partial-big", 0.45, 0.4, "partial"),
  ...Array.from({ length: 6 }, (_, i) => e(`filler${i}`, 0.1, 0.6)),
];

const profile = (
  over: Partial<IdentityProfileWire> = {},
): IdentityProfileWire => ({
  pack: PACK,
  incomplete: false,
  min: 10,
  max: 15,
  band: null,
  controlPassed: null,
  controlMeasuredAt: null,
  embedder: null,
  standing: "x",
  ...over,
});

const gen = (over: Partial<PreviewRequest> = {}): PreviewRequest => ({
  intent: "image.generate",
  deliverable: "post",
  objective: "grow-following",
  direction: "me at the stadium at golden hour",
  ...over,
});

describe("ranking", () => {
  it("best-3 picks a small face — the largest measured faces come first, unmeasured last", () => {
    expect(
      rankPack(PACK)
        .slice(0, 4)
        .map((x) => x.assetId),
    ).toEqual(["bigger", "partial-big", "big", "mid"]);
    expect(rankPack(PACK).at(-1)?.assetId).toBe("unmeasured");
  });

  it("a clear face outranks a partial one at the same size and prominence", () => {
    expect(
      rankPack([e("p", 0.3, 0.5, "partial"), e("c", 0.3, 0.5, "clear")]).map(
        (x) => x.assetId,
      ),
    ).toEqual(["c", "p"]);
  });

  it("P-chooser: the same pack and need give the same picks, in the same order, twice", () => {
    const a = chooseBest(PACK, 3, new Set());
    const b = chooseBest([...PACK].reverse(), 3, new Set());
    expect(a).toEqual(b);
    expect(a.map((x) => x.assetId)).toEqual(["bigger", "partial-big", "big"]);
  });

  it("skips what is already on the request", () => {
    // Slot 1 is the largest CLEAR face (the body-slot rule), so "big" now leads "partial-big".
    expect(
      chooseBest(PACK, 2, new Set(["bigger"])).map((x) => x.assetId),
    ).toEqual(["big", "partial-big"]);
  });
});

describe("person intent (ruling 1, 24 Sep 2026)", () => {
  it("a 'You' ref declares it; her words naming herself declare it", () => {
    expect(
      hasPersonIntent(
        gen({
          direction: "the stadium",
          references: [{ assetId: "a", role: "person" }],
        }),
      ),
    ).toBe(true);
    expect(hasPersonIntent(gen({ direction: "me at the stadium" }))).toBe(true);
    expect(hasPersonIntent(gen({ direction: "I'm holding the bottle" }))).toBe(
      true,
    );
  });

  it("pack attaches to a product-only still — a product ref with no person words is NOT a likeness ask", () => {
    expect(
      hasPersonIntent(
        gen({
          direction: "the bottle on a marble counter",
          references: [{ assetId: "p", role: "product" }],
        }),
      ),
    ).toBe(false);
    expect(
      hasPersonIntent(gen({ direction: "the bottle on a marble counter" })),
    ).toBe(false);
  });

  it("never on an edit, a clip, or a request with a frame", () => {
    expect(
      hasPersonIntent(
        gen({
          intent: "image.edit",
          sourceAssetId: "s",
          references: [{ assetId: "a", role: "person" }],
        }),
      ),
    ).toBe(false);
    expect(
      hasPersonIntent(
        gen({
          intent: "video.generate",
          references: [{ assetId: "a", role: "person" }],
        }),
      ),
    ).toBe(false);
    expect(hasPersonIntent(gen({ sourceAssetId: "s" }))).toBe(false);
  });
});

describe("withPackReferences", () => {
  it("zero explicit refs and her words naming her → three pack refs, appended", () => {
    const out = withPackReferences(gen(), profile());
    expect(out.references).toEqual([
      { assetId: "bigger", role: "person" },
      { assetId: "partial-big", role: "person" },
      { assetId: "big", role: "person" },
    ]);
  });

  it("pack overrides an explicit user reference — her picks stay first and untouched; the pack only fills what is left", () => {
    const mine = [
      { assetId: "mine1", role: "person" as const, label: "at practice" },
    ];
    const out = withPackReferences(gen({ references: mine }), profile());
    expect(out.references?.slice(0, 1)).toEqual(mine);
    expect(out.references).toHaveLength(3);
    expect(out.references?.slice(1).every((r) => r.role === "person")).toBe(
      true,
    );
  });

  it("P-explicit: three explicit picks → the pack is unused, request returned as-is", () => {
    const req = gen({
      references: [
        { assetId: "m1", role: "person" },
        { assetId: "m2", role: "person" },
        { assetId: "m3", role: "person" },
      ],
    });
    expect(withPackReferences(req, profile())).toBe(req);
  });

  it("P-explicit: 'just these' → zero pack refs at any count", () => {
    const req = gen({ references: [{ assetId: "m1", role: "person" }] });
    expect(withPackReferences(req, profile(), "just-these")).toBe(req);
    const bare = gen();
    expect(withPackReferences(bare, profile(), "just-these")).toBe(bare);
  });

  it("pack competes with a product reference — a product ref is neither counted nor moved; the pack fills person slots only", () => {
    const req = gen({
      references: [
        { assetId: "prod", role: "product", label: "the bottle" },
        { assetId: "m1", role: "person" },
      ],
    });
    const out = withPackReferences(req, profile());
    expect(out.references?.[0]).toEqual({
      assetId: "prod",
      role: "product",
      label: "the bottle",
    });
    expect(out.references?.[1]).toEqual({ assetId: "m1", role: "person" });
    expect(out.references?.filter((r) => r.role === "product")).toHaveLength(1);
    expect(out.references?.filter((r) => r.role === "person")).toHaveLength(3);
  });

  it("pack attaches to a product-only still — no person intent → the request is returned as-is", () => {
    const req = gen({
      direction: "the bottle on marble",
      references: [{ assetId: "prod", role: "product" }],
    });
    expect(withPackReferences(req, profile())).toBe(req);
  });

  it("never past the request cap: with five refs on it, one is added, not three", () => {
    const req = gen({
      references: [
        { assetId: "p1", role: "product" },
        { assetId: "p2", role: "product" },
        { assetId: "o1", role: "object" },
        { assetId: "o2", role: "object" },
        { assetId: "m", role: "person" },
      ],
    });
    const out = withPackReferences(req, profile());
    expect(out.references).toHaveLength(6);
    expect(out.references?.slice(0, 5)).toEqual(req.references);
  });

  it("an incomplete pack, or no profile, is never used", () => {
    const req = gen();
    expect(withPackReferences(req, profile({ incomplete: true }))).toBe(req);
    expect(withPackReferences(req, null)).toBe(req);
    expect(withPackReferences(req, profile({ pack: [] }))).toBe(req);
  });

  it("addedFromPack names exactly what the chooser appended", () => {
    const before = gen({ references: [{ assetId: "m1", role: "person" }] });
    expect(
      addedFromPack(before, withPackReferences(before, profile())),
    ).toEqual(["bigger", "partial-big"]);
  });
});

describe("previewBody — the flag", () => {
  it("pack attaches with the flag off — off, the body is the variables minus packPolicy, byte-identical", () => {
    const vars = { ...gen(), packPolicy: "top-up" as const };
    const body = previewBody(vars, profile(), false);
    expect(body).toEqual(gen());
    expect("packPolicy" in body).toBe(false);
    expect(JSON.stringify(body)).toBe(JSON.stringify(gen()));
  });

  it("on, the body is topped up; 'just-these' is stripped and honoured", () => {
    expect(previewBody({ ...gen() }, profile(), true).references).toHaveLength(
      3,
    );
    const just = previewBody(
      { ...gen(), packPolicy: "just-these" },
      profile(),
      true,
    );
    expect(just.references).toBeUndefined();
    expect("packPolicy" in just).toBe(false);
  });
});

describe("the body slot (walk-driven amendment to R-3, 24 Sep 2026)", () => {
  // Her row, as Adi read it: seven portraits outrank two action and one lifestyle shot.
  const HER: PackEntryWire[] = [
    e("p1", 0.38),
    e("p2", 0.32),
    e("a1", 0.212, 0.8, "clear", "action"),
    e("l1", 0.182, 0.8, "clear", "lifestyle"),
    e("p3", 0.17),
    e("p4", 0.16),
    e("p5", 0.15),
    e("p6", 0.14),
    e("p7", 0.13),
    e("a2", 0.12, 0.8, "clear", "action"),
  ];

  it("best-3 picks three close-ups from a mixed pack — slot 2 is the best body shot, not the third portrait", () => {
    expect(chooseBest(HER, 3, new Set()).map((x) => x.assetId)).toEqual([
      "p1",
      "a1",
      "p2",
    ]);
  });

  it("slot 1 is not the largest clear face — a larger PARTIAL face never leads", () => {
    const pack = [e("partial-huge", 0.6, 0.9, "partial"), ...HER];
    expect(chooseBest(pack, 3, new Set())[0].assetId).toBe("p1");
  });

  it("body slot ignored when shot.framing is wide — wide or medium framing puts the body shot first", () => {
    expect(chooseBest(HER, 3, new Set(), "wide").map((x) => x.assetId)).toEqual(
      ["a1", "p1", "p2"],
    );
    expect(
      chooseBest(HER, 3, new Set(), "medium").map((x) => x.assetId),
    ).toEqual(["a1", "p1", "p2"]);
    expect(
      chooseBest(HER, 3, new Set(), "close").map((x) => x.assetId),
    ).toEqual(["p1", "a1", "p2"]);
  });

  it("a pack with no body shot falls back to rank, and the framing reaches the chooser from the request", () => {
    const portraitsOnly = HER.filter((x) => !isBodyShot(x.shotType));
    expect(
      chooseBest(portraitsOnly, 3, new Set(), "wide").map((x) => x.assetId),
    ).toEqual(["p1", "p2", "p3"]);
    const out = withPackReferences(
      gen({ shot: { framing: "wide" } }),
      profile({ pack: HER }),
    );
    expect(out.references?.[0]).toEqual({ assetId: "a1", role: "person" });
  });

  it("still deterministic: the same pack, need and framing give the same picks twice", () => {
    expect(chooseBest([...HER].reverse(), 3, new Set(), "wide")).toEqual(
      chooseBest(HER, 3, new Set(), "wide"),
    );
  });
});
