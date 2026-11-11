/**
 * items.test.ts — the Studio library's data (agent/studio/items.ts), on the in-memory store, a fake media port and a
 * fake pitches list; no database, no provider.
 *
 *   I1 deckItems: today's decks, exactly the client's own former fallback mapping (status, hostedUrl vs PitchDetail)
 *   I2 postKitItems: a built kit only (to_start is not listed), made -> draft, done -> published, the first asset's
 *      thumbnail, the goal it serves; dark behind AGENT_POST_KITS (nothing, same as before this route existed)
 *   I3 listStudioItems: decks and post kits together, newest first
 *   I4 closed actions (expired, skipped) are not listed: their kit screen would only say "no longer open"
 *   I5 one goals read and one media read for every kit (not one per kit); at most POST_KIT_ITEMS_MAX, newest first
 */
jest.mock("../../db", () => ({ db: {} }));

import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import type { Pitch } from "../../services/pitches";
import { createMemoryStore, type AgentStore } from "../research/store";
import { deckItems, listStudioItems, POST_KIT_ITEMS_MAX, type StudioItemsDeps } from "./items";

const A = "00000000-0000-4000-8000-0000000000aa";
const saved = process.env.AGENT_POST_KITS;
afterEach(() => { if (saved === undefined) delete process.env.AGENT_POST_KITS; else process.env.AGENT_POST_KITS = saved; });

const pitch = (over: Partial<Pitch> = {}): Pitch => ({
  brandId: 1, brandName: "Shop One", brandLogo: null, brandDomain: null, category: null, status: "ready", stale: false,
  opensCount: 0, lastOpenedAt: null, sentAt: null, generatedAt: "2026-10-01T00:00:00.000Z", dealId: null, hostedUrl: null, coverPath: null,
  ...over,
});

test("I1: deckItems — status words, a hosted deck opens its url, otherwise PitchDetail", () => {
  expect(deckItems([pitch()])[0]).toMatchObject({ id: "deck-1", kind: "deck", title: "Shop One", status: "approved", open: { screen: "PitchDetail", params: { brandId: 1, brandName: "Shop One" } } });
  expect(deckItems([pitch({ status: "sent" })])[0].status).toBe("published");
  expect(deckItems([pitch({ status: "opened", opensCount: 3 })])[0]).toMatchObject({ status: "published", meta: "Opened 3 times" });
  expect(deckItems([pitch({ status: "tailoring" })])[0].status).toBe("draft");
  expect(deckItems([pitch({ hostedUrl: "https://nomila.co/d/1" })])[0].open).toEqual({ url: "https://nomila.co/d/1" });
});

