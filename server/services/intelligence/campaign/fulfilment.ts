/**
 * campaign/fulfilment.ts — a content deliverable's progress and completion, DERIVED (Amendment 3): through its intents
 * to the jobs and assets Studio produced, per unit; progress is readable under every observable stage, and the obligation
 * is `fulfilled` only when its DECLARED `completesWhen` is satisfied — `cleared` / `published` derived here, and
 * `externally_confirmed` only by the confirming party's write (store.confirmExternally). Nothing here writes.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import { deriveIntentState, type IntentState } from "../creative/intents";
import { downstreamOf, type CreativeIntentRecord } from "../creative/store";
import type { CampaignDeliverable, CompletionCriterion } from "./contract";

type Db = PgDatabase<any, any, any>;
export type ProgressStage = "generated" | "cleared" | "published";
const MEETS: Record<ProgressStage, IntentState[]> = { generated: ["produced", "cleared", "published"], cleared: ["cleared", "published"], published: ["published"] };

export interface DeliverableProgress {
  deliverableId: string; of: number;
  units: Array<{ unit: number; intentId: string; state: IntentState }>;
  /** Units at or past each observable stage — readable always; none of these closes the obligation by itself. */
  under: Record<ProgressStage, number>;
  /** The declared criterion, whether it is satisfied, and the status as derived from it. */
  criterion: CompletionCriterion;
  satisfied: boolean;
  status: CampaignDeliverable["status"];
}

export async function deliverableProgress(db: Db, athleteId: string, d: CampaignDeliverable, intents: CreativeIntentRecord[]): Promise<DeliverableProgress> {
  const mine = intents.filter((i) => i.lineage.campaignDeliverableId === d.id).sort((a, b) => (a.lineage.unit ?? 1) - (b.lineage.unit ?? 1));
  const units: DeliverableProgress["units"] = [];
  for (const i of mine) units.push({ unit: i.lineage.unit ?? 1, intentId: i.id, state: deriveIntentState(i, await downstreamOf(db, athleteId, i.id)) });
  const under = { generated: 0, cleared: 0, published: 0 } as Record<ProgressStage, number>;
  for (const c of Object.keys(under) as ProgressStage[]) under[c] = units.filter((u) => MEETS[c].includes(u.state)).length;
  const of = Math.max(1, d.intent.quantity);
  const criterion = d.intent.completesWhen;
  const satisfied = criterion === "externally_confirmed" ? d.status === "fulfilled" : under[criterion] >= of;
  const status: CampaignDeliverable["status"] = d.status === "waived" || d.status === "cancelled" ? d.status : satisfied ? "fulfilled" : "open";
  return { deliverableId: d.id, of, units, under, criterion, satisfied, status };
}
