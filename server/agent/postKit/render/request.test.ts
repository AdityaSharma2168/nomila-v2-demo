/**
 * request.test.ts — asking for a kit's preview (render/request.ts) through the real build and the two edits, on the
 * in-memory store and library, with a recording render port; no provider is reached (the kit is built with a fake
 * Gemini client), no ffmpeg runs (that is worker.ffmpeg.test.ts).
 *
 *   Q1 dark: with either flag off, or no port, nothing is asked for and the kit has no preview
 *   Q2 a build asks once: one job, the preview queued under the plan's key, the runner kicked
 *   Q3 idempotent: asking again, or a caption edit (no pixel changes), queues nothing
 *   Q4 a swap clears the old preview and asks for the new set; swapping back to a set rendered before reuses its
 *      outputs with no job
 *   Q5 a failed preview with the same key is asked again; a kit whose assets are all gone has nothing to render
 *   Q6 the read: the preview signed fresh, previewUrl the first output; the route's re-ask refuses while the render is off
 *   Q7 never stuck: a queued preview whose job ended (failed, cancelled, gone) is asked again; a ready one whose outputs
 *      were deleted is rendered again on the route's re-ask
 *   Q8 one job per key: two concurrent requests for the same key leave exactly one live job — the loser's is cancelled
 *   Q9 requestedAt is the job row's own (database) stamp
 *   Q10 a kit whose post became brand work after the build: the request reconciles its music and caption, and writes it
 *   Q7b a stalled preview (queued past POST_KIT_PREVIEW_STALL_MS) is re-asked by the route only: its job cancelled, a fresh
 *      one queued with a new requestedAt
 */
jest.mock("../../../db", () => ({ db: {} }));
jest.mock("../../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));

import type { ActionDecisionDetail } from "../../../../shared/plan";
import { POST_KIT_PREVIEW_STALL_MS, type PostKit, type PostKitPreview, type PostKitPreviewOutput } from "../../../../shared/postKit";
import type { CastableRow } from "../../../studio/agent/cast";
import { setGeminiClient } from "../../geminiProvider";
import { createMemoryStore, type AgentStore } from "../../research/store";
import { buildPostKit, type PostKitDeps } from "../build";
import { editCaption, readPostKit, renderPreview, swapAsset } from "../edit";
import { fakeGemini, fakeMedia, postAction, refsWith, row } from "../testRows";
import { expectedOutputs, type RenderJobSpec } from "./compile";
import { requestPostKitRender, type PostKitRenderPort, type RenderJobStatus } from "./request";
import { MUSIC_CATALOGUE } from "../../../studio/music/find";
import { creditLine } from "../music";

const A = "11111111-1111-4111-8111-111111111111";
const ENV = ["AGENT_POST_KITS", "AGENT_POST_KIT_RENDER", "STUDIO_STITCH_BEDS_READY"];
let saved: Record<string, string | undefined>;

let store: AgentStore;
let library: Map<string, CastableRow[]>;
let picked: CastableRow; let spare: CastableRow;
let decisionId = "";

/**
 * A render port over an in-memory queue: queued specs (with a status each, a database-clock stamp each), cancels, kicks,
 * a published set per key (what a finished render left), and the assets still there.
 */
function recordingPort() {
  const queued: Array<{ athleteId: string; spec: RenderJobSpec; jobId: string }> = [];
  const status = new Map<string, RenderJobStatus>();
  const cancelled: string[] = [];
  const published = new Map<string, PostKitPreviewOutput[]>();
  const gone = new Set<string>();
  let kicks = 0;
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 1, 0, 0, ++tick)).toISOString();
  const port: PostKitRenderPort = {
    async queue(athleteId, spec) {
      const jobId = `job-${queued.length + 1}`;
      queued.push({ athleteId, spec, jobId });
      status.set(jobId, "queued");
      return { jobId, queuedAt: stamp() };
    },
    async cancel(_a, jobId) {
      if (status.get(jobId) === "queued") { status.set(jobId, "canceled"); cancelled.push(jobId); }
    },
    async jobStatus(_a, jobId) { return status.get(jobId) ?? null; },
    async clock() { return stamp(); },
    kick() { kicks++; },
    async published(_a, _d, key) { return published.get(key) ?? null; },
    async outputsExist(_a, ids) { return ids.length > 0 && ids.every((id) => !gone.has(id)); },
    async sign(_a, preview) {
      return { items: preview.outputs.map((o) => `https://signed.example/${o.assetId}`), coverUrl: preview.coverAssetId ? `https://signed.example/${preview.coverAssetId}.cover` : null };
    },
  };
  return { port, queued, status, cancelled, published, gone, kicks: () => kicks };
}

