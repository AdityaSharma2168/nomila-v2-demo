/**
 * build.test.ts — Track E builds a post kit on a plan action's own decision row (agent/postKit/build.ts), against the
 * in-memory store, an in-memory library port and a fake Gemini client (no provider, no database).
 *
 *   B1  a kit: the re-rank's picks in order, a clip's seconds from the segment it named, the rest as the shortlist, the
 *       treatment plan, the caption from the plan's deliverable; the action moves to_start → made with studioItemId =
 *       its own id; one post-kit/match run on the cheap tier, its evidence the candidates
 *   B2  a moment: the action's event fact → the moment decision; its idea leads and its format sets the search
 *   B3  edge cases: no media (no call; the generation flag up; the action stays to_start), only photos (a reel of held
 *       stills), brand-unsafe / made-here / meta / not-the-athlete / never-use rows never reach the model, a rival
 *       brand on a partner post, an asset already in another kit
 *   B4  guards: another athlete's action is not found; not a post, answered, already made; never-content held; the
 *       caps (week count, week spend, day spend) refuse before any call; a retried step never pays twice
 *   B5  the plan workflow's step: goal actions only, at most MAX_PER_RUN, soonest first, one failure never stops the rest
 *   B6  C1, prepared before Keep: the next HELD_PER_RUN dated posts held for a recommendation still waiting are built too
 *   B7  the plan's idea leads the kit (format, shot list); a carousel takes up to ten, a reel or story three
 *   B8  the final guard on the words that ship, after the copy pass: a rewrite with a never-use name falls back to the
 *       plan's copy; blocked twice → held, the hold recorded; the plan workflow AND Build it answer from it (free, not
 *       counted, not re-told) until its inputs change; a paid hold takes a run slot; a number no source holds comes out
 *       (every active fact counts, never a disputed one); stored copy options guarded; #ad at the start only when the
 *       partner or a brand the words name matches a deal / gift / affiliate record, else "ask"; the guard runs
 *       without the copy pass too; round 3: the hold key fingerprints every active fact, the deal records and the event
 *       date; a Build it tap retries a hold older than HOLD_RETRY_MS
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));
// The copy pass is a model call: stood in (COPYWRITER_V1 is off unless a test sets it).
jest.mock("../../services/copywriter", () => ({ polishPostCopy: jest.fn() }));

import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import { SPORTSWEAR_BRANDS } from "../../studio/agent/brands";
import type { CastableRow } from "../../studio/agent/cast";
import { MUSIC_CATALOGUE } from "../../studio/music/find";
import { DEFAULT_STILL_SEC } from "../../studio/video/spec";
import { setGeminiClient } from "../geminiProvider";
import { setResponsesTransport } from "../research/llm";
import { createMemoryStore, type AgentStore } from "../research/store";
import { buildPendingPostKits, buildPostKit, HOLD_RETRY_MS, holdInputsKey, PostKitError, type PostKitDeps } from "./build";
import { MATCH_SKILL_ID, POST_KIT } from "./config";
import { AI_REASONS } from "./kit";
import { GUARD_VERSION } from "./finalGuard";
import { clip, fakeGemini, fakeMedia, postAction, refsWith, row } from "./testRows";
import { polishPostCopy } from "../../services/copywriter";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date();

let store: AgentStore;
let library: Map<string, CastableRow[]>;
let prefs: Array<{ kind: string; statement: string; status: string }>;

function deps(over: Partial<PostKitDeps> = {}): PostKitDeps & { calls: ReturnType<typeof fakeMedia>["calls"] } {
  const { media, calls } = fakeMedia(library);
  return { store, media, preferences: async () => prefs as never, now: NOW, calls, ...over };
}

async function action(detail: ActionDecisionDetail = postAction(), over: { goalId?: string | null; parentDecisionId?: string | null; athleteId?: string } = {}) {
  const goalId = over.goalId === undefined ? (await store.insertGoal(over.athleteId ?? A, { text: "Grow my audience", source: "said", decisionId: null })).id : over.goalId;
  return store.insertDecision(over.athleteId ?? A, {
    runId: null, skillId: "plan", kind: "action", suggested: detail.what, why: "Why now.", evidence: [],
    detail: detail as unknown as Record<string, unknown>, goalId, parentDecisionId: over.parentDecisionId ?? null,
  });
}

const kitOf = async (id: string, athleteId = A) => ((await store.getDecision(athleteId, id))!.detail as unknown as ActionDecisionDetail);

/** The re-rank: picks the candidates whose description has `words`, in that order, with a segment for clips. */
const pickBy = (...words: string[]) => (input: any) => ({
  picks: words.flatMap((w) => refsWith(input.candidates, w)).map((ref) => ({ ref, segment: input.candidates.find((c: any) => c.ref === ref).segments.length ? "S1" : "", reason: "fits" })),
  none_fit: false, none_fit_reason: "", look_preset: "warm", music_mood: "driving",
});

beforeEach(() => {
  store = createMemoryStore();
  library = new Map();
  prefs = [];
  setResponsesTransport({ create: async () => { throw new Error("the post-kit skills never call OpenAI"); } });
});
afterEach(() => { setGeminiClient(null); setResponsesTransport(null); });

