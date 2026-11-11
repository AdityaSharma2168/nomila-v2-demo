/**
 * kit.test.ts — the post kit's rules as plain functions (agent/postKit/kit.ts): the post to make, which library rows may
 * be used, clip ranges (beats, camera cuts, long clips, the caster's snap), the re-rank's answer checked, the treatment
 * plan's shape per format, and the athlete's swap and caption edits. No database, no model: the caster's module is
 * loaded for its snap, so its database and cloud clients are stood in.
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));

import type { MemoryFact } from "../../../shared/agent";
import { LOOK_PRESETS } from "../../../shared/postKit";
import { brandsToAvoid, SPORTSWEAR_BRANDS } from "../../studio/agent/brands";
import { DEFAULT_STILL_SEC } from "../../studio/video/spec";
import { dayWords } from "../plan/goals";
import { POST_KIT } from "./config";
import {
  AI_REASONS, assembleKit, candidateInput, captionFromBody, clipRangeFor, firstSentence, fitsFormat, fitToTotal, formatFor, FormatMismatch, formatOfPicks, hashtagsOf, refsInOrder,
  ineligibleReason, momentOf, parseMatch, postSpecOf, segmentsOf, shotListFromBody, swapInKit, treatmentFor, withCaption,
  type EligibilityContext, type PostSpec,
} from "./kit";
import { clip, postAction, row } from "./testRows";

const NOW = new Date("2026-10-11T12:00:00Z");
const CTX: EligibilityContext = { neverTerms: [], avoidBrands: [], used: new Set() };
const MATCH = { runId: "r1", skillVersion: "1.0.0", candidates: 3, costMicroUsd: 4000, noneFitNote: null };
const spec = (over: Partial<PostSpec> = {}): PostSpec => ({ ...postSpecOf(postAction(), "Training clip", null, [], dayWords), ...over });

afterEach(() => { delete process.env.STUDIO_SHOT_DETECT; delete process.env.STUDIO_ALL_ON; });

describe("the post to make", () => {
  it("splits a post_brief into its caption and its shot list, and lists the caption's tags", () => {
    const body = "Caption: The work nobody sees.\nEarly sessions add up. #training #Training #process\nShots: a sprint start, a hard rep.";
    expect(captionFromBody(body)).toBe("The work nobody sees.\nEarly sessions add up. #training #Training #process");
    expect(shotListFromBody(body)).toBe("a sprint start, a hard rep.");
    expect(hashtagsOf(captionFromBody(body))).toEqual(["#training", "#process"]);
    expect(captionFromBody("Just the words, no labels.")).toBe("Just the words, no labels.");
    expect(shotListFromBody("Just the words, no labels.")).toBe("");
    expect(firstSentence("Big day ahead! More soon. #tag", 160)).toBe("Big day ahead!");
  });

  it("without a moment, the idea and brief come from the plan's own deliverable", () => {
    const s = postSpecOf(postAction({ dueOn: "2026-10-15" }), "Training clip", null, [], dayWords);
    expect(s).toMatchObject({
      momentDecisionId: null, formatFixed: false,
      idea: { hook: "The work nobody sees.", platform: "instagram", timing: "By Thu 15 Oct" },
      brief: { show: "a sprint start, a hard rep, the walk back.", captionAngle: "The work nobody sees.", avoid: "" },
      caption: { text: "The work nobody sees. Early sessions add up. #training #process", hashtags: ["#training", "#process"], edited: false },
      partner: null,
    });
    expect(s.searchText).toContain("a sprint start");
  });

  it("with a moment, its idea and brief lead — except a line carrying a never-use name, which falls back to the plan's", () => {
    const fact = { id: "f1", subject: { kind: "event", name: "Season opener" }, date: "2026-10-20" } as unknown as MemoryFact;
    const m = momentOf("m1", {
      kind: "moment", idea: { hook: "Ten days to the opener", format: "carousel", platform: "tiktok", timing: "3 days before" },
      brief: { show: "Pat Private in the stands", captionAngle: "Ready", avoid: "anything staged" }, mediaNeeds: "a calm portrait",
    }, fact)!;
    expect(m).toMatchObject({ decisionId: "m1", name: "Season opener", date: "2026-10-20", brief: { captionAngle: "Ready" }, mediaNeeds: "a calm portrait" });
    const s = postSpecOf(postAction(), "Training clip", m, ["Pat Private"], dayWords);
    expect(s).toMatchObject({
      momentDecisionId: "m1", formatFixed: true,
      idea: { hook: "Ten days to the opener", format: "carousel", platform: "instagram", timing: "3 days before" },
      brief: { show: "a sprint start, a hard rep, the walk back.", captionAngle: "Ready", avoid: "anything staged" },
      mediaNeeds: "a calm portrait",
    });
    expect(momentOf("x", { kind: "idea" }, null)).toBeNull();
  });

  it("plan 1.7.0: the caption, tags and shots come from their own fields — the body is never read for them", () => {
    const det = postAction();
    det.deliverable = {
      ...det.deliverable, body: "Format: carousel. Slide 1: the track. Caption draft: an older line.",
      caption: "Four weeks out. Every lap counts.", hashtags: ["#seasonprep", "#trainingday"], shots: ["the track at dawn", "laces tied"],
    };
    const s = postSpecOf(det, "Training clip", null, [], dayWords);
    expect(s.caption).toEqual({ text: "Four weeks out. Every lap counts.\n\n#seasonprep #trainingday", hashtags: ["#seasonprep", "#trainingday"], edited: false });
    expect(s.brief.show).toBe("the track at dawn; laces tied");
    expect(s.idea.hook).toBe("Four weeks out.");
  });

  it("an older brief-shaped body yields only its caption draft; one with no caption yields \"\", never the brief or the title", () => {
    const det = postAction();
    det.deliverable = {
      ...det.deliverable,
      body: "Format: carousel, three slides. Slide 1: a wide shot of the track. Slide 2: laces tied. Caption draft: Four weeks out. #seasonprep\nHashtags: #trainingday",
    };
    const s = postSpecOf(det, "Training clip", null, [], dayWords);
    expect(s.caption.text).toBe("Four weeks out. #seasonprep\n\n#trainingday");
    expect(s.caption.text).not.toMatch(/Format:|Slide \d+:|Shots?:/);
    expect(s.caption.hashtags).toEqual(["#seasonprep", "#trainingday"]);
    expect(s.brief.show).toBe("a wide shot of the track; laces tied");

    det.deliverable = { ...det.deliverable, title: "Countdown story", body: "Format: story. Frame 1: countdown sticker. Frame 2: the team bus." };
    const none = postSpecOf(det, "Training clip", null, [], dayWords);
    expect(none.caption).toEqual({ text: "", hashtags: [], edited: false });
  });

  it("plan 1.7.0, caption \"\" or null: the body is NEVER read for the caption — an unlabelled brief is not a caption", () => {
    const det = postAction();
    const brief = "Reel: open on the clock, then cut to the start line and the last lap. Use the record as the hook.";
    for (const caption of ["", null]) {
      det.deliverable = { ...det.deliverable, body: brief, caption: caption as string, hashtags: ["#trackseason"], shots: [] };
      const s = postSpecOf(det, "Training clip", null, [], dayWords);
      expect(s.caption).toEqual({ text: "#trackseason", hashtags: ["#trackseason"], edited: false });
      expect(s.caption.text).not.toContain("open on the clock");
    }
    // A pre-1.7.0 row (no caption key) still reads its body, as it always did.
    const old = postAction();
    old.deliverable = { ...old.deliverable, body: "Caption: Four weeks out.\nShots: warm-up" };
    expect(postSpecOf(old, "Training clip", null, [], dayWords).caption.text).toBe("Four weeks out.");
  });

  it("a post naming a partner brand keeps that partner; any other kind of target is not a partner", () => {
    const withBrand = postAction();
    withBrand.deliverable.target = { subjectKind: "brand", name: "Partner Co" };
    expect(postSpecOf(withBrand, "x", null, [], dayWords).partner).toEqual({ subjectKind: "brand", name: "Partner Co" });
    const withPerson = postAction();
    withPerson.deliverable.target = { subjectKind: "person", name: "A Coach" };
    expect(postSpecOf(withPerson, "x", null, [], dayWords).partner).toBeNull();
  });
});

describe("which library rows may be in a kit", () => {
  it("only the athlete's own, tagged, brand-safe footage with the athlete in it; each refusal named", () => {
    expect(ineligibleReason(row(), CTX)).toBeNull();
    expect(ineligibleReason(row({ provenance: "synced" }), CTX)).toBeNull();
    expect(ineligibleReason(row({ vision: null }), CTX)).toBe("untagged");
    expect(ineligibleReason(row({ provenance: "made-here" }), CTX)).toBe("not_own_footage");
    expect(ineligibleReason(row({ provenance: "stitched-here" }), CTX)).toBe("not_own_footage");
    expect(ineligibleReason(row({ provenance: null }), CTX)).toBe("not_own_footage");
    expect(ineligibleReason(row({ vision: { athlete_present: false } }), CTX)).toBe("athlete_not_in_it");
    // A legacy blind tag (athlete_present true, no subject) is unsure, and another person is never her.
    expect(ineligibleReason(row({ vision: { subject: undefined, athlete_present: true } }), CTX)).toBe("athlete_not_in_it");
    expect(ineligibleReason(row({ vision: { subject: "another_person", athlete_present: true } }), CTX)).toBe("athlete_not_in_it");
    expect(ineligibleReason(row({ meta: true }), CTX)).toBe("meta_image");
    expect(ineligibleReason(row({ vision: { brand_safe: false } }), CTX)).toBe("brand_unsafe");
    expect(ineligibleReason(row({ vision: { content_flags: { sexual: true } } }), CTX)).toBe("brand_unsafe");
    expect(ineligibleReason(row({ vision: { disposition: "reject" } }), CTX)).toBe("rejected_by_tagger");
    const r = row();
    expect(ineligibleReason(r, { ...CTX, used: new Set([r.id]) })).toBe("used_in_another_post");
    expect(ineligibleReason(clip(20, []), CTX)).toBeNull();
    expect(ineligibleReason(clip(20, [], undefined, { durationSeconds: null }), CTX)).toBe("clip_length_unknown");
  });

  it("a never-use name anywhere in the tagger's text (description, brands, a beat) keeps the row out", () => {
    const ctx = { ...CTX, neverTerms: ["Pat Private"] };
    expect(ineligibleReason(row({ vision: { description: "the athlete with Pat Private at the park" } }), ctx)).toBe("never_term");
    expect(ineligibleReason(clip(10, [[0, 4, "Pat Private waves"]]), ctx)).toBe("never_term");
    expect(ineligibleReason(row({ vision: { description: "the athlete at the park" } }), ctx)).toBeNull();
  });

  it("on a partner post, a photo showing another sportswear brand is out; the partner's own mark is fine", () => {
    // The caster's closed sportswear list (studio/agent/brands.ts), read rather than named here.
    const partner = SPORTSWEAR_BRANDS[0].name;
    const avoid = brandsToAvoid(partner);
    expect(avoid.length).toBe(SPORTSWEAR_BRANDS.length - 1);
    const rival = avoid[0].name;
    expect(ineligibleReason(row({ vision: { brands_visible: [rival] } }), { ...CTX, avoidBrands: avoid })).toBe("conflicting_brand");
    expect(ineligibleReason(row({ vision: { brands_visible: [partner] } }), { ...CTX, avoidBrands: avoid })).toBeNull();
    // No partner named: a mark in frame is not a reason on its own.
    expect(ineligibleReason(row({ vision: { brands_visible: [rival] } }), CTX)).toBeNull();
  });
});

describe("segments and clip ranges", () => {
  it("a clip's segments are its described beats; else the spans between its camera cuts; a photo has none", () => {
    expect(segmentsOf(clip(10, [[0, 3, "warm-up"], [3, 7, "the sprint"]]))).toEqual([
      { startSec: 0, endSec: 3, from: "beat", what: "warm-up" }, { startSec: 3, endSec: 7, from: "beat", what: "the sprint" },
    ]);
    expect(segmentsOf(clip(10, [], [4, 4.8, 8]))).toEqual([
      { startSec: 0, endSec: 4, from: "shot", what: "" }, { startSec: 4.8, endSec: 8, from: "shot", what: "" }, { startSec: 8, endSec: 10, from: "shot", what: "" },
    ]); // the 0.8 s sliver between two cuts is no segment
    expect(segmentsOf(clip(10))).toEqual([]);
    expect(segmentsOf(row())).toEqual([]);
  });

  it("the chosen beat is the range; with none chosen, the first segment; with no segments, the opening", () => {
    const c = clip(10, [[0, 3, "warm-up"], [3, 7, "the sprint"]]);
    expect(clipRangeFor(c, segmentsOf(c)[1])).toEqual({ startSec: 3, endSec: 7, from: "beat" });
    expect(clipRangeFor(c, null)).toEqual({ startSec: 0, endSec: 3, from: "beat" });
    expect(clipRangeFor(clip(8), null)).toEqual({ startSec: 0, endSec: 8, from: "opening" });
  });

  it("a long video is cut, never posted whole: an unsegmented 10-minute clip opens on MAX_CLIP_SEC; a long beat is capped", () => {
    expect(clipRangeFor(clip(600), null)).toEqual({ startSec: 0, endSec: POST_KIT.MAX_CLIP_SEC, from: "opening" });
    const long = clip(600, [[120, 300, "a long rally"]]);
    expect(clipRangeFor(long, segmentsOf(long)[0])).toEqual({ startSec: 120, endSec: 120 + POST_KIT.MAX_CLIP_SEC, from: "beat" });
  });

  it("a beat edge near a camera cut lands on the cut — the caster's own snap, under STUDIO_SHOT_DETECT only", () => {
    const c = clip(10, [[0, 3.2, "warm-up"], [3.2, 7, "the sprint"]], [3.5, 9]);
    expect(clipRangeFor(c, segmentsOf(c)[1])).toEqual({ startSec: 3.2, endSec: 7, from: "beat" });
    process.env.STUDIO_SHOT_DETECT = "true";
    expect(clipRangeFor(c, segmentsOf(c)[1])).toEqual({ startSec: 3.5, endSec: 7, from: "beat" });
  });

  it("a cut shorter than MIN_CLIP_SEC is stretched when the clip allows, and never runs past the clip", () => {
    const c = clip(10, [[2, 2.4, "a blink"]]);
    expect(clipRangeFor(c, segmentsOf(c)[0])).toEqual({ startSec: 2, endSec: 2 + POST_KIT.MIN_CLIP_SEC, from: "beat" });
    const end = clip(5, [[4.5, 5, "the last frames"]]);
    expect(clipRangeFor(end, segmentsOf(end)[0])).toEqual({ startSec: 5 - POST_KIT.MIN_CLIP_SEC, endSec: 5, from: "beat" });
  });

  it("a video post fits TOTAL_MAX_SEC: the later clips give up seconds first, none below MIN_CLIP_SEC", () => {
    const assets = [
      { assetId: "a", mediaType: "clip" as const, clip: { startSec: 0, endSec: 12, from: "beat" as const }, durationSec: 20, provenance: "camera" as const },
      { assetId: "b", mediaType: "clip" as const, clip: { startSec: 0, endSec: 12, from: "beat" as const }, durationSec: 20, provenance: "camera" as const },
      { assetId: "c", mediaType: "photo" as const, clip: null, durationSec: null, provenance: "camera" as const },
      { assetId: "d", mediaType: "clip" as const, clip: { startSec: 0, endSec: 12, from: "beat" as const }, durationSec: 20, provenance: "camera" as const },
    ];
    // 38 s into 20: the last clip gives all it can (down to MIN_CLIP_SEC), the photo holds, the clip before gives the rest.
    const fitted = fitToTotal(assets, 2, 20);
    const total = [...fitted.values()].reduce((n, r) => n + r.endSec - r.startSec, 0) + 2;
    expect(total).toBe(20);
    expect(fitted.get("a")!.endSec).toBe(12);
    expect(fitted.get("d")!.endSec).toBe(POST_KIT.MIN_CLIP_SEC);
    expect(fitted.get("b")!.endSec).toBe(20 - 2 - 12 - POST_KIT.MIN_CLIP_SEC);
    // A cut that already fits comes back as it was.
    expect(fitToTotal(assets, 2, 60).get("d")).toEqual({ startSec: 0, endSec: 12, from: "beat" });
  });
});

describe("the re-rank's answer", () => {
  const c1 = row(); const c2 = clip(10, [[0, 3, "warm-up"], [3, 7, "the sprint"]]); const c3 = row();
  const refs = new Map([["C1", c1], ["C2", c2], ["C3", c3]]);

  it("keeps only refs it was shown, each once, at most max picks; a segment only when the clip has it", () => {
    const a = parseMatch({
      picks: [{ ref: "c2", segment: "S1", reason: "r" }, { ref: "C9", segment: "", reason: "r" }, { ref: "C2", segment: "", reason: "dup" }, { ref: "C1", segment: "S4", reason: "r" }, { ref: "C3", segment: "", reason: "r" }],
      none_fit: false, none_fit_reason: "", look_preset: "warm", music_mood: "driving",
    }, refs, 2);
    expect(a.picks.map((p) => [p.row.id, p.segment?.startSec ?? null])).toEqual([[c2.id, 3], [c1.id, null]]);
    expect(a).toMatchObject({ noneFit: false, noneFitNote: null, look: "warm", musicMood: "driving" });
  });

  it("an unknown look reads natural, an unknown or 'none' mood reads no music; no picks is 'none fit' with the model's note", () => {
    const a = parseMatch({ picks: [], none_fit: true, none_fit_reason: "Needs a portrait at the venue.", look_preset: "sepia", music_mood: "none" }, refs, 3);
    expect(a).toMatchObject({ picks: [], noneFit: true, noneFitNote: "Needs a portrait at the venue.", look: "natural", musicMood: null });
    expect(parseMatch("not json", refs, 3)).toMatchObject({ picks: [], noneFit: true, look: "natural", musicMood: null });
  });

  it("the re-rank is shown the tagger's text and a clip's segments under C- and S-refs — never an asset id", () => {
    const { refs: r, lines } = candidateInput([c1, c2]);
    expect([...r.keys()]).toEqual(["C1", "C2"]);
    expect(lines[1]).toMatchObject({ ref: "C2", kind: "clip", duration_sec: 10, segments: [{ ref: "S0", start_sec: 0, end_sec: 3, what: "warm-up" }, { ref: "S1", start_sec: 3, end_sec: 7, what: "the sprint" }] });
    expect(JSON.stringify(lines)).not.toContain(c1.id);
  });
});

describe("the treatment plan", () => {
  const look = { lookPreset: "natural" as const, musicMood: "hype" };

  it("a reel: 9:16, filled, in order, each clip trimmed, each photo held, the hook over the opening, the cover inside the first cut", () => {
    const c = clip(10, [[2, 6, "the sprint"]]);
    const p = row();
    const { treatment, assets } = treatmentFor("reel", [
      { assetId: c.id, mediaType: "clip", clip: clipRangeFor(c, null), durationSec: 10, provenance: "camera" },
      { assetId: p.id, mediaType: "photo", clip: null, durationSec: null, provenance: "camera" },
    ], look, "The work nobody sees.", []);
    expect(treatment).toEqual({
      aspect: "9:16", cropToFill: true, order: [c.id, p.id],
      trims: [{ assetId: c.id, startSec: 2, endSec: 6 }], stills: [{ assetId: p.id, holdSec: DEFAULT_STILL_SEC }],
      overlayText: "The work nobody sees.", lookPreset: "natural", musicMood: "hype",
      coverFrame: { assetId: c.id, atSec: 3 }, totalSec: 4 + DEFAULT_STILL_SEC,
    });
    expect(assets[0].clip).toEqual({ startSec: 2, endSec: 6, from: "beat" });
  });

  it("only photos still make a reel: every photo is a held still and the cut has a length", () => {
    const ps = [row(), row(), row()];
    const { treatment } = treatmentFor("reel", ps.map((p) => ({ assetId: p.id, mediaType: "photo" as const, clip: null, durationSec: null, provenance: "camera" as const })), look, "Hook", []);
    expect(treatment).toMatchObject({ trims: [], stills: ps.map((p) => ({ assetId: p.id, holdSec: DEFAULT_STILL_SEC })), totalSec: 3 * DEFAULT_STILL_SEC, coverFrame: { assetId: ps[0].id, atSec: null } });
  });

  it("a feed post or carousel: 4:5, no holds, no overlay, no running length", () => {
    const p = row();
    const { treatment } = treatmentFor("carousel", [{ assetId: p.id, mediaType: "photo", clip: null, durationSec: null, provenance: "camera" }], look, "Hook", []);
    expect(treatment).toMatchObject({ aspect: "4:5", stills: [], overlayText: null, totalSec: null });
  });

  it("a hook carrying a never-use name is never laid over the picture", () => {
    const p = row();
    const { treatment } = treatmentFor("reel", [{ assetId: p.id, mediaType: "photo", clip: null, durationSec: null, provenance: "camera" }], look, "Big day with Pat Private", ["Pat Private"]);
    expect(treatment.overlayText).toBeNull();
  });

  it("the format follows the moment when it set one; else the picks: any clip a reel, 2+ photos a carousel, one a feed post", () => {
    expect(formatFor(spec({ formatFixed: true, idea: { ...spec().idea, format: "story" } }), ["photo"])).toBe("story");
    expect(formatFor(spec(), ["photo", "clip"])).toBe("reel");
    expect(formatFor(spec(), ["photo", "photo"])).toBe("carousel");
    expect(formatFor(spec(), ["photo"])).toBe("feed");
  });
});

describe("the kit", () => {
  it("built from picks: real footage, the shortlist without the picks, aiGenerationNeeded false with its reason", () => {
    const a = row(); const b = row(); const c = row();
    const kit = assembleKit({ spec: spec(), picks: [{ row: a, segment: null }, { row: b, segment: null }], shortlist: [a, b, c], look: "warm", musicMood: null, match: MATCH, eligibleCount: 3, neverTerms: [], now: NOW });
    expect(kit).toMatchObject({
      contract: "post-kit/1", idea: { format: "carousel" }, shortlist: [c.id],
      aiGenerationNeeded: { value: false, reason: AI_REASONS.realFootage }, builtAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    expect(kit.assets.map((x) => x.assetId)).toEqual([a.id, b.id]);
  });

  it("a feed post holds one picture, whatever was picked", () => {
    const a = row(); const b = row();
    const s = spec({ formatFixed: true, idea: { ...spec().idea, format: "feed" } });
    expect(assembleKit({ spec: s, picks: [{ row: a, segment: null }, { row: b, segment: null }], shortlist: [a, b], look: "natural", musicMood: null, match: MATCH, eligibleCount: 2, neverTerms: [], now: NOW }).assets.map((x) => x.assetId)).toEqual([a.id]);
  });

  it("no media at all, or nothing that fits: no assets, and the generation flag up with a fixed reason (nothing is generated)", () => {
    const empty = assembleKit({ spec: spec(), picks: [], shortlist: [], look: "natural", musicMood: null, match: { ...MATCH, runId: null, candidates: 0 }, eligibleCount: 0, neverTerms: [], now: NOW });
    expect(empty).toMatchObject({ assets: [], aiGenerationNeeded: { value: true, reason: AI_REASONS.emptyLibrary }, treatmentPlan: { order: [], trims: [], stills: [], coverFrame: null } });
    const noneFit = assembleKit({ spec: spec(), picks: [], shortlist: [row()], look: "natural", musicMood: null, match: MATCH, eligibleCount: 1, neverTerms: [], now: NOW });
    expect(noneFit.aiGenerationNeeded).toEqual({ value: true, reason: AI_REASONS.noneFit });
  });

  it("swap: the new asset takes the old one's place, the old one goes to the front of the shortlist, the treatment follows", () => {
    const a = clip(10, [[1, 5, "x"]]); const b = row(); const c = clip(30, [[10, 14, "y"]]);
    const s = spec({ formatFixed: true, idea: { ...spec().idea, format: "reel" } });
    const kit = assembleKit({ spec: s, picks: [{ row: a, segment: null }, { row: b, segment: null }], shortlist: [a, b, c], look: "warm", musicMood: "hype", match: MATCH, eligibleCount: 3, neverTerms: [], now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const swapped = swapInKit(kit, a.id, c, [], later);
    expect(swapped.assets.map((x) => x.assetId)).toEqual([c.id, b.id]);
    expect(swapped.assets[0].clip).toEqual({ startSec: 10, endSec: 14, from: "beat" });
    expect(swapped.shortlist).toEqual([a.id]);
    expect(swapped.treatmentPlan).toMatchObject({ order: [c.id, b.id], trims: [{ assetId: c.id, startSec: 10, endSec: 14 }], lookPreset: "warm", musicMood: "hype", coverFrame: { assetId: c.id } });
    expect(swapped.updatedAt).toBe(later.toISOString());
    expect(() => swapInKit(kit, "not-in-kit", c, [], later)).toThrow(/not in the kit/);
  });

  it("caption: the athlete's words, trimmed and capped, tags listed, marked edited", () => {
    const kit = assembleKit({ spec: spec(), picks: [{ row: row(), segment: null }], shortlist: [], look: "natural", musicMood: null, match: MATCH, eligibleCount: 1, neverTerms: [], now: NOW });
    const edited = withCaption(kit, "  New words #mine  ", NOW);
    expect(edited.caption).toEqual({ text: "New words #mine", hashtags: ["#mine"], edited: true });
    expect(withCaption(kit, "x".repeat(POST_KIT.CAPTION_CHARS + 10), NOW).caption.text).toHaveLength(POST_KIT.CAPTION_CHARS);
  });

  it("a feed post the moment set is a photo: a picked clip is left out of it", () => {
    const c = clip(10, [[0, 4, "x"]]); const p = row();
    const s = spec({ formatFixed: true, idea: { ...spec().idea, format: "feed" } });
    const kit = assembleKit({ spec: s, picks: [{ row: c, segment: null }, { row: p, segment: null }], shortlist: [c, p], look: "natural", musicMood: null, match: MATCH, eligibleCount: 2, neverTerms: [], now: NOW });
    expect(kit).toMatchObject({ formatFromMoment: true, idea: { format: "feed" } });
    expect(kit.assets.map((a) => a.assetId)).toEqual([p.id]);
    expect(fitsFormat("feed", "clip")).toBe(false);
    for (const f of ["reel", "story", "carousel"] as const) expect([f, fitsFormat(f, "clip"), fitsFormat(f, "photo")]).toEqual([f, true, true]);
  });

  it("swap: a format the picks made follows the new set; one the moment set refuses an asset that does not fit", () => {
    const p = row(); const c = clip(10, [[1, 5, "x"]]); const q = row();
    const free = assembleKit({ spec: spec(), picks: [{ row: p, segment: null }], shortlist: [p, c, q], look: "natural", musicMood: null, match: MATCH, eligibleCount: 3, neverTerms: [], now: NOW });
    expect(free).toMatchObject({ formatFromMoment: false, idea: { format: "feed" }, treatmentPlan: { aspect: "4:5" } });
    expect(swapInKit(free, p.id, c, [], NOW)).toMatchObject({ idea: { format: "reel" }, treatmentPlan: { aspect: "9:16", totalSec: 4 } });
    const fixed = { ...free, formatFromMoment: true };
    expect(() => swapInKit(fixed, p.id, c, [], NOW)).toThrow(FormatMismatch);
    expect(swapInKit(fixed, p.id, q, [], NOW)).toMatchObject({ idea: { format: "feed" }, assets: [{ assetId: q.id }] });
    expect(formatOfPicks(["photo", "photo"])).toBe("carousel");
  });

  it("refs rebuilt from a run's evidence keep their original numbers; a row gone or no longer kept is unmapped", () => {
    const a = row(); const b = row(); const c = row();
    const refs = refsInOrder([a.id, b.id, c.id], new Map([[a.id, a], [c.id, c]]), "C", (r) => r.id !== c.id);
    expect([...refs].map(([k, r]) => [k, r.id])).toEqual([["C1", a.id]]);
  });

  it("the look presets are the fixed list the skill names", () => {
    expect(LOOK_PRESETS).toEqual(["natural", "warm", "cool", "vivid", "muted", "mono"]);
  });
});
