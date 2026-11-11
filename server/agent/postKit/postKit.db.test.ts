/**
 * postKit.db.test.ts — Track E end to end on PGlite: the real library port (services/mediaSearch.ts searchMedia, the
 * caster's loadCastable through herPhoto / herClip), the real dbStore, the post-kit routes over HTTP, and the plan
 * workflow's post_kits step on the real runner. Mocked at the network boundaries only: embedText (one fixed vector),
 * signedUrl, OpenAI (the plan's fake answer) and Gemini (the re-rank's fake answer).
 *
 *   P1 tenancy and "the athlete's own media only": a made-here still, a deleted photo, a reference and another
 *      athlete's photo never reach the re-rank — only the athlete's camera photo and clip do
 *   P2 the routes: build, read, swap, caption, posted ("I posted it"); another athlete gets 404 on every route and
 *      cannot swap in an asset that is not on the kit's own shortlist
 *   P3 the plan_refresh workflow (v2) builds the kit for the plan's new post action when AGENT_POST_KITS is on
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaEmbed", () => ({ embedText: jest.fn(async () => [1, 0, 0]), cosine: () => 1 }));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import { mediaAssets } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { fakeResponses, skillOf, unfencedInput } from "../../testUtils/agentModel";
import { getRun } from "../../workflow/runner";
import { setGeminiClient } from "../geminiProvider";
import { requestPlanRefresh } from "../plan/triggers";
import "../plan/workflow";
import { setResponsesTransport } from "../research/llm";
import { dbStore } from "../research/dbStore";
import { agentPostKitRouter } from "./routes";
import { fakeGemini, postAction } from "./testRows";

let server: Server;
let base = "";
let A = "";
let B = "";
const ids: Record<string, string> = {};
const saved = { plan: process.env.AGENT_PLAN, kits: process.env.AGENT_POST_KITS };

const vision = (description: string, over: Record<string, unknown> = {}) => ({
  athlete_present: true, subject: "the_athlete", athlete_prominence: 0.8, shot_type: "action", description, brands_visible: [],
  aesthetic_quality: 0.8, brand_safe: true, content_flags: {}, setting: "track", attire: "kit", vibe: "focused", hero_suitability: 0.8,
  disposition: "as_is", edit_note: "", reason: "r", ...over,
});

async function asset(owner: string, over: Record<string, unknown>, description: string, visionOver: Record<string, unknown> = {}): Promise<string> {
  const [r] = await db.insert(mediaAssets).values({
    athlete_id: owner, platform: "studio", origin: "upload", media_type: "IMAGE", status: "stored",
    gcs_path: `athletes/${owner}/${randomUUID()}.jpg`, content_type: "image/jpeg", ingested_at: new Date(),
    metadata: { vision: vision(description, visionOver), embedding: [1, 0, 0] }, ...over,
  } as never).returning({ id: mediaAssets.id });
  return r.id;
}

async function call(as: string, method: string, path: string, body?: unknown) {
  (globalThis as any).__TEST_ATHLETE_ID = as;
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function postDecision(athleteId: string, what = "Training clip"): Promise<string> {
  const goal = await dbStore.insertGoal(athleteId, { text: "Grow my audience", source: "said", decisionId: null });
  const d = await dbStore.insertDecision(athleteId, { runId: null, skillId: "plan", kind: "action", suggested: what, why: "w", evidence: [], detail: postAction({ what }) as unknown as Record<string, unknown>, goalId: goal.id });
  return d.id;
}

let seen: string[][] = [];
beforeAll(async () => {
  process.env.AGENT_POST_KITS = "true";
  await initTestDb();
  A = await seedAthlete("Pat Example");
  B = await seedAthlete("Rival Private");
  ids.camera = await asset(A, {}, "camera photo of the athlete");
  ids.clip = await asset(A, { media_type: "VIDEO", content_type: "video/mp4", gcs_path: `athletes/${A}/c.mp4`, gcs_thumb_path: `athletes/${A}/c.jpg`, duration_seconds_precise: 9 }, "camera clip of the athlete", { beats: [{ start_s: 0, end_s: 4, description: "warm-up" }, { start_s: 4, end_s: 9, description: "the sprint" }] });
  ids.madeHere = await asset(A, { origin: "generated", generation_job_id: randomUUID() }, "made-here still of the athlete");
  ids.deleted = await asset(A, { deleted_at: new Date() }, "deleted photo of the athlete");
  ids.reference = await asset(A, { origin: "reference" }, "a reference picture");
  ids.theirs = await asset(B, {}, "another athlete's photo");
  fakeGemini((input, skillId) => {
    if (skillId === "post-kit/ideas") {
      seen.push(input.assets.map((a: any) => a.description));
      return { ideas: input.assets.slice(0, 1).map((a: any) => ({ asset_refs: [a.ref], moment_ref: "", hook: "A hook.", format: "feed", platform: input.platforms[0], timing: "this week", show: "it", caption_angle: "c", avoid: "", media_needs: "m" })) };
    }
    seen.push(input.candidates.map((c: any) => c.description));
    const pick = (w: string) => input.candidates.filter((c: any) => c.description.includes(w)).map((c: any) => c.ref);
    return { picks: [...pick("camera clip"), ...pick("camera photo")].map((ref, i) => ({ ref, segment: i === 0 ? "S1" : "", reason: "r" })), none_fit: false, none_fit_reason: "", look_preset: "natural", music_mood: "hype" };
  });
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", agentPostKitRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  setGeminiClient(null);
  setResponsesTransport(null);
  for (const [k, v] of [["AGENT_PLAN", saved.plan], ["AGENT_POST_KITS", saved.kits]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

test("P1 + P2: build over HTTP from the athlete's own media only; read, swap, caption; tenancy on every route", async () => {
  seen = [];
  const id = await postDecision(A);
  const built = await call(A, "POST", `/agent/actions/${id}/post-kit`);
  expect(built.status).toBe(200);
  expect(built.body.outcome).toMatchObject({ status: "built", assets: 2 });
  expect(seen).toHaveLength(1);
  expect([...seen[0]].sort()).toEqual(["camera clip of the athlete", "camera photo of the athlete"]);
  const kit = built.body.kit as PostKit;
  expect(kit.assets.map((a) => [a.assetId, a.mediaType, a.clip])).toEqual([[ids.clip, "clip", { startSec: 4, endSec: 9, from: "beat" }], [ids.camera, "photo", null]]);
  expect(built.body.state).toBe("made");
  expect(built.body.media.map((m: any) => [m.assetId, m.available])).toEqual([[ids.clip, true], [ids.camera, true]]);

  const stored = (await dbStore.getDecision(A, id))!.detail as unknown as ActionDecisionDetail;
  expect(stored).toMatchObject({ state: "made", prepared: { studioItemId: id, postKit: { contract: "post-kit/1" } } });

  // Building again does nothing: the kit is made.
  expect((await call(A, "POST", `/agent/actions/${id}/post-kit`)).body.outcome).toEqual({ status: "exists", decisionId: id });

  const caption = await call(A, "PATCH", `/agent/actions/${id}/post-kit/caption`, { text: "Mine now #own" });
  expect(caption.status).toBe(200);
  expect(caption.body.kit.caption).toEqual({ text: "Mine now #own", hashtags: ["#own"], edited: true });

  // Another athlete: not found everywhere; nothing changed.
  for (const [m, p, b] of [["GET", "", undefined], ["POST", "", undefined], ["PATCH", "/caption", { text: "x" }], ["POST", "/swap", { replace: ids.camera, with: ids.theirs }], ["POST", "/posted", undefined]] as const) {
    expect([m, p, (await call(B, m, `/agent/actions/${id}/post-kit${p}`, b)).status]).toEqual([m, p, 404]);
  }
  // The athlete cannot swap in another athlete's asset, a made-here still or a deleted one: none is on the shortlist.
  for (const w of [ids.theirs, ids.madeHere, ids.deleted]) {
    const r = await call(A, "POST", `/agent/actions/${id}/post-kit/swap`, { replace: ids.camera, with: w });
    expect([r.status, r.body.code]).toEqual([400, "not_on_shortlist"]);
  }
  expect((await call(A, "GET", `/agent/actions/${id}/post-kit`)).body.kit.caption.text).toBe("Mine now #own");

  // "I posted it": answers the action; read-only afterwards; a second tap answers the current read (idempotent).
  const posted = await call(A, "POST", `/agent/actions/${id}/post-kit/posted`);
  expect(posted.status).toBe(200);
  expect(posted.body.state).toBe("done");
  expect((await call(A, "PATCH", `/agent/actions/${id}/post-kit/caption`, { text: "late" }))).toMatchObject({ status: 409, body: { code: "done" } });
  expect((await call(A, "POST", `/agent/actions/${id}/post-kit/posted`))).toMatchObject({ status: 200, body: { state: "done" } });
}, 60_000);

test("P3: the plan_refresh workflow's post_kits step builds the kit for the plan's new post action", async () => {
  process.env.AGENT_PLAN = "true";
  seen = [];
  await db.delete(mediaAssets);
  const C = await seedAthlete("Workflow Example");
  await asset(C, {}, "camera photo of the athlete");
  await dbStore.insertFacts(C, [{ subject: { kind: "athlete", name: "Workflow Example" }, claim: "Workflow Example won the final.", type: "found", source: { url: "https://example.org/final" }, date: "2026-05-01", confidence: 0.9, runId: null, topic: "achievement" }]);
  await dbStore.writeBrief(C, { summary: "S", runId: null, factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, sections: [] });
  const goalId = (await dbStore.insertGoal(C, { text: "Grow my audience", source: "said", decisionId: null, horizon: "now" })).id;
  setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) !== "plan") throw new Error(`unexpected skill ${skillOf(body)}`);
    const f = /^(F\d+) \|[^\n]*won the final/m.exec(unfencedInput(body.input))![1];
    return { json: {
      contract: "plan/1", stage_read: { band: "developing", why: "w" }, recommended_goals: [],
      game_plans: [{ goal_ref: `G:${goalId}`, lines: ["Post twice a week."], kept_athlete_text: false }],
      actions: [{ goal_ref: `G:${goalId}`, kind: "post", what: "Final recap", why: "Fresh news.", due_on: null, event_ref: null, button: "post", deliverable: { type: "post_brief", title: "Recap", body: "Caption: What a final.\nShots: the finish.", target: null, platform: "instagram", thread_ref: null, connector: null }, fact_keys: [f] }],
      goal_notes: [], missing: [], path_note: "p",
    } };
  }));
  const r = await requestPlanRefresh(C, { trigger: "event", reason: "test", immediate: true, idempotencyKey: "plan:postkit:wf" });
  expect(r).toMatchObject({ started: true });
  const wf = (await getRun((r as any).runId))!;
  expect(wf.steps.map((s) => [s.step, s.status])).toEqual([["wait", "done"], ["plan", "done"], ["post_kits", "done"], ["tell", "done"]]);
  expect(wf.steps.find((s) => s.step === "post_kits")!.output).toMatchObject({ status: "done", built: 1, failed: 0 });
  const [action] = await dbStore.listDecisions(C, { kinds: ["action"] });
  const det = action.detail as unknown as ActionDecisionDetail;
  expect(det).toMatchObject({ state: "made", prepared: { studioItemId: action.id } });
  expect((det.prepared!.postKit as PostKit).caption.text).toBe("What a final.");
  const runs = await dbStore.listRunsSince(C, { since: new Date(Date.now() - 3_600_000).toISOString(), skillId: "post-kit/match" });
  expect(runs.map((x) => [x.status, x.parentRef])).toEqual([["completed", `workflow:${(r as any).runId}:post_kit:${action.id}`]]);
}, 60_000);

test("P4: the daily ideas sweep — athletes with a current Brief and new media; the athlete's own unused media only", async () => {
  seen = [];
  await db.delete(mediaAssets);
  const D = await seedAthlete("Ideas Example");
  await dbStore.writeBrief(D, { summary: "S", runId: null, factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, sections: [] });
  const mine = await asset(D, {}, "a fresh photo of the athlete");
  await asset(D, { origin: "generated", generation_job_id: randomUUID() }, "a made-here still");
  await asset(D, { deleted_at: new Date() }, "a deleted photo");
  await asset(B, {}, "another athlete's new photo");
  const { sweepPostIdeas } = await import("./ideas");
  const { dbPostKitDeps } = await import("./deps");
  const out = await sweepPostIdeas(dbPostKitDeps());
  // D has a Brief and new media; B has new media but no Brief; A and C have no media left.
  expect(out).toMatchObject({ enabled: true, checked: 1, proposed: 1, ideas: 1, failed: 0 });
  expect(seen).toEqual([["a fresh photo of the athlete"]]);
  const [idea] = await dbStore.listDecisions(D, { kinds: ["other"], skillId: "post-kit/ideas" });
  expect(idea).toMatchObject({ kind: "other", response: "pending", evidence: [{ kind: "record", table: "media_assets", id: mine }], detail: { kind: "idea", timeBound: false, status: "new" } });
  // The next sweep: nothing newer than the last pass, so the athlete is not even checked.
  expect(await sweepPostIdeas(dbPostKitDeps())).toMatchObject({ checked: 0 });

  // An athlete whose only new media can't be used is looked at once — a zero-cost checked run moves the cursor — and
  // never again until something new is tagged: no slot is taken day after day.
  const E = await seedAthlete("Unusable Example");
  await dbStore.writeBrief(E, { summary: "S", runId: null, factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, sections: [] });
  await asset(E, { origin: "generated", generation_job_id: randomUUID() }, "only a made-here still");
  seen = [];
  expect(await sweepPostIdeas(dbPostKitDeps())).toMatchObject({ checked: 1, proposed: 0, skipped: { nothing_new: 1 } });
  expect(seen).toEqual([]);
  const runs = await dbStore.listRunsSince(E, { since: new Date(Date.now() - 3_600_000).toISOString(), skillId: "post-kit/ideas" });
  expect(runs.map((r) => [r.status, r.cost.microUsd, (r.output as any).status])).toEqual([["completed", 0, "nothing_new"]]);
  expect(await sweepPostIdeas(dbPostKitDeps())).toMatchObject({ checked: 0 });
}, 60_000);

test("P5: 'new' is keyed on when the tags were written, not when the row arrived; pages are oldest first", async () => {
  await db.delete(mediaAssets);
  const F = await seedAthlete("Tag Time Example");
  const old = new Date("2020-01-01T00:00:00Z");
  const retagged = await asset(F, { ingested_at: old, metadata_updated_at: new Date("2026-10-11T10:00:00Z") }, "an old upload tagged today");
  const arrivedLate = await asset(F, { ingested_at: new Date("2026-10-11T09:00:00Z"), metadata_updated_at: new Date("2026-10-11T09:30:00Z") }, "a newer upload tagged earlier");
  await asset(F, { ingested_at: new Date("2026-10-11T08:00:00Z"), metadata_updated_at: old }, "tagged long ago");
  const { dbPostKitMedia } = await import("./media");
  const page = await dbPostKitMedia.newlyTagged(F, { at: "2026-10-11T00:00:00.000000Z", id: "" }, 10);
  expect(page.map((p) => p.row.id)).toEqual([arrivedLate, retagged]);
  expect(page.map((p) => p.taggedAt)).toEqual(["2026-10-11T09:30:00.000000Z", "2026-10-11T10:00:00.000000Z"]);
  // The cursor at a row's own tag time and id never reads that row again.
  expect((await dbPostKitMedia.newlyTagged(F, { at: page[0].taggedAt, id: page[0].row.id }, 10)).map((p) => p.row.id)).toEqual([retagged]);
  // Another athlete's newly tagged media is never theirs to page.
  expect(await dbPostKitMedia.newlyTagged(B, null, 10)).toEqual(expect.not.arrayContaining([expect.objectContaining({ row: expect.objectContaining({ id: retagged }) })]));
}, 60_000);

test("P6: the conditional write — a row that moved since it was read is left alone", async () => {
  const id = await postDecision(A, "Conditional");
  const read = (await dbStore.getDecision(A, id))!;
  await dbStore.updateDecision(A, id, { detail: { ...read.detail, what: "Moved meanwhile" } });
  expect(await dbStore.updateDecision(A, id, { detail: { ...read.detail, what: "Stale writer" }, ifUnchanged: { detail: read.detail!, response: "pending" } })).toBeNull();
  expect(((await dbStore.getDecision(A, id))!.detail as any).what).toBe("Moved meanwhile");
  const fresh = (await dbStore.getDecision(A, id))!;
  expect(await dbStore.updateDecision(A, id, { detail: { ...fresh.detail, what: "Fresh writer" }, ifUnchanged: { detail: fresh.detail!, response: "pending" } })).not.toBeNull();
  expect(((await dbStore.getDecision(A, id))!.detail as any).what).toBe("Fresh writer");
  // Another athlete can't write it, conditionally or not.
  expect(await dbStore.updateDecision(B, id, { detail: { x: 1 }, ifUnchanged: { detail: fresh.detail!, response: "pending" } })).toBeNull();
}, 60_000);
