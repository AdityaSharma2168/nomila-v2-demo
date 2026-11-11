/**
 * worker.ffmpeg.test.ts — a post kit's preview render, end to end through the runner's worker (render/worker.ts) on
 * REAL ffmpeg, sharp and the caption renderer, over tiny fixtures generated here (lavfi clips, sharp photos — nothing in
 * git, $0). Only the edges that need a cloud are faked: the download (the workspace is handed the fixture paths), the
 * upload (the publish records what it was given), the job row (recorded), and the store (in memory).
 *
 *   I1 a reel: clip + held vertical photo + short clip, overlay, music, look → one 1080×1920 mp4 of the planned length,
 *      with sound, the photo filling the frame, and a cover still; the kit's preview is ready
 *   I2 a photos-only reel in mono with no music: silent, and grey
 *   I2b a photos-only reel with music (music only): the bed is the programme — −14 LUFS integrated, under −1 dBTP,
 *      measured on the output (Medium's −12 dB is a level for music under her own sound, not for music alone)
 *   I3 a carousel: a picture, a clip slide and a vertical picture → three outputs at 1080×1350, the cover a still off
 *      the clip slide
 *   I4 a feed post: one 1080×1350 picture
 *   I5 a clip shorter than its row said: the render keeps inside the real file
 *   I6 a missing asset: the job fails and the preview says so in her words
 *   I7 superseded, and flags off: nothing is fetched
 *   I8 the job row is always closed and the kit only written by the job that owns it: a swap mid-render (nothing
 *      uploaded), a swap after upload (markReady refuses), another job owning the key, a lost lease, a store that
 *      throws, a kit write that fails
 *   I9 check before deliver (A4): the real check passes a real render; a render that fails it is needs-a-look —
 *      nothing uploaded, the job failed, the kit never ready
 *
 * ffmpeg is on PATH in CI for every batch (.github/workflows/ci-checks.yml "Install ffmpeg") — the stitch suite's own
 * contract — so nothing here is skipped.
 */
jest.mock("../../../db", () => ({ db: {} }));
jest.mock("../../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../../lib/mediaStore", () => ({
  signedUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  UPLOAD_LIMITS: { image: { max: 25 * 1024 * 1024, types: [] }, video: { max: 200 * 1024 * 1024, types: [] } },
}));

import { execFile } from "child_process";
import { copyFile, mkdtemp, rm, stat } from "fs/promises";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import type { ActionDecisionDetail } from "../../../../shared/plan";
import type { PostFormat, PostKit, PostKitAsset, PostKitPreview } from "../../../../shared/postKit";
import type { StudioStitchJob } from "../../../../shared/schema";
import { ebur128Filter } from "../../../studio/video/ebur128";
import { BED_REFERENCE_LUFS, TRUE_PEAK_DBTP } from "../../../studio/video/finishing";
import { MaterializeError, type StitchWorkspace } from "../../../studio/video/materialize";
import { probeMedia } from "../../../studio/video/probe";
import { makeFixtures, measureContentBox, readFrameRgb, type Fixtures } from "../../../studio/video/testFixtures";
import { createMemoryStore, type AgentStore } from "../../research/store";
import { treatmentFor } from "../kit";
import { compileRender, renderJobSpec, type RenderPlan, type VideoRenderPlan } from "./compile";
import type { LocalRender } from "./local";
import type { PublishInput } from "./publish";
import { RENDER_ERRORS, workPostKitRender, type RenderWorkerDeps } from "./worker";
import { verifyRender } from "./verify";

jest.setTimeout(300_000);
const execFileP = promisify(execFile);

const A = "11111111-1111-4111-8111-111111111111";
const PL = "10000000-0000-4000-8000-00000000000a"; // landscape photo
const PV = "10000000-0000-4000-8000-00000000000b"; // vertical photo
const CA = "20000000-0000-4000-8000-00000000000a"; // clipA: 640×360, 2 s, sound
const CB = "20000000-0000-4000-8000-00000000000b"; // clipB: 320×240, 1.5 s, silent
const CC = "20000000-0000-4000-8000-00000000000c"; // clipC: 240×426 portrait, 1 s, sound

const ENV = ["AGENT_POST_KITS", "AGENT_POST_KIT_RENDER", "STUDIO_STITCH_BEDS_READY", "STUDIO_FINISHING"];
let saved: Record<string, string | undefined>;
let dir: string;
let fx: Fixtures;
let photos: Record<string, string>;

