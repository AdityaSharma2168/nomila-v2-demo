/**
 * campaignGovernance.test.ts — the athlete's narrow governance surface over HTTP against PGlite: view purpose / scope /
 * period / eligibility, approve the current draft (materialises intents, authorizes nothing in Studio), confirm an
 * external obligation, end with a reason. Flag off ⇒ 404. No provider.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); } }));
jest.mock("../lib/mediaStore", () => ({ signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`), saveBuffer: jest.fn(), rehostFromUrl: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import studioRouter from "./studio";
import { athletes, generationJobs, studioGenerationPreviews } from "../../shared/schema";
import { createCampaignFromOrigin, proposeSpecVersion } from "../services/intelligence/campaign/store";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666"; const OTHER_ID = "99999999-8888-4777-8666-555555555555";
let server: Server; let base: string;
async function post(path: string, body?: unknown) { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }); return { status: res.status, json: (await res.json().catch(() => null)) as any }; }
async function get(path: string) { const res = await fetch(`${base}${path}`); return { status: res.status, json: (await res.json().catch(() => null)) as any }; }

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([{ id: ATHLETE_ID, full_name: "Test Athlete" }, { id: OTHER_ID, full_name: "Other" }] as never);
  const app = express(); app.use(express.json()); app.use("/", studioRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as any).__TEST_ATHLETE_ID = ATHLETE_ID;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(); });
beforeEach(() => { process.env.STUDIO_CAMPAIGN_GOVERNANCE = "true"; delete process.env.STUDIO_ENABLED; });

describe("campaign governance — the second act, reachable by her", () => {
  it("off ⇒ 404; hers only; view shows purpose, period, eligibility, current draft scope; approving materialises intents and creates nothing in Studio; confirming an access obligation; ending with a reason", async () => {
    process.env.STUDIO_CAMPAIGN_GOVERNANCE = "false";
    expect((await get("/campaigns")).status).toBe(404);
    process.env.STUDIO_CAMPAIGN_GOVERNANCE = "true";
    const { campaign } = await createCampaignFromOrigin(db, ATHLETE_ID, { version: "execution-router/0.2.0-exp", shape: "campaign", door: "recommendation", recommendationId: "rec_gov", purpose: "A match-day presence through the season.", objectiveIds: ["obj-1"], dealIds: [], brandIds: [], period: { startsOn: null, endsOn: "2026-12-15", endsWith: "objective_horizon", endsRef: "objective[obj-1]" }, constraints: [{ text: "no travel-day production", source: "recommendation" }], evidence: [] });
    const v2 = await proposeSpecVersion(db, ATHLETE_ID, campaign.id, { keep: [], add: [{ category: "content", contentFormat: "post", sourceQuote: null, quantity: 2, dueOn: null, optional: false, completesWhen: "published" }, { category: "access", sourceQuote: "one clinic", quantity: 1, dueOn: null, optional: false, completesWhen: "externally_confirmed" }], createdBy: "athlete" });
    const view = await get(`/campaigns/${campaign.id}`);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ campaign: { purpose: "A match-day presence through the season.", status: "planning" }, eligibility: { eligibility: "not_reached", basis: "period.endsOn 2026-12-15" }, approvedVersion: null });
    expect(view.json.existingWork.statement).toContain("· planning ·");   // a planning campaign IS in Existing Work — the Brain and the router must see it
    expect(view.json.currentScope).toMatchObject({ version: 2, approval: "draft", constraints: [{ text: "no travel-day production" }] });
    expect(view.json.currentScope.deliverables.map((d: any) => [d.intent.category, d.intent.completesWhen, d.progress.of])).toEqual([["content", "published", 2], ["access", "externally_confirmed", 1]]);
    (globalThis as any).__TEST_ATHLETE_ID = OTHER_ID; expect((await get(`/campaigns/${campaign.id}`)).status).toBe(404); (globalThis as any).__TEST_ATHLETE_ID = ATHLETE_ID;
    // approve: the second act — creates intents, nothing else
    const ap = await post(`/campaigns/${campaign.id}/specs/2/approve`);
    expect(ap.status).toBe(200); expect(ap.json).toMatchObject({ campaign: { status: "approved", currentSpecVersion: 2 }, alreadyApproved: false });
    expect(ap.json.creativeIntents.created).toHaveLength(2);
    expect((await db.select().from(studioGenerationPreviews)).length).toBe(0); expect((await db.select().from(generationJobs)).length).toBe(0);
    expect((await post(`/campaigns/${campaign.id}/specs/2/approve`)).json).toMatchObject({ alreadyApproved: true, creativeIntents: { created: [] } });
    expect((await post(`/campaigns/${campaign.id}/specs/1/approve`)).status).toBe(409);           // an older draft cannot be approved over the current scope
    const after = await get(`/campaigns/${campaign.id}`);
    expect(after.json.existingWork).toMatchObject({ ref: { kind: "campaign", id: campaign.id }, for: { recommendationId: "rec_gov" } });
    expect(after.json.existingWork.statement).toContain("· approved ·");
    // external confirmation closes the access obligation; a content one refuses
    const [contentD, accessD] = v2.added;
    expect((await post(`/campaigns/${campaign.id}/deliverables/${contentD.id}/confirm`)).status).toBe(409);
    expect((await post(`/campaigns/${campaign.id}/deliverables/${accessD.id}/confirm`)).json.deliverable.status).toBe("fulfilled");
    // end: needs a reason and a disposition for the open content obligation; the end is not yet reached → expired refused without override
    expect((await post(`/campaigns/${campaign.id}/end`, { because: "expired" })).status).toBe(409);
    expect((await post(`/campaigns/${campaign.id}/end`, { because: "later" })).status).toBe(400);
    const ended = await post(`/campaigns/${campaign.id}/end`, { because: "cancelled", remaining: "cancel" });
    expect(ended.status).toBe(200); expect(ended.json.campaign).toMatchObject({ status: "ended", endedBecause: "cancelled" });
    expect(ended.json.recommendationOutcome).toMatchObject({ recommendationId: "rec_gov", followed: true, result: { fulfilled: 1, of: 2 } });
    expect((await get(`/campaigns/${campaign.id}`)).json.existingWork).toBeNull();
  });
});
