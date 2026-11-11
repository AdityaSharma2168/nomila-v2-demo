/**
 * campaign/store.ts — the origin writer (#655 §2, recommendation door first), spec versions, approval, and reads. No
 * provider, no Studio. Rules enforced here: a campaign needs a resolved reason to end (refused without endsRef);
 * from the router door it starts at `planning` (both Amendment-3 acts are done before the router hands off — `idea`
 * has no writer here, recorded); a spec version is immutable once written (the only update is its approval);
 * approval of a later version supersedes the deliverables it drops without deleting anything.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { campaignDeliverables, campaignSpecs, campaigns } from "../../../../shared/schema";
import type { CampaignOriginProposal } from "../brain/executionRouter";
import { CAMPAIGN_VERSION, allowedCriteria, type Campaign, type CampaignDeliverable, type CampaignSpec, type DeliverableIntent } from "./contract";

/** Amendment 3: every deliverable declares what closes it, within what its category allows; the deal door's read-through is not built here. */
export function validateDeliverable(d: DeliverableIntent): void {
  if (!d || typeof d !== "object") throw new CampaignRefused("a deliverable must be an object");
  if (!d.completesWhen) throw new CampaignRefused(`deliverable "${d.sourceQuote ?? d.category}" declares no completion criterion (completesWhen) — never defaulted, never inferred`);
  if (!allowedCriteria(d.category).includes(d.completesWhen)) throw new CampaignRefused(`a "${d.category}" obligation cannot complete on "${d.completesWhen}" — only ${allowedCriteria(d.category).join(" | ")}`);
  if (d.category === "content" && !d.contentFormat) throw new CampaignRefused("a content deliverable names its format");
  if (!Number.isInteger(d.quantity) || d.quantity < 1) throw new CampaignRefused("quantity must be a positive integer");
}

type Db = PgDatabase<any, any, any>;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const toCampaign = (r: typeof campaigns.$inferSelect): Campaign => ({ id: r.id, athleteId: r.athlete_id, version: r.version as Campaign["version"], originDoor: r.origin_door as Campaign["originDoor"], purpose: r.purpose, recommendationIds: (r.recommendation_ids as string[]) ?? [], objectiveIds: (r.objective_ids as string[]) ?? [], dealIds: (r.deal_ids as string[]) ?? [], brandIds: (r.brand_ids as number[]) ?? [], participantAthleteIds: (r.participant_athlete_ids as string[]) ?? [], period: r.period as Campaign["period"], evidence: (r.evidence as Campaign["evidence"]) ?? [], status: r.status as Campaign["status"], endedBecause: (r.ended_because as Campaign["endedBecause"]) ?? null, currentSpecVersion: r.current_spec_version, createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), endedAt: iso(r.ended_at) });
const toSpec = (r: typeof campaignSpecs.$inferSelect): CampaignSpec => ({ id: r.id, campaignId: r.campaign_id, athleteId: r.athlete_id, version: r.version, purpose: r.purpose, deliverableIds: (r.deliverable_ids as string[]) ?? [], period: r.period as CampaignSpec["period"], constraints: (r.constraints as CampaignSpec["constraints"]) ?? [], approval: r.approval as CampaignSpec["approval"], provenance: r.provenance as CampaignSpec["provenance"], supersedes: r.supersedes ?? null, createdAt: iso(r.created_at)!, approvedAt: iso(r.approved_at), approvedBy: r.approved_by ?? null });
const toDeliverable = (r: typeof campaignDeliverables.$inferSelect): CampaignDeliverable => ({ id: r.id, campaignId: r.campaign_id, athleteId: r.athlete_id, introducedVersion: r.introduced_version, supersededVersion: r.superseded_version ?? null, seq: r.seq, intent: r.intent as DeliverableIntent, status: r.status as CampaignDeliverable["status"], dealDeliverableId: r.deal_deliverable_id ?? null, confirmedBy: r.confirmed_by ?? null, confirmedAt: iso(r.confirmed_at), confirmationRef: r.confirmation_ref ?? null, createdAt: iso(r.created_at)!, supersededAt: iso(r.superseded_at) });

