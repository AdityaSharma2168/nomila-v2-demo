/**
 * edit.use.test.ts — the targeted camera-roll ask's last step (CAMERA_ROLL_INTAKE; agent/postKit/edit.ts useAsset): a
 * photo or clip she just imported for a post that had nothing of hers goes straight into its kit. In-memory store and
 * library port; no provider is reached (the empty kit is built with no candidates, so no model call is made).
 *
 *   U1 an empty kit takes the asset: assets, format, treatment, generation flag, state made, preview asked for
 *   U2 refusals are named and actionable: a kit that already has media (use Swap), an asset not hers, one still being
 *      read, one she isn't in, a clip into a photo-only post, a closed or done post
 *   U3 tenancy: another athlete's action is not found
 *   U4 postNeeds: what the post needs, in its own words, and whether it wants a clip
 *
 * ⚠️ MUTATIONS: drop the eligibility check — "an asset she isn't in is refused" reds; write without moving to made —
 * "an empty kit takes the clip" reds on state.
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
import { useAsset } from "./edit";
import { postNeeds } from "./intake";
import { clip, fakeGemini, fakeMedia, postAction, row } from "./testRows";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let store: AgentStore;
let library: Map<string, CastableRow[]>;
let decisionId = "";
let geminiCalls: unknown[] = [];

const deps = (): PostKitDeps => ({ store, media: fakeMedia(library).media, preferences: async () => [] });
const detailOf = async () => (await store.getDecision(A, decisionId))!.detail as unknown as ActionDecisionDetail;

async function emptyKit(over: Partial<ActionDecisionDetail> = {}): Promise<string> {
  const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
  const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Training clip", why: "w", evidence: [], detail: postAction(over) as unknown as Record<string, unknown>, goalId: goal.id });
  await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
  return d.id;
}

beforeEach(async () => {
  store = createMemoryStore();
  library = new Map([[A, []], [B, [row()]]]);
  geminiCalls = fakeGemini(() => ({ picks: [], none_fit: true, none_fit_reason: "", look_preset: "natural", music_mood: "none" }));
  decisionId = await emptyKit();
});
afterEach(() => setGeminiClient(null));

describe("U1: an empty kit takes the asset", () => {
  it("the built kit was empty (needs media) and no model was called", async () => {
    const det = await detailOf();
    expect(det.state).toBe("to_start");
    expect(det.prepared!.postKit!.assets).toEqual([]);
    expect(geminiCalls).toHaveLength(0);
  });

  it("an empty kit takes the clip she imported: a reel cut from it, made, built from her own footage", async () => {
    const imported = clip(14, [[0, 6, "a sprint start"], [6, 14, "the walk back"]]);
    library.set(A, [imported]);
    const r = await useAsset(deps(), A, decisionId, { assetId: imported.id });
    expect(r.state).toBe("made");
    const kit = r.kit as PostKit;
    expect(kit.assets).toEqual([expect.objectContaining({ assetId: imported.id, mediaType: "clip", provenance: "camera" })]);
    expect(kit.assets[0].clip).toMatchObject({ startSec: 0, from: "beat" });
    expect(kit.idea.format).toBe("reel");
    expect(kit.treatmentPlan.order).toEqual([imported.id]);
    expect(kit.aiGenerationNeeded).toEqual({ value: false, reason: "Built from your own photos and clips." });
    expect((await detailOf()).prepared!.studioItemId).toBe(decisionId);
    expect(r.media).toEqual([expect.objectContaining({ assetId: imported.id, inKit: true, available: true })]);
  });

  it("a photo makes a feed post when the moment did not set the format", async () => {
    const photo = row();
    library.set(A, [photo]);
    const r = await useAsset(deps(), A, decisionId, { assetId: photo.id });
    expect((r.kit as PostKit).idea.format).toBe("feed");
  });
});

describe("U2: refusals, named and actionable", () => {
  const refused = async (body: { assetId?: unknown }, code: string, words?: RegExp) => {
    const err = await useAsset(deps(), A, decisionId, body).then(() => null, (e) => e);
    expect(err).toMatchObject({ code });
    if (words) expect(String(err.message)).toMatch(words);
  };

  it("no asset id", async () => { await refused({}, "bad_request"); });

  it("a kit that already has media: use Swap", async () => {
    const first = row();
    library.set(A, [first]);
    await useAsset(deps(), A, decisionId, { assetId: first.id });
    const second = row();
    library.set(A, [first, second]);
    await refused({ assetId: second.id }, "kit_has_media", /use Swap/);
  });

  it("an asset that is not hers is not in her library", async () => {
    await refused({ assetId: library.get(B)![0].id }, "unavailable", /isn't in your library/);
  });

  it("one still being read says to try again in a minute", async () => {
    const unread = row({ vision: null });
    library.set(A, [unread]);
    await refused({ assetId: unread.id }, "untagged", /try again in a minute/i);
  });

  it("an asset she isn't in is refused, in words she can act on", async () => {
    const notHer = row({ vision: { athlete_present: false, subject: "another_person" }, athletePresent: false });
    library.set(A, [notHer]);
    await refused({ assetId: notHer.id }, "athlete_not_in_it", /Pick one you're in/);
  });

  it("a clip into a post the moment made a photo post", async () => {
    // A kit whose moment fixed the format to feed.
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Opener" }, claim: "The opener is on the 20th.", type: "found", source: { url: "https://example.org/s" }, date: "2026-10-20", confidence: 0.9, runId: null, topic: "moment" }]);
    await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Opener", why: "w", evidence: [{ kind: "fact", factId: fact.id }],
      detail: { kind: "moment", whyNow: "Soon.", idea: { hook: "Ready.", format: "feed", platform: "instagram", timing: "the day before" }, brief: { show: "a calm portrait", captionAngle: "Ready", avoid: "" }, mediaNeeds: "a calm portrait" } });
    decisionId = await emptyKit({ event: { factId: fact.id, label: "Opener", date: "2026-10-20", precision: "day" } });
    const c = clip(10);
    library.set(A, [c]);
    await refused({ assetId: c.id }, "format_mismatch", /needs a photo/);
  });
});

describe("U3: tenancy", () => {
  it("another athlete's action is not found", async () => {
    const imported = clip(10);
    library.set(B, [imported]);
    const err = await useAsset(deps(), B, decisionId, { assetId: imported.id }).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: "not_found" });
  });
});

describe("U4: what a post needs", () => {
  it("in the post's own words, and a clip when the moment made it a reel", async () => {
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Final" }, claim: "The final is on the 21st.", type: "found", source: { url: "https://example.org/f" }, date: "2026-10-21", confidence: 0.9, runId: null, topic: "moment" }]);
    await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Final", why: "w", evidence: [{ kind: "fact", factId: fact.id }],
      detail: { kind: "moment", whyNow: "Soon.", idea: { hook: "Here we go.", format: "reel", platform: "instagram", timing: "the day before" }, brief: { show: "warm-up", captionAngle: "Go", avoid: "" }, mediaNeeds: "a short clip of the warm-up" } });
    const id = await emptyKit({ event: { factId: fact.id, label: "Final", date: "2026-10-21", precision: "day" } });
    expect(await postNeeds(store, async () => [], A, id)).toEqual({ lookingFor: "a short clip of the warm-up", kind: "videos" });
  });

  it("no moment: what the post shows, and both photos and videos", async () => {
    expect(await postNeeds(store, async () => [], A, decisionId)).toEqual({ lookingFor: "a sprint start, a hard rep, the walk back.", kind: "all" });
  });

  it("another athlete's action, or something that is not a post, is null", async () => {
    expect(await postNeeds(store, async () => [], B, decisionId)).toBeNull();
    expect(await postNeeds(store, async () => [], A, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
