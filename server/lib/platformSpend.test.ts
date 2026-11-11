/**
 * platformSpend.test.ts — the platform-wide day ceiling refuses new paid calls for everyone, alerts once, and sums
 * the existing ledgers (agent_runs + Studio generation_jobs) against PGlite.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

const mockError = jest.fn();
jest.mock("../logger", () => {
  const make = (): any => ({ warn: () => {}, info: () => {}, error: (...a: unknown[]) => mockError(...a), debug: () => {}, child: () => make() });
  return { createLogger: () => make(), logger: make(), default: make() };
});

import { randomUUID } from "node:crypto";
import { agentRuns, athletes, chatMessages, conversations, generationJobs } from "../../shared/schema";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import {
  assertPlatformBudget, dbPlatformSpentTodayMicroUsd, notePlatformSpend, platformBudget, PlatformCapError,
  PLATFORM_CAP_MESSAGE, setPlatformSpendReaderForTests, STALE_OK_MS,
} from "./platformSpend";
import { CostCapError } from "./spendErrors";
import { runSkill } from "../agent/research/runSkill";
import { voiceCostPerMinuteUsd, voiceSpendTodayMicroUsd, VOICE_COST_PER_MINUTE_DEFAULT_USD, VOICE_COST_PER_MINUTE_FLOOR_USD } from "../voice/voiceMinutes";
import { spentTodayMicroUsd } from "../agent/trace";
import { athleteDaySpendMicroUsd, createMemoryStore } from "../agent/research/store";
import { dbStore } from "../agent/research/dbStore";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });
afterEach(() => { setPlatformSpendReaderForTests(null); delete process.env.PLATFORM_DAY_COST_CAP_USD; delete process.env.VOICE_COST_PER_MINUTE_USD; mockError.mockClear(); });

describe("the platform-wide day ceiling", () => {
  it("under the cap: allowed", async () => {
    setPlatformSpendReaderForTests(async () => 1_000_000);
    await expect(assertPlatformBudget()).resolves.toBeUndefined();
  });

  it("at the cap: refused with a clear PlatformCapError (a CostCapError), and ONE alert line per day", async () => {
    process.env.PLATFORM_DAY_COST_CAP_USD = "10";
    setPlatformSpendReaderForTests(async () => 10_000_000);
    const err = await assertPlatformBudget().catch((e) => e);
    expect(err).toBeInstanceOf(PlatformCapError);
    expect(err).toBeInstanceOf(CostCapError);
    expect(err.message).toBe(PLATFORM_CAP_MESSAGE);
    await assertPlatformBudget().catch(() => undefined);
    await assertPlatformBudget().catch(() => undefined);
    const alerts = mockError.mock.calls.filter((c) => (c[0] as any)?.event === "platform_spend_cap_reached");
    expect(alerts).toHaveLength(1);
  });

  it("a cost this process just recorded counts before the next re-read", async () => {
    process.env.PLATFORM_DAY_COST_CAP_USD = "1";
    setPlatformSpendReaderForTests(async () => 900_000);
    expect((await platformBudget()).over).toBe(false);
    notePlatformSpend(200_000);
    expect((await platformBudget()).over).toBe(true);
  });

  it("a failed read FAILS CLOSED: refused with the at-cap message and one alert line, never a total of 0", async () => {
    setPlatformSpendReaderForTests(async () => { throw new Error("db down"); });
    const t0 = new Date("2026-11-05T12:00:00Z");
    const err = await assertPlatformBudget(t0).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformCapError);
    expect(err.message).toBe(PLATFORM_CAP_MESSAGE);
    expect((await platformBudget(new Date(t0.getTime() + 1000))).readFailed).toBe(true);
    await assertPlatformBudget(new Date(t0.getTime() + 2000)).catch(() => undefined);
    const alerts = mockError.mock.calls.filter((c) => (c[0] as any)?.event === "platform_spend_read_failed");
    expect(alerts).toHaveLength(1);
    expect((alerts[0][0] as any).refusing).toBe(true);
  });

  it("a failed re-read uses the last good total only while it is under 60s old, then refuses; a good read recovers", async () => {
    let fail = false;
    setPlatformSpendReaderForTests(async () => { if (fail) throw new Error("db down"); return 1_000_000; });
    const t0 = new Date("2026-11-05T12:00:00Z").getTime();
    expect((await platformBudget(new Date(t0))).over).toBe(false);          // good read: $1 of $25
    fail = true;
    const stale = await platformBudget(new Date(t0 + 45_000));               // cache expired (30s), read fails, last good is 45s old
    expect(stale).toMatchObject({ over: false, spentMicroUsd: 1_000_000 });
    const old = await platformBudget(new Date(t0 + STALE_OK_MS + 1));        // last good is over 60s old
    expect(old).toMatchObject({ over: true, readFailed: true });
    await expect(assertPlatformBudget(new Date(t0 + STALE_OK_MS + 2))).rejects.toBeInstanceOf(PlatformCapError);
    fail = false;
    expect((await platformBudget(new Date(t0 + STALE_OK_MS + 3))).over).toBe(false); // recovered
  });

  it("runSkill refuses before starting a run (no agent_runs row, no model call)", async () => {
    process.env.PLATFORM_DAY_COST_CAP_USD = "1";
    setPlatformSpendReaderForTests(async () => 5_000_000);
    const store = { findCompletedRun: jest.fn(), startRun: jest.fn() } as any;
    await expect(runSkill({
      store, athleteId: randomUUID(), skillId: "echo/health", trigger: "test", parentRef: null, input: "x", schemaName: "x", schema: {} as any,
    })).rejects.toBeInstanceOf(PlatformCapError);
    expect(store.startRun).not.toHaveBeenCalled();
  });

  it("sums today's agent_runs and Studio generation spend across ALL athletes", async () => {
    const ids: string[] = [];
    for (const n of ["Athlete One", "Athlete Two"]) {
      const [a] = await db.insert(athletes).values({ full_name: n } as any).returning({ id: athletes.id });
      ids.push(a.id);
    }
    const before = await dbPlatformSpentTodayMicroUsd();
    for (const id of ids) {
      await db.insert(agentRuns).values({
        athlete_id: id, skill_id: "t", skill_version: "1", trigger: "test", provider: "openai", model: "gpt-6-luna", effort: "low",
        status: "completed", ended_at: new Date(), cost_micro_usd: 250_000,
      } as any);
    }
    await db.insert(generationJobs).values({
      athlete_id: ids[0], origin: "system", mode: "generate", objective: "o", deliverable: "d", brief: {}, status: "succeeded", cost_estimated_usd: "0.5",
    } as any);
    await db.insert(generationJobs).values({
      athlete_id: ids[1], origin: "system", mode: "generate", objective: "o", deliverable: "d", brief: {}, status: "canceled", cost_estimated_usd: "9",
    } as any);
    const after = await dbPlatformSpentTodayMicroUsd();
    // 2 × 0.25 (agent_runs) + 0.5 (a Studio job); the cancelled job is not spend.
    expect(after - before).toBe(1_000_000);
  });

  it("adds today's voice minutes (every athlete) × the per-minute ESTIMATE to the platform total", async () => {
    const [a] = await db.insert(athletes).values({ full_name: "Voice One" } as any).returning({ id: athletes.id });
    const [b] = await db.insert(athletes).values({ full_name: "Voice Two" } as any).returning({ id: athletes.id });
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const at = (min: number) => new Date(Math.max(midnight.getTime() + 1000, now.getTime() - 60 * 60_000) + min * 60_000);
    const before = await dbPlatformSpentTodayMicroUsd(now);
    for (const id of [a.id, b.id]) {
      const [c] = await db.insert(conversations).values({ athlete_id: id } as any).returning({ id: conversations.id });
      // One session per athlete: turns at +0, +2, +4 minutes → span 4 + 1 = 5 minutes each.
      await db.insert(chatMessages).values([0, 2, 4].map((m) => ({ athlete_id: id, role: "user", content: "spoken", conversation_id: c.id, source: "voice", created_at: at(m) })) as any);
    }
    // A text row never counts as voice.
    await db.insert(chatMessages).values({ athlete_id: a.id, role: "user", content: "typed", created_at: at(1) } as any);
    const after = await dbPlatformSpentTodayMicroUsd(now);
    expect(after - before).toBe(Math.round(10 * VOICE_COST_PER_MINUTE_DEFAULT_USD * 1_000_000));
  });

  it("the voice rate is an estimate floored at the computed blended cost; overrides can only make it more cautious", () => {
    // Owner, 5 Nov 2026: default $0.35 a minute, floor $0.25 (an estimate for a compressed 32k/16k context).
    expect([VOICE_COST_PER_MINUTE_DEFAULT_USD, VOICE_COST_PER_MINUTE_FLOOR_USD]).toEqual([0.35, 0.25]);
    expect(voiceCostPerMinuteUsd()).toBe(VOICE_COST_PER_MINUTE_DEFAULT_USD);
    process.env.VOICE_COST_PER_MINUTE_USD = "0.01";
    expect(voiceCostPerMinuteUsd()).toBe(VOICE_COST_PER_MINUTE_FLOOR_USD);
    process.env.VOICE_COST_PER_MINUTE_USD = "0";
    expect(voiceCostPerMinuteUsd()).toBe(VOICE_COST_PER_MINUTE_FLOOR_USD);
    process.env.VOICE_COST_PER_MINUTE_USD = "abc";
    expect(voiceCostPerMinuteUsd()).toBe(VOICE_COST_PER_MINUTE_DEFAULT_USD);
    process.env.VOICE_COST_PER_MINUTE_USD = "0.20";   // under the floor
    expect(voiceCostPerMinuteUsd()).toBe(VOICE_COST_PER_MINUTE_FLOOR_USD);
    process.env.VOICE_COST_PER_MINUTE_USD = "0.50";
    expect(voiceCostPerMinuteUsd()).toBe(0.5);
    expect(VOICE_COST_PER_MINUTE_DEFAULT_USD).toBeGreaterThanOrEqual(VOICE_COST_PER_MINUTE_FLOOR_USD);
  });
});

describe("the athlete's day total counts voice (estimate)", () => {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const at = (min: number) => new Date(Math.max(midnight.getTime() + 1000, now.getTime() - 60 * 60_000) + min * 60_000);
  async function athleteWithRun(name: string): Promise<string> {
    const [a] = await db.insert(athletes).values({ full_name: name } as any).returning({ id: athletes.id });
    await db.insert(agentRuns).values({
      athlete_id: a.id, skill_id: "t", skill_version: "1", trigger: "test", provider: "openai", model: "gpt-6-luna", effort: "low",
      status: "completed", ended_at: new Date(), cost_micro_usd: 250_000,
    } as any);
    return a.id;
  }
  async function talk(id: string, minutes: number[]) {
    const [c] = await db.insert(conversations).values({ athlete_id: id } as any).returning({ id: conversations.id });
    await db.insert(chatMessages).values(minutes.map((m) => ({ athlete_id: id, role: "user", content: "spoken", conversation_id: c.id, source: "voice", created_at: at(m) })) as any);
  }

  it("voice minutes today raise the athlete's total by minutes × VOICE_COST_PER_MINUTE_USD", async () => {
    const id = await athleteWithRun("Voice Talker");
    expect(await spentTodayMicroUsd(id, now)).toBe(250_000);
    await talk(id, [0, 2, 4]); // span 4 + 1 = 5 minutes
    const voice = Math.round(5 * VOICE_COST_PER_MINUTE_DEFAULT_USD * 1_000_000);
    expect(await voiceSpendTodayMicroUsd(id, now)).toBe(voice);
    expect(await spentTodayMicroUsd(id, now)).toBe(250_000 + voice);
    // The store-based day caps (plan, moments, post kits) read the same total.
    expect(await athleteDaySpendMicroUsd(dbStore, id, now)).toBe(250_000 + voice);
    // Another athlete's voice is never in this athlete's total.
    const other = await athleteWithRun("Voice Other");
    await talk(other, [0, 9]);
    expect(await spentTodayMicroUsd(id, now)).toBe(250_000 + voice);
  });

  it("a text-only athlete's total is unchanged: their runs, nothing added", async () => {
    const id = await athleteWithRun("Text Only");
    await db.insert(chatMessages).values({ athlete_id: id, role: "user", content: "typed", created_at: at(1) } as any);
    expect(await voiceSpendTodayMicroUsd(id, now)).toBe(0);
    expect(await spentTodayMicroUsd(id, now)).toBe(250_000);
    expect(await athleteDaySpendMicroUsd(dbStore, id, now)).toBe(250_000);
  });

  it("a store without voice (the in-memory one) adds nothing", async () => {
    const store = createMemoryStore();
    expect(await athleteDaySpendMicroUsd(store, randomUUID(), now)).toBe(0);
  });
});
