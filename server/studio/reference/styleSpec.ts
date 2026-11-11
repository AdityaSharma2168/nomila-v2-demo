/**
 * studio/reference/styleSpec — a stored reading, bridged into what an image edit or generate can use (PR 18).
 *
 *   one of her already-read references  →  studio_reference_analyses.decomposition (reference/1, stored once)
 *                                        →  styleSpecFrom (PURE, versioned)  →  StyleSpec, frozen onto the brief
 *
 * ─── DERIVED ON READ, NEVER STORED ON THE ROW (ADI-GO18 G1) ─────────────────────────────────────────────
 *
 * The reading is what is stored. The spec is a pure function of it, stamped with STYLE_SPEC_VERSION, and the
 * quote freezes it onto the brief (studio/brief.ts `JobReference.style`). So:
 *   * no second model call, ever. Not on the first edit off a reference and not on the second, because nothing
 *     here calls a model. ⚠️ MUTATION (edit/engine.style.test "a second edit off the same reference
 *     re-decomposes"): call decomposeReference here.
 *   * no DDL, and the strict decomposition shape is not widened (reference/schema.ts: the STORED shape, which is
 *     also what a model reply is read against).
 *   * an old quote replays with the derivation it was made under. The run reads the FROZEN spec off the brief
 *     and never re-derives it. ⚠️ MUTATION M20 (edit/engine.style.test "a spec derived under a new version
 *     replays an old quote differently").
 *
 * ─── WHAT A STILL KEEPS (R-C, verdicted in the ledger §3) ───────────────────────────────────────────────
 *
 *   1  the target is the whole frame (GLOBAL_STYLE)                                   mapping
 *   8  motion, editing_rhythm and the camera MOVEMENT tags are dropped                 mapping
 *   9  the version, and the reading's own prompt_version and model                    mapping
 *   10 summaries copied whole: stored at ≤ 300, never cut here                         mapping
 *   3  typography: not carried in PR 18 (ADI-GO18-R3: no image consumer; it returns with PR 19's type re-laid
 *      ops). A description of type would also invite the model to write words.
 *   2, 4, 7: the colour values, the crop geometry and the garment vocabulary need a new extraction, which
 *      nothing ruled in. They ride as the reading's prose, or not at all.
 *   6  the reference's pixels as a style slot: DEAD (ADI-GO18 G7, brief.ts:222-237). `sourceAssetId` is
 *      provenance only. Nothing in this module or its callers makes it an image the model receives.
 *
 * PURE: no database, no network. The reads under her id live in reference/styleStore.ts, so compile/ can
 * import this module's types and version list and stay pure.
 */
import { CAPABILITY_LISTS } from "../agent/capabilities";
import {
  referenceDecompositionSchema,
  type CommercialStyle,
  type DimensionReading,
} from "./schema";

/** Bump when styleSpecFrom's OUTPUT changes shape or meaning. A frozen spec keeps the version it was made under. */
export const STYLE_SPEC_VERSION = "style-spec/1" as const;
export type StyleSpecVersion = typeof STYLE_SPEC_VERSION;

/** The versions compile can still render. A frozen spec outside this list is refused, never re-derived. */
export const RENDERABLE_STYLE_SPEC_VERSIONS: readonly string[] = [
  STYLE_SPEC_VERSION,
];

/**
 * The dimensions a STILL carries, in the reading's own order (§7). Without motion and editing_rhythm (R-C 8:
 * video-only) or typography (ADI-GO18-R3: no image consumer in PR 18; returns with PR 19).
 */
export const STILL_DIMENSIONS = [
  "composition",
  "camera",
  "lens_perspective",
  "lighting",
  "color",
  "environment",
  "subject_placement",
  "wardrobe",
  "emotional_tone",
] as const;
export type StillDimension = (typeof STILL_DIMENSIONS)[number];

export type CameraMember = (typeof CAPABILITY_LISTS.camera)[number];
export type LightingMember = (typeof CAPABILITY_LISTS.lighting)[number];
export type CompositionMember = (typeof CAPABILITY_LISTS.composition)[number];

