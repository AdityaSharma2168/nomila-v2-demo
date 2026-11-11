/**
 * compile/style.test.ts — what a style reference SAYS to the model (PR 18), pure: no row, no call.
 *
 * Red by name when taken out:
 *   M3  "a raw style image is forwarded to the model" — add `style_reference` to PLANNED_ROLE (preview.ts).
 *   M5  "spec content reaches the output as literal text" — render a summary outside STYLE_OPEN/CLOSE.
 *   M9  "the fourth role changes an existing role's compiled prompt".
 *   M16 "the image ShotSpec renders a member with no phrase".
 *   M19 "the GLOBAL_STYLE closed-LOOKS arm changes when a spec is present elsewhere".
 *   M20 (unit half) "a spec derived under a new version replays an old quote differently".
 */
jest.mock("../../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));
jest.mock("../router", () => ({
  // A fixed quote, so previewGeneration can report its blockers; nothing is priced for real here.
  estimate: (task: string) => ({
    task,
    provider: "vertex",
    model: "gemini-3-pro-image",
    inputs: { prompt: "p", references: 0, n: 1 },
    cost: {
      amountUsd: 0.1344,
      currency: "USD",
      basis: "estimated",
      detail: "fixture",
    },
  }),
  generate: () => {
    throw new Error("never generates");
  },
  resolve: () => ({ adapter: { name: "vertex" }, model: "gemini-3-pro-image" }),
}));

import { CAPABILITY_LISTS } from "../agent/capabilities";
import { compileNativeInstruction } from "./assemble";
import { freezeEditIntent } from "../nativeIntent";
import { plannedInputs, previewGeneration } from "../preview";
import type { CreativeBrief, JobReference } from "../brief";
import {
  SHOT_AXES_FOR,
  STYLE_CLOSE,
  STYLE_OPEN,
  IMAGE_SHOT_PHRASES,
  styleBlock,
} from "./style";
import {
  SPEC,
  STYLE_PATH,
  STYLE_REF,
  ZQ_EDIT,
  ZQ_GENERATE_ONLY,
  ZQ_NEVER,
} from "../reference/styleFixtures";
import { BOOT, FRAME, ME, brief, withStyleFlag } from "./testBriefs";

const ON = (fn: () => void) => withStyleFlag("true", fn);

/** Everything OUTSIDE the style fences. */
const outsideFences = (prompt: string): string =>
  prompt.replace(
    new RegExp(`${STYLE_OPEN}[\\s\\S]*?${STYLE_CLOSE}`, "g"),
    "<fenced>",
  );

/** A native edit, frozen from our canonical sentence, with the style reference on it. */
function styledEdit(
  ask: string,
  references: JobReference[] = [STYLE_REF],
): CreativeBrief {
  const src = {
    ...FRAME,
    editRegions: /jersey/.test(ask)
      ? [{ label: "red jersey", left: 100, top: 300, width: 200, height: 200 }]
      : [],
  };
  const frozen = freezeEditIntent({
    ask,
    origin: "system",
    source: src,
    references,
  });
  if (!frozen.ok) throw new Error(`"${ask}" did not freeze: ${frozen.reason}`);
  return brief({
    mode: "edit",
    source: src,
    references,
    editIntent: frozen.intent,
  });
}

describe("the style block, per mode", () => {
  it("an EDIT carries the look only: light, colour, mood, and the lighting members", () => {
    const b = styleBlock(SPEC, "edit")!;
    for (const z of ZQ_EDIT) expect(b).toContain(z);
    for (const z of [...ZQ_GENERATE_ONLY, ...ZQ_NEVER])
      expect(b).not.toContain(z);
    expect(b).toContain(
      "LIGHT: hard light with crisp, defined shadows; a rim light tracing the subject's edges.",
    );
    expect(b).not.toMatch(/CAMERA:|COMPOSITION:/);
  });

  it("a GENERATE carries the whole still: every still dimension, camera, lighting and composition", () => {
    const b = styleBlock(SPEC, "generate")!;
    for (const z of [...ZQ_EDIT, ...ZQ_GENERATE_ONLY]) expect(b).toContain(z);
    for (const z of ZQ_NEVER) expect(b).not.toContain(z);
    // The camera tags keep the shots and drop the movement (push_in): R-C 8.
    expect(b).toContain(
      "CAMERA: shot from a low angle, looking up; a close-up of her head and shoulders.",
    );
    expect(b).toContain(
      "COMPOSITION: generous empty space around the subject.",
    );
    expect(b).not.toMatch(/push/);
  });

  it("spec content reaches the output as literal text — it must not: every word of the reading sits inside the fence", () => {
    ON(() => {
      const edit = plannedInputs(styledEdit("make it colour grade")).inputs
        .prompt;
      const gen = plannedInputs(
        brief({ mode: "generate", references: [ME, STYLE_REF] }),
      ).inputs.prompt;
      for (const p of [edit, gen]) {
        expect(p).toContain(STYLE_OPEN);
        expect(outsideFences(p)).not.toMatch(/ZQ[A-Z]+/);
      }
      expect(edit).toContain("none of its words may be written into the image");
    });
  });
});

describe("R-8: the reference's pixels are never sent", () => {
  it("a raw style image is forwarded to the model — it must not: no planned reference is the style image", () => {
    ON(() => {
      for (const b of [
        styledEdit("make it colour grade"),
        brief({ mode: "generate", references: [ME, BOOT, STYLE_REF] }),
      ]) {
        const { inputs, references } = plannedInputs(b);
        expect(references.map((r) => r.ref)).not.toContain(STYLE_PATH);
        expect(
          (inputs.references ?? []).map((r) => (r as { url?: string }).url),
        ).not.toContain(STYLE_PATH);
        expect(inputs.prompt).not.toContain(STYLE_PATH);
      }
    });
  });
});

describe("the fourth role is additive", () => {
  it("the fourth role changes an existing role's compiled prompt — it must not: the prompt is today's plus the style block", () => {
    ON(() => {
      const plain = brief({ mode: "generate", references: [ME, BOOT] });
      const styled = brief({
        mode: "generate",
        references: [ME, BOOT, STYLE_REF],
      });
      const a = plannedInputs(plain);
      const b = plannedInputs(styled);
      // The manifest numbers the same images the same way, and the adapter gets the same list.
      expect(b.references).toEqual(a.references);
      expect(b.inputs.aspectRatio).toEqual(a.inputs.aspectRatio);
      const block = styleBlock(SPEC, "generate")!;
      expect(b.inputs.prompt.replace(`\n\n${block}`, "")).toBe(a.inputs.prompt);
    });
  });
});

describe("GLOBAL_STYLE's two arms", () => {
  it("the closed-LOOKS arm changes when a spec is present elsewhere — it must not", () => {
    ON(() => {
      // Her own look, with no style reference: the closed-LOOKS phrase, exactly as it has always compiled.
      const hers = plannedInputs(styledEdit("make it moodier", [])).inputs
        .prompt;
      expect(hers).toContain(
        "give the whole photograph this look: moodier — darker overall",
      );
      expect(hers).not.toContain("look of the style reference");
      // With the reference, the spec arm, and only then.
      const styled = plannedInputs(styledEdit("make it colour grade")).inputs
        .prompt;
      expect(styled).toContain(
        "give the whole photograph the look of the style reference below: its light, colour and mood",
      );
      expect(styled).not.toContain("this look: colour grade");
    });
  });

  it("the instruction alone, with no addressing, is the closed-LOOKS arm", () => {
    const intent = styledEdit("make it colour grade").job.editIntent!;
    expect(compileNativeInstruction(intent)).toContain(
      "give the whole photograph this look: colour grade",
    );
  });

  it("a recolour with the modifier compiles the recolour, then the reference's look, then the block", () => {
    ON(() => {
      const p = plannedInputs(
        styledEdit("make the jersey red, and make it colour grade"),
      ).inputs.prompt;
      expect(p).toMatch(
        /make the .*jersey red, and give the whole photograph the look of the style reference below/,
      );
      expect(p.indexOf(STYLE_OPEN)).toBeGreaterThan(p.indexOf("Keep"));
    });
  });
});

describe("a style reference's refusals (studio/preview.ts styleBlockers)", () => {
  const blockers = (b: CreativeBrief) =>
    previewGeneration(b).blockers.map((x) => x.note);

  it("an edit that changes no look refuses it, and says why", () => {
    ON(() => {
      expect(blockers(styledEdit("make the jersey red"))).toContain(
        "A style reference changes the whole photo's look, and this edit doesn't change the look. Remove the style reference, or ask for a look change too.",
      );
    });
  });

  it("two style references refuse", () => {
    ON(() => {
      const two = [STYLE_REF, { ...STYLE_REF, mediaAssetId: "other" }];
      expect(blockers(brief({ mode: "generate", references: two }))).toContain(
        "One style reference at a time. Remove one and check again.",
      );
    });
  });

  it("flag off means flag off: a brief frozen with a style reference does not run", () => {
    const b = brief({ mode: "generate", references: [STYLE_REF] });
    expect(blockers(b)).toContain(
      "Style references are switched off right now.",
    );
  });

  it("a spec derived under a new version replays an old quote differently — it must not: an unknown version refuses and is never re-derived", () => {
    ON(() => {
      const old = {
        ...STYLE_REF,
        style: { ...SPEC, version: "style-spec/0" as never },
      };
      const b = brief({ mode: "generate", references: [old] });
      expect(blockers(b)).toContain(
        "This check was saved in a form we can't run any more — check the cost again.",
      );
      expect(styleBlock(old.style, "generate")).toBeNull();
    });
  });

  it("a style reference with no spec is refused as still reading", () => {
    ON(() => {
      const { style: _gone, ...bare } = STYLE_REF;
      expect(
        blockers(brief({ mode: "generate", references: [bare] })),
      ).toContain(
        "Still reading this reference — pick one that has been read, or try again once it has.",
      );
    });
  });
});

describe("the image ShotSpec (R-5, R-14)", () => {
  it("the image ShotSpec renders a member with no phrase — it must not: every applicable member has one", () => {
    const missing: string[] = [];
    for (const axis of SHOT_AXES_FOR.generate) {
      const table = IMAGE_SHOT_PHRASES[axis] as Record<string, string>;
      for (const m of CAPABILITY_LISTS[axis])
        if (!table[m]?.trim()) missing.push(`${axis}.${m}`);
      // And nothing phrased that the vocabulary does not have.
      for (const k of Object.keys(table))
        if (!(CAPABILITY_LISTS[axis] as readonly string[]).includes(k))
          missing.push(`extra ${axis}.${k}`);
    }
    expect(missing).toEqual([]);
  });

  it("a shot with every member renders every phrase, and never 'undefined'", () => {
    const all = {
      ...SPEC,
      shot: {
        camera: [...CAPABILITY_LISTS.camera],
        lighting: [...CAPABILITY_LISTS.lighting],
        composition: [...CAPABILITY_LISTS.composition],
      },
    };
    const b = styleBlock(all, "generate")!;
    expect(b).not.toContain("undefined");
    for (const axis of SHOT_AXES_FOR.generate)
      for (const phrase of Object.values(IMAGE_SHOT_PHRASES[axis]))
        expect(b).toContain(phrase);
  });

  it("the reading's tag vocabulary is a subset of CAPABILITY_LISTS, so every tag it can carry is phrased", async () => {
    const { CAMERA_SHOTS, LIGHTING, COMPOSITION } = await import(
      "../reference/schema"
    );
    expect(
      CAMERA_SHOTS.filter(
        (t) => !(CAPABILITY_LISTS.camera as readonly string[]).includes(t),
      ),
    ).toEqual([]);
    expect(
      LIGHTING.filter(
        (t) => !(CAPABILITY_LISTS.lighting as readonly string[]).includes(t),
      ),
    ).toEqual([]);
    expect(
      COMPOSITION.filter(
        (t) => !(CAPABILITY_LISTS.composition as readonly string[]).includes(t),
      ),
    ).toEqual([]);
  });
});
