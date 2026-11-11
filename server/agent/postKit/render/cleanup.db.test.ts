/**
 * cleanup.db.test.ts — the superseded-preview clean-up (render/cleanup.ts) and its cron route (cleanupRoutes.ts), on
 * PGlite (real Postgres). Storage is mocked: removeObject is a jest.fn, nothing reaches GCS.
 *
 *   C1 soft-delete: a preview row older than 24 h whose key is not its kit's current key is soft-deleted; the current
 *      key's rows, a row the current preview names, a younger row, a non-preview row and a row whose path is not under
 *      its own athlete's space are untouched; a decision that is gone counts as "no current key"
 *   C2 per athlete: another athlete's row under a path naming HER decision is judged against HIS store (not found), and
 *      her kit is never read for him
 *   C3 purge: a preview row soft-deleted more than 7 days ago has both files deleted and its paths let go; a younger
 *      deletion, a non-preview row and a path outside her space are untouched; a file a live row still uses is kept;
 *      a failed delete keeps the paths for the next pass
 *   C4 lifecycle: superseded today → soft-deleted; 8 days later → files gone; a third pass does nothing
 *   C5 the route: the secret, the flag (off → nothing runs), a failure
 *   C6 the flag in the Cloud Run yamls
 *   C7 (review MUST-FIX) a soft-deleted row whose key is its kit's CURRENT key keeps its files, even when the database
 *      pre-filter does not see it (the store is the authority)
 *   C8 (review 1) a kit that names a row again between the read and the soft-delete gets that row restored
 *   C9 (review 2) oldest stale work first, so a capped pass rotates through athletes; current-key rows never fill a window
 *   C10 (review 3) the wall-clock budget stops a pass cleanly
 *   C11 (review 4) only a path whose file was really deleted is let go: an unshared cover goes, a shared video stays
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../lib/mediaStore", () => ({ removeObject: jest.fn(async () => true) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import type { PostKitPreview } from "../../../../shared/postKit";
import { athletes, mediaAssets } from "../../../../shared/schema";
import { removeObject } from "../../../lib/mediaStore";
import { POST_KIT_PREVIEW_FORMAT } from "../../../lib/previewAsset";
import { closeTestDb, db, initTestDb } from "../../../testUtils/pgliteDb";
import { dbStore } from "../../research/dbStore";
import { previewPathParts, sweepPreviewCleanup } from "./cleanup";
import { previewCleanupCronRouter } from "./cleanupRoutes";

jest.setTimeout(120_000);

const HER = "77777777-3333-4777-8777-777777777777";
const HIM = "88888888-3333-4888-8888-888888888888";
const GONE = "30000000-0000-4000-8000-0000000000ff";
const K_CUR = "c".repeat(32);
const K_OLD = "0".repeat(32);
const K_OLD2 = "1".repeat(32);
const K_NAMED = "2".repeat(32);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const mockRemove = removeObject as jest.MockedFunction<typeof removeObject>;
const saved = process.env.AGENT_POST_KIT_PREVIEW_CLEANUP;

const space = (athlete: string, decision: string, key: string) => `athletes/${athlete}/studio/post-kit/${decision}/${key}/`;

async function row(athleteId: string, path: string | null, o: { createdAgoMs?: number; deletedAgoMs?: number | null; preview?: boolean; thumb?: string | null } = {}): Promise<string> {
  const now = Date.now();
  const [r] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "studio", origin: "generated", media_type: "IMAGE", status: "stored", approval_status: "draft",
    gcs_path: path, gcs_thumb_path: o.thumb ?? null, content_format: o.preview === false ? null : POST_KIT_PREVIEW_FORMAT,
    created_at: new Date(now - (o.createdAgoMs ?? 2 * DAY)),
    deleted_at: o.deletedAgoMs == null ? null : new Date(now - o.deletedAgoMs),
  } as never).returning({ id: mediaAssets.id });
  return r.id;
}

async function decisionWithPreview(athleteId: string, key: string, named: string[]): Promise<string> {
  const goal = await dbStore.insertGoal(athleteId, { text: "Grow", source: "said", decisionId: null });
  const d = await dbStore.insertDecision(athleteId, { runId: null, skillId: "plan", kind: "action", suggested: "s", why: "w", evidence: [], goalId: goal.id, detail: {} });
  const preview: PostKitPreview = {
    contract: "post-kit-render/1", key, status: "ready", jobId: null,
    outputs: named.map((assetId) => ({ assetId, kind: "image", sourceAssetId: assetId })), coverAssetId: named[0] ?? null,
    notes: [], error: null, requestedAt: new Date().toISOString(), renderedAt: new Date().toISOString(),
  };
  const kit = { contract: "post-kit/1", assets: [], treatmentPlan: { order: [] }, preview };
  await dbStore.updateDecision(athleteId, d.id, { detail: { kind: "post", state: "made", prepared: { studioItemId: d.id, postKit: kit } } });
  return d.id;
}

const get = async (id: string) => (await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0];

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([{ id: HER, full_name: "Preview Athlete" }, { id: HIM, full_name: "Another" }] as never);
});
afterAll(async () => {
  if (saved === undefined) delete process.env.AGENT_POST_KIT_PREVIEW_CLEANUP; else process.env.AGENT_POST_KIT_PREVIEW_CLEANUP = saved;
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  mockRemove.mockReset();
  mockRemove.mockImplementation(async () => true);
});

test("previewPathParts: only a path under the athlete's own post-kit space", () => {
  expect(previewPathParts(HER, `${space(HER, "d", "k")}0-of-1.jpg`)).toEqual({ decisionId: "d", key: "k" });
  expect(previewPathParts(HER, `${space(HIM, "d", "k")}0-of-1.jpg`)).toBeNull();
  expect(previewPathParts(HER, `athletes/${HER}/uploads/x.jpg`)).toBeNull();
  expect(previewPathParts(HER, `${space(HER, "d", "k")}extra/0-of-1.jpg`)).toBeNull();
  expect(previewPathParts(HER, null)).toBeNull();
});

test("C1 + C2: superseded preview rows older than 24 h are soft-deleted, nothing else, per athlete", async () => {
  const named = await row(HER, `${space(HER, "PENDING", K_NAMED)}0-of-1.jpg`);   // path fixed below, once the decision exists
  const D = await decisionWithPreview(HER, K_CUR, [named]);
  await db.update(mediaAssets).set({ gcs_path: `${space(HER, D, K_NAMED)}0-of-1.jpg` } as never).where(eq(mediaAssets.id, named));

  const current = await row(HER, `${space(HER, D, K_CUR)}0-of-1.jpg`);
  const old = await row(HER, `${space(HER, D, K_OLD)}0-of-1.mp4`, { thumb: `${space(HER, D, K_OLD)}0-of-1.cover.jpg` });
  const young = await row(HER, `${space(HER, D, K_OLD2)}0-of-1.jpg`, { createdAgoMs: HOUR });
  const orphan = await row(HER, `${space(HER, GONE, K_OLD)}0-of-1.jpg`);
  const notPreview = await row(HER, `${space(HER, D, K_OLD)}upload.jpg`, { preview: false });
  const foreign = await row(HER, `${space(HIM, D, K_OLD)}0-of-1.jpg`);
  const his = await row(HIM, `${space(HIM, D, K_CUR)}0-of-1.jpg`);   // names HER decision and current key: not his kit

  const out = await sweepPreviewCleanup();
  expect(out).toMatchObject({ athletes: 2, softDeleted: 3, purged: 0, filesDeleted: 0, failedAthletes: 0 });
  const deleted = (await db.select({ id: mediaAssets.id }).from(mediaAssets).where(inArray(mediaAssets.id, [named, current, old, young, orphan, notPreview, foreign, his])))
    .length;
  expect(deleted).toBe(8);   // soft delete: every row is still there
  for (const id of [old, orphan, his]) expect((await get(id)).deleted_at).not.toBeNull();
  for (const id of [named, current, young, notPreview, foreign]) expect((await get(id)).deleted_at).toBeNull();
  expect(mockRemove).not.toHaveBeenCalled();

  // Her kit and its current rows are exactly as they were.
  const det = (await dbStore.getDecision(HER, D))!.detail as any;
  expect(det.prepared.postKit.preview.key).toBe(K_CUR);

  // A second pass finds nothing more to do.
  expect(await sweepPreviewCleanup()).toMatchObject({ softDeleted: 0, purged: 0 });
});

test("C3: soft-deleted preview rows older than 7 days lose their files; nothing else is deleted", async () => {
  const D = "30000000-0000-4000-8000-000000000001";
  const p = (key: string, f: string) => `${space(HER, D, key)}${f}`;
  const purge = await row(HER, p(K_OLD, "0-of-1.mp4"), { deletedAgoMs: 8 * DAY, thumb: p(K_OLD, "0-of-1.cover.jpg") });
  const recent = await row(HER, p(K_OLD2, "0-of-1.jpg"), { deletedAgoMs: 2 * DAY });
  const notPreview = await row(HER, `athletes/${HER}/uploads/u.jpg`, { deletedAgoMs: 8 * DAY, preview: false });
  const outside = await row(HER, `athletes/${HER}/uploads/v.jpg`, { deletedAgoMs: 8 * DAY });
  const sharedPath = p(K_CUR, "0-of-1.jpg");
  const sharedDeleted = await row(HER, sharedPath, { deletedAgoMs: 8 * DAY });
  const live = await row(HER, sharedPath, { createdAgoMs: HOUR });   // the same key re-published to the same path
  const failing = await row(HER, p(K_NAMED, "0-of-1.jpg"), { deletedAgoMs: 8 * DAY });
  mockRemove.mockImplementation(async (path: string) => !path.includes(K_NAMED));

  const out = await sweepPreviewCleanup();
  expect(out).toMatchObject({ purged: 1, filesDeleted: 2, sharedKept: 1, purgeFailed: 1, failedAthletes: 0 });
  expect(mockRemove.mock.calls.map((c) => c[0]).sort()).toEqual([p(K_NAMED, "0-of-1.jpg"), p(K_OLD, "0-of-1.cover.jpg"), p(K_OLD, "0-of-1.mp4")].sort());

  expect(await get(purge)).toMatchObject({ gcs_path: null, gcs_thumb_path: null });
  expect((await get(purge)).deleted_at).not.toBeNull();                       // the row stays, as history
  expect(await get(sharedDeleted)).toMatchObject({ gcs_path: sharedPath });   // file kept for the live row; path kept until it is free
  expect(await get(live)).toMatchObject({ gcs_path: sharedPath, deleted_at: null });
  expect(await get(failing)).toMatchObject({ gcs_path: p(K_NAMED, "0-of-1.jpg") });   // retried next pass
  expect(await get(recent)).toMatchObject({ gcs_path: p(K_OLD2, "0-of-1.jpg") });
  expect(await get(notPreview)).toMatchObject({ gcs_path: `athletes/${HER}/uploads/u.jpg` });
  expect(await get(outside)).toMatchObject({ gcs_path: `athletes/${HER}/uploads/v.jpg` });
});

test("C4: superseded → soft-deleted after 24 h → files gone 7 days later → nothing more", async () => {
  const D = await decisionWithPreview(HER, K_CUR, []);
  const old = await row(HER, `${space(HER, D, K_OLD)}0-of-1.jpg`);
  expect(await sweepPreviewCleanup()).toMatchObject({ softDeleted: 1, purged: 0 });
  expect(mockRemove).not.toHaveBeenCalled();
  expect(await sweepPreviewCleanup({ now: new Date(Date.now() + 6 * DAY) })).toMatchObject({ softDeleted: 0, purged: 0 });
  expect(await sweepPreviewCleanup({ now: new Date(Date.now() + 8 * DAY) })).toMatchObject({ purged: 1, filesDeleted: 1 });
  expect(mockRemove).toHaveBeenCalledWith(`${space(HER, D, K_OLD)}0-of-1.jpg`);
  expect(await sweepPreviewCleanup({ now: new Date(Date.now() + 9 * DAY) })).toMatchObject({ athletes: 0, purged: 0 });
});

test("C5: the cron route — the secret, the flag, a failure", async () => {
  const calls: number[] = [];
  const result = { athletes: 1, softDeleted: 2, restored: 0, purged: 1, filesDeleted: 2, currentKept: 0, sharedKept: 0, purgeFailed: 0, failedAthletes: 0, stoppedEarly: false };
  const app = express();
  app.use(previewCleanupCronRouter((req) => req.headers["x-cron-secret"] === "s3cret", async () => { calls.push(1); return result; }));
  const broken = express();
  broken.use(previewCleanupCronRouter(() => true, async () => { throw new Error("db down"); }));
  const servers: Server[] = [app.listen(0), broken.listen(0)];
  const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/internal/post-kit-preview-cleanup-cron`;
  try {
    expect((await fetch(url(servers[0]), { method: "POST" })).status).toBe(401);
    expect((await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "wrong" } })).status).toBe(401);

    delete process.env.AGENT_POST_KIT_PREVIEW_CLEANUP;
    expect(await (await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "s3cret" } })).json()).toEqual({ ok: true, enabled: false });
    process.env.AGENT_POST_KIT_PREVIEW_CLEANUP = "yes";   // only exactly "true" turns it on
    expect(await (await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "s3cret" } })).json()).toEqual({ ok: true, enabled: false });
    expect(calls).toEqual([]);

    process.env.AGENT_POST_KIT_PREVIEW_CLEANUP = "true";
    expect(await (await fetch(url(servers[0]), { method: "POST", headers: { "x-cron-secret": "s3cret" } })).json()).toEqual({ ok: true, enabled: true, ...result });
    expect(calls).toEqual([1]);
    const failed = await fetch(url(servers[1]), { method: "POST" });
    expect([failed.status, await failed.json()]).toEqual([500, { error: "Internal server error" }]);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
});

test("C6: the flag is on in both Cloud Run yamls (prod: stage 1, owner 25 Oct 2026), exactly once each", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { parse } = require("yaml") as typeof import("yaml");
  const GCP = join(__dirname, "..", "..", "..", "..", "gcp");
  const envOf = (file: string) => (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);
  for (const [file, value] of [["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "true"]]) {
    expect([file, envOf(file).filter((e) => e.name === "AGENT_POST_KIT_PREVIEW_CLEANUP")]).toEqual([file, [{ name: "AGENT_POST_KIT_PREVIEW_CLEANUP", value }]]);
  }
});

/** A store that answers from the real one, but lets a test change what a decision's preview key reads as. */
function storeWith(override: (decisionId: string, call: number) => string | undefined) {
  const calls = new Map<string, number>();
  return {
    async getDecision(athleteId: string, decisionId: string) {
      const n = (calls.get(decisionId) ?? 0) + 1; calls.set(decisionId, n);
      const d = await dbStore.getDecision(athleteId, decisionId);
      const key = override(decisionId, n);
      if (!d || key === undefined) return d;
      const det = d.detail as any;
      return { ...d, detail: { ...det, prepared: { ...det.prepared, postKit: { ...det.prepared.postKit, preview: { ...det.prepared.postKit.preview, key } } } } } as typeof d;
    },
  };
}

