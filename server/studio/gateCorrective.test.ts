/**
 * gateCorrective.test.ts — a re-quote's fix, compiled into each target's prompt (quality-scrappy piece 5, ADI-QS-GO):
 * Seedance's in its closing Avoid clause, every other template's and the image prompt's as one labelled paragraph, and
 * nothing at all without a corrective — every first attempt is the prompt byte for byte.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M5c — the Seedance corrective dropped (seedanceParts ignores it): "Seedance: the fix joins the Avoid clause" reds.
 *   M5d — the image prompt ignores it: "the image prompt ends with the fix" reds.
 *   M5m — the native edit ignores it (as it did until piece 8's build found it): "a native edit's prompt ends with the
 *         fix" reds.
 */
jest.mock("../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import SHARED from "./video/prompts.golden.json";
import DIALECT from "./video/seedance.golden.json";
import { plannedInputs } from "./preview";
import type { CreativeBrief } from "./brief";
import type { GateReason } from "./gateVocab";
import { CORRECTIVE_LINE, correctiveBlock } from "./gateVocab";
import { clipBrief } from "./video/seedance.cells";

const PERSON = [
  {
    role: "person",
    ref: "athletes/a/uploads/her.jpg",
    mediaAssetId: "11111111-1111-4111-8111-111111111111",
    label: "me",
  },
];
const withFix = (b: CreativeBrief, corrective: GateReason[]) =>
  ({ ...b, job: { ...b.job, corrective } }) as CreativeBrief;
const prompt = (b: CreativeBrief) => plannedInputs(b, {}).inputs.prompt;

let dialects: string | undefined;
beforeEach(() => {
  dialects = process.env.STUDIO_DIALECTS;
  delete process.env.STUDIO_DIALECTS;
});
afterEach(() => {
  if (dialects === undefined) delete process.env.STUDIO_DIALECTS;
  else process.env.STUDIO_DIALECTS = dialects;
});

describe("no corrective: every prompt byte for byte", () => {
  it("an empty corrective is the same as none", () => {
    expect(prompt(withFix(clipBrief(), []))).toBe(
      (SHARED["broll-no-marks"] as string[]).join("\n"),
    );
  });
});

describe("with a corrective", () => {
  it("Seedance: the fix joins the Avoid clause, in the closed set's order, and nothing else moves", () => {
    process.env.STUDIO_DIALECTS = "true";
    const p = prompt(withFix(clipBrief(), ["name_or_handle", "black"]));
    const plain = (DIALECT["seedance-plain"] as string[]).join("\n");
    expect(p).toBe(
      plain.replace(
        /cuts\.$/,
        "cuts, black frames, names, handles or lettering on anything.",
      ),
    );
  });

  it("the shared b-roll template: one labelled paragraph after the template", () => {
    const p = prompt(withFix(clipBrief(), ["frozen"]));
    expect(p).toBe(
      `${(SHARED["broll-no-marks"] as string[]).join("\n")}\n\nTHE LAST ATTEMPT CAME BACK WRONG. This time: ${CORRECTIVE_LINE.frozen}`,
    );
  });

  it("the Veo 'her' template: the fix before the sound clause, so a paid-for sound is still the last thing asked", () => {
    const b = clipBrief({
      references: PERSON,
      audio: true,
      direction: {
        set: "chosen",
        statement: "She smiles.",
        untrusted: false,
        featuredPieces: [],
      },
    } as Partial<CreativeBrief["job"]>);
    const p = prompt(withFix(b, ["black"]));
    const parts = p.split("\n\n");
    expect(parts.at(-2)).toBe(correctiveBlock(["black"]));
    expect(parts.at(-1)!.startsWith("Sound:")).toBe(true);
  });

  it("the image prompt ends with the fix", () => {
    const b = clipBrief({ deliverable: "post" } as Partial<
      CreativeBrief["job"]
    >);
    const p = prompt(withFix(b, ["name_or_handle"]));
    expect(p).toBe(`${prompt(b)}\n\n${correctiveBlock(["name_or_handle"])}`);
  });

  it("a native edit's prompt ends with the fix too — its re-quote is not the prompt that failed", () => {
    const b = clipBrief({
      mode: "edit",
      deliverable: "post",
      source: {
        mediaAssetId: "asset-frame",
        ref: "athletes/synthetic/frame.jpg",
        width: 1008,
        height: 1476,
        editRegions: [],
      },
      editIntent: {
        version: 1,
        initialPath: "FULL_IMAGE",
        steps: [
          {
            op: "RECOLOR",
            targets: ["shorts"],
            value: "black",
            scope: "REGION",
          },
        ],
        changes: [
          { op: "RECOLOR", target: "shorts", change: "black and green" },
        ],
        imageSize: "2K",
      },
    } as Partial<CreativeBrief["job"]>);
    expect(prompt(b)).toMatch(/^make the shorts black and green\./);
    expect(prompt(withFix(b, ["name_or_handle"]))).toBe(
      `${prompt(b)}\n\n${correctiveBlock(["name_or_handle"])}`,
    );
  });

  it("a failure no words can fix (length, shape) adds nothing — the re-run is simply a re-run", () => {
    expect(correctiveBlock(["duration", "aspect", "resolution"])).toBeNull();
    expect(prompt(withFix(clipBrief(), ["duration"]))).toBe(
      (SHARED["broll-no-marks"] as string[]).join("\n"),
    );
  });
});
