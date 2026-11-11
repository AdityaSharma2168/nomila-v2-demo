/**
 * identityResolution.db.test.ts — PR E1, the compare-and-set writer on a real (PGlite) Postgres
 * (design record pr-e-identity-resolution-design.md §1.2 "Concurrency", §8).
 *
 *   - CAS: `WHERE identity_resolution IS NOT DISTINCT FROM $from`; a lost CAS is a returned result, not an error
 *   - the race: a late Q1 never overwrites an athlete's confirmation
 *   - two writers from the same `pending`: exactly one wins
 *   - flag off ⇒ zero column writes
 *   - NULL guarantees: legacy account signals (identity_resolved_at, identity_confidence, research_status
 *     'identity_resolved', a claimed account, an active connection) still read NULL, never pending
 *   - the CHECKs: unknown value refused; value and provenance exist together or not at all
 *
 * No provider is reachable: nothing here imports one.
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { athleteResearchState, athletes } from "../../../../shared/schema";
import { applyIdentityTransition, readIdentityState, type IdentityEvent, type Q1Determination } from "./identityResolution";

const AT = new Date("2026-10-01T12:00:00.000Z");
const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const env = process.env;
const flags = (f: Record<string, string>) => { process.env = { ...env }; for (const k of Object.keys(ON)) delete process.env[k]; Object.assign(process.env, f); };

const AMBIG: Q1Determination = { outcome: "ambiguous", anchorMatch: "matched", confidence: 0.7, namesakes: 2, reason: "namesakes_uncorroborated" };
const RESOLVED: Q1Determination = { outcome: "resolved", anchorMatch: "matched", confidence: 0.9, namesakes: 0, corroboratedBy: [] };
const q1 = (d: Q1Determination, runId = "rr-1"): IdentityEvent => ({ kind: "q1", determination: d, researchRunId: runId, workflowRunId: "wf-1", requestAnchorHash: "h1", currentAnchorHash: "h1", namesakeEvidenceIds: [] });
const ENTER: IdentityEvent = { kind: "enter", trigger: "signup", by: null, anchorHash: "h1" };
const CONFIRM: IdentityEvent = { kind: "athlete_confirmed", assertedId: "as-1", evidenceIds: ["ev-1"], q1ResearchRunId: "rr-1", by: "user-1" };

let athleteId: string;
const row = async () => (await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)))[0];
const state = async () => (await readIdentityState(athleteId))!;

beforeAll(initTestDb);
afterAll(closeTestDb);
beforeEach(async () => {
  flags(ON);
  athleteId = await seedAthlete(`Identity ${Math.random()}`);
  await db.insert(athleteResearchState).values({ athlete_id: athleteId });
});
afterEach(() => { process.env = env; });

describe("applyIdentityTransition — compare-and-set", () => {
  test("a fresh row is NULL; T1 → pending → T3 ambiguous → T6 resolved, each a CAS on what the caller read", async () => {
    expect(await state()).toEqual({ value: null, detail: null });
    expect(await applyIdentityTransition(athleteId, await state(), ENTER, { at: AT })).toMatchObject({ written: true, transition: "T1", from: null, to: "pending" });
    expect(await applyIdentityTransition(athleteId, await state(), q1(AMBIG), { at: AT })).toMatchObject({ written: true, transition: "T3", to: "ambiguous" });
    expect(await applyIdentityTransition(athleteId, await state(), CONFIRM, { at: AT })).toMatchObject({ written: true, transition: "T6", to: "resolved" });
    const r = await row();
    expect(r.identity_resolution).toBe("resolved");
    expect(r.identity_resolution_detail).toMatchObject({ basis: "athlete_confirmed", assertedId: "as-1", previous: { value: "ambiguous", basis: "q1", reason: "namesakes_uncorroborated" } });
    expect((r.identity_resolution_detail as any).previous.previous).toBeUndefined();   // current plus one, never a chain
  });

  test("the race: a late Q1 (read `pending` before the athlete confirmed) never overwrites her confirmation", async () => {
    await applyIdentityTransition(athleteId, await state(), ENTER, { at: AT });
    const staleRead = await state();                                                   // a Q1 step reads `pending` …
    await applyIdentityTransition(athleteId, staleRead, q1(AMBIG), { at: AT });         // … the first attempt lands T3
    await applyIdentityTransition(athleteId, await state(), CONFIRM, { at: AT });       // she confirms: resolved
    // the late retry of the same step still holds its stale `pending` read and a different answer
    const late = await applyIdentityTransition(athleteId, staleRead, q1(AMBIG, "rr-late"), { at: AT });
    expect(late).toEqual({ written: false, reason: "cas_lost", expected: "pending", observed: "resolved" });
    // a late Q1 that reads fresh is a no-op: resolved is sticky (D7) and a confirmation is kept (T10)
    expect(await applyIdentityTransition(athleteId, await state(), q1(AMBIG, "rr-late"), { at: AT })).toMatchObject({ written: false, reason: "noop", detail: "resolved_sticky" });
    expect(await applyIdentityTransition(athleteId, await state(), q1(RESOLVED, "rr-late"), { at: AT })).toMatchObject({ written: false, reason: "noop", detail: "athlete_confirmed_kept" });
    expect((await row()).identity_resolution_detail).toMatchObject({ basis: "athlete_confirmed", assertedId: "as-1" });
  });

  test("two writers from the same `pending`: exactly one wins, the other is told (not thrown)", async () => {
    await applyIdentityTransition(athleteId, await state(), ENTER, { at: AT });
    const read = await state();
    const results = await Promise.all([applyIdentityTransition(athleteId, read, q1(RESOLVED, "rr-a"), { at: AT }), applyIdentityTransition(athleteId, read, q1(AMBIG, "rr-b"), { at: AT })]);
    expect(results.filter((r) => r.written)).toHaveLength(1);
    expect(results.filter((r) => !r.written)).toEqual([expect.objectContaining({ written: false, reason: "cas_lost", expected: "pending" })]);
  });

  test("T1 twice: the second enter sees a non-NULL row and is refused, never re-pending a determination", async () => {
    const nullRead = await state();
    expect((await applyIdentityTransition(athleteId, nullRead, ENTER, { at: AT })).written).toBe(true);
    expect(await applyIdentityTransition(athleteId, nullRead, ENTER, { at: AT })).toEqual({ written: false, reason: "cas_lost", expected: null, observed: "pending" });
    expect(await applyIdentityTransition(athleteId, await state(), ENTER, { at: AT })).toMatchObject({ written: false, reason: "refused" });
  });

  test("no athlete_research_state row ⇒ cas_lost / no_row (the writer never inserts)", async () => {
    const other = await seedAthlete("No State Row");
    expect(await applyIdentityTransition(other, { value: null, detail: null }, ENTER, { at: AT })).toEqual({ written: false, reason: "cas_lost", expected: null, observed: "no_row" });
    expect(await readIdentityState(other)).toBeNull();
  });

  test("the writer touches only the two identity columns", async () => {
    const before = await row();
    await applyIdentityTransition(athleteId, await state(), ENTER, { at: AT });
    const after = await row();
    const { identity_resolution: _a, identity_resolution_detail: _b, ...restBefore } = before;
    const { identity_resolution: _c, identity_resolution_detail: _d, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
  });
});

describe("flag off ⇒ zero column writes", () => {
  test("every event is refused before the database is touched", async () => {
    flags({ RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "kimi" });
    for (const e of [ENTER, q1(RESOLVED), CONFIRM]) expect(await applyIdentityTransition(athleteId, await state(), e, { at: AT })).toEqual({ written: false, reason: "disabled" });
    flags({});
    expect(await applyIdentityTransition(athleteId, await state(), ENTER, { at: AT })).toEqual({ written: false, reason: "disabled" });
    expect(await state()).toEqual({ value: null, detail: null });
  });
});

describe("NULL guarantees", () => {
  test("legacy account signals + a claimed account + an active connection still read NULL (not pending)", async () => {
    await db.update(athleteResearchState).set({ identity_resolved_at: AT, identity_confidence: "1.00", research_status: "identity_resolved" }).where(eq(athleteResearchState.athlete_id, athleteId));
    await db.update(athletes).set({ claimed_at: AT, auth_id: `uid-${athleteId}` } as any).where(eq(athletes.id, athleteId));
    await seedConnection({ athleteId, platform: "instagram" });
    expect(await state()).toEqual({ value: null, detail: null });
    // and a Q1 determination cannot write a NULL row (only T1 enters governed resolution)
    expect(await applyIdentityTransition(athleteId, await state(), q1(RESOLVED), { at: AT })).toMatchObject({ written: false, reason: "refused" });
    expect((await row()).identity_resolution).toBeNull();
  });
});

describe("the CHECKs (schema.ts mirror of 0080)", () => {
  const set = (value: string | null, detail: unknown) => db.execute(sql`UPDATE athlete_research_state SET identity_resolution = ${value}, identity_resolution_detail = ${detail == null ? null : JSON.stringify(detail)}::jsonb WHERE athlete_id = ${athleteId}`);
  test("an unknown value is refused", async () => { await expect(set("unresolved", { at: "x" })).rejects.toThrow(/identity_resolution_check/); });
  test("a value without provenance, or provenance without a value, is refused", async () => {
    await expect(set("pending", null)).rejects.toThrow(/identity_detail_check/);
    await expect(set(null, { at: "x" })).rejects.toThrow(/identity_detail_check/);
  });
  test("each of the four values with provenance is accepted, and NULL/NULL is", async () => {
    for (const v of ["pending", "resolved", "ambiguous", "failed"]) await set(v, { at: "x" });
    await set(null, null);
  });
});
