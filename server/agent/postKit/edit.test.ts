/**
 * edit.test.ts — reading a post kit and the athlete's two edits (agent/postKit/edit.ts), on the in-memory store and
 * library port; no provider is reached (the kit is built once with a fake Gemini client).
 *
 *   E1 the read: the kit, its media with signed URLs, an asset gone since the build marked unavailable; nothing built yet
 *      reads as to_start with no kit
 *   E2 swap: only to an asset on the kit's own shortlist that still passes the athlete's predicate and every check; the
 *      old asset goes back on the shortlist; refusals are named
 *   E3 caption: the athlete's words, its tags listed; empty or too long refused; a done post is read-only; the final
 *      guard on the edit (never-content, avoided wording, care text refused; contact out; their numbers stand; #ad first
 *      on a sponsored post)
 *   E4 tenancy: another athlete's action is not found, through every function
 *   E5 "I posted it": the same answer every other action kind gets (response accepted), written conditionally (an
 *      action closed in between is never flipped); needs a built kit; a repeat answers the current read; a kit with
 *      no assets can still be marked posted. E5b–d: detail.posted { at, link, by } in the same write; the time they
 *      give; a link added once on a repeat tap; bad links and times refused
 *   E6 music: switch only among the kit's suggestions, never a non-brand-safe one on a brand post; the credit line
 *      follows the track and is locked against a caption edit; the read signs a listening link per suggestion
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));

import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import type { CastableRow } from "../../studio/agent/cast";
import { setGeminiClient } from "../geminiProvider";
import { createMemoryStore, type AgentStore } from "../research/store";
import { buildPostKit, type PostKitDeps } from "./build";
import { POST_KIT } from "./config";
import { chooseTrack, editCaption, markPosted, readPostKit, swapAsset } from "./edit";
import { creditLine } from "./music";
import { GUARD_VERSION } from "./finalGuard";
import { MUSIC_CATALOGUE } from "../../studio/music/find";
import { clip, fakeGemini, fakeMedia, postAction, refsWith, row } from "./testRows";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let store: AgentStore;
let library: Map<string, CastableRow[]>;
let picked: CastableRow; let spare: CastableRow; let spareClip: CastableRow;
let decisionId = "";

const deps = (): PostKitDeps => ({ store, media: fakeMedia(library).media, preferences: async () => [] });
const kitOf = async () => ((await store.getDecision(A, decisionId))!.detail as unknown as ActionDecisionDetail).prepared!.postKit as PostKit;

beforeEach(async () => {
  store = createMemoryStore();
  picked = row({ vision: { description: "the chosen shot" } });
  spare = row({ vision: { description: "a spare shot" } });
  spareClip = clip(12, [[2, 6, "a spare clip moment"]], undefined, { vision: { description: "a spare clip" } });
  library = new Map([[A, [picked, spare, spareClip]], [B, [row()]]]);
  fakeGemini((input) => ({ picks: refsWith(input.candidates, "chosen").map((ref) => ({ ref, segment: "", reason: "r" })), none_fit: false, none_fit_reason: "", look_preset: "natural", music_mood: "warm" }));
  const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
  const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Training clip", why: "w", evidence: [], detail: postAction() as unknown as Record<string, unknown>, goalId: goal.id });
  decisionId = d.id;
  await buildPostKit(deps(), A, decisionId, { trigger: "event", parentRef: null });
});
const savedQueue = process.env.CONTENT_READY_QUEUE;
const savedKits = process.env.AGENT_POST_KITS;
/** CONTENT_READY_QUEUE (and AGENT_POST_KITS, which it needs) on, for the tests of what "I posted it" carries. */
const queueOn = () => { process.env.CONTENT_READY_QUEUE = "true"; process.env.AGENT_POST_KITS = "true"; };
afterEach(() => {
  setGeminiClient(null);
  if (savedQueue === undefined) delete process.env.CONTENT_READY_QUEUE; else process.env.CONTENT_READY_QUEUE = savedQueue;
  if (savedKits === undefined) delete process.env.AGENT_POST_KITS; else process.env.AGENT_POST_KITS = savedKits;
});

