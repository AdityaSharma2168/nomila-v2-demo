/**
 * milaTurn.test.ts (was tfTurn.test.ts) — agent_onboarding's turns as Mila turns in the waitlist conversation
 * (MILA_TF_WAITLIST; docs/design/mila-hosted-waitlist.md). In-memory store; the Mila turn is faked (it records what it
 * was asked and leaves a finished run, as runMilaTurn does); no model, provider or network.
 *
 *   O1  the flag picks the path: off ⇒ today's takeTurn, on ⇒ the Mila turn
 *   O2  opening: the same conversation as the waitlist; code shows the M.I.A. preview then the facts list; reveal and
 *       facts_review advance; Mila is told the step and the cards; the record is readable as a turn
 *   O3  a retried step reuses its finished run (no second Mila turn)
 *   O4  insights: the Brief's rate ranges and the plan's recommended goals, by code
 *   O5  her turns, one group at a time: connect offers → capabilities → consent; her taps reach Mila
 *   O6  waiting phase: no cards; a failed Mila turn falls back to takeTurn with her taps already applied
 */
jest.mock("../../db", () => ({ db: {} }));

import { FIXTURES } from "../../testUtils/agentModel";
import { createMemoryStore, type AgentStore } from "../research/store";
import type { MiaPreview } from "../../../shared/agent";
import { CAPABILITIES, CONNECTORS } from "./catalog";
import { setMiaPreviewProvider } from "./miaPreview";
import { onboardingTurnFn, takeMilaTurn, STEP_LINES } from "./milaTurn";
import { takeTurn, turnPrefix, type TurnContext } from "./turn";
import { waitlistConversationId } from "../waitlist/turn";

const athleteId = "00000000-0000-4000-8000-0000000000cc";
const ENV: Record<string, string> = {
  // The waitlist needs only its own flag (no engine switch, no /mcp, no TRUEFORGE_* settings).
  MILA_TF_WAITLIST: "true",
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterEach(() => setMiaPreviewProvider(null));

function preview(score: number): MiaPreview {
  return { score, scale: { min: 0, max: 850 }, groups: [], assessment: null, preliminary: true, label: "Preliminary", confidence: { level: "MEDIUM", explanation: "" },
    inputs: { public: [], measured: [] }, sharpen: [], evidenceAsOf: "2026-10-26T00:00:00.000Z", identity: { uncertain: false, factIds: [] }, provenance: null } as unknown as MiaPreview;
}

async function setup() {
  const store = createMemoryStore();
  const f = FIXTURES.college;
  const facts = await store.insertFacts(athleteId, f.pages.filter((p) => p.sensitivity !== "never").map((p) => ({
    subject: { kind: "athlete" as const, name: f.name }, claim: p.claim, type: "found" as const, source: { url: p.url, title: p.title },
    date: null, confidence: 0.9, runId: null, sensitive: p.sensitivity === "care",
  })));
  await store.setCheckpoint(athleteId, "wf1", "name_sport", { status: "done" });
  const ctx: TurnContext = { store, athleteId, scope: "wf1", athlete: { name: f.name, sport: f.sport }, connected: [] };
  return { store, facts, ctx };
}

/** A fake Mila turn: records the call and leaves a completed run under the given parent ref (as runMilaTurn). */
function fakeRun(store: AgentStore, reply: string | null = "Here's what I found.") {
  const calls: any[] = [];
  const run = async (p: any, _deps: any, opts: any) => {
    calls.push({ p, opts });
    const runId = await store.startRun({ athleteId, skillId: "chat", skillVersion: "tf:mila-dev", trigger: opts.trigger, model: "mila-dev", parentRef: opts.parentRef } as any);
    if (reply === null) return { runId, text: "", status: "failed", stopReason: "error", cards: [], cost: {} };
    await store.finishRun(athleteId, runId, { status: "completed", stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 0 }, steps: [], evidenceRead: [], output: null, error: null } as any);
    return { runId, text: reply, status: "completed", stopReason: null, cards: [], cost: {} };
  };
  return { calls, run: run as any };
}
const updatesOf = (c: any) => (c.opts.updates as string[]).join("\n");

