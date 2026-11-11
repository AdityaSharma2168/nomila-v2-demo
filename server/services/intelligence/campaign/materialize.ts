/**
 * campaign/materialize.ts — #570 §5 as amended: on an APPROVED spec version, `CampaignSpec → CreativeIntent[]` for
 * content deliverables only, one intent per unit, keyed campaign:<id>:<deliverable>:<unit>. Idempotent: existing
 * deliverable/unit intents are untouched; a later version creates intents only for new deliverable/unit combinations;
 * deliverables the new scope dropped keep their history — their still-unproduced intents are withdrawn (nothing
 * deleted; anything already in production stays, under Studio's own semantics). Never from a draft.
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { creativeIntents } from "../../../../shared/schema";
import { intentKey, type CreativeIntent } from "../creative/contract";
import { deriveIntentState, intentsFromCampaignSpec, type SpecDeliverable } from "../creative/intents";
import { createCreativeIntent, downstreamOf, withdrawCreativeIntent, type CreativeIntentRecord } from "../creative/store";
import { CampaignRefused, deliverablesInScope, getCampaign, getSpec, listDeliverables } from "./store";

type Db = PgDatabase<any, any, any>;

export async function campaignIntents(db: Db, athleteId: string, campaignId: string): Promise<CreativeIntentRecord[]> {
  const rows = await db.select().from(creativeIntents).where(and(eq(creativeIntents.athlete_id, athleteId), eq(creativeIntents.source_kind, "campaign"), eq(creativeIntents.source_ref, `campaign[${campaignId}]`)));
  const { getCreativeIntent } = await import("../creative/store");
  const out: CreativeIntentRecord[] = [];
  for (const r of rows) { const rec = await getCreativeIntent(db, athleteId, r.id); if (rec) out.push(rec); }
  return out;
}

export async function materializeCreativeIntents(db: Db, athleteId: string, campaignId: string, version: number, now = new Date()): Promise<{ created: CreativeIntentRecord[]; kept: number; withdrawn: CreativeIntentRecord[] }> {
  const c = await getCampaign(db, athleteId, campaignId); if (!c) throw new CampaignRefused("campaign not found");
  const spec = await getSpec(db, athleteId, campaignId, version); if (!spec) throw new CampaignRefused(`no spec version ${version}`);
  if (spec.approval === "draft") throw new CampaignRefused("a draft scope creates no creative work — approve the spec first");
  const inScope = await deliverablesInScope(db, athleteId, campaignId, version);
  const existing = await campaignIntents(db, athleteId, campaignId);
  const deliverables: SpecDeliverable[] = inScope.map((d) => ({ id: d.id, category: d.intent.category, contentFormat: d.intent.contentFormat, quantity: d.intent.quantity, dueOn: d.intent.dueOn, sourceQuote: d.intent.sourceQuote, brandId: d.intent.brandId ?? null, dealDeliverableId: d.dealDeliverableId }));
  const plan = intentsFromCampaignSpec({ campaignId, athleteId, version, purpose: spec.purpose, brandIds: c.brandIds, constraints: spec.constraints }, deliverables, existing, now.toISOString());
  const created: CreativeIntentRecord[] = [];
  for (const i of plan.created) {
    const { record, created: fresh } = await createCreativeIntent(db, i, intentKey(i));
    if (fresh) created.push(record);
  }
  // dropped scope: intents of deliverables no longer in scope that have produced nothing are withdrawn — history kept
  const dropped = new Set((await listDeliverables(db, athleteId, campaignId)).filter((d) => d.supersededVersion !== null).map((d) => d.id));
  const withdrawn: CreativeIntentRecord[] = [];
  for (const i of existing) {
    if (!i.lineage.campaignDeliverableId || !dropped.has(i.lineage.campaignDeliverableId) || i.withdrawnAt) continue;
    const state = deriveIntentState(i as CreativeIntent, await downstreamOf(db, athleteId, i.id));
    if (state === "open" || state === "interpreted" || state === "confirmed") withdrawn.push(await withdrawCreativeIntent(db, athleteId, i.id, now));
  }
  return { created, kept: plan.kept.length, withdrawn };
}