describe("E1: the read", () => {
  it("the kit and its media: the kit's assets first, then the shortlist, with signed URLs", async () => {
    const r = await readPostKit(deps(), A, decisionId);
    expect(r).toMatchObject({ contract: "post-kit/1", decisionId, state: "made", kit: { assets: [{ assetId: picked.id }] } });
    // The goal it serves and the plain-words why, off the same row — no moment timed for this one.
    expect(r).toMatchObject({ goal: { text: "Grow" }, moment: null, why: "w" });
    expect(r.media).toEqual([
      { assetId: picked.id, mediaType: "photo", thumbUrl: `https://signed.example/${picked.gcsPath}`, videoUrl: null, available: true, inKit: true },
      { assetId: spare.id, mediaType: "photo", thumbUrl: `https://signed.example/${spare.gcsPath}`, videoUrl: null, available: true, inKit: false },
      { assetId: spareClip.id, mediaType: "clip", thumbUrl: `https://signed.example/${spareClip.gcsPath}`, videoUrl: `https://signed.example/${spareClip.videoPath}`, available: true, inKit: false },
    ]);
  });

  it("an asset deleted since the build reads unavailable, never as someone else's", async () => {
    library.set(A, [spare, spareClip]);
    const r = await readPostKit(deps(), A, decisionId);
    expect(r.media[0]).toEqual({ assetId: picked.id, mediaType: "photo", thumbUrl: null, videoUrl: null, available: false, inKit: true });
  });

  it("timed for a moment: its name and why_now, off the moment's own decision row", async () => {
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Season opener" }, claim: "The season opener is on the 20th.", type: "found", source: { url: "https://example.org/schedule" }, date: "2026-10-20", confidence: 0.9, runId: null, topic: "moment" }]);
    await store.insertDecision(A, {
      runId: null, skillId: "moments", kind: "other", suggested: "Season opener", why: "w", evidence: [{ kind: "fact", factId: fact.id }],
      detail: { kind: "moment", whyNow: "Ten days out and she hasn't posted about it yet.", idea: { hook: "Ten days out.", format: "story", platform: "instagram", timing: "3 days before" }, brief: { show: "game-day prep", captionAngle: "Ready", avoid: "" }, mediaNeeds: "a calm portrait" },
    });
    const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Opener post", why: "w", evidence: [], goalId: goal.id, detail: postAction({ event: { factId: fact.id, label: "Season opener", date: "2026-10-20", precision: "day" } }) as unknown as Record<string, unknown> });
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const r = await readPostKit(deps(), A, d.id);
    expect(r.moment).toEqual({ name: "Season opener", whyNow: "Ten days out and she hasn't posted about it yet." });
  });

  it("an action with nothing built reads to_start with no kit; a closed one is refused", async () => {
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "x", why: "w", evidence: [], detail: postAction() as unknown as Record<string, unknown> });
    expect(await readPostKit(deps(), A, d.id)).toEqual({ contract: "post-kit/1", decisionId: d.id, state: "to_start", kit: null, media: [], goal: null, moment: null, why: "w", preview: null });
    await store.respondDecision(A, d.id, "expired", "not repeated");
    await expect(readPostKit(deps(), A, d.id)).rejects.toMatchObject({ status: 409, code: "closed" });
  });
});