test("C7: a soft-deleted row whose key is the kit's current key keeps its files", async () => {
  // In the database the kit's key is K_CUR; the row is under K_OLD, so the SQL pre-filter lets it through. The store
  // (the authority) says K_OLD is current again: request.ts wrote it, and the re-render will write this very path.
  const D = await decisionWithPreview(HER, K_CUR, []);
  const path = `${space(HER, D, K_OLD)}0-of-1.jpg`;
  const r = await row(HER, path, { deletedAgoMs: 8 * DAY });
  const out = await sweepPreviewCleanup({ store: storeWith((d) => (d === D ? K_OLD : undefined)) });
  expect(out).toMatchObject({ currentKept: 1, filesDeleted: 0, purged: 0 });
  expect(mockRemove).not.toHaveBeenCalled();
  expect(await get(r)).toMatchObject({ gcs_path: path });

  // And in the database itself: the key IS current, so the row is not even a candidate.
  const D2 = await decisionWithPreview(HER, K_OLD2, []);
  const r2 = await row(HER, `${space(HER, D2, K_OLD2)}0-of-1.jpg`, { deletedAgoMs: 8 * DAY });
  await sweepPreviewCleanup();   // (the first row, whose key the database says is NOT current, goes now)
  expect(mockRemove.mock.calls.map((c) => c[0])).toEqual([path]);
  expect((await get(r2)).gcs_path).not.toBeNull();
});

