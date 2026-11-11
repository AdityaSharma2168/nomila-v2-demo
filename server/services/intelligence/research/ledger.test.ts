/**
 * ledger.test.ts — the atomic nightly LLM cap (design §5.1) on a real (PGlite) Postgres.
 *
 *   E. retries consume the nightly call budget (every attempt reserves; the day row is the authority)
 *   F. two workers race for the LAST slot: exactly one reservation succeeds, exactly one call happens;
 *      the same for the per-run cap
 *   G. non-LLM lanes never touch the LLM counter and cannot bypass the reservation
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { researchBudgetDays, researchRuns } from "../../../../shared/schema";
import { DEFAULT_RESEARCH_POLICY, type ResearchPolicy } from "./policy";
import { budgetDay, nightlyLedger, recordNonLlmCall, reserveLlmCall } from "./ledger";
import { groundedSearch } from "../../../lib/research/providers/geminiGrounded";

let athleteId: string;
const AT = new Date("2026-09-15T05:10:00.000Z");
const policyWith = (planner: Partial<ResearchPolicy["planner"]>): ResearchPolicy => ({ ...DEFAULT_RESEARCH_POLICY, planner: { ...DEFAULT_RESEARCH_POLICY.planner, ...planner } });
const openRun = async () => (await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "ttl", status: "running", started_at: AT, as_of: AT }).returning({ id: researchRuns.id }))[0].id;
const dayRow = async () => (await db.select().from(researchBudgetDays).where(eq(researchBudgetDays.day, budgetDay(AT))))[0];
const runRow = async (id: string) => (await db.select().from(researchRuns).where(eq(researchRuns.id, id)))[0];

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Ledger Test"); });
afterAll(closeTestDb);
beforeEach(async () => { await db.delete(researchRuns); await db.delete(researchBudgetDays); });

describe("reserveLlmCall (atomic day + run caps)", () => {
  it("E. every attempt, retries included, reserves against the day row; the ledger reports the actuals", async () => {
    const policy = policyWith({ maxLlmCallsPerNight: 6, geminiRetryMax: 2, maxCallsPerRun: 8 });
    const runId = await openRun();
    const reserve = () => reserveLlmCall(runId, { policy, asOf: AT });
    // query 1 fails twice then succeeds (3 attempts); query 2 succeeds first time (1 attempt)
    let n = 0;
    const flaky = async () => { n++; if (n < 3) throw new Error("boom"); return { text: "answer", groundingChunks: [{ uri: "https://a.example/x", title: "t", domain: "a.example" }], groundingSupports: [], webSearchQueries: [] }; };
    const r1 = await groundedSearch("q1", { envelopeId: "g0", queryName: "Profile + Social", retryMax: policy.planner.geminiRetryMax, reserve, call: flaky, sleep: async () => {} });
    const r2 = await groundedSearch("q2", { envelopeId: "g1", queryName: "Commercial + Brand", retryMax: policy.planner.geminiRetryMax, reserve, call: flaky, sleep: async () => {} });
    expect(r1.attempts).toBe(3); expect(r1.completed).toBe(true); expect(r2.attempts).toBe(1);
    expect((await dayRow()).llm_attempts).toBe(4);
    expect((await runRow(runId)).llm_attempts).toBe(4);
    expect((await runRow(runId)).calls).toBe(4);
    const ledger = await nightlyLedger(AT);
    expect(ledger.llmExecutedToday).toBe(4);
    // only 2 slots remain: a third query with retries stops after 2 attempts and is refused on the third
    let m = 0;
    const alwaysEmpty = async () => { m++; return { text: "", groundingChunks: [], groundingSupports: [], webSearchQueries: [] }; };
    const r3 = await groundedSearch("q3", { envelopeId: "g2", queryName: "Performance + Press", retryMax: 5, reserve, call: alwaysEmpty, sleep: async () => {} });
    expect(m).toBe(2); expect(r3.refused).toBe(true); expect(r3.completed).toBe(false);
    expect(r3.envelope.errors.some((e) => e.class === "budget")).toBe(true);
    expect((await dayRow()).llm_attempts).toBe(6);   // the cap, never above
  });

  it("F. two workers race for the last LLM slot: exactly one reservation succeeds and exactly one provider call is made", async () => {
    const policy = policyWith({ maxLlmCallsPerNight: 5, maxCallsPerRun: 8 });
    await db.insert(researchBudgetDays).values({ day: budgetDay(AT), llm_attempts: 4 });   // one slot left
    const runA = await openRun(); const runB = await openRun();
    let calls = 0;
    const provider = async () => { calls++; return { text: "x", groundingChunks: [{ uri: "https://a.example/x", title: "t", domain: "a.example" }], groundingSupports: [], webSearchQueries: [] }; };
    const worker = (runId: string) => groundedSearch("q", { envelopeId: "g", queryName: "Profile + Social", retryMax: 0, reserve: () => reserveLlmCall(runId, { policy, asOf: AT }), call: provider, sleep: async () => {} });
    const [a, b] = await Promise.all([worker(runA), worker(runB)]);
    expect([a.refused, b.refused].filter((x) => x).length).toBe(1);
    expect([a.attempts, b.attempts].reduce((x, y) => x + y, 0)).toBe(1);
    expect(calls).toBe(1);
    expect((await dayRow()).llm_attempts).toBe(5);
    // per-run cap: one run, two concurrent query tasks, one slot left on the run
    const runC = await openRun();
    await db.update(researchRuns).set({ llm_attempts: 7 }).where(eq(researchRuns.id, runC));
    const loose = policyWith({ maxLlmCallsPerNight: 1000, maxCallsPerRun: 8 });
    const before = (await dayRow()).llm_attempts;
    const [c1, c2] = await Promise.all([reserveLlmCall(runC, { policy: loose, asOf: AT }), reserveLlmCall(runC, { policy: loose, asOf: AT })]);
    expect([c1, c2].filter((x) => x).length).toBe(1);
    expect((await runRow(runC)).llm_attempts).toBe(8);
    expect((await dayRow()).llm_attempts).toBe(before + 1);   // the refused reservation released its day slot
  });

  it("G. non-LLM calls are counted on their own lanes, never on the LLM counter; the other lane has its own cap", async () => {
    const policy = policyWith({ maxLlmCallsPerNight: 10, maxOtherCallsPerNight: 2 });
    const runId = await openRun();
    expect(await recordNonLlmCall(runId, "signals", { policy, asOf: AT })).toBe(true);
    expect(await recordNonLlmCall(runId, "signals", { policy, asOf: AT })).toBe(true);
    expect(await recordNonLlmCall(runId, "other", { policy, asOf: AT })).toBe(true);
    expect(await recordNonLlmCall(runId, "other", { policy, asOf: AT })).toBe(true);
    expect(await recordNonLlmCall(runId, "other", { policy, asOf: AT })).toBe(false);   // maxOtherCallsPerNight reached
    const d = await dayRow();
    expect(d).toMatchObject({ llm_attempts: 0, signal_calls: 2, other_calls: 2 });
    expect(await runRow(runId)).toMatchObject({ llm_attempts: 0, signal_calls: 2, other_calls: 2, calls: 4 });
    // an LLM reservation is still available: the other lane never consumed it
    expect(await reserveLlmCall(runId, { policy, asOf: AT })).toBe(true);
    expect((await dayRow()).llm_attempts).toBe(1);
    // the adapter has no path to the provider without a successful reservation
    let called = 0;
    const r = await groundedSearch("q", { envelopeId: "g", queryName: "Social Handles", retryMax: 3, reserve: async () => false, call: async () => { called++; return { text: "x", groundingChunks: [], groundingSupports: [], webSearchQueries: [] }; }, sleep: async () => {} });
    expect(called).toBe(0); expect(r.refused).toBe(true); expect(r.attempts).toBe(0);
  });
});