describe("B1: a post kit on the action's own row", () => {
  it("picks, clip seconds, shortlist, treatment, caption; to_start → made; one cheap-tier run", async () => {
    const sprint = clip(30, [[0, 4, "warm-up laps"], [4, 9, "the athlete sprinting the final bend"]], undefined, { vision: { description: "the athlete sprinting on the track" } });
    const portrait = row({ vision: { description: "the athlete smiling after the session" } });
    const other = row({ vision: { description: "the athlete stretching on the grass" } });
    library.set(A, [sprint, portrait, other]);
    const calls = fakeGemini(pickBy("sprinting", "smiling"));
    const d = await action(postAction({ dueOn: "2026-10-15" }));

    const out = await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect(out).toMatchObject({ status: "built", decisionId: d.id, assets: 2, aiGenerationNeeded: false, costMicroUsd: 4800 });

    const det = await kitOf(d.id);
    expect(det.state).toBe("made");
    expect(det.prepared!.studioItemId).toBe(d.id);
    const kit = det.prepared!.postKit as PostKit;
    expect(kit.assets).toEqual([
      { assetId: sprint.id, mediaType: "clip", clip: { startSec: 4, endSec: 9, from: "beat" }, durationSec: 30, provenance: "camera" },
      { assetId: portrait.id, mediaType: "photo", clip: null, durationSec: null, provenance: "camera" },
    ]);
    expect(kit.shortlist).toEqual([other.id]);
    expect(kit.idea).toMatchObject({ hook: "The work nobody sees.", format: "reel", platform: "instagram", timing: "By Thu 15 Oct" });
    expect(kit.caption).toEqual({ text: "The work nobody sees. Early sessions add up. #training #process", hashtags: ["#training", "#process"], edited: false });
    expect(kit.treatmentPlan).toEqual({
      aspect: "9:16", cropToFill: true, order: [sprint.id, portrait.id], trims: [{ assetId: sprint.id, startSec: 4, endSec: 9 }],
      stills: [{ assetId: portrait.id, holdSec: DEFAULT_STILL_SEC }], overlayText: "The work nobody sees.", lookPreset: "warm",
      musicMood: "driving", coverFrame: { assetId: sprint.id, atSec: 5 }, totalSec: 5 + DEFAULT_STILL_SEC,
    });
    expect(kit.aiGenerationNeeded).toEqual({ value: false, reason: AI_REASONS.realFootage });
    expect(kit.match).toMatchObject({ skillVersion: "1.0.0", candidates: 3, costMicroUsd: 4800, noneFitNote: null });

    expect(calls.map((c) => c.skillId)).toEqual([MATCH_SKILL_ID]);
    expect(calls[0].input.post).toMatchObject({ hook: "The work nobody sees.", show: "a sprint start, a hard rep, the walk back." });
    expect(JSON.stringify(calls[0].input)).not.toContain(sprint.id); // the model sees C-refs, never an asset id
    const [run] = await store.listRunsSince(A, { since: new Date(0).toISOString(), skillId: MATCH_SKILL_ID });
    expect(run).toMatchObject({ status: "completed", trigger: "event", model: { provider: "gemini" } });
    expect(run.evidenceRead).toEqual([sprint, portrait, other].map((r) => ({ kind: "record", table: "media_assets", id: r.id })));
  });
});

describe("B1m: music choices (AGENT_POST_KIT_MUSIC_CHOICES)", () => {
  afterEach(() => { delete process.env.AGENT_POST_KIT_MUSIC_CHOICES; delete process.env.STUDIO_MUSIC_LIBRARY_READY; });
  const reelLibrary = () => [
    clip(30, [[0, 4, "warm-up laps"], [4, 9, "the athlete sprinting the final bend"]], undefined, { vision: { description: "the athlete sprinting on the track" } }),
    row({ vision: { description: "the athlete smiling after the session" } }),
  ];

  it("off: the kit has no music block — exactly as before", async () => {
    library.set(A, reelLibrary());
    fakeGemini(pickBy("sprinting", "smiling"));
    const d = await action(postAction());
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect((await kitOf(d.id)).prepared!.postKit!.music).toBeUndefined();
  });

  it("on: three tracks for the mood the re-rank named, the first in use; a brand post's are all brand-safe", async () => {
    process.env.AGENT_POST_KIT_MUSIC_CHOICES = "true";
    process.env.STUDIO_MUSIC_LIBRARY_READY = "true";
    library.set(A, reelLibrary());
    fakeGemini(pickBy("sprinting", "smiling"));
    const d = await action(postAction());
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const music = (await kitOf(d.id)).prepared!.postKit!.music!;
    expect(music.choices).toHaveLength(3);
    // The default avoids a Content ID claim: the first choice not registered, else the first.
    expect(music.selected).toBe((music.choices.find((c) => c.contentIdRegistered !== true) ?? music.choices[0]).trackId);
    for (const c of music.choices) expect(MUSIC_CATALOGUE[c.trackId].moods).toContain("driving");

    library.set(A, reelLibrary());
    fakeGemini(pickBy("sprinting", "smiling"));
    const det = postAction();
    det.deliverable.target = { subjectKind: "brand", name: "Brand A" };
    const b = await action(det);
    await buildPostKit(deps(), A, b.id, { trigger: "event", parentRef: null });
    for (const c of (await kitOf(b.id)).prepared!.postKit!.music!.choices) expect([c.trackId, MUSIC_CATALOGUE[c.trackId].brandSafe]).toEqual([c.trackId, true]);
  });
});

