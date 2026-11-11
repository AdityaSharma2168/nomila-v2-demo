/**
 * campaign/campaign.test.ts — #570 C1 as amended, against PGlite: the recommendation-door origin writer, spec versions
 * and approval, materialisation of CreativeIntents (content only, idempotent across versions), fulfilment counts under
 * each candidate criterion (no `fulfilled` written — the criterion gap is #570's), and the Existing Work projection.
 * Synthetic athlete; no provider; no Studio call.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { eq } from "drizzle-orm";
import { athletes, creativeIntents, generationJobs, mediaAssets, studioGenerationPreviews } from "../../../../shared/schema";
import { closeTestDb, db, initTestDb } from "../../../testUtils/pgliteDb";
import type { CampaignOriginProposal } from "../brain/executionRouter";
import { creativeIntentState } from "../creative/store";
import { deriveIntentState } from "../creative/intents";
import { downstreamOf } from "../creative/store";
import { campaignWorkItem } from "./existingWork";
import { deliverableProgress } from "./fulfilment";
import { campaignIntents, materializeCreativeIntents } from "./materialize";
import { CampaignRefused, approveSpec, confirmExternally, createCampaignFromOrigin, deliverablesInScope, executionRefFor, listDeliverables, listSpecs, proposeSpecVersion } from "./store";
import type { DeliverableIntent } from "./contract";

let athleteId = "";
beforeAll(async () => { await initTestDb(); const [a] = await db.insert(athletes).values({ full_name: "Test Athlete" }).returning(); athleteId = a.id; });
afterAll(closeTestDb);

const origin = (over: Partial<CampaignOriginProposal> = {}): CampaignOriginProposal => ({ version: "execution-router/0.2.0-exp", shape: "campaign", door: "recommendation", recommendationId: "rec_test_1", purpose: "A match-day presence on her own channels through the season.", objectiveIds: ["obj-1"], dealIds: [], brandIds: [], period: { startsOn: null, endsOn: null, endsWith: "objective_horizon", endsRef: "objective[obj-1]" }, constraints: [{ text: "no travel-day production", source: "recommendation" }], evidence: [{ ref: "objective[obj-1]", how: "the season" }], ...over });
const content = (over: Partial<DeliverableIntent> = {}): DeliverableIntent => ({ category: "content", contentFormat: "post", sourceQuote: null, quantity: 1, dueOn: "2026-11-01", optional: false, brandId: null, dealDeliverableId: null, completesWhen: "cleared", ...over });

describe("origin writer — recommendation door", () => {
  it("1. creates one campaign at `planning` and one DRAFT spec v1, with no invented deliverables; lineage by reference; 3. a draft creates zero intents", async () => {
    const { campaign, spec, deliverables } = await createCampaignFromOrigin(db, athleteId, origin());
    expect(campaign).toMatchObject({ originDoor: "recommendation", status: "planning", currentSpecVersion: 1, purpose: origin().purpose, recommendationIds: ["rec_test_1"], objectiveIds: ["obj-1"], period: { endsWith: "objective_horizon", endsRef: "objective[obj-1]" } });
    expect(spec).toMatchObject({ version: 1, approval: "draft", deliverableIds: [], supersedes: null, provenance: { createdBy: "recommendation_door", origin: { recommendationId: "rec_test_1" } } });
    expect(deliverables).toEqual([]);
    expect(executionRefFor(campaign)).toEqual({ kind: "campaign", id: campaign.id });
    await expect(materializeCreativeIntents(db, athleteId, campaign.id, 1)).rejects.toThrow("draft scope creates no creative work");
    expect(await campaignIntents(db, athleteId, campaign.id)).toEqual([]);
    expect(JSON.stringify(campaign)).not.toContain("idea"); expect(["planning", "approved", "ended"]).toContain(campaign.status);
  });
  it("2. an origin without a resolved reason to end, without a purpose, or from another door cannot create a campaign", async () => {
    await expect(createCampaignFromOrigin(db, athleteId, { ...origin(), period: { startsOn: null, endsOn: null, endsWith: "objective_horizon", endsRef: "" } })).rejects.toThrow(CampaignRefused);
    await expect(createCampaignFromOrigin(db, athleteId, { ...origin(), period: null as any })).rejects.toThrow("reason to end");
    await expect(createCampaignFromOrigin(db, athleteId, origin({ purpose: "  " }))).rejects.toThrow("purpose");
    await expect(createCampaignFromOrigin(db, athleteId, { ...origin(), door: "deal" as any })).rejects.toThrow("no writer");
  });
});

describe("spec approval → CreativeIntent materialisation", () => {
  it("4. an approved one-asset scope creates exactly one intent, contract-fixed, with campaign/spec/deliverable lineage; 11. re-approval and re-materialisation create nothing", async () => {
    const { campaign } = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_one", brandIds: [42] }));
    const v2 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [content({ contentFormat: "reel", sourceQuote: "one hero video for the spring launch", dealDeliverableId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" })], createdBy: "athlete" });
    expect(v2.spec.version).toBe(2); expect(v2.added).toHaveLength(1);
    const a = await approveSpec(db, athleteId, campaign.id, 2, "athlete");
    expect(a.campaign).toMatchObject({ status: "approved", currentSpecVersion: 2 }); expect(a.spec.approval).toBe("athlete");
    const m = await materializeCreativeIntents(db, athleteId, campaign.id, 2);
    expect(m.created).toHaveLength(1);
    expect(m.created[0]).toMatchObject({ source: { kind: "campaign", ref: `campaign[${campaign.id}]` }, purpose: "one hero video for the spring launch", why: origin().purpose, brandId: 42, format: { class: "reel", quantity: 1, dueOn: "2026-11-01", fixedBy: "contract" }, lineage: { campaignId: campaign.id, specVersion: 2, campaignDeliverableId: v2.added[0].id, dealDeliverableId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", unit: 1 }, constraints: [{ text: "no travel-day production", source: "recommendation" }] });
    expect(m.created[0].intentKey).toBe(`campaign:${campaign.id}:${v2.added[0].id}:1`);
    expect(JSON.stringify(m.created[0])).not.toMatch(/deliverableIds|endsRef|"status"/);
    const again = await approveSpec(db, athleteId, campaign.id, 2, "athlete"); expect(again.alreadyApproved).toBe(true);
    const m2 = await materializeCreativeIntents(db, athleteId, campaign.id, 2); expect(m2.created).toEqual([]); expect(m2.kept).toBe(1);
    expect(await campaignIntents(db, athleteId, campaign.id)).toHaveLength(1);
  });
  it("5. a multi-asset scope creates the right count (quantity → units); 6./9. v2 adds one → exactly one new intent, earlier keep specVersion and lineage; a dropped deliverable is superseded, its unproduced intent withdrawn, nothing deleted", async () => {
    const { campaign } = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_multi" }));
    const v2 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [content(), content({ contentFormat: "reel" }), content({ contentFormat: "story", quantity: 2 })], createdBy: "athlete" });
    await approveSpec(db, athleteId, campaign.id, 2, "athlete");
    const m = await materializeCreativeIntents(db, athleteId, campaign.id, 2);
    expect(m.created).toHaveLength(4); expect(m.created.map((i) => i.lineage.unit)).toEqual([1, 1, 1, 2]);
    const before = await campaignIntents(db, athleteId, campaign.id);
    const [d1, d2, d3] = v2.added;
    const v3 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [d1.id, d3.id], add: [content({ contentFormat: "clip" })], createdBy: "athlete" });
    await expect(approveSpec(db, athleteId, campaign.id, 2, "athlete").then((r) => r.alreadyApproved)).resolves.toBe(true);
    const ap = await approveSpec(db, athleteId, campaign.id, 3, "athlete");
    expect(ap.dropped.map((d) => d.id)).toEqual([d2.id]); expect(ap.campaign.currentSpecVersion).toBe(3);
    expect((await listSpecs(db, athleteId, campaign.id)).map((s) => [s.version, s.approval, s.supersedes])).toEqual([[1, "draft", null], [2, "athlete", 1], [3, "athlete", 2]]);
    const m3 = await materializeCreativeIntents(db, athleteId, campaign.id, 3);
    expect(m3.created).toHaveLength(1); expect(m3.created[0].lineage).toMatchObject({ campaignDeliverableId: v3.added[0].id, specVersion: 3, unit: 1 });
    expect(m3.withdrawn.map((i) => i.lineage.campaignDeliverableId)).toEqual([d2.id]);
    const after = await campaignIntents(db, athleteId, campaign.id);
    expect(after).toHaveLength(5);
    for (const b of before) { const now = after.find((x) => x.id === b.id)!; expect(now.lineage).toEqual(b.lineage); expect(now.lineage.specVersion).toBe(2); }
    expect((await listDeliverables(db, athleteId, campaign.id)).find((d) => d.id === d2.id)).toMatchObject({ supersededVersion: 3, status: "open" });
    expect((await deliverablesInScope(db, athleteId, campaign.id, 3)).map((d) => d.id)).toEqual([d1.id, d3.id, v3.added[0].id]);
  });
  it("7. a mixed scope: only content deliverables become intents; the appearance stays a tracked obligation whose words reach no intent", async () => {
    const { campaign } = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_mixed" }));
    const v2 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [content(), { category: "access", sourceQuote: "one appearance at the spring launch", quantity: 1, dueOn: null, optional: false, completesWhen: "externally_confirmed" }], createdBy: "athlete" });
    await approveSpec(db, athleteId, campaign.id, 2, "athlete");
    const m = await materializeCreativeIntents(db, athleteId, campaign.id, 2);
    expect(m.created).toHaveLength(1);
    expect(JSON.stringify(m.created)).not.toContain("appearance");
    expect((await listDeliverables(db, athleteId, campaign.id)).map((d) => d.intent.category)).toEqual(["content", "access"]);
    expect(v2.spec.deliverableIds).toHaveLength(2);
  });
});

describe("fulfilment (derived, criterion gap recorded), approval boundary, Existing Work", () => {
  it("8./10. counts per unit under each candidate criterion, writes no `fulfilled`; approval created no preview, job or asset", async () => {
    const { campaign } = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_ful" }));
    const v2 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [content({ quantity: 2 })], createdBy: "athlete" });
    await approveSpec(db, athleteId, campaign.id, 2, "athlete");
    const m = await materializeCreativeIntents(db, athleteId, campaign.id, 2);
    expect((await db.select().from(studioGenerationPreviews)).length).toBe(0); expect((await db.select().from(generationJobs)).length).toBe(0);
    const [u1] = m.created;
    const [job] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "inbound", mode: "generate", objective: "announce", deliverable: "post", brief: {}, status: "succeeded", creative_intent_id: u1.id, source_spec_id: v2.spec.id, source_spec_version: 2, campaign_deliverable_id: v2.added[0].id } as any).returning();
    await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "instagram", origin: "generated", media_type: "IMAGE", status: "stored", generation_job_id: job.id, approval_status: "approved" } as any);
    const p = await deliverableProgress(db, athleteId, v2.added[0], m.created);
    expect(p).toMatchObject({ of: 2, under: { generated: 1, cleared: 1, published: 0 }, criterion: "cleared", satisfied: false, status: "open" });
    expect(p.units.map((u) => u.state)).toEqual(["cleared", "open"]);
    expect((await listDeliverables(db, athleteId, campaign.id))[0].status).toBe("open");            // nothing wrote `fulfilled`
    // the second unit clears → the declared criterion is satisfied → `fulfilled`, derived, no write
    const [job2] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "inbound", mode: "generate", objective: "announce", deliverable: "post", brief: {}, status: "succeeded", creative_intent_id: m.created[1].id } as any).returning();
    await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "instagram", origin: "generated", media_type: "IMAGE", status: "stored", generation_job_id: job2.id, approval_status: "approved" } as any);
    expect(await deliverableProgress(db, athleteId, v2.added[0], m.created)).toMatchObject({ satisfied: true, status: "fulfilled", under: { cleared: 2, published: 0 } });
    expect((await listDeliverables(db, athleteId, campaign.id))[0].status).toBe("open");            // derived, not persisted
    // a `published` criterion is not satisfied by clearance
    const pub = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [v2.added[0].id], add: [content({ completesWhen: "published" })], createdBy: "athlete" });
    await approveSpec(db, athleteId, campaign.id, 3, "athlete"); const m3 = await materializeCreativeIntents(db, athleteId, campaign.id, 3);
    const [job3] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "inbound", mode: "generate", objective: "announce", deliverable: "post", brief: {}, status: "succeeded", creative_intent_id: m3.created[0].id } as any).returning();
    await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "instagram", origin: "generated", media_type: "IMAGE", status: "stored", generation_job_id: job3.id, approval_status: "approved" } as any);
    expect(await deliverableProgress(db, athleteId, pub.added[0], m3.created)).toMatchObject({ criterion: "published", satisfied: false, status: "open", under: { cleared: 1 } });
    // an access obligation completes only by external confirmation; a content one cannot be confirmed by hand; no criterion → refused
    const acc = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [v2.added[0].id, pub.added[0].id], add: [{ category: "access", sourceQuote: "one clinic", quantity: 1, dueOn: null, optional: false, completesWhen: "externally_confirmed" }], createdBy: "athlete" });
    await approveSpec(db, athleteId, campaign.id, 4, "athlete");
    await expect(confirmExternally(db, athleteId, v2.added[0].id, "athlete")).rejects.toThrow("derived from Studio");
    expect((await confirmExternally(db, athleteId, acc.added[0].id, "athlete")).status).toBe("fulfilled");
    expect((await deliverableProgress(db, athleteId, (await listDeliverables(db, athleteId, campaign.id)).find((d) => d.id === acc.added[0].id)!, [])).satisfied).toBe(true);
    await expect(proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [{ category: "access", sourceQuote: "x", quantity: 1, dueOn: null, optional: false } as any], createdBy: "athlete" })).rejects.toThrow("completesWhen");
    await expect(proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [{ category: "access", sourceQuote: "x", quantity: 1, dueOn: null, optional: false, completesWhen: "published" }], createdBy: "athlete" })).rejects.toThrow("cannot complete on");
  });
  it("12. Existing Work sees the campaign: purpose, lifecycle, scope, whether creative work is underway, `for` the Recommendation and Objectives", async () => {
    const { campaign } = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_ew", objectiveIds: ["obj-9"] }));
    const v2 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [content(), { category: "access", sourceQuote: "one clinic", quantity: 1, dueOn: null, optional: false, completesWhen: "externally_confirmed" }], createdBy: "athlete" });
    const ap = await approveSpec(db, athleteId, campaign.id, 2, "athlete");
    const m = await materializeCreativeIntents(db, athleteId, campaign.id, 2);
    const inScope = await deliverablesInScope(db, athleteId, campaign.id, 2);
    const states = await Promise.all(m.created.map(async (i) => ({ intent: i, state: deriveIntentState(i, await downstreamOf(db, athleteId, i.id)) })));
    const w = campaignWorkItem({ campaign: ap.campaign, spec: ap.spec, inScope, intents: states })!;
    expect(w).toMatchObject({ ref: { kind: "campaign", id: campaign.id }, kind: "activation", for: { recommendationId: "rec_ew", objectiveIds: ["obj-9"] }, deliverablesRecorded: 0 });
    expect(w.statement).toContain("· approved ·"); expect(w.statement).toContain("1 content deliverable(s), 1 other obligation(s)"); expect(w.statement).toContain("creative work underway: no");
    const active = campaignWorkItem({ campaign: ap.campaign, spec: ap.spec, inScope, intents: states.map((x) => ({ ...x, state: "in_production" as const })) })!;
    expect(active.statement).toContain("· active ·");                                              // derived, never stored expect(w.statement).toContain("objective[obj-1]");
    expect((await creativeIntentState(db, athleteId, m.created[0].id))!.state).toBe("open");
    expect((await db.select().from(creativeIntents).where(eq(creativeIntents.id, m.created[0].id)))[0].source_kind).toBe("campaign");
  });
});
