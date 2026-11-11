/**
 * creative/store.ts — creative_intents and creative_interpretations, narrowly. The intent has no status column: state is
 * READ from downstream (interpretations, studio_plans, generation_jobs, media_assets, content_posts) through creative_intent_id; the only
 * write after creation is withdrawal. Interpretations are versioned per intent; confirmation is a separate write that may
 * establish a format class the ask did not. Nothing here calls a provider or touches Studio's gates.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { contentPosts, creativeIntents, creativeInterpretations, generationJobs, mediaAssets, studioPlans, studioStitchJobs } from "../../../../shared/schema";
import { notAPreview } from "../../../lib/previewAsset";
import { CREATIVE_INTENT_VERSION, type CreativeIntent } from "./contract";
import { deriveIntentState, type Downstream, type IntentState } from "./intents";

type Db = PgDatabase<any, any, any>;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface CreativeIntentRecord extends CreativeIntent { intentKey: string }

function toRecord(r: typeof creativeIntents.$inferSelect): CreativeIntentRecord {
  return { version: CREATIVE_INTENT_VERSION, id: r.id, athleteId: r.athlete_id, intentKey: r.intent_key, source: { kind: r.source_kind as CreativeIntent["source"]["kind"], ref: r.source_ref }, purpose: r.purpose, why: r.why, audienceRole: r.audience_role, brandId: r.brand_id, format: r.format as CreativeIntent["format"], channel: r.channel, timing: r.timing, constraints: (r.constraints as CreativeIntent["constraints"]) ?? [], ask: (r.ask as CreativeIntent["ask"]) ?? null, lineage: (r.lineage as CreativeIntent["lineage"]) ?? {}, createdAt: iso(r.created_at)!, withdrawnAt: iso(r.withdrawn_at) };
}

/** Idempotent on (athleteId, intentKey): a retry of the same ask returns the existing row and creates nothing. */
export async function createCreativeIntent(db: Db, i: Omit<CreativeIntent, "id" | "createdAt" | "withdrawnAt" | "version">, intentKey: string): Promise<{ record: CreativeIntentRecord; created: boolean }> {
  const existing = await db.select().from(creativeIntents).where(and(eq(creativeIntents.athlete_id, i.athleteId), eq(creativeIntents.intent_key, intentKey))).limit(1);
  if (existing[0]) return { record: toRecord(existing[0]), created: false };
  const [row] = await db.insert(creativeIntents).values({ athlete_id: i.athleteId, version: CREATIVE_INTENT_VERSION, intent_key: intentKey, source_kind: i.source.kind, source_ref: i.source.ref, purpose: i.purpose, why: i.why, audience_role: i.audienceRole, brand_id: i.brandId, format: i.format, channel: i.channel, timing: i.timing, constraints: i.constraints, ask: i.ask, lineage: i.lineage }).returning();
  return { record: toRecord(row), created: true };
}

