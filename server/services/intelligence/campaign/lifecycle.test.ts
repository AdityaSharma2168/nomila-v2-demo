/**
 * campaign/lifecycle.test.ts — end eligibility is a read from the authoritative source (unknown when it cannot be
 * resolved); ending is a stored decision with a reason, an actor and a disposition for open obligations; `fulfilled` only
 * by declared criteria; nothing executing is touched; an ended campaign leaves Existing Work while the Recommendation's
 * outcome, recorded on the ledger, closes the record so the router's dedup releases. Synthetic athlete; no provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { eq } from "drizzle-orm";
import { athletes, creativeIntents, generationJobs, mediaAssets, objectives } from "../../../../shared/schema";
import { closeTestDb, db, initTestDb } from "../../../testUtils/pgliteDb";
import type { CampaignOriginProposal } from "../brain/executionRouter";
import { route } from "../brain/executionRouter";
import { authorizePrepare, emptyLedger, recordExecution, recordOutcome, respond, type RecommendationRecord } from "../brain/recommendation";
import { EXISTING_WORK_VERSION } from "../brain/contract";
import { campaignWorkItem } from "./existingWork";
import { endCampaign, endEligibility } from "./lifecycle";
import { campaignIntents, materializeCreativeIntents } from "./materialize";
import { CampaignRefused, approveSpec, createCampaignFromOrigin, deliverablesInScope, listDeliverables, proposeSpecVersion } from "./store";
import type { DeliverableIntent } from "./contract";
import type { Objective } from "../contracts/objectiveEntity";

let athleteId = "";
beforeAll(async () => { await initTestDb(); const [a] = await db.insert(athletes).values({ full_name: "Test Athlete" }).returning(); athleteId = a.id; });
afterAll(closeTestDb);
const origin = (over: Partial<CampaignOriginProposal> = {}): CampaignOriginProposal => ({ version: "execution-router/0.2.0-exp", shape: "campaign", door: "recommendation", recommendationId: "rec_lc_1", purpose: "A match-day presence through the season.", objectiveIds: [], dealIds: [], brandIds: [], period: { startsOn: null, endsOn: null, endsWith: "objective_horizon", endsRef: "objective[nope]" }, constraints: [], evidence: [], ...over });
const content = (over: Partial<DeliverableIntent> = {}): DeliverableIntent => ({ category: "content", contentFormat: "post", sourceQuote: null, quantity: 1, dueOn: null, optional: false, brandId: null, dealDeliverableId: null, completesWhen: "cleared", ...over });

describe("end eligibility — a read, never a guess", () => {
  it("a resolved endsOn decides; a live Objective with a period horizon is unknown; a closed Objective is reached; an unresolved deal term or stated finish is unknown", async () => {
    const past = (await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "r1", period: { startsOn: null, endsOn: "2026-01-01", endsWith: "deal_term", endsRef: "deal[d]" } }))).campaign;
    expect(await endEligibility(db, athleteId, past, new Date("2026-09-27"))).toMatchObject({ eligibility: "reached", basis: "period.endsOn 2026-01-01" });
    const future = (await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "r2", period: { startsOn: null, endsOn: "2027-01-01", endsWith: "athlete_stated", endsRef: "preferences[x]" } }))).campaign;
    expect((await endEligibility(db, athleteId, future, new Date("2026-09-27"))).eligibility).toBe("not_reached");
    // fromRow spreads `created_snapshot` as the base, so the snapshot carries the identity
    const objId = "abcdabcd-1111-4222-8333-444444444444";
    await db.insert(objectives).values({ id: objId, athlete_id: athleteId, version: "objective/1.1.0", origin: "athlete", domain: "audience", desired_state: { value: "A match-day presence." }, current_state: { value: "none" }, success: { observableCondition: "seen" }, horizon: { kind: "period", period: "this_season", why: "w" }, confidence: "HIGH", lifecycle: "active", disposition: "accepted", provenance: { origin: "athlete", fromOpportunities: [], fromAthleteIntent: [], currentStateEvidence: [] }, lineage: {}, created_snapshot: { id: objId, athleteId, domain: "audience", version: "objective/1.1.0" }, created_at: new Date() } as any);
    const live = { id: objId };
    const onLive = (await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "r3", period: { startsOn: null, endsOn: null, endsWith: "objective_horizon", endsRef: `objective[${live.id}]` } }))).campaign;
    expect(await endEligibility(db, athleteId, onLive)).toMatchObject({ eligibility: "unknown", basis: expect.stringContaining("period (this_season) with no date") });
    await db.update(objectives).set({ lifecycle: "achieved" }).where(eq(objectives.id, live.id));
    expect(await endEligibility(db, athleteId, onLive)).toMatchObject({ eligibility: "reached", basis: expect.stringContaining("achieved") });
    const noTerm = (await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "r4", period: { startsOn: null, endsOn: null, endsWith: "deal_term", endsRef: "deal[d]" } }))).campaign;
    expect((await endEligibility(db, athleteId, noTerm)).eligibility).toBe("unknown");
  });
});

describe("ending — a decision, with the open obligations disposed explicitly", () => {
  it("reaching the end does not end anything; `expired` needs the end reached (or an override) and a disposition; `fulfilled` needs every required obligation met by its criterion or waived; `cancelled` is hers any time; unproduced intents withdrawn, executing work untouched; the ended campaign leaves Existing Work", async () => {
    const { campaign } = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_lc_end", period: { startsOn: null, endsOn: "2026-01-01", endsWith: "deal_term", endsRef: "deal[d]" } }));
    const v2 = await proposeSpecVersion(db, athleteId, campaign.id, { keep: [], add: [content(), content({ contentFormat: "reel", optional: true })], createdBy: "athlete" });
    const ap = await approveSpec(db, athleteId, campaign.id, 2, "athlete");
    const m = await materializeCreativeIntents(db, athleteId, campaign.id, 2);
    // reached, yet still `approved`
    expect((await endEligibility(db, athleteId, ap.campaign, new Date("2026-09-27"))).eligibility).toBe("reached");
    expect(ap.campaign.status).toBe("approved");
    // one unit in production: its intent must survive ending
    const [job] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "inbound", mode: "generate", objective: "announce", deliverable: "reel", brief: {}, status: "running", creative_intent_id: m.created[1].id } as any).returning();
    await expect(endCampaign(db, athleteId, campaign.id, { because: "fulfilled", actor: "athlete" })).rejects.toThrow("non-optional obligation");
    await expect(endCampaign(db, athleteId, campaign.id, { because: "expired", actor: "athlete" })).rejects.toThrow("still open");
    const r = await endCampaign(db, athleteId, campaign.id, { because: "expired", actor: "athlete", remaining: "waive" }, new Date("2026-09-27"));
    expect(r.campaign).toMatchObject({ status: "ended", endedBecause: "expired" });
    expect(r.obligations.map((o) => o.after)).toEqual(["waived", "waived"]);
    expect(r.withdrawnIntents).toEqual([m.created[0].id]);                                   // the unproduced one
    expect((await db.select().from(creativeIntents).where(eq(creativeIntents.id, m.created[1].id)))[0].withdrawn_at).toBeNull(); // the executing one
    expect((await db.select().from(generationJobs).where(eq(generationJobs.id, job.id)))[0].status).toBe("running");
    expect(campaignWorkItem({ campaign: r.campaign, spec: ap.spec, inScope: await deliverablesInScope(db, athleteId, campaign.id, 2), intents: [] })).toBeNull();
    expect((await listDeliverables(db, athleteId, campaign.id)).map((d) => d.status)).toEqual(["waived", "waived"]);   // history stays
    expect(r.recommendationOutcome).toEqual({ recommendationId: "rec_lc_end", followed: true, result: { campaignId: campaign.id, endedBecause: "expired", fulfilled: 0, of: 2 } });
    // idempotent
    expect((await endCampaign(db, athleteId, campaign.id, { because: "cancelled", actor: "athlete" })).campaign.endedBecause).toBe("expired");
    // fulfilled by criterion
    const f = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_lc_f", period: { startsOn: null, endsOn: null, endsWith: "deal_term", endsRef: "deal[d]" } }));
    const fv = await proposeSpecVersion(db, athleteId, f.campaign.id, { keep: [], add: [content()], createdBy: "athlete" });
    await approveSpec(db, athleteId, f.campaign.id, 2, "athlete"); const fm = await materializeCreativeIntents(db, athleteId, f.campaign.id, 2);
    const [j2] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "inbound", mode: "generate", objective: "announce", deliverable: "post", brief: {}, status: "succeeded", creative_intent_id: fm.created[0].id } as any).returning();
    await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "instagram", origin: "generated", media_type: "IMAGE", status: "stored", generation_job_id: j2.id, approval_status: "approved" } as any);
    const done = await endCampaign(db, athleteId, f.campaign.id, { because: "fulfilled", actor: "athlete" });
    expect(done.campaign.endedBecause).toBe("fulfilled"); expect(done.recommendationOutcome!.result).toMatchObject({ fulfilled: 1, of: 1 });
    expect(done.eligibility.eligibility).toBe("unknown");                                    // fulfilment never needed the clock
    void fv;
    // cancelled at any time, with disposition
    const c = await createCampaignFromOrigin(db, athleteId, origin({ recommendationId: "rec_lc_c", period: { startsOn: null, endsOn: "2027-06-01", endsWith: "athlete_stated", endsRef: "preferences[x]" } }));
    const cv = await proposeSpecVersion(db, athleteId, c.campaign.id, { keep: [], add: [content()], createdBy: "athlete" }); await approveSpec(db, athleteId, c.campaign.id, 2, "athlete"); await materializeCreativeIntents(db, athleteId, c.campaign.id, 2);
    await expect(endCampaign(db, athleteId, c.campaign.id, { because: "cancelled", actor: "athlete" })).rejects.toThrow(CampaignRefused);
    const cx = await endCampaign(db, athleteId, c.campaign.id, { because: "cancelled", actor: "athlete", remaining: "cancel" });
    expect(cx.campaign.endedBecause).toBe("cancelled"); expect(cx.obligations[0].after).toBe("cancelled"); expect((await campaignIntents(db, athleteId, c.campaign.id))[0].withdrawnAt).not.toBeNull();
    void cv;
  });
  it("the Recommendation outcome closes the ledger record, so a later Brain run finds no execution underway and the router's dedup releases — history intact", () => {
    const rec: RecommendationRecord = { version: "recommendation/0.2.0-exp", id: "rec_lc_end", key: "k", source: "the Objective loop", subject: { kind: "objective", id: "obj-1" }, question: "q", objectiveIds: ["obj-1"], value: { what: "A match-day presence through the season.", why: "w", cites: [{ ref: "objective[obj-1]", how: "h" }], executionPath: "campaign", relationToExistingWork: "new_work", advances: null, notSeen: [], intent: null, ends: { source: "objective_horizon", ref: "objective[obj-1]" } }, versions: { spec: "s", runId: "r", runAt: "t" }, runs: ["r"], response: { state: "none", at: null, actor: null }, authorization: { state: "none", at: null, actor: null }, execution: { state: "none", refs: [] }, outcome: null, supersededBy: null, reconsiders: null, closed: false, events: [] };
    const governed = recordExecution(authorizePrepare(respond(rec, "accept", "athlete", "t"), "athlete", "t"), { kind: "campaign", id: "camp-1" }, "t");
    const ctx: Parameters<typeof route>[1] = { objectives: [{ id: "obj-1", domain: "audience" as Objective["domain"], horizon: { kind: "period", period: "this_season", why: "w" } as Objective["horizon"] }], work: { version: EXISTING_WORK_VERSION, asOf: "t", items: [] }, ledger: { ...emptyLedger(), records: [governed] }, runId: "again" };
    expect(route(governed, ctx)).toMatchObject({ ok: false, stage: "dedup", refused: expect.stringContaining("campaign:camp-1") });
    const closed = recordOutcome(governed, { followed: true, result: { campaignId: "camp-1", endedBecause: "expired", fulfilled: 0, of: 2 } }, "t2");
    expect(closed).toMatchObject({ closed: true, outcome: { followed: true }, execution: { refs: [{ kind: "campaign", id: "camp-1" }] } });
    expect(closed.events.map((e) => e.event)).toEqual(["accept", "prepare_authorized", "execution_proposed", "outcome_recorded"]);
    // a new judgment on the same decision is a fresh record; the closed one is not in the dedup's way and its history is intact
    const fresh = { ...rec, id: "rec_lc_next", objectiveIds: ["obj-1"] };
    const g2 = authorizePrepare(respond(fresh, "accept", "athlete", "t3"), "athlete", "t3");
    expect(route(g2, { ...ctx, ledger: { ...emptyLedger(), records: [closed, g2] } })).toMatchObject({ ok: true, handoff: { shape: "campaign" } });
    expect(() => recordOutcome(rec, { followed: null, result: null }, "t")).toThrow("execution");
  });
});