let rec: ReturnType<typeof recordingPort>;
const deps = (): PostKitDeps => ({ store, media: fakeMedia(library).media, preferences: async () => [], render: rec.port });
const kitOf = async (): Promise<PostKit> => ((await store.getDecision(A, decisionId))!.detail as unknown as ActionDecisionDetail).prepared!.postKit!;

beforeAll(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); });
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function build() {
  const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
  const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Training clip", why: "w", evidence: [], detail: postAction() as unknown as Record<string, unknown>, goalId: goal.id });
  decisionId = d.id;
  await buildPostKit(deps(), A, decisionId, { trigger: "event", parentRef: null });
}

beforeEach(() => {
  process.env.AGENT_POST_KITS = "true";
  process.env.AGENT_POST_KIT_RENDER = "true";
  process.env.STUDIO_STITCH_BEDS_READY = "true";
  store = createMemoryStore();
  rec = recordingPort();
  picked = row({ vision: { description: "the chosen shot" } });
  spare = row({ vision: { description: "a spare shot" } });
  library = new Map([[A, [picked, spare]]]);
  fakeGemini((input) => ({ picks: refsWith(input.candidates, "chosen").map((ref) => ({ ref, segment: "", reason: "r" })), none_fit: false, none_fit_reason: "", look_preset: "warm", music_mood: "hype" }));
});
afterEach(() => setGeminiClient(null));

describe("Q1: dark", () => {
  it.each([["AGENT_POST_KIT_RENDER", "false"], ["AGENT_POST_KITS", "false"]])("with %s=%s nothing is asked for", async (k, v) => {
    process.env[k] = v;
    await build();
    expect(rec.queued).toEqual([]);
    expect(await kitOf()).not.toHaveProperty("preview");
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "off" });
  });

  it("without a render port nothing is asked for, flags on or not", async () => {
    await build();
    rec.queued.length = 0;
    expect(await requestPostKitRender({ ...deps(), render: undefined }, A, decisionId)).toEqual({ status: "off" });
  });
});

describe("Q2: a build asks once", () => {
  it("one job under the plan's key, the preview queued, the runner kicked", async () => {
    await build();
    expect(rec.queued).toHaveLength(1);
    const { athleteId, spec } = rec.queued[0];
    expect(athleteId).toBe(A);
    expect(spec).toMatchObject({ kind: "post_kit_render", decisionId, plan: { format: "feed", output: "slides", look: "warm", positions: [{ assetId: picked.id }] } });
    expect((await kitOf()).preview).toEqual({
      contract: "post-kit-render/1", key: spec.key, status: "queued", jobId: "job-1", outputs: [], coverAssetId: null,
      notes: [], error: null, requestedAt: expect.any(String), renderedAt: null,
    });
    expect(rec.kicks()).toBe(1);
  });
});

describe("Q3: idempotent", () => {
  it("asking again, or editing the caption, queues nothing", async () => {
    await build();
    const key = (await kitOf()).preview!.key;
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "unchanged", key });
    await editCaption(deps(), A, decisionId, { text: "My own words #mine" });
    expect(rec.queued).toHaveLength(1);
    expect((await kitOf()).preview).toMatchObject({ key, status: "queued", jobId: "job-1" });
  });
});

describe("Q4: a swap", () => {
  it("clears the old preview and asks for the new set; a swap back to a rendered set reuses it, no job", async () => {
    await build();
    const first = (await kitOf()).preview!;
    // The first render finished: its outputs are published under its key.
    const firstOutputs: PostKitPreviewOutput[] = [{ assetId: "out-1", kind: "image", sourceAssetId: picked.id }];
    rec.published.set(first.key, firstOutputs);

    const r = await swapAsset(deps(), A, decisionId, { replace: picked.id, with: spare.id });
    expect(rec.queued).toHaveLength(2);
    const second = (await kitOf()).preview!;
    expect(second).toMatchObject({ status: "queued", jobId: "job-2" });
    expect(second.key).not.toBe(first.key);
    expect(rec.queued[1].spec.plan.positions.map((p) => p.assetId)).toEqual([spare.id]);
    expect(r.preview).toEqual({ status: "queued", previewUrl: null, items: [], coverUrl: null, notes: [], error: null });

    await swapAsset(deps(), A, decisionId, { replace: spare.id, with: picked.id });
    expect(rec.queued).toHaveLength(2);
    expect((await kitOf()).preview).toMatchObject({ key: first.key, status: "ready", jobId: null, outputs: firstOutputs, coverAssetId: "out-1" });
  });
});