describe("B2: the moment the action is timed for", () => {
  it("its idea leads, its format fixes the post, and the search puts clips first for a video format", async () => {
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Season opener" }, claim: "The season opener is on the 20th.", type: "found", source: { url: "https://example.org/schedule" }, date: "2026-10-20", confidence: 0.9, runId: null, topic: "moment" }]);
    const moment = await store.insertDecision(A, {
      runId: null, skillId: "moments", kind: "other", suggested: "Season opener", why: "w", evidence: [{ kind: "fact", factId: fact.id }],
      detail: { kind: "moment", idea: { hook: "Ten days out.", format: "story", platform: "instagram", timing: "3 days before" }, brief: { show: "game-day prep", captionAngle: "Ready", avoid: "anything staged" }, mediaNeeds: "a calm portrait" },
    });
    library.set(A, [row({ vision: { description: "a calm portrait of the athlete" } })]);
    fakeGemini(pickBy("calm portrait"));
    const d = await action(postAction({ event: { factId: fact.id, label: "Season opener", date: "2026-10-20", precision: "day" } }));
    const dp = deps();
    await buildPostKit(dp, A, d.id, { trigger: "schedule", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit).toMatchObject({ momentDecisionId: moment.id, idea: { hook: "Ten days out.", format: "story", timing: "3 days before" }, brief: { show: "game-day prep", captionAngle: "Ready", avoid: "anything staged" } });
    expect(kit.treatmentPlan.aspect).toBe("9:16");
    expect(dp.calls[0]).toMatchObject({ clipsFirst: true, k: POST_KIT.SEARCH_K });
    expect(dp.calls[0].brief).toContain("a calm portrait");
  });
});

describe("B3: edge cases", () => {
  it("no media at all: no model call, the generation flag up with its reason, the action stays to_start", async () => {
    const calls = fakeGemini(() => { throw new Error("must not be called"); });
    const d = await action();
    const out = await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect(out).toMatchObject({ status: "built", assets: 0, aiGenerationNeeded: true, costMicroUsd: 0, runId: null });
    expect(calls).toHaveLength(0);
    const det = await kitOf(d.id);
    expect(det.state).toBe("to_start");
    expect(det.prepared!.studioItemId).toBeUndefined();
    expect(det.prepared!.postKit).toMatchObject({ assets: [], shortlist: [], aiGenerationNeeded: { value: true, reason: AI_REASONS.emptyLibrary }, match: { runId: null, candidates: 0 } });
  });

  it("the library has only what can't be used: nothing reaches the model", async () => {
    library.set(A, [
      row({ vision: { brand_safe: false, description: "unsafe" } }),
      row({ vision: { content_flags: { hateful: true }, description: "flagged" } }),
      row({ provenance: "made-here", vision: { description: "made here" } }),
      row({ meta: true, vision: { description: "a screenshot" } }),
      row({ vision: { athlete_present: false, description: "an empty stadium" } }),
      row({ vision: null }),
    ]);
    const calls = fakeGemini(() => { throw new Error("must not be called"); });
    const d = await action();
    const out = await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect(out).toMatchObject({ status: "built", assets: 0, aiGenerationNeeded: true });
    expect(calls).toHaveLength(0);
  });

  it("the model finds nothing that fits: no assets, the flag up with the fixed reason, its own note kept internal", async () => {
    library.set(A, [row({ vision: { description: "the athlete at a dinner" } })]);
    fakeGemini(() => ({ picks: [], none_fit: true, none_fit_reason: "Needs training footage.", look_preset: "natural", music_mood: "none" }));
    const d = await action();
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.aiGenerationNeeded).toEqual({ value: true, reason: AI_REASONS.noneFit });
    expect(kit.match.noneFitNote).toBe("Needs training footage.");
    expect(kit.shortlist).toHaveLength(1);
  });

  it("only photos: a reel of held stills, in the model's order", async () => {
    const p1 = row({ vision: { description: "photo one of the athlete" } });
    const p2 = row({ vision: { description: "photo two of the athlete" } });
    library.set(A, [p1, p2]);
    fakeGemini(pickBy("photo two", "photo one"));
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Final" }, claim: "The final.", type: "found", source: { url: "https://example.org/f" }, date: "2026-10-30", confidence: 0.9, runId: null }]);
    await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Final", why: "w", evidence: [{ kind: "fact", factId: fact.id }], detail: { kind: "moment", idea: { format: "reel" } } });
    const d = await action(postAction({ event: { factId: fact.id, label: "Final", date: "2026-10-30", precision: "day" } }));
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.idea.format).toBe("reel");
    expect(kit.treatmentPlan).toMatchObject({ order: [p2.id, p1.id], trims: [], stills: [{ assetId: p2.id, holdSec: DEFAULT_STILL_SEC }, { assetId: p1.id, holdSec: DEFAULT_STILL_SEC }], totalSec: 2 * DEFAULT_STILL_SEC });
  });

  it("a long video is cut, not posted whole", async () => {
    const long = clip(900, [], undefined, { vision: { description: "a full session filmed end to end" } });
    library.set(A, [long]);
    fakeGemini(pickBy("full session"));
    const d = await action();
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.assets[0].clip).toEqual({ startSec: 0, endSec: POST_KIT.MAX_CLIP_SEC, from: "opening" });
    expect(kit.treatmentPlan.totalSec).toBe(POST_KIT.MAX_CLIP_SEC);
  });

  it("a never-use name in an asset's tags keeps it from the model", async () => {
    prefs = [{ kind: "avoid", statement: "Never use: Pat Private", status: "active" }];
    library.set(A, [row({ vision: { description: "the athlete with Pat Private" } }), row({ vision: { description: "the athlete alone" } })]);
    const calls = fakeGemini(pickBy("alone"));
    const d = await action();
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect(calls[0].input.candidates.map((c: any) => c.description)).toEqual(["the athlete alone"]);
  });

  it("a partner post: another sportswear brand stays out of frame — in the search and in the judging", async () => {
    const partner = SPORTSWEAR_BRANDS[0].name;
    const rival = SPORTSWEAR_BRANDS[1];
    library.set(A, [row({ vision: { description: "kit with a rival mark", brands_visible: [rival.name] } }), row({ vision: { description: "kit with the partner mark", brands_visible: [partner] } })]);
    const calls = fakeGemini(pickBy("partner mark"));
    const det = postAction();
    det.deliverable.target = { subjectKind: "brand", name: partner };
    const d = await action(det);
    const dp = deps();
    await buildPostKit(dp, A, d.id, { trigger: "event", parentRef: null });
    expect(dp.calls[0].excludeBrands).toEqual(expect.arrayContaining(rival.spellings));
    expect(calls[0].input.candidates.map((c: any) => c.description)).toEqual(["kit with the partner mark"]);
  });

  it("an asset already in another live kit is not offered again", async () => {
    const a = row({ vision: { description: "shot a" } });
    const b = row({ vision: { description: "shot b" } });
    library.set(A, [a, b]);
    fakeGemini(pickBy("shot a", "shot b"));
    const first = await action();
    await buildPostKit(deps(), A, first.id, { trigger: "event", parentRef: null });
    const calls = fakeGemini(pickBy("shot b"));
    const second = await action(postAction({ what: "Another post" }));
    await buildPostKit(deps(), A, second.id, { trigger: "event", parentRef: null });
    // Both are in the first kit: nothing is left to offer, so no call is made at all.
    expect(calls).toHaveLength(0);
    expect(((await kitOf(second.id)).prepared!.postKit as PostKit).aiGenerationNeeded.value).toBe(true);
  });
});

