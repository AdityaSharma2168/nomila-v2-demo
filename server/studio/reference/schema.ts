/**
 * studio/reference/schema — the shape of a reference decomposition (spec docs/specs/creative-architecture.md §7),
 * and the controlled vocabulary its tags are drawn from (§8).
 *
 * ─── WHAT THE SPEC FIXES, AND WHAT IS OURS ─────────────────────────────────────────────────────────────
 *
 * The spec's §7 names twelve dimensions and says the new generation "should inherit the creative attributes,
 * not copy the original content". Its example `reference_intent` carries five of them: camera, lighting,
 * composition, color, mood. Those five are REQUIRED here (decided 22 Sep 2026; Mia confirms async). "mood" is
 * §7's "Emotional tone", keyed `emotional_tone` like the other eleven. The other seven may be null, because they
 * do not apply to every reference: a still has no motion or editing rhythm, and a frame with no type has no
 * typography.
 *
 * Ours, not the spec's, each marked where it is used:
 *   * a dimension is `{ summary, tags, basis }`, not a bare string;
 *   * tag ids are §8's words in snake_case. §8 wants them "represented as structured objects"; that is the
 *     Capability Library (§9, the spec's Phase 2), and until it exists a closed list of ids is the seam it
 *     replaces;
 *   * `commercial_style` rides beside the dimensions, from §8's "Commercial styles";
 *   * no summary may carry a URL, an @handle or a #hashtag. That is "not the original content" enforced where it
 *     is cheapest: a brand's handle or caption read out of a screenshot is copied content AND external text.
 *
 * ─── STRICT ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Every object is `.strict()`: an unknown key is a refusal, not a silently dropped field. This is the STORED
 * shape — what studio_reference_analyses.decomposition holds and what a campaign brief's reference carries. The
 * engine may be lenient about the model's raw reply (an unknown tag is dropped and counted), but what it returns
 * must pass this schema, or nothing is stored.
 */
import { z } from "zod";

export const REFERENCE_SCHEMA = "reference-decomposition/1" as const;

// ─── §8 — the controlled vocabulary, as ids ────────────────────────────────────────────────────────────

export const CAMERA_SHOTS = [
  "wide",
  "medium_wide",
  "medium",
  "close_up",
  "extreme_close_up",
  "macro",
  "pov",
  "over_the_shoulder",
  "low_angle",
  "high_angle",
  "overhead",
] as const;

export const CAMERA_MOVEMENTS = [
  "static",
  "push_in",
  "pull_out",
  "dolly",
  "tracking",
  "orbit",
  "crane",
  "pan",
  "tilt",
  "handheld",
  "whip_pan",
] as const;

export const LIGHTING = [
  "natural",
  "golden_hour",
  "studio",
  "hard_light",
  "soft_light",
  "rim_light",
  "backlight",
  "neon",
  "stadium",
  "low_key",
  "high_key",
] as const;

export const COMPOSITION = [
  "centered",
  "rule_of_thirds",
  "symmetrical",
  "negative_space",
  "foreground_framing",
  "layered_depth",
  "shallow_depth_of_field",
] as const;

export const MOTION = [
  "walking",
  "running",
  "turning",
  "jumping",
  "celebrating",
  "interacting_with_product",
  "slow_motion",
  "speed_ramp",
] as const;

export const ENVIRONMENT = [
  "stadium",
  "locker_room",
  "training_facility",
  "street",
  "studio",
  "hotel",
  "airport",
  "beach",
  "city",
] as const;

export const COMMERCIAL_STYLES = [
  "sports_campaign",
  "fashion_editorial",
  "luxury",
  "ugc",
  "documentary",
  "cinematic",
  "product_hero",
  "social_advertisement",
] as const;

export type CommercialStyle = (typeof COMMERCIAL_STYLES)[number];

// ─── §7 — the twelve dimensions ────────────────────────────────────────────────────────────────────────

/** §7's list, in its order. */
export const DIMENSIONS = [
  "composition",
  "camera",
  "lens_perspective",
  "lighting",
  "color",
  "environment",
  "subject_placement",
  "wardrobe",
  "motion",
  "editing_rhythm",
  "typography",
  "emotional_tone",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** The spec's example reference_intent (§7): camera, lighting, composition, color, mood (= emotional_tone). */
export const REQUIRED_DIMENSIONS = [
  "camera",
  "lighting",
  "composition",
  "color",
  "emotional_tone",
] as const satisfies readonly Dimension[];

/** Which §8 list a dimension's tags are drawn from. A dimension with no list here takes no tags. */
export const DIMENSION_VOCAB: Partial<Record<Dimension, readonly string[]>> = {
  camera: [...CAMERA_SHOTS, ...CAMERA_MOVEMENTS],
  lighting: LIGHTING,
  composition: COMPOSITION,
  environment: ENVIRONMENT,
  motion: MOTION,
};

export const MAX_SUMMARY = 300;
export const MAX_TAGS = 6;

/** A URL, an @handle or a #hashtag — copied content and external text, never a creative attribute. */
const COPIED_CONTENT =
  /(https?:\/\/|www\.|(^|[\s(])@[A-Za-z0-9_.]{2,}|(^|[\s(])#[A-Za-z0-9_]{2,})/;

const summary = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SUMMARY)
  .refine((s) => !COPIED_CONTENT.test(s), {
    message: "a summary may not carry a URL, an @handle or a #hashtag",
  });

function dimensionSchema(dimension: Dimension) {
  const vocab = DIMENSION_VOCAB[dimension];
  const tags = vocab
    ? z.array(z.enum(vocab as [string, ...string[]])).max(MAX_TAGS)
    : z.array(z.never()).max(0);
  return z
    .object({
      /** What the reference does on this dimension, in a sentence. Describes the look, never the words. */
      summary,
      tags,
      /** Seen in the pixels, or inferred (a pasted brief is mostly inferred). Ours, not the spec's. */
      basis: z.enum(["observed", "inferred"]),
    })
    .strict();
}

const REQUIRED = new Set<Dimension>(REQUIRED_DIMENSIONS);

const intentShape = Object.fromEntries(
  DIMENSIONS.map((d) => [
    d,
    REQUIRED.has(d) ? dimensionSchema(d) : dimensionSchema(d).nullable(),
  ]),
) as {
  [D in Dimension]: D extends (typeof REQUIRED_DIMENSIONS)[number]
    ? ReturnType<typeof dimensionSchema>
    : z.ZodNullable<ReturnType<typeof dimensionSchema>>;
};

/** Spec §7's `reference_intent`: every key present, the five required ones never null. */
export const referenceIntentSchema = z.object(intentShape).strict();

export const referenceDecompositionSchema = z
  .object({
    schema: z.literal(REFERENCE_SCHEMA),
    reference_intent: referenceIntentSchema,
    commercial_style: z.array(z.enum(COMMERCIAL_STYLES)).max(3),
  })
  .strict();

export type DimensionReading = z.infer<ReturnType<typeof dimensionSchema>>;
export type ReferenceIntent = z.infer<typeof referenceIntentSchema>;
export type ReferenceDecomposition = z.infer<
  typeof referenceDecompositionSchema
>;

/** Spec §6's roles a decomposed reference can play. Identity and product references are not decomposed. */
export const REFERENCE_ROLES = [
  "style_reference",
  "composition_reference",
] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

/** Each issue as `path: message`, so a refusal names the field that failed. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
}