export async function getCreativeIntent(db: Db, athleteId: string, id: string): Promise<CreativeIntentRecord | null> {
  const rows = await db.select().from(creativeIntents).where(and(eq(creativeIntents.id, id), eq(creativeIntents.athlete_id, athleteId))).limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * WITHDRAWAL: the intent is no longer active as an instruction. After it: no new interpretation, no confirmation, no
 * brief, no plan and no job may be prepared from it (every writer checks `withdrawnAt`). Already-created plans, jobs and
 * assets are NOT deleted or rewritten — they stay auditable; an in-flight job keeps Studio's own cancellation semantics.
 */
export async function withdrawCreativeIntent(db: Db, athleteId: string, id: string, now = new Date()): Promise<CreativeIntentRecord> {
  const [row] = await db.update(creativeIntents).set({ withdrawn_at: now }).where(and(eq(creativeIntents.id, id), eq(creativeIntents.athlete_id, athleteId))).returning();
  if (!row) throw new Error(`creative intent ${id} not found`);
  return toRecord(row);
}

// ── interpretations ──────────────────────────────────────────────────────────────────────────────

export interface InterpretationRecord {
  id: string; athleteId: string; creativeIntentId: string; version: number; supersedes: string | null; sourceTool: string;
  proposal: unknown; flags: unknown[]; createdAt: string;
  confirmedAt: string | null; confirmedConcept: unknown | null; confirmedFormatClass: string | null; confirmedFlags: unknown[] | null;
}
const toInterp = (r: typeof creativeInterpretations.$inferSelect): InterpretationRecord => ({ id: r.id, athleteId: r.athlete_id, creativeIntentId: r.creative_intent_id, version: r.version, supersedes: r.supersedes ?? null, sourceTool: r.source_tool, proposal: r.proposal, flags: (r.flags as unknown[]) ?? [], createdAt: iso(r.created_at)!, confirmedAt: iso(r.confirmed_at), confirmedConcept: r.confirmed_concept ?? null, confirmedFormatClass: r.confirmed_format_class ?? null, confirmedFlags: (r.confirmed_flags as unknown[] | null) ?? null });

/** A new version supersedes the latest; a withdrawn intent takes none. */
export async function addInterpretation(db: Db, input: { athleteId: string; creativeIntentId: string; sourceTool: string; proposal: unknown; flags: unknown[] }): Promise<InterpretationRecord> {
  const intent = await getCreativeIntent(db, input.athleteId, input.creativeIntentId);
  if (!intent) throw new Error("creative intent not found");
  if (intent.withdrawnAt) throw new Error("creative intent is withdrawn — no new interpretation");
  const latest = await latestInterpretation(db, input.athleteId, input.creativeIntentId);
  const [row] = await db.insert(creativeInterpretations).values({ athlete_id: input.athleteId, creative_intent_id: input.creativeIntentId, version: (latest?.version ?? 0) + 1, supersedes: latest?.id ?? null, source_tool: input.sourceTool, proposal: input.proposal, flags: input.flags }).returning();
  return toInterp(row);
}

export async function latestInterpretation(db: Db, athleteId: string, creativeIntentId: string): Promise<InterpretationRecord | null> {
  const rows = await db.select().from(creativeInterpretations).where(and(eq(creativeInterpretations.athlete_id, athleteId), eq(creativeInterpretations.creative_intent_id, creativeIntentId))).orderBy(desc(creativeInterpretations.version)).limit(1);
  return rows[0] ? toInterp(rows[0]) : null;
}

export async function confirmedInterpretation(db: Db, athleteId: string, creativeIntentId: string): Promise<InterpretationRecord | null> {
  const rows = await db.select().from(creativeInterpretations).where(and(eq(creativeInterpretations.athlete_id, athleteId), eq(creativeInterpretations.creative_intent_id, creativeIntentId), isNotNull(creativeInterpretations.confirmed_at))).orderBy(desc(creativeInterpretations.version)).limit(1);
  return rows[0] ? toInterp(rows[0]) : null;
}

/**
 * CONFIRMATION — the load-bearing read stage. The athlete confirms the interpretation, the concept she chose, the inferred
 * fields she accepts, and — only when the intent fixed none, or hers was wrong — the format class. The intent's verbatim
 * ask is never mutated; the confirmed format lives on the interpretation.
 */
export async function confirmInterpretation(db: Db, input: { athleteId: string; interpretationId: string; concept: unknown | null; flags: unknown[]; formatClass: string | null }, now = new Date()): Promise<InterpretationRecord> {
  const rows = await db.select().from(creativeInterpretations).where(and(eq(creativeInterpretations.id, input.interpretationId), eq(creativeInterpretations.athlete_id, input.athleteId))).limit(1);
  const r = rows[0]; if (!r) throw new Error("interpretation not found");
  const intent = await getCreativeIntent(db, input.athleteId, r.creative_intent_id);
  if (!intent || intent.withdrawnAt) throw new Error("creative intent is withdrawn — nothing to confirm");
  const latest = await latestInterpretation(db, input.athleteId, r.creative_intent_id);
  if (latest && latest.id !== r.id) throw new Error(`interpretation ${r.id} is superseded by version ${latest.version}`);
  const [row] = await db.update(creativeInterpretations).set({ confirmed_at: now, confirmed_concept: input.concept, confirmed_flags: input.flags, confirmed_format_class: input.formatClass }).where(eq(creativeInterpretations.id, r.id)).returning();
  return toInterp(row);
}

// ── derived state (read only) ────────────────────────────────────────────────────────────────────

export async function downstreamOf(db: Db, athleteId: string, creativeIntentId: string): Promise<Downstream> {
  const interps = await db.select({ id: creativeInterpretations.id, confirmed_at: creativeInterpretations.confirmed_at }).from(creativeInterpretations).where(and(eq(creativeInterpretations.athlete_id, athleteId), eq(creativeInterpretations.creative_intent_id, creativeIntentId)));
  const plans = await db.select({ id: studioPlans.id, parent: studioPlans.parent_plan_id, version: studioPlans.version }).from(studioPlans).where(and(eq(studioPlans.athlete_id, athleteId), eq(studioPlans.creative_intent_id, creativeIntentId)));
  const jobs = await db.select({ id: generationJobs.id, status: generationJobs.status }).from(generationJobs).where(and(eq(generationJobs.athlete_id, athleteId), eq(generationJobs.creative_intent_id, creativeIntentId)));
  const assets = jobs.length ? await db.select({ id: mediaAssets.id, job: mediaAssets.generation_job_id, approval: mediaAssets.approval_status }).from(mediaAssets).where(inArray(mediaAssets.generation_job_id, jobs.map((j) => j.id))) : [];
  const direct: Downstream["assets"] = assets.map((a) => ({ id: a.id, generationJobId: a.job!, approvalStatus: (a.approval as Approval) ?? null, postedAt: null }));
  const all = [...direct, ...(await reachedFrom(db, athleteId, creativeIntentId, direct))];
  const posted = await postedAtOf(db, all.map((a) => a.id));
  return {
    proposals: interps.map((p) => ({ intentId: creativeIntentId, confirmedAt: iso(p.confirmed_at) })),
    plans: plans.map((p) => ({ id: p.id, creativeIntentId, parentPlanId: p.parent ?? null, version: p.version })),
    jobs: jobs.map((j) => ({ id: j.id, creativeIntentId, status: j.status as Downstream["jobs"][number]["status"] })),
    assets: all.map((a) => ({ ...a, postedAt: posted.get(a.id) ?? null })),
  };
}

/**
 * WHEN AN ASSET WAS PUBLISHED: the earliest `content_posts.posted_at` for it. content_posts is the record the publish
 * runner writes once a post really exists (studio/publish/runner.ts recordPost) — the only writer, and the only
 * publication fact every publish leaves (published_asset_identities is skipped when the platform returned no usable id).
 * NOT `media_assets.posted_at`: that column is the platform's post date of media synced FROM her accounts, or an
 * upload's capture date (routes/media.ts postedAtFrom); nothing Studio publishes ever writes it.
 */
async function postedAtOf(db: Db, assetIds: string[]): Promise<Map<string, string>> {
  if (!assetIds.length) return new Map();
  const rows = await db.select({ asset: contentPosts.asset_id, posted: sql<Date | string | null>`min(${contentPosts.posted_at})` }).from(contentPosts)
    .where(and(inArray(contentPosts.asset_id, assetIds), isNotNull(contentPosts.posted_at))).groupBy(contentPosts.asset_id);
  return new Map(rows.map((r) => [r.asset, iso(r.posted)!]));
}

type Approval = Downstream["assets"][number]["approvalStatus"];

/**
 * How many derivation hops a lineage walk follows (an edit of an edit, a reel stitched from an edit ...) before it
 * stops. A `seen` set catches a cycle; this catches a chain that is merely absurd. Same posture as studio/qa/chain.ts.
 */
export const MAX_DERIVATION_HOPS = 8;

/**
 * THE TWO RECORDED HOPS an intent's output can take without its own generation job carrying the intent id. Read
 * forward from the assets the intent's jobs produced; nothing is written, nothing is inferred:
 *
 *   edit    media_assets.derived_from_asset_id = a reached asset. The edit engine (studio/edit/engine.ts) opens its
 *           own job with no creative_intent_id, so the edit is reachable only through its source. An edit whose OWN
 *           job carries a DIFFERENT intent belongs to that intent and is not claimed here.
 *   stitch  a succeeded studio_stitch_jobs row whose spec.clips[].assetId names a reached asset -> its output_asset_id.
 *           The reel is written with generation_job_id NULL (studio/video/materialize.ts publishStitchOutput); the
 *           stitch row is its only link. A reel cut from clips of several intents is reachable from each of them.
 *           `bedAssetId` is sound laid underneath, not footage: it does not make a reel part of an intent.
 *
 * Each reached asset names the intent job it is reached through, so deriveIntentState counts it like the job's own.
 */
async function reachedFrom(db: Db, athleteId: string, creativeIntentId: string, direct: Downstream["assets"]): Promise<Downstream["assets"]> {
  const through = new Map<string, string>(direct.map((a) => [a.id, a.generationJobId!]));
  const out: Downstream["assets"] = [];
  let frontier = direct.map((a) => a.id);
  for (let hop = 0; hop < MAX_DERIVATION_HOPS && frontier.length; hop++) {
    const next: string[] = [];
    const edits = await db.select({ id: mediaAssets.id, job: mediaAssets.generation_job_id, from: mediaAssets.derived_from_asset_id, approval: mediaAssets.approval_status, jobIntent: generationJobs.creative_intent_id })
      .from(mediaAssets).leftJoin(generationJobs, eq(generationJobs.id, mediaAssets.generation_job_id))
      // A post-kit preview (lib/previewAsset.ts) is a by-product of its kit, not an output of any intent.
      .where(and(eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.derived_from_asset_id, frontier), notAPreview()));
    for (const e of edits) {
      if (through.has(e.id) || (e.jobIntent && e.jobIntent !== creativeIntentId)) continue;
      const jobId = through.get(e.from!)!;
      through.set(e.id, jobId); next.push(e.id);
      out.push({ id: e.id, generationJobId: e.job ?? null, approvalStatus: (e.approval as Approval) ?? null, postedAt: null, reachedThrough: { jobId, by: "edit", ref: e.from! } });
    }
    const ids = sql.join(frontier.map((id) => sql`${id}`), sql`, `);
    const stitches = await db.select({ id: studioStitchJobs.id, spec: studioStitchJobs.spec, output: studioStitchJobs.output_asset_id }).from(studioStitchJobs)
      .where(and(eq(studioStitchJobs.athlete_id, athleteId), eq(studioStitchJobs.status, "succeeded"), isNotNull(studioStitchJobs.output_asset_id),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${studioStitchJobs.spec}->'clips') AS c WHERE c->>'assetId' IN (${ids}))`));
    const fresh = stitches.filter((s) => !through.has(s.output!));
    const outputs = fresh.length ? await db.select({ id: mediaAssets.id, job: mediaAssets.generation_job_id, approval: mediaAssets.approval_status }).from(mediaAssets).where(and(eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.id, fresh.map((s) => s.output!)), notAPreview())) : [];
    for (const s of fresh) {
      const o = outputs.find((x) => x.id === s.output);
      if (!o || through.has(o.id)) continue;
      // The first clip, in timeline order, that this intent reached.
      const clip = ((s.spec as { clips?: Array<{ assetId?: string }> }).clips ?? []).find((c) => c.assetId && through.has(c.assetId));
      if (!clip) continue;
      const jobId = through.get(clip.assetId!)!;
      through.set(o.id, jobId); next.push(o.id);
      out.push({ id: o.id, generationJobId: o.job ?? null, approvalStatus: (o.approval as Approval) ?? null, postedAt: null, reachedThrough: { jobId, by: "stitch", ref: s.id } });
    }
    frontier = next;
  }
  return out;
}

export async function creativeIntentState(db: Db, athleteId: string, creativeIntentId: string): Promise<{ intent: CreativeIntentRecord; state: IntentState; downstream: Downstream } | null> {
  const intent = await getCreativeIntent(db, athleteId, creativeIntentId);
  if (!intent) return null;
  const downstream = await downstreamOf(db, athleteId, creativeIntentId);
  return { intent, state: deriveIntentState(intent, downstream), downstream };
}