beforeAll(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  dir = await mkdtemp(join(tmpdir(), "post-kit-render-"));
  fx = await makeFixtures(dir);
  // A landscape photo, and a vertical one whose top half is red and bottom half blue (to see where a crop landed).
  const landscape = join(dir, "landscape.jpg");
  await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 30, g: 160, b: 60 } } }).jpeg().toFile(landscape);
  const vertical = join(dir, "vertical.jpg");
  await sharp({ create: { width: 400, height: 720, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .composite([{ input: { create: { width: 400, height: 360, channels: 3, background: { r: 40, g: 40, b: 200 } } }, top: 360, left: 0 }])
    .jpeg().toFile(vertical);
  photos = { [PL]: landscape, [PV]: vertical };
});
beforeEach(() => {
  process.env.AGENT_POST_KITS = "true";
  process.env.AGENT_POST_KIT_RENDER = "true";
  process.env.STUDIO_STITCH_BEDS_READY = "true";
  delete process.env.STUDIO_FINISHING;
});
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(dir, { recursive: true, force: true });
});

const clipFile: Record<string, () => string> = { [CA]: () => fx.clipA.path, [CB]: () => fx.clipB.path, [CC]: () => fx.clipC.path };
const photo = (id: string): PostKitAsset => ({ assetId: id, mediaType: "photo", clip: null, durationSec: null, provenance: "camera" });
const clipOf = (id: string, startSec: number, endSec: number, durationSec: number): PostKitAsset => ({
  assetId: id, mediaType: "clip", clip: { startSec, endSec, from: "beat" }, durationSec, provenance: "camera",
});

function kitOf(format: PostFormat, assets: PostKitAsset[], over: Partial<PostKit["treatmentPlan"]> = {}, look: { lookPreset: PostKit["treatmentPlan"]["lookPreset"]; musicMood: string | null } = { lookPreset: "natural", musicMood: null }): PostKit {
  const { assets: fitted, treatment } = treatmentFor(format, assets, look, "Early sessions add up", []);
  return {
    contract: "post-kit/1", momentDecisionId: null, idea: { hook: "Early sessions add up", format, platform: "instagram", timing: "This week" },
    formatFromMoment: false, brief: { show: "s", captionAngle: "a", avoid: "" }, assets: fitted, shortlist: [],
    caption: { text: "Caption", hashtags: [], edited: false }, treatmentPlan: { ...treatment, ...over },
    aiGenerationNeeded: { value: false, reason: "r" }, match: { runId: null, skillVersion: null, candidates: 0, costMicroUsd: 0, noneFitNote: null },
    builtAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

interface Harness {
  store: AgentStore; decisionId: string; job: StudioStitchJob; plan: RenderPlan;
  closed: Array<[string, string]>; published: LocalRender[]; materialized: number; deps: RenderWorkerDeps;
}

const JOB_ID = "40000000-0000-4000-8000-000000000001";

/** Point the kit's preview somewhere else, as a swap's request would (a later key, by the database's clock). */
async function repoint(h: Harness, over: Partial<PostKitPreview>): Promise<void> {
  const det = (await h.store.getDecision(A, h.decisionId))!.detail as unknown as ActionDecisionDetail;
  const kit = det.prepared!.postKit!;
  await h.store.updateDecision(A, h.decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: { ...kit, preview: { ...kit.preview!, ...over } } } } as unknown as Record<string, unknown> });
}

