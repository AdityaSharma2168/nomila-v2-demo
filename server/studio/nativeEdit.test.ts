/**
 * nativeEdit.test.ts — the native edit's compiler and frozen shape. Pure: no network, no rows.
 *
 * The properties asserted hardest:
 *
 *   1. For the sentences the probe measured, the compiled instruction IS the probe's prompt — Q5's
 *      exact words — followed by exactly one new sentence, the preservation clause. That is what
 *      makes sweep #2 a measurement of the model and not of a new compiler (PR N, D2).
 *   2. The preservation clause is on every compiled prompt, and its property list is pinned by a
 *      HAND-WRITTEN expectation. A test that looped over NATIVE_PRESERVATION would go green when an
 *      entry was deleted — the runbook's `GARMENT_NOUNS` lesson (docs/runbooks/verifying-a-guard-bites.md).
 *   3. An intent that cannot be run is `invalid`, never `none`: a brief quoted as a native edit must
 *      not quietly plan as a masked one.
 */
import {
  NATIVE_PRESERVATION,
  compileNativeInstruction,
  droppedWordsNote,
  intentsAgree,
  inventedObjectNote,
  isRegionFree,
  nativeResolutionNote,
  preservationClause,
  readNativeIntent,
  spatialPlace,
  type FrozenEditIntent,
  type NativeChange,
} from "./nativeEdit";
import { route } from "./classify";
import { ADD_FRAMING_LINE, buildNativePrompt, sceneLast } from "./compile";
import type { CreativeBrief } from "./brief";

/** Q5's measured full-frame prompts, verbatim from studioModelNativeProbe.ts's path-B cells. */
const Q5_SHORTS =
  "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.";
const Q5_SOCKS =
  "make the socks blue and green. Keep everything else exactly as-is — change only the socks.";

/** The clause with nothing waived — written out, not derived from the constant it pins. */
const CLAUSE_ALL =
  "Keep the original photograph's lighting, exposure, contrast, colour grade and scene exactly as they are.";

/**
 * The framing line a PLACED add carries (wave B, addition (a); compile/templates.ts has what measured
 * it). Imported rather than retyped, so a reword is one edit and this file cannot drift from the string
 * the model actually reads.
 */
const FRAMING = ADD_FRAMING_LINE;

function intent(
  changes: NativeChange[],
  over: Partial<FrozenEditIntent> = {},
): FrozenEditIntent {
  return {
    version: 1,
    initialPath: "FULL_IMAGE",
    steps: [
      { op: "RECOLOR", targets: ["shorts"], value: "black", scope: "REGION" },
    ],
    changes,
    imageSize: "4K",
    ...over,
  };
}

const recolour = (target: string, change: string): NativeChange => ({
  op: "RECOLOR",
  target,
  change,
});

describe("droppedWordsNote — B.1c's disclosure, read off the frozen steps", () => {
  /** The classifier's own steps for her sentence, frozen — never hand-written, so the two can't drift. */
  const brandIntent = (text: string) =>
    intent([], { initialPath: "MASKED", steps: route(text, true).steps });

  it("names what was dropped and what she will get — before she pays", () => {
    expect(
      droppedWordsNote(brandIntent("swap the cleats for Nike Mercurials")),
    ).toBe(
      "Specific models and details can't be matched — this will be nike cleats, not mercurials specifically.",
    );
  });

  it("lists each item's result, and the words they dropped once — the degrade is per item", () => {
    expect(
      droppedWordsNote(
        brandIntent("change my socks and shoes to nike elite ones"),
      ),
    ).toBe(
      "Specific models and details can't be matched — this will be nike socks and nike shoes, not elite specifically.",
    );
  });

  it("says nothing when nothing was dropped", () => {
    expect(
      droppedWordsNote(brandIntent("change my jersey to adidas")),
    ).toBeNull();
    expect(droppedWordsNote(intent([recolour("shorts", "black")]))).toBeNull();
  });
});

