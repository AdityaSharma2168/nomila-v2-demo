/**
 * rollReview.intake.test.ts — the keep rules under CAMERA_ROLL_INTAKE (pure): a candidate that carries a kind gets a
 * short description and its fit; a targeted review's fit leans the rank and leads the line; a candidate without a kind
 * (the flag off) is the entry it always was, field for field. Plus the intake's switch and knobs.
 *
 * ⚠️ MUTATION: apply the fit with fitWeight 0 — "no target, no lean" reds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CLOSE_FIT, qualityWord, reviewCandidates, reviewSummary, rollReviewConfig, type ReviewCandidate } from "./rollReview";
import { cameraRollIntakeEnabled, intakeConfig, isIntakeRow } from "./cameraRollIntake";
import type { AssetTags } from "./visionTag";

const tags = (over: Partial<AssetTags> = {}): AssetTags => ({
  athlete_present: true, athlete_prominence: 0.8, shot_type: "portrait", description: "smiling at the camera after a session",
  brands_visible: [], aesthetic_quality: 0.8, brand_safe: true, setting: "indoor gym", attire: "kit", vibe: "warm",
  hero_suitability: 0.8, disposition: "as_is", edit_note: "", reason: "Looks great.", ...over,
} as AssetTags);
const cand = (itemId: string, over: Partial<ReviewCandidate> = {}, t: Partial<AssetTags> = {}): ReviewCandidate =>
  ({ itemId, tags: tags(t), embedding: null, likeness: null, ...over });

describe("the entry under the intake", () => {
  it("a kind brings the description: shot type, setting, what she's doing, quality in words", () => {
    const { keep } = reviewCandidates([cand("i1", { kind: "video", fit: null }, { shot_type: "action", aesthetic_quality: 0.65 })]);
    expect(keep[0]).toMatchObject({
      kind: "video", fit: null,
      summary: { shotType: "action", setting: "indoor gym", doing: "smiling at the camera after a session", quality: "good" },
    });
  });

  it("no kind (the flag off): the entry is exactly what it always was", () => {
    const { keep } = reviewCandidates([cand("i1")]);
    expect(Object.keys(keep[0]).sort()).toEqual(["itemId", "rank", "reason", "tags"]);
  });

  it("quality words", () => {
    expect([0.9, 0.7, 0.5, 0.1, "x"].map(qualityWord)).toEqual(["great", "good", "fair", "poor", "poor"]);
    expect(reviewSummary(tags({ setting: "  a   very long  ".repeat(20) })).setting.length).toBeLessThanOrEqual(80);
  });
});

describe("a targeted review", () => {
  it("leans the rank toward what it looks for", () => {
    const cfg = { ...rollReviewConfig(), fitWeight: 0.4 };
    const better = cand("better", { kind: "photo", fit: 0 }, { hero_suitability: 0.9, aesthetic_quality: 0.9 });
    const closer = cand("closer", { kind: "photo", fit: 1 }, { hero_suitability: 0.7, aesthetic_quality: 0.7 });
    expect(reviewCandidates([better, closer], cfg).keep.map((k) => k.itemId)).toEqual(["closer", "better"]);
  });

  it("no target, no lean: fitWeight 0 keeps the plain order", () => {
    const better = cand("better", { kind: "photo", fit: 0 }, { hero_suitability: 0.9, aesthetic_quality: 0.9 });
    const closer = cand("closer", { kind: "photo", fit: 1 }, { hero_suitability: 0.7, aesthetic_quality: 0.7 });
    expect(reviewCandidates([better, closer]).keep.map((k) => k.itemId)).toEqual(["better", "closer"]);
  });

  it("a close fit leads its line with what it's close to", () => {
    const cfg = { ...rollReviewConfig(), fitWeight: 0.4 };
    const { keep } = reviewCandidates([cand("i1", { kind: "photo", fit: CLOSE_FIT })], cfg);
    expect(keep[0].reason).toBe("Close to what you're looking for · Looks great.");
  });
});

describe("the switch and the knobs", () => {
  const KEYS = ["CAMERA_ROLL_INTAKE", "CAMERA_ROLL_INTAKE_DAILY_PREVIEWS", "CAMERA_ROLL_INTAKE_FIT_WEIGHT", "CAMERA_ROLL_INTAKE_PURGE_HOURS", "CAMERA_ROLL_INTAKE_CLIP_DAILY_USD"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("only the exact string \"true\" is on", () => {
    for (const v of ["", "false", "TRUE", "1", " true"]) { process.env.CAMERA_ROLL_INTAKE = v; expect(cameraRollIntakeEnabled()).toBe(false); }
    process.env.CAMERA_ROLL_INTAKE = "true";
    expect(cameraRollIntakeEnabled()).toBe(true);
  });

  const envOf = (file: string) => parse(readFileSync(join(__dirname, "..", "..", "gcp", file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[];
  it("dev turns CAMERA_ROLL_INTAKE on together with MEDIA_VIDEO_FIXES; prod sets neither", () => {
    const dev = envOf("cloud-run-dev.yaml");
    expect(dev.filter((e) => e.name === "CAMERA_ROLL_INTAKE")).toEqual([{ name: "CAMERA_ROLL_INTAKE", value: "true" }]);
    // Imported videos are only content-checked when MEDIA_VIDEO_FIXES is on too (review of #960).
    expect(dev.filter((e) => e.name === "MEDIA_VIDEO_FIXES")).toEqual([{ name: "MEDIA_VIDEO_FIXES", value: "true" }]);
    expect(envOf("cloud-run-prod.yaml").filter((e) => e.name === "CAMERA_ROLL_INTAKE")).toEqual([]);
  });

  it("defaults, tuning, nonsense falls back", () => {
    expect(intakeConfig()).toEqual({ dailyPreviews: 600, fitWeight: 0.4, purgeAfterHours: 48, clipReadDailyUsd: 2 });
    process.env.CAMERA_ROLL_INTAKE_DAILY_PREVIEWS = "100";
    process.env.CAMERA_ROLL_INTAKE_FIT_WEIGHT = "7";
    expect(intakeConfig()).toMatchObject({ dailyPreviews: 100, fitWeight: 0.4 });
  });

  it("an intake row is one with metadata.review", () => {
    expect([isIntakeRow({ review: { sessionId: "s" } }), isIntakeRow({}), isIntakeRow(null)]).toEqual([true, false, false]);
  });
});
