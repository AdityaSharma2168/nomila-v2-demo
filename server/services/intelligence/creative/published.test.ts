/**
 * creative/published.test.ts — "published" is read from the record the publish runner writes, against PGlite.
 *
 * studio/publish/runner.ts recordPost is the only production publish path. Once a post exists it writes
 * published_asset_identities (outcome/publishedIdentity.ts) and one content_posts row (asset_id, platform, permalink,
 * posted_at). It never writes media_assets.posted_at — that column is a synced post's platform date or an upload's
 * capture date. These tests write exactly the runner's rows and nothing else.
 *
 * Synthetic rows only; nothing here reaches a provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { athletes, contentPosts, creativeIntents, generationJobs, mediaAssets, studioStitchJobs } from "../../../../shared/schema";
import { closeTestDb, db, initTestDb } from "../../../testUtils/pgliteDb";
import type { CampaignOriginProposal } from "../brain/executionRouter";
import { deliverableProgress } from "../campaign/fulfilment";
import { materializeCreativeIntents } from "../campaign/materialize";
import { approveSpec, createCampaignFromOrigin, proposeSpecVersion } from "../campaign/store";
import { recordPublishedIdentity } from "../outcome/publishedIdentity";
import { deriveIntentState } from "./intents";
import { downstreamOf, getCreativeIntent } from "./store";

let athleteId = "";
beforeAll(async () => { await initTestDb(); const [a] = await db.insert(athletes).values({ full_name: "Test Athlete" }).returning(); athleteId = a.id; });
afterAll(closeTestDb);

let n = 0;
async function intent() {
  const [row] = await db.insert(creativeIntents).values({ athlete_id: athleteId, version: "creative-intent/0.1.0-exp", intent_key: `k-${++n}`, source_kind: "athlete", source_ref: `mila:turn:${n}`, purpose: "a reel", format: { class: "reel", quantity: 1, dueOn: null, fixedBy: "athlete" }, constraints: [] } as any).returning();
  return row.id as string;
}
async function job(intentId: string | null, editOf?: string) {
  const [row] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "athlete", mode: editOf ? "edit" : "generate", source_asset_id: editOf ?? null, objective: "recap", deliverable: "clip", brief: {}, status: "succeeded", creative_intent_id: intentId } as any).returning();
  return row.id as string;
}
async function asset(o: { jobId?: string | null; derivedFrom?: string | null; approval?: string; origin?: string; postedAt?: Date } = {}) {
  const [row] = await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "studio", origin: o.origin ?? "generated", media_type: "VIDEO", status: "stored", generation_job_id: o.jobId ?? null, derived_from_asset_id: o.derivedFrom ?? null, approval_status: o.approval ?? "draft", posted_at: o.postedAt ?? null } as any).returning();
  return row.id as string;
}
async function stitch(clipIds: string[], output: string) {
  await db.insert(studioStitchJobs).values({ athlete_id: athleteId, spec: { clips: clipIds.map((assetId) => ({ assetId })), target: "portrait" }, status: "succeeded", output_asset_id: output, completed_at: new Date() } as any);
}
/** Exactly what runner.ts recordPost writes once Instagram says the post exists — and nothing else. */
async function publishAsTheRunnerDoes(assetId: string, mediaId: string, postedAt = new Date("2026-10-01T15:00:00Z")) {
  const permalink = `https://www.instagram.com/reel/${mediaId}/`;
  await recordPublishedIdentity(db, { athleteId, assetId, platform: "instagram", platformMediaId: mediaId, permalink, publishJobId: null });
  await db.insert(contentPosts).values({ asset_id: assetId, platform: "instagram", permalink, posted_at: postedAt } as never).onConflictDoNothing();
}
const stateOf = async (id: string) => deriveIntentState((await getCreativeIntent(db, athleteId, id))!, await downstreamOf(db, athleteId, id));

