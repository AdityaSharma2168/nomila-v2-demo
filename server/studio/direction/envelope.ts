/**
 * studio/direction/envelope — what every direction tool answers: a BriefProposal.
 *
 * The direction tools (PR 7) turn a PDF, a pasted reference, a stated objective or a moment into a
 * CampaignBrief she confirms before anything is planned. They differ in what they read; they agree on
 * what they hand back, and this file is that agreement:
 *
 *   { brief, flags, sourceTool, extras }
 *
 *   brief       a CampaignBrief, strict (studio/campaign/brief.ts) — the planner's own input, unchanged.
 *   flags       one per line the tool filled: WHERE (a path into the brief), and on what BASIS —
 *                 literal   quoted from what it was given; carries the quote it came from
 *                 inferred  derived by the tool; carries a one-line "because"
 *   sourceTool  which tool wrote it. A closed enum: a tool that is not on it cannot ship a proposal.
 *   extras      what a brief has no field for yet (see the constraints decision below).
 *
 * ─── THE FLAGS SIT BESIDE THE BRIEF, NEVER INSIDE IT ────────────────────────────────────────────────
 *
 * The brief schema is `.strict()` and its version tag is a literal. A flag inside it would fail the very
 * validator the planner runs — so the envelope carries them, and the brief that reaches the planner is
 * byte-for-byte a CampaignBrief. `unflaggedPaths` is the rule's other half: every line a tool filled has
 * a flag, and a tool's test holds it (Lane A's "inferred fields not flagged" reds there by name).
 *
 * ─── BELIEF IS EARNED BY VERIFICATION, NEVER BY A MODEL'S CLAIM ───────────────────────────────────────
 *
 * A "literal" flag MUST carry its quote; an "inferred" one MUST carry its because. The schema refuses
 * either without. Whether the quote is actually IN the source is the tool's job (summarize_brief checks
 * it as a whitespace-normalised substring of the extracted text and downgrades to inferred when it is
 * not) — this file only makes the claim impossible to state without the evidence field.
 *
 * ─── TYPES AND A VALIDATOR ONLY ───────────────────────────────────────────────────────────────────────
 *
 * Nothing here calls a model, reads a row, or plans. A direction tool returns a brief; it never plans,
 * generates, stitches or quotes (the PR's hard gate — routes.ts and its tripwire).
 */
import { z } from "zod";
import { campaignBriefSchema, type CampaignBrief } from "../campaign/brief";

/**
 * The tools that may sign a proposal. Each lane adds its own name here AND to envelope.test's pinned
 * list — so a new tool cannot ship without saying, in a test, that it flags what it fills.
 */
export const SOURCE_TOOLS = [
  "echo_brief",
  "summarize_brief",
  "propose_campaign",
  "decompose_reference",
  "research_moment",
] as const;
export type SourceTool = (typeof SOURCE_TOOLS)[number];

export const FLAG_BASES = ["literal", "inferred"] as const;
export type FlagBasis = (typeof FLAG_BASES)[number];

export const MAX_FLAGS = 64;
export const MAX_CONSTRAINTS = 6;
export const MAX_QUOTE = 300;
export const MAX_BECAUSE = 200;
export const MAX_CONSTRAINT = 120;
export const MAX_ANGLE = 60;
export const MAX_FEELING = 60;
export const MAX_LINE = 200;
export const MAX_NOTES = 4;
export const MAX_NOTE = 160;
export const MAX_MOMENT_TITLE = 120;
export const MAX_MOMENT_SUMMARY = 400;
export const MAX_MOMENT_SOURCES = 5;

/** A dotted path into the brief: `brand.name`, `creative_direction.tone`, `output.aspect_ratio`. */
const PATH_RE = /^[a-z_]+(\.[a-z_0-9]+)*$/;

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const inferenceFlagSchema = z
  .object({
    path: z
      .string()
      .regex(PATH_RE, "a dotted path into the brief, like brand.name"),
    basis: z.enum(FLAG_BASES),
    /** literal: the words it was read from. */
    quote: shortText(MAX_QUOTE).optional(),
    /** inferred: why the tool filled it this way, in one line. */
    because: shortText(MAX_BECAUSE).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.basis === "literal" && f.quote === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quote"],
        message: "a literal line carries the quote it was read from",
      });
    if (f.basis === "inferred" && f.because === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["because"],
        message: "an inferred line says why, in one line",
      });
  });

export type InferenceFlag = z.infer<typeof inferenceFlagSchema>;

