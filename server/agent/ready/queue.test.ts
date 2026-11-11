/**
 * queue.test.ts — "Ready for you" (agent/ready/queue.ts) and its routes (agent/ready/routes.ts), on the in-memory store
 * with a fake media port; no database, no provider, no model. Made-up athletes, posts and brands.
 *
 *   Q1 ready = a built kit with media that PASSED the final guard (kit.guard), still open (pending, made), not resting:
 *      a kit before the guard, one with no media, a to_start, an answered or closed action, another athlete's — never
 *   Q2 most timely first: due soonest (today, coming, or a little past) → no due date → long past; ties newest made
 *   Q3 the item: title from the hook, the caption and its first line, the guard's disclosure, the partner, the goal,
 *      the first asset's thumbnail, the actions; `top` and `more` for Home
 *   Q4 ⋯ Not now rests it 14 days (milaCards outcome, card content): out of ready, back after; still open
 *   Q5 "I posted it" moves it from ready to posted (with the link); posted lists newest first; another athlete's is 404
 *   Q6 the routes: state checked, the session's athlete only, a bad link refused with its code, 500 on a failure
 *   Q7 ⋯ Not for me: skipped with the reason as response_reason; `lasting` saves their words as a style preference
 *      (and needs words); not on a non-post row; accepted / edited are not ⋯ taps
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import { createMemoryStore, type AgentStore } from "../research/store";
import { recordOutcome } from "../milaCards/outcomes";
import { postAction } from "../postKit/testRows";
import { listQueue, markItemPosted, rankReady } from "./queue";
import { createMemoryRightsStore, type RightsDeps } from "./rights";
import { readyQueueRouter } from "./routes";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const NOW = new Date("2026-11-10T15:00:00.000Z");
const DAY = 86_400_000;

const kit = (over: Partial<PostKit> = {}): PostKit => ({
  contract: "post-kit/1", momentDecisionId: null, idea: { hook: "Early sessions add up", format: "feed", platform: "instagram", timing: "This week" },
  formatFromMoment: false, brief: { show: "s", captionAngle: "c", avoid: "" },
  assets: [{ assetId: "asset-1", mediaType: "photo", clip: null, durationSec: null, provenance: "camera" }],
  shortlist: [], caption: { text: "The work nobody sees.\nEarly sessions add up. #training", hashtags: ["#training"], edited: false },
  treatmentPlan: { aspect: "4:5", cropToFill: true, order: ["asset-1"], trims: [], stills: [], overlayText: null, lookPreset: "natural", musicMood: null, coverFrame: null, totalSec: null },
  aiGenerationNeeded: { value: false, reason: "Built from your own photos and clips." },
  match: { runId: null, skillVersion: null, candidates: 1, costMicroUsd: 0, noneFitNote: null },
  builtAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: null },
  ...over,
});

let store: AgentStore;
let rights: ReturnType<typeof createMemoryRightsStore>;
function deps(): RightsDeps {
  return {
    store,
    rights,
    now: NOW,
    media: {
      async search() { return []; },
      async newlyTagged() { return []; },
      async load(_athleteId, ids) { return new Map(ids.filter((id) => id.startsWith("asset")).map((id) => [id, { id, gcsPath: `${id}.jpg` } as any])); },
      async urls(row) { return { thumbUrl: `https://signed.example/${row.gcsPath}`, videoUrl: null }; },
    },
  };
}

async function action(athleteId: string, det: Partial<ActionDecisionDetail>, over: { goalId?: string | null; suggested?: string } = {}) {
  const detail = postAction({ state: "made", ...det }) as unknown as Record<string, unknown>;
  return store.insertDecision(athleteId, { runId: null, skillId: "plan", kind: "action", suggested: over.suggested ?? "Post", why: "Your training gets the most saves.", evidence: [], goalId: over.goalId ?? null, detail });
}

// The queue's flag (and AGENT_POST_KITS, which it needs): "I posted it" reads a link, and ⋯ on content is taken, only while it is on.
const savedEnv = { q: process.env.CONTENT_READY_QUEUE, k: process.env.AGENT_POST_KITS };
beforeAll(() => { process.env.CONTENT_READY_QUEUE = "true"; process.env.AGENT_POST_KITS = "true"; });
afterAll(() => {
  if (savedEnv.q === undefined) delete process.env.CONTENT_READY_QUEUE; else process.env.CONTENT_READY_QUEUE = savedEnv.q;
  if (savedEnv.k === undefined) delete process.env.AGENT_POST_KITS; else process.env.AGENT_POST_KITS = savedEnv.k;
});
beforeEach(() => { store = createMemoryStore(); rights = createMemoryRightsStore(() => NOW); });

describe("Q1 what is ready", () => {
  it("only a built kit with media that passed the final guard, still open and made", async () => {
    const ready = await action(A, { prepared: { postKit: kit() } });
    await action(A, { prepared: { postKit: kit({ guard: undefined }) } });                                    // before the guard
    await action(A, { prepared: { postKit: kit({ assets: [] }) } });                                          // nothing fitted
    await action(A, { prepared: { postKit: kit({ aiGenerationNeeded: { value: true, reason: "x" } }) } });     // needs media
    await action(A, { state: "to_start" });                                                                   // nothing built
    const posted = await action(A, { prepared: { postKit: kit() } });
    await store.respondDecision(A, posted.id, "accepted", "posted");
    const expired = await action(A, { prepared: { postKit: kit() } });
    await store.respondDecision(A, expired.id, "expired", "old");
    await action(B, { prepared: { postKit: kit() } });                                                        // not theirs
    const q = await listQueue(deps(), A);
    expect(q.items.map((i) => i.id)).toEqual([ready.id]);
    expect(q).toMatchObject({ contract: "ready-queue/1", state: "ready", top: { id: ready.id }, more: 0 });
  });
});

describe("Q2 most timely first", () => {
  it("due soonest (today, coming, a little past) → no due date → long past; ties newest made", () => {
    const i = (id: string, dueOn: string | null, updatedAt = "2026-11-01T00:00:00.000Z") => ({ id, dueOn, updatedAt });
    const ranked = rankReady([
      i("long-past", "2026-10-20"), i("undated-old", null, "2026-10-01T00:00:00.000Z"), i("next-week", "2026-11-17"),
      i("today", "2026-11-10"), i("undated-new", null, "2026-11-05T00:00:00.000Z"), i("two-days-ago", "2026-11-08"),
    ], NOW);
    expect(ranked.map((x) => x.id)).toEqual(["two-days-ago", "today", "next-week", "undated-new", "undated-old", "long-past"]);
  });
});

describe("Q3 the item", () => {
  it("carries what Studio Ready and Home's one card draw", async () => {
    const goal = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
    const brand = await action(A, {
      dueOn: "2026-11-12", post: { hook: "Matchday fit check", format: "reel" } as any,
      deliverable: { type: "post_brief", title: "Fit check", body: "", target: { subjectKind: "brand", name: "  Brand One " }, platform: "instagram", thread: null, connector: null },
      prepared: { postKit: kit({ caption: { text: "#ad Matchday fit check.\nThanks @brandone", hashtags: ["#ad"], edited: true }, guard: { version: 2, at: "2026-11-02T00:00:00.000Z", disclosure: "ad" } }) },
    }, { goalId: goal.id });
    const other = await action(A, { prepared: { postKit: kit({ updatedAt: "2026-11-03T00:00:00.000Z" }) } });
    const q = await listQueue(deps(), A);
    expect(q.items.map((x) => x.id)).toEqual([brand.id, other.id]);
    expect(q.top).toEqual({
      id: brand.id, recipe: "post_kit", title: "Matchday fit check", format: "feed", platform: "instagram", dueOn: "2026-11-12",
      thumbUrl: "https://signed.example/asset-1.jpg", previewUrl: null, previewStatus: null,
      caption: { text: "#ad Matchday fit check.\nThanks @brandone", firstLine: "#ad Matchday fit check.", hashtags: ["#ad"], edited: true },
      guard: { version: 2, at: "2026-11-02T00:00:00.000Z", disclosure: "ad" },
      sponsored: { brand: "Brand One" }, moment: null, why: "Your training gets the most saves.", goal: { id: goal.id, text: "Grow my audience" },
      sourceAssetIds: ["asset-1"], actions: ["post_it", "copy_caption", "save_media", "posted", "open", "not_now", "not_for_me"], posted: null,
      rights: { missingAssetIds: ["asset-1"], sponsored: { brand: "Brand One", confirmed: false, kind: null }, disclosure: "ad", complete: false },
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(q.more).toBe(1);
    expect(q.items[1]).toMatchObject({ sponsored: null, guard: { disclosure: null }, goal: null, title: "Early sessions add up" });
  });
});

describe("Q4 ⋯ Not now", () => {
  it("rests the post 14 days out of the queue; it stays open and comes back after", async () => {
    const d = await action(A, { prepared: { postKit: kit() } });
    const r = await recordOutcome(store, A, { card: "content", ref: d.id, outcome: "not_now", reason: "After my exams" }, { addPreference: async () => null, now: () => NOW });
    expect(r).toEqual({ ok: true, receipt: expect.stringContaining("not now") });
    const row = (await store.getDecision(A, d.id))!;
    expect(row.response).toBe("pending");
    expect(row.detail!.cardTap).toEqual({ state: "not_now", at: NOW.toISOString(), until: new Date(NOW.getTime() + 14 * DAY).toISOString(), reason: "After my exams" });
    expect((await listQueue(deps(), A)).items).toEqual([]);
    expect((await listQueue({ ...deps(), now: new Date(NOW.getTime() + 15 * DAY) }, A)).items.map((i) => i.id)).toEqual([d.id]);
    // A repeat is done, not a second rest.
    expect((await recordOutcome(store, A, { card: "content", ref: d.id, outcome: "not_now" }, { addPreference: async () => null, now: () => NOW })).ok).toBe(true);
  });
});

describe("Q5 I posted it", () => {
  it("moves it from ready to posted, with the link; posted lists newest first", async () => {
    const first = await action(A, { prepared: { postKit: kit() } });
    const second = await action(A, { prepared: { postKit: kit() } });
    const r = await markItemPosted(deps(), A, first.id, { link: "https://www.instagram.com/p/Abc/" });
    expect(r.receipt).toMatch(/posted/i);
    expect(r.item).toMatchObject({ id: first.id, actions: ["open"], posted: { at: NOW.toISOString(), link: "https://www.instagram.com/p/Abc/", by: "athlete" } });
    await markItemPosted({ ...deps(), now: new Date(NOW.getTime() + DAY) }, A, second.id, {});
    expect((await listQueue(deps(), A)).items).toEqual([]);
    const posted = await listQueue(deps(), A, "posted");
    expect(posted.items.map((i) => i.id)).toEqual([second.id, first.id]);
    expect(posted).toMatchObject({ state: "posted", top: null, more: 0 });
  });

  it("another athlete's post is not found", async () => {
    const d = await action(A, { prepared: { postKit: kit() } });
    await expect(markItemPosted(deps(), B, d.id, {})).rejects.toMatchObject({ status: 404 });
    expect((await store.getDecision(A, d.id))!.response).toBe("pending");
  });
});

describe("Q7 ⋯ Not for me", () => {
  const prefs: Array<[string, unknown]> = [];
  const outcomeDeps = { addPreference: async (athleteId: string, p: unknown) => { prefs.push([athleteId, p]); return null; }, now: () => NOW };
  beforeEach(() => { prefs.length = 0; });

  it("closes it with their reason as response_reason; lasting saves their words as a style preference", async () => {
    const once = await action(A, { prepared: { postKit: kit() } });
    expect(await recordOutcome(store, A, { card: "content", ref: once.id, outcome: "never", reason: "Not this photo" }, outcomeDeps)).toEqual({ ok: true, receipt: "Taken off your list." });
    expect(await store.getDecision(A, once.id)).toMatchObject({ response: "skipped", responseReason: "not_for_me: Not this photo" });
    expect(prefs).toEqual([]);
    // A repeat is done.
    expect((await recordOutcome(store, A, { card: "content", ref: once.id, outcome: "never" }, outcomeDeps)).ok).toBe(true);

    const lasting = await action(A, { prepared: { postKit: kit() } });
    expect((await recordOutcome(store, A, { card: "content", ref: lasting.id, outcome: "never", lasting: true }, outcomeDeps))).toMatchObject({ ok: false, status: 400 });
    expect((await store.getDecision(A, lasting.id))!.response).toBe("pending");
    expect((await recordOutcome(store, A, { card: "content", ref: lasting.id, outcome: "never", reason: "No music on my training clips", lasting: true }, outcomeDeps)).ok).toBe(true);
    expect(prefs).toEqual([[A, { kind: "style", statement: "No music on my training clips", source: "said" }]]);
    expect((await listQueue(deps(), A)).items).toEqual([]);
  });

  it("a failed preference save puts the post back, so the next tap can save both", async () => {
    const d = await action(A, { prepared: { postKit: kit() } });
    await expect(recordOutcome(store, A, { card: "content", ref: d.id, outcome: "never", reason: "r", lasting: true }, { addPreference: async () => { throw new Error("db"); }, now: () => NOW })).rejects.toThrow("db");
    expect((await store.getDecision(A, d.id))!.response).toBe("pending");
  });

  it("CONTENT_READY_QUEUE off: a content tap is not a card (404) and changes nothing", async () => {
    const d = await action(A, { prepared: { postKit: kit() } });
    delete process.env.CONTENT_READY_QUEUE;
    try {
      expect(await recordOutcome(store, A, { card: "content", ref: d.id, outcome: "never", reason: "r", lasting: true }, outcomeDeps)).toMatchObject({ ok: false, status: 404 });
    } finally { process.env.CONTENT_READY_QUEUE = "true"; }
    expect((await store.getDecision(A, d.id))!.response).toBe("pending");
    expect(prefs).toEqual([]);
  });

  it("only on a made post of theirs; Post it / I posted it are not ⋯ taps", async () => {
    const notPost = await store.insertDecision(A, { runId: null, skillId: "insight", kind: "other", suggested: "x", why: "w", evidence: [], detail: {} });
    expect(await recordOutcome(store, A, { card: "content", ref: notPost.id, outcome: "never" }, outcomeDeps)).toMatchObject({ ok: false, status: 404 });
    const d = await action(A, { prepared: { postKit: kit() } });
    expect(await recordOutcome(store, B, { card: "content", ref: d.id, outcome: "never" }, outcomeDeps)).toMatchObject({ ok: false, status: 404 });
    expect(await recordOutcome(store, A, { card: "content", ref: d.id, outcome: "accepted" }, outcomeDeps)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("Q6 the routes", () => {
  let server: Server;
  let base = "";
  let failing = false;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/me", readyQueueRouter({ deps: () => { if (failing) throw new Error("boom"); return deps(); } }));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  const as = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };

  it("GET lists the session athlete's queue; state is checked", async () => {
    const d = await action(A, { prepared: { postKit: kit() } });
    await action(B, { prepared: { postKit: kit() } });
    as(A);
    const r = await fetch(`${base}/api/v1/me/engine/items`);
    expect(r.status).toBe(200);
    expect((await r.json()).items.map((i: { id: string }) => i.id)).toEqual([d.id]);
    expect((await fetch(`${base}/api/v1/me/engine/items?state=posted`)).status).toBe(200);
    const bad = await fetch(`${base}/api/v1/me/engine/items?state=working`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "bad_state" });
  });

  it("POST posted: the item and the receipt; a bad link is a 400 with its code; another athlete's is 404", async () => {
    const d = await action(A, { prepared: { postKit: kit() } });
    as(B);
    expect((await fetch(`${base}/api/v1/me/engine/items/${d.id}/posted`, { method: "POST" })).status).toBe(404);
    as(A);
    const bad = await fetch(`${base}/api/v1/me/engine/items/${d.id}/posted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "nope" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "bad_link" });
    const ok = await fetch(`${base}/api/v1/me/engine/items/${d.id}/posted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "https://www.instagram.com/p/Abc/" }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ item: { id: d.id, posted: { link: "https://www.instagram.com/p/Abc/" } } });
  });

  it("approve, list and revoke the rights words over HTTP (the session's athlete only)", async () => {
    const d = await action(A, { prepared: { postKit: kit() } });
    as(A);
    const post = (path: string, b: unknown) => fetch(`${base}/api/v1/me${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const ask = await (await post(`/engine/items/${d.id}/approve`, {})).json();
    expect(ask).toMatchObject({ approved: false, needs: { missingAssetIds: ["asset-1"] } });
    // Only a real `true` ticks a line.
    expect(await (await post(`/engine/items/${d.id}/approve`, { ownMedia: "yes" })).json()).toMatchObject({ approved: false });
    expect(await (await post(`/engine/items/${d.id}/approve`, { ownMedia: true })).json()).toMatchObject({ approved: true, caption: kit().caption.text });
    const list = await (await fetch(`${base}/api/v1/me/engine/rights`)).json();
    expect(list.attestations).toHaveLength(1);
    as(B);
    expect((await post(`/engine/rights/${list.attestations[0].id}/revoke`, {})).status).toBe(404);
    as(A);
    expect(await (await post(`/engine/rights/${list.attestations[0].id}/revoke`, {})).json()).toEqual({ revoked: true });
  });

  it("a failure answers 500, not a crash", async () => {
    failing = true;
    try {
      as(A);
      expect((await fetch(`${base}/api/v1/me/engine/items`)).status).toBe(500);
    } finally { failing = false; }
  });
});
