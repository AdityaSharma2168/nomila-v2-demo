/**
 * planFollowUp.test — the open chat's half of the plan-ready follow-up: which run a turn waits on, when the run is over
 * (the goals read no longer names it), and what the re-read conversation does to the chat: Mila's row added once under
 * a done card, or the card failed when no tell step ran; nothing claimed when the chat only stopped waiting.
 */
import { advancePlanCard, applyPlanFollowUp, planReadyCardId, runningPlanRunId, stillPlanning, type FollowMessage } from "./planFollowUp";
import { GOALS_PLAN_FIXTURE } from "./goalsFixtures";
import type { AgentGoalsResponse } from "../../../shared/plan";

const RUN = "wf-run-1";
const progress = (state: "running" | "done" | "failed", runId = RUN) => ({
  id: `plan-progress:${runId}`, kind: "progress", title: "Updating your plan", links: [], runId: "chat-run",
  payload: { step: 1, of: 2, label: "Planning your week", state, planRunId: runId, steps: [{ label: "Planning your week", state: "running" }, { label: "Getting your post kits ready", state: "pending" }] },
});
const ready = { id: planReadyCardId(RUN), kind: "open-screen", title: "This week's plan", payload: { screen: "goals", id: null, label: "your goals", why: "3 posts · 3 kits built" }, links: [], runId: null };
const chat: FollowMessage[] = [
  { id: "u-1", role: "user", content: "Refresh my plan" },
  { id: "a-2", role: "assistant", content: "On it.", cards: [progress("running")] },
];
let n = 10;
const mint = () => `a-${++n}`;

it("the run a turn waits on: a running progress card's planRunId only", () => {
  expect(runningPlanRunId([progress("running")])).toBe(RUN);
  expect(runningPlanRunId([progress("done")])).toBeNull();
  expect(runningPlanRunId([{ kind: "progress", payload: { state: "running" } }])).toBeNull();   // the onboarding research card
  expect(runningPlanRunId(undefined)).toBeNull();
});

it("still planning only while the goals read names this run", () => {
  const read = (planning: AgentGoalsResponse["planning"]): AgentGoalsResponse => ({ ...GOALS_PLAN_FIXTURE, planning });
  expect(stillPlanning(read({ runId: RUN, step: "post_kits", startedAt: "2026-10-12T09:00:00.000Z" }), RUN)).toBe(true);
  expect(stillPlanning(read({ runId: "another", step: "plan", startedAt: "2026-10-12T09:00:00.000Z" }), RUN)).toBe(false);
  expect(stillPlanning(read(null), RUN)).toBe(false);
  expect(stillPlanning(null, RUN)).toBe(false);
});

it("Mila came back: the card turns done (every step done) and her row goes under it, once", () => {
  const rows = [
    { role: "user" as const, content: "Refresh my plan", agentCards: null },
    { role: "assistant" as const, content: "On it.", agentCards: [progress("done")] },
    { role: "assistant" as const, content: "Your plan's ready: 3 posts this week, and all 3 kits are built.", agentCards: [ready] },
  ];
  const after = applyPlanFollowUp(chat, rows, RUN, mint);
  expect(after).toHaveLength(3);
  expect((after[1].cards![0] as any).payload).toMatchObject({ state: "done", step: 2, steps: [{ state: "done" }, { state: "done" }] });
  expect(after[2]).toEqual({ id: "a-11", role: "assistant", content: "Your plan's ready: 3 posts this week, and all 3 kits are built.", cards: [ready] });
  // Applied again (a second check, a reopen): nothing is added twice.
  expect(applyPlanFollowUp(after, rows, RUN, mint)).toHaveLength(3);
});

it("no tell step ran (the run failed outright): the card fails and says the plan stands; nothing added", () => {
  const after = applyPlanFollowUp(chat, [{ role: "assistant", content: "On it.", agentCards: [progress("running")] }], RUN, mint);
  expect(after).toHaveLength(2);
  expect((after[1].cards![0] as any).payload).toMatchObject({ state: "failed", steps: [{ state: "failed" }, { state: "pending" }] });
});

it("the chat only stopped waiting (15 minutes): nothing is claimed", () => {
  expect(applyPlanFollowUp(chat, [], RUN, mint, false)).toBe(chat);
});

it("another run's card is never touched", () => {
  const other: FollowMessage[] = [{ id: "a-3", role: "assistant", content: "On it.", cards: [progress("running", "wf-other")] }];
  expect(applyPlanFollowUp(other, [], RUN, mint)).toEqual(other);
});

it("while it runs, the card shows the step the run is on: planning, then the post kits", () => {
  const moved = advancePlanCard(chat, RUN, "post_kits");
  expect((moved[1].cards![0] as any).payload).toMatchObject({ step: 2, label: "Getting your post kits ready", state: "running", steps: [{ state: "done" }, { state: "running" }] });
  expect(advancePlanCard(moved, RUN, "post_kits")).toBe(moved);          // nothing moved: the same array
  expect(advancePlanCard(chat, "wf-other", "post_kits")).toBe(chat);     // another run's card: untouched
});