const kit = (over: Partial<PostKit> = {}): PostKit => ({
  contract: "post-kit/1", momentDecisionId: null, idea: { hook: "h", format: "feed", platform: "instagram", timing: "This week" },
  formatFromMoment: false, brief: { show: "s", captionAngle: "c", avoid: "" },
  assets: [{ assetId: "asset-1", mediaType: "photo", clip: null, durationSec: null, provenance: "camera" }],
  shortlist: [], caption: { text: "A caption.", hashtags: [], edited: false },
  treatmentPlan: { aspect: "4:5", cropToFill: true, order: ["asset-1"], trims: [], stills: [], overlayText: null, lookPreset: "natural", musicMood: null, coverFrame: null, totalSec: null },
  aiGenerationNeeded: { value: false, reason: "Built from your own photos and clips." },
  match: { runId: null, skillVersion: null, candidates: 1, costMicroUsd: 0, noneFitNote: null },
  builtAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const postAction = (over: Partial<ActionDecisionDetail> = {}): ActionDecisionDetail => ({
  kind: "post", what: "Opener post", button: "post", dueOn: null, event: null, state: "to_start",
  deliverable: { type: "post_brief", title: "Opener post", body: "", target: null, platform: "instagram", thread: null, connector: null },
  ...over,
});

function deps(store: AgentStore, pitches: Pitch[] = []): StudioItemsDeps {
  return {
    store,
    media: {
      async load(_athleteId, ids) { return new Map(ids.filter((id) => id === "asset-1").map((id) => [id, { id, gcsPath: "a.jpg" } as any])); },
      async urls(row) { return { thumbUrl: `https://signed.example/${row.gcsPath}`, videoUrl: null }; },
    },
    pitches: async () => pitches,
  };
}

test("I2: postKitItems — to_start is not listed; made -> draft, done -> published; the goal it serves; dark off", async () => {
  process.env.AGENT_POST_KITS = "true";
  const store = createMemoryStore();
  const goal = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
  const toStart = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Opener post", why: "w", evidence: [], goalId: goal.id, detail: postAction() as unknown as Record<string, unknown> });
  const made = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Training clip", why: "w", evidence: [], goalId: goal.id, detail: postAction({ what: "Training clip", state: "made", prepared: { postKit: kit() } }) as unknown as Record<string, unknown> });
  const done = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Final recap", why: "w", evidence: [], goalId: goal.id, detail: postAction({ what: "Final recap", state: "made", prepared: { postKit: kit({ updatedAt: "2026-10-05T00:00:00.000Z" }) } }) as unknown as Record<string, unknown> });
  await store.respondDecision(A, done.id, "accepted", null);

  const items = await listStudioItems(A, deps(store));
  const kits = items.filter((i) => i.kind === "post_kit");
  expect(kits.map((i) => i.id)).toEqual([done.id, made.id]); // newest updatedAt first
  expect(kits.find((i) => i.id === made.id)).toMatchObject({ title: "Training clip", status: "draft", goal: { id: goal.id, text: "Grow my audience" }, thumbUrl: "https://signed.example/a.jpg", open: { screen: "post-kit", params: { id: made.id } } });
  expect(kits.find((i) => i.id === done.id)).toMatchObject({ title: "Final recap", status: "published" });
  expect(items.some((i) => i.id === toStart.id)).toBe(false); // nothing built yet: nothing to show

  process.env.AGENT_POST_KITS = "false";
  expect((await listStudioItems(A, deps(store))).filter((i) => i.kind === "post_kit")).toEqual([]);
});

test("I3: listStudioItems — decks and post kits together, newest updatedAt first", async () => {
  process.env.AGENT_POST_KITS = "true";
  const store = createMemoryStore();
  const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
  await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Training clip", why: "w", evidence: [], goalId: goal.id, detail: postAction({ state: "made", prepared: { studioItemId: "x", postKit: kit({ updatedAt: "2026-09-01T00:00:00.000Z" }) } }) as unknown as Record<string, unknown> });
  const items = await listStudioItems(A, deps(store, [pitch({ generatedAt: "2026-10-10T00:00:00.000Z" })]));
  expect(items.map((i) => i.kind)).toEqual(["deck", "post_kit"]);
});

const built = (store: AgentStore, what: string, updatedAt: string, goalId: string | null = null, assetId = "asset-1") =>
  store.insertDecision(A, {
    runId: null, skillId: "plan", kind: "action", suggested: what, why: "w", evidence: [], goalId,
    detail: postAction({ what, state: "made", prepared: { postKit: kit({ updatedAt, assets: [{ assetId, mediaType: "photo", clip: null, durationSec: null, provenance: "camera" }] }) } }) as unknown as Record<string, unknown>,
  });

test("I4: an expired or skipped action's kit is not listed (its screen would only say it's closed)", async () => {
  process.env.AGENT_POST_KITS = "true";
  const store = createMemoryStore();
  const open = await built(store, "Still open", "2026-10-03T00:00:00.000Z");
  const expired = await built(store, "Expired", "2026-10-04T00:00:00.000Z");
  const skipped = await built(store, "Skipped", "2026-10-05T00:00:00.000Z");
  const edited = await built(store, "Posted, edited", "2026-10-02T00:00:00.000Z");
  await store.respondDecision(A, expired.id, "expired", "not repeated");
  await store.respondDecision(A, skipped.id, "skipped", null);
  await store.respondDecision(A, edited.id, "edited", null);
  const ids = (await listStudioItems(A, deps(store))).map((i) => i.id);
  expect(ids).toEqual([open.id, edited.id]);
});

test("I5: one goals read and one media read for every kit; capped at POST_KIT_ITEMS_MAX, newest first", async () => {
  process.env.AGENT_POST_KITS = "true";
  const store = createMemoryStore();
  const goal = await store.insertGoal(A, { text: "Grow", source: "said", decisionId: null });
  const n = POST_KIT_ITEMS_MAX + 3;
  for (let i = 0; i < n; i++) {
    await built(store, `Kit ${i}`, new Date(Date.UTC(2026, 8, 1) + i * 3600_000).toISOString(), goal.id, `asset-${i}`);
  }
  const listGoals = jest.spyOn(store, "listGoals");
  const getGoal = jest.spyOn(store, "getGoal");
  const d = deps(store);
  const load = jest.spyOn(d.media, "load");
  const items = (await listStudioItems(A, d)).filter((i) => i.kind === "post_kit");
  expect(items).toHaveLength(POST_KIT_ITEMS_MAX);
  expect(items[0].title).toBe(`Kit ${n - 1}`); // the newest
  expect(items.every((i) => i.goal?.text === "Grow")).toBe(true);
  expect(listGoals).toHaveBeenCalledTimes(1);
  expect(getGoal).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
  expect((load.mock.calls[0][1] as string[]).length).toBe(POST_KIT_ITEMS_MAX);
});
