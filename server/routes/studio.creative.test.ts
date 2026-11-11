/**
 * studio.creative.test.ts — the athlete vertical slice, production-shaped, over HTTP against PGlite with the provider
 * mocked: her words → CreativeIntent (Mila tool) → interpretation (direction tools, mocked) → confirmation → the
 * existing preview/generation path with `creative_intent_id` on the plan and the job. Studio's gates are exercised
 * unchanged. Synthetic athlete; no provider.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../studio/router", () => { const actual = jest.requireActual("../studio/router"); return { ...actual, generate: jest.fn() }; });
jest.mock("../studio/videoRunner", () => ({ videoTick: jest.fn(async () => ({})) }));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(async (_b: unknown, base: string) => ({ gcs_path: `${base}.png`, content_type: "image/png", bytes: 1234 })),
  rehostFromUrl: jest.fn(async (_u: string, base: string) => ({ gcs_path: `${base}.png`, content_type: "image/png", bytes: 1234 })),
}));
jest.mock("../studio/direction/propose", () => ({ proposeCampaign: jest.fn() }));

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import { generate } from "../studio/router";
import { proposeCampaign } from "../studio/direction/propose";
import { athletes, athletesCurrent, creativeIntents, generationJobs, mediaAssets, studioGenerationPreviews, studioPlans } from "../../shared/schema";
import { savePlan } from "../studio/agent/plans";
import { requestCreativeTool } from "../mila/tools/requestCreative";
import { creativeTools, getTool } from "../mila/registry";
import { creativeIntentState, getCreativeIntent } from "../services/intelligence/creative/store";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
let server: Server; let base: string;
const asUser = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };
async function post(path: string, body?: unknown) { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }); return { status: res.status, json: (await res.json().catch(() => null)) as any }; }
async function get(path: string) { const res = await fetch(`${base}${path}`); return { status: res.status, json: (await res.json().catch(() => null)) as any }; }

const proposal = (goal: string) => ({ brief: { objective: { type: "social_content", goal } }, flags: [{ path: "objective.goal", basis: "inferred", because: "she said today's win" }], sourceTool: "propose_campaign", extras: { constraints: [], concept: { angle: "the last ten minutes", feeling: "relief", line: "we held on" } } });
const proposeOk = (goal = "recap") => ({ ok: true, proposals: [proposal(goal), proposal("grow-following")], model: "m", promptVersion: "p", cost: { usd: 0 }, dropped: [], notes: [], libraryLines: [] });
const generatedResult = () => { const now = new Date().toISOString(); return { task: "image.generate", provider: "vertex", model: "gemini-3-pro-image", assets: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]).buffer, width: 1024, height: 1280 }], cost: { amountUsd: 0.1344, currency: "USD", basis: "estimated" }, timings: { startedAt: now, completedAt: now, ms: 10 }, raw: {} }; };

/** her words → intent → interpreted → confirmed (with a format when asked) — the three acts before Studio */
async function confirmedIntent(ask: string, formatClass: string | null, requestKey: string) {
  const made = (await requestCreativeTool.execute(ATHLETE_ID, { ask, requestKey })) as any;
  const interp = await post(`/studio/creative/intents/${made.intentId}/interpret`, { objective: "recap" });
  expect(interp.status).toBe(200);
  const conf = await post(`/studio/creative/intents/${made.intentId}/confirm`, { interpretationId: interp.json.interpretation.id, proposalIndex: 0, flags: interp.json.interpretation.flags, ...(formatClass ? { formatClass } : {}) });
  expect(conf.status).toBe(200);
  return made.intentId as string;
}