/** A kit on a decision row with its preview queued, the job that renders it, and the worker's fakes around real ffmpeg. */
async function harness(kit: PostKit, opts: {
  durations?: Record<string, number>; materialize?: RenderWorkerDeps["materialize"];
} = {}): Promise<Harness> {
  const store = createMemoryStore();
  const sources = new Map(kit.assets.map((a) => [a.assetId, { mediaType: a.mediaType, durationSec: opts.durations?.[a.assetId] ?? a.durationSec }]));
  const c = compileRender(kit, sources, { forBrand: false, musicReady: true });
  if (!c.ok) throw new Error(c.reason);
  const preview: PostKitPreview = {
    contract: "post-kit-render/1", key: c.key, status: "queued", jobId: JOB_ID, outputs: [], coverAssetId: null, notes: c.notes,
    error: null, requestedAt: "2026-10-01T00:00:00.000Z", renderedAt: null,
  };
  const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
  const det = { kind: "post", what: "w", button: "post", dueOn: null, event: null, state: "made", prepared: { studioItemId: null, postKit: { ...kit, preview } } };
  const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "s", why: "w", evidence: [], detail: det as unknown as Record<string, unknown>, goalId: goal.id });
  const job = { id: JOB_ID, athlete_id: A, spec: JSON.parse(JSON.stringify(renderJobSpec(d.id, c.plan, c.key))), created_at: new Date("2026-10-01T00:00:01.000Z") } as unknown as StudioStitchJob;
  const h: Harness = { store, decisionId: d.id, job, plan: c.plan, closed: [], published: [], materialized: 0, deps: undefined as never };
  const work = await mkdtemp(join(dir, "ws-"));
  h.deps = {
    store,
    materialize: opts.materialize ?? (async (_athlete, timeline, _signal, bed) => {
      h.materialized++;
      const paths = new Map<string, string>();
      const stills = new Map<string, string>();
      for (const e of timeline) {
        if (e.stillSec !== undefined) stills.set(e.assetId, photos[e.assetId]);
        else { const p = join(work, `${e.assetId}.mp4`); await copyFile(clipFile[e.assetId](), p); paths.set(e.assetId, p); }
      }
      const ws: StitchWorkspace = { dir: work, paths, stills, bedPath: bed ? fx.bed.path : null, outputPath: join(work, "output.mp4"), dispose: async () => undefined };
      return ws;
    }),
    probeSec: async (p) => (await probeMedia(p)).durationSec,
    publish: async (input: PublishInput) => {
      h.published.push(input.render);
      return input.render.outputs.map((o, i) => ({ assetId: `50000000-0000-4000-8000-00000000000${i}`, kind: o.kind, sourceAssetId: o.sourceAssetId }));
    },
    jobs: {
      succeed: async (id) => { h.closed.push([id, "succeeded"]); return true; },
      fail: async (id, _h, m) => { h.closed.push([id, `failed: ${m}`]); return true; },
      cancel: async (id) => { h.closed.push([id, "canceled"]); return true; },
    },
    now: () => new Date("2026-10-01T00:01:00.000Z"),
  };
  return h;
}

const previewOf = async (h: Harness) =>
  ((await h.store.getDecision(A, h.decisionId))!.detail as unknown as ActionDecisionDetail).prepared!.postKit!.preview!;

describe("I1: a reel", () => {
  it("one 1080×1920 mp4 of the planned length, with sound, the vertical photo filling the frame, and a cover", async () => {
    const kit = kitOf("reel", [clipOf(CA, 0, 2, 2), photo(PV), clipOf(CC, 0, 1, 1)], {}, { lookPreset: "warm", musicMood: "hype" });
    const h = await harness(kit);
    const plan = h.plan as VideoRenderPlan;
    expect(plan.bed).not.toBeNull();
    expect(plan.overlay).not.toBeNull();

    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    expect(h.closed).toEqual([[h.job.id, "succeeded"]]);
    const [render] = h.published;
    expect(render.outputs).toHaveLength(1);
    const out = render.outputs[0];
    expect(out).toMatchObject({ kind: "video", contentType: "video/mp4", width: 1080, height: 1920, sourceAssetId: CA });
    const probe = await probeMedia(out.path);
    expect(probe).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(probe.durationSec).toBeCloseTo(plan.totalSec, 1);
    expect(probe.durationSec).toBeLessThanOrEqual(30);

    // The held photo (2 s, after a 2 s clip and a crossfade) fills the frame: no bars either way.
    const box = await measureContentBox(out.path, { startSec: 2.3, durationSec: 0.6 });
    expect(box).toMatchObject({ width: 1080, height: 1920 });

    // The cover: a still the frame's size, taken off the cut, as the video's poster.
    expect(render.cover).toMatchObject({ outputIndex: 0 });
    const cover = await sharp(render.cover.path!).metadata();
    expect([cover.width, cover.height]).toEqual([1080, 1920]);

    expect(await previewOf(h)).toMatchObject({
      status: "ready", error: null, renderedAt: "2026-10-01T00:01:00.000Z",
      outputs: [{ assetId: "50000000-0000-4000-8000-000000000000", kind: "video", sourceAssetId: CA }],
      coverAssetId: "50000000-0000-4000-8000-000000000000",
    });
  });
});