describe("E2: swap", () => {
  it("to a clip on the shortlist: it takes the place, its seconds are its first beat, the old one goes back on the shortlist", async () => {
    const r = await swapAsset(deps(), A, decisionId, { replace: picked.id, with: spareClip.id });
    expect(r.kit!.assets).toEqual([{ assetId: spareClip.id, mediaType: "clip", clip: { startSec: 2, endSec: 6, from: "beat" }, durationSec: 12, provenance: "camera" }]);
    expect(r.kit!.shortlist).toEqual([picked.id, spare.id]);
    expect(r.kit!.treatmentPlan).toMatchObject({ order: [spareClip.id], trims: [{ assetId: spareClip.id, startSec: 2, endSec: 6 }], musicMood: "warm" });
    expect((await kitOf()).assets[0].assetId).toBe(spareClip.id);
    // The picks set the format (no moment): one photo was a feed post; a clip makes it a reel, cut for 9:16.
    expect(r.kit!.formatFromMoment).toBe(false);
    expect(r.kit!.idea.format).toBe("reel");
    expect(r.kit!.treatmentPlan).toMatchObject({ aspect: "9:16", totalSec: 4, overlayText: "The work nobody sees." });
    // And back again: a feed post, 4:5, no overlay, no running length.
    const back = await swapAsset(deps(), A, decisionId, { replace: spareClip.id, with: picked.id });
    expect(back.kit!.assets.map((a) => a.assetId)).toEqual([picked.id]);
    expect(back.kit!.idea.format).toBe("feed");
    expect(back.kit!.treatmentPlan).toMatchObject({ aspect: "4:5", overlayText: null, totalSec: null, trims: [], stills: [] });
  });

  it("a format the moment set holds: a clip can't be swapped into a feed post, a photo can", async () => {
    const kit = await kitOf();
    const fixed = { ...kit, formatFromMoment: true, idea: { ...kit.idea, format: "feed" as const } };
    const d = (await store.getDecision(A, decisionId))!;
    const det = d.detail as unknown as ActionDecisionDetail;
    await store.updateDecision(A, decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: fixed } } as unknown as Record<string, unknown> });
    await expect(swapAsset(deps(), A, decisionId, { replace: picked.id, with: spareClip.id })).rejects.toMatchObject({ status: 409, code: "format_mismatch" });
    const r = await swapAsset(deps(), A, decisionId, { replace: picked.id, with: spare.id });
    expect(r.kit).toMatchObject({ formatFromMoment: true, idea: { format: "feed" }, treatmentPlan: { aspect: "4:5" } });
  });

  it("a race: a write that lands while the swap is worked out answers conflict and overwrites nothing", async () => {
    const real = store;
    let reads = 0;
    store = { ...real, getDecision: async (a: string, id: string) => {
      const got = await real.getDecision(a, id);
      // The re-read before the write is followed at once by another edit of the same kit.
      if (id === decisionId && ++reads === 2) {
        const det = got!.detail as unknown as ActionDecisionDetail;
        const k = det.prepared!.postKit as PostKit;
        await real.updateDecision(a, id, { detail: { ...det, prepared: { ...det.prepared, postKit: { ...k, caption: { ...k.caption, text: "theirs" } } } } as unknown as Record<string, unknown> });
      }
      return got;
    } };
    await expect(editCaption(deps(), A, decisionId, { text: "mine" })).rejects.toMatchObject({ status: 409, code: "conflict" });
    store = real;
    expect((await kitOf()).caption.text).toBe("theirs");
    // An edit that began before another one finished is refused too (its kit is no longer the one it read).
    const det = (await store.getDecision(A, decisionId))!.detail as unknown as ActionDecisionDetail;
    const k = det.prepared!.postKit as PostKit;
    store = { ...real, getDecision: async (a: string, id: string) => {
      const got = await real.getDecision(a, id);
      if (id === decisionId && reads++ === 2) {
        await real.updateDecision(a, id, { detail: { ...det, prepared: { ...det.prepared, postKit: { ...k, updatedAt: "2099-01-01T00:00:00.000Z" } } } as unknown as Record<string, unknown> });
      }
      return got;
    } };
    await expect(swapAsset(deps(), A, decisionId, { replace: picked.id, with: spare.id })).rejects.toMatchObject({ code: "conflict" });
    store = real;
    expect((await kitOf()).assets[0].assetId).toBe(picked.id);
  });

  it("refuses what is not in the kit, not on the shortlist, gone, or no longer usable — each by name", async () => {
    const outsider = row();
    library.set(A, [picked, spare, spareClip, outsider]);
    await expect(swapAsset(deps(), A, decisionId, {})).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(swapAsset(deps(), A, decisionId, { replace: spare.id, with: spareClip.id })).rejects.toMatchObject({ status: 400, code: "not_in_kit" });
    await expect(swapAsset(deps(), A, decisionId, { replace: picked.id, with: outsider.id })).rejects.toMatchObject({ status: 400, code: "not_on_shortlist" });
    library.set(A, [picked, spareClip]);
    await expect(swapAsset(deps(), A, decisionId, { replace: picked.id, with: spare.id })).rejects.toMatchObject({ status: 409, code: "unavailable" });
    library.set(A, [picked, { ...spare, vision: { ...spare.vision, brand_safe: false } }, spareClip]);
    await expect(swapAsset(deps(), A, decisionId, { replace: picked.id, with: spare.id })).rejects.toMatchObject({ status: 409, code: "brand_unsafe" });
    expect((await kitOf()).assets[0].assetId).toBe(picked.id);
  });
});