export class CampaignRefused extends Error { constructor(msg: string) { super(msg); } }

/**
 * THE ORIGIN WRITER — recommendation door. Takes the router's validated CampaignOriginProposal and writes one campaign
 * at `planning` and one DRAFT spec v1 with the origin's deliverables (none from a Recommendation: they are the spec's
 * and the planner's, never the Brain's). Refuses without a resolved reason to end. Invents no deliverable.
 */
export async function createCampaignFromOrigin(db: Db, athleteId: string, origin: CampaignOriginProposal & { deliverables?: DeliverableIntent[] }, now = new Date()): Promise<{ campaign: Campaign; spec: CampaignSpec; deliverables: CampaignDeliverable[] }> {
  if (origin.door !== "recommendation") throw new CampaignRefused(`door "${String(origin.door)}" has no writer in this slice`);
  if (!origin.period || !origin.period.endsRef || !origin.period.endsWith) throw new CampaignRefused("a campaign without a resolved reason to end (period.endsRef) is refused — #570 invariant 2");
  if (!origin.purpose?.trim()) throw new CampaignRefused("a campaign without a purpose is refused");
  if (!origin.recommendationId) throw new CampaignRefused("the recommendation door needs the Recommendation it comes from");
  for (const d of origin.deliverables ?? []) validateDeliverable(d);
  const [c] = await db.insert(campaigns).values({ athlete_id: athleteId, version: CAMPAIGN_VERSION, origin_door: "recommendation", purpose: origin.purpose, recommendation_ids: [origin.recommendationId], objective_ids: origin.objectiveIds, deal_ids: origin.dealIds, brand_ids: origin.brandIds, participant_athlete_ids: [], period: origin.period, evidence: origin.evidence, status: "planning", current_spec_version: 1, created_at: now }).returning();
  const dels: CampaignDeliverable[] = [];
  for (const [i, d] of (origin.deliverables ?? []).entries()) {
    const [row] = await db.insert(campaignDeliverables).values({ campaign_id: c.id, athlete_id: athleteId, introduced_version: 1, seq: i + 1, intent: d, status: "open", deal_deliverable_id: d.dealDeliverableId ?? null, created_at: now }).returning();
    dels.push(toDeliverable(row));
  }
  const [s] = await db.insert(campaignSpecs).values({ campaign_id: c.id, athlete_id: athleteId, version: 1, purpose: origin.purpose, deliverable_ids: dels.map((d) => d.id), period: origin.period, constraints: origin.constraints, approval: "draft", provenance: { origin: { door: "recommendation", recommendationId: origin.recommendationId }, supersedes: null, createdBy: "recommendation_door", createdAt: now.toISOString() }, supersedes: null, created_at: now }).returning();
  return { campaign: toCampaign(c), spec: toSpec(s), deliverables: dels };
}