beforeAll(async () => {
  await initTestDb();
  await client.exec(readFileSync(join(__dirname, "..", "studio", "sql", "generationGuards.sql"), "utf8"));
  await db.insert(athletes).values([{ id: ATHLETE_ID, full_name: "Test Spike Athlete", sport: "soccer" }, { id: OTHER_ID, full_name: "Other Athlete", sport: "soccer" }] as never);
  await db.insert(athletesCurrent).values({ athlete_id: ATHLETE_ID, story_arc: "A synthetic arc for tests." } as never);
  const app = express(); app.use(express.json()); app.use("/", studioRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(); });
beforeEach(async () => {
  process.env.STUDIO_ENABLED = "true"; process.env.STUDIO_CREATIVE_INTENTS = "true"; process.env.STUDIO_VIDEO_ENABLED = "true";
  delete process.env.STUDIO_AGENT; delete process.env.STUDIO_DIRECTION_MOMENTS; delete process.env.STUDIO_BRAND_PROFILES;
  asUser(ATHLETE_ID);
  (generate as jest.Mock).mockReset().mockResolvedValue(generatedResult());
  (proposeCampaign as jest.Mock).mockReset().mockResolvedValue(proposeOk());
  await db.delete(studioGenerationPreviews); await db.delete(mediaAssets); await db.delete(generationJobs);
});

describe("the direct athlete door (Mila tool)", () => {
  it("1. her ask creates ONE intent in her words: source athlete, no objective, no brand, no lineage; 2. a retry with the same key is idempotent", async () => {
    const a = (await requestCreativeTool.execute(ATHLETE_ID, { ask: "Make a post about today's win", requestKey: "msg-1" })) as any;
    const b = (await requestCreativeTool.execute(ATHLETE_ID, { ask: "Make a post about today's win", requestKey: "msg-1" })) as any;
    expect(a).toMatchObject({ ok: true, created: true, ask: "Make a post about today's win", format: "post", next: "interpret" });
    expect(b).toMatchObject({ ok: true, created: false, intentId: a.intentId });
    const rows = await db.select().from(creativeIntents).where(eq(creativeIntents.athlete_id, ATHLETE_ID));
    expect(rows.filter((r) => r.intent_key === "athlete:key:msg-1")).toHaveLength(1);
    const i = (await getCreativeIntent(db, ATHLETE_ID, a.intentId))!;
    expect(i).toMatchObject({ source: { kind: "athlete" }, purpose: "Make a post about today's win", why: null, brandId: null, lineage: {}, format: { class: "post", fixedBy: "athlete" } });
    expect(JSON.stringify(i)).not.toMatch(/objective|recommendation|campaign/i);   // 3. no objective before interpretation; 11. nothing manufactured above it
    expect(Object.keys(i)).not.toContain("status");
    expect((await creativeIntentState(db, ATHLETE_ID, a.intentId))!.state).toBe("open");
  });
  it("the tool is declared only while the flag is on; another athlete cannot read her intent", async () => {
    expect(getTool("request_creative")?.name).toBe("request_creative");
    process.env.STUDIO_CREATIVE_INTENTS = "false";
    expect(creativeTools()).toEqual([]); expect(getTool("request_creative")).toBeUndefined();
    process.env.STUDIO_CREATIVE_INTENTS = "true";
    const a = (await requestCreativeTool.execute(ATHLETE_ID, { ask: "A reel from the away trip", requestKey: "msg-2" })) as any;
    asUser(OTHER_ID);
    expect((await get(`/studio/creative/intents/${a.intentId}`)).status).toBe(404);
  });
});

describe("interpretation and confirmation", () => {
  it("4. an unconfirmed interpretation cannot create a Studio brief; 5. a confirmation may fix an unset format; the verbatim ask is untouched", async () => {
    const made = (await requestCreativeTool.execute(ATHLETE_ID, { ask: "Something about today's win", requestKey: "msg-3" })) as any;
    expect(made.format).toBeNull();
    expect((await post("/studio/preview", { creativeIntentId: made.intentId, direction: "x", references: [] })).status).toBe(409);            // open: nothing to read yet
    // What it is for is hers to choose; without it the route asks, it does not fail.
    const asked = await post(`/studio/creative/intents/${made.intentId}/interpret`);
    expect(asked.status).toBe(400); expect(asked.json.error).toBe("needs_objective"); expect(asked.json.options).toContain("recap");
    expect(proposeCampaign as jest.Mock).not.toHaveBeenCalled();
    const interp = await post(`/studio/creative/intents/${made.intentId}/interpret`, { objective: "recap" });
    expect(interp.status).toBe(200); expect(interp.json.proposals).toBe(2);
    // her chosen code as the objective, her own words as the context — never her sentence in place of the code
    expect((proposeCampaign as jest.Mock).mock.calls[0][1]).toMatchObject({ objective: "recap", brand: null, priorContext: { sourceTool: "creative_intent", lines: ["Something about today's win"] } });
    expect((await get(`/studio/creative/intents/${made.intentId}`)).json.state).toBe("interpreted");
    const unconfirmed = await post("/studio/preview", { creativeIntentId: made.intentId, references: [] });
    expect(unconfirmed.status).toBe(409); expect(unconfirmed.json.error).toContain("Confirm");
    const conf = await post(`/studio/creative/intents/${made.intentId}/confirm`, { interpretationId: interp.json.interpretation.id, proposalIndex: 0, flags: interp.json.interpretation.flags, formatClass: "clip" });
    expect(conf.status).toBe(200); expect(conf.json.interpretation).toMatchObject({ confirmedFormatClass: "clip", confirmedConcept: { proposalIndex: 0, concept: { line: "we held on" } } });
    const i = (await getCreativeIntent(db, ATHLETE_ID, made.intentId))!;
    expect(i.ask!.verbatim).toBe("Something about today's win"); expect(i.format.class).toBeNull();
    expect((await get(`/studio/creative/intents/${made.intentId}`)).json.state).toBe("confirmed");
  });
});

describe("the adapter into Studio, plan/job lineage, derived state, withdrawal", () => {
  it("6. origin is athlete; the objective is the confirmed goal; 7. creative_intent_id reaches the plan and the job; 8. derived state moves without mutating the intent", async () => {
    const intentId = await confirmedIntent("A clip from today's win", null, "msg-4");
    const before = await db.select().from(creativeIntents).where(eq(creativeIntents.id, intentId));
    const quote = await post("/studio/preview", { creativeIntentId: intentId, references: [] });
    expect({ status: quote.status, body: quote.json }).toMatchObject({ status: 200 });
    const [stored] = await db.select().from(studioGenerationPreviews).where(eq(studioGenerationPreviews.id, quote.json.previewId));
    expect((stored.brief as any).job).toMatchObject({ origin: "athlete", objective: "recap", deliverable: "clip", creativeIntentId: intentId, direction: { statement: "A clip from today's win", untrusted: false } });
    const plan = await savePlan(ATHLETE_ID, { plan: { items: [], castCount: 0, picksWithoutHer: [], gaps: [], look: null, music: null } as any, creativeIntentId: intentId });
    expect((await db.select().from(studioPlans).where(eq(studioPlans.id, plan.id)))[0].creative_intent_id).toBe(intentId);
    const run = await post("/studio/generate", { previewId: quote.json.previewId });
    expect({ status: run.status, body: run.json }).toMatchObject({ status: 200 });
    const jobs = await db.select().from(generationJobs).where(eq(generationJobs.creative_intent_id, intentId));
    expect(jobs).toHaveLength(1); expect(jobs[0].origin).toBe("athlete");
    expect(["in_production", "produced"]).toContain((await creativeIntentState(db, ATHLETE_ID, intentId))!.state);
    expect(await db.select().from(creativeIntents).where(eq(creativeIntents.id, intentId))).toEqual(before);
  });
  it("9. withdrawal blocks new preparation (preview 409, plan 409) and deletes nothing", async () => {
    const intentId = await confirmedIntent("A clip of the celebration", null, "msg-5");
    const plan = await savePlan(ATHLETE_ID, { plan: { items: [], castCount: 0, picksWithoutHer: [], gaps: [], look: null, music: null } as any, creativeIntentId: intentId });
    expect((await post(`/studio/creative/intents/${intentId}/withdraw`)).status).toBe(200);
    expect((await get(`/studio/creative/intents/${intentId}`)).json.state).toBe("withdrawn");
    expect((await post("/studio/preview", { creativeIntentId: intentId, references: [] })).status).toBe(409);
    process.env.STUDIO_AGENT = "true";
    const p = await post("/studio/agent/plan", { prompt: "anything", creativeIntentId: intentId });
    expect({ status: p.status, body: p.json }).toMatchObject({ status: 409, body: { field: "creativeIntentId" } });
    expect((await post(`/studio/creative/intents/${intentId}/interpret`)).status).toBe(409);
    expect((await db.select().from(studioPlans).where(eq(studioPlans.id, plan.id))).length).toBe(1);
  });
  it("10. a written piece refuses honestly — Studio has no executor; 12. Studio's gates are unchanged (body may not override; flag off; scored-profile gate)", async () => {
    const written = await confirmedIntent("Write me a short piece about the season", "written", "msg-6");
    const r = await post("/studio/preview", { creativeIntentId: written, references: [] });
    expect({ status: r.status, body: r.json }).toMatchObject({ status: 422, body: { error: expect.stringContaining("unsupported executor") } });
    const clip = await confirmedIntent("A clip from training", null, "msg-7");
    expect((await post("/studio/preview", { creativeIntentId: clip, objective: "announce", references: [] })).status).toBe(400);   // objective is not the body's to set
    process.env.STUDIO_CREATIVE_INTENTS = "false";
    expect((await post("/studio/preview", { creativeIntentId: clip, references: [] })).json).toMatchObject({ error: "unknown field", field: "creativeIntentId" });
    process.env.STUDIO_CREATIVE_INTENTS = "true";
    await db.delete(athletesCurrent).where(eq(athletesCurrent.athlete_id, ATHLETE_ID));
    expect((await post("/studio/preview", { creativeIntentId: clip, references: [] })).status).toBe(409);                            // hasBeenScored, exactly as before
    await db.insert(athletesCurrent).values({ athlete_id: ATHLETE_ID, story_arc: "A synthetic arc for tests." } as never);
  });
});

describe("Slice 4 — the plan is made from her confirmed reading, and the job keeps the plan's request (M3, M4)", () => {
  it("M3: a plan with an unconfirmed request is refused and confirms nothing itself; with a confirmed one the objective comes from her reading, never the body", async () => {
    process.env.STUDIO_AGENT = "true";
    const made = (await requestCreativeTool.execute(ATHLETE_ID, { ask: "A reel from the derby", requestKey: "s4-m3-a" })) as any;
    const interp = await post(`/studio/creative/intents/${made.intentId}/interpret`, { objective: "recap" });
    expect(interp.status).toBe(200);
    const unconfirmed = await post("/studio/agent/plan", { prompt: "the derby", creativeIntentId: made.intentId });
    expect({ status: unconfirmed.status, body: unconfirmed.json }).toMatchObject({ status: 409, body: { field: "creativeIntentId", error: expect.stringContaining("Confirm") } });
    expect((await get(`/studio/creative/intents/${made.intentId}`)).json.state).toBe("interpreted");            // the plan did not confirm it
    const confirmed = await confirmedIntent("A clip from the derby", null, "s4-m3-b");
    expect((await post("/studio/agent/plan", { prompt: "the derby", objective: "announce", creativeIntentId: confirmed })).status).toBe(400); // not the body's to set
    // No objective in the body: it passes the objective check (taken from her reading) and stops at the next field —
    // proven by validation order, so no planner model is ever reached from this test.
    const next = await post("/studio/agent/plan", { prompt: "the derby", creativeIntentId: confirmed, assetIds: ["not-an-id"] });
    expect({ status: next.status, body: next.json }).toMatchObject({ status: 400, body: { field: "assetIds" } });
  });

  it("M4: a preview built from a plan carries the plan's request into the job, read from the row — not from the body", async () => {
    process.env.STUDIO_BRIEF_CARRIER = "true";
    const intentId = await confirmedIntent("A clip of the warm-up", null, "s4-m4");
    const plan = await savePlan(ATHLETE_ID, { plan: { items: [], castCount: 0, picksWithoutHer: [], gaps: [], look: null, music: null } as any, creativeIntentId: intentId });
    const quote = await post("/studio/preview", { intent: "video.generate", deliverable: "clip", objective: "recap", direction: "the warm-up", references: [], planId: plan.id });
    expect({ status: quote.status, body: quote.json }).toMatchObject({ status: 200 });
    const [stored] = await db.select().from(studioGenerationPreviews).where(eq(studioGenerationPreviews.id, quote.json.previewId));
    expect((stored.brief as any).job.creativeIntentId).toBe(intentId);
    delete process.env.STUDIO_BRIEF_CARRIER;
  });
});