describe("B4: guards", () => {
  it("another athlete's action is not found; their library is never read", async () => {
    library.set(B, [row()]);
    const theirs = await action(postAction(), { athleteId: B });
    await expect(buildPostKit(deps(), A, theirs.id, { trigger: "event", parentRef: null })).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("not a post, answered or already made: refused or left alone", async () => {
    const pitch = await action({ ...postAction(), kind: "pitch" });
    await expect(buildPostKit(deps(), A, pitch.id, { trigger: "event", parentRef: null })).rejects.toBeInstanceOf(PostKitError);
    const answered = await action();
    await store.respondDecision(A, answered.id, "accepted", null);
    await expect(buildPostKit(deps(), A, answered.id, { trigger: "event", parentRef: null })).rejects.toMatchObject({ code: "answered" });
    const made = await action(postAction({ state: "made" }));
    expect(await buildPostKit(deps(), A, made.id, { trigger: "event", parentRef: null })).toEqual({ status: "exists", decisionId: made.id });
  });

  it("never-content in the post's own words: held, nothing written, no call", async () => {
    prefs = [{ kind: "avoid", statement: "Never name: Pat Private", status: "active" }];
    library.set(A, [row()]);
    const calls = fakeGemini(pickBy("athlete"));
    const det = postAction();
    det.deliverable.body = "Caption: A day out with Pat Private.\nShots: the park.";
    const d = await action(det);
    expect(await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null })).toEqual({ status: "held", decisionId: d.id, reason: "never_content" });
    expect(calls).toHaveLength(0);
    // No kit is written — only the hold, so the plan workflow does not try the same words again.
    expect((await kitOf(d.id)).prepared).toEqual({ postKitHold: { reason: "never_content", block: null, inputsKey: expect.any(String), at: expect.any(String) } });
  });

  async function pastRun(skillId: string, microUsd: number) {
    const id = await store.startRun({ athleteId: A, skillId, skillVersion: "1.0.0", trigger: "event", model: { provider: "gemini", model: "m", effort: "low" }, parentRef: null });
    await store.finishRun(A, id, { status: "completed", stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd }, steps: [], evidenceRead: [], output: null, error: null });
  }

  it("caps: kits this week, post-kit spend this week, every run's spend today — each refuses before any call", async () => {
    library.set(A, [row()]);
    const calls = fakeGemini(pickBy("athlete"));
    for (let i = 0; i < POST_KIT.MAX_PER_WEEK; i++) await pastRun(MATCH_SKILL_ID, 1);
    const d = await action();
    expect(await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null })).toEqual({ status: "skipped", decisionId: d.id, reason: "week_count" });

    store = createMemoryStore();
    await pastRun("post-kit/ideas", POST_KIT.WEEK_CAP_MICRO_USD - POST_KIT.RUN_RESERVE_MICRO_USD + 1);
    const d2 = await action();
    expect(await buildPostKit(deps(), A, d2.id, { trigger: "event", parentRef: null })).toMatchObject({ status: "skipped", reason: "week_cap" });

    store = createMemoryStore();
    await pastRun("plan", POST_KIT.DAY_CAP_MICRO_USD);
    const d3 = await action();
    expect(await buildPostKit(deps(), A, d3.id, { trigger: "event", parentRef: null })).toMatchObject({ status: "skipped", reason: "day_cap" });
    expect(calls).toHaveLength(0);
    expect((await kitOf(d3.id)).state).toBe("to_start");
  });

  it("a retried step reuses the finished model run: never pays twice, reads its picks against what that run was shown", async () => {
    const other = row({ vision: { description: "another shot" } });
    const one = row({ vision: { description: "the one" } });
    library.set(A, [other, one]);
    const calls = fakeGemini(pickBy("the one"));
    const d = await action();
    const first = await buildPostKit(deps(), A, d.id, { trigger: "schedule", parentRef: "workflow:w1:post_kit:x" });
    // A crash after the call and before the write: the row is back at to_start with nothing on it. Meanwhile the
    // library's order changed, so a fresh search would hand the same refs to other assets.
    await store.updateDecision(A, d.id, { detail: postAction() as unknown as Record<string, unknown> });
    library.set(A, [one, other]);
    const again = await buildPostKit(deps(), A, d.id, { trigger: "schedule", parentRef: "workflow:w1:post_kit:x" });
    expect(calls).toHaveLength(1);
    expect(again).toMatchObject({ status: "built", assets: 1, costMicroUsd: 0, runId: (first as { runId: string }).runId });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.assets.map((a) => a.assetId)).toEqual([one.id]);
    expect(kit.shortlist).toEqual([other.id]);
    // The kit records what the match really cost, though this attempt spent nothing.
    expect(kit.match.costMicroUsd).toBe(4800);
  });

  it("an action held for a recommended goal is refused until the goal is kept", async () => {
    library.set(A, [row()]);
    const held = await action(postAction(), { goalId: null });
    await expect(buildPostKit(deps(), A, held.id, { trigger: "event", parentRef: null })).rejects.toMatchObject({ status: 409, code: "goal_not_kept" });
  });

  it("a race: the action changes while the kit is built — the build writes nothing and says so", async () => {
    library.set(A, [row({ vision: { description: "x" } })]);
    fakeGemini(pickBy("x"));
    const d = await action();
    const { media } = fakeMedia(library);
    // While the library is searched, a plan refresh rewrites the action's words and another build marks it made.
    const racing = { ...media, search: async (...args: Parameters<typeof media.search>) => {
      const cur = (await store.getDecision(A, d.id))!.detail as unknown as ActionDecisionDetail;
      await store.updateDecision(A, d.id, { detail: { ...cur, what: "Rewritten", state: "made", prepared: { studioItemId: d.id, note: "theirs" } } as unknown as Record<string, unknown> });
      return media.search(...args);
    } };
    expect(await buildPostKit(deps({ media: racing }), A, d.id, { trigger: "event", parentRef: null })).toEqual({ status: "conflict", decisionId: d.id });
    expect((await kitOf(d.id))).toMatchObject({ what: "Rewritten", state: "made", prepared: { note: "theirs" } });
    expect((await kitOf(d.id)).prepared!.postKit).toBeUndefined();
  });

  it("a race at the write itself: the conditional update refuses a row that moved after the re-read", async () => {
    library.set(A, [row({ vision: { description: "x" } })]);
    fakeGemini(pickBy("x"));
    const d = await action();
    const real = store;
    let reads = 0;
    // The second read of the row (the re-read before the write) is followed at once by someone else's write.
    store = { ...real, getDecision: async (a: string, id: string) => {
      const got = await real.getDecision(a, id);
      if (id === d.id && ++reads === 2) await real.updateDecision(a, id, { detail: { ...(got!.detail as object), what: "Moved" } as Record<string, unknown> });
      return got;
    } };
    expect(await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null })).toEqual({ status: "conflict", decisionId: d.id });
    store = real;
    expect(await kitOf(d.id)).toMatchObject({ what: "Moved", state: "to_start" });
    expect((await kitOf(d.id)).prepared).toBeUndefined();
  });

  it("a fresh write merges into the row's own prepared fields rather than replacing them", async () => {
    library.set(A, [row({ vision: { description: "x" } })]);
    fakeGemini(pickBy("x"));
    const d = await action(postAction({ prepared: { approvalNote: "kept" } }));
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect((await kitOf(d.id)).prepared).toMatchObject({ approvalNote: "kept", studioItemId: d.id, postKit: { contract: "post-kit/1" } });
  });
});

