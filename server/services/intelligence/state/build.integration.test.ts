/**
 * build.integration.test.ts — State 1.2 composed from real tables (PGlite), and the validator PROVEN on the path.
 *
 * The Rate lesson: a gate that is defined and tested but never called guards nothing. This file spies on the real
 * validator, asserts it was invoked with the state that was returned, and then makes it report a problem and
 * asserts the build refuses. No athlete's expected content appears anywhere here.
 */
jest.mock("./validate", () => {
  const real = jest.requireActual("./validate");
  return { ...real, validateAthleteState: jest.fn(real.validateAthleteState) };
});

// The direction tests write through recordAssertions, which imports server/db — point it at the same PGlite.
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
import { eq } from "drizzle-orm";
import { athletes, deals, inboxThreads, socialAudienceDistributions, socialFeatures, socialIdentities } from "../../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { ATHLETE_STATE_VERSION } from "../contracts/athleteState";
import { buildAthleteState } from "./build";
import { validateAthleteState } from "./validate";

const spy = validateAthleteState as unknown as jest.Mock;
let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Integration Athlete");
  await db.update(athletes).set({
    goal_archetype: "grow_following",
    secondary_goals: ["land_first_deal", "grow_following"],
    deal_preferences: { agent_name: "An Agent", minimum_rates: { social_feed_post: 750, story: "not a number" } },
    claimed_at: new Date("2026-06-01T00:00:00.000Z"),
  } as any).where(eq(athletes.id, athleteId));

  await db.insert(deals).values([
    { athlete_id: athleteId, brand_name: "Detected Co", status: "detected" },
    { athlete_id: athleteId, brand_name: "Detected Co 2", status: "detected" },
    { athlete_id: athleteId, brand_name: "Talking Co", status: "negotiating", term_end: "2027-03-01" },
    { athlete_id: athleteId, brand_name: "Signed Co", status: "accepted", amount: "1200", amount_cash: "1000", term_end: "2026-12-31" },
  ] as any);

  await db.insert(inboxThreads).values([
    { athlete_id: athleteId, subject: "Paid collab", status: "read", last_message_at: new Date("2026-09-10T00:00:00.000Z"),
      classification: { category: "PAID", advertiser: "Brand A", confidence: 0.9, deadline: "2026-10-15" } },
    { athlete_id: athleteId, subject: "Gift", status: "unread", last_message_at: new Date("2026-09-12T00:00:00.000Z"),
      classification: { category: "GIFTING", brand_name: "Brand B", confidence: 0.7 } },
    { athlete_id: athleteId, subject: "Newsletter", status: "read", last_message_at: new Date("2026-09-13T00:00:00.000Z"), classification: null },
  ] as any);

  const [ident] = await db.insert(socialIdentities).values({ athlete_id: athleteId, platform: "instagram", account_id: "acct-1", handle: "x", source_class: "connected_verified", source_method: "api", status: "active" } as any).returning({ id: socialIdentities.id });
  const base = { athlete_id: athleteId, platform: "instagram", identity_id: ident!.id, basis: "followers", source_class: "connected_verified", source_method: "api", provider: "meta", definition_version: "v1" };
  await db.insert(socialAudienceDistributions).values([
    { ...base, dimension: "country", bucket: "US", pct: "58", observed_at: new Date("2026-09-01T00:00:00.000Z") },
    { ...base, dimension: "country", bucket: "GB", pct: "12", observed_at: new Date("2026-09-01T00:00:00.000Z") },
    { ...base, dimension: "country", bucket: "US", pct: "40", observed_at: new Date("2026-06-01T00:00:00.000Z") }, // stale
    { ...base, dimension: "age", bucket: "18-24", pct: "44", observed_at: new Date("2026-09-01T00:00:00.000Z") },
    { ...base, dimension: "gender", bucket: "F", pct: "70", observed_at: new Date("2026-09-01T00:00:00.000Z") },
  ] as any);
  await db.insert(socialFeatures).values([
    { athlete_id: athleteId, platform: "instagram", identity_id: ident!.id, feature_key: "followers_latest", value: "12000", unit: "count", window_days: 0, as_of: new Date("2026-09-01T00:00:00.000Z"), source_class: "connected_verified", confidence: "1.00", calculation_version: "v1", inputs: {} },
    { athlete_id: athleteId, platform: "instagram", identity_id: ident!.id, feature_key: "posts_per_week", value: "2.5", unit: "count", window_days: 90, as_of: new Date("2026-09-01T00:00:00.000Z"), source_class: "connected_verified", confidence: "1.00", calculation_version: "v1", inputs: {} },
  ] as any);
});

afterAll(async () => { await closeTestDb(); });
beforeEach(() => { spy.mockClear(); });

