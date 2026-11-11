/**
 * creative/store.test.ts — the persistence spine against PGlite: idempotent creation, no status column, versioned
 * interpretations, confirmation that may fix a format, withdrawal that blocks new preparation but rewrites nothing,
 * and derived state read from downstream rows without any write to the intent. Synthetic athlete; no provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { eq } from "drizzle-orm";
import { athletes, contentPosts, creativeIntents, generationJobs, mediaAssets, studioPlans } from "../../../../shared/schema";
import { closeTestDb, db, initTestDb } from "../../../testUtils/pgliteDb";
import { intentFromAthleteAsk } from "./intents";
import { addInterpretation, confirmInterpretation, createCreativeIntent, creativeIntentState, getCreativeIntent, latestInterpretation, withdrawCreativeIntent } from "./store";

let athleteId = "";
beforeAll(async () => { await initTestDb(); const [a] = await db.insert(athletes).values({ full_name: "Test Athlete" }).returning(); athleteId = a.id; });
afterAll(closeTestDb);
const now = "2026-09-27T12:00:00Z";
const ask = (text: string, ref: string) => intentFromAthleteAsk(text, { athleteId, askRef: ref, moment: { asOf: "2026-09-27", ref: "ctx[0]" }, now });

describe("creative_intents — the spine", () => {
  it("creates one intent from her words; a retry with the same key returns it and creates nothing; the row has no status", async () => {
    const i = ask("Make a post about today's win", "mila:turn:1");
    const first = await createCreativeIntent(db, i, `athlete:${i.source.ref}`);
    const again = await createCreativeIntent(db, i, `athlete:${i.source.ref}`);
    expect(first.created).toBe(true); expect(again.created).toBe(false); expect(again.record.id).toBe(first.record.id);
    expect(first.record).toMatchObject({ source: { kind: "athlete", ref: "mila:turn:1" }, purpose: "Make a post about today's win", ask: { verbatim: "Make a post about today's win", moment: { ref: "ctx[0]" } }, format: { class: "post", fixedBy: "athlete" }, brandId: null, why: null, lineage: {}, withdrawnAt: null });
    expect(Object.keys(first.record)).not.toContain("status");
    expect(Object.keys(creativeIntents)).not.toContain("status");
    expect((await creativeIntentState(db, athleteId, first.record.id))!.state).toBe("open");
  });
  it("interpretations version per intent; confirmation is a separate write that may fix an unset format without touching the ask", async () => {
    const i = ask("Do something for the team from today", "mila:turn:2");
    expect(i.format.class).toBeNull();
    const { record } = await createCreativeIntent(db, i, `athlete:${i.source.ref}`);
    const v1 = await addInterpretation(db, { athleteId, creativeIntentId: record.id, sourceTool: "propose_campaign", proposal: { brief: { objective: { goal: "recap" } }, extras: { concept: { angle: "a", feeling: "f", line: "l" } } }, flags: [{ path: "objective.goal", basis: "inferred", because: "she said today" }] });
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("interpreted");
    const v2 = await addInterpretation(db, { athleteId, creativeIntentId: record.id, sourceTool: "propose_campaign", proposal: { brief: { objective: { goal: "recap" } } }, flags: [] });
    expect(v2).toMatchObject({ version: 2, supersedes: v1.id, confirmedAt: null });
    await expect(confirmInterpretation(db, { athleteId, interpretationId: v1.id, concept: null, flags: [], formatClass: "post" })).rejects.toThrow("superseded");
    const confirmed = await confirmInterpretation(db, { athleteId, interpretationId: v2.id, concept: { id: "A", angle: "a", feeling: "f", line: "l" }, flags: [], formatClass: "reel" });
    expect(confirmed).toMatchObject({ confirmedFormatClass: "reel", confirmedConcept: { id: "A" } });
    expect((await getCreativeIntent(db, athleteId, record.id))!.ask!.verbatim).toBe("Do something for the team from today"); // never mutated
    expect((await getCreativeIntent(db, athleteId, record.id))!.format.class).toBeNull();                                   // the fix lives on the interpretation
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("confirmed");
  });
  it("derived state moves with downstream rows while the intent row never changes; withdrawal overrides and blocks new preparation but deletes nothing", async () => {
    const i = ask("A reel from today's win", "mila:turn:3");
    const { record } = await createCreativeIntent(db, i, `athlete:${i.source.ref}`);
    const before = await db.select().from(creativeIntents).where(eq(creativeIntents.id, record.id));
    const [plan] = await db.insert(studioPlans).values({ athlete_id: athleteId, plan: { items: [] }, creative_intent_id: record.id }).returning();
    // Slice 4 M3: a plan carrying the id never confirms anything — only her confirmed interpretation does.
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("open");
    const [job] = await db.insert(generationJobs).values({ athlete_id: athleteId, origin: "athlete", mode: "generate", objective: "recap", deliverable: "reel", brief: { briefId: "b" }, status: "running", creative_intent_id: record.id } as any).returning();
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("in_production");
    const [asset] = await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "instagram", origin: "generated", media_type: "VIDEO", status: "stored", generation_job_id: job.id, approval_status: "draft" } as any).returning();
    await db.update(generationJobs).set({ status: "succeeded" }).where(eq(generationJobs.id, job.id));
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("produced");
    await db.update(mediaAssets).set({ approval_status: "rejected" }).where(eq(mediaAssets.id, asset.id));      // revision C: asset-level only
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("produced");
    await db.update(mediaAssets).set({ approval_status: "approved" }).where(eq(mediaAssets.id, asset.id));
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("cleared");
    await db.insert(contentPosts).values({ asset_id: asset.id, platform: "instagram", permalink: null, posted_at: new Date() } as never); // as studio/publish/runner.ts recordPost writes it
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("published");
    const after = await db.select().from(creativeIntents).where(eq(creativeIntents.id, record.id));
    expect(after).toEqual(before);                                                                              // no drift: the intent row is byte-identical
    // withdrawal
    const w = await withdrawCreativeIntent(db, athleteId, record.id);
    expect(w.withdrawnAt).not.toBeNull();
    expect((await creativeIntentState(db, athleteId, record.id))!.state).toBe("withdrawn");
    await expect(addInterpretation(db, { athleteId, creativeIntentId: record.id, sourceTool: "echo_brief", proposal: {}, flags: [] })).rejects.toThrow("withdrawn");
    expect((await db.select().from(studioPlans).where(eq(studioPlans.id, plan.id))).length).toBe(1);             // history stays auditable
    expect((await db.select().from(generationJobs).where(eq(generationJobs.id, job.id)))[0].status).toBe("succeeded");
    expect(await latestInterpretation(db, athleteId, record.id)).toBeNull();
  });
});