describe("B5: the plan workflow's post_kits step", () => {
  it("builds goal actions still to start, soonest first, at most MAX_PER_RUN; held and other kinds wait", async () => {
    library.set(A, [row({ vision: { description: "x" } })]);
    fakeGemini(pickBy("x"));
    const due = ["2026-10-20", "2026-10-14", null, "2026-10-16"];
    const ids: string[] = [];
    for (const dueOn of due) ids.push((await action(postAction({ what: `post ${dueOn}`, dueOn }))).id);
    const held = await action(postAction({ what: "held" }), { goalId: null, parentDecisionId: (await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "g", why: "w", evidence: [] })).id });
    await action({ ...postAction({ what: "pitch" }), kind: "pitch" });
    const out = await buildPendingPostKits(deps(), A, { parentRef: "workflow:w2:post_kit", trigger: "schedule" });
    expect(out.built).toBe(3);
    expect(out.built).toBe(POST_KIT.MAX_PER_RUN);
    expect(out.failed).toBe(0);
    const tried = (await Promise.all(ids.map(async (id) => [id, !!(await kitOf(id)).prepared?.postKit] as const))).filter(([, t]) => t).map(([id]) => id);
    // Soonest first: the 14th, the 16th, the 20th; the undated one waits.
    expect(tried).toEqual([ids[0], ids[1], ids[3]]);
    expect((await kitOf(held.id)).prepared).toBeUndefined();
  });

  it("one kit failing never stops the others", async () => {
    library.set(A, [row({ vision: { description: "x" } })]);
    fakeGemini(pickBy("x"));
    const a = await action(postAction({ what: "first", dueOn: "2026-10-12" }));
    const b = await action(postAction({ what: "second", dueOn: "2026-10-13" }));
    const { media } = fakeMedia(library);
    let n = 0;
    const flaky = { ...media, search: async (...args: Parameters<typeof media.search>) => { if (n++ === 0) throw new Error("search down"); return media.search(...args); } };
    const out = await buildPendingPostKits(deps({ media: flaky }), A, { parentRef: "workflow:w3:post_kit", trigger: "schedule" });
    expect(out).toMatchObject({ built: 1, failed: 1 });
    expect((await kitOf(a.id)).prepared).toBeUndefined();
    expect((await kitOf(b.id)).state).toBe("made");
  });

  it("an action held for its words takes no slot: the next ones are still built", async () => {
    prefs = [{ kind: "avoid", statement: "Never use: Pat Private", status: "active" }];
    library.set(A, [row({ vision: { description: "x1" } }), row({ vision: { description: "x2" } }), row({ vision: { description: "x3" } })]);
    fakeGemini((input) => ({ picks: input.candidates.slice(0, 1).map((c: any) => ({ ref: c.ref, segment: "", reason: "r" })), none_fit: false, none_fit_reason: "", look_preset: "natural", music_mood: "none" }));
    const heldDet = postAction({ what: "held", dueOn: "2026-10-12" });
    heldDet.deliverable.body = "Caption: With Pat Private.\nShots: x.";
    await action(heldDet);
    const ids: string[] = [];
    for (const dueOn of ["2026-10-13", "2026-10-14", "2026-10-15"]) ids.push((await action(postAction({ what: `post ${dueOn}`, dueOn }))).id);
    const out = await buildPendingPostKits(deps(), A, { parentRef: "workflow:w4:post_kit", trigger: "schedule" });
    expect(out).toMatchObject({ built: 3, failed: 0, skipped: { never_content: 1 } });
    for (const id of ids) expect((await kitOf(id)).state).toBe("made");
  });

  it("an empty kit is tried again once new usable media is tagged after it was built — and not before", async () => {
    const d = await action();
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const empty = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(empty.assets).toEqual([]);
    const calls = fakeGemini(pickBy("fresh"));
    // Nothing new: the empty kit is left alone, no call.
    expect(await buildPendingPostKits(deps(), A, { parentRef: "workflow:w5:post_kit", trigger: "schedule" })).toMatchObject({ built: 0 });
    // Unusable new media changes nothing either.
    const later = new Date(Date.parse(empty.builtAt) + 60_000).toISOString();
    library.set(A, [row({ provenance: "made-here", vision: { description: "fresh but made here" } })]);
    const tagged = { taggedAt: () => later };
    expect(await buildPendingPostKits({ ...deps(), media: fakeMedia(library, tagged).media }, A, { parentRef: "workflow:w6:post_kit", trigger: "schedule" })).toMatchObject({ built: 0 });
    // A usable photo tagged after the build: the kit is rebuilt and the action is made.
    library.set(A, [row({ vision: { description: "a fresh photo of the athlete" } })]);
    expect(await buildPendingPostKits({ ...deps(), media: fakeMedia(library, tagged).media }, A, { parentRef: "workflow:w7:post_kit", trigger: "schedule" })).toMatchObject({ built: 1 });
    expect((await kitOf(d.id)).state).toBe("made");
    expect(calls).toHaveLength(1);
  });
});