describe("State 1.2 — composed from what Nomila already holds", () => {
  it("invokes the validator ON THE PATH, with the state it returns", async () => {
    const state = await buildAthleteState(db as any, athleteId);
    expect(state).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(state);
    expect(state!.version).toBe(ATHLETE_STATE_VERSION);
  });

  it("REFUSES to return a state the validator rejects", async () => {
    spy.mockImplementationOnce(() => ["injected problem"]);
    await expect(buildAthleteState(db as any, athleteId)).rejects.toThrow(/injected problem/);
  });

  it("projects onboarding intent as LABELLED preferences, deduplicated, never as assertions", async () => {
    const s = (await buildAthleteState(db as any, athleteId))!;
    const onboarding = s.preferences.filter((p) => p.source.source === "onboarding");
    expect(onboarding.map((p) => p.subject)).toEqual(["onboarding_goal.grow_following", "onboarding_goal.land_first_deal"]);
    for (const p of onboarding) {
      expect(p.stance).toBe("wants");
      expect(p.recordedAs).toEqual({ method: "onboarding_v1_choice", at: "2026-06-01T00:00:00.000Z" });
    }
  });

  it("keeps pipeline states distinct and never lets inbound become a deal", async () => {
    const s = (await buildAthleteState(db as any, athleteId))!;
    expect(s.commercialPosition.pipeline.value).toEqual({ detected: 2, negotiating: 1, rejected: 0, accepted: 1, completed: 0 });
    expect(s.commercialPosition.closedDeals.value).toBe(1);
    expect(s.commercialPosition.inbound.map((i) => i.category)).toEqual(["GIFTING", "PAID"]); // most recent first, unclassified dropped
    expect(s.commercialPosition.inbound.map((i) => i.counterparty)).toEqual(["Brand B", "Brand A"]);
    for (const i of s.commercialPosition.inbound) { expect(i.evidence.source).toBe("inbox"); expect("amount" in i).toBe(false); }
  });

  it("projects the LATEST audience composition per platform, top buckets only", async () => {
    const s = (await buildAthleteState(db as any, athleteId))!;
    expect(s.audience).toHaveLength(1);
    const ig = s.audience[0]!;
    expect(ig.platform).toBe("instagram");
    expect(ig.topCountry).toEqual({ bucket: "US", pct: 58 }); // not the stale 40
    expect(ig.topAge).toEqual({ bucket: "18-24", pct: 44 });
    expect(ig.gender).toEqual([{ bucket: "F", pct: 70 }]);
    expect(ig.followers.evidenceClass).toBe("MEASURED");
    expect(s.contentPerformance).toEqual([expect.objectContaining({ platform: "instagram", postsPerWeek: 2.5 })]);
  });

  it("projects floors and representation as stated, dropping what is not a number", async () => {
    const s = (await buildAthleteState(db as any, athleteId))!;
    expect(s.representation).toEqual(expect.objectContaining({ agent: "An Agent", agency: null, floors: [{ key: "social_feed_post", amount: 750 }] }));
  });

  it("projects only populated real-world dates, each with its meaning, ascending", async () => {
    const s = (await buildAthleteState(db as any, athleteId))!;
    expect(s.dates.map((d) => [d.kind, d.date])).toEqual([
      ["inbound_deadline", "2026-10-15"],
      ["deal_term_end", "2026-12-31"],
      ["deal_term_end", "2027-03-01"],
    ]);
  });
});

describe("athlete-state 1.4.0 — HER DIRECTION (athlete authority; not a fact, finding, want, goal or Objective)", () => {
  const DIR = "Technology and entrepreneurship should be much more central to how I am understood.";
  it("her direction, written through the athlete_asserted machinery, is projected as athleteDirection and nowhere else; a new one supersedes with history; the fact resolver never sees it", async () => {
    const { recordAssertions } = await import("../../../mila/onboarding");
    const { assertionsFor } = await import("../research/researchInputs");
    const { renderStateBlock } = await import("../opportunity/stateBlock");
    const { athleteAsserted } = await import("../../../../shared/schema");
    await recordAssertions({ athleteId, runId: null, mode: "form", source: "settings", corrections: [{ field: "direction", value: "Tech should be central." } as any] });
    await recordAssertions({ athleteId, runId: null, mode: "form", source: "settings", corrections: [{ field: "direction", value: DIR } as any] });

    const state = (await buildAthleteState(db as any, athleteId))!;
    expect(state.version).toBe("athlete-state/1.5.0");
    expect(state.athleteDirection).toMatchObject({ statement: DIR, source: { source: "assertion" } });
    // its own class: never a preference, a constraint or a note
    expect(state.preferences.map((p) => p.subject)).not.toContain("direction");
    expect(state.constraints.map((c) => c.kind)).not.toContain("direction");
    expect(state.athleteNotes.map((n) => n.text)).not.toContain(DIR);
    // superseded with history: both rows remain; only the current one is live
    const rows = await db.select().from(athleteAsserted).where(eq(athleteAsserted.athlete_id, athleteId));
    const dirRows = rows.filter((r: any) => r.field === "direction");
    expect(dirRows).toHaveLength(2);
    expect(dirRows.filter((r: any) => r.superseded_by === null)).toHaveLength(1);
    // never enters the fact resolver
    expect((await assertionsFor(athleteId)).map((a) => a.factKey)).not.toContain("direction");
    // rendered for every reasoner that reads the State block, as hers and as context
    const block = renderStateBlock(state);
    expect(block).toContain("HER DIRECTION — how the athlete wants to be understood.");
    const line = block.split("\n").find((l) => l.trimStart().startsWith("athleteDirection"));
    expect(line).toContain(`"${DIR}"`);
    expect(block).not.toContain("Tech should be central.");
  });
  it("an athlete with no direction renders exactly as before (no HER DIRECTION section)", async () => {
    const { renderStateBlock } = await import("../opportunity/stateBlock");
    const state = (await buildAthleteState(db as any, athleteId))!;
    const { athleteDirection: _d, ...without } = state;
    expect(renderStateBlock(without as any)).not.toContain("HER DIRECTION");
  });
});
