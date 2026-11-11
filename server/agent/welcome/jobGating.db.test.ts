/**
 * jobGating.db.test.ts — the always-on OPTIONAL jobs ask the athlete's choice (owner, 28 Oct 2026), on a real (PGlite)
 * Postgres. Run starters and media are faked: no workflow runs, no provider is reached. Made-up athletes only.
 *
 * Three athletes: YES said yes to each job's capability, UNSET never answered, PAUSED said yes then paused.
 *   G1 MILA_WELCOME off: every job runs for all three, exactly as before
 *   G2 on: the weekly moments scan, post ideas, the weekly plan refresh and the monthly research refresh start only
 *      for YES; the athletes who never chose them do not take the sweep's batch slots
 *   G3 on: an automatic plan event (notifyPlanEvent) refreshes only YES's plan
 *   G4 on: auto-archive files only YES's quiet deals; UNSET's stay in their list
 *   G5 on: the research refresh still reaches athletes with recent research (the anchor refresh is data upkeep, core)
 *   G6 on: the per-opportunity pass of auto-archive (sweepOpportunities: filing, and "going quiet" marks) also asks
 *      first; off, every athlete's quiet opportunity is filed as before
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
// The real runner's selection helpers stay; starting and kicking a run are faked, so no workflow or model ever runs.
const mockStartRun = jest.fn(async (o: { athleteId: string }) => ({ run: { id: `wf-${o.athleteId}` }, created: true }));
jest.mock("../../workflow/runner", () => ({ ...jest.requireActual("../../workflow/runner"), startRun: (o: any) => mockStartRun(o), kick: async () => undefined }));

import { inArray } from "drizzle-orm";
import { agentRuns, deals, inboxThreads, opportunities } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dbStore } from "../research/dbStore";
import { sweepMomentsScan, type MomentsRunStarter } from "../moments/triggers";
import { notifyPlanEvent, sweepPlanRefresh } from "../plan/triggers";
import { sweepPostIdeas, type IdeasDeps } from "../postKit/ideas";
import { refreshCandidates, sweepResearchRefresh, type RefreshStarter } from "../researchRefresh/sweep";
import { archiveStaleDeals, ARCHIVE_DORMANT_DAYS } from "../../skills/archiveStaleDeals";
import { setChoice } from "./choices";
import { OPTIONAL_JOBS } from "./gate";

const FLAGS = ["MILA_WELCOME", "AGENT_MOMENTS", "AGENT_POST_KITS", "AGENT_PLAN", "AGENT_RESEARCH_REFRESH", "AGENT_RESEARCH_REFRESH_COHORT"] as const;
const saved: Record<string, string | undefined> = {};
const NOW = new Date();
const DAY = 86_400_000;
let YES = "", UNSET = "", PAUSED = "", RECENT = "";

const flagsOn = () => { for (const k of FLAGS) if (k !== "MILA_WELCOME") process.env[k] = "true"; };
const brief = (id: string) => dbStore.writeBrief(id, { summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
const person = (name: string) => seedAthlete(name, { sport: "Rowing", status: "active", auth_id: `uid-${name}` } as any);

beforeAll(async () => {
  for (const k of FLAGS) saved[k] = process.env[k];
  await initTestDb();
  YES = await person("Said Yes");
  UNSET = await person("Never Answered");
  PAUSED = await person("Paused It");
  RECENT = await person("Recently Researched");
  for (const id of [YES, UNSET, PAUSED]) await brief(id);
  await db.insert(agentRuns).values({ athlete_id: RECENT, skill_id: "research/merge", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "high", status: "completed", started_at: new Date(NOW.getTime() - 3 * DAY), ended_at: new Date(NOW.getTime() - 3 * DAY) });

  flagsOn();
  process.env.MILA_WELCOME = "true";
  for (const { capability } of Object.values(OPTIONAL_JOBS)) {
    if (capability === "post_took_off") continue;   // the learning loop's message: learning.test.ts
    expect(await setChoice({ athleteId: YES, capability, to: "enabled", via: "me" })).toMatchObject({ ok: true });
    expect(await setChoice({ athleteId: PAUSED, capability, to: "enabled", via: "card" })).toMatchObject({ ok: true });
    expect(await setChoice({ athleteId: PAUSED, capability, to: "paused", via: "chat" })).toMatchObject({ ok: true });
  }
});
afterAll(async () => {
  for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeTestDb();
});
beforeEach(() => { flagsOn(); delete process.env.MILA_WELCOME; });

const ours = (ids: string[]) => ids.filter((id) => [YES, UNSET, PAUSED].includes(id)).sort();
const three = () => [YES, UNSET, PAUSED].sort();

async function runSweeps() {
  const moments: string[] = [];
  const startMoments: MomentsRunStarter = async (o) => { moments.push(o.athleteId); return { runId: `m-${moments.length}`, created: true }; };
  await sweepMomentsScan({ start: startMoments });

  const plans: string[] = [];
  await sweepPlanRefresh({ start: async (o: any) => { plans.push(o.athleteId); return { runId: `p-${plans.length}`, created: true }; } });

  const looked: string[] = [];
  const deps = { store: dbStore, now: NOW, media: { newlyTagged: async (athleteId: string) => { looked.push(athleteId); return []; } } } as unknown as IdeasDeps;
  await sweepPostIdeas(deps, { limit: 50 });

  const research: string[] = [];
  const startResearch: RefreshStarter = async (o) => { research.push(o.athleteId); return { runId: `r-${research.length}`, created: true }; };
  await sweepResearchRefresh({ start: startResearch, limit: 50 });

  return { moments: ours(moments), plans: ours(plans), ideas: ours(looked), research: ours(research) };
}

test("G1: MILA_WELCOME off — every optional job runs for every athlete, as before", async () => {
  expect(await runSweeps()).toEqual({ moments: three(), plans: three(), ideas: three(), research: three() });
});

test("G2: on — moments, post ideas, the weekly plan and the monthly research refresh only for the athlete who said yes", async () => {
  process.env.MILA_WELCOME = "true";
  expect(await runSweeps()).toEqual({ moments: [YES], plans: [YES], ideas: [YES], research: [YES] });
});

test("G3: an automatic plan event (notifyPlanEvent) — off: every athlete; on: only the athlete who said yes", async () => {
  // notifyPlanEvent is fire-and-forget on the default starter: the runner's startRun is faked above (no run, no model).
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10)); };
  const asked = () => ours(mockStartRun.mock.calls.map((c: any[]) => c[0].athleteId));
  mockStartRun.mockClear();
  for (const id of [YES, UNSET, PAUSED]) notifyPlanEvent(id, "a new deal");
  await settle();
  expect(asked()).toEqual(three());

  process.env.MILA_WELCOME = "true";
  mockStartRun.mockClear();
  for (const id of [YES, UNSET, PAUSED]) notifyPlanEvent(id, "a new deal");
  await settle();
  expect(asked()).toEqual([YES]);
});

test("G4: on — auto-archive files only the quiet deals of the athlete who said yes", async () => {
  const quiet = new Date(NOW.getTime() - (ARCHIVE_DORMANT_DAYS + 10) * DAY);
  const mk = async (athleteId: string) => {
    const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Example Brand", status: "detected" } as any).returning();
    const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: d.id, subject: "Hello", status: "read", last_message_at: quiet } as any).returning();
    return t.id as string;
  };
  const statusOf = async (ids: string[]) => (await db.select({ id: inboxThreads.id, s: inboxThreads.status }).from(inboxThreads).where(inArray(inboxThreads.id, ids)))
    .reduce<Record<string, string | null>>((m, r) => ({ ...m, [r.id]: r.s }), {});

  // Off: every athlete's quiet deals are filed, as before.
  const off = { yes: await mk(YES), unset: await mk(UNSET), paused: await mk(PAUSED) };
  await archiveStaleDeals(NOW);
  expect(Object.values(await statusOf(Object.values(off)))).toEqual(["archived", "archived", "archived"]);

  process.env.MILA_WELCOME = "true";
  const on = { yes: await mk(YES), unset: await mk(UNSET), paused: await mk(PAUSED) };
  await archiveStaleDeals(NOW);
  const s = await statusOf(Object.values(on));
  expect({ yes: s[on.yes], unset: s[on.unset], paused: s[on.paused] }).toEqual({ yes: "archived", unset: "read", paused: "read" });
});

test("G5: on — athletes with recent research stay candidates for the anchor refresh; stale ones only after a yes", async () => {
  process.env.MILA_WELCOME = "true";
  const ids = (await refreshCandidates(500, { staleBefore: new Date(NOW.getTime() - 30 * DAY) })).map((c) => c.athleteId);
  expect(ids).toEqual(expect.arrayContaining([YES, RECENT]));
  expect(ids).not.toContain(UNSET);
  expect(ids).not.toContain(PAUSED);
});

test("G6: on — the per-opportunity auto-archive pass files and marks only the athlete who said yes", async () => {
  const quiet = new Date(NOW.getTime() - (ARCHIVE_DORMANT_DAYS + 10) * DAY);
  const mk = async (athleteId: string, cash: number | null) => {
    const [o] = await db.insert(opportunities).values({ athlete_id: athleteId, status: "open", opened_at: quiet, last_activity_at: quiet } as any).returning();
    const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Example Co", status: "detected", deal_type: "social_post", amount_cash: cash == null ? null : String(cash), opportunity_id: o.id } as any).returning();
    await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: d.id, subject: "Hi", status: "read", last_message_at: quiet } as any);
    return o.id as string;
  };
  const state = async (ids: string[]) => (await db.select({ id: opportunities.id, s: opportunities.status, q: opportunities.going_quiet_at }).from(opportunities).where(inArray(opportunities.id, ids)))
    .reduce<Record<string, string>>((m, r) => ({ ...m, [r.id]: r.q ? "quiet" : String(r.s) }), {});

  const off = [await mk(YES, null), await mk(UNSET, null), await mk(PAUSED, null)];
  await archiveStaleDeals(NOW);
  expect(Object.values(await state(off))).toEqual(["closed", "closed", "closed"]);

  process.env.MILA_WELCOME = "true";
  const on = { yes: await mk(YES, null), unset: await mk(UNSET, null), paused: await mk(PAUSED, null) };
  await archiveStaleDeals(NOW);
  const s = await state(Object.values(on));
  expect({ yes: s[on.yes], unset: s[on.unset], paused: s[on.paused] }).toEqual({ yes: "closed", unset: "open", paused: "open" });
});