test("O1: the flag picks the path", () => {
  expect(onboardingTurnFn()).not.toBe(takeTurn);
  process.env.MILA_TF_WAITLIST = "false";
  try { expect(onboardingTurnFn()).toBe(takeTurn); } finally { process.env.MILA_TF_WAITLIST = "true"; }
});

test("O2–O3: opening — the waitlist conversation, the preview then the facts, checkpoints, the record; a retry reuses it", async () => {
  const { store, ctx, facts } = await setup();
  setMiaPreviewProvider(async () => preview(612));
  const mila = fakeRun(store);
  const r = await takeMilaTurn(ctx, { message: null, actions: [], reply: true, turnKey: "opening", phase: "ready" }, { runTurn: mila.run });

  expect(mila.calls).toHaveLength(1);
  expect(mila.calls[0].p.conversationId).toBe(waitlistConversationId(athleteId));
  expect(mila.calls[0].p.message).toBeNull();
  expect(mila.calls[0].opts.parentRef).toBe(`${turnPrefix("wf1")}opening`);
  expect(updatesOf(mila.calls[0])).toContain(STEP_LINES.opening);
  expect(updatesOf(mila.calls[0])).toMatch(/Under your reply the app shows: their preliminary M\.I\.A\. score \(612 of 850\); the \d+ facts Nomila found/);

  expect(r.cards.map((c) => c.kind)).toEqual(["mia-preview", "fact-review"]);
  expect((r.cards[1].payload as any).facts.length).toBe(facts.length);
  expect(r.message).toBe("Here's what I found.");
  expect(r.checkpoints.reveal.status).toBe("done");
  expect(r.checkpoints.facts_review.status).toBe("done");
  const runs = await store.listRunsByPrefix(athleteId, turnPrefix("wf1"));
  expect((runs[0].output as any).turn).toMatchObject({ message: "Here's what I found.", pathNote: "mastra" });

  const again = await takeMilaTurn(ctx, { message: null, actions: [], reply: true, turnKey: "opening", phase: "ready" }, { runTurn: mila.run });
  expect(mila.calls).toHaveLength(1);
  expect(again.runId).toBe(r.runId);
});

test("O4: insights — the Brief's ranges and the plan's goals, by code; the preview once", async () => {
  const { store, ctx, facts } = await setup();
  setMiaPreviewProvider(async () => preview(612));
  const mila = fakeRun(store);
  await takeMilaTurn(ctx, { message: null, actions: [], reply: true, turnKey: "opening" }, { runTurn: mila.run });
  await store.insertDecision(athleteId, { runId: null, skillId: "plan", kind: "goal", suggested: "Land a first local partner", why: "Season start.", evidence: [{ kind: "fact", factId: facts[0].id }], detail: { horizon: "now" } } as any);
  const internal = jest.spyOn(store, "currentBriefInternal").mockResolvedValue({ rateRanges: [{ rateType: "ig_post", low: 100, high: 300, currency: "USD", confidence: "low", drivers: [], factIds: [] }] } as any);
  const r = await takeMilaTurn(ctx, { message: null, actions: [], reply: true, turnKey: "insights" }, { runTurn: mila.run });
  internal.mockRestore();
  expect(r.cards.map((c) => c.kind)).toEqual(["rate-ranges", "goal-proposal"]);
  expect(updatesOf(mila.calls[1])).toContain(STEP_LINES.insights);
  expect(r.checkpoints.goal.status).toBe("offered");
});