describe("the compiled instruction is the probe's prompt, plus exactly one sentence", () => {
  it("compiles the shorts cell to Q5's words verbatim, then the preservation clause", () => {
    const compiled = compileNativeInstruction(
      intent([recolour("shorts", "black and green")]),
    );
    expect(compiled).toBe(`${Q5_SHORTS} ${CLAUSE_ALL}`);
  });

  it("and the socks cell the same way", () => {
    const compiled = compileNativeInstruction(
      intent([recolour("socks", "blue and green")]),
    );
    expect(compiled).toBe(`${Q5_SOCKS} ${CLAUSE_ALL}`);
  });

  it("compiles two targets into ONE instruction, each with its own colour", () => {
    // The one-call compound — the DESIGN, not settled capability (see the module header). What is
    // pinned is only that each target carries its own change and both land in one prompt.
    expect(
      compileNativeInstruction(
        intent([recolour("jersey", "red"), recolour("shorts", "black")]),
      ),
    ).toBe(
      "make the jersey red, and make the shorts black. Keep everything else exactly as-is — change " +
        `only the jersey and the shorts. ${CLAUSE_ALL}`,
    );
  });

  it("gives each operation its own clause and scope", () => {
    expect(
      compileNativeInstruction(
        intent([
          { op: "APPLY_DESIGN", target: "jersey", change: "adidas logo" },
        ]),
      ),
    ).toBe(
      `add adidas logo to the jersey. Keep everything else exactly as-is — change only the jersey. ${CLAUSE_ALL}`,
    );
    expect(
      compileNativeInstruction(
        intent([{ op: "REMOVE_OBJECT", target: "ball", change: null }]),
      ),
    ).toBe(
      "remove the ball and fill the space where it was with what naturally lies behind it. Keep " +
        `everything else exactly as-is — change only the ball. ${CLAUSE_ALL}`,
    );
    // Q2's own wording for the kept subject — "keep the person exactly as-is".
    expect(
      compileNativeInstruction(
        intent([
          { op: "CHANGE_BACKGROUND", target: null, change: "beach at sunset" },
        ]),
      ),
    ).toBe(
      "change the background to beach at sunset. Keep the person exactly as-is — change only the " +
        "background. Keep the original photograph's lighting, exposure, contrast and colour grade " +
        "exactly as they are.",
    );
    // A BLUR IS A TREATMENT OF THE BACKGROUND, NOT A REPLACEMENT OF IT (wave D, card 4 / A14) — so it
    // gets its own line. "change the background to blurred" is what a bare value would have compiled.
    expect(
      compileNativeInstruction(
        intent([{ op: "CHANGE_BACKGROUND", target: null, change: "blurred" }]),
      ),
    ).toBe(
      "blur the background, keeping the subject sharp and exactly as it is. Keep the person exactly " +
        "as-is — change only the background. Keep the original photograph's lighting, exposure, " +
        "contrast and colour grade exactly as they are.",
    );
    expect(
      compileNativeInstruction(
        intent([
          { op: "GLOBAL_STYLE", target: null, change: "black and white" },
        ]),
      ),
    ).toBe(
      "give the whole photograph this look: black and white. Keep everything in the photograph " +
        "exactly where and what it is — change only its overall look. Keep the original " +
        "photograph's scene exactly as it is.",
    );
  });

  it("never tells an add beside a background or a look to 'change only the background' (composition)", () => {
    // The lone background's scope sentence would contradict the add clause before it.
    const ball: NativeChange = {
      op: "ADD_OBJECT",
      target: null,
      change: null,
      add: { thing: "soccer ball", place: "at her feet", objectAssetId: null },
    };
    expect(
      compileNativeInstruction(
        intent([
          ball,
          { op: "CHANGE_BACKGROUND", target: null, change: "stadium" },
        ]),
      ),
    ).toBe(
      "add a soccer ball, place it at the person's feet, and change the background to stadium. " +
        "Keep everything else exactly as-is — change only the added soccer ball and the background. " +
        "Keep the original photograph's lighting, exposure, contrast and colour grade exactly as they are. " +
        `${FRAMING}`,
    );
    expect(
      compileNativeInstruction(
        intent([
          ball,
          { op: "GLOBAL_STYLE", target: null, change: "black and white" },
        ]),
      ),
    ).toContain(
      "Keep everything else exactly as-is — change only the added soccer ball and the overall look.",
    );
  });
});

describe("spatialPlace — her place, with the person named as 'the person' (C.2)", () => {
  it("turns her possessives into the person's, whoever typed them", () => {
    expect(spatialPlace("in the middle of my cleats")).toBe(
      "in the middle of the person's cleats",
    );
    expect(spatialPlace("on top of her head")).toBe(
      "on top of the person's head",
    );
    expect(spatialPlace("on the grass beside her right foot")).toBe(
      "on the grass beside the person's right foot",
    );
  });

  it("turns a pronoun that names her into the person — 'her' by where it sits", () => {
    expect(spatialPlace("on the grass next to me")).toBe(
      "on the grass next to the person",
    );
    expect(spatialPlace("next to her")).toBe("next to the person");
  });

  it("leaves a place that does not name her exactly as she said it", () => {
    expect(spatialPlace("between the cleats")).toBe("between the cleats");
    expect(spatialPlace("on the grass")).toBe("on the grass");
  });
});

