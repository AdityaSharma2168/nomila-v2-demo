/**
 * studio.campaign.test.ts — a CAMPAIGN-origin CreativeIntent runs the SAME interpret → confirm → preview → generate path
 * as the athlete's, unchanged, and the job carries creative_intent_id plus the #570 §6 campaign lineage. Approval of the
 * scope authorizes nothing in Studio. HTTP over PGlite; provider mocked; synthetic athlete.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); } }));
jest.mock("../studio/router", () => { const actual = jest.requireActual("../studio/router"); return { ...actual, generate: jest.fn() }; });
jest.mock("../studio/videoRunner", () => ({ videoTick: jest.fn(async () => ({})) }));
jest.mock("../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`), saveBuffer: jest.fn(async (_b: unknown, base: string) => ({ gcs_path: `${base}.png`, content_type: "image/png", bytes: 1234 })), rehostFromUrl: jest.fn(async (_u: string, base: string) => ({ gcs_path: `${base}.png`, content_type: "image/png", bytes: 1234 })) }));
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
import { athletes, athletesCurrent, creativeIntents, generationJobs, mediaAssets, studioGenerationPreviews } from "../../shared/schema";
import { approveSpec, createCampaignFromOrigin, proposeSpecVersion } from "../services/intelligence/campaign/store";
import { materializeCreativeIntents } from "../services/intelligence/campaign/materialize";
import { creativeIntentState } from "../services/intelligence/creative/store";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666";
let server: Server; let base: string;
async function post(path: string, body?: unknown) { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }); return { status: res.status, json: (await res.json().catch(() => null)) as any }; }
const proposal = (goal: string) => ({ brief: { objective: { type: "brand_campaign", goal } }, flags: [{ path: "objective.goal", basis: "inferred", because: "the contract line" }], sourceTool: "propose_campaign", extras: { constraints: [], concept: { angle: "the launch", feeling: "lift", line: "spring, worn" } } });
const generatedResult = () => { const now = new Date().toISOString(); return { task: "image.generate", provider: "vertex", model: "gemini-3-pro-image", assets: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]).buffer, width: 1024, height: 1280 }], cost: { amountUsd: 0.1344, currency: "USD", basis: "estimated" }, timings: { startedAt: now, completedAt: now, ms: 10 }, raw: {} }; };

beforeAll(async () => {
  await initTestDb();
  await client.exec(readFileSync(join(__dirname, "..", "studio", "sql", "generationGuards.sql"), "utf8"));
  await db.insert(athletes).values([{ id: ATHLETE_ID, full_name: "Test Spike Athlete", sport: "soccer" }] as never);
  await db.insert(athletesCurrent).values({ athlete_id: ATHLETE_ID, story_arc: "A synthetic arc for tests." } as never);
  const app = express(); app.use(express.json()); app.use("/", studioRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as any).__TEST_ATHLETE_ID = ATHLETE_ID;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(); });
beforeEach(async () => {
  process.env.STUDIO_ENABLED = "true"; process.env.STUDIO_CREATIVE_INTENTS = "true"; process.env.STUDIO_VIDEO_ENABLED = "true";
  (generate as jest.Mock).mockReset().mockResolvedValue(generatedResult());
  (proposeCampaign as jest.Mock).mockReset().mockResolvedValue({ ok: true, proposals: [proposal("announce")], model: "m", promptVersion: "p", cost: { usd: 0 }, dropped: [], notes: [], libraryLines: [] });
  await db.delete(studioGenerationPreviews); await db.delete(mediaAssets); await db.delete(generationJobs);
});

describe("campaign-origin intent through the unchanged creative path", () => {
  it("8./9./10. approval materialises the intent and touches nothing in Studio; the intent runs interpret → confirm → preview → generate unchanged; the job carries creative_intent_id and the campaign lineage; origin is inbound with the contract's words", async () => {
    const { campaign } = await createCampaignFromOrigin(db, ATHLETE_ID, { version: "execution-router/0.2.0-exp", shape: "campaign", door: "recommendation", recommendationId: "rec_route", purpose: "six posts over the term", objectiveIds: ["obj-1"], dealIds: [], brandIds: [], period: { startsOn: null, endsOn: null, endsWith: "objective_horizon", endsRef: "objective[obj-1]" }, constraints: [{ text: "no competing jewellery in frame", source: "recommendation" }], evidence: [] });
    const v2 = await proposeSpecVersion(db, ATHLETE_ID, campaign.id, { keep: [], add: [{ category: "content", contentFormat: "clip", sourceQuote: "one launch clip for the spring drop", quantity: 1, dueOn: "2026-11-01", optional: false, completesWhen: "published" }], constraints: [{ text: "no competing jewellery in frame", source: "contract" }], createdBy: "athlete" });
    await approveSpec(db, ATHLETE_ID, campaign.id, 2, "athlete");
    const m = await materializeCreativeIntents(db, ATHLETE_ID, campaign.id, 2);
    expect(m.created).toHaveLength(1); const intentId = m.created[0].id;
    // 10. approval + materialisation authorized nothing: no preview, no job, no asset
    expect((await db.select().from(studioGenerationPreviews)).length).toBe(0); expect((await db.select().from(generationJobs)).length).toBe(0);
    expect((await creativeIntentState(db, ATHLETE_ID, intentId))!.state).toBe("open");
    // 8. the same path
    const interp = await post(`/studio/creative/intents/${intentId}/interpret`, { objective: "announce" }); expect(interp.status).toBe(200);
    // the objective is chosen at interpretation; the deliverable's own words travel as context, never as the code
    expect((proposeCampaign as jest.Mock).mock.calls[0][1]).toMatchObject({ objective: "announce", priorContext: { sourceTool: "creative_intent", lines: ["one launch clip for the spring drop"] } });
    expect((await post("/studio/preview", { creativeIntentId: intentId, references: [] })).status).toBe(409);       // unconfirmed
    const conf = await post(`/studio/creative/intents/${intentId}/confirm`, { interpretationId: interp.json.interpretation.id, proposalIndex: 0, flags: [] }); expect(conf.status).toBe(200);
    const quote = await post("/studio/preview", { creativeIntentId: intentId, references: [] });
    expect({ status: quote.status, body: quote.json }).toMatchObject({ status: 200 });
    const [stored] = await db.select().from(studioGenerationPreviews).where(eq(studioGenerationPreviews.id, quote.json.previewId));
    expect((stored.brief as any).job).toMatchObject({ origin: "inbound", objective: "announce", deliverable: "clip", creativeIntentId: intentId, campaignLineage: { specId: v2.spec.id, specVersion: 2, campaignDeliverableId: v2.added[0].id }, direction: { set: "given", untrusted: true } });
    expect((stored.brief as any).job.direction.statement).toContain("one launch clip for the spring drop");
    expect(JSON.stringify(stored.brief)).not.toContain("six posts over the term");                                   // no campaign purpose on the job
    const run = await post("/studio/generate", { previewId: quote.json.previewId });
    expect({ status: run.status, body: run.json }).toMatchObject({ status: 200 });
    // 9. lineage on the job
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.creative_intent_id, intentId));
    expect(job).toMatchObject({ origin: "inbound", creative_intent_id: intentId, source_spec_id: v2.spec.id, source_spec_version: 2, campaign_deliverable_id: v2.added[0].id });
    expect(["in_production", "produced"]).toContain((await creativeIntentState(db, ATHLETE_ID, intentId))!.state);
    expect((await db.select().from(creativeIntents).where(eq(creativeIntents.id, intentId)))[0].withdrawn_at).toBeNull();
  });
});
