/**
 * capabilityBlock.test.ts (post kits) — the capability block in the re-rank, behind AGENT_POST_KIT_CAPABILITY_BLOCK
 * (Studio capability layer v3, PR 1a). Against the in-memory store, an in-memory library and a fake Gemini client: no
 * provider, no database.
 *
 *   M1  off: post-kit/match 1.0.0 and its input, exactly as before — no block, the same schema
 *   M2  on: post-kit/match-library, its input carries the block generated for THIS post (format, moment, candidates),
 *       the kit is built from its answer as before, and its runs count against the same weekly caps
 *   M3  the flagged skill: same tier and tools; no fixed look or music list of its own — the block and the schema carry
 *       them, both read off the library
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({ embedText: jest.fn(), cosine: () => 0 }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));

import type { ActionDecisionDetail } from "../../../shared/plan";
import { LOOK_PRESETS, type PostKit } from "../../../shared/postKit";
import { TRACK_MOODS } from "../../studio/music/tracks";
import { setGeminiClient } from "../geminiProvider";
import { modelFor } from "../models";
import { setResponsesTransport } from "../research/llm";
import { createMemoryStore, type AgentStore } from "../research/store";
import { clearJobCache, loadJob } from "../jobs";
import { buildPostKit, MATCH_LIBRARY_SCHEMA, MATCH_SCHEMA, postKitBudget, type PostKitDeps } from "./build";
import { MATCH_LIBRARY_SKILL_ID, MATCH_SKILL_ID, POST_KIT } from "./config";
import { daysUntil } from "./kit";
import { clip, fakeGemini, fakeMedia, postAction, refsWith, row } from "./testRows";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-12T15:00:00Z");

let store: AgentStore;
let library: Map<string, ReturnType<typeof row>[]>;

const deps = (): PostKitDeps => ({ store, media: fakeMedia(library).media, preferences: async () => [], now: NOW });

async function action(detail: ActionDecisionDetail = postAction()) {
  const goalId = (await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null })).id;
  return store.insertDecision(A, {
    runId: null, skillId: "plan", kind: "action", suggested: detail.what, why: "Why now.", evidence: [],
    detail: detail as unknown as Record<string, unknown>, goalId, parentDecisionId: null,
  });
}

const answer = (input: any) => ({
  picks: refsWith(input.candidates, "sprinting").map((ref) => ({ ref, segment: "S0", reason: "fits" })),
  none_fit: false, none_fit_reason: "", look_preset: "warm", music_mood: "uplifting",
});

const saved = process.env.AGENT_POST_KIT_CAPABILITY_BLOCK;
beforeEach(() => {
  store = createMemoryStore();
  library = new Map([[A, [clip(20, [[0, 5, "the athlete sprinting the final bend"]], undefined, { vision: { description: "the athlete sprinting on the track" } }), row({ vision: { description: "the athlete smiling" } })]]]);
  setResponsesTransport({ create: async () => { throw new Error("the post-kit skills never call OpenAI"); } });
  delete process.env.AGENT_POST_KIT_CAPABILITY_BLOCK;
});
afterEach(() => {
  setGeminiClient(null);
  setResponsesTransport(null);
  if (saved === undefined) delete process.env.AGENT_POST_KIT_CAPABILITY_BLOCK;
  else process.env.AGENT_POST_KIT_CAPABILITY_BLOCK = saved;
});

describe("M1: off — the re-rank is exactly what it was", () => {
  it.each([undefined, "1", "TRUE", "false"])("AGENT_POST_KIT_CAPABILITY_BLOCK=%s: post-kit/match, no block in its input", async (v) => {
    if (v !== undefined) process.env.AGENT_POST_KIT_CAPABILITY_BLOCK = v;
    const calls = fakeGemini(answer);
    const d = await action();
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect(calls.map((c) => c.skillId)).toEqual([MATCH_SKILL_ID]);
    expect(Object.keys(calls[0].input).sort()).toEqual(["candidates", "max_picks", "post"]);
  });
});

describe("M2: on — the block generated for this post", () => {
  beforeEach(() => { process.env.AGENT_POST_KIT_CAPABILITY_BLOCK = "true"; });

  it("one post-kit/match-library call; its input carries the block, with this post's facts in the header", async () => {
    const calls = fakeGemini(answer);
    const d = await action();
    const out = await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    expect(out).toMatchObject({ status: "built", assets: 1 });
    expect(calls.map((c) => c.skillId)).toEqual([MATCH_LIBRARY_SKILL_ID]);
    const block: string = calls[0].input.capabilities;
    expect(block.startsWith("WHAT YOU CAN USE — the capability library for this post")).toBe(true);
    expect(block).toContain("THIS POST: format not set yet");
    expect(block).toContain("Candidates: 1 photo, 1 clip.");
    expect(block).toMatch(/^LOOKS — one look for the whole post\n- look\.preset \| /m);
    expect(block).toMatch(/^- music\.mood \| .*\| formats: reel, story \|/m);
    expect(block).toMatch(/^NOT AVAILABLE HERE YET — do not plan, offer or promise: image\.motion\.dolly, /m);
    // The kit reads the answer exactly as before.
    const kit = ((await store.getDecision(A, d.id))!.detail as unknown as ActionDecisionDetail).prepared!.postKit as PostKit;
    expect(kit.treatmentPlan).toMatchObject({ lookPreset: "warm", musicMood: "uplifting" });
    expect(kit.match.skillVersion).toBe("1.1.0");
  });

  it("a moment ahead with a fixed format: the header says so, and the lines are filtered to the format", async () => {
    const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Home opener" }, claim: "The home opener is on the 15th.", type: "found", source: { url: "https://example.org/schedule" }, date: "2026-10-15", confidence: 0.9, runId: null, topic: "moment" }]);
    await store.insertDecision(A, {
      runId: null, skillId: "moments", kind: "other", suggested: "Home opener", why: "w", evidence: [{ kind: "fact", factId: fact.id }],
      detail: { kind: "moment", idea: { hook: "Three days out.", format: "feed", platform: "instagram", timing: "3 days before" }, brief: { show: "a calm portrait" }, mediaNeeds: "a portrait" },
    });
    library.set(A, [row({ vision: { description: "a calm portrait of the athlete" } })]);
    const calls = fakeGemini(() => ({ picks: [{ ref: "C1", segment: "", reason: "fits" }], none_fit: false, none_fit_reason: "", look_preset: "natural", music_mood: "none" }));
    const d = await action(postAction({ event: { factId: fact.id, label: "Home opener", date: "2026-10-15", precision: "day" } }));
    await buildPostKit(deps(), A, d.id, { trigger: "event", parentRef: null });
    const block: string = calls[0].input.capabilities;
    expect(block.split("\n")[1]).toBe('THIS POST: feed post, 4:5, one photo, no sound. Moment: <external_content>Home opener</external_content>, 2026-10-15, 3 days from today. Names a partner: no. Candidates: 1 photo, 0 clips.');
    expect(block).not.toMatch(/^- music\.mood /m); // a feed post plays no sound
    expect(block).not.toContain("SOUND —");
  });

  it("the week's caps count both re-rank skills: the flag that picks one never resets the week", async () => {
    for (let i = 0; i < POST_KIT.MAX_PER_WEEK; i++) {
      const id = await store.startRun({ athleteId: A, skillId: i % 2 ? MATCH_SKILL_ID : MATCH_LIBRARY_SKILL_ID, skillVersion: "1", trigger: "event", model: { provider: "gemini", model: "m", effort: "low" }, parentRef: null });
      await store.finishRun(A, id, { status: "completed", stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 1 }, steps: [], evidenceRead: [], output: null, error: null });
    }
    expect(await postKitBudget(store, A, NOW, { countKits: true })).toEqual({ ok: false, reason: "week_count" });
  });
});

describe("M3: the flagged skill and its schema", () => {
  it("same tier, effort and tools as post-kit/match; on Gemini", () => {
    clearJobCache();
    const s = loadJob(MATCH_LIBRARY_SKILL_ID);
    const base = loadJob(MATCH_SKILL_ID);
    expect({ model: s.model, effort: s.effort, tools: s.tools }).toEqual({ model: base.model, effort: base.effort, tools: base.tools });
    expect(modelFor(s).provider).toBe("gemini");
  });

  /** ⚠️ MUTATION: paste match.md's "Look and music" list back into match-library.md — this reds by name. */
  it("no hand-written capability list: the prompt names no look and no mood; it reads them from the block", () => {
    const text = loadJob(MATCH_LIBRARY_SKILL_ID).instructions;
    for (const v of [...LOOK_PRESETS, ...TRACK_MOODS]) expect([v, text.includes(`\`${v}\``)]).toEqual([v, false]);
    expect(text).toContain("`capabilities`");
    expect(text).toMatch(/LOOKS line/);
    expect(text).toMatch(/SOUND line/);
  });

  it("the schema's look and mood lists are the library's, and the shape is post-kit/match's", () => {
    const props = MATCH_LIBRARY_SCHEMA.properties as Record<string, { enum?: string[] }>;
    expect(props.look_preset.enum).toEqual([...LOOK_PRESETS]);
    expect(props.music_mood.enum).toEqual([...TRACK_MOODS, "none"]);
    expect(Object.keys(MATCH_LIBRARY_SCHEMA.properties).sort()).toEqual(Object.keys(MATCH_SCHEMA.properties).sort());
    expect(MATCH_LIBRARY_SCHEMA.required).toEqual(MATCH_SCHEMA.required);
    expect(MATCH_LIBRARY_SCHEMA.additionalProperties).toBe(false);
  });

  it("days to a moment are whole UTC days; a date that does not read is unknown", () => {
    expect(daysUntil(NOW, "2026-10-15")).toBe(3);
    expect(daysUntil(NOW, "2026-10-12")).toBe(0);
    expect(daysUntil(NOW, "2026-10-09")).toBe(-3);
    expect(daysUntil(NOW, "soon")).toBeNull();
    expect(daysUntil(NOW, null)).toBeNull();
  });
});