describe("B6: C1, prepared before Keep — the next timely posts held for a recommendation still waiting", () => {
  const recommendation = async (response: "pending" | "skipped" = "pending") => {
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "A post before every home race", why: "w", evidence: [] });
    if (response !== "pending") await store.respondDecision(A, d.id, response, null);
    return d;
  };

  it("builds at most HELD_PER_RUN dated held posts, soonest first, after the kept goals' own; undated or answered ones wait", async () => {
    library.set(A, [1, 2, 3, 4].map((n) => row({ vision: { description: `x${n}` } })));
    fakeGemini((input) => ({ picks: input.candidates.slice(0, 1).map((c: any) => ({ ref: c.ref, segment: "", reason: "r" })), none_fit: false, none_fit_reason: "", look_preset: "natural", music_mood: "none" }));
    const rec = await recommendation();
    const skipped = await recommendation("skipped");
    const kept = await action(postAction({ what: "kept", dueOn: "2026-10-20" }));
    const held: string[] = [];
    for (const dueOn of ["2026-10-19", "2026-10-15", "2026-10-17"]) held.push((await action(postAction({ what: `held ${dueOn}`, dueOn }), { goalId: null, parentDecisionId: rec.id })).id);
    const undated = await action(postAction({ what: "held undated" }), { goalId: null, parentDecisionId: rec.id });
    const onSkipped = await action(postAction({ what: "held on a skipped one", dueOn: "2026-10-12" }), { goalId: null, parentDecisionId: skipped.id });
    const out = await buildPendingPostKits(deps(), A, { parentRef: "workflow:c1:post_kit", trigger: "schedule" });
    expect(POST_KIT.HELD_PER_RUN).toBe(2);
    expect(out).toMatchObject({ built: 3, failed: 0 });
    expect((await kitOf(kept.id)).state).toBe("made");
    // The 15th and the 17th: the two soonest held; the 19th, the undated one and the skipped recommendation's wait.
    expect(await Promise.all(held.map(async (id) => (await kitOf(id)).state))).toEqual(["to_start", "made", "made"]);
    expect((await kitOf(undated.id)).prepared).toBeUndefined();
    expect((await kitOf(onSkipped.id)).prepared).toBeUndefined();
    // Still held: the action is not moved onto any goal by being prepared.
    expect((await store.getDecision(A, held[1]))).toMatchObject({ goalId: null, parentDecisionId: rec.id, response: "pending" });
  });

  it("a direct build of a held action is still refused unless the step allows it, and only while its recommendation waits", async () => {
    library.set(A, [row({ vision: { description: "x" } })]);
    fakeGemini(pickBy("x"));
    const rec = await recommendation();
    const held = await action(postAction({ dueOn: "2026-10-14" }), { goalId: null, parentDecisionId: rec.id });
    await expect(buildPostKit(deps(), A, held.id, { trigger: "event", parentRef: null })).rejects.toMatchObject({ code: "goal_not_kept" });
    expect(await buildPostKit(deps(), A, held.id, { trigger: "event", parentRef: null, allowHeld: true })).toMatchObject({ status: "built" });
    const gone = await recommendation("skipped");
    const orphan = await action(postAction({ dueOn: "2026-10-14" }), { goalId: null, parentDecisionId: gone.id });
    await expect(buildPostKit(deps(), A, orphan.id, { trigger: "event", parentRef: null, allowHeld: true })).rejects.toMatchObject({ code: "goal_not_kept" });
  });
});

describe("B7: the plan picks the format and the shot list; a carousel holds up to ten", () => {
  it("the plan's idea leads the kit (format, what it shows); a carousel takes up to MAX_ASSETS (10) of her photos", async () => {
    const photos = Array.from({ length: 12 }, (_, i) => row({ vision: { description: `x photo ${i + 1}` } }));
    library.set(A, photos);
    const calls = fakeGemini((input) => ({ picks: input.candidates.map((c: any) => ({ ref: c.ref, segment: "", reason: "fits" })), none_fit: false, none_fit_reason: "", look_preset: "natural", music_mood: "none" }));
    const d = await action(postAction({ post: { hook: "Ten from the season.", format: "carousel", show: "A photo from each race.", captionAngle: "The season so far.", avoid: "", mediaNeeds: "ten photos" } }));
    expect(await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null })).toMatchObject({ status: "built", assets: 10 });
    expect(POST_KIT.MAX_ASSETS).toBe(10);
    expect(calls[0].input.max_picks).toBe(10);
    expect(calls[0].input.post).toMatchObject({ format: "carousel", hook: "Ten from the season.", show: "A photo from each race.", caption_angle: "The season so far.", media_needs: "ten photos" });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect([kit.idea.format, kit.formatFromMoment, kit.assets.length]).toEqual(["carousel", true, 10]);
  });

  it("a reel or story stays at VIDEO_MAX_ASSETS (3)", async () => {
    library.set(A, Array.from({ length: 6 }, (_, i) => row({ vision: { description: `x photo ${i + 1}` } })));
    const calls = fakeGemini((input) => ({ picks: input.candidates.map((c: any) => ({ ref: c.ref, segment: "", reason: "fits" })), none_fit: false, none_fit_reason: "", look_preset: "natural", music_mood: "none" }));
    const d = await action(postAction({ post: { hook: "Race week.", format: "reel", show: "The build-up.", captionAngle: "Ready.", avoid: "", mediaNeeds: "" } }));
    expect(await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null })).toMatchObject({ status: "built", assets: 3 });
    expect(calls[0].input.max_picks).toBe(POST_KIT.VIDEO_MAX_ASSETS);
  });
});

