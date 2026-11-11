/**
 * campaign/lifecycle.ts — the narrow end of a campaign (#570 §7 as amended). Two things, kept apart:
 *
 *  END ELIGIBILITY (a read): has the authoritative end condition occurred? Resolved from the campaign's resolved period
 *  and the object `endsRef` names — an Objective's horizon, a deal's term, her stated finish — never from prose, never
 *  guessed: when the source cannot be resolved the answer is `unknown`.
 *
 *  ENDING (a decision, stored): reaching the end makes the campaign ELIGIBLE to end; `ended` is written only by an
 *  explicit closure with a reason, an actor and a disposition for whatever is still open. `fulfilled` requires every
 *  non-optional in-scope deliverable fulfilled by its declared criterion or waived; `expired` requires the end reached
 *  (or a stated override) and says what happens to the open obligations; `cancelled` is the athlete's act at any time.
 *  Unproduced intents are withdrawn; executing work is never touched (that is the executor's own cancellation).
 */
import { eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { campaignDeliverables, campaigns } from "../../../../shared/schema";
import { deriveIntentState } from "../creative/intents";
import { downstreamOf, withdrawCreativeIntent, type CreativeIntentRecord } from "../creative/store";
import { liveObjectives, objectiveHistory } from "../objective/store";
import type { Campaign, CampaignDeliverable } from "./contract";
import { deliverableProgress } from "./fulfilment";
import { campaignIntents } from "./materialize";
import { CampaignRefused, deliverablesInScope, getCampaign } from "./store";

type Db = PgDatabase<any, any, any>;

export type EndEligibility = { eligibility: "not_reached" | "reached" | "unknown"; source: Campaign["period"]["endsWith"]; ref: string; basis: string };

/** Has the authoritative end condition occurred? A date on the resolved period decides; else the referenced object; else unknown. */
export async function endEligibility(db: Db, athleteId: string, c: Campaign, now = new Date()): Promise<EndEligibility> {
  const { endsWith, endsRef, endsOn } = c.period;
  const nowIso = now.toISOString().slice(0, 10);
  if (endsOn) return { eligibility: endsOn <= nowIso ? "reached" : "not_reached", source: endsWith, ref: endsRef, basis: `period.endsOn ${endsOn}` };
  if (endsWith === "objective_horizon") {
    const m = /^objective\[(.+)\]$/.exec(endsRef); const id = m?.[1];
    const live = id ? (await liveObjectives(db, athleteId)).find((o) => o.id === id) : undefined;
    if (live) return { eligibility: "unknown", source: endsWith, ref: endsRef, basis: `the Objective is live and its horizon is a period (${live.horizon?.kind === "period" ? live.horizon.period : "open"}) with no date on record` };
    const past = id ? (await objectiveHistory(db, athleteId)).find((o) => o.id === id) : undefined;
    if (past) return { eligibility: "reached", source: endsWith, ref: endsRef, basis: `the Objective is ${past.lifecycle} — its horizon has closed by decision` };
    return { eligibility: "unknown", source: endsWith, ref: endsRef, basis: "the referenced Objective is not on record" };
  }
  if (endsWith === "deal_term") return { eligibility: "unknown", source: endsWith, ref: endsRef, basis: "no term end was resolved onto the period" };
  return { eligibility: "unknown", source: endsWith, ref: endsRef, basis: "no stated finish is on record" };
}

export interface EndInput {
  because: "fulfilled" | "expired" | "cancelled";
  actor: string;
  /** What happens to obligations still open at closure. Required when any are open (never silently resolved). */
  remaining?: "waive" | "cancel";
  /** For `expired` when the end is not (yet) resolvable: the stated reason the athlete/system closes anyway. */
  override?: { reason: string };
}
export interface EndResult {
  campaign: Campaign;
  eligibility: EndEligibility;
  obligations: Array<{ deliverableId: string; before: CampaignDeliverable["status"]; after: CampaignDeliverable["status"] }>;
  withdrawnIntents: string[];
  /** The Recommendation's outcome for the ledger's owner to record — isolated, not written here. */
  recommendationOutcome: null | { recommendationId: string; followed: true; result: { campaignId: string; endedBecause: EndInput["because"]; fulfilled: number; of: number } };
}

export async function endCampaign(db: Db, athleteId: string, campaignId: string, input: EndInput, now = new Date()): Promise<EndResult> {
  const c = await getCampaign(db, athleteId, campaignId); if (!c) throw new CampaignRefused("campaign not found");
  const eligibility = await endEligibility(db, athleteId, c, now);
  const inScope = await deliverablesInScope(db, athleteId, campaignId, c.currentSpecVersion);
  const intents = await campaignIntents(db, athleteId, campaignId);
  const progress = await Promise.all(inScope.map((d) => deliverableProgress(db, athleteId, d, intents)));
  const fulfilledCount = progress.filter((p) => p.status === "fulfilled").length;
  const required = inScope.filter((d) => !d.intent.optional);
  const open = inScope.filter((d, i) => progress[i].status === "open");
  const outcome = (): EndResult["recommendationOutcome"] => c.recommendationIds[0] ? { recommendationId: c.recommendationIds[0], followed: true, result: { campaignId, endedBecause: input.because, fulfilled: fulfilledCount, of: inScope.length } } : null;
  if (c.status === "ended") return { campaign: c, eligibility, obligations: [], withdrawnIntents: [], recommendationOutcome: outcome() };

  if (input.because === "fulfilled") {
    const unmet = required.filter((d, i) => { const p = progress[inScope.indexOf(d)]; return !(p.status === "fulfilled" || p.status === "waived"); });
    if (unmet.length) throw new CampaignRefused(`cannot end as fulfilled: ${unmet.length} non-optional obligation(s) neither fulfilled by their declared criterion nor waived`);
  }
  if (input.because === "expired") {
    if (eligibility.eligibility !== "reached" && !input.override?.reason) throw new CampaignRefused(`cannot end as expired: the end condition is ${eligibility.eligibility} (${eligibility.basis}) — state an override reason or wait`);
    if (open.length && !input.remaining) throw new CampaignRefused(`${open.length} obligation(s) still open — say whether they are waived or cancelled`);
  }
  if (input.because === "cancelled" && open.length && !input.remaining) throw new CampaignRefused(`${open.length} obligation(s) still open — say whether they are waived or cancelled`);

  const obligations: EndResult["obligations"] = [];
  for (const d of open) {
    const after: CampaignDeliverable["status"] = input.remaining === "waive" ? "waived" : "cancelled";
    await db.update(campaignDeliverables).set({ status: after }).where(eq(campaignDeliverables.id, d.id));
    obligations.push({ deliverableId: d.id, before: "open", after });
  }
  // unproduced creative intents are withdrawn; anything in production is the executor's to stop, never ours
  const withdrawnIntents: string[] = [];
  for (const i of intents as CreativeIntentRecord[]) {
    if (i.withdrawnAt) continue;
    const st = deriveIntentState(i, await downstreamOf(db, athleteId, i.id));
    if (st === "open" || st === "interpreted" || st === "confirmed") { await withdrawCreativeIntent(db, athleteId, i.id, now); withdrawnIntents.push(i.id); }
  }
  const [row] = await db.update(campaigns).set({ status: "ended", ended_because: input.because, ended_at: now }).where(eq(campaigns.id, campaignId)).returning();
  const ended = (await getCampaign(db, athleteId, row.id))!;
  return { campaign: ended, eligibility, obligations, withdrawnIntents, recommendationOutcome: outcome() };
}
