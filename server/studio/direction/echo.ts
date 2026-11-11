/**
 * studio/direction/echo — the spike tool: the thinnest thing that answers a BriefProposal.
 *
 * `echo_brief` takes a brand and a product line and hands back a FIXED brief built around them: the
 * two lines she typed flagged literal (the quote is her own words), every other line the sample fills
 * flagged inferred with a because that says so. No model, no row, no file. It exists to prove the
 * channel end to end — route → client holds the validated object → confirm surface renders literal
 * and inferred lines apart — before any real tool is built on it (PR 7, commit 1).
 *
 * It is pure and deterministic: the same input is the same proposal, byte for byte, which is what the
 * "survives the wire unchanged" test compares against.
 */
import type { CampaignBrief } from "../campaign/brief";
import type { BriefProposal } from "./envelope";

export const ECHO_MAX_BRAND = 80;
export const ECHO_MAX_LINE = 120;

const SAMPLE = "echo_brief's fixed sample — not read from anything";

export interface EchoInput {
  brand: string;
  productLine: string;
}

export function echoBrief(input: EchoInput): BriefProposal {
  const brand = input.brand.trim().slice(0, ECHO_MAX_BRAND);
  const line = input.productLine.trim().slice(0, ECHO_MAX_LINE);
  const brief: CampaignBrief = {
    schema: "campaign-brief/1",
    objective: { type: "brand_campaign", goal: "showcase-product" },
    story: null,
    brand: { name: brand, brand_attributes: [], profile: null },
    subject: { identity_priority: "high", sport: null },
    product: { ref: null, fidelity: "high", line },
    creative_direction: {
      tone: ["calm", "focused"],
      style: null,
      energy: "steady",
    },
    references: [],
    output: { type: "video", aspect_ratio: "9:16", platform: "instagram" },
  };
  return {
    brief,
    flags: [
      { path: "brand.name", basis: "literal", quote: brand },
      { path: "product.line", basis: "literal", quote: line },
      { path: "objective.type", basis: "inferred", because: SAMPLE },
      { path: "objective.goal", basis: "inferred", because: SAMPLE },
      { path: "subject.identity_priority", basis: "inferred", because: SAMPLE },
      { path: "product.fidelity", basis: "inferred", because: SAMPLE },
      { path: "creative_direction.tone", basis: "inferred", because: SAMPLE },
      { path: "creative_direction.energy", basis: "inferred", because: SAMPLE },
      { path: "output.type", basis: "inferred", because: SAMPLE },
      { path: "output.aspect_ratio", basis: "inferred", because: SAMPLE },
      { path: "output.platform", basis: "inferred", because: SAMPLE },
    ],
    sourceTool: "echo_brief",
    extras: { constraints: [] },
  };
}
