/**
 * studio/direction/brief — the one place a direction tool turns KEPT LINES into a CampaignBrief.
 *
 * A tool decides what each line is worth (summarize_brief verifies a quote; propose_campaign proposes,
 * so every line is inferred); this file decides what the brief's schema needs around it — a brand
 * object needs a name before it can carry attributes, a product needs a line before a fidelity, the
 * objective is always present — and flags the companions it fills as the brand flow's defaults. Every
 * filled line leaves with a flag, which is what `unflaggedPaths` holds at [] for every tool.
 *
 * Nothing here calls a model, reads a row, or plans.
 */
import type { CampaignBrief } from "../campaign/brief";
import type { InferenceFlag } from "./envelope";

/** The brand flow's defaults, filled when the input says nothing — flagged inferred with this because. */
export const DEFAULT_BECAUSE =
  "not stated in the document; the brand flow's default";

/** What a tool decided about one line: read from words it can quote, or its own with a why. */
export type LineFlag =
  | { basis: "literal"; quote: string }
  | { basis: "inferred"; because: string };

export interface KeptLine {
  value: string | string[];
  flag: LineFlag;
}

export interface BuiltBrief {
  brief: CampaignBrief;
  flags: InferenceFlag[];
  /** Lines that could not be kept because the brief has nowhere to put them (attributes with no brand name, …). */
  dropped: string[];
}

const defaultFlag = (path: string): InferenceFlag => ({
  path,
  basis: "inferred",
  because: DEFAULT_BECAUSE,
});

/**
 * The brief, built from the base every line starts from — nulls, the flow's objective — with each kept
 * line applied and flagged, and the schema's required companions filled and flagged as defaults.
 * `kept` is keyed by brief path (summarizePrompt SUMMARIZE_PATHS); `constraints` never come here.
 */
export function buildBrief(kept: ReadonlyMap<string, KeptLine>): BuiltBrief {
  const flags: InferenceFlag[] = [];
  const dropped: string[] = [];
  const take = (path: string) => kept.get(path);
  const flagKept = (path: string) => {
    const k = kept.get(path);
    if (k) flags.push({ path, ...k.flag });
  };

  // brand — attributes need a name to belong to.
  const brandName = take("brand.name");
  let brand: CampaignBrief["brand"] = null;
  if (brandName) {
    brand = {
      name: brandName.value as string,
      brand_attributes: [],
      profile: null,
    };
    flagKept("brand.name");
    const attrs = take("brand.brand_attributes");
    if (attrs) {
      brand.brand_attributes = attrs.value as string[];
      flagKept("brand.brand_attributes");
    }
  } else if (take("brand.brand_attributes"))
    dropped.push("brand.brand_attributes (no brand name)");

  // subject — present when anything is said about her; the priority is the flow's default otherwise.
  const sport = take("subject.sport");
  const priority = take("subject.identity_priority");
  let subject: CampaignBrief["subject"] = null;
  if (sport || priority) {
    subject = {
      identity_priority:
        (priority?.value as "maximum" | "high" | "standard" | undefined) ??
        "high",
      sport: (sport?.value as string) ?? null,
    };
    if (priority) flagKept("subject.identity_priority");
    else flags.push(defaultFlag("subject.identity_priority"));
    if (sport) flagKept("subject.sport");
  }

  // product — a line of words; fidelity is the flow's default unless stated.
  const line = take("product.line");
  const fidelity = take("product.fidelity");
  let product: CampaignBrief["product"] = null;
  if (line) {
    product = {
      ref: null,
      fidelity:
        (fidelity?.value as "maximum" | "high" | "standard" | undefined) ??
        "high",
      line: line.value as string,
    };
    flagKept("product.line");
    if (fidelity) flagKept("product.fidelity");
    else flags.push(defaultFlag("product.fidelity"));
  } else if (fidelity) dropped.push("product.fidelity (no product line)");

  // objective — always present; the flow's default when nothing names one.
  const objType = take("objective.type");
  const objGoal = take("objective.goal");
  const objective: CampaignBrief["objective"] = {
    type:
      (objType?.value as CampaignBrief["objective"]["type"] | undefined) ??
      "brand_campaign",
    goal:
      (objGoal?.value as CampaignBrief["objective"]["goal"] | undefined) ??
      "showcase-product",
  };
  if (objType) flagKept("objective.type");
  else flags.push(defaultFlag("objective.type"));
  if (objGoal) flagKept("objective.goal");
  else flags.push(defaultFlag("objective.goal"));

  // the rest — present only when given.
  const story = take("story");
  if (story) flagKept("story");
  const tone = take("creative_direction.tone");
  const style = take("creative_direction.style");
  const energy = take("creative_direction.energy");
  for (const p of [
    "creative_direction.tone",
    "creative_direction.style",
    "creative_direction.energy",
  ])
    flagKept(p);
  const outType = take("output.type");
  const outRatio = take("output.aspect_ratio");
  const outPlatform = take("output.platform");
  for (const p of ["output.type", "output.aspect_ratio", "output.platform"])
    flagKept(p);

  const brief: CampaignBrief = {
    schema: "campaign-brief/1",
    objective,
    story: (story?.value as string) ?? null,
    brand,
    subject,
    product,
    creative_direction: {
      tone: (tone?.value as string[]) ?? [],
      style:
        (style?.value as
          | CampaignBrief["creative_direction"]["style"]
          | undefined) ?? null,
      energy: (energy?.value as string) ?? null,
    },
    references: [],
    output: {
      type:
        (outType?.value as CampaignBrief["output"]["type"] | undefined) ?? null,
      aspect_ratio:
        (outRatio?.value as
          | CampaignBrief["output"]["aspect_ratio"]
          | undefined) ?? null,
      platform:
        (outPlatform?.value as
          | CampaignBrief["output"]["platform"]
          | undefined) ?? null,
    },
  };

  return { brief, flags, dropped };
}