describe("Q5: failures and nothing to render", () => {
  it("a failed preview with the same key is asked again", async () => {
    await build();
    const det = (await store.getDecision(A, decisionId))!.detail as unknown as ActionDecisionDetail;
    const kit = det.prepared!.postKit!;
    const failed: PostKitPreview = { ...kit.preview!, status: "failed", error: "x" };
    await store.updateDecision(A, decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: { ...kit, preview: failed } } } as unknown as Record<string, unknown> });
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "queued", key: failed.key, jobId: "job-2" });
  });

  it("a kit whose assets have all left the library has nothing to render", async () => {
    await build();
    library.set(A, []);
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "nothing_to_render", reason: "nothing_available" });
    await expect(renderPreview(deps(), A, decisionId)).rejects.toMatchObject({ status: 409, code: "nothing_to_render" });
  });
});

describe("Q6: the read, and the route's re-ask", () => {
  it("a ready preview is signed fresh; previewUrl is the first output", async () => {
    await build();
    const kit = await kitOf();
    rec.published.set(kit.preview!.key, [{ assetId: "out-9", kind: "image", sourceAssetId: picked.id }]);
    // The kit was rendered before (the preview reused), then read.
    const det = (await store.getDecision(A, decisionId))!.detail as unknown as ActionDecisionDetail;
    await store.updateDecision(A, decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: { ...kit, preview: { ...kit.preview!, status: "failed" } } } } as unknown as Record<string, unknown> });
    expect(await requestPostKitRender(deps(), A, decisionId)).toMatchObject({ status: "reused" });
    const r = await readPostKit(deps(), A, decisionId);
    expect(r.preview).toEqual({
      status: "ready", previewUrl: "https://signed.example/out-9", items: [{ kind: "image", url: "https://signed.example/out-9" }],
      coverUrl: "https://signed.example/out-9.cover", notes: [], error: null,
    });
    expect(expectedOutputs(rec.queued[0].spec.plan)).toEqual([{ kind: "image", sourceAssetId: picked.id }]);
  });

  it("the re-ask answers 404 while the render is off; another athlete's action is not found", async () => {
    await build();
    await expect(renderPreview(deps(), "22222222-2222-4222-8222-222222222222", decisionId)).rejects.toMatchObject({ status: 404 });
    process.env.AGENT_POST_KIT_RENDER = "false";
    await expect(renderPreview(deps(), A, decisionId)).rejects.toMatchObject({ status: 404, code: "render_off" });
  });
});

describe("Q7: never stuck", () => {
  it.each(["failed", "canceled", null] as const)("a queued preview whose job is %s is asked again", async (ended) => {
    await build();
    const first = (await kitOf()).preview!;
    if (ended) rec.status.set(first.jobId!, ended); else rec.status.delete(first.jobId!);
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "queued", key: first.key, jobId: "job-2" });
    expect((await kitOf()).preview).toMatchObject({ key: first.key, status: "queued", jobId: "job-2" });
  });

  it("a queued preview whose job is still queued or running is left alone", async () => {
    await build();
    const first = (await kitOf()).preview!;
    rec.status.set(first.jobId!, "running");
    expect(await requestPostKitRender(deps(), A, decisionId, { verify: true })).toEqual({ status: "unchanged", key: first.key });
    expect(rec.queued).toHaveLength(1);
  });

  it("a stalled preview (queued past POST_KIT_PREVIEW_STALL_MS) is asked again on the route's re-ask: old job cancelled, a fresh one with a new requestedAt", async () => {
    await build();
    const first = (await kitOf()).preview!;
    // Asked for 11 minutes before the database's clock reads now; its job never started.
    const d = (await store.getDecision(A, decisionId))!;
    const det = d.detail as unknown as ActionDecisionDetail;
    const stalledAt = new Date(Date.parse(first.requestedAt) - POST_KIT_PREVIEW_STALL_MS - 60_000).toISOString();
    await store.updateDecision(A, decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: { ...det.prepared!.postKit!, preview: { ...first, requestedAt: stalledAt } } } } as unknown as Record<string, unknown> });

    // An edit's ask (no verify) still leaves it alone: only the screen's "Try again" re-asks a stall.
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "unchanged", key: first.key });
    expect(rec.queued).toHaveLength(1);

    const read = await renderPreview(deps(), A, decisionId);
    expect(rec.queued).toHaveLength(2);
    expect(rec.cancelled).toEqual([first.jobId]);
    const now = (await kitOf()).preview!;
    expect(now).toMatchObject({ key: first.key, status: "queued", jobId: "job-2" });
    expect(Date.parse(now.requestedAt)).toBeGreaterThan(Date.parse(stalledAt) + POST_KIT_PREVIEW_STALL_MS);
    expect(read.preview).toMatchObject({ status: "queued" });

    // A stalled preview whose job is running is replaced too; the running job cannot be cancelled, and no longer owns the kit.
    rec.status.set("job-2", "running");
    const again = (await store.getDecision(A, decisionId))!.detail as unknown as ActionDecisionDetail;
    await store.updateDecision(A, decisionId, { detail: { ...again, prepared: { ...again.prepared, postKit: { ...again.prepared!.postKit!, preview: { ...now, requestedAt: stalledAt } } } } as unknown as Record<string, unknown> });
    await renderPreview(deps(), A, decisionId);
    expect((await kitOf()).preview).toMatchObject({ status: "queued", jobId: "job-3" });
  });

  it("a queued preview whose job succeeded but never landed is picked up from what it published", async () => {
    await build();
    const first = (await kitOf()).preview!;
    rec.status.set(first.jobId!, "succeeded");
    rec.published.set(first.key, [{ assetId: "out-1", kind: "image", sourceAssetId: picked.id }]);
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "reused", key: first.key });
    expect((await kitOf()).preview).toMatchObject({ status: "ready", outputs: [{ assetId: "out-1" }], coverAssetId: "out-1" });
  });

  it("a ready preview whose outputs were deleted: unchanged to an edit, rendered again on the route's re-ask", async () => {
    await build();
    const first = (await kitOf()).preview!;
    rec.published.set(first.key, [{ assetId: "out-1", kind: "image", sourceAssetId: picked.id }]);
    rec.status.set(first.jobId!, "succeeded");
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "reused", key: first.key });
    rec.gone.add("out-1");
    rec.published.delete(first.key);
    expect(await requestPostKitRender(deps(), A, decisionId)).toEqual({ status: "unchanged", key: first.key });
    const r = await renderPreview(deps(), A, decisionId);
    expect(r.preview).toMatchObject({ status: "queued" });
    expect(rec.queued).toHaveLength(2);
  });
});