/**
 * THE IMAGE SHOT SPEC (R-5): the members of CAPABILITY_LISTS that mean something on a still AND that a reading
 * carries. The reading's tag ids are §8's words in snake_case, the same ids as the capability lists
 * (styleSpec.test pins that they are a subset).
 *
 * Not here, and why (P-capabilities):
 *   * movement (11): a still has no camera move, and `static` says nothing about a photograph.
 *   * motion (8): `slow_motion` and `speed_ramp` are time. The six depicted actions are a planner's ask, and
 *     the reading's motion dimension is stripped by R-C 8.
 * On an EDIT only `lighting` renders (compile/style.ts): a shot size, an angle or an arrangement cannot change
 * without re-shooting her, and the edit engine refuses a reframed output (edit/engine.ts assertKeptItsShape).
 */
export interface ImageShot {
  camera: CameraMember[];
  lighting: LightingMember[];
  composition: CompositionMember[];
}

export interface StyleDimension {
  /** The reading's sentence, whole. Model-written about external material, so compile fences it. */
  summary: string;
  basis: DimensionReading["basis"];
}

export interface StyleSpec {
  version: StyleSpecVersion;
  /** The analysis row it was derived from: provenance, and the key a later reader re-checks under her id. */
  analysisId: string;
  /** The reference image, as provenance only. NEVER a reference the model is sent (R-8). */
  sourceAssetId: string;
  /** What produced the reading, so two specs can be compared. */
  reading: { promptVersion: string; model: string };
  /** R-C 1: a style reference restyles the whole frame. */
  target: "whole_frame";
  /** The still's dimensions the reading answered, in STILL_DIMENSIONS order. A null dimension is absent. */
  dimensions: Partial<Record<StillDimension, StyleDimension>>;
  shot: ImageShot;
  commercialStyle: CommercialStyle[];
}

export interface AnalysisRow {
  id: string;
  source_asset_id: string | null;
  role: string;
  decomposition: unknown;
  prompt_version: string;
  model: string;
}

/** The tags a closed list carries, typed as that list's members. */
function membersOf<T extends string>(
  tags: readonly string[],
  list: readonly T[],
): T[] {
  return tags.filter((t): t is T => (list as readonly string[]).includes(t));
}

/**
 * The stored reading → the spec. PURE: the same row gives the same spec, every time, with no I/O. Null when the
 * row is not a style reference read from an image, or its reading no longer passes the stored shape. A row the
 * strict schema refuses is refused, never repaired.
 */
export function styleSpecFrom(row: AnalysisRow): StyleSpec | null {
  if (row.role !== "style_reference" || !row.source_asset_id) return null;
  const parsed = referenceDecompositionSchema.safeParse(row.decomposition);
  if (!parsed.success) return null;
  const intent = parsed.data.reference_intent;

  const dimensions: Partial<Record<StillDimension, StyleDimension>> = {};
  for (const d of STILL_DIMENSIONS) {
    const reading = intent[d];
    if (reading)
      dimensions[d] = { summary: reading.summary, basis: reading.basis };
  }
  return {
    version: STYLE_SPEC_VERSION,
    analysisId: row.id,
    sourceAssetId: row.source_asset_id,
    reading: { promptVersion: row.prompt_version, model: row.model },
    target: "whole_frame",
    dimensions,
    shot: {
      // Camera tags mix shot sizes and movements (reference/schema.ts DIMENSION_VOCAB); a still keeps the shots.
      camera: membersOf(intent.camera.tags, CAPABILITY_LISTS.camera),
      lighting: membersOf(intent.lighting.tags, CAPABILITY_LISTS.lighting),
      composition: membersOf(
        intent.composition.tags,
        CAPABILITY_LISTS.composition,
      ),
    },
    commercialStyle: [...parsed.data.commercial_style],
  };
}

// ─── The refusals a caller shows ─────────────────────────────────────────────────────────────────────────

/**
 * R-8's refusal, and the only copy a caller shows. The picker lists only references already read (ADI-GO18 G8),
 * so this is the invariant under that convenience: a hand-built request naming an unread image lands here.
 */
export const STYLE_UNREAD_COPY =
  "Still reading this reference — pick one that has been read, or try again once it has.";

export type StyleRefusal = "style_not_found" | "style_unread";

export const STYLE_REFUSAL_COPY: Record<StyleRefusal, string> = {
  style_not_found: "We couldn't find that reference in your library.",
  style_unread: STYLE_UNREAD_COPY,
};
