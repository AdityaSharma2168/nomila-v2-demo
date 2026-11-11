/**
 * contract.test.ts — the post kit's contract (shared/postKit.ts, design §9 and §11), pinned:
 *
 *   C1 a built kit has exactly the contract's fields at every level, and survives a jsonb round trip unchanged
 *   C2 it lives on the action's own row: the Goals read shows the action as a made post_kit that opens its Studio item
 *   C3 the GET response's shape
 *   C4 the two skills: cheap tier (Gemini Flash), low effort, no tools; their fixed lists (look presets, music moods,
 *      formats) are the code's own lists, in the skill text and in the strict response schemas
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));

import type { ActionDecisionDetail } from "../../../shared/plan";
import { LOOK_PRESETS, POST_FORMATS, POST_KIT_CONTRACT, type PostKit } from "../../../shared/postKit";
import { TRACK_MOODS } from "../../studio/music/tracks";
import { setGeminiClient } from "../geminiProvider";
import { modelFor } from "../models";
import { actionView } from "../plan/goals";
import { createMemoryStore } from "../research/store";
import { clearJobCache, loadJob } from "../jobs";
import { buildPostKit, MATCH_SCHEMA } from "./build";
import { IDEAS_SKILL_ID, MATCH_SKILL_ID } from "./config";
import { GUARD_VERSION } from "./finalGuard";
import { readPostKit } from "./edit";
import { IDEAS_SCHEMA } from "./ideas";
import { clip, fakeGemini, fakeMedia, postAction, refsWith, row } from "./testRows";

const A = "11111111-1111-4111-8111-111111111111";
const keys = (o: object) => Object.keys(o).sort();

async function builtKit() {
  const store = createMemoryStore();
  const c = clip(14, [[0, 5, "the start"], [5, 11, "the finish line"]], undefined, { vision: { description: "the athlete crossing the line" } });
  const p = row({ vision: { description: "the athlete with the medal" } });
  const library = new Map([[A, [c, p, row()]]]);
  fakeGemini((input) => ({ picks: [...refsWith(input.candidates, "crossing"), ...refsWith(input.candidates, "medal")].map((ref, i) => ({ ref, segment: i === 0 ? "S1" : "", reason: "r" })), none_fit: false, none_fit_reason: "", look_preset: "vivid", music_mood: "uplifting" }));
  const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
  const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Finish-line post", why: "Timed to the result.", evidence: [], detail: postAction() as unknown as Record<string, unknown>, goalId: goal.id });
  const deps = { store, media: fakeMedia(library).media, preferences: async () => [] };
  await buildPostKit(deps, A, d.id, { trigger: "event", parentRef: null });
  const decision = (await store.getDecision(A, d.id))!;
  return { store, deps, decision, kit: (decision.detail as unknown as ActionDecisionDetail).prepared!.postKit as PostKit };
}

afterEach(() => setGeminiClient(null));

test("C1: a built kit has exactly the contract's fields, and is jsonb-safe", async () => {
  const { kit } = await builtKit();
  expect(keys(kit)).toEqual(["aiGenerationNeeded", "assets", "brief", "builtAt", "caption", "contract", "formatFromMoment", "guard", "idea", "match", "momentDecisionId", "shortlist", "treatmentPlan", "updatedAt"]);
  expect(kit.contract).toBe(POST_KIT_CONTRACT);
  // The final guard's mark (additive; absent on a kit built before it).
  expect(kit.guard).toEqual({ version: GUARD_VERSION, at: expect.any(String), disclosure: null });
  expect(keys(kit.idea)).toEqual(["format", "hook", "platform", "timing"]);
  expect(POST_FORMATS).toContain(kit.idea.format);
  expect(keys(kit.brief)).toEqual(["avoid", "captionAngle", "show"]);
  expect(kit.assets.length).toBeGreaterThanOrEqual(1);
  expect(kit.assets.length).toBeLessThanOrEqual(3);
  for (const a of kit.assets) expect(keys(a)).toEqual(["assetId", "clip", "durationSec", "mediaType", "provenance"]);
  expect(keys(kit.assets[0].clip!)).toEqual(["endSec", "from", "startSec"]);
  expect(keys(kit.caption)).toEqual(["edited", "hashtags", "text"]);
  expect(keys(kit.treatmentPlan)).toEqual(["aspect", "coverFrame", "cropToFill", "lookPreset", "musicMood", "order", "overlayText", "stills", "totalSec", "trims"]);
  expect(keys(kit.treatmentPlan.trims[0])).toEqual(["assetId", "endSec", "startSec"]);
  expect(keys(kit.treatmentPlan.stills[0])).toEqual(["assetId", "holdSec"]);
  expect(keys(kit.treatmentPlan.coverFrame!)).toEqual(["assetId", "atSec"]);
  expect(LOOK_PRESETS).toContain(kit.treatmentPlan.lookPreset);
  expect(TRACK_MOODS as readonly string[]).toContain(kit.treatmentPlan.musicMood);
  expect(kit.aiGenerationNeeded).toEqual({ value: false, reason: expect.any(String) });
  expect(keys(kit.match)).toEqual(["candidates", "costMicroUsd", "noneFitNote", "runId", "skillVersion"]);
  // The order is the assets' order, every trim is a clip of the kit, every still a photo of it.
  expect(kit.treatmentPlan.order).toEqual(kit.assets.map((a) => a.assetId));
  expect(kit.treatmentPlan.trims.map((t) => t.assetId)).toEqual(kit.assets.filter((a) => a.clip).map((a) => a.assetId));
  expect(kit.treatmentPlan.stills.map((s) => s.assetId)).toEqual(kit.assets.filter((a) => !a.clip).map((a) => a.assetId));
  expect(JSON.parse(JSON.stringify(kit))).toEqual(kit);
});

test("C2: the kit lives on the action's own row; the Goals read shows a made post_kit that opens it", async () => {
  const { decision } = await builtKit();
  const det = decision.detail as unknown as ActionDecisionDetail;
  expect(det).toMatchObject({ kind: "post", state: "made", prepared: { studioItemId: decision.id } });
  expect(actionView(decision)).toMatchObject({ id: decision.id, kind: "post_kit", state: "made", studioItemId: decision.id, open: { screen: "post-kit", params: { id: decision.id } }, button: "post", startPrompt: null });
});

test("C3: the GET response's shape", async () => {
  const { deps, decision } = await builtKit();
  const r = await readPostKit(deps, A, decision.id);
  expect(keys(r)).toEqual(["contract", "decisionId", "goal", "kit", "media", "moment", "preview", "state", "why"]);
  // No preview was asked for (AGENT_POST_KIT_RENDER off): null, never absent.
  expect(r.preview).toBeNull();
  for (const m of r.media) expect(keys(m)).toEqual(["assetId", "available", "inKit", "mediaType", "thumbUrl", "videoUrl"]);
});

test("C4: the skills — cheap tier, low effort, no tools; their fixed lists are the code's", () => {
  clearJobCache();
  for (const id of [MATCH_SKILL_ID, IDEAS_SKILL_ID]) {
    const s = loadJob(id);
    expect({ id, model: s.model, effort: s.effort, tools: s.tools }).toEqual({ id, model: "cheap", effort: "low", tools: [] });
    expect(modelFor(s).provider).toBe("gemini");
  }
  const match = loadJob(MATCH_SKILL_ID).instructions;
  for (const look of LOOK_PRESETS) expect(match).toContain(`\`${look}\``);
  for (const mood of [...TRACK_MOODS, "none"]) expect(match).toContain(`\`${mood}\``);
  const props = MATCH_SCHEMA.properties as Record<string, { enum?: string[] }>;
  expect(props.look_preset.enum).toEqual([...LOOK_PRESETS]);
  expect(props.music_mood.enum).toEqual([...TRACK_MOODS, "none"]);
  const ideas = loadJob(IDEAS_SKILL_ID).instructions;
  for (const f of POST_FORMATS) expect(ideas).toContain(`\`${f}\``);
  const ideaProps = ((IDEAS_SCHEMA.properties.ideas as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties);
  expect(ideaProps.format.enum).toEqual([...POST_FORMATS]);

  // Strict schemas: every object closes additionalProperties and requires every key it lists.
  const strict = (s: any): void => {
    if (s?.type === "object") {
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(strict);
    }
    if (s?.type === "array") strict(s.items);
  };
  strict(MATCH_SCHEMA);
  strict(IDEAS_SCHEMA);
});