test("O5: her turns — connect offers, then capabilities, then consent; her taps reach Mila", async () => {
  const { store, ctx, facts } = await setup();
  const mila = fakeRun(store);
  await takeMilaTurn(ctx, { message: null, actions: [], reply: true, turnKey: "opening" }, { runTurn: mila.run });

  const t1 = await takeMilaTurn(ctx, { message: "Looks right", actions: [{ type: "fact_review", factId: facts[0].id, action: "confirm" }], reply: true }, { runTurn: mila.run });
  expect(t1.cards.map((c) => c.kind)).toEqual(CONNECTORS.map(() => "connect"));
  expect(updatesOf(mila.calls[1])).toMatch(/The athlete tapped: confirmed: /);
  expect(mila.calls[1].p.message).toBe("Looks right");
  expect(t1.checkpoints.connect_offers.status).toBe("done");

  const t2 = await takeMilaTurn(ctx, { message: "ok", actions: [], reply: true }, { runTurn: mila.run });
  expect(t2.cards.map((c) => c.kind)).toEqual(CAPABILITIES.map(() => "capability"));
  expect(t2.checkpoints.capabilities.status).toBe("done");

  const t3 = await takeMilaTurn(ctx, { message: "and then?", actions: [], reply: true }, { runTurn: mila.run });
  expect(t3.cards.map((c) => c.kind)).toEqual(["consent"]);
  const t4 = await takeMilaTurn(ctx, { message: null, actions: [{ type: "consent", consentId: "how_mila_works/1", response: "agree" }], reply: true }, { runTurn: mila.run });
  expect(t4.checkpoints.consent.status).toBe("done");
  expect(t4.done).toBe(true);
});

test("O6: waiting shows no cards; a failed Mila turn falls back to takeTurn with her taps applied once", async () => {
  const { store, ctx, facts } = await setup();
  const ok = fakeRun(store, "Still reading.");
  const w = await takeMilaTurn(ctx, { message: "hi", actions: [], reply: true, phase: "waiting" }, { runTurn: ok.run });
  expect(w.cards).toEqual([]);
  expect(updatesOf(ok.calls[0])).toMatch(/research is still running/);

  const failing = fakeRun(store, null);
  const fallback = jest.fn(async (_ctx: TurnContext, input: any) => ({ runId: "old", turn: 9, athleteInput: { message: input.message, actions: [] }, message: "Today's path.", cards: [], checkpoints: await store.getCheckpoints(athleteId, "wf1"), pathNote: "", held: [], errors: [], done: false }));
  const r = await takeMilaTurn(ctx, { message: "remove that", actions: [{ type: "fact_review", factId: facts[1].id, action: "remove" }], reply: true }, { runTurn: failing.run, fallback: fallback as any });
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(fallback.mock.calls[0][1].actions).toEqual([]);                  // her tap is not applied twice
  expect(r.message).toBe("Today's path.");
  expect(r.athleteInput.actions[0]).toMatch(/^removed: /);
  const [gone] = await store.getFacts(athleteId, [facts[1].id]);
  expect(gone.status).toBe("removed");
});

test("O7: a turn whose answer is only a card waiting on their tap is an answer (no fallback; the card is kept)", async () => {
  const { store, ctx } = await setup();
  const mila = fakeRun(store, "");
  const action = { id: "a1", kind: "action", title: "Save this?", payload: {}, links: [], runId: "r" };
  const run = async (p: any, deps: any, opts: any) => ({ ...(await mila.run(p, deps, opts)), approvalState: "awaiting_approval", cards: [action] });
  const fallback = jest.fn();
  const r = await takeMilaTurn(ctx, { message: "remember I train mornings", actions: [], reply: true, phase: "waiting" }, { runTurn: run as any, fallback: fallback as any });
  expect(fallback).not.toHaveBeenCalled();
  expect(r.message).toBe("");
  expect(r.cards.map((c) => c.kind)).toContain("action");

  // the same empty answer with no waiting card still falls back
  const fb = jest.fn(async (_ctx: TurnContext, input: any) => ({ runId: "old", turn: 9, athleteInput: { message: input.message, actions: [] }, message: "Today's path.", cards: [], checkpoints: await store.getCheckpoints(athleteId, "wf1"), pathNote: "", held: [], errors: [], done: false }));
  await takeMilaTurn(ctx, { message: "hello", actions: [], reply: true, phase: "waiting" }, { runTurn: fakeRun(store, "").run, fallback: fb as any });
  expect(fb).toHaveBeenCalledTimes(1);
});