export async function getCampaign(db: Db, athleteId: string, id: string): Promise<Campaign | null> {
  const rows = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.athlete_id, athleteId))).limit(1);
  return rows[0] ? toCampaign(rows[0]) : null;
}
export async function listCampaigns(db: Db, athleteId: string): Promise<Campaign[]> {
  return (await db.select().from(campaigns).where(eq(campaigns.athlete_id, athleteId)).orderBy(desc(campaigns.created_at))).map(toCampaign);
}
export async function getSpec(db: Db, athleteId: string, campaignId: string, version: number): Promise<CampaignSpec | null> {
  const rows = await db.select().from(campaignSpecs).where(and(eq(campaignSpecs.campaign_id, campaignId), eq(campaignSpecs.athlete_id, athleteId), eq(campaignSpecs.version, version))).limit(1);
  return rows[0] ? toSpec(rows[0]) : null;
}
export async function listSpecs(db: Db, athleteId: string, campaignId: string): Promise<CampaignSpec[]> {
  return (await db.select().from(campaignSpecs).where(and(eq(campaignSpecs.campaign_id, campaignId), eq(campaignSpecs.athlete_id, athleteId))).orderBy(asc(campaignSpecs.version))).map(toSpec);
}
export async function listDeliverables(db: Db, athleteId: string, campaignId: string): Promise<CampaignDeliverable[]> {
  return (await db.select().from(campaignDeliverables).where(and(eq(campaignDeliverables.campaign_id, campaignId), eq(campaignDeliverables.athlete_id, athleteId))).orderBy(asc(campaignDeliverables.introduced_version), asc(campaignDeliverables.seq))).map(toDeliverable);
}
/** The deliverables in scope under the campaign's current approved version. */
export async function deliverablesInScope(db: Db, athleteId: string, campaignId: string, version: number): Promise<CampaignDeliverable[]> {
  const spec = await getSpec(db, athleteId, campaignId, version); if (!spec) return [];
  const all = await listDeliverables(db, athleteId, campaignId);
  return spec.deliverableIds.map((id) => all.find((d) => d.id === id)).filter((d): d is CampaignDeliverable => !!d);
}

/**
 * A NEW SPEC VERSION (draft). `keep` names existing deliverables carried into scope (identity preserved); `add` are
 * new obligations. Anything in the previous version and not kept leaves scope when this version is approved. The
 * previous version's row is untouched — versions are immutable.
 */
export async function proposeSpecVersion(db: Db, athleteId: string, campaignId: string, input: { purpose?: string; keep: string[]; add: DeliverableIntent[]; constraints?: CampaignSpec["constraints"]; createdBy: CampaignSpec["provenance"]["createdBy"] }, now = new Date()): Promise<{ spec: CampaignSpec; added: CampaignDeliverable[] }> {
  const c = await getCampaign(db, athleteId, campaignId); if (!c) throw new CampaignRefused("campaign not found");
  if (c.status === "ended") throw new CampaignRefused("an ended campaign takes no new scope — a revival is a new campaign");
  const specs = await listSpecs(db, athleteId, campaignId); const prev = specs[specs.length - 1];
  const existing = await listDeliverables(db, athleteId, campaignId);
  for (const id of input.keep) if (!existing.some((d) => d.id === id)) throw new CampaignRefused(`deliverable ${id} is not this campaign's`);
  for (const d of input.add) validateDeliverable(d);
  const version = (prev?.version ?? 0) + 1; const added: CampaignDeliverable[] = [];
  let seq = existing.reduce((m, d) => Math.max(m, d.seq), 0);
  for (const d of input.add) {
    const [row] = await db.insert(campaignDeliverables).values({ campaign_id: campaignId, athlete_id: athleteId, introduced_version: version, seq: ++seq, intent: d, status: "open", deal_deliverable_id: d.dealDeliverableId ?? null, created_at: now }).returning();
    added.push(toDeliverable(row));
  }
  const [s] = await db.insert(campaignSpecs).values({ campaign_id: campaignId, athlete_id: athleteId, version, purpose: input.purpose ?? prev?.purpose ?? c.purpose, deliverable_ids: [...input.keep, ...added.map((d) => d.id)], period: c.period, constraints: input.constraints ?? prev?.constraints ?? [], approval: "draft", provenance: { origin: { door: c.originDoor, recommendationId: c.recommendationIds[0] }, supersedes: prev?.version ?? null, createdBy: input.createdBy, createdAt: now.toISOString() }, supersedes: prev?.version ?? null, created_at: now }).returning();
  return { spec: toSpec(s), added };
}

