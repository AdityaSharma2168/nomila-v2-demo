/**
 * campaign/existingWork.ts — a campaign as the Brain and the router see it: one Existing Work item under `campaign[<id>]`
 * (an existing subject kind), kind `activation`, `for {recommendationId, objectiveIds}`, with the purpose, lifecycle,
 * the current approved scope in one line, and whether creative work is underway — by reference, never as Athlete State.
 */
import type { WorkItem } from "../brain/contract";
import type { CreativeIntentRecord } from "../creative/store";
import type { IntentState } from "../creative/intents";
import type { Campaign, CampaignDeliverable, CampaignSpec } from "./contract";

export interface CampaignView { campaign: Campaign; spec: CampaignSpec | null; inScope: CampaignDeliverable[]; intents: Array<{ intent: CreativeIntentRecord; state: IntentState }>; now?: string }

export function campaignWorkItem(v: CampaignView): WorkItem | null {
  const c = v.campaign;
  if (c.status === "ended") return null;
  const content = v.inScope.filter((d) => d.intent.category === "content");
  const other = v.inScope.length - content.length;
  const underway = v.intents.filter((x) => !["withdrawn", "open"].includes(x.state)).length;
  const scope = v.spec ? `scope v${v.spec.version} (${v.spec.approval}): ${content.length} content deliverable(s)${other ? `, ${other} other obligation(s)` : ""}` : "no scope yet";
  // Amendment 3: `active` is read, not stored — approved scope with work begun, or a start date passed.
  const begun = v.intents.some((x) => ["in_production", "produced", "cleared", "published"].includes(x.state)) || (!!c.period.startsOn && c.period.startsOn <= (v.now ?? new Date().toISOString()));
  const phase = c.status === "approved" && begun ? "active" : c.status;
  return {
    id: c.id, ref: { kind: "campaign", id: c.id }, kind: "activation", brand: null,
    statement: `Campaign "${c.purpose}" · ${phase} · ${scope} · creative work underway: ${underway ? `${underway} of ${v.intents.length} intent(s)` : "no"} · ends with ${c.period.endsWith} (${c.period.endsRef}).`,
    amount: null, termStart: c.period.startsOn, termEnd: c.period.endsOn, deliverablesRecorded: v.intents.filter((x) => ["cleared", "published"].includes(x.state)).length,
    since: c.createdAt, for: { recommendationId: c.recommendationIds[0] ?? null, objectiveIds: c.objectiveIds },
  };
}
export const campaignWorkItems = (views: CampaignView[]): WorkItem[] => views.map(campaignWorkItem).filter((w): w is WorkItem => w !== null);
