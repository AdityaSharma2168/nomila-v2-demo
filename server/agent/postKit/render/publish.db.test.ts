/**
 * publish.db.test.ts — a preview's files as derived media assets (render/publish.ts), and its job on the real stitch
 * queue (studio/stitchRunner.ts), on PGlite (real Postgres: the FKs, the CHECKs, the claim, the advisory lock). GCS is
 * faked.
 *
 *   D1 published: origin generated, platform studio, draft, derived_from_asset_id = the source, under the athlete's
 *      prefix with the run's own count in each path; a video's cover is its poster; marked a preview
 *   D2 once: a re-run updates the same rows; two runs of one key at once write one row per path (advisory lock);
 *      findPublishedOutputs finds what a run actually wrote, and only the athlete's
 *   D3 a preview is not hers to browse: the library list, the Studio pickers, the Made shelf, search and enrichment skip it
 *   D4 the queue: a render row is claimed by the stitch tick and worked by the post-kit worker; with the Studio dark the
 *      tick claims render rows only, never a Studio timeline; a render the reaper gives up on marks its kit failed
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../../lib/mediaStore", () => ({
  signedUrl: jest.fn(),
  uploadLocalFile: jest.fn(async () => undefined),
  UPLOAD_LIMITS: { image: { max: 25 * 1024 * 1024, types: [] }, video: { max: 200 * 1024 * 1024, types: [] } },
}));

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import type { ActionDecisionDetail } from "../../../../shared/plan";
import type { PostKitPreview } from "../../../../shared/postKit";
import { athletes, mediaAssets, studioStitchJobs } from "../../../../shared/schema";
import { uploadLocalFile } from "../../../lib/mediaStore";
import { notAPreview, POST_KIT_PREVIEW_FORMAT } from "../../../lib/previewAsset";
import { herPhoto } from "../../../studio/photoPredicate";
import { inFlightCount, stitchTick } from "../../../studio/stitchRunner";
import { claimStitchJobs, maxAttempts, queueStitch } from "../../../studio/stitchJobs";
import { closeTestDb, db, initTestDb } from "../../../testUtils/pgliteDb";
import { dbStore } from "../../research/dbStore";
import { renderJobSpec, renderKey, type RenderPlan } from "./compile";
import type { LocalRender } from "./local";
import { findPublishedOutputs, outputsExist, publishRenderOutputs } from "./publish";
import { RENDER_ERRORS } from "./worker";

jest.setTimeout(120_000);

const HER = "77777777-2222-4777-8777-777777777777";
const OTHER = "88888888-2222-4888-8888-888888888888";
const DECISION = "30000000-0000-4000-8000-000000000009";
const KEY = "a".repeat(32);
const DIR = mkdtempSync(join(tmpdir(), "post-kit-publish-"));
let photoId = ""; let clipId = "";
const mockUpload = uploadLocalFile as jest.MockedFunction<typeof uploadLocalFile>;
const ENV = ["AGENT_POST_KITS", "AGENT_POST_KIT_RENDER", "STUDIO_ENABLED", "STUDIO_ALL_ON"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const file = (name: string, bytes: number) => { const p = join(DIR, name); writeFileSync(p, Buffer.alloc(bytes, 7)); return p; };

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([{ id: HER, full_name: "Render Athlete" }, { id: OTHER, full_name: "Another" }] as never);
  const [p] = await db.insert(mediaAssets).values({ athlete_id: HER, platform: "upload", origin: "upload", media_type: "IMAGE", status: "stored", gcs_path: `athletes/${HER}/p.jpg`, content_type: "image/jpeg" } as never).returning({ id: mediaAssets.id });
  const [c] = await db.insert(mediaAssets).values({ athlete_id: HER, platform: "upload", origin: "upload", media_type: "VIDEO", status: "stored", gcs_path: `athletes/${HER}/c.mp4` } as never).returning({ id: mediaAssets.id });
  photoId = p.id; clipId = c.id;
});
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeTestDb();
  rmSync(DIR, { recursive: true, force: true });
});

const carousel = (): LocalRender => ({
  outputs: [
    { path: file("0.jpg", 1000), kind: "image", contentType: "image/jpeg", width: 1080, height: 1350, durationSec: null, sourceAssetId: photoId },
    { path: file("1.mp4", 5000), kind: "video", contentType: "video/mp4", width: 1080, height: 1350, durationSec: 2.47, sourceAssetId: clipId },
  ],
  cover: { outputIndex: 1, path: file("1.cover.jpg", 300) },
});
const previews = () => db.select().from(mediaAssets).where(eq(mediaAssets.content_format, POST_KIT_PREVIEW_FORMAT));

describe("D1 + D2: published, once", () => {
  it("derived assets with lineage under her prefix, the run's count in each path, a video's cover as its poster", async () => {
    const out = await publishRenderOutputs({ athleteId: HER, decisionId: DECISION, key: KEY, render: carousel() });
    expect(out.map((o) => [o.kind, o.sourceAssetId])).toEqual([["image", photoId], ["video", clipId]]);
    const prefix = `athletes/${HER}/studio/post-kit/${DECISION}/${KEY}`;
    expect(mockUpload.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [`${prefix}/0-of-2.jpg`, "image/jpeg"], [`${prefix}/1-of-2.mp4`, "video/mp4"], [`${prefix}/1-of-2.cover.jpg`, "image/jpeg"],
    ]);
    const [video] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, out[1].assetId));
    expect(video).toMatchObject({
      athlete_id: HER, origin: "generated", platform: "studio", media_type: "VIDEO", status: "stored", approval_status: "draft",
      gcs_path: `${prefix}/1-of-2.mp4`, gcs_thumb_path: `${prefix}/1-of-2.cover.jpg`, content_type: "video/mp4",
      content_format: POST_KIT_PREVIEW_FORMAT, derived_from_asset_id: clipId,
      width: 1080, height: 1350, bytes: 5000, duration_seconds: 2, duration_seconds_precise: 2.47, generation_job_id: null,
    });
    const [picture] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, out[0].assetId));
    expect(picture).toMatchObject({ media_type: "IMAGE", derived_from_asset_id: photoId, gcs_thumb_path: null, duration_seconds: null, content_format: POST_KIT_PREVIEW_FORMAT });

    // A re-run updates in place; two runs at once still write one row per path.
    expect(await publishRenderOutputs({ athleteId: HER, decisionId: DECISION, key: KEY, render: carousel() })).toEqual(out);
    const [a, b] = await Promise.all([1, 2].map(() => publishRenderOutputs({ athleteId: HER, decisionId: DECISION, key: KEY, render: carousel() })));
    expect(a).toEqual(out);
    expect(b).toEqual(out);
    expect(await previews()).toHaveLength(2);

    expect(await findPublishedOutputs(HER, DECISION, KEY)).toEqual(out);
    expect(await findPublishedOutputs(OTHER, DECISION, KEY)).toBeNull();
    expect(await findPublishedOutputs(HER, DECISION, "b".repeat(32))).toBeNull();
    expect(await outputsExist(HER, out.map((o) => o.assetId))).toBe(true);
    expect(await outputsExist(OTHER, out.map((o) => o.assetId))).toBe(false);
  });

  it("finds what a run ACTUALLY wrote: a set published short (a slide left out) is whole at its own count", async () => {
    const key = "c".repeat(32);
    const one: LocalRender = { outputs: [carousel().outputs[0]], cover: { outputIndex: 0, path: null } };
    const out = await publishRenderOutputs({ athleteId: HER, decisionId: DECISION, key, render: one });
    expect(await findPublishedOutputs(HER, DECISION, key)).toEqual(out);
    // A deleted output breaks the set: it is rendered again rather than shown half gone.
    await db.update(mediaAssets).set({ deleted_at: new Date() } as never).where(eq(mediaAssets.id, out[0].assetId));
    expect(await findPublishedOutputs(HER, DECISION, key)).toBeNull();
    expect(await outputsExist(HER, [out[0].assetId])).toBe(false);
  });
});

describe("D3: a preview is not hers to browse", () => {
  it("the predicates every library reader shares skip it", async () => {
    const own = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(herPhoto(HER));
    expect(own.map((r) => r.id)).toEqual([photoId]);
    const visible = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.athlete_id, HER), notAPreview()));
    expect(visible.map((r) => r.id).sort()).toEqual([photoId, clipId].sort());
    expect((await previews()).length).toBeGreaterThan(0);
  });
});

describe("D4: the queue", () => {
  const plan: () => RenderPlan = () => ({
    contract: "post-kit-render/1", format: "feed", aspect: "4:5", width: 1080, height: 1350, cropToFill: true, look: "natural",
    positions: [{ assetId: photoId, kind: "still", trimStartSec: null, trimEndSec: null, holdSec: null, crossfadeSec: null }],
    cover: { position: 0, offsetSec: 0 }, output: "slides",
  });
  const settle = async () => { for (let i = 0; i < 200 && inFlightCount() > 0; i++) await new Promise((r) => setTimeout(r, 20)); };
  beforeEach(async () => {
    await db.delete(studioStitchJobs);
    for (const k of ENV) delete process.env[k];
  });

  it("a render row is claimed by the stitch tick and worked by the post-kit worker; capacity is given back", async () => {
    // Switched off after it was queued: the post-kit worker's own refusal, not the timeline parser's.
    process.env.STUDIO_ENABLED = "true";
    process.env.AGENT_POST_KITS = "true";
    process.env.AGENT_POST_KIT_RENDER = "false";
    const id = await queueStitch(HER, renderJobSpec(DECISION, plan(), renderKey(plan())));
    expect((await stitchTick()).claimed).toBe(1);
    await settle();
    expect(inFlightCount()).toBe(0);
    const [row] = await db.select().from(studioStitchJobs).where(eq(studioStitchJobs.id, id));
    expect(row).toMatchObject({ status: "failed", last_error: RENDER_ERRORS.off, lease_holder: null });
  });

  it("with the Studio dark and previews on, the tick claims the render row only — never a Studio timeline", async () => {
    process.env.STUDIO_ENABLED = "false";
    process.env.AGENT_POST_KITS = "true";
    process.env.AGENT_POST_KIT_RENDER = "true";
    const timeline = await queueStitch(HER, { clips: [{ assetId: clipId }], target: "portrait" });
    const render = await queueStitch(HER, renderJobSpec(DECISION, plan(), renderKey(plan())));
    // The kit is gone, so the worker cancels nothing and fails nothing it should not: what matters is what was claimed.
    expect((await stitchTick()).claimed).toBe(1);
    await settle();
    const rows = new Map((await db.select().from(studioStitchJobs)).map((r) => [r.id, r]));
    expect(rows.get(timeline)).toMatchObject({ status: "queued", attempts: 0 });
    expect(rows.get(render)!.status).not.toBe("queued");
    // And the filter itself, directly: kind-filtered claims leave the timeline alone.
    await db.update(studioStitchJobs).set({ status: "queued" } as never).where(eq(studioStitchJobs.id, render));
    const claimed = await claimStitchJobs(5, "probe", { kind: "post_kit_render" });
    expect(claimed.map((j) => j.id)).toEqual([render]);
  });

  it("a render the reaper gives up on marks its kit failed — never left saying queued", async () => {
    process.env.STUDIO_ENABLED = "true";
    process.env.AGENT_POST_KITS = "true";
    process.env.AGENT_POST_KIT_RENDER = "true";
    const goal = await dbStore.insertGoal(HER, { text: "Grow", source: "said", decisionId: null });
    const d = await dbStore.insertDecision(HER, { runId: null, skillId: "plan", kind: "action", suggested: "s", why: "w", evidence: [], goalId: goal.id, detail: {} });
    const p = plan();
    const key = renderKey(p);
    const id = await queueStitch(HER, renderJobSpec(d.id, p, key));
    const preview: PostKitPreview = {
      contract: "post-kit-render/1", key, status: "queued", jobId: id, outputs: [], coverAssetId: null, notes: [], error: null,
      requestedAt: new Date().toISOString(), renderedAt: null,
    };
    const kit = { contract: "post-kit/1", assets: [{ assetId: photoId }], treatmentPlan: { order: [photoId] }, preview };
    await dbStore.updateDecision(HER, d.id, { detail: { kind: "post", state: "made", prepared: { studioItemId: d.id, postKit: kit } } });
    // A job that has burned every attempt and whose holder died.
    await db.update(studioStitchJobs).set({ status: "running", attempts: maxAttempts(), lease_holder: "dead", lease_until: new Date(Date.now() - 1000) } as never)
      .where(eq(studioStitchJobs.id, id));
    const tick = await stitchTick();
    expect(tick.reaped.exhausted).toBe(1);
    const [row] = await db.select().from(studioStitchJobs).where(eq(studioStitchJobs.id, id));
    expect(row.status).toBe("failed");
    const det = (await dbStore.getDecision(HER, d.id))!.detail as unknown as ActionDecisionDetail;
    expect(det.prepared!.postKit!.preview).toMatchObject({ status: "failed", error: RENDER_ERRORS.exhausted, key });
  });
});