test("C8: a kit that names a row again right after the soft-delete gets it restored", async () => {
  const D = await decisionWithPreview(HER, K_CUR, []);
  const old = await row(HER, `${space(HER, D, K_OLD)}0-of-1.jpg`);
  const other = await row(HER, `${space(HER, D, K_OLD2)}0-of-1.jpg`);
  // First read: K_CUR (both stale). The re-read after the UPDATE: swapped back to K_OLD.
  const out = await sweepPreviewCleanup({ store: storeWith((d, n) => (d === D && n >= 2 ? K_OLD : undefined)) });
  expect(out).toMatchObject({ softDeleted: 1, restored: 1 });
  expect((await get(old)).deleted_at).toBeNull();
  expect((await get(other)).deleted_at).not.toBeNull();
});

test("C9: oldest stale work first — a capped pass rotates through athletes; current-key rows never fill the window", async () => {
  const THIRD = "99999999-3333-4999-8999-999999999999";
  await db.insert(athletes).values({ id: THIRD, full_name: "Third" } as never).onConflictDoNothing();
  const G = "30000000-0000-4000-8000-0000000000aa";
  const h = await row(HIM, `${space(HIM, G, K_OLD)}0-of-1.jpg`, { createdAgoMs: 5 * DAY });
  const t = await row(THIRD, `${space(THIRD, G, K_OLD)}0-of-1.jpg`, { createdAgoMs: 3 * DAY });
  // HER: three rows of her kit's CURRENT key (older than everything) and one stale row.
  const D = await decisionWithPreview(HER, K_CUR, []);
  for (let i = 0; i < 3; i++) await row(HER, `${space(HER, D, K_CUR)}${i}-of-3.jpg`, { createdAgoMs: 9 * DAY });
  const mine = await row(HER, `${space(HER, D, K_OLD)}0-of-1.jpg`, { createdAgoMs: 2 * DAY });

  const pass = () => sweepPreviewCleanup({ maxAthletes: 1, maxRowsPerAthlete: 1 });
  expect(await pass()).toMatchObject({ athletes: 1, softDeleted: 1 });
  expect((await get(h)).deleted_at).not.toBeNull();          // oldest stale row first: HIM (5 days)
  expect(await pass()).toMatchObject({ athletes: 1, softDeleted: 1 });
  expect((await get(t)).deleted_at).not.toBeNull();          // then THIRD (3 days)
  expect(await pass()).toMatchObject({ athletes: 1, softDeleted: 1 });
  expect((await get(mine)).deleted_at).not.toBeNull();       // then HER: her current-key rows took no slot of the 1-row window
  expect(await pass()).toMatchObject({ athletes: 0 });
});