describe("published = the publish runner's record", () => {
  it("an edited clip stitched into a reel, published by the runner, makes the Creative Request `published`; approved-but-unposted stays `cleared`", async () => {
    const i = await intent(); const j = await job(i);
    const original = await asset({ jobId: j });
    const edited = await asset({ jobId: await job(null, original), derivedFrom: original, approval: "approved" });
    const reel = await asset({ jobId: null, approval: "approved" }); await stitch([edited], reel);

    expect(await stateOf(i)).toBe("cleared");                                                   // approved, nothing posted
    expect((await downstreamOf(db, athleteId, i)).assets.every((a) => a.postedAt === null)).toBe(true);

    await publishAsTheRunnerDoes(reel, "ig-reel-1");
    const d = await downstreamOf(db, athleteId, i);
    expect(d.assets.find((a) => a.id === reel)).toMatchObject({ postedAt: "2026-10-01T15:00:00.000Z", reachedThrough: { jobId: j, by: "stitch" } });
    expect(d.assets.find((a) => a.id === edited)!.postedAt).toBeNull();                        // only the posted asset carries the date
    expect(await stateOf(i)).toBe("published");
  });

  it("an edit published directly counts too; a published_asset_identities row alone (no post record) does not", async () => {
    const i = await intent(); const j = await job(i);
    const original = await asset({ jobId: j, approval: "approved" });
    const edited = await asset({ jobId: await job(null, original), derivedFrom: original, approval: "approved" });
    await recordPublishedIdentity(db, { athleteId, assetId: edited, platform: "instagram", platformMediaId: "ig-identity-only" });
    expect(await stateOf(i)).toBe("cleared");
    await publishAsTheRunnerDoes(edited, "ig-edit-1");
    expect(await stateOf(i)).toBe("published");
  });

  it("media_assets.posted_at (a synced post's date, an upload's capture date) is not a Studio publication", async () => {
    const i = await intent(); const j = await job(i);
    const clip = await asset({ jobId: j, approval: "approved" });
    const upload = await asset({ origin: "upload", postedAt: new Date("2026-08-01T00:00:00Z") });   // her own footage, dated by capture
    const reel = await asset({ jobId: null, approval: "approved", postedAt: new Date("2026-09-01T00:00:00Z") });
    await stitch([upload, clip], reel);
    expect(await stateOf(i)).toBe("cleared");
  });
});

describe("campaign fulfilment — completesWhen: published", () => {
  it("resolves once the runner has recorded the post", async () => {
    const origin: CampaignOriginProposal = { version: "execution-router/0.2.0-exp", shape: "campaign", door: "recommendation", recommendationId: "rec_pub", purpose: "One launch post.", objectiveIds: ["obj-1"], dealIds: [], brandIds: [], period: { startsOn: null, endsOn: null, endsWith: "objective_horizon", endsRef: "objective[obj-1]" }, constraints: [], evidence: [] };
    const { campaign } = await createCampaignFromOrigin(db, athleteId, origin);
    const v2 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [{ category: "content", contentFormat: "post", sourceQuote: null, quantity: 1, dueOn: null, optional: false, brandId: null, dealDeliverableId: null, completesWhen: "published" }], createdBy: "athlete" });
    await approveSpec(db, athleteId, campaign.id, 2, "athlete");
    const m = await materializeCreativeIntents(db, athleteId, campaign.id, 2);
    const a = await asset({ jobId: await job(m.created[0].id), approval: "approved" });
    expect(await deliverableProgress(db, athleteId, v2.added[0], m.created)).toMatchObject({ criterion: "published", satisfied: false, status: "open", under: { cleared: 1, published: 0 } });
    await publishAsTheRunnerDoes(a, "ig-campaign-1");
    expect(await deliverableProgress(db, athleteId, v2.added[0], m.created)).toMatchObject({ criterion: "published", satisfied: true, status: "fulfilled", under: { cleared: 1, published: 1 } });
  });
});
