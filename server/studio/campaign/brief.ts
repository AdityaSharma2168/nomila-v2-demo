/**
 * studio/campaign/brief — the campaign brief: the object the Agent planner will consume (spec
 * docs/specs/creative-architecture.md §5 "Creative Specification", with §4's story folded in).
 *
 * TYPES AND A VALIDATOR ONLY. Nothing here calls a model. Since PR 6 (6b) the planner reads a brief — the
 * route validates it here, behind STUDIO_BRAND_PROFILES, and the prompt renders it inside a fenced CAMPAIGN
 * block (server/studio/agent/plan.ts `campaignBlock`); the wiring card (docs/studio-brand-profiles-wiring-
 * card.md) is the boundary it was built to, and its studio_campaign_briefs table is superseded by the plan
 * row's `brief` column (0061).
 *
 * ─── WHERE THIS DEPARTS FROM THE SPEC'S EXAMPLE, AND WHY ───────────────────────────────────────────────
 *
 * The spec's §5 example is the shape. These are OUR departures, each for a house rule the spec does not know:
 *
 *   * NO `athlete_id`, anywhere. §5 puts one in `subject`. House tenancy: an id supplied by a model or a client is
 *     never trusted. Whose brief it is comes from `req.athleteId`, beside the object, never inside it. The
 *     validator is strict, so an `athlete_id` smuggled in at any level is a refusal, not an ignored key.
 *   * NO `campaign_id`. It is the row's id once briefs are stored (CreativeSpec storage lands with the wiring).
 *   * `product_id` / `asset_id` become `ref`: an OPAQUE HANDLE ("product_1", "ref_2") that the server resolves
 *     against her own library, the discipline studio/agent/plan.ts keeps for LIBRARY and PRODUCTS. Never an id.
 *   * `objective.goal` is the house's existing vocabulary, studio/brief.ts `BriefObjective`, not a new one.
 *     `objective.type` ("brand_campaign" | "ad" | "social_content") is ours; the spec shows only brand_campaign.
 *   * `identity_priority` / `fidelity` take "maximum" | "high" | "standard". The spec shows only "maximum".
 *   * `subject.sport` is ours: the planner already reads a sport, and "a soccer ad" names one.
 *   * A reference carries its §7 `intent`, the decomposition the reference engine wrote, so the planner inherits
 *     the creative attributes without ever being handed the reference itself.
 *   * Things she did not say are `null`, never guessed. The control "a soccer ad with me in it" names no brand, no
 *     product, no look and no format, and its brief says so.
 *
 * Her own sentence is NOT in the brief. It stays `PlanAsk.prompt`: her words, trusted because we watched her type
 * them. A brief is written by a model or a picker, so everything in it is data to the planner, fenced.
 */
import { z } from "zod";
import type { BriefObjective } from "../brief";
import {
  COMMERCIAL_STYLES,
  REFERENCE_ROLES,
  referenceIntentSchema,
} from "../reference/schema";

export const CAMPAIGN_BRIEF_SCHEMA = "campaign-brief/1" as const;

/** studio/brief.ts `BriefObjective`, as a runtime list. The two checks below fail to compile if they drift. */
export const BRIEF_GOALS = [
  "announce",
  "showcase-product",
  "grow-following",
  "concept",
  "recap",
  "thank-partner",
] as const;
// Tuple-wrapped so the conditional does not distribute over the union: one missing member fails it.
type GoalsCoverObjective = [BriefObjective] extends [
  (typeof BRIEF_GOALS)[number],
]
  ? true
  : never;
type ObjectiveCoversGoals = [(typeof BRIEF_GOALS)[number]] extends [
  BriefObjective,
]
  ? true
  : never;
export const BRIEF_GOALS_MATCH_OBJECTIVE: [
  GoalsCoverObjective,
  ObjectiveCoversGoals,
] = [true, true];

export const OBJECTIVE_TYPES = [
  "brand_campaign",
  "ad",
  "social_content",
] as const;
export const PRIORITIES = ["maximum", "high", "standard"] as const;
export const OUTPUT_TYPES = ["image", "video"] as const;
export const ASPECT_RATIOS = ["9:16", "4:5", "1:1", "16:9"] as const;
export const PLATFORMS = ["instagram", "tiktok"] as const;

/** The most references a brief may carry: the image models' style-slot cap (studio/config.ts RefCapacity). */
export const MAX_REFERENCES = 3;
export const MAX_ATTRIBUTES = 12;
export const MAX_TONES = 6;

