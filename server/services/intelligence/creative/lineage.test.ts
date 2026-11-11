/**
 * creative/lineage.test.ts — the two recorded hops an intent's output takes without its own job carrying the intent id,
 * read both ways against PGlite: DOWN from the Creative Request (downstreamOf) and UP from the asset (lineageForAsset).
 *
 *   stitch  a reel is written with generation_job_id NULL; studio_stitch_jobs (spec.clips[].assetId → output_asset_id)
 *           is its only link.
 *   edit    the edit engine opens its own job with no creative_intent_id; media_assets.derived_from_asset_id is the link.
 *
 * Synthetic rows only; nothing here reaches a provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { eq } from "drizzle-orm";
import { athletes, creativeIntents, generationJobs, mediaAssets, studioStitchJobs } from "../../../../shared/schema";
import { closeTestDb, db, initTestDb } from "../../../testUtils/pgliteDb";
import { lineageForAsset } from "../outcome/attribution";
import { deriveIntentState } from "./intents";
import { downstreamOf, getCreativeIntent } from "./store";

let athleteId = "";
beforeAll(async () => { await initTestDb(); const [a] = await db.insert(athletes).values({ full_name: "Test Athlete" }).returning(); athleteId = a.id; });
afterAll(closeTestDb);

let n = 0;
async function intent(lineage: Record<string, unknown> = {}) {
  const [row] = await db.insert(creativeIntents).values({ athlete_id: athleteId, version: "creative-intent/0.1.0-exp", intent_key: `k-${++n}`, source_kind: "campaign", source_ref: `campaign[${n}]`, purpose: "a reel", format: { class: "reel", quantity: 1, dueOn: null, fixedBy: "contract" }, constraints: [], lineage } as any).returning();
  return row.id as string;
}
async function job(intentId: string | null, editOf?: string) {
  const [row] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "system", mode: editOf ? "edit" : "generate", source_asset_id: editOf ?? null, objective: "recap", deliverable: "clip", brief: {}, status: "succeeded", creative_intent_id: intentId } as any).returning();
  return row.id as string;
}
async function asset(o: { jobId?: string | null; derivedFrom?: string | null; media?: string; approval?: string } = {}) {
  const [row] = await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "studio", origin: o.jobId === undefined && !o.derivedFrom ? "upload" : "generated", media_type: o.media ?? "VIDEO", status: "stored", generation_job_id: o.jobId ?? null, derived_from_asset_id: o.derivedFrom ?? null, approval_status: o.approval ?? "draft" } as any).returning();
  return row.id as string;
}
async function stitch(clipIds: string[], output: string | null, o: { status?: string; bedAssetId?: string } = {}) {
  const [row] = await db.insert(studioStitchJobs).values({ athlete_id: athleteId, spec: { clips: clipIds.map((assetId) => ({ assetId })), target: "portrait", ...(o.bedAssetId ? { bedAssetId: o.bedAssetId } : {}) }, status: o.status ?? "succeeded", output_asset_id: output, completed_at: new Date() } as any).returning();
  return row.id as string;
}
const stateOf = async (id: string) => deriveIntentState((await getCreativeIntent(db, athleteId, id))!, await downstreamOf(db, athleteId, id));

describe("stitched reel ↔ Creative Request", () => {
  it("a reel stitched from an intent's clips (plus her own upload) is reachable from the intent and traces back to it, through the stitch row", async () => {
    const i = await intent({ campaignId: "camp-1", recommendationId: "rec-1", campaignDeliverableId: "del-1" });
    const j = await job(i);
    const clipA = await asset({ jobId: j }); const clipB = await asset({ jobId: j }); const upload = await asset();
    const reel = await asset({ jobId: null, approval: "approved" });
    const s = await stitch([upload, clipA, clipB], reel);

    const d = await downstreamOf(db, athleteId, i);
    expect(d.assets.map((a) => a.id).sort()).toEqual([clipA, clipB, reel].sort());
    expect(d.assets.find((a) => a.id === reel)).toMatchObject({ generationJobId: null, approvalStatus: "approved", reachedThrough: { jobId: j, by: "stitch", ref: s } });
    expect(await stateOf(i)).toBe("cleared");                                    // the approved reel clears it; the draft clips alone would not

    const up = await lineageForAsset(db, athleteId, reel);
    expect(up).toMatchObject({ assetId: reel, jobId: j, creativeIntentId: i, source: "campaign", campaignId: "camp-1", recommendationId: "rec-1", campaignDeliverableId: "del-1", through: [{ by: "stitch", assetId: reel, stitchJobId: s }] });
    // A direct asset's lineage is unchanged: its own job, no hops.
    const direct = await lineageForAsset(db, athleteId, clipA);
    expect(direct).toMatchObject({ jobId: j, creativeIntentId: i }); expect(direct.through).toBeUndefined();
  });

  it("only a SUCCEEDED stitch counts, and a bed (sound under the reel) does not make a reel part of an intent", async () => {
    const i = await intent(); const j = await job(i); const clip = await asset({ jobId: j });
    const queuedOut = await asset({ jobId: null }); await stitch([clip], queuedOut, { status: "running" });
    const other = await asset(); const bedOnly = await asset({ jobId: null }); await stitch([other], bedOnly, { bedAssetId: clip });
    const d = await downstreamOf(db, athleteId, i);
    expect(d.assets.map((a) => a.id)).toEqual([clip]);
    expect(await lineageForAsset(db, athleteId, queuedOut)).toMatchObject({ jobId: null, creativeIntentId: null });
    expect(await lineageForAsset(db, athleteId, bedOnly)).toMatchObject({ jobId: null, creativeIntentId: null });
  });

  it("a reel cut from two intents' clips is reachable from each, but traces back to neither — which one is not recorded", async () => {
    const i1 = await intent(); const i2 = await intent();
    const c1 = await asset({ jobId: await job(i1) }); const c2 = await asset({ jobId: await job(i2) });
    const reel = await asset({ jobId: null }); await stitch([c1, c2], reel);
    expect((await downstreamOf(db, athleteId, i1)).assets.map((a) => a.id)).toContain(reel);
    expect((await downstreamOf(db, athleteId, i2)).assets.map((a) => a.id)).toContain(reel);
    const up = await lineageForAsset(db, athleteId, reel);
    expect(up).toMatchObject({ assetId: reel, jobId: null, creativeIntentId: null, source: "none" }); expect(up.through).toBeUndefined();
  });
});

describe("edited asset ↔ Creative Request", () => {
  it("an edit (its own job carries no intent, as studio/edit opens it) is reached through derived_from — and so is a reel stitched from that edit", async () => {
    const i = await intent({ recommendationId: "rec-e" }); const j = await job(i);
    const original = await asset({ jobId: j, media: "IMAGE" });
    const editJob = await job(null, original);
    const edited = await asset({ jobId: editJob, derivedFrom: original, media: "IMAGE", approval: "approved" });
    const reel = await asset({ jobId: null }); const s = await stitch([edited], reel);

    const d = await downstreamOf(db, athleteId, i);
    expect(d.assets.find((a) => a.id === edited)).toMatchObject({ generationJobId: editJob, reachedThrough: { jobId: j, by: "edit", ref: original } });
    expect(d.assets.find((a) => a.id === reel)).toMatchObject({ reachedThrough: { jobId: j, by: "stitch", ref: s } });
    expect(d.jobs.map((x) => x.id)).toEqual([j]);                                  // the edit job is not rewritten into the intent's jobs
    expect(await stateOf(i)).toBe("cleared");

    expect(await lineageForAsset(db, athleteId, edited)).toMatchObject({ jobId: j, creativeIntentId: i, recommendationId: "rec-e", through: [{ by: "edit", assetId: edited, jobId: editJob, derivedFromAssetId: original }] });
    expect(await lineageForAsset(db, athleteId, reel)).toMatchObject({ jobId: j, creativeIntentId: i, through: [{ by: "stitch", assetId: reel, stitchJobId: s }, { by: "edit", assetId: edited, jobId: editJob, derivedFromAssetId: original }] });
  });

  it("an edit whose own job carries a DIFFERENT intent belongs to that intent only; an edit of an intent-less asset keeps its own job", async () => {
    const i1 = await intent(); const i2 = await intent();
    const original = await asset({ jobId: await job(i1), media: "IMAGE" });
    const j2 = await job(i2, original);
    const edited = await asset({ jobId: j2, derivedFrom: original, media: "IMAGE" });
    expect((await downstreamOf(db, athleteId, i1)).assets.map((a) => a.id)).toEqual([original]);
    expect(await lineageForAsset(db, athleteId, edited)).toMatchObject({ jobId: j2, creativeIntentId: i2 });

    const upload = await asset({ media: "IMAGE" }); const loneJob = await job(null, upload);
    const loneEdit = await asset({ jobId: loneJob, derivedFrom: upload, media: "IMAGE" });
    const l = await lineageForAsset(db, athleteId, loneEdit);
    expect(l).toMatchObject({ jobId: loneJob, creativeIntentId: null }); expect(l.through).toBeUndefined();
  });
});

describe("post-kit previews are not an intent's output", () => {
  it("a preview derived from an intent's clip, or the output of a render whose spec names it, is not reached", async () => {
    const i = await intent(); const j = await job(i); const clip = await asset({ jobId: j });
    const mark = async (id: string) => { await db.update(mediaAssets).set({ content_format: "post_kit_preview" } as any).where(eq(mediaAssets.id, id)); };
    const derived = await asset({ derivedFrom: clip }); await mark(derived);
    const rendered = await asset({ jobId: null }); await mark(rendered); await stitch([clip], rendered);
    // The same two hops without the mark ARE reached — so it is the mark that keeps the previews out.
    const edit = await asset({ derivedFrom: clip });
    const reel = await asset({ jobId: null }); await stitch([clip], reel);
    expect((await downstreamOf(db, athleteId, i)).assets.map((a) => a.id).sort()).toEqual([clip, edit, reel].sort());
  });
});