test("C10: the wall-clock budget stops a pass cleanly", async () => {
  const G = "30000000-0000-4000-8000-0000000000bb";
  await row(HER, `${space(HER, G, K_OLD)}0-of-1.jpg`);
  await row(HIM, `${space(HIM, G, K_OLD)}0-of-1.jpg`);
  expect(await sweepPreviewCleanup({ budgetMs: 0 })).toMatchObject({ athletes: 0, softDeleted: 0, stoppedEarly: true });
  let t = 0;
  // The first athlete's first kit read finds the budget gone: the pass stops there, nothing half-written.
  const out = await sweepPreviewCleanup({ budgetMs: 10, clock: () => (t += 6) });
  expect(out).toMatchObject({ stoppedEarly: true, softDeleted: 0, failedAthletes: 0 });
  expect(await sweepPreviewCleanup()).toMatchObject({ softDeleted: 2, stoppedEarly: false });
});

test("C11: only a path whose file was really deleted is let go", async () => {
  const D = "30000000-0000-4000-8000-0000000000cc";
  const video = `${space(HER, D, K_OLD)}0-of-1.mp4`;
  const cover = `${space(HER, D, K_OLD)}0-of-1.cover.jpg`;
  const r = await row(HER, video, { deletedAgoMs: 8 * DAY, thumb: cover });
  await row(HER, video, { createdAgoMs: HOUR });            // a live row still uses the video, not the cover
  const out = await sweepPreviewCleanup();
  expect(out).toMatchObject({ filesDeleted: 1, sharedKept: 1, purged: 0 });
  expect(mockRemove.mock.calls.map((c) => c[0])).toEqual([cover]);
  expect(await get(r)).toMatchObject({ gcs_path: video, gcs_thumb_path: null });   // the cover is not leaked

  // A failed delete keeps its path too.
  const thumb2 = `${space(HER, D, K_OLD2)}0-of-1.cover.jpg`;
  const r2 = await row(HER, `${space(HER, D, K_OLD2)}0-of-1.mp4`, { deletedAgoMs: 8 * DAY, thumb: thumb2 });
  mockRemove.mockReset();
  mockRemove.mockImplementation(async (p: string) => !p.endsWith(".cover.jpg"));
  expect(await sweepPreviewCleanup()).toMatchObject({ purgeFailed: 1, sharedKept: 1 });
  expect(await get(r2)).toMatchObject({ gcs_path: null, gcs_thumb_path: thumb2 });
});