describe("a thing PLACED on a part of her is placed, and only a worn thing is worn (wave A, G1)", () => {
  const add = (thing: string, place: string): NativeChange => ({
    op: "ADD_OBJECT",
    target: null,
    change: null,
    add: { thing, place, objectAssetId: null },
  });

  it("words a bottle onto her head as a placement — the head is on the worn-place table, the bottle is not worn", () => {
    expect(
      compileNativeInstruction(intent([add("water bottle", "onto my head")])),
    ).toMatch(/^add a water bottle, place it onto the person's head\./);
    expect(
      compileNativeInstruction(intent([add("soccer ball", "near my feet")])),
    ).toMatch(/^add a soccer ball, place it near the person's feet\./);
  });

  it("still words a worn thing on the same place as worn (PR M3)", () => {
    expect(
      compileNativeInstruction(intent([add("cap", "onto my head")])),
    ).toMatch(/^add a cap, worn on the person's head\./);
  });
});

describe("an add is addressed by the manifest's own number, and says so when nothing is attached (C.3)", () => {
  const add = (objectAssetId: string | null): NativeChange => ({
    op: "ADD_OBJECT",
    target: null,
    change: null,
    add: { thing: "soccer ball", place: "between her cleats", objectAssetId },
  });
  const ADD_STEP = {
    op: "ADD_OBJECT" as const,
    targets: ["soccer ball"],
    value: "between her cleats",
    scope: "REGION" as const,
  };

  it("points at the object photo by the number it was given — Q1's q1-a shape", () => {
    expect(
      compileNativeInstruction(intent([add("ball-asset")]), { objectImage: 2 }),
    ).toBe(
      "add the soccer ball from Image 2, place it between the person's cleats. " +
        `Keep everything else exactly as-is — only add the soccer ball. ${CLAUSE_ALL} ${FRAMING}`,
    );
  });

  it("never invents a number it was not given", () => {
    expect(compileNativeInstruction(intent([add("ball-asset")]))).toMatch(
      /^add the soccer ball from the object image, place it/,
    );
  });

  it("invents the object, with an indefinite, when no photo is attached — q1-d's shape", () => {
    expect(compileNativeInstruction(intent([add(null)]))).toMatch(
      /^add a soccer ball, place it between the person's cleats\./,
    );
  });

  it("tells her before she pays when nothing of hers is being placed — and not when it is", () => {
    expect(inventedObjectNote(intent([add(null)]))).toBe(
      "No photo of the soccer ball is attached, so the edit will invent one. " +
        "To add yours, attach it with the Object tile.",
    );
    expect(inventedObjectNote(intent([add("ball-asset")]))).toBeNull();
  });

  it("names EVERY thing it will invent when a composed sentence adds two (4a) — and not the advice that would refuse", () => {
    const bottle: NativeChange = {
      op: "ADD_OBJECT",
      target: null,
      change: null,
      add: { thing: "red bottle", place: "on the grass", objectAssetId: null },
    };
    expect(inventedObjectNote(intent([add(null), bottle]))).toBe(
      "No photos of the soccer ball and the red bottle are attached, so the edit will invent them. " +
        "To use your own, add them one at a time with the Object tile.",
    );
    // "Attach it with the Object tile" would lead her into ambiguous_object: one photo, two adds.
    expect(inventedObjectNote(intent([add(null), bottle]))).not.toMatch(
      /attach it/,
    );
    // One invented beside a recolour is the lone-add line, word for word.
    expect(
      inventedObjectNote(intent([add(null), recolour("jersey", "blue")])),
    ).toBe(inventedObjectNote(intent([add(null)])));
  });

  it("REFUSES an add naming an object photo the brief does not carry", () => {
    const briefWith = (refs: { role: string; mediaAssetId: string }[]) =>
      ({
        job: {
          mode: "edit",
          source: { width: 1008, height: 1476, editRegions: [] },
          references: refs.map((r) => ({ ...r, ref: `x/${r.mediaAssetId}` })),
          editIntent: intent([add("ball-asset")], { steps: [ADD_STEP] }),
        },
      }) as unknown as CreativeBrief;

    expect(
      readNativeIntent(
        briefWith([{ role: "object", mediaAssetId: "ball-asset" }]),
      ).kind,
    ).toBe("native");
    // Gone, or carried under another role: either way the instruction would point at nothing. (A lone
    // PRODUCT photo was this line until C3 — it is an add's thing now; see the next test.)
    expect(readNativeIntent(briefWith([])).kind).toBe("invalid");
    expect(
      readNativeIntent(
        briefWith([{ role: "person", mediaAssetId: "ball-asset" }]),
      ).kind,
    ).toBe("invalid");
  });

  it("lets an add name her lone PRODUCT photo only where the freeze would have bound it (C3)", () => {
    const briefWith = (refs: { role: string; mediaAssetId: string }[]) =>
      ({
        job: {
          mode: "edit",
          source: { width: 1008, height: 1476, editRegions: [] },
          references: refs.map((r) => ({ ...r, ref: `x/${r.mediaAssetId}` })),
          editIntent: intent([add("bottle-asset")], { steps: [ADD_STEP] }),
        },
      }) as unknown as CreativeBrief;
    const read = (refs: { role: string; mediaAssetId: string }[]) =>
      readNativeIntent(briefWith(refs)).kind;

    // No Object photo, one product, and it is the one named.
    expect(read([{ role: "product", mediaAssetId: "bottle-asset" }])).toBe(
      "native",
    );
    // An Object photo on the brief is the add's thing, so a product named beside it is not what the freeze wrote.
    expect(
      read([
        { role: "object", mediaAssetId: "ball-asset" },
        { role: "product", mediaAssetId: "bottle-asset" },
      ]),
    ).toBe("invalid");
    // Two products: the freeze asked which, so an intent naming one of them was not frozen here.
    expect(
      read([
        { role: "product", mediaAssetId: "bottle-asset" },
        { role: "product", mediaAssetId: "boot-asset" },
      ]),
    ).toBe("invalid");
    // One product, but not the one named.
    expect(read([{ role: "product", mediaAssetId: "boot-asset" }])).toBe(
      "invalid",
    );
  });
});

describe("a replacement with her photo points at it by the manifest's own number (replace with reference, R.2)", () => {
  const hoops: NativeChange = {
    op: "REPLACE_OBJECT",
    target: "earrings",
    change: "gold hoops",
    object: { objectAssetId: "hoops-asset" },
  };
  const REPLACE_STEP = {
    op: "REPLACE_OBJECT" as const,
    targets: ["earrings"],
    value: "gold hoops",
    scope: "REGION" as const,
  };

  it("names her thing and the image it is in — the add's measured shape, with her noun", () => {
    expect(compileNativeInstruction(intent([hoops]), { objectImage: 2 })).toBe(
      "replace the earrings with the gold hoops from Image 2. " +
        `Keep everything else exactly as-is — change only the earrings. ${CLAUSE_ALL}`,
    );
  });

  it("never invents a number it was not given", () => {
    expect(compileNativeInstruction(intent([hoops]))).toMatch(
      /^replace the earrings with the gold hoops from the object image\. /,
    );
  });

  it("leaves a replacement with no photo exactly as it was — rule 4c's brand change", () => {
    // The addressing is ignored when there is nothing to address: a brand change points at no image.
    expect(
      compileNativeInstruction(
        intent([
          { op: "REPLACE_OBJECT", target: "jersey", change: "adidas jersey" },
        ]),
        { objectImage: 2 },
      ),
    ).toBe(
      "replace the jersey with adidas jersey. " +
        `Keep everything else exactly as-is — change only the jersey. ${CLAUSE_ALL}`,
    );
  });

  it("REFUSES a replacement naming an object photo the brief does not carry", () => {
    const briefWith = (refs: { role: string; mediaAssetId: string }[]) =>
      ({
        job: {
          mode: "edit",
          source: { width: 1008, height: 1476, editRegions: [] },
          references: refs.map((r) => ({ ...r, ref: `x/${r.mediaAssetId}` })),
          editIntent: intent([hoops], { steps: [REPLACE_STEP] }),
        },
      }) as unknown as CreativeBrief;

    expect(
      readNativeIntent(
        briefWith([{ role: "object", mediaAssetId: "hoops-asset" }]),
      ).kind,
    ).toBe("native");
    expect(readNativeIntent(briefWith([])).kind).toBe("invalid");
    // ⚠️ FLIPPED BY CARD 4. This asserted `invalid` for a PRODUCT carrying the very id the intent
    // names — the C3 scope, where only an add could bind a product. It is `native` now, and this
    // validator agreeing with the freeze is the whole point: while it disagreed, a correct intent came
    // back "saved in a form we can't run any more", which is a false statement about her own request.
    expect(
      readNativeIntent(
        briefWith([{ role: "product", mediaAssetId: "hoops-asset" }]),
      ).kind,
    ).toBe("native");
    // The GUARD this test exists for is untouched, and is worth stating on the product arm too: a
    // photo the brief does not carry is still invalid, whichever tile it claims to be in.
    expect(
      readNativeIntent(
        briefWith([{ role: "product", mediaAssetId: "some-other-asset" }]),
      ).kind,
    ).toBe("invalid");
    // And an Object photo present alongside means the OBJECT is the thing — a product with a
    // different id cannot stand in for it.
    expect(
      readNativeIntent(
        briefWith([
          { role: "object", mediaAssetId: "not-the-hoops" },
          { role: "product", mediaAssetId: "hoops-asset" },
        ]),
      ).kind,
    ).toBe("invalid");
  });

  it("REFUSES a photo on any change but a replacement, and a replacement photo with no id", () => {
    const withRefs = (changes: NativeChange[]) =>
      ({
        job: {
          mode: "edit",
          source: { width: 1008, height: 1476, editRegions: [] },
          references: [
            { role: "object", mediaAssetId: "hoops-asset", ref: "x/hoops" },
          ],
          editIntent: intent(changes, { steps: [REPLACE_STEP] }),
        },
      }) as unknown as CreativeBrief;

    expect(readNativeIntent(withRefs([hoops])).kind).toBe("native");
    expect(
      readNativeIntent(
        withRefs([{ ...recolour("earrings", "gold"), object: hoops.object }]),
      ).kind,
    ).toBe("invalid");
    expect(
      readNativeIntent(withRefs([{ ...hoops, object: { objectAssetId: "" } }]))
        .kind,
    ).toBe("invalid");
  });
});

describe("a replacement never reads as invented — that is an add's arm, and only an add's (replace with reference, R.3)", () => {
  it("says nothing of inventing for a replacement, with her photo or as a brand change — and still says it for an add with none", () => {
    const hoops: NativeChange = {
      op: "REPLACE_OBJECT",
      target: "earrings",
      change: "gold hoops",
      object: { objectAssetId: "hoops-asset" },
    };
    const brand: NativeChange = {
      op: "REPLACE_OBJECT",
      target: "jersey",
      change: "adidas jersey",
    };
    const inventedBall: NativeChange = {
      op: "ADD_OBJECT",
      target: null,
      change: null,
      add: { thing: "soccer ball", place: "at her feet", objectAssetId: null },
    };
    expect(inventedObjectNote(intent([hoops]))).toBeNull();
    expect(inventedObjectNote(intent([brand]))).toBeNull();
    // Beside an invented add, the note names the add's thing and never the replacement's.
    expect(inventedObjectNote(intent([hoops, inventedBall]))).toBe(
      "No photo of the soccer ball is attached, so the edit will invent one. " +
        "To add yours, attach it with the Object tile.",
    );
  });
});

describe("the preservation clause — REQUIRED on every prompt, and pinned by hand", () => {
  it("names exactly these five properties, in this order", () => {
    // Hand-written. Deleting one from NATIVE_PRESERVATION must turn this red.
    expect(NATIVE_PRESERVATION.properties).toEqual([
      "lighting",
      "exposure",
      "contrast",
      "colour grade",
      "scene",
    ]);
  });

  it("waives only what the request is itself about", () => {
    expect(NATIVE_PRESERVATION.waivedBy).toEqual({
      GLOBAL_STYLE: ["lighting", "exposure", "contrast", "colour grade"],
      CHANGE_BACKGROUND: ["scene"],
      // PR 19: a relight is about the light; a camera move shows the scene from somewhere else.
      RELIGHT: ["lighting", "exposure", "contrast", "colour grade"],
      CAMERA: ["scene"],
    });
    // A recolour, a design, a removal and a replacement change a THING, and keep every property.
    for (const op of [
      "RECOLOR",
      "APPLY_DESIGN",
      "REMOVE_OBJECT",
      "REPLACE_OBJECT",
    ] as const) {
      expect(preservationClause([op])).toBe(CLAUSE_ALL);
    }
  });

  it("is on the compiled prompt of every operation a native edit can run", () => {
    const every: NativeChange[] = [
      recolour("socks", "blue"),
      { op: "APPLY_DESIGN", target: "jersey", change: "number 10" },
      { op: "REPLACE_OBJECT", target: "ball", change: "a basketball" },
      { op: "REMOVE_OBJECT", target: "cone", change: null },
      { op: "CHANGE_BACKGROUND", target: null, change: "packed stadium" },
      { op: "GLOBAL_STYLE", target: null, change: "golden hour" },
    ];
    for (const c of every) {
      expect({
        op: c.op,
        compiled: compileNativeInstruction(intent([c])),
      }).toEqual({
        op: c.op,
        compiled: expect.stringContaining("Keep the original photograph's"),
      });
    }
  });
});

// ─── Reading an intent back off a brief ─────────────────────────────────────────────────────────

function brief(job: Record<string, unknown>): CreativeBrief {
  return {
    job: {
      mode: "edit",
      source: {
        mediaAssetId: "a",
        ref: "athletes/x/frame.jpg",
        width: 4000,
        height: 6000,
        editRegions: [],
      },
      ...job,
    },
  } as unknown as CreativeBrief;
}

describe("readNativeIntent — none, runnable, or refused; never quietly none", () => {
  const good = intent([recolour("shorts", "black and green")]);

  it("reads a brief with no intent as none — every flag-off brief", () => {
    expect(readNativeIntent(brief({}))).toEqual({ kind: "none" });
  });

  it("reads a well-formed intent on an edit as native", () => {
    expect(readNativeIntent(brief({ editIntent: good }))).toEqual({
      kind: "native",
      intent: good,
    });
  });

  it("refuses an intent it cannot run, rather than ignoring it", () => {
    const cases: Record<string, CreativeBrief> = {
      "unknown version": brief({ editIntent: { ...good, version: 2 } }),
      "unknown size": brief({ editIntent: { ...good, imageSize: "8K" } }),
      "a GENERATE step": brief({
        editIntent: {
          ...good,
          steps: [
            { op: "GENERATE", targets: [], value: null, scope: "GLOBAL" },
          ],
        },
      }),
      "a recolour with no colour": brief({
        editIntent: {
          ...good,
          changes: [{ op: "RECOLOR", target: "shorts", change: null }],
        },
      }),
      "no changes at all": brief({ editIntent: { ...good, changes: [] } }),
      "an intent on a generate": brief({
        mode: "generate",
        source: null,
        editIntent: good,
      }),
    };
    for (const [name, b] of Object.entries(cases)) {
      expect({ name, kind: readNativeIntent(b).kind }).toEqual({
        name,
        kind: "invalid",
      });
    }
  });
});

describe("intentsAgree — the spend-time re-check's comparison", () => {
  const frozenFrom = (sentence: string): FrozenEditIntent => {
    const r = route(sentence, true);
    return intent([recolour("socks", "blue")], {
      initialPath: r.initialPath,
      steps: r.steps,
    });
  };

  it("agrees with the same sentence classified again", () => {
    expect(
      intentsAgree(
        frozenFrom("make the socks blue"),
        route("make the socks blue", true),
      ),
    ).toBe(true);
  });

  it("disagrees on a changed value, a changed target, or an ASK", () => {
    const frozen = frozenFrom("make the socks blue");
    expect(intentsAgree(frozen, route("make the socks red", true))).toBe(false);
    expect(intentsAgree(frozen, route("make the shorts blue", true))).toBe(
      false,
    );
    expect(
      intentsAgree(frozen, route("do something cool with this", true)),
    ).toBe(false);
  });

  it("disagrees when one points at her photo and the other does not (replace with reference)", () => {
    const pointed = route("change my earrings to these gold hoops", true, {
      objects: 1,
    });
    const frozen = intent([recolour("earrings", "gold")], {
      initialPath: pointed.initialPath,
      steps: pointed.steps,
    });
    expect(intentsAgree(frozen, pointed)).toBe(true);
    // The same op, targets, value and scope, with the pointer gone: a replacement that would no longer
    // name her photo is a different edit from the one she was quoted.
    const unpointed = {
      ...pointed,
      steps: pointed.steps.map(({ reference: _gone, ...s }) => s),
    };
    expect(intentsAgree(frozen, unpointed)).toBe(false);
  });

  it("⚠️ disagrees when the PER-TARGET colours differ — card 2's field is inside the gate", () => {
    // A field that decides which garment becomes which colour may not sit outside the quote-vs-spend
    // re-check. `op`, `targets`, `value` and `scope` are IDENTICAL across these two, so without
    // `values` in the key the gate would call them the same edit and spend on the wrong render.
    const quoted = route("make the jersey red and the shorts black", true);
    expect(quoted.steps[0].values).toEqual(["red", "black"]);
    const frozen = intent([recolour("jersey", "red")], {
      initialPath: quoted.initialPath,
      steps: quoted.steps,
    });
    expect(intentsAgree(frozen, quoted)).toBe(true);
    const swapped = {
      ...quoted,
      steps: quoted.steps.map((st) => ({ ...st, values: ["black", "red"] })),
    };
    expect(intentsAgree(frozen, swapped)).toBe(false);
    // And an intent frozen BEFORE card 2 — same step, no pairing — is a different edit from the one
    // the rules read now. It refuses once and she re-quotes, rather than spending on the old reading.
    const before = intent([recolour("jersey", "red")], {
      initialPath: quoted.initialPath,
      steps: quoted.steps.map(({ values: _gone, ...st }) => st),
    });
    expect(intentsAgree(before, quoted)).toBe(false);
  });
});

describe("nativeResolutionNote — the fidelity loss, said out loud (N.3)", () => {
  const at = (imageSize: FrozenEditIntent["imageSize"]) =>
    intent([recolour("shorts", "black and green")], { imageSize });

  it("names both sizes in whole megapixels when the tier returns less than her photo", () => {
    expect(nativeResolutionNote(at("4K"), { width: 4000, height: 6000 })).toBe(
      "An edit comes back at about 17 megapixels, and your photo is 24 — so the edited version " +
        "will be smaller than the original.",
    );
  });

  it("is null when the tier covers the photo, and null for a frame nobody measured", () => {
    expect(
      nativeResolutionNote(at("2K"), { width: 1008, height: 1476 }),
    ).toBeNull();
    expect(
      nativeResolutionNote(at("4K"), { width: 4096, height: 4096 }),
    ).toBeNull();
    expect(
      nativeResolutionNote(at("4K"), { width: null, height: null }),
    ).toBeNull();
  });
});

// ─── PR T — a headline (DISPLAY_TEXT): q6-t1's clause, scoped as an add, after the background ───────

describe("a headline compiles to q6-t1's measured words, scoped as an add, and waives nothing (PR T, T.3)", () => {
  const headline = (words: string): NativeChange => ({
    op: "DISPLAY_TEXT",
    target: null,
    change: words,
  });
  const background: NativeChange = {
    op: "CHANGE_BACKGROUND",
    target: null,
    change: "stadium",
  };
  const look: NativeChange = {
    op: "GLOBAL_STYLE",
    target: null,
    change: "black and white",
  };

  it("is q6-t1's sentence with her words where GET LOUD was — only the banner is added, and every property is kept", () => {
    // Written out, not built from the template it pins: q6-t1 was "Add a large banner across the top of
    // the background that reads GET LOUD in bold white capital letters" (docs/probes/sweep-4-ledger.md).
    expect(compileNativeInstruction(intent([headline("OWN THE MOMENT")]))).toBe(
      "add a large banner across the top of the background that reads OWN THE MOMENT in bold white " +
        "capital letters. Keep everything else exactly as-is — only add the banner. " +
        CLAUSE_ALL,
    );
    expect(preservationClause(["DISPLAY_TEXT"])).toBe(CLAUSE_ALL);
  });

  it("scopes it after the background, as 'the added banner' — the plan's own sentence", () => {
    expect(
      compileNativeInstruction(
        intent([recolour("jersey", "blue"), background, headline("GET LOUD")]),
      ),
    ).toBe(
      "make the jersey blue, and change the background to stadium, and add a large banner across the " +
        "top of the background that reads GET LOUD in bold white capital letters. Keep everything else " +
        "exactly as-is — change only the jersey, the background and the added banner. Keep the original " +
        "photograph's lighting, exposure, contrast and colour grade exactly as they are.",
    );
    // Beside a background alone it is never told "change only the background" — the add's rule.
    expect(
      compileNativeInstruction(intent([background, headline("GET LOUD")])),
    ).toContain(
      "Keep everything else exactly as-is — change only the background and the added banner.",
    );
    // Beside an add, both are added.
    expect(
      compileNativeInstruction(
        intent([
          {
            op: "ADD_OBJECT",
            target: null,
            change: null,
            add: {
              thing: "soccer ball",
              place: "at her feet",
              objectAssetId: null,
            },
          },
          headline("GET LOUD"),
        ]),
      ),
    ).toContain(
      "Keep everything else exactly as-is — only add the soccer ball and the banner.",
    );
  });

  it("is compiled after the background and before a look, and every other order is unchanged", () => {
    const shirt = recolour("jersey", "blue");
    const text = headline("GET LOUD");
    expect(sceneLast([look, text, background, shirt])).toEqual([
      shirt,
      background,
      text,
      look,
    ]);
    // A sentence with no headline keeps composition's order exactly: things, background, look.
    expect(sceneLast([look, background, shirt])).toEqual([
      shirt,
      background,
      look,
    ]);
  });

  it("needs no region, and reads back as runnable only with no target and its words", () => {
    expect(isRegionFree(intent([headline("GET LOUD")]))).toBe(true);
    expect(isRegionFree(intent([headline("GET LOUD"), background]))).toBe(true);
    // A recolour beside it still needs its own region, and does not ride the headline's exemption.
    expect(
      isRegionFree(intent([headline("GET LOUD"), recolour("jersey", "red")])),
    ).toBe(false);

    const good = intent([headline("GET LOUD")], {
      steps: [
        {
          op: "DISPLAY_TEXT",
          targets: [],
          value: "GET LOUD",
          scope: "GLOBAL",
        },
      ],
    });
    expect(readNativeIntent(brief({ editIntent: good })).kind).toBe("native");
    for (const [name, change] of [
      ["a target", { ...headline("GET LOUD"), target: "banner" }],
      ["no words", headline("")],
      ["null words", { ...headline("GET LOUD"), change: null }],
    ] as [string, NativeChange][]) {
      expect({
        name,
        kind: readNativeIntent(
          brief({ editIntent: { ...good, changes: [change] } }),
        ).kind,
      }).toEqual({ name, kind: "invalid" });
    }
  });
});

// ─── The interpreter's constraints (I.1): version 2, closed in shape, restraint only ────────────

describe("a constrained intent is version 2, and only a closed shape reads back (the interpreter, I.1)", () => {
  const v1 = intent([recolour("shorts", "black and green")]);
  const v2 = (constraints: unknown) =>
    ({ ...v1, version: 2, constraints }) as unknown as FrozenEditIntent;

  it("reads a version 2 intent carrying closed constraints, in canonical order, as native", () => {
    const good = v2([
      { kind: "preserve_person" },
      { kind: "exclude_marks", brand: "nike" },
    ]);
    expect(readNativeIntent(brief({ editIntent: good }))).toEqual({
      kind: "native",
      intent: good,
    });
  });

  it("refuses every constraint that is not exactly one closed shape — none can carry a step", () => {
    const cases: Record<string, unknown> = {
      "version 2 with no constraints": undefined,
      "version 2 with an empty list": [],
      "not a list": { kind: "preserve_person" },
      "an unknown kind": [{ kind: "keep_background" }],
      "a constraint carrying a step": [
        { kind: "preserve_person", op: "REMOVE_OBJECT", targets: ["jersey"] },
      ],
      "an exclusion carrying a value": [
        { kind: "exclude_marks", brand: "nike", value: "remove them" },
      ],
      "an exclusion of something that is not a brand": [
        { kind: "exclude_marks", brand: "the person" },
      ],
      "a brand in her casing, not the rules'": [
        { kind: "exclude_marks", brand: "Nike" },
      ],
      "the same constraint twice": [
        { kind: "preserve_person" },
        { kind: "preserve_person" },
      ],
      "out of canonical order": [
        { kind: "exclude_marks", brand: "nike" },
        { kind: "preserve_person" },
      ],
    };
    for (const [name, constraints] of Object.entries(cases)) {
      expect({
        name,
        kind: readNativeIntent(brief({ editIntent: v2(constraints) })).kind,
      }).toEqual({ name, kind: "invalid" });
    }
  });

  it("refuses constraints on a version 1 intent — an older reader would run the changes and drop them", () => {
    const smuggled = { ...v1, constraints: [{ kind: "preserve_person" }] };
    expect(readNativeIntent(brief({ editIntent: smuggled })).kind).toBe(
      "invalid",
    );
  });

  it("refuses a version it has never heard of", () => {
    expect(
      readNativeIntent(brief({ editIntent: { ...v1, version: 3 } })).kind,
    ).toBe("invalid");
  });
});

describe("a constraint compiles to restraint and nothing else (the interpreter, I.1)", () => {
  const changes = [recolour("shorts", "black and green")];
  const keep = intent(changes, {
    version: 2,
    constraints: [{ kind: "preserve_person" }],
  });
  const noNike = intent(changes, {
    version: 2,
    constraints: [{ kind: "exclude_marks", brand: "nike" }],
  });

  it("adds ONE keep sentence after the preservation clause — her face, hair, body and pose, never her clothes", () => {
    // Written out by hand, not read off the constant it pins.
    expect(compileNativeInstruction(keep)).toBe(
      `${Q5_SHORTS} ${CLAUSE_ALL} Keep the person's face, hair, body and pose exactly as they are.`,
    );
    // The same changes, version 1: exactly the probe's prompt and the clause, as ever.
    expect(compileNativeInstruction(intent(changes))).toBe(
      `${Q5_SHORTS} ${CLAUSE_ALL}`,
    );
  });

  it("puts an exclusion on the DO NOT line — beside the brand's own, or alone — and never in the instruction", () => {
    const withBrand = {
      job: { references: [] },
      brand: { donts: ["no alcohol"] },
    } as unknown as CreativeBrief;
    const noBrand = {
      job: { references: [] },
      brand: null,
    } as unknown as CreativeBrief;
    expect(buildNativePrompt(withBrand, [], noNike)).toBe(
      `${Q5_SHORTS} ${CLAUSE_ALL}\n\nDO NOT: no alcohol; show any Nike logo anywhere in the photograph.`,
    );
    expect(buildNativePrompt(noBrand, [], noNike)).toBe(
      `${Q5_SHORTS} ${CLAUSE_ALL}\n\nDO NOT: show any Nike logo anywhere in the photograph.`,
    );
    // Version 1: the DO NOT line is the brand's alone, and absent with no brand — byte for byte as before.
    expect(buildNativePrompt(noBrand, [], intent(changes))).toBe(
      `${Q5_SHORTS} ${CLAUSE_ALL}`,
    );
  });
});

// ─── WAVE B, CARD 2 — A MOVE'S WELL-FORMEDNESS ────────────────────────────────────────────────────────

describe("a frozen MOVE_OBJECT reads back as runnable (wave B, card 2)", () => {
  const briefOf = (changes: NativeChange[]) =>
    ({
      job: {
        mode: "edit",
        source: { width: 1008, height: 1476, editRegions: [] },
        references: [],
        editIntent: intent(changes, {
          steps: [
            {
              op: "MOVE_OBJECT",
              targets: ["ball"],
              value: "closer to my feet",
              scope: "REGION",
            },
          ],
        }),
      },
    }) as unknown as CreativeBrief;

  const MOVE: NativeChange = {
    op: "MOVE_OBJECT",
    target: "ball",
    change: null,
    to: "closer to my feet",
  };

  it("is native with a target, a null change and a destination", () => {
    // ⚠️ `changeIsWellFormed` HAD NO MOVE ARM, so its `default` read every frozen move as INVALID and the
    // preview refused it with "This check was saved in a form we can't run any more" — a whole operation
    // unrunnable with nothing downstream able to say why. golden.test.ts's operation-coverage pin caught
    // it; this is the direct assertion.
    expect(readNativeIntent(briefOf([MOVE])).kind).toBe("native");
  });

  it("is invalid without its destination, or with a change beside it", () => {
    for (const bad of [
      { ...MOVE, to: undefined },
      { ...MOVE, to: "   " },
      { ...MOVE, change: "closer" },
      { ...MOVE, target: null },
    ] as NativeChange[]) {
      expect(readNativeIntent(briefOf([bad])).kind).toBe("invalid");
    }
  });

  it("refuses a destination on any OTHER operation — a field no template reads", () => {
    // The same rule `object` takes: elsewhere it names a place the instruction never mentions.
    expect(
      readNativeIntent(
        briefOf([
          {
            op: "REMOVE_OBJECT",
            target: "cone",
            change: null,
            to: "the bench",
          },
        ]),
      ).kind,
    ).toBe("invalid");
  });
});

/**
 * THE FRAMING LINE — which operations carry it, and which must never (wave B, addition (a)).
 *
 * Probe 1b reproduced the reframe 4 of 4 on a placed add whose place lay outside the frame's content
 * bounds (Δscale 0.8651-0.8931), and 1a measured 0 of 12 backgrounds and 18 of 19 adds holding the
 * frame with no line at all. So the line rides on a PLACED add and nowhere else, and these are the
 * pins that say so — the widened predicate is the failure mode, not the missing one.
 */
describe("the framing line rides on a placed add and nothing else", () => {
  const placed = (
    thing = "soccer ball",
    place = "at my feet",
  ): NativeChange => ({
    op: "ADD_OBJECT",
    target: null,
    change: null,
    add: { thing, place, objectAssetId: null },
  });

  it("is the last sentence of a placed add's instruction", () => {
    const compiled = compileNativeInstruction(intent([placed()]));
    expect(compiled).toContain(FRAMING);
    expect(compiled.endsWith(FRAMING)).toBe(true);
  });

  it("is ABSENT from a worn add — a place on her body is inside the bounds by construction", () => {
    // The nineteenth add in 1a's corpus is worn hoops (`f226a375`, made by the running product
    // mid-probe) and it measured Δscale 1.0025. Only a spatial place can lie outside the frame.
    expect(
      compileNativeInstruction(intent([placed("gold hoops", "to my ears")])),
    ).not.toContain(FRAMING);
  });

  it("is ABSENT from a recolour, a removal, a background and a look", () => {
    const changes: NativeChange[] = [
      { op: "RECOLOR", target: "socks", change: "blue" },
      { op: "REMOVE_OBJECT", target: "goalpost", change: null },
      { op: "CHANGE_BACKGROUND", target: null, change: "a stadium" },
      { op: "GLOBAL_STYLE", target: null, change: "black and white" },
    ];
    for (const c of changes) {
      expect(compileNativeInstruction(intent([c]))).not.toContain(FRAMING);
    }
  });

  it("is ONE line however many things a compound places — it is a fact about the frame", () => {
    const compiled = compileNativeInstruction(
      intent([placed(), placed("orange cone", "on the grass")]),
    );
    expect(compiled.split(FRAMING)).toHaveLength(2);
  });

  it("does not go in the shared preservation clause", () => {
    // The blanket clause is DEAD (1a: 29 of 30 renders hold the frame without one), and the way that
    // decision is kept is this assertion: `preservationClause` is read by every operation, so a
    // framing sentence reaching it would put the line on every recolour in the product.
    for (const ops of [
      ["ADD_OBJECT"],
      ["RECOLOR"],
      ["CHANGE_BACKGROUND"],
      ["GLOBAL_STYLE"],
    ] as const) {
      expect(preservationClause([...ops]) ?? "").not.toContain("framing");
    }
  });
});