describe("Q8: one job per key", () => {
  it("two concurrent requests for the same key leave exactly one live job; the other is cancelled", async () => {
    process.env.AGENT_POST_KIT_RENDER = "false";
    await build(); // no preview yet
    process.env.AGENT_POST_KIT_RENDER = "true";
    const [a, b] = await Promise.all([requestPostKitRender(deps(), A, decisionId), requestPostKitRender(deps(), A, decisionId)]);
    expect([a.status, b.status].sort()).toEqual(["queued", "unchanged"]);
    expect(rec.queued).toHaveLength(2);
    const kept = (await kitOf()).preview!.jobId!;
    expect([...rec.status].filter(([, s]) => s === "queued").map(([id]) => id)).toEqual([kept]);
    expect(rec.cancelled).toEqual(rec.queued.map((q) => q.jobId).filter((id) => id !== kept));
  });
});

describe("Q9: requestedAt", () => {
  it("is the queued job row's own stamp (the database's clock), not the app's", async () => {
    await build();
    expect((await kitOf()).preview!.requestedAt).toBe("2026-10-01T00:00:01.000Z");
  });
});

describe("Q10: a kit gone stale on music", () => {
  it("the post became brand work after the build: the render request moves off a non-brand-safe pick and writes the credit out", async () => {
    await build();
    const owes = Object.values(MUSIC_CATALOGUE).find((t) => !t.brandSafe && t.credit)!;
    const safe = Object.values(MUSIC_CATALOGUE).find((t) => t.brandSafe && !t.credit)!;
    const c = (t: typeof owes) => ({ trackId: t.id, title: t.title, artist: t.artist, reason: "r", licence: t.licence, credit: t.credit, creditShort: t.creditShort });
    const d = (await store.getDecision(A, decisionId))!;
    const det = d.detail as unknown as ActionDecisionDetail;
    const kit = det.prepared!.postKit!;
    const stale: ActionDecisionDetail = {
      ...det,
      deliverable: { ...det.deliverable!, target: { subjectKind: "brand", name: "Brand A" } },
      prepared: { ...det.prepared!, postKit: { ...kit, music: { choices: [c(owes), c(safe)], selected: owes.id }, caption: { ...kit.caption, text: `${kit.caption.text}\n\n${creditLine(owes.credit!)}` } } },
    };
    await store.updateDecision(A, decisionId, { detail: stale as unknown as Record<string, unknown> });
    await requestPostKitRender(deps(), A, decisionId);
    const after = await kitOf();
    expect(after.music?.selected).toBe(safe.id);
    expect(after.caption.text).toBe(kit.caption.text);
    expect(after.preview).toBeDefined();
  });
});
