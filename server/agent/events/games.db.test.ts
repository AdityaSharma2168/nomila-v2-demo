/**
 * games.db.test.ts — a game the athlete tells Mila about, on the REAL queries (PGlite in memory; no real database, no
 * provider, no model). A made-up athlete and a fixture game ten days out.
 *
 *   GD1 saved through remember_fact (prepare + execute on the db store), the game is picked up by the plan's daily sweep
 *       (plan/triggers.ts sweepPlanRefresh, its dated-event SQL): one event run, standing before_event
 *   GD2 eleven days later the wake-up's own queries (dbPassedGamesDeps: the candidate SQL, the facts, the schedule ids)
 *       find it once; a saved result fact about it is never a second game
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { agentRuns } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dbStore } from "../research/dbStore";
import { chatTools } from "../chat/tools";
import { PLAN_SKILL_ID } from "../plan/config";
import { dbPassedGamesDeps, GAME_TOPIC, sweepPassedGames } from "./games";

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const saved = { plan: process.env.AGENT_PLAN, welcome: process.env.MILA_WELCOME };
let F = "";

beforeAll(async () => {
  await initTestDb();
  process.env.AGENT_PLAN = "true";
  delete process.env.MILA_WELCOME;
  F = await seedAthlete("Fixture Athlete");
  await dbStore.writeBrief(F, { summary: "F", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
  // A plan ran today, so the sweep's weekly run is not due: only the dated-event rule can start one.
  await db.insert(agentRuns).values({ athlete_id: F, skill_id: PLAN_SKILL_ID, skill_version: "test", trigger: "test", provider: "openai", model: "test", effort: "low", status: "completed", ended_at: new Date() } as any);
}, 60_000);
afterAll(async () => {
  if (saved.plan === undefined) delete process.env.AGENT_PLAN; else process.env.AGENT_PLAN = saved.plan;
  if (saved.welcome === undefined) delete process.env.MILA_WELCOME; else process.env.MILA_WELCOME = saved.welcome;
  await closeTestDb();
});

test("GD1 + GD2: a game said ten days out reaches the plan sweep, and the wake-up finds it once after", async () => {
  const tool = chatTools(dbStore, {} as any).find((t) => t.name === "remember_fact")!;
  const ctx = { athleteId: F, runId: "", skillId: "chat", turn: { factKeys: new Map(), conversationId: "c", offeredConnectors: [], today: day(0) } } as any;
  const prepared = await tool.prepare!(ctx, tool.args.parse({ subject_kind: "event", subject_name: "Playoff game vs Rivals", claim: "Our first playoff game is against the Rivals.", date: day(10), game: true })) as any;
  expect(prepared.error).toBeUndefined();
  await tool.execute!(ctx, prepared.args);
  const [game] = await dbStore.listFacts(F, ["active"]);
  expect(game).toMatchObject({ topic: GAME_TOPIC, date: day(10) });

  const { sweepPlanRefresh } = await import("../plan/triggers");
  const started: any[] = [];
  const out = await sweepPlanRefresh({ start: async (o) => { started.push(o); return { runId: `wf-${started.length}`, created: true }; } });
  expect(out).toMatchObject({ events: 1, scheduled: 0 });
  expect(started.map((s) => [s.athleteId, s.input.trigger])).toEqual([[F, "event"]]);

  // Eleven days on: the game is a day past.
  const later = new Date(Date.now() + 11 * DAY);
  const deps = await dbPassedGamesDeps();
  const keys: string[] = [];
  const emit = async (e: { dedupeKey: string }) => { keys.push(e.dedupeKey); return "ev"; };
  expect(await sweepPassedGames({ ...deps, emit }, later)).toMatchObject({ events: 1 });
  expect(keys).toEqual([`event_passed:${game.id}`]);

  // Their typed result about it is a fact about the event, never a second game to wake up for.
  await dbStore.insertFacts(F, [{ subject: { kind: "event", name: "Playoff game vs Rivals" }, claim: "Playoff game vs Rivals: won 3-1", type: "said", topic: "result", source: { ref: "test#said" }, date: day(10), confidence: 1, runId: null }]);
  keys.length = 0;
  await sweepPassedGames({ ...deps, emit }, later);
  expect(keys).toEqual([`event_passed:${game.id}`]);
}, 60_000);
