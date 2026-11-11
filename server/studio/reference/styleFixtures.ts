/**
 * studio/reference/styleFixtures — one SYNTHETIC style reading, for the PR 18 suites. Not a test file.
 *
 * Every dimension's summary carries its own ZQ nonce (ZQLIGHT, ZQCOLOR, …), so a test can say exactly which
 * words reached a prompt and where they sit. Nothing here is a real reference, a real brand or a real person.
 */
import type { ReferenceDecomposition } from "./schema";
import { styleSpecFrom, type AnalysisRow, type StyleSpec } from "./styleSpec";

export const STYLE_ASSET_ID = "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e";
export const STYLE_ANALYSIS_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const STYLE_PATH = "athletes/synthetic/references/zq-look.jpg";

/** A strong look: hard shadows, one dominant colour, a distinctive low crop. */
export const READING: ReferenceDecomposition = {
  schema: "reference-decomposition/1",
  reference_intent: {
    composition: {
      summary:
        "ZQCOMP subject set low with a wide band of empty concrete above",
      tags: ["negative_space"],
      basis: "observed",
    },
    camera: {
      summary: "ZQCAM a low angle close to the subject, looking up",
      tags: ["low_angle", "push_in", "close_up"],
      basis: "observed",
    },
    lens_perspective: {
      summary: "ZQLENS a wide lens with slight stretch at the edges",
      tags: [],
      basis: "inferred",
    },
    lighting: {
      summary:
        "ZQLIGHT hard midday sun from high left, crisp black shadows, a thin rim on the shoulders",
      tags: ["hard_light", "rim_light"],
      basis: "observed",
    },
    color: {
      summary:
        "ZQCOLOR one dominant cobalt blue against crushed blacks and warm skin",
      tags: [],
      basis: "observed",
    },
    environment: {
      summary: "ZQENV an empty concrete stairwell",
      tags: ["street"],
      basis: "observed",
    },
    subject_placement: {
      summary: "ZQPLACE one subject in the lower third, off centre",
      tags: [],
      basis: "observed",
    },
    wardrobe: {
      summary: "ZQWARD an oversized dark tracksuit",
      tags: [],
      basis: "observed",
    },
    motion: {
      summary: "ZQMOTION walking out of frame",
      tags: ["walking"],
      basis: "inferred",
    },
    editing_rhythm: null,
    typography: {
      summary: "ZQTYPE bold condensed capitals stacked top left",
      tags: [],
      basis: "observed",
    },
    emotional_tone: {
      summary: "ZQMOOD defiant, still and focused",
      tags: [],
      basis: "observed",
    },
  },
  commercial_style: ["sports_campaign"],
};

export const ZQ_EDIT = ["ZQLIGHT", "ZQCOLOR", "ZQMOOD"] as const;
export const ZQ_GENERATE_ONLY = [
  "ZQCOMP",
  "ZQCAM",
  "ZQLENS",
  "ZQENV",
  "ZQPLACE",
  "ZQWARD",
] as const;
export const ZQ_NEVER = ["ZQMOTION", "ZQTYPE"] as const;

export function analysisRow(over: Partial<AnalysisRow> = {}): AnalysisRow {
  return {
    id: STYLE_ANALYSIS_ID,
    source_asset_id: STYLE_ASSET_ID,
    role: "style_reference",
    decomposition: READING,
    prompt_version: "reference/1",
    model: "gemini-flash-synthetic",
    ...over,
  };
}

export const SPEC: StyleSpec = styleSpecFrom(analysisRow())!;

/** The style reference as a brief carries it. */
export const STYLE_REF = {
  role: "style_reference" as const,
  ref: STYLE_PATH,
  mediaAssetId: STYLE_ASSET_ID,
  style: SPEC,
};
