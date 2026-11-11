/**
 * compile.test.ts — the treatment plan → render compiler (agent/postKit/render/compile.ts), pure: no ffmpeg, no db.
 *
 *   R1 the mapping, field by field: aspect → frame, cropToFill, order, trims, stills, overlay, music, look, cover, total
 *   R2 the joins: a crossfade only where both sides run a second, a cut otherwise
 *   R3 edge cases: a photos-only reel, a single photo (reel and feed), very short clips, a missing asset, the length cap
 *   R4 the key: the same kit renders once; a caption edit changes nothing, a swap or a re-order changes it
 *   R5 the stored spec: read back intact; a tampered plan, a bad id or an unknown name is refused
 *   R6 at run time: the files' real lengths (conformToProbes), and the engine request (stitchRequestFor, slideRequestFor)
 */
jest.mock("../../../db", () => ({ db: {} }));
jest.mock("../../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));

import type { PostFormat, PostKit, PostKitAsset } from "../../../../shared/postKit";
import { MUSIC_TRACKS, type TrackId } from "../../../studio/music/tracks";
import { MUSIC_CATALOGUE } from "../../../studio/music/find";
import { isLibraryTrackId } from "../../../studio/music/library";
import { TRUE_PEAK_DBTP } from "../../../studio/video/finishing";
import { treatmentFor } from "../kit";
import {
  compileRender, conformToProbes, coverAssetFor, CROSSFADE_SEC, drawableOverlay, expectedOutputs, fitClip,
  parseRenderOutputPath, readRenderJobSpec, renderCoverPath, renderJobSpec, renderKey, renderOutputPath, slideRequestFor,
  stitchRequestFor,
  timelineOf, trackForMood,
  type CompileOptions, type RenderSource, type SlidesRenderPlan, type VideoRenderPlan,
} from "./compile";

const P1 = "10000000-0000-4000-8000-000000000001";
const P2 = "10000000-0000-4000-8000-000000000002";
const C1 = "20000000-0000-4000-8000-000000000001";
const C2 = "20000000-0000-4000-8000-000000000002";
const C3 = "20000000-0000-4000-8000-000000000003";
const DECISION = "30000000-0000-4000-8000-000000000001";

const photo = (id: string): PostKitAsset => ({ assetId: id, mediaType: "photo", clip: null, durationSec: null, provenance: "camera" });
const clipAsset = (id: string, startSec: number, endSec: number, durationSec: number | null): PostKitAsset => ({
  assetId: id, mediaType: "clip", clip: { startSec, endSec, from: "beat" }, durationSec, provenance: "camera",
});

/** A kit whose treatment is the builder's own (kit.ts treatmentFor), then `over` on top. */
function kitOf(format: PostFormat, assets: PostKitAsset[], over: Partial<PostKit["treatmentPlan"]> = {}, hook = "Early sessions add up"): PostKit {
  const { assets: fitted, treatment } = treatmentFor(format, assets, { lookPreset: "warm", musicMood: "hype" }, hook, []);
  return {
    contract: "post-kit/1", momentDecisionId: null,
    idea: { hook, format, platform: "instagram", timing: "This week" }, formatFromMoment: false,
    brief: { show: "s", captionAngle: "a", avoid: "" }, assets: fitted, shortlist: [],
    caption: { text: "The work nobody sees.", hashtags: [], edited: false },
    treatmentPlan: { ...treatment, ...over },
    aiGenerationNeeded: { value: false, reason: "r" },
    match: { runId: null, skillVersion: null, candidates: 0, costMicroUsd: 0, noneFitNote: null },
    builtAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const sourcesOf = (kit: PostKit, over: Record<string, RenderSource | null> = {}): Map<string, RenderSource> => {
  const m = new Map<string, RenderSource>();
  for (const a of kit.assets) {
    const o = over[a.assetId];
    if (o === null) continue;
    m.set(a.assetId, o ?? { mediaType: a.mediaType, durationSec: a.durationSec });
  }
  return m;
};
const OPTS: CompileOptions = { forBrand: false, musicReady: true };

function compiled(kit: PostKit, sources = sourcesOf(kit), opts = OPTS) {
  const c = compileRender(kit, sources, opts);
  if (!c.ok) throw new Error(`did not compile: ${c.reason}`);
  return c;
}

describe("R1: the mapping, field by field", () => {
  const reel = kitOf("reel", [clipAsset(C1, 2, 6, 10), photo(P1), clipAsset(C2, 0, 3, 8)]);

  it("aspect → the frame; a reel is one 9:16 video", () => {
    const { plan } = compiled(reel);
    expect(plan).toMatchObject({ output: "video", format: "reel", aspect: "9:16", width: 1080, height: 1920 });
    const feed = compiled(kitOf("feed", [photo(P1)])).plan;
    expect(feed).toMatchObject({ output: "slides", aspect: "4:5", width: 1080, height: 1350 });
    // The format pins the frame, whatever the treatment says: a reel is 9:16, a carousel 4:5.
    expect(compiled(kitOf("carousel", [photo(P1), photo(P2)], { aspect: "9:16" })).plan).toMatchObject({ aspect: "4:5", width: 1080, height: 1350 });
    expect(compiled(kitOf("reel", [photo(P1)], { aspect: "4:5" })).plan).toMatchObject({ aspect: "9:16", width: 1080, height: 1920 });
    const story = compiled(kitOf("story", [photo(P1)])).plan;
    expect(story).toMatchObject({ output: "video", format: "story", aspect: "9:16", width: 1080, height: 1920 });
  });

  it("cropToFill → the plan's crop (true, and false kept)", () => {
    expect(compiled(reel).plan.cropToFill).toBe(true);
    expect(compiled(kitOf("reel", [photo(P1)], { cropToFill: false })).plan.cropToFill).toBe(false);
  });

  it("order, trims and stills → positions in order, with each clip's seconds and each photo's hold", () => {
    const { plan } = compiled(reel);
    expect(plan.positions).toEqual([
      { assetId: C1, kind: "clip", trimStartSec: 2, trimEndSec: 6, holdSec: null, crossfadeSec: null },
      { assetId: P1, kind: "still", trimStartSec: null, trimEndSec: null, holdSec: 2, crossfadeSec: CROSSFADE_SEC },
      { assetId: C2, kind: "clip", trimStartSec: 0, trimEndSec: 3, holdSec: null, crossfadeSec: CROSSFADE_SEC },
    ]);
    // A re-ordered treatment re-orders the positions; a hold is kept inside 1–8 s.
    const reordered = compiled(kitOf("reel", [clipAsset(C1, 2, 6, 10), photo(P1)], { order: [P1, C1], stills: [{ assetId: P1, holdSec: 20 }] })).plan;
    expect(reordered.positions.map((p) => [p.assetId, p.holdSec])).toEqual([[P1, 8], [C1, null]]);
  });

  it("a carousel: one picture per position, no holds, no joins; a clip slide keeps its seconds", () => {
    const plan = compiled(kitOf("carousel", [photo(P1), clipAsset(C1, 1, 4, 9), photo(P2)])).plan as SlidesRenderPlan;
    expect(plan.positions).toEqual([
      { assetId: P1, kind: "still", trimStartSec: null, trimEndSec: null, holdSec: null, crossfadeSec: null },
      { assetId: C1, kind: "clip", trimStartSec: 1, trimEndSec: 4, holdSec: null, crossfadeSec: null },
      { assetId: P2, kind: "still", trimStartSec: null, trimEndSec: null, holdSec: null, crossfadeSec: null },
    ]);
    expect(expectedOutputs(plan)).toEqual([{ kind: "image", sourceAssetId: P1 }, { kind: "video", sourceAssetId: C1 }, { kind: "image", sourceAssetId: P2 }]);
  });

  it("overlayText → a caption at the top, on a plate; drawn only on a video", () => {
    expect((compiled(reel).plan as VideoRenderPlan).overlay).toEqual({ text: "Early sessions add up", position: "top", style: "boxed" });
    expect(compiled(kitOf("feed", [photo(P1)])).plan).not.toHaveProperty("overlay");
    expect((compiled(kitOf("reel", [photo(P1)], { overlayText: null })).plan as VideoRenderPlan).overlay).toBeNull();
  });

  it("an overlay the font cannot draw loses the undrawable characters, and is cut at a word to 60", () => {
    expect(drawableOverlay("Game day 🔥🔥 let's go")).toBe("Game day let's go");
    const long = drawableOverlay("one two three four five six seven eight nine ten eleven twelve thirteen");
    expect(long).toBe("one two three four five six seven eight nine ten eleven");
    expect(Array.from(long!).length).toBeLessThanOrEqual(60);
    const c = compiled(kitOf("reel", [photo(P1)], { overlayText: "🔥🔥🔥" }));
    expect((c.plan as VideoRenderPlan).overlay).toBeNull();
    expect(c.notes).toEqual(["overlay_not_drawable"]);
  });

  it("musicMood → the best track carrying that mood; none, not installed, or no track carrying it are said", () => {
    const plan = compiled(reel).plan as VideoRenderPlan;
    expect(plan.bed).not.toBeNull();
    expect(MUSIC_TRACKS[plan.bed as TrackId].moods).toContain("hype");
    expect(plan.bed).toBe(trackForMood("hype", false));
    const brand = trackForMood("warm", true)!;
    expect(MUSIC_TRACKS[brand]).toMatchObject({ brandSafe: true });
    expect(MUSIC_TRACKS[brand].moods).toContain("warm");
    const off = compiled(reel, sourcesOf(reel), { forBrand: false, musicReady: false });
    expect((off.plan as VideoRenderPlan).bed).toBeNull();
    expect(off.notes).toEqual(["music_not_installed"]);
    const none = compiled(kitOf("reel", [photo(P1)], { musicMood: "uplifting" }));
    expect((none.plan as VideoRenderPlan).bed).toBeNull();
    expect(none.notes).toEqual(["no_track_for_mood"]);
    const silent = compiled(kitOf("reel", [photo(P1)], { musicMood: null }));
    expect((silent.plan as VideoRenderPlan).bed).toBeNull();
    expect(silent.notes).toEqual([]);
  });

  it("kit.music.selected → that track (her pick), not the mood's; null → no music; a choice not brand-safe never goes under a brand post", () => {
    // Whatever the attribution switch (M2), these picks are judged on brand-safety and install alone.
    process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS = "true";
    const free = Object.values(MUSIC_CATALOGUE).find((t) => !t.brandSafe && t.moods.includes("hype"))!;
    const safe = Object.values(MUSIC_CATALOGUE).find((t) => t.brandSafe && t.moods.includes("hype"))!;
    const choice = (id: string) => ({ trackId: id, title: id, artist: "a", reason: "r", licence: "CC0-1.0", credit: null });
    const withPick = (selected: string | null): PostKit => ({ ...reel, music: { choices: [choice(free.id), choice(safe.id)], selected } });
    const LIB = { forBrand: false, musicReady: true, libraryReady: true };
    expect((compiled(withPick(free.id), sourcesOf(reel), LIB).plan as VideoRenderPlan).bed).toBe(free.id);
    // The free library has its own gate: not installed here, not laid under.
    const gated = compiled(withPick(free.id), sourcesOf(reel), { forBrand: false, musicReady: true, libraryReady: false });
    expect([(gated.plan as VideoRenderPlan).bed, gated.notes]).toEqual([isLibraryTrackId(free.id) ? null : free.id, isLibraryTrackId(free.id) ? ["music_not_installed"] : []]);
    expect((compiled(withPick(safe.id), sourcesOf(reel), LIB).plan as VideoRenderPlan).bed).toBe(safe.id);
    const none = compiled(withPick(null));
    expect([(none.plan as VideoRenderPlan).bed, none.notes]).toEqual([null, []]);
    // THE GUARD at the render: a stored non-brand-safe pick on a brand post falls back to the mood's brand-safe track.
    const brand = compiled(withPick(free.id), sourcesOf(reel), { forBrand: true, musicReady: true, libraryReady: true }).plan as VideoRenderPlan;
    expect(brand.bed).not.toBe(free.id);
    expect(brand.bed === null || MUSIC_CATALOGUE[brand.bed].brandSafe).toBe(true);
    // A pick that is not one of the kit's choices, or not in the catalogue, is ignored the same way.
    const stray = compiled({ ...reel, music: { choices: [choice(safe.id)], selected: "not-a-track" } }).plan as VideoRenderPlan;
    expect(stray.bed).toBe(trackForMood("hype", false));
    // The key follows the pick: a switch re-renders.
    expect(compiled(withPick(free.id), sourcesOf(reel), LIB).key).not.toBe(compiled(withPick(safe.id), sourcesOf(reel), LIB).key);
    // Not installed: said, not guessed.
    expect(compiled(withPick(free.id), sourcesOf(reel), { forBrand: false, musicReady: false }).notes).toEqual(["music_not_installed"]);
    // A stored spec with a library id reads back.
    const c = compiled(withPick(free.id), sourcesOf(reel), LIB);
    expect(readRenderJobSpec(renderJobSpec(DECISION, c.plan, c.key))).not.toHaveProperty("error");
    delete process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS;
  });

  it("M2: with MUSIC_ALLOW_ATTRIBUTION_TRACKS off, a stored pick that owes a credit is never laid under", () => {
    const owes = Object.values(MUSIC_CATALOGUE).find((t) => t.credit && t.moods.includes("hype"))!;
    const choice = { trackId: owes.id, title: owes.title, artist: "a", reason: "r", licence: owes.licence, credit: owes.credit };
    const plan = compiled({ ...reel, music: { choices: [choice], selected: owes.id } }, sourcesOf(reel), { forBrand: false, musicReady: true, libraryReady: true }).plan as VideoRenderPlan;
    expect(plan.bed).not.toBe(owes.id);
  });

  it("lookPreset → the plan's look; a name outside the set is natural", () => {
    expect(compiled(reel).plan.look).toBe("warm");
    expect(compiled(kitOf("reel", [photo(P1)], { lookPreset: "sepia" as never })).plan.look).toBe("natural");
  });

  it("coverFrame → a position and seconds into it, clear of the crossfades", () => {
    // The builder's cover: the first asset, a second into its cut.
    expect(compiled(reel).plan.cover).toEqual({ position: 0, offsetSec: 1 });
    // A cover on the held photo: the middle of its hold, at least past the crossfade into it.
    expect(compiled(reel.treatmentPlan.coverFrame ? { ...reel, treatmentPlan: { ...reel.treatmentPlan, coverFrame: { assetId: P1, atSec: null } } } : reel).plan.cover).toEqual({ position: 1, offsetSec: 1 });
    // A cover on the last clip at 2.9 s: inside the clip by a frame.
    const late = compiled({ ...reel, treatmentPlan: { ...reel.treatmentPlan, coverFrame: { assetId: C2, atSec: 2.99 } } }).plan.cover;
    expect(late.position).toBe(2);
    expect(late.offsetSec).toBeCloseTo(3 - 1 / 30, 3);
    // A carousel picture: its own picture, at 0.
    expect(compiled(kitOf("carousel", [photo(P1), photo(P2)], { coverFrame: { assetId: P2, atSec: null } })).plan.cover).toEqual({ position: 1, offsetSec: 0 });
    // No cover: the opening position.
    expect(compiled(kitOf("carousel", [photo(P1), photo(P2)], { coverFrame: null })).plan.cover).toEqual({ position: 0, offsetSec: 0 });
  });

  it("totalSec → the positions as the engine lays them (crossfades overlap)", () => {
    const plan = compiled(reel).plan as VideoRenderPlan;
    expect(plan.totalSec).toBeCloseTo(4 + 2 + 3 - 2 * CROSSFADE_SEC, 6);
    expect(timelineOf(plan.positions)).toEqual({ starts: [0, 3.7, 5.4], totalSec: 8.4 });
  });
});

describe("R2: the joins", () => {
  it("a crossfade only where both sides run at least a second; the first position is always a cut", () => {
    const plan = compiled(kitOf("reel", [clipAsset(C1, 0, 0.8, 0.8), clipAsset(C2, 0, 3, 5), clipAsset(C3, 0, 2, 5)])).plan;
    expect(plan.positions.map((p) => p.crossfadeSec)).toEqual([null, null, CROSSFADE_SEC]);
  });
});

describe("R3: edge cases", () => {
  it("a photos-only reel: every position a held photo, the total their holds less the crossfades", () => {
    const c = compiled(kitOf("reel", [photo(P1), photo(P2)]));
    const plan = c.plan as VideoRenderPlan;
    expect(plan.positions.map((p) => [p.kind, p.holdSec])).toEqual([["still", 2], ["still", 2]]);
    expect(plan.totalSec).toBeCloseTo(4 - CROSSFADE_SEC, 6);
    expect(expectedOutputs(plan)).toEqual([{ kind: "video", sourceAssetId: P1 }]);
  });

  it("a single photo: a 2 s reel, or one feed picture", () => {
    const reel = compiled(kitOf("reel", [photo(P1)])).plan as VideoRenderPlan;
    expect(reel.positions).toHaveLength(1);
    expect(reel.totalSec).toBe(2);
    expect(reel.cover).toEqual({ position: 0, offsetSec: 1 });
    const feed = compiled(kitOf("feed", [photo(P1)])).plan;
    expect(feed.positions).toEqual([{ assetId: P1, kind: "still", trimStartSec: null, trimEndSec: null, holdSec: null, crossfadeSec: null }]);
    expect(feed.cover).toEqual({ position: 0, offsetSec: 0 });
    expect(expectedOutputs(feed)).toEqual([{ kind: "image", sourceAssetId: P1 }]);
  });

  it("very short clips: a 0.8 s clip plays whole; one under half a second is left out and said", () => {
    const kit = kitOf("reel", [clipAsset(C1, 0, 0.8, 0.8), clipAsset(C2, 0, 0.3, 0.3), photo(P1)]);
    const c = compiled(kit);
    expect(c.plan.positions.map((p) => [p.assetId, p.trimStartSec, p.trimEndSec])).toEqual([[C1, 0, 0.8], [P1, null, null]]);
    expect(c.notes).toEqual(["clip_too_short"]);
    // A trim past the clip's real end is pulled back inside it, keeping half a second.
    expect(fitClip(4, 6, 4.2, 30)).toEqual({ startSec: 3.7, endSec: 4.2 });
    expect(fitClip(1, 1.1, null, 30)).toEqual({ startSec: 0.6, endSec: 1.1 });
    expect(fitClip(0, 0.2, 0.3, 30)).toBeNull();
  });

  it("a missing asset is left out and said; with none left, nothing compiles", () => {
    const kit = kitOf("reel", [clipAsset(C1, 0, 3, 5), photo(P1)]);
    const c = compiled(kit, sourcesOf(kit, { [C1]: null }));
    expect(c.plan.positions.map((p) => p.assetId)).toEqual([P1]);
    expect(c.notes).toEqual(["asset_missing"]);
    expect(compileRender(kit, new Map(), OPTS)).toEqual({ ok: false, reason: "nothing_available", notes: ["asset_missing"] });
    expect(compileRender({ ...kit, assets: [], treatmentPlan: { ...kit.treatmentPlan, order: [] } }, new Map(), OPTS)).toEqual({ ok: false, reason: "no_assets", notes: [] });
  });

  it("a vertical source compiles like any other: the frame is the post's, the crop the runner's", () => {
    const kit = kitOf("reel", [clipAsset(C1, 0, 4, 4)]);
    const plan = compiled(kit, sourcesOf(kit, { [C1]: { mediaType: "clip", durationSec: 4 } })).plan;
    expect(plan).toMatchObject({ width: 1080, height: 1920, cropToFill: true, positions: [{ trimStartSec: 0, trimEndSec: 4 }] });
  });

  it("the 30 s cap: the later clips give up seconds first, and it is said", () => {
    const kit = kitOf("reel", [clipAsset(C1, 0, 12, 20), clipAsset(C2, 0, 12, 20), clipAsset(C3, 0, 12, 20)], {
      trims: [{ assetId: C1, startSec: 0, endSec: 12 }, { assetId: C2, startSec: 0, endSec: 12 }, { assetId: C3, startSec: 0, endSec: 12 }],
    });
    const c = compiled(kit);
    const plan = c.plan as VideoRenderPlan;
    expect(plan.totalSec).toBeLessThanOrEqual(30);
    expect(plan.totalSec).toBeCloseTo(30, 6);
    expect(plan.positions.map((p) => p.trimEndSec)).toEqual([12, 12, 6.6]);
    expect(c.notes).toEqual(["over_length"]);
  });
});

describe("R4: the key", () => {
  const kit = kitOf("reel", [clipAsset(C1, 2, 6, 10), photo(P1)]);
  it("is the plan's own: the same kit gives the same key; a caption edit gives the same key", () => {
    const a = compiled(kit);
    expect(a.key).toMatch(/^[0-9a-f]{32}$/);
    expect(compiled(kit).key).toBe(a.key);
    expect(compiled({ ...kit, caption: { text: "New words", hashtags: [], edited: true } }).key).toBe(a.key);
    expect(renderKey(a.plan)).toBe(a.key);
  });
  it("a swap, a re-order, a new overlay or look gives a new key", () => {
    const a = compiled(kit).key;
    expect(compiled(kitOf("reel", [clipAsset(C1, 2, 6, 10), photo(P2)])).key).not.toBe(a);
    expect(compiled({ ...kit, treatmentPlan: { ...kit.treatmentPlan, order: [P1, C1] } }).key).not.toBe(a);
    expect(compiled({ ...kit, treatmentPlan: { ...kit.treatmentPlan, overlayText: "Another line" } }).key).not.toBe(a);
    expect(compiled({ ...kit, treatmentPlan: { ...kit.treatmentPlan, lookPreset: "mono" } }).key).not.toBe(a);
  });
});

describe("R5: the stored spec", () => {
  const c = compiled(kitOf("reel", [clipAsset(C1, 2, 6, 10), photo(P1)]));
  const spec = renderJobSpec(DECISION, c.plan, c.key);

  it("carries ids and names only, the sources as clips, and reads back intact through jsonb", () => {
    expect(spec).toMatchObject({ kind: "post_kit_render", contract: "post-kit-render/1", decisionId: DECISION, key: c.key, clips: [{ assetId: C1 }, { assetId: P1 }] });
    expect(readRenderJobSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });

  it("refuses a plan edited after it was queued, a bad id, an unknown name or a cut past the cap", () => {
    const edit = (f: (s: any) => void) => { const s = JSON.parse(JSON.stringify(spec)); f(s); return readRenderJobSpec(s); };
    expect(edit((s) => { s.plan.positions[1].assetId = P2; })).toEqual({ error: "key does not match the plan" });
    // A length edited without its total is caught before the key is even compared.
    expect(edit((s) => { s.plan.positions[0].trimEndSec = 9; })).toEqual({ error: "plan.totalSec" });
    expect(edit((s) => { s.decisionId = "../etc"; })).toEqual({ error: "decisionId" });
    expect(edit((s) => { s.plan.positions[0].assetId = "x"; })).toEqual({ error: "plan.positions[0].assetId" });
    expect(edit((s) => { s.plan.look = "lut=/etc/passwd"; })).toEqual({ error: "plan.look" });
    expect(edit((s) => { s.plan.bed = "not-a-track"; })).toEqual({ error: "plan.bed" });
    expect(edit((s) => { s.plan.overlay.text = "a\nb\nc"; })).toEqual({ error: "plan.overlay" });
    expect(edit((s) => { s.plan.width = 4000; })).toEqual({ error: "plan.frame" });
    expect(edit((s) => { s.plan.aspect = "4:5"; s.plan.width = 1080; s.plan.height = 1350; })).toEqual({ error: "plan.aspect" });
    expect(edit((s) => { s.plan.totalSec = 99; })).toEqual({ error: "plan.totalSec" });
    expect(readRenderJobSpec({ clips: [{ assetId: C1 }], target: "portrait" })).toEqual({ error: "not a post kit render" });
  });

  it("outputs are stored under the athlete's own prefix, by kit and key", () => {
    expect(renderOutputPath("A", DECISION, c.key, 0, 1, "video")).toBe(`athletes/A/studio/post-kit/${DECISION}/${c.key}/0-of-1.mp4`);
    expect(renderOutputPath("A", DECISION, c.key, 2, 3, "image")).toBe(`athletes/A/studio/post-kit/${DECISION}/${c.key}/2-of-3.jpg`);
    expect(renderCoverPath("A", DECISION, c.key, 0, 1)).toBe(`athletes/A/studio/post-kit/${DECISION}/${c.key}/0-of-1.cover.jpg`);
    expect(parseRenderOutputPath(renderOutputPath("A", DECISION, c.key, 2, 3, "image"))).toEqual({ index: 2, count: 3, kind: "image" });
    expect(parseRenderOutputPath(renderCoverPath("A", DECISION, c.key, 0, 1))).toBeNull();
    expect(parseRenderOutputPath("x/3-of-3.mp4")).toBeNull();
  });

  it("the cover output is found by its source, so it holds for a set a run published short", () => {
    const video = [{ assetId: "o0", sourceAssetId: C1 }];
    expect(coverAssetFor(c.plan, video)).toBe("o0");
    const slides = compiled(kitOf("carousel", [photo(P1), clipAsset(C1, 1, 4, 9), photo(P2)], { coverFrame: { assetId: P2, atSec: null } })).plan;
    // The clip slide was left out at run time: the cover's picture is the second output, not the third.
    expect(coverAssetFor(slides, [{ assetId: "a", sourceAssetId: P1 }, { assetId: "b", sourceAssetId: P2 }])).toBe("b");
    expect(coverAssetFor(slides, [])).toBeNull();
  });
});

describe("R6: at run time", () => {
  it("conformToProbes keeps each clip inside its real length, drops one too short, and recomputes", () => {
    const plan = compiled(kitOf("reel", [clipAsset(C1, 2, 6, 10), clipAsset(C2, 0, 3, 8), photo(P1)])).plan as VideoRenderPlan;
    const r = conformToProbes(plan, new Map([[C1, 4.5], [C2, 0.2]]))!;
    expect(r.notes).toEqual(["clip_too_short"]);
    const p = r.plan as VideoRenderPlan;
    expect(p.positions.map((x) => [x.assetId, x.trimStartSec, x.trimEndSec, x.crossfadeSec])).toEqual([[C1, 2, 4.5, null], [P1, null, null, CROSSFADE_SEC]]);
    expect(p.totalSec).toBeCloseTo(2.5 + 2 - CROSSFADE_SEC, 6);
    expect(conformToProbes(compiled(kitOf("reel", [clipAsset(C1, 0, 3, 5)])).plan, new Map([[C1, 0.1]]))).toBeNull();
  });

  it("stitchRequestFor: each field from the plan, each path from the workspace", () => {
    const plan = compiled(kitOf("reel", [clipAsset(C1, 2, 6, 10), photo(P1)])).plan as VideoRenderPlan;
    const req = stitchRequestFor(plan, { sources: ["/w/c1.mp4", "/w/still-1.mp4"], overlay: { source: "/w/overlay.png", y: 250 }, bedPath: "/w/bed.m4a", bedGainDb: -3.5 }, "/w/out.mp4", 60_000);
    expect(req).toEqual({
      clips: [
        { source: "/w/c1.mp4", trimStartSec: 2, trimEndSec: 6, transitionIn: { kind: "cut" }, overlay: { source: "/w/overlay.png", y: 250 } },
        { source: "/w/still-1.mp4", transitionIn: { kind: "crossfade", durationSec: CROSSFADE_SEC } },
      ],
      audioBed: { source: "/w/bed.m4a", duck: {} },
      outputPath: "/w/out.mp4",
      target: { width: 1080, height: 1920, fps: 30 },
      timeoutMs: 60_000,
      finishing: { cropToFill: true, truePeakDbtp: TRUE_PEAK_DBTP, bedGainDb: -3.5, look: "warm" },
    });
    // No bed: no audioBed, no gain; natural: no look.
    const natural = { ...plan, look: "natural" as const, overlay: null };
    const bare = stitchRequestFor(natural, { sources: ["/w/c1.mp4", "/w/s.mp4"], overlay: null, bedPath: null, bedGainDb: -3.5 }, "/w/o.mp4", 1000);
    expect(bare).not.toHaveProperty("audioBed");
    expect(bare.finishing).toEqual({ cropToFill: true, truePeakDbtp: TRUE_PEAK_DBTP });
    expect(() => stitchRequestFor(plan, { sources: ["/w/c1.mp4"], overlay: null, bedPath: null, bedGainDb: null }, "/w/o.mp4", 1)).toThrow("2 positions, 1 files");
    expect(() => stitchRequestFor(plan, { sources: ["/a", "/b"], overlay: null, bedPath: null, bedGainDb: null }, "/w/o.mp4", 1)).toThrow("overlay");
  });

  it("slideRequestFor: one clip slide at the slide frame, its own sound, the look", () => {
    const plan = compiled(kitOf("carousel", [photo(P1), clipAsset(C1, 1, 4, 9)], { lookPreset: "mono" })).plan as SlidesRenderPlan;
    expect(slideRequestFor(plan, 1, "/w/c1.mp4", "/w/slide-1.mp4", 5000)).toEqual({
      clips: [{ source: "/w/c1.mp4", trimStartSec: 1, trimEndSec: 4, transitionIn: { kind: "cut" } }],
      outputPath: "/w/slide-1.mp4",
      target: { width: 1080, height: 1350, fps: 30 },
      timeoutMs: 5000,
      finishing: { cropToFill: true, truePeakDbtp: TRUE_PEAK_DBTP, look: "mono" },
    });
    expect(() => slideRequestFor(plan, 0, "/w/p.jpg", "/w/x.mp4", 1)).toThrow("not a clip");
  });
});