/**
 * APPROVAL — the athlete's second act (Amendment 3). Only the latest version can be approved; approval is the one
 * write a spec row ever receives. The campaign moves planning → approved and its current version advances; the
 * deliverables the new scope dropped are marked superseded (history kept, nothing deleted). Approval authorizes
 * nothing downstream: no spend, no asset, no publication. Creative materialisation is the caller's next step.
 */
export async function approveSpec(db: Db, athleteId: string, campaignId: string, version: number, actor: string, now = new Date()): Promise<{ campaign: Campaign; spec: CampaignSpec; dropped: CampaignDeliverable[]; alreadyApproved: boolean }> {
  const c = await getCampaign(db, athleteId, campaignId); if (!c) throw new CampaignRefused("campaign not found");
  const specs = await listSpecs(db, athleteId, campaignId); const latest = specs[specs.length - 1];
  const spec = specs.find((s) => s.version === version); if (!spec) throw new CampaignRefused(`no spec version ${version}`);
  if (spec.approval !== "draft") return { campaign: c, spec, dropped: [], alreadyApproved: true };
  if (latest.version !== version) throw new CampaignRefused(`version ${version} is superseded by version ${latest.version}; approve the current scope`);
  const [s] = await db.update(campaignSpecs).set({ approval: "athlete", approved_at: now, approved_by: actor }).where(eq(campaignSpecs.id, spec.id)).returning();
  const inScope = new Set(spec.deliverableIds);
  const dropped: CampaignDeliverable[] = [];
  for (const d of await listDeliverables(db, athleteId, campaignId)) {
    if (!inScope.has(d.id) && d.supersededVersion === null) {
      const [row] = await db.update(campaignDeliverables).set({ superseded_version: version, superseded_at: now }).where(eq(campaignDeliverables.id, d.id)).returning();
      dropped.push(toDeliverable(row));
    }
  }
  const [cc] = await db.update(campaigns).set({ status: c.status === "planning" ? "approved" : c.status, current_spec_version: version }).where(eq(campaigns.id, campaignId)).returning();
  return { campaign: toCampaign(cc), spec: toSpec(s), dropped, alreadyApproved: false };
}

/**
 * EXTERNAL CONFIRMATION (Amendment 3): the one write that closes an `externally_confirmed` obligation, by the party outside
 * Studio that confirms it. Refused for any other criterion (those are derived) and for a deal-door deliverable (its status
 * is read through from deal_deliverables and never written here — invariant 6).
 */
export async function confirmExternally(db: Db, athleteId: string, deliverableId: string, by: string, now = new Date(), ref: string | null = null): Promise<CampaignDeliverable> {
  const rows = await db.select().from(campaignDeliverables).where(and(eq(campaignDeliverables.id, deliverableId), eq(campaignDeliverables.athlete_id, athleteId))).limit(1);
  const d = rows[0] ? toDeliverable(rows[0]) : null; if (!d) throw new CampaignRefused("deliverable not found");
  if (d.intent.completesWhen !== "externally_confirmed") throw new CampaignRefused(`this obligation completes on "${d.intent.completesWhen}" — derived from Studio's records, not confirmed by hand`);
  if (d.dealDeliverableId) throw new CampaignRefused("a deal-door deliverable's status is read through from deal_deliverables; the campaign never writes it");
  if (d.status !== "open") return d;
  // 0075: an external confirmation is an outcome observation — it keeps who confirmed it, when, and what it points at.
  if (!by?.trim()) throw new CampaignRefused("an external confirmation records who confirmed it");
  const [row] = await db.update(campaignDeliverables).set({ status: "fulfilled", confirmed_by: by.trim(), confirmed_at: now, confirmation_ref: ref?.trim() || null }).where(eq(campaignDeliverables.id, d.id)).returning();
  return toDeliverable(row);
}

/** The reference the Recommendation ledger records under execution.refs when it is mounted on this path — the caller's write, isolated here. */
export const executionRefFor = (c: Pick<Campaign, "id">) => ({ kind: "campaign" as const, id: c.id });
export { isNull };