describe("E3: caption", () => {
  it("the athlete's own words, tags listed, marked edited", async () => {
    const r = await editCaption(deps(), A, decisionId, { text: "  My own words.\nSecond line #mine " });
    expect(r.kit!.caption).toEqual({ text: "My own words.\nSecond line #mine", hashtags: ["#mine"], edited: true });
    expect((await kitOf()).caption.edited).toBe(true);
  });

  it("empty or too long is refused; a done post is read-only", async () => {
    await expect(editCaption(deps(), A, decisionId, { text: "   " })).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(editCaption(deps(), A, decisionId, { text: "x".repeat(POST_KIT.CAPTION_CHARS + 1) })).rejects.toMatchObject({ status: 400, code: "too_long" });
    await store.respondDecision(A, decisionId, "accepted", null);
    await expect(editCaption(deps(), A, decisionId, { text: "late" })).rejects.toMatchObject({ status: 409, code: "done" });
    await expect(swapAsset(deps(), A, decisionId, { replace: picked.id, with: spare.id })).rejects.toMatchObject({ status: 409, code: "done" });
  });

  it("the final guard runs on their edit: never-content (in a tag too), avoided wording, care text refused in words; nothing of theirs deleted; their numbers stand", async () => {
    await store.insertFacts(A, [{
      subject: { kind: "athlete", name: "Sam Example" }, claim: "Sam Example missed the spring season with a knee injury in March.", type: "found",
      source: { url: "https://example.org/a" }, date: "2026-03-01", confidence: 0.9, runId: null, sensitive: true, careKind: "personal",
    }]);
    const guarded = (): PostKitDeps => ({ ...deps(), preferences: async () => [{ kind: "avoid", statement: "Never use: Robin", status: "active" }] as never, avoidWords: async () => ["grind"] });
    for (const text of ["A ride with Robin today.", "Big day. #TeamRobin", "Back to the grind.", "Back after I missed the spring season with a knee injury."]) {
      await expect(editCaption(guarded(), A, decisionId, { text })).rejects.toMatchObject({ status: 400, code: "final_guard" });
    }
    expect((await kitOf()).caption.edited).toBe(false); // nothing was saved
    // A contact detail or a price is never cut out of their words for them: a refusal that says what it found.
    await expect(editCaption(guarded(), A, decisionId, { text: "Onward. Bookings: sam@example.com. Posts from $500." }))
      .rejects.toMatchObject({ status: 400, code: "final_guard", message: "That caption has a contact detail and a price or rate. Take it out, then save again." });
    // Their own typed numbers stand (41 is in no fact).
    const r = await editCaption(guarded(), A, decisionId, { text: "Scored 41 today. Onward." });
    expect(r.kit!.caption).toEqual({ text: "Scored 41 today. Onward.", hashtags: [], edited: true });
    expect(r.kit!.guard).toMatchObject({ version: GUARD_VERSION, disclosure: null });
    // Never a caption that is only #ad.
    await expect(editCaption(guarded(), A, decisionId, { text: "#ad" })).rejects.toMatchObject({ status: 400, code: "final_guard" });
  });

  it("a kit built before the guard (no mark): its old numbers are re-checked once; numbers they newly type are theirs", async () => {
    // Stand in an unguarded kit: the mark taken off and an old, never-checked number in its caption.
    const row = (await store.getDecision(A, decisionId))!;
    const det = row.detail as unknown as ActionDecisionDetail;
    const old = { ...(det.prepared!.postKit as PostKit), caption: { text: "Won 9 straight. Onward.", hashtags: [], edited: false } };
    delete (old as Partial<PostKit>).guard;
    await store.updateDecision(A, decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: old } } as unknown as Record<string, unknown> });
    // Keeping the old "9" is refused (it was never checked); typing a new number of their own is fine.
    await expect(editCaption(deps(), A, decisionId, { text: "Won 9 straight. Onward!" })).rejects.toMatchObject({ code: "final_guard", message: expect.stringContaining("(9)") });
    const r = await editCaption(deps(), A, decisionId, { text: "Onward, 3 days out!" });
    expect(r.kit!.caption.text).toBe("Onward, 3 days out!");
    expect(r.kit!.guard).toMatchObject({ version: GUARD_VERSION });
  });

  it("round 2: a pre-guard kit the athlete already edited — the numbers they typed then are theirs", async () => {
    const row = (await store.getDecision(A, decisionId))!;
    const det = row.detail as unknown as ActionDecisionDetail;
    const old = { ...(det.prepared!.postKit as PostKit), caption: { text: "Won 9 straight. Onward.", hashtags: [], edited: true } };
    delete (old as Partial<PostKit>).guard;
    await store.updateDecision(A, decisionId, { detail: { ...det, prepared: { ...det.prepared, postKit: old } } as unknown as Record<string, unknown> });
    const r = await editCaption(deps(), A, decisionId, { text: "Won 9 straight. Onward!" });
    expect(r.kit!.caption.text).toBe("Won 9 straight. Onward!");
  });

  it("#ad on an edit: put at the start (and kept) when a real deal record matches; without one they may take it out", async () => {
    const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
    const brand = postAction({ what: "Brand post", deliverable: { ...postAction().deliverable, target: { subjectKind: "brand", name: "Partner Co" } } });
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Brand post", why: "w", evidence: [], detail: brand as unknown as Record<string, unknown>, goalId: goal.id });
    const linked = (): PostKitDeps => ({ ...deps(), connections: async () => [{ brand: "Partner Co", kind: "deal", codes: [] }] });
    await buildPostKit(linked(), A, d.id, { trigger: "event", parentRef: null });
    const r = await editCaption(linked(), A, d.id, { text: "New kit day. #gear #ad" });
    expect(r.kit!.caption).toEqual({ text: "#ad New kit day. #gear", hashtags: ["#ad", "#gear"], edited: true });
    // Taking #ad out of a deal post: it goes back in.
    expect((await editCaption(linked(), A, d.id, { text: "New kit day. #gear" })).kit!.caption.text).toBe("#ad New kit day. #gear");
    // No record: it may come out.
    expect((await editCaption(deps(), A, d.id, { text: "New kit day. #gear" })).kit!.caption.text).toBe("New kit day. #gear");
  });

  it("an action with no kit built cannot be edited", async () => {
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "x", why: "w", evidence: [], detail: postAction() as unknown as Record<string, unknown> });
    await expect(editCaption(deps(), A, d.id, { text: "words" })).rejects.toMatchObject({ status: 404, code: "no_kit" });
  });

  it("a kit nothing fitted: its caption can still be edited; a swap says plainly there is nothing to swap", async () => {
    library.set(A, []);
    const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Empty", why: "w", evidence: [], detail: postAction({ what: "Empty" }) as unknown as Record<string, unknown>, goalId: goal.id });
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const r = await editCaption(deps(), A, d.id, { text: "Words for later" });
    expect(r).toMatchObject({ state: "to_start", kit: { assets: [], caption: { text: "Words for later", edited: true }, aiGenerationNeeded: { value: true } } });
    await expect(swapAsset(deps(), A, d.id, { replace: "x", with: "y" })).rejects.toMatchObject({ status: 409, code: "no_assets" });
  });
});