/** An opaque handle the server resolves against her own library. Never a database id. */
const handle = z
  .string()
  .regex(/^[a-z]+_[0-9]{1,3}$/, "an opaque handle like ref_1");
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const MAX_CONSTRAINTS = 6;
export const MAX_CONSTRAINT = 120;

export const campaignBriefSchema = z
  .object({
    schema: z.literal(CAMPAIGN_BRIEF_SCHEMA),

    objective: z
      .object({
        type: z.enum(OBJECTIVE_TYPES),
        goal: z.enum(BRIEF_GOALS),
      })
      .strict(),

    /** §4 "story": the one-line narrative, e.g. "pre-game preparation". Null when she gave none. */
    story: shortText(200).nullable(),

    brand: z
      .object({
        name: shortText(80),
        brand_attributes: z.array(shortText(40)).max(MAX_ATTRIBUTES),
        /** Her brand profile, by handle, when the brief was built from one. */
        profile: handle.nullable(),
      })
      .strict()
      .nullable(),

    /** Present when SHE is in it ("with me in it"). Null for a brief she is not in. */
    subject: z
      .object({
        identity_priority: z.enum(PRIORITIES),
        sport: shortText(40).nullable(),
      })
      .strict()
      .nullable(),

    product: z
      .object({
        /** Her product photo, by handle — or null when she named the product only in words (PR 6). */
        ref: handle.nullable(),
        fidelity: z.enum(PRIORITIES),
        /**
         * The product in her words ("the new matte-black bottle") — PR 6 decision 2. Optional on input
         * so briefs written before it still validate; a product carries a photo, a line, or both.
         */
        line: shortText(120).nullable().optional(),
      })
      .strict()
      .refine((p) => p.ref !== null || (p.line ?? null) !== null, {
        message: "a product is a photo handle, a line of words, or both",
        path: ["ref"],
      })
      .nullable(),

    creative_direction: z
      .object({
        tone: z.array(shortText(40)).max(MAX_TONES),
        style: z.enum(COMMERCIAL_STYLES).nullable(),
        energy: shortText(40).nullable(),
      })
      .strict(),

    references: z
      .array(
        z
          .object({
            ref: handle,
            role: z.enum(REFERENCE_ROLES),
            /** The §7 decomposition of this reference, or null before it has been decomposed. */
            intent: referenceIntentSchema.nullable(),
            /**
             * The asset this reading was made from — `studio_reference_analyses.source_asset_id`,
             * resolved on the plan route at save time (campaign/resolveRefs.ts, PR 14) and stored on the
             * row. SERVER-SET ONLY: the plan route refuses a posted one (an id from a client is never
             * trusted), and the replan route strips it before re-posting so the child re-resolves.
             * Optional so every brief stored before PR 14 still validates.
             */
            assetId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(MAX_REFERENCES),

    output: z
      .object({
        type: z.enum(OUTPUT_TYPES).nullable(),
        aspect_ratio: z.enum(ASPECT_RATIOS).nullable(),
        platform: z.enum(PLATFORMS).nullable(),
      })
      .strict(),
    /**
     * The brief's "do not" and "must" lines (PR 7, decision 3's second half, landed 23 Sep 2026): a
     * constraint the planner never sees isn't one. Optional, so every brief written before it still
     * validates; the confirm screen reads the same lines from the envelope's extras.constraints.
     */
    constraints: z
      .array(shortText(MAX_CONSTRAINT))
      .max(MAX_CONSTRAINTS)
      .optional(),
  })
  .strict()
  .superRefine((brief, ctx) => {
    const seen = new Set<string>();
    brief.references.forEach((r, i) => {
      if (seen.has(r.ref))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["references", i, "ref"],
          message: "a reference handle appears twice",
        });
      seen.add(r.ref);
    });
  });

export type CampaignBrief = z.infer<typeof campaignBriefSchema>;

export type BriefValidation =
  | { ok: true; brief: CampaignBrief }
  | { ok: false; issues: string[] };

/** Strict: an unknown key at any level is a refusal. Each issue names its path, e.g. `subject.athlete_id`. */
export function validateCampaignBrief(raw: unknown): BriefValidation {
  const parsed = campaignBriefSchema.safeParse(raw);
  if (parsed.success) return { ok: true, brief: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => {
      const at = i.path.join(".") || "(root)";
      const keys =
        i.code === z.ZodIssueCode.unrecognized_keys
          ? ` [${i.keys.join(", ")}]`
          : "";
      return `${at}: ${i.message}${keys}`;
    }),
  };
}
