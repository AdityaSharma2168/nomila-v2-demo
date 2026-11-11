/**
 * creative/contract.ts — the ONE creative-intent contract (campaign-creative-seam-checkpoint.md §5), experimental and
 * unmounted. Creative work requested, with why and constraints, BEFORE conception: served to the planner's Commission,
 * the Campaign's content deliverables and the athlete's direct ask alike. It has no field for a concept, hook, caption,
 * treatment, shot, edit, reference, look or music — those are creative intelligence's, after this. Pure types.
 *
 * STATUS, pressure-tested (forcing.test.ts "status"): the intent carries NO lifecycle. `interpreted`, `confirmed`,
 * `in_production`, `produced`, `published` are all derivable from downstream Studio records (proposals, studio_plans,
 * generation_jobs, media_assets, publish jobs) through `creative_intent_id`, so a mutable copy here would only drift.
 * The one fact nothing downstream can express is that the intent was withdrawn before or regardless of production —
 * `withdrawnAt` is the only mutable field.
 */
import type { BriefDeliverable } from "../../../studio/brief";

export const CREATIVE_INTENT_VERSION = "creative-intent/0.1.0-exp";

export type IntentSourceKind = "planner" | "campaign" | "athlete";
export type FormatClass = BriefDeliverable | "written" | "other";

export interface CreativeIntent {
  version: typeof CREATIVE_INTENT_VERSION;
  id: string;
  athleteId: string;
  source: { kind: IntentSourceKind; ref: string };
  /** planner: Commission.purpose · campaign: the deliverable's own words · athlete: her ask, verbatim. */
  purpose: string;
  /** planner: Commission.why · campaign: the spec's purpose · athlete: null. */
  why: string | null;
  audienceRole: string | null;
  /** campaign/deal only; never inferred. */
  brandId: number | null;
  format: { class: FormatClass | null; quantity: number | null; dueOn: string | null; fixedBy: "contract" | "planner" | "athlete" | null };
  channel: string | null;
  timing: string | null;
  constraints: Array<{ text: string; source: "contract" | "athlete" | "recommendation" | "planner" }>;
  /** athlete door only: her words, and the moment by Context reference. */
  ask: { verbatim: string; moment: { asOf: string; ref: string } | null } | null;
  lineage: { recommendationId?: string; outreachPlanId?: string; campaignId?: string; specVersion?: number; campaignDeliverableId?: string; dealDeliverableId?: string; unit?: number };
  createdAt: string;
  withdrawnAt: string | null;
}

/** Keys that may never appear anywhere inside an intent: the creative solution's vocabulary and the strategic layer's. */
export const NOT_INTENT_FIELDS = ["concept", "hook", "angle", "caption", "captions", "treatment", "tone", "shot", "shots", "edit", "references", "look", "music", "storyboard", "objective", "what", "recommendation", "execution_path"] as const;

export const intentKey = (i: Pick<CreativeIntent, "source" | "lineage">) =>
  i.source.kind === "campaign" ? `campaign:${i.lineage.campaignId}:${i.lineage.campaignDeliverableId}:${i.lineage.unit ?? 1}`
  : i.source.kind === "planner" ? `planner:${i.lineage.outreachPlanId}:${i.source.ref}`
  : `athlete:${i.source.ref}`;