describe("E4: tenancy", () => {
  it("another athlete cannot read or change the kit: not found, every time", async () => {
    await expect(readPostKit(deps(), B, decisionId)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(swapAsset(deps(), B, decisionId, { replace: picked.id, with: spare.id })).rejects.toMatchObject({ status: 404 });
    await expect(editCaption(deps(), B, decisionId, { text: "mine now" })).rejects.toMatchObject({ status: 404 });
    expect((await kitOf()).caption.edited).toBe(false);
  });
});

describe("E5: \"I posted it\"", () => {
  it("answers the action the same way a reply or a pitch does: response accepted, state reads done", async () => {
    const r = await markPosted(deps(), A, decisionId);
    expect(r.state).toBe("done");
    const fresh = (await store.getDecision(A, decisionId))!;
    expect(fresh.response).toBe("accepted");
    expect(fresh.respondedAt).toBeTruthy();
    // Read-only once posted, same as any other done kit.
    await expect(editCaption(deps(), A, decisionId, { text: "late" })).rejects.toMatchObject({ status: 409, code: "done" });
    // A repeat tap is not an error: it answers the current read and writes nothing.
    const respondedAt = fresh.respondedAt;
    expect(await markPosted(deps(), A, decisionId)).toMatchObject({ state: "done" });
    expect((await store.getDecision(A, decisionId))!.respondedAt).toBe(respondedAt);
  });

  it("an action closed before the tap is refused (409 closed), never flipped to accepted", async () => {
    await store.respondDecision(A, decisionId, "expired", "not repeated");
    await expect(markPosted(deps(), A, decisionId)).rejects.toMatchObject({ status: 409, code: "closed" });
    expect((await store.getDecision(A, decisionId))!.response).toBe("expired");
  });

  it("the write is conditional: an action that expires between the read and the write stays expired", async () => {
    // The store answers the read, then the action expires (the plan's sweep) before the write lands.
    const racing: AgentStore = {
      ...store,
      async updateDecision(athleteId, id, p) {
        await store.respondDecision(athleteId, id, "expired", "swept");
        return store.updateDecision(athleteId, id, p);
      },
    };
    await expect(markPosted({ ...deps(), store: racing }, A, decisionId)).rejects.toMatchObject({ status: 409, code: "closed" });
    expect((await store.getDecision(A, decisionId))!.response).toBe("expired");
  });

  it("the write is conditional: a kit edited between the read and the write answers conflict", async () => {
    const racing: AgentStore = {
      ...store,
      async updateDecision(athleteId, id, p) {
        if (p.response === "accepted") await editCaption(deps(), A, decisionId, { text: "Changed meanwhile." });
        return store.updateDecision(athleteId, id, p);
      },
    };
    await expect(markPosted({ ...deps(), store: racing }, A, decisionId)).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect((await store.getDecision(A, decisionId))!.response).toBe("pending");
  });

  it("needs a kit built first", async () => {
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "x", why: "w", evidence: [], detail: postAction() as unknown as Record<string, unknown> });
    await expect(markPosted(deps(), A, d.id)).rejects.toMatchObject({ status: 404, code: "no_kit" });
  });

  it("a kit with no assets (nothing fitted) can still be marked posted", async () => {
    library.set(A, []);
    const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Empty", why: "w", evidence: [], detail: postAction({ what: "Empty" }) as unknown as Record<string, unknown>, goalId: goal.id });
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const r = await markPosted(deps(), A, d.id);
    expect(r).toMatchObject({ state: "done", kit: { assets: [] } });
  });

  it("another athlete cannot mark it posted", async () => {
    await expect(markPosted(deps(), B, decisionId)).rejects.toMatchObject({ status: 404 });
    expect((await store.getDecision(A, decisionId))!.response).toBe("pending");
  });

  it("E5b records detail.posted in the same write: now, or the time they give; the link they paste", async () => {
    queueOn();
    const now = new Date(Date.now() + 60_000);
    await markPosted({ ...deps(), now }, A, decisionId, { link: "  https://www.instagram.com/p/Abc123/  " });
    const fresh = (await store.getDecision(A, decisionId))!;
    expect(fresh).toMatchObject({ response: "accepted", responseReason: "posted" });
    expect(fresh.detail!.posted).toEqual({ at: now.toISOString(), link: "https://www.instagram.com/p/Abc123/", by: "athlete" });
    // The kit itself is untouched by the tap.
    expect((fresh.detail as any).prepared.postKit).toBeTruthy();
  });

  it("E5c a time in the past is kept; a bare tap is now; a link given on a repeat tap is added once, never replaced", async () => {
    queueOn();
    const now = new Date(Date.now() + 3 * 3_600_000);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await markPosted({ ...deps(), now }, A, decisionId, { postedAt: at });
    expect((await store.getDecision(A, decisionId))!.detail!.posted).toEqual({ at, link: null, by: "athlete" });
    await markPosted({ ...deps(), now }, A, decisionId, { link: "https://www.tiktok.com/@x/video/123" });
    expect((await store.getDecision(A, decisionId))!.detail!.posted).toEqual({ at, link: "https://www.tiktok.com/@x/video/123", by: "athlete" });
    await markPosted({ ...deps(), now }, A, decisionId, { link: "https://www.tiktok.com/@x/video/999" });
    expect(((await store.getDecision(A, decisionId))!.detail!.posted as any).link).toBe("https://www.tiktok.com/@x/video/123");
  });

  it("E5d refuses a link that is not http(s), a time to come or before the post was suggested — and writes nothing", async () => {
    queueOn();
    const now = new Date(Date.now() + 60_000);
    for (const [body, code] of [
      [{ link: "javascript:alert(1)" }, "bad_link"], [{ link: "https://user:secret@www.instagram.com/p/Abc/" }, "bad_link"], [{ link: "not a link" }, "bad_link"], [{ link: `https://x.com/${"a".repeat(600)}` }, "bad_link"], [{ link: 5 }, "bad_link"],
      [{ postedAt: "yesterday-ish" }, "bad_time"], [{ postedAt: new Date(now.getTime() + 3_600_000).toISOString() }, "bad_time"], [{ postedAt: "2001-01-01T00:00:00Z" }, "bad_time"],
    ] as const) {
      await expect(markPosted({ ...deps(), now }, A, decisionId, body as any)).rejects.toMatchObject({ status: 400, code });
    }
    expect((await store.getDecision(A, decisionId))!.response).toBe("pending");
  });

  it("E5e a link they paste corrects a wrong auto-link: the learning loop's guess is replaced and the wrong post unlinked", async () => {
    queueOn();
    // The loop marked it posted by time, linked to the wrong post.
    const d0 = (await store.getDecision(A, decisionId))!;
    await store.updateDecision(A, decisionId, {
      response: "accepted", responseReason: "posted",
      detail: { ...(d0.detail ?? {}), published: { platform: "instagram", entity_id: "wrong", via: "time", permalink: "https://www.instagram.com/reel/WRONG/", readings: { d2: {} } }, posted: { at: "2026-11-01T00:00:00.000Z", link: "https://www.instagram.com/reel/WRONG/", by: "learning" } },
    });
    await markPosted(deps(), A, decisionId, { link: "https://instagram.com/reel/RIGHT?igsh=1" });
    const fresh = (await store.getDecision(A, decisionId))!;
    expect(fresh.detail!.published).toBeUndefined();
    expect(fresh.detail).toMatchObject({ posted: { link: "https://instagram.com/reel/RIGHT?igsh=1", by: "athlete", at: "2026-11-01T00:00:00.000Z" }, unlinked: { reason: "athlete_link", was: { entity_id: "wrong" } } });
    // A link to the same post as the published one keeps the link (and its readings).
    const d1 = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "x", why: "w", evidence: [], detail: { ...(d0.detail ?? {}), published: { platform: "instagram", entity_id: "ok", via: "time", permalink: "https://www.instagram.com/reel/SAME/" } } });
    await markPosted(deps(), A, d1.id, { link: "https://www.instagram.com/reel/SAME" });
    expect((await store.getDecision(A, d1.id))!.detail).toMatchObject({ published: { entity_id: "ok" }, posted: { by: "athlete" } });
    // A pending kit tapped with a link that is NOT the time-linked post: unlinked in the same write.
    const d2 = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "x", why: "w", evidence: [], detail: { ...(d0.detail ?? {}), published: { platform: "instagram", entity_id: "thursday", via: "time", permalink: "https://www.instagram.com/reel/THU/" } } });
    await markPosted(deps(), A, d2.id, { link: "https://www.instagram.com/reel/FRI/" });
    const r2 = (await store.getDecision(A, d2.id))!;
    expect(r2.response).toBe("accepted");
    expect(r2.detail!.published).toBeUndefined();
  });
  it("E5f CONTENT_READY_QUEUE off: the tap is exactly as before — a link or time is not read, nothing is unlinked", async () => {
    delete process.env.CONTENT_READY_QUEUE;
    const d0 = (await store.getDecision(A, decisionId))!;
    const published = { platform: "instagram", entity_id: "x", via: "time", permalink: "https://www.instagram.com/reel/OTHER/" };
    await store.updateDecision(A, decisionId, { detail: { ...(d0.detail ?? {}), published } });
    await markPosted(deps(), A, decisionId, { link: "not even a link", postedAt: "nonsense" });
    const fresh = (await store.getDecision(A, decisionId))!;
    expect(fresh.response).toBe("accepted");
    expect(fresh.detail!.posted).toBeUndefined();
    expect(fresh.detail!.published).toEqual(published);
  });

  it("E5g a published link whose own permalink is unknown is kept (nothing proves it wrong); their link is stored", async () => {
    queueOn();
    const d0 = (await store.getDecision(A, decisionId))!;
    const published = { platform: "instagram", entity_id: "old", via: "time" };
    await store.updateDecision(A, decisionId, { detail: { ...(d0.detail ?? {}), published } });
    await markPosted(deps(), A, decisionId, { link: "https://www.instagram.com/p/Theirs/" });
    const fresh = (await store.getDecision(A, decisionId))!;
    expect(fresh.detail).toMatchObject({ published, posted: { link: "https://www.instagram.com/p/Theirs/", by: "athlete" } });
    expect(fresh.detail!.unlinked).toBeUndefined();
  });
});