describe("I2: a photos-only reel", () => {
  it("in mono with no music: silent, grey, two holds less a crossfade long", async () => {
    const kit = kitOf("reel", [photo(PL), photo(PV)], { overlayText: null }, { lookPreset: "mono", musicMood: null });
    const h = await harness(kit);
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    const out = h.published[0].outputs[0];
    const probe = await probeMedia(out.path);
    expect(probe.hasAudio).toBe(false);
    expect(probe.durationSec).toBeCloseTo((h.plan as VideoRenderPlan).totalSec, 1);
    // The green photo, graded mono: every pixel's channels within a few levels of each other.
    const rgb = await readFrameRgb(out.path, 0.5, { width: 1080, height: 1920 });
    let spread = 0;
    for (let i = 0; i < rgb.length; i += 3) spread = Math.max(spread, Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) - Math.min(rgb[i], rgb[i + 1], rgb[i + 2]));
    expect(spread).toBeLessThanOrEqual(8);
  });
});

describe("I2b: a photos-only reel with music", () => {
  it("is music only, so the bed is the programme: −14 LUFS integrated, under −1 dBTP (not Medium's −12 dB under)", async () => {
    const kit = kitOf("reel", [photo(PL), photo(PV)], { overlayText: null }, { lookPreset: "natural", musicMood: "hype" });
    const h = await harness(kit);
    expect((h.plan as VideoRenderPlan).bed).not.toBeNull();
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    const out = h.published[0].outputs[0];
    expect((await probeMedia(out.path)).hasAudio).toBe(true);
    const { stderr } = await execFileP("ffmpeg", ["-hide_banner", "-nostdin", "-i", out.path, "-map", "0:a:0", "-af", ebur128Filter({ peak: true }), "-f", "null", "-"], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    const lufs = Number([...stderr.matchAll(/^\s+I:\s+(-?[\d.]+)\s+LUFS/gm)].at(-1)![1]);
    const truePeak = Number([...stderr.matchAll(/^\s+Peak:\s+(-?[\d.]+)\s+dBFS/gm)].at(-1)![1]);
    expect(Math.abs(lufs - BED_REFERENCE_LUFS)).toBeLessThanOrEqual(1);
    expect(truePeak).toBeLessThanOrEqual(TRUE_PEAK_DBTP + 0.1);
  });
});

describe("I3: a carousel", () => {
  it("a picture, a clip slide and a vertical picture at 1080×1350; the cover a still off the clip slide", async () => {
    const kit = kitOf("carousel", [photo(PL), clipOf(CB, 0, 1.5, 1.5), photo(PV)], { coverFrame: { assetId: CB, atSec: 0.5 } }, { lookPreset: "vivid", musicMood: "hype" });
    const h = await harness(kit);
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    const [render] = h.published;
    expect(render.outputs.map((o) => [o.kind, o.width, o.height, o.sourceAssetId])).toEqual([
      ["image", 1080, 1350, PL], ["video", 1080, 1350, CB], ["image", 1080, 1350, PV],
    ]);
    for (const o of render.outputs.filter((x) => x.kind === "image")) {
      const m = await sharp(o.path).metadata();
      expect([m.format, m.width, m.height]).toEqual(["jpeg", 1080, 1350]);
    }
    // The vertical picture, cropped to 4:5 around the upper middle: its top is the red half, its bottom the blue.
    const v = await sharp(render.outputs[2].path).resize(10, 10).raw().toBuffer();
    expect(v[0]).toBeGreaterThan(v[2]);
    expect(v[v.length - 1]).toBeGreaterThan(v[v.length - 3]);
    const slide = await probeMedia(render.outputs[1].path);
    expect(slide).toMatchObject({ width: 1080, height: 1350 });
    expect(slide.durationSec).toBeCloseTo(1.5, 1);
    expect(render.cover.outputIndex).toBe(1);
    expect((await stat(render.cover.path!)).size).toBeGreaterThan(0);
    expect((await previewOf(h)).coverAssetId).toBe("50000000-0000-4000-8000-000000000001");
  });
});

describe("I4: a feed post", () => {
  it("one 1080×1350 picture", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    const [render] = h.published;
    expect(render.outputs).toHaveLength(1);
    const m = await sharp(render.outputs[0].path).metadata();
    expect([m.format, m.width, m.height]).toEqual(["jpeg", 1080, 1350]);
    expect(render.cover).toEqual({ outputIndex: 0, path: null });
  });
});

