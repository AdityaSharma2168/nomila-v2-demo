/**
 * studio/creative/resolve.ts — THE LAST ADAPTER, on the preview path: a CreativeIntent plus its CONFIRMED interpretation
 * → the fields Studio's BriefInput needs. `objective` comes from the confirmed interpretation and from nowhere else;
 * the deliverable from the confirmed format or the intent's; brand from the intent; origin from the source. It invents
 * no creative semantics and refuses honestly: no confirmation, withdrawn, or a format Studio has no executor for.
 * Provenance, not authorization — every Studio gate after this is unchanged.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { BriefDeliverable, BriefObjective, BriefOrigin } from "../brief";
import { confirmedInterpretation, getCreativeIntent, type CreativeIntentRecord, type InterpretationRecord } from "../../services/intelligence/creative/store";
import { getSpec } from "../../services/intelligence/campaign/store";
import type { CampaignLineage } from "../brief";

type Db = PgDatabase<any, any, any>;
const OBJECTIVES: readonly BriefObjective[] = ["announce", "showcase-product", "grow-following", "concept", "recap", "thank-partner"];
const DELIVERABLES: readonly BriefDeliverable[] = ["post", "story", "reel", "carousel", "ad", "clip"];

export interface ResolvedCreativeIntent {
  intent: CreativeIntentRecord;
  interpretation: InterpretationRecord;
  objective: BriefObjective;
  deliverable: BriefDeliverable;
  brandId: number | null;
  origin: BriefOrigin;
  /** Her words, as the direction Studio reads — athlete door only. */
  direction: string | null;
  /** The contract's words, as the untrusted `ask` Studio requires for an inbound origin — campaign door only. */
  ask: string | null;
  /** #570 §6: scope version and unit of scope, when the intent came from a campaign. */
  campaignLineage: CampaignLineage | null;
}
export interface ResolveRefusal { status: 404 | 409 | 422; error: string; field: "creativeIntentId" }

export const originFor = (i: CreativeIntentRecord): BriefOrigin =>
  i.source.kind === "athlete" ? "athlete" : i.source.kind === "campaign" && i.constraints.some((c) => c.source === "contract") ? "inbound" : "system";

/** The goal the athlete confirmed: the chosen proposal's `brief.objective.goal`. */
export function confirmedGoal(x: InterpretationRecord): BriefObjective | null {
  const p = x.proposal as { proposals?: Array<{ brief?: { objective?: { goal?: string } } }> } | null;
  const idx = ((x.confirmedConcept as { proposalIndex?: number } | null)?.proposalIndex) ?? 0;
  const goal = p?.proposals?.[idx]?.brief?.objective?.goal;
  return goal && (OBJECTIVES as readonly string[]).includes(goal) ? (goal as BriefObjective) : null;
}

export async function resolveCreativeIntentForBrief(db: Db, athleteId: string, id: string): Promise<ResolvedCreativeIntent | ResolveRefusal> {
  const intent = await getCreativeIntent(db, athleteId, id);
  if (!intent) return { status: 404, error: "That creative request isn't one of yours.", field: "creativeIntentId" };
  if (intent.withdrawnAt) return { status: 409, error: "That creative request was withdrawn — nothing more is prepared from it.", field: "creativeIntentId" };
  const interpretation = await confirmedInterpretation(db, athleteId, id);
  if (!interpretation) return { status: 409, error: "Confirm how it should be read first — the objective comes from your confirmed interpretation, never from the request.", field: "creativeIntentId" };
  const objective = confirmedGoal(interpretation);
  if (!objective) return { status: 409, error: "The confirmed interpretation names no creative objective Studio knows.", field: "creativeIntentId" };
  const cls = interpretation.confirmedFormatClass ?? intent.format.class;
  if (!cls) return { status: 409, error: "No format yet — confirm the interpretation with the format you want.", field: "creativeIntentId" };
  if (!(DELIVERABLES as readonly string[]).includes(cls)) return { status: 422, error: `unsupported executor: Studio has no job for a "${cls}" piece (post, story, reel, carousel, ad or clip only).`, field: "creativeIntentId" };
  const origin = originFor(intent);
  let campaignLineage: CampaignLineage | null = null;
  if (intent.lineage.campaignId && intent.lineage.specVersion && intent.lineage.campaignDeliverableId) {
    const spec = await getSpec(db, athleteId, intent.lineage.campaignId, intent.lineage.specVersion);
    if (spec) campaignLineage = { specId: spec.id, specVersion: spec.version, campaignDeliverableId: intent.lineage.campaignDeliverableId };
  }
  return { intent, interpretation, objective, deliverable: cls as BriefDeliverable, brandId: intent.brandId, origin, direction: intent.ask?.verbatim ?? null, ask: origin === "inbound" ? intent.purpose : null, campaignLineage };
}