describe("E6: music", () => {
  // The credit machinery runs with MUSIC_ALLOW_ATTRIBUTION_TRACKS on; the M2 default (off) is the last test here.
  beforeEach(() => { process.env.AGENT_POST_KIT_MUSIC_CHOICES = "true"; process.env.STUDIO_MUSIC_LIBRARY_READY = "true"; process.env.STUDIO_STITCH_BEDS_READY = "true"; process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS = "true"; });
  afterEach(() => { delete process.env.AGENT_POST_KIT_MUSIC_CHOICES; delete process.env.STUDIO_MUSIC_LIBRARY_READY; delete process.env.STUDIO_STITCH_BEDS_READY; delete process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS; });
  const owes = Object.values(MUSIC_CATALOGUE).find((t) => !t.brandSafe && t.credit)!;
  const safe = Object.values(MUSIC_CATALOGUE).find((t) => t.brandSafe && !t.credit)!;
  const choice = (t: typeof owes) => ({ trackId: t.id, title: t.title, artist: t.artist, reason: "r", licence: t.licence, credit: t.credit, creditShort: t.creditShort, contentIdRegistered: t.contentIdRegistered });
  /** The built kit, given suggestions (as a build with AGENT_POST_KIT_MUSIC_CHOICES on a reel would). */
  const withChoices = async (brand = false) => {
    const d = (await store.getDecision(A, decisionId))!;
    const det = d.detail as unknown as ActionDecisionDetail;
    const kit = det.prepared!.postKit as PostKit;
    const next: ActionDecisionDetail = {
      ...det,
      ...(brand ? { deliverable: { ...det.deliverable!, target: { subjectKind: "brand", name: "Brand A" } as never } } : {}),
      prepared: { ...det.prepared!, postKit: { ...kit, music: { choices: [choice(safe), choice(owes)], selected: safe.id } } },
    };
    await store.updateDecision(A, decisionId, { detail: next as unknown as Record<string, unknown> });
  };
  const mediaWithTracks = () => {
    const m = fakeMedia(library).media;
    return { ...m, trackUrl: async (p: string) => `https://signed.example/${p}` };
  };

  it("the read lists the suggestions, the one in use, and a listening link each", async () => {
    await withChoices();
    const r = await readPostKit({ ...deps(), media: mediaWithTracks() }, A, decisionId);
    expect(r.music?.choices.map((c) => [c.trackId, c.selected, c.allowed, c.listenUrl])).toEqual([
      [safe.id, true, true, `https://signed.example/${safe.gcsPath}`],
      [owes.id, false, true, `https://signed.example/${owes.gcsPath}`],
    ]);
    // A file not installed here gets no listening link.
    delete process.env.STUDIO_MUSIC_LIBRARY_READY; delete process.env.STUDIO_STITCH_BEDS_READY;
    const gated = await readPostKit({ ...deps(), media: mediaWithTracks() }, A, decisionId);
    expect(gated.music?.choices.map((c) => c.listenUrl)).toEqual([null, null]);
    // The flag off: the read carries no music block, and the route is dark.
    delete process.env.AGENT_POST_KIT_MUSIC_CHOICES;
    expect((await readPostKit(deps(), A, decisionId)).music).toBeUndefined();
    await expect(chooseTrack(deps(), A, decisionId, { track: safe.id })).rejects.toMatchObject({ status: 404, code: "music_off" });
  });

  it("switches to another suggestion; the credit follows, and a caption edit cannot drop it", async () => {
    await withChoices();
    const r = await chooseTrack(deps(), A, decisionId, { track: owes.id });
    expect(r.kit?.music?.selected).toBe(owes.id);
    expect(r.kit?.caption.text).toContain(creditLine(owes.credit!));
    const edited = await editCaption(deps(), A, decisionId, { text: "Only my words now." });
    expect(edited.kit?.caption.text).toBe(`Only my words now.

${creditLine(owes.credit!)}`);
    const back = await chooseTrack(deps(), A, decisionId, { track: safe.id });
    expect(back.kit?.caption.text).toBe("Only my words now.");
    const none = await chooseTrack(deps(), A, decisionId, { track: null });
    expect(none.kit?.music?.selected).toBeNull();
  });

  it("near the caption limit: her words are never cut — the short credit, or a refusal she can act on", async () => {
    await withChoices();
    const room = POST_KIT.CAPTION_CHARS - creditLine(owes.creditShort!).length - 2;
    await editCaption(deps(), A, decisionId, { text: "z".repeat(room) });
    const r = await chooseTrack(deps(), A, decisionId, { track: owes.id });
    expect(r.kit?.caption.text).toBe(`${"z".repeat(room)}

${creditLine(owes.creditShort!)}`);
    await expect(editCaption(deps(), A, decisionId, { text: "z".repeat(room + 5) })).rejects.toMatchObject({ status: 400, code: "no_room_for_credit" });
    await chooseTrack(deps(), A, decisionId, { track: safe.id });
    await editCaption(deps(), A, decisionId, { text: "z".repeat(room + 5) });
    await expect(chooseTrack(deps(), A, decisionId, { track: owes.id })).rejects.toMatchObject({ status: 400, code: "no_room_for_credit" });
    expect((await kitOf()).caption.text).toBe("z".repeat(room + 5));
  });

  it("a post that became brand work after the build: the read marks the pick not allowed, moves off it, and drops its credit", async () => {
    await withChoices();
    await chooseTrack(deps(), A, decisionId, { track: owes.id });
    expect((await kitOf()).caption.text).toContain(creditLine(owes.credit!));
    const d = (await store.getDecision(A, decisionId))!;
    const det = d.detail as unknown as ActionDecisionDetail;
    await store.updateDecision(A, decisionId, { detail: { ...det, deliverable: { ...det.deliverable!, target: { subjectKind: "brand", name: "Brand A" } } } as unknown as Record<string, unknown> });
    const r = await readPostKit(deps(), A, decisionId);
    expect(r.music?.choices.map((c) => [c.trackId, c.selected, c.allowed])).toEqual([[safe.id, true, true], [owes.id, false, false]]);
    expect(r.kit?.caption.text).not.toContain(creditLine(owes.credit!));
    // The next edit writes the reconciled kit; the credit does not come back.
    const e = await editCaption(deps(), A, decisionId, { text: "Brand words." });
    // (A brand named with no deal record: no #ad is put in — the kit asks instead.)
    expect([e.kit?.caption.text, (await kitOf()).music?.selected, e.kit?.guard?.disclosure]).toEqual(["Brand words.", safe.id, "ask"]);
  });

  it("refuses a track that is not a suggestion, a bad body, and — on a brand post — a track that is not brand-safe", async () => {
    await withChoices();
    await expect(chooseTrack(deps(), A, decisionId, { track: "status" })).rejects.toMatchObject({ status: 400, code: "not_a_choice" });
    await expect(chooseTrack(deps(), A, decisionId, { track: 7 })).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await withChoices(true);
    await expect(chooseTrack(deps(), A, decisionId, { track: owes.id })).rejects.toMatchObject({ status: 409, code: "not_brand_safe" });
  });

  it("M2 (MUSIC_ALLOW_ATTRIBUTION_TRACKS off): a credit-owing pick is no longer offered and gives way; a switch to it is refused", async () => {
    await withChoices();
    await chooseTrack(deps(), A, decisionId, { track: owes.id });
    delete process.env.MUSIC_ALLOW_ATTRIBUTION_TRACKS;
    const r = await readPostKit(deps(), A, decisionId);
    // Left out, not marked "not allowed" (the screen draws that as "Not for brand posts" — wrong on her own post).
    expect(r.music?.choices.map((c) => [c.trackId, c.selected, c.allowed])).toEqual([[safe.id, true, true]]);
    expect(r.kit?.caption.text).not.toContain(creditLine(owes.credit!));
    await expect(chooseTrack(deps(), A, decisionId, { track: owes.id })).rejects.toMatchObject({ status: 409, code: "not_offered" });
  });

  it("a kit with no suggestions says so (and reads no music block); another athlete gets not found", async () => {
    expect((await readPostKit(deps(), A, decisionId)).music).toBeUndefined();
    await expect(chooseTrack(deps(), A, decisionId, { track: safe.id })).rejects.toMatchObject({ status: 409, code: "no_music_choices" });
    await withChoices();
    await expect(chooseTrack(deps(), B, decisionId, { track: safe.id })).rejects.toMatchObject({ status: 404 });
  });
});