describe("I5: a clip shorter than its row said", () => {
  it("the render keeps inside the real file", async () => {
    // The row claims clipC runs 6 s and the kit cut 0–4; the file is 1 s.
    const kit = kitOf("reel", [clipOf(CC, 0, 4, 6), photo(PL)], { overlayText: null }, { lookPreset: "natural", musicMood: null });
    const h = await harness(kit);
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    const probe = await probeMedia(h.published[0].outputs[0].path);
    expect(probe.durationSec).toBeCloseTo(1 + 2 - 0.3, 1);
  });
});

describe("I6: a missing asset", () => {
  it("fails the job, and the preview says so in her words", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]), {
      materialize: async () => { throw new MaterializeError("A photo in this timeline could not be found", "not_found"); },
    });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.closed).toEqual([[h.job.id, "failed: A photo in this timeline could not be found"]]);
    expect(await previewOf(h)).toMatchObject({ status: "failed", error: "A photo in this timeline could not be found", outputs: [] });
  });

  it("an engine error is logged, and replaced by a sentence she can act on", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]), {
      materialize: async () => { throw new Error("ffmpeg exploded at /tmp/secret/path"); },
    });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect((await previewOf(h)).error).toBe(RENDER_ERRORS.generic);
  });
});

describe("I7: nothing is fetched when the render is not wanted", () => {
  it("superseded by a newer request for another key: cancelled", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    const d = (await h.store.getDecision(A, h.decisionId))!;
    const det = d.detail as unknown as ActionDecisionDetail;
    const kit = det.prepared!.postKit!;
    await h.store.updateDecision(A, h.decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: { ...kit, preview: { ...kit.preview!, key: "f".repeat(32), requestedAt: "2026-10-01T00:00:30.000Z" } } } } as unknown as Record<string, unknown> });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("canceled");
    expect(h.materialized).toBe(0);
    expect(h.closed).toEqual([[h.job.id, "canceled"]]);
  });

  it("the render switched off since it was queued: failed, and said", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    process.env.AGENT_POST_KIT_RENDER = "false";
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.materialized).toBe(0);
    expect((await previewOf(h)).error).toBe(RENDER_ERRORS.off);
  });

  it("a spec that does not read back: failed, and the kit is not touched", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    const bad = { ...h.job, spec: { ...(h.job.spec as object), key: "0".repeat(32) } } as StudioStitchJob;
    expect(await workPostKitRender(bad, "me", h.deps)).toBe("failed");
    expect(h.closed).toEqual([[h.job.id, `failed: ${RENDER_ERRORS.unreadable}`]]);
    expect((await previewOf(h)).status).toBe("queued");
  });
});

describe("I8: the job is always closed, and the kit only written by the job that owns it", () => {
  const LATER = "2026-10-01T00:00:30.000Z";

  it("a swap while it renders: nothing is uploaded, the job is cancelled, the new preview stands", async () => {
    const h = await harness(kitOf("reel", [clipOf(CB, 0, 1.5, 1.5)], { overlayText: null }));
    const probe = h.deps.probeSec;
    h.deps.probeSec = async (p) => { await repoint(h, { key: "e".repeat(32), jobId: "another", requestedAt: LATER }); return probe(p); };
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("canceled");
    expect(h.published).toEqual([]);
    expect(h.closed).toEqual([[h.job.id, "canceled"]]);
    expect(await previewOf(h)).toMatchObject({ key: "e".repeat(32), status: "queued", jobId: "another" });
  });

  it("a swap while it uploads: the job succeeds, markReady refuses, the new preview stands", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    h.deps.publish = (() => {
      const publish = h.deps.publish;
      return async (input) => { await repoint(h, { key: "d".repeat(32), jobId: "another", requestedAt: LATER }); return publish(input); };
    })();
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    expect(h.closed).toEqual([[h.job.id, "succeeded"]]);
    expect(await previewOf(h)).toMatchObject({ key: "d".repeat(32), status: "queued", outputs: [] });
  });

  it("another job owns this key (the kit names it, asked after this job was queued): cancelled before anything moves", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    await repoint(h, { jobId: "40000000-0000-4000-8000-000000000002", requestedAt: LATER });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("canceled");
    expect(h.materialized).toBe(0);
  });

  it("claimed between its insert and the kit write: the kit still names an OLDER job for this key — this one runs", async () => {
    // The request re-asked (the old job ended), queued this job at 00:00:01 and has not yet written it onto the kit, which
    // still names the old job, asked at 00:00:00. A tick claims this job now: it must not cancel the job the kit is
    // about to name.
    const h = await harness(kitOf("feed", [photo(PL)]));
    await repoint(h, { jobId: "40000000-0000-4000-8000-000000000000", status: "queued", requestedAt: "2026-10-01T00:00:00.000Z" });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    expect(h.closed).toEqual([[h.job.id, "succeeded"]]);
  });

  it("…but a failed preview for this key, or one older than the job for another key, is this job's to replace", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    await repoint(h, { jobId: "40000000-0000-4000-8000-000000000002", status: "failed" });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    const g = await harness(kitOf("feed", [photo(PL)]));
    await repoint(g, { key: "c".repeat(32), jobId: "older", requestedAt: "2026-10-01T00:00:00.500Z" });
    expect(await workPostKitRender(g.job, "me", g.deps)).toBe("succeeded");
  });

  it("a lost lease: the job is not closed again and the kit is left to the job's holder", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    h.deps.jobs.succeed = async () => false;
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("lost");
    expect(h.closed).toEqual([]);
    expect((await previewOf(h)).status).toBe("queued");
  });

  it("a store that throws before anything starts: the job row is still closed", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    h.deps.store = { ...h.store, getDecision: async () => { throw new Error("database gone"); } };
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.closed).toEqual([[h.job.id, `failed: ${RENDER_ERRORS.generic}`]]);
  });

  it("a kit write that fails never skips closing the job", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]), {
      materialize: async () => { throw new MaterializeError("A photo in this timeline could not be found", "not_found"); },
    });
    h.deps.store = { ...h.store, updateDecision: async () => { throw new Error("write refused"); } };
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.closed).toEqual([[h.job.id, "failed: A photo in this timeline could not be found"]]);
  });
});

