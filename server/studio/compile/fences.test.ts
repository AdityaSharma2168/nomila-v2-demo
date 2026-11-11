/**
 * compile/fences.test.ts — the brand's research, fenced as data in both image compilers (PR 18; PR 16 K1;
 * ADI-24SEP R1). Pure: no row, no call.
 *
 * Red by name when taken out:
 *   M10 "brand research text reaches the image prompt unfenced" — drop a `fenced(...)` in buildPrompt.
 *   M12 "a fenced field is concatenated into an instruction" — fence our own exclude_marks with the brand's
 *       DO NOTs, or leave a brand DO NOT bare beside it (compile/assemble.ts).
 * The flag-off and fence-stripping invariants over all 118 goldens live in golden.test.ts.
 */
jest.mock("../../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));
jest.mock("../router", () => ({
  estimate: () => {
    throw new Error("never estimates");
  },
  generate: () => {
    throw new Error("never generates");
  },
  resolve: () => ({ adapter: { name: "vertex" }, model: "gemini-3-pro-image" }),
}));

import { freezeEditIntent } from "../nativeIntent";
import { plannedInputs } from "../preview";
import { EXTERNAL_CLOSE, EXTERNAL_OPEN, unfence } from "./fence";
import { BRAND, FRAME, ME, brief, withStyleFlag } from "./testBriefs";

/** Every nonce of the brand's research, each of which must sit inside a fence. */
const RESEARCH = [
  "ZQCAT",
  "ZQSTYLE",
  "ZQVALUES",
  "ZQPAL1",
  "ZQPAL2",
  "ZQDO",
  "ZQDONT1",
  "ZQDONT2",
];

/** The prompt with every fenced field replaced, so what remains is only what we wrote. */
const outside = (p: string) =>
  p.replace(
    new RegExp(`${EXTERNAL_OPEN}[\\s\\S]*?${EXTERNAL_CLOSE}`, "g"),
    "<x>",
  );

/** One fenced field per nonce, never two fields in one fence. */
const fencedFields = (p: string) =>
  [
    ...p.matchAll(
      new RegExp(`${EXTERNAL_OPEN}([\\s\\S]*?)${EXTERNAL_CLOSE}`, "g"),
    ),
  ].map((m) => m[1]);

describe("the legacy image prompt (buildPrompt, a generate)", () => {
  const gen = () =>
    plannedInputs(
      brief({ mode: "generate", references: [ME] }, { brand: BRAND }),
    ).inputs.prompt;

  it("brand research text reaches the image prompt unfenced — it must not", () => {
    withStyleFlag("true", () => {
      const p = gen();
      for (const z of RESEARCH) expect(p).toContain(z);
      expect(outside(p)).not.toMatch(/ZQ[A-Z0-9]+/);
      // Verbatim: each field whole, unsanitised, exactly as the brand's row holds it.
      expect(fencedFields(p)).toEqual([
        "ZQCAT Athletic Apparel",
        "ZQSTYLE clean, high-contrast",
        "ZQVALUES Everyday performance",
        "ZQPAL1 black",
        "ZQPAL2 volt",
        "ZQDO show the product in use",
        "ZQDONT1 never show a competitor's logo",
        "ZQDONT2 no alcohol",
      ]);
      // The name is an identity field and stays bare, as Mila's get_brand leaves it.
      expect(outside(p)).toContain("BRAND: Example Co (");
    });
  });

  it("flag off: not one marker, and the unfenced flag-on prompt is the flag-off prompt", () => {
    const off = gen();
    expect(off).not.toContain(EXTERNAL_OPEN);
    const on = withStyleFlag("true", gen);
    expect(unfence(on)).toBe(off);
  });
});

describe("the native edit's DO NOT line (buildNativePrompt)", () => {
  const native = () => {
    const frozen = freezeEditIntent({
      ask: "make it warmer",
      origin: "system",
      source: FRAME,
      references: [],
      constraints: [{ kind: "exclude_marks", brand: "nike" }],
    });
    if (!frozen.ok) throw new Error("did not freeze");
    return plannedInputs(
      brief(
        { mode: "edit", source: FRAME, editIntent: frozen.intent },
        { brand: BRAND },
      ),
    ).inputs.prompt;
  };

  it("a fenced field is concatenated into an instruction — it must not: the brand's DO NOTs are fenced, ours are not", () => {
    withStyleFlag("true", () => {
      const line = native()
        .split("\n")
        .find((l) => l.startsWith("DO NOT:"))!;
      expect(line).toBe(
        `DO NOT: ${EXTERNAL_OPEN}ZQDONT1 never show a competitor's logo${EXTERNAL_CLOSE}; ${EXTERNAL_OPEN}ZQDONT2 no alcohol${EXTERNAL_CLOSE}; show any Nike logo anywhere in the photograph.`,
      );
      // Our own exclusion is an instruction, outside every fence.
      expect(outside(line)).toContain(
        "show any Nike logo anywhere in the photograph",
      );
      for (const f of fencedFields(line)) expect(f).not.toMatch(/Nike/);
    });
  });

  it("flag off: the DO NOT line is today's, byte for byte", () => {
    const off = native();
    expect(off).not.toContain(EXTERNAL_OPEN);
    expect(unfence(withStyleFlag("true", native))).toBe(off);
  });
});