export const briefProposalSchema = z
  .object({
    brief: campaignBriefSchema,
    flags: z.array(inferenceFlagSchema).max(MAX_FLAGS),
    sourceTool: z.enum(SOURCE_TOOLS),
    extras: z
      .object({
        /**
         * A brand's "do not" lines. Decision 3 (22 Sep 2026): these move INTO the brief as an optional
         * array with a fenced campaignBlock line — a constraint the planner never sees isn't one. Until
         * that lane lands they ride here, so the confirm screen can already show them.
         */
        constraints: z.array(shortText(MAX_CONSTRAINT)).max(MAX_CONSTRAINTS),
        /**
         * propose_campaign's concept for this brief — what the video is about, how it feels, one line —
         * the exact shape of a PlanConcept (studio/agent/types.ts), so a picked proposal rides POST
         * /studio/agent/plan as `concept` unchanged, skipping the concept call. Never a brief field.
         */
        concept: z
          .object({
            angle: shortText(MAX_ANGLE),
            feeling: shortText(MAX_FEELING),
            line: shortText(MAX_LINE),
          })
          .strict()
          .optional(),
        /**
         * What the tool wants her to know about the reading itself — "read 20,000 of 31,000 characters",
         * "the document addressed the reader; ignored" — plain lines, never a brief field.
         */
        notes: z.array(shortText(MAX_NOTE)).max(MAX_NOTES).optional(),
        /**
         * summarize_brief: whether the document yielded text a literal could be checked against.
         * "unavailable" (a scanned or image-only PDF, or one the PDF parser could not read) means the pages
         * were read by the model alone — every line is inferred, and the confirm screen says so.
         */
        extraction: z.enum(["text", "unavailable"]).optional(),
        /**
         * research_moment: what the search found — the moment's title and summary, the PROVIDER's own
         * citations (its grounding chunks; never links the model claimed), the queries it ran, and
         * whether the timing came from HER (a constraint she typed) or from nowhere. Provenance she
         * reads on the confirm step, like `notes`; not a line she confirms. Never a brief field.
         */
        moment: z
          .object({
            title: shortText(MAX_MOMENT_TITLE),
            summary: shortText(MAX_MOMENT_SUMMARY),
            sources: z
              .array(
                z
                  .object({
                    title: shortText(160).nullable(),
                    url: z.string().trim().min(1).max(500).nullable(),
                    domain: shortText(120).nullable(),
                  })
                  .strict(),
              )
              .max(MAX_MOMENT_SOURCES),
            searchQueries: z.array(shortText(160)).max(5),
            dateBasis: z.enum(["hers", "none"]),
            /** Timing the search supplied and the tool removed (a date, a month-and-day, a year) — never a line. */
            timingRemoved: z.array(shortText(40)).max(6),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    // A flag names a line that exists. A flag on nothing is a tool describing work it did not do.
    const present = new Set(proposalPaths(p));
    const seen = new Set<string>();
    p.flags.forEach((f, i) => {
      if (!present.has(f.path))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["flags", i, "path"],
          message: `no filled line at ${f.path}`,
        });
      if (seen.has(f.path))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["flags", i, "path"],
          message: `${f.path} is flagged twice`,
        });
      seen.add(f.path);
    });
  });

export type BriefProposal = z.infer<typeof briefProposalSchema>;

export type ProposalValidation =
  | { ok: true; proposal: BriefProposal }
  | { ok: false; issues: string[] };

/** Strict, as the brief's own validator: each issue names its path. */
export function validateBriefProposal(raw: unknown): ProposalValidation {
  const parsed = briefProposalSchema.safeParse(raw);
  if (parsed.success) return { ok: true, proposal: parsed.data };
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

/** The version tag is the brief's own name, not a line anyone filled. */
const NOT_A_LINE = new Set(["schema"]);

/**
 * Every FILLED line of a brief, as dotted paths: each leaf that is not null, not an empty string and
 * not an empty array. An array is one line (`creative_direction.tone`), never one per item. This is
 * the set a tool's flags must cover, and the set a flag may point into.
 */
export function leafPaths(brief: CampaignBrief): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      if (v.length) out.push(path);
      return;
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        if (NOT_A_LINE.has(p)) continue;
        walk(child, p);
      }
      return;
    }
    if (typeof v === "string" && v === "") return;
    out.push(path);
  };
  walk(brief, "");
  return out;
}

/**
 * Every line a tool filled, brief AND extras: the brief's leaves, plus one path per constraint
 * (`extras.constraints.0`, …) and `extras.concept` (one line: the concept is confirmed whole) — each a
 * line she reads on the confirm step, so each carries its own basis. `notes` are the tool's own words
 * about the reading, not lines it filled.
 */
export function proposalPaths(
  p: Pick<BriefProposal, "brief" | "extras">,
): string[] {
  const out = leafPaths(p.brief);
  p.extras.constraints.forEach((_, i) => out.push(`extras.constraints.${i}`));
  if (p.extras.concept !== undefined) out.push("extras.concept");
  return out;
}

/** The filled lines no flag speaks for. A tool's test holds this at `[]`. */
export function unflaggedPaths(p: BriefProposal): string[] {
  const flagged = new Set(p.flags.map((f) => f.path));
  return proposalPaths(p).filter((path) => !flagged.has(path));
}