describe("I9: check before deliver (A4)", () => {
  it("the real check reads the real files: a reel passes on the plan's shape", async () => {
    const h = await harness(kitOf("reel", [clipOf(CA, 0, 2, 2), photo(PV)]));
    const seen: Array<Awaited<ReturnType<typeof verifyRender>>> = [];
    h.deps.verify = async (p, r) => { const v = await verifyRender(p, r); seen.push(v); return v; };
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("succeeded");
    expect(seen).toEqual([expect.objectContaining({ ok: true, kind: "video" })]);
  });

  it("a render that fails its check is needs-a-look: nothing is uploaded, the job fails, the kit is never ready", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    h.deps.verify = async (p, r) => verifyRender(p, r, { image: async () => ({ decoded: true, width: 1080, height: 1080, sizeBytes: 1000 }) });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.published).toEqual([]);
    expect(h.closed).toEqual([[h.job.id, `failed: ${RENDER_ERRORS.needsALook}`]]);
    expect(await previewOf(h)).toMatchObject({ status: "failed", error: RENDER_ERRORS.needsALook, outputs: [] });
  });

  it("what failed is kept aside for debugging (never published), before the workspace goes", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    h.deps.verify = async (p, r) => verifyRender(p, r, { image: async () => ({ decoded: true, width: 1080, height: 1080, sizeBytes: 1000 }) });
    const kept: Array<{ jobId: string; files: string[] }> = [];
    const { keepForReview } = await import("../../../services/verify/keep");
    h.deps.keep = async (athleteId, jobId, r) => {
      const stored = await keepForReview(athleteId, jobId, r.outputs.map((o) => ({ path: o.path, contentType: o.contentType, kind: o.kind })), async () => undefined);
      kept.push({ jobId, files: stored });
      return stored;
    };
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.published).toEqual([]);
    expect(kept).toEqual([{ jobId: h.job.id, files: [expect.stringMatching(new RegExp(`^athletes/[^/]+/studio/needs-a-look/${h.job.id}/0\\.jpg$`))] }]);
  });

  it("a check that THROWS fails closed with the same sentence, final (no retry), never the generic one", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    h.deps.verify = async () => { throw new Error("verifier bug"); };
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.published).toEqual([]);
    expect(h.closed).toEqual([[h.job.id, `failed: ${RENDER_ERRORS.needsALook}`]]);
  });

  it("a file the render did not actually write fails as unreadable (the default check reads the disk)", async () => {
    const h = await harness(kitOf("feed", [photo(PL)]));
    h.deps.verify = async (p, r) => verifyRender(p, { ...r, outputs: r.outputs.map((o) => ({ ...o, path: join(dir, "never-written.jpg") })) });
    expect(await workPostKitRender(h.job, "me", h.deps)).toBe("failed");
    expect(h.published).toEqual([]);
    expect((await previewOf(h)).status).toBe("failed");
  });
});