describe("B8: the final guard runs on the words that ship — after the copy pass", () => {
  const polish = polishPostCopy as jest.MockedFunction<typeof polishPostCopy>;
  const copy = (caption: string, hook = "Early, every day.") => ({ picked: { hook, caption }, options: [{ hook, caption }] });
  const setup = async (detail = postAction()) => {
    library.set(A, [row({ vision: { description: "the athlete smiling after the session" } })]);
    fakeGemini(pickBy("smiling"));
    return action(detail);
  };
  beforeEach(() => { process.env.COPYWRITER_V1 = "true"; polish.mockReset(); });
  afterEach(() => { delete process.env.COPYWRITER_V1; });

  it("a rewrite that brings in a never-use name is blocked: the plan's own (guarded) copy ships instead", async () => {
    prefs = [{ kind: "avoid", statement: "Never use: Robin", status: "active" }];
    polish.mockResolvedValue(copy("Early mornings with Robin. Every rep counts."));
    const d = await setup();
    expect(await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null })).toMatchObject({ status: "built" });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(polish).toHaveBeenCalledTimes(1);
    expect(kit.caption.text).toBe("The work nobody sees. Early sessions add up. #training #process");
    expect(kit.caption.text).not.toContain("Robin");
    expect(kit.copy).toBeUndefined();
    expect(kit.idea.hook).toBe("The work nobody sees.");
  });

  it("blocked again on the plan's copy (avoided wording): no kit is written, the hold is recorded, and nothing re-runs it while its inputs are unchanged", async () => {
    polish.mockResolvedValue(copy("Back to the grind tomorrow."));
    const d = await setup(postAction({ deliverable: { ...postAction().deliverable, body: "Caption: Back to the grind. #training\nShots: a hard rep." } }));
    const avoid = deps({ avoidWords: async () => ["grind"] });
    const out = await buildPostKit(avoid, A, d.id, { trigger: "event", parentRef: null });
    expect(out).toEqual({ status: "held", decisionId: d.id, reason: "final_guard", block: "avoided_wording" });
    const det = await kitOf(d.id);
    expect(det.state).toBe("to_start");
    expect(det.prepared?.postKit).toBeUndefined();
    expect(det.prepared?.postKitHold).toMatchObject({ reason: "final_guard", block: "avoided_wording" });
    expect(polish).toHaveBeenCalledTimes(1);

    // The next plan run: the same inputs → answered from the row: no re-rank, no copy pass, not counted, not re-told.
    const before = (await store.listRunsSince(A, { since: "2000-01-01T00:00:00Z", skillId: MATCH_SKILL_ID })).length;
    expect(await buildPendingPostKits(avoid, A, { parentRef: "workflow:w2:post_kit", trigger: "schedule" })).toEqual({ built: 0, skipped: {}, failed: 0, held: [] });
    expect((await store.listRunsSince(A, { since: "2000-01-01T00:00:00Z", skillId: MATCH_SKILL_ID })).length).toBe(before);
    // The athlete's Build it, nothing changed: the same answer, free (round 2 — no second paid run for the same words).
    expect(await buildPostKit(avoid, A, d.id, { trigger: "event", parentRef: null })).toEqual({ status: "held", decisionId: d.id, reason: "final_guard", block: "avoided_wording", reused: true });
    expect(polish).toHaveBeenCalledTimes(1);

    // The inputs change (the athlete drops the avoided word) → it is tried again.
    polish.mockResolvedValue(copy("Early, every day."));
    expect(await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null })).toMatchObject({ status: "built" });
    expect((await kitOf(d.id)).prepared?.postKitHold).toBeNull();
  });

  it("round 3: the hold's key changes with any fact (claim edited, not only the count), a deal record, or the event's date", () => {
    const det = postAction({ event: { factId: "e1", label: "Final", date: "2026-11-21", precision: "day" } });
    const facts = [{ id: "f1", claim: "Ran 12 races.", date: "2026-10-01" }];
    const base = holdInputsKey(det, [], [], facts, []);
    expect(holdInputsKey(det, [], [], [{ ...facts[0], claim: "Ran 14 races." }], [])).not.toBe(base);
    expect(holdInputsKey(det, [], [], [{ ...facts[0], date: "2026-10-02" }], [])).not.toBe(base);
    expect(holdInputsKey(det, [], [], facts, [{ brand: "Partner Co", kind: "deal", codes: [] }])).not.toBe(base);
    expect(holdInputsKey({ ...det, event: { ...det.event!, date: "2026-11-28" } }, [], [], facts, [])).not.toBe(base);
    expect(holdInputsKey(det, [], [], [...facts], [])).toBe(base);
  });

  it("round 3: the athlete's Build it tap retries a hold older than HOLD_RETRY_MS (nothing changed); a newer one answers free", async () => {
    polish.mockResolvedValue(copy("Back to the grind tomorrow."));
    const d = await setup(postAction({ deliverable: { ...postAction().deliverable, body: "Caption: Back to the grind. #training\nShots: a hard rep." } }));
    const at = (ms: number) => deps({ avoidWords: async () => ["grind"], now: new Date(NOW.getTime() + ms) });
    await buildPostKit(at(0), A, d.id, { trigger: "event", parentRef: null });
    expect(polish).toHaveBeenCalledTimes(1);
    // A tap a minute later: the stored answer, free.
    expect(await buildPostKit(at(60_000), A, d.id, { trigger: "event", parentRef: null, asked: true })).toMatchObject({ status: "held", reused: true });
    expect(polish).toHaveBeenCalledTimes(1);
    // The plan workflow an hour later, nothing changed: still free (it never retries on time).
    expect(await buildPostKit(at(HOLD_RETRY_MS + 1), A, d.id, { trigger: "schedule", parentRef: null })).toMatchObject({ status: "held", reused: true });
    // A tap an hour later: tried once more (paid), and the hold re-recorded with the new time.
    expect(await buildPostKit(at(HOLD_RETRY_MS + 1), A, d.id, { trigger: "event", parentRef: null, asked: true })).toMatchObject({ status: "held", reason: "final_guard" });
    expect(polish).toHaveBeenCalledTimes(2);
    expect((await kitOf(d.id)).prepared?.postKitHold?.at).toBe(new Date(NOW.getTime() + HOLD_RETRY_MS + 1).toISOString());
    // …and right after, a tap answers free again.
    expect(await buildPostKit(at(HOLD_RETRY_MS + 60_000), A, d.id, { trigger: "event", parentRef: null, asked: true })).toMatchObject({ reused: true });
    expect(polish).toHaveBeenCalledTimes(2);
  });

  it("a final-guard hold is paid for, so it takes one of the run's MAX_PER_RUN slots; the run reports the holds it made", async () => {
    polish.mockResolvedValue(copy("Back to the grind tomorrow."));
    library.set(A, [row({ vision: { description: "the athlete smiling after the session" } })]);
    fakeGemini(pickBy("smiling"));
    const grind = postAction({ deliverable: { ...postAction().deliverable, body: "Caption: Back to the grind. #training\nShots: a hard rep." } });
    for (let i = 0; i < POST_KIT.MAX_PER_RUN + 1; i++) await action({ ...grind, what: `Grind ${i}`, dueOn: `2026-12-1${i}` });
    const out = await buildPendingPostKits(deps({ avoidWords: async () => ["grind"] }), A, { parentRef: "workflow:w1:post_kit", trigger: "schedule" });
    expect(out.skipped).toEqual({ final_guard: POST_KIT.MAX_PER_RUN });
    expect(out.held).toEqual(Array.from({ length: POST_KIT.MAX_PER_RUN }, () => ({ reason: "final_guard", block: "avoided_wording" })));
    expect(polish).toHaveBeenCalledTimes(POST_KIT.MAX_PER_RUN);
  });

  it("a clean rewrite ships: a number no source holds comes out, the plan's tags follow the words; options are guarded too", async () => {
    polish.mockResolvedValue({
      picked: { hook: "Early, every day.", caption: "Early, every day. We drew 5,000 fans last time. The work adds up." },
      options: [
        { hook: "Early, every day.", caption: "Early, every day. We drew 5,000 fans last time. The work adds up." },
        { hook: "Robin's alarm clock.", caption: "Up early with Robin." },
      ],
    });
    prefs = [{ kind: "avoid", statement: "Never use: Robin", status: "active" }];
    const d = await setup();
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.caption).toEqual({ text: "Early, every day. The work adds up.\n\n#training #process", hashtags: ["#training", "#process"], edited: false });
    expect(kit.copy?.original.caption).toBe("The work nobody sees. Early sessions add up. #training #process");
    // Only the options that pass are stored, as they would ship.
    expect(kit.copy?.options).toEqual([{ hook: "Early, every day.", caption: "Early, every day. The work adds up.\n\n#training #process" }]);
    expect(kit.guard).toEqual({ version: GUARD_VERSION, at: NOW.toISOString(), disclosure: null });
  });

  const brandPost = () => postAction({ deliverable: { ...postAction().deliverable, target: { subjectKind: "brand", name: "Partner Co" } } });

  it("#ad only for a real deal: the partner matches a record of the athlete's → #ad at the start", async () => {
    polish.mockResolvedValue(copy("New kit, same early mornings."));
    const d = await setup(brandPost());
    await buildPostKit(deps({ connections: async () => [{ brand: "partner co.", kind: "deal", codes: [] }] }), A, d.id, { trigger: "event", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.caption.text).toBe("#ad New kit, same early mornings.\n\n#training #process");
    expect(kit.caption.hashtags).toEqual(["#ad", "#training", "#process"]);
    expect(kit.guard?.disclosure).toBe("ad");
  });

  it("round 2: a record's brand named in the final words (no partner on the deliverable) → #ad too", async () => {
    polish.mockResolvedValue(copy("Early miles in my Partner Co spikes."));
    const d = await setup();
    await buildPostKit(deps({ connections: async () => [{ brand: "Partner Co", kind: "gift", codes: [] }] }), A, d.id, { trigger: "event", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.caption.text).toBe("#ad Early miles in my Partner Co spikes.\n\n#training #process");
    expect(kit.guard?.disclosure).toBe("ad");
  });

  it("a brand named with no deal, gift or affiliate record: no #ad, the kit asks (disclosure \"ask\")", async () => {
    polish.mockResolvedValue(copy("New kit, same early mornings."));
    const d = await setup(brandPost());
    await buildPostKit(deps({ connections: async () => [{ brand: "Other Co", kind: "gift", codes: [] }] }), A, d.id, { trigger: "event", parentRef: null });
    const kit = (await kitOf(d.id)).prepared!.postKit as PostKit;
    expect(kit.caption.text).toBe("New kit, same early mornings.\n\n#training #process");
    expect(kit.guard?.disclosure).toBe("ask");
  });

  it("without the copy pass the guard still runs on the plan's copy", async () => {
    delete process.env.COPYWRITER_V1;
    const d = await setup(brandPost());
    await buildPostKit(deps({ connections: async () => [{ brand: "Partner Co", kind: "affiliate", codes: [] }] }), A, d.id, { trigger: "event", parentRef: null });
    expect(polish).not.toHaveBeenCalled();
    expect(((await kitOf(d.id)).prepared!.postKit as PostKit).caption.text).toBe("#ad The work nobody sees. Early sessions add up. #training #process");
  });

  it("numbers: every ACTIVE fact counts as a source, not only the cited ones — never a disputed one", async () => {
    delete process.env.COPYWRITER_V1;
    const fact = (claim: string) => ({ subject: { kind: "athlete" as const, name: "Sam Example" }, claim, type: "found" as const, source: { url: "https://example.org/a" }, date: "2026-10-01", confidence: 0.9, runId: null });
    await store.insertFacts(A, [fact("Ran 12 races this season.")]);
    const [disputed] = await store.insertFacts(A, [fact("Won 7 titles in a row.")]);
    await store.setFactStatus(A, disputed.id, "disputed");
    const d = await setup(postAction({ deliverable: { ...postAction().deliverable, body: "Caption: Early again. 12 races in. Won 7 titles. #training\nShots: a hard rep." } }));
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect(((await kitOf(d.id)).prepared!.postKit as PostKit).caption.text).toBe("Early again. 12 races in. #training");
  });
});
