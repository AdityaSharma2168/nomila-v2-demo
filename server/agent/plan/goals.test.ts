/**
 * goals.test.ts — the goals service behind the chat agent's goal tools and the app routes (in-memory store; no model).
 *
 *   G1 the read: active goals with their game plan and this week's actions (waiting first, soonest due; done this week
 *      after), set-aside goals, recommendations with their sources and held actions, Home's "Coming up" (≤ 3, next 60
 *      days, dated facts only, actions ready per event), the biggest risk and upside, what would help
 *   G2 keep: a recommendation becomes a goal (horizon, game plan), its held actions follow; Undo puts it back
 *   G3 change (a game plan you write is yours), set aside (waiting actions expire, never an approval), drop, bring
 *      back — each recorded with what it was, and each undone exactly
 *   G4 add (your words; a duplicate is refused), suggest (a recommendation only, on real non-personal facts), skip
 *   G5 results: per goal, what you did and what came back
 *   G6 the goal tools: list is read, every write is draft; a write returns a goal-change card with Undo, built by code;
 *      a refused write tells the model in words; refresh_plan is off unless AGENT_PLAN
 *   G7 (0119) a goal's domain is served and a kept recommendation brings its own; Coming up keeps a month as a month
 *   G8 a prepared post opens its kit; another prepared kind opens the library
 *   G9 a post action carries its idea, pillar and kit in short and always opens its kit; an older post or another kind: nulls
 *   G10 the read's `planning` comes from deps.planning, null without it
 *   G11 plan 1.5.0: once or standing, on the recommendation and the goal kept from it; every waiting post shows
 *   G12 Moments: what the moments step chose and still holds
 *   G13 plan 1.7.0: a post_brief's caption, tags and shots reach the start prompt
 */
jest.mock("../../db", () => ({ db: {} }));

import type { Decision } from "../../../shared/agent";
import type { ActionDecisionDetail, GoalChangeDetail } from "../../../shared/plan";
import { createMemoryStore, type AgentStore } from "../research/store";
import {
  actionView, addGoal, bringBackGoal, changeGoal, dropGoal, GoalsError, keepRecommended, readGoals, readResults, setAsideGoal, skipRecommended,
  suggestGoal, undoChange,
} from "./goals";
import { goalTools } from "./tools";

const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-10T09:00:00.000Z");
afterEach(() => jest.useRealTimers());

const detail = (over: Partial<ActionDecisionDetail> = {}): Record<string, unknown> => ({
  kind: "pitch", what: "Pitch a shop", button: "send", dueOn: null, event: null, state: "to_start",
  deliverable: { type: "pitch", title: "Hello", body: "I'd love to work with you.", target: { subjectKind: "brand", name: "Shop One" }, platform: null, thread: null, connector: null },
  ...over,
});

async function seed(store: AgentStore) {
  const [result, opener, clinic, far, past, care, undated] = await store.insertFacts(A, [
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example won the conference final.", type: "found", source: { url: "https://example.org/final", title: "Final report" }, date: "2026-05-01", confidence: 0.9, runId: null },
    { subject: { kind: "event", name: "Home opener" }, claim: "The home opener is on 18 October.", type: "found", source: { url: "https://example.org/s1" }, date: "2026-10-18", confidence: 0.9, runId: null, topic: "upcoming" },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example runs a youth clinic on 22 October.", type: "found", source: { url: "https://example.org/s2" }, date: "2026-10-22", confidence: 0.9, runId: null, topic: "upcoming" },
    { subject: { kind: "event", name: "Winter final" }, claim: "The winter final is in January.", type: "found", source: { url: "https://example.org/s3" }, date: "2027-01-20", confidence: 0.9, runId: null, topic: "upcoming" },
    { subject: { kind: "event", name: "Last season's final" }, claim: "Last season's final.", type: "found", source: { url: "https://example.org/s4" }, date: "2026-09-01", confidence: 0.9, runId: null, topic: "upcoming" },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example is recovering from a knee injury.", type: "found", source: { url: "https://example.org/s5" }, date: null, confidence: 0.9, runId: null, sensitive: true, careKind: "personal" },
    { subject: { kind: "event", name: "Some day" }, claim: "A showcase is coming up.", type: "found", source: { url: "https://example.org/s6" }, date: null, confidence: 0.9, runId: null, topic: "upcoming" },
  ]);
  await store.writeBrief(A, { summary: "S", runId: null, factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, sections: [
    { key: "risks_upside", title: "Biggest risk and biggest upside", text: "", factIds: [], lines: [
      { text: "Biggest risk: a quiet off-season could cost reach.", kind: "inference", factIds: [] },
      { text: "Biggest upside: the comeback story opens bigger brands.", kind: "inference", factIds: [] },
    ] },
  ] });
  const goal = await store.insertGoal(A, { text: "Land my first paid partnership", source: "said", decisionId: null, horizon: "next", gamePlan: "Pitch two shops." });
  const rec = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "Be the face of your community work", why: "Your clinics get shared most.", evidence: [{ kind: "fact", factId: result.id }, { kind: "fact", factId: care.id }],
    detail: { key: "R1", horizon: "later", value: { text: "Reach and a stronger story", low: null, high: null, currency: null, drivers: [] }, valueConfidence: "low", nextDecision: "Pick a clinic to film.", gamePlan: ["Film one clinic.", "Post it with your words."] } });
  const ev = (f: typeof opener) => ({ factId: f.id, label: f.subject.name, date: f.date!, precision: "day" as const });
  const a1 = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Opener post", why: "Timed to the opener.", evidence: [], goalId: goal.id, detail: detail({ kind: "post", what: "Opener post", button: "post", dueOn: "2026-10-16", event: ev(opener) }) });
  const a2 = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Pitch a shop", why: "-", evidence: [], goalId: goal.id, detail: detail({ dueOn: "2026-10-14", event: ev(opener) }) });
  const a3 = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Connect Instagram", why: "So reach is measured.", evidence: [], goalId: goal.id, detail: detail({ kind: "connect", what: "Connect Instagram", button: "connect", deliverable: { type: "connect_request", title: "Connect", body: "", target: null, platform: null, thread: null, connector: "instagram" } }) });
  const held = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Film a clinic", why: "w", evidence: [], parentDecisionId: rec.id, detail: detail({ kind: "post", what: "Film a clinic", button: "post", dueOn: "2026-10-21", event: ev(clinic) }) });
  return { result, opener, clinic, far, past, care, undated, goal, rec, a1, a2, a3, held };
}

test("G1: the read — goals, this week's actions, recommendations, Coming up, risk and upside", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  // One action already done this week (sent), one done long ago (not this week).
  await store.respondDecision(A, s.a3.id, "accepted", null);
  const old = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Old reply", why: "-", evidence: [], goalId: s.goal.id, detail: detail({ kind: "reply" }) });
  (store as any).dump().decisions.find((d: Decision) => d.id === old.id).response = "accepted";
  (store as any).dump().decisions.find((d: Decision) => d.id === old.id).respondedAt = "2026-08-01T00:00:00.000Z";
  // Another athlete's goal never shows.
  await store.insertGoal(B, { text: "B's secret goal", source: "said", decisionId: null });

  const v = await readGoals(A, { store, now: NOW });
  expect(v.contract).toBe("agent-goals/1");
  expect(v.goals).toHaveLength(1);
  const g = v.goals[0];
  expect(g).toMatchObject({ id: s.goal.id, text: "Land my first paid partnership", plan: "Pitch two shops.", horizon: "next", inYourWords: true, gamePlanBy: "mila", nextEvent: { label: "Home opener", date: "2026-10-18" } });
  expect(g.actions.map((a) => [a.title, a.state, a.button, a.buttonLabel, a.when])).toEqual([
    ["Pitch a shop", "to_start", "start", "Start with Mila", "Wed 14 Oct"],        // nothing prepared yet: start with Mila
    ["Opener post", "to_start", "start", "Start with Mila", "Fri 16 Oct"],
    ["Connect Instagram", "done", "connect", "Connect", null],                      // done this week; a connect needs no prep
  ]);
  expect(g.actions[0]).toMatchObject({ kind: "pitch", planKind: "pitch", why: "", event: { label: "Home opener" }, startPrompt: expect.stringContaining("Start from this draft:\nI'd love to work with you.") });
  expect(g.actions[2].open).toEqual({ screen: "connect", params: { connector: "instagram" } });
  // Recommended: the plan's words, sources from its facts (never a care fact's), its held action.
  expect(v.recommended).toEqual([expect.objectContaining({
    decisionId: s.rec.id, goal: "Be the face of your community work", horizon: "later", why: "Your clinics get shared most.", value: "Reach and a stronger story",
    valueRange: null, valueConfidence: "low", nextDecision: "Pick a clinic to film.", gamePlan: "Film one clinic.\nPost it with your words.",
    sources: [{ label: "Final report", url: "https://example.org/final" }],
  })]);
  expect(v.recommended[0].actions.map((a) => a.title)).toEqual(["Film a clinic"]);
  // Coming up: the next three dated events in 60 days, soonest first; undated and past never; ready = waiting actions.
  expect(v.comingUp).toEqual([
    { date: "2026-10-18", precision: "day", label: "Home opener", factId: s.opener.id, goalId: s.goal.id, actionsReady: 2, kitActionId: null },
    { date: "2026-10-22", precision: "day", label: "Pat Example runs a youth clinic on 22 October", factId: s.clinic.id, goalId: null, actionsReady: 0, kitActionId: null },
  ]);
  expect(v.riskUpside).toEqual({ risk: "a quiet off-season could cost reach.", upside: "the comeback story opens bigger brands." });
  expect(v.setAside).toEqual([]);
  expect(v.plan).toBeNull();
  expect(JSON.stringify(v)).not.toContain("B's secret goal");
});

test("G1b: Coming up counts a post prepared under a goal still only recommended (built kit), and the row opens that kit", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const kit = { assets: [{ assetId: "x1" }], aiGenerationNeeded: { value: false }, preview: null };
  const row = (id: string) => (store as any).dump().decisions.find((d: Decision) => d.id === id);
  // the recommendation's post for the clinic: no kit yet → not ready
  let v = await readGoals(A, { store, now: NOW });
  expect(v.comingUp.find((c) => c.factId === s.clinic.id)).toMatchObject({ actionsReady: 0, kitActionId: null });
  // its kit is built → "1 ready", opening that kit (no goal held yet)
  row(s.held.id).detail = { ...row(s.held.id).detail, prepared: { postKit: kit } };
  v = await readGoals(A, { store, now: NOW });
  expect(v.comingUp.find((c) => c.factId === s.clinic.id)).toMatchObject({ actionsReady: 1, kitActionId: s.held.id, goalId: null });
  // a held goal's post with a built kit: the kit is the one opened
  row(s.a1.id).detail = { ...row(s.a1.id).detail, prepared: { postKit: kit } };
  v = await readGoals(A, { store, now: NOW });
  expect(v.comingUp.find((c) => c.factId === s.opener.id)).toMatchObject({ actionsReady: 2, kitActionId: s.a1.id, goalId: s.goal.id });
  // skipped recommendation or an expired post: not counted
  await store.respondDecision(A, s.held.id, "expired", "replaced");
  v = await readGoals(A, { store, now: NOW });
  expect(v.comingUp.find((c) => c.factId === s.clinic.id)).toMatchObject({ actionsReady: 0, kitActionId: null });
});

test("G2: keep — the recommendation becomes a goal and its held actions follow; Undo puts it back", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const k = await keepRecommended(A, s.rec.id, { text: "Be the face of our clinics" }, { store, now: NOW });
  expect(k.goal).toMatchObject({ text: "Be the face of our clinics", source: "proposed_accepted", horizon: "later", gamePlan: "Film one clinic.\nPost it with your words.", gamePlanBy: "mila", decisionId: s.rec.id });
  expect((await store.getDecision(A, s.rec.id))!).toMatchObject({ response: "edited", goalId: k.goal!.id });
  expect((await store.getDecision(A, s.held.id))!.goalId).toBe(k.goal!.id);
  expect(k.card).toMatchObject({ op: "keep", goalId: k.goal!.id, before: null, after: { text: "Be the face of our clinics", horizon: "later", status: "active" }, thisWeek: [{ title: "Film a clinic", state: "to_start" }], undoDecisionId: k.decisionId });
  const v = await readGoals(A, { store, now: NOW });
  expect(v.goals.find((g) => g.id === k.goal!.id)!.inYourWords).toBe(true);           // kept in the athlete's words
  expect(v.recommended).toEqual([]);
  await expect(keepRecommended(A, s.rec.id, {}, { store })).rejects.toMatchObject({ status: 409 });
  await expect(keepRecommended(B, s.rec.id, {}, { store })).rejects.toMatchObject({ status: 404 });   // another athlete's

  const u = await undoChange(A, k.decisionId!, { store, now: NOW });
  expect(u.card.after.status).toBe("recommended");
  expect(await store.getGoal(A, k.goal!.id)).toBeNull();
  expect((await store.getDecision(A, s.rec.id))!).toMatchObject({ response: "pending", goalId: null });
  expect((await store.getDecision(A, s.held.id))!).toMatchObject({ goalId: null, parentDecisionId: s.rec.id, response: "pending" });
  await expect(undoChange(A, k.decisionId!, { store })).rejects.toMatchObject({ status: 409 });   // once only
});

test("G3: change, set aside, drop, bring back — each recorded with what it was, each undone exactly", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const c = await changeGoal(A, s.goal.id, { text: "Land a first partnership with a local shop", horizon: "now", gamePlan: "Two local shops, my opener story." }, { store, now: NOW });
  expect(c.goal).toMatchObject({ text: "Land a first partnership with a local shop", horizon: "now", gamePlan: "Two local shops, my opener story.", gamePlanBy: "athlete" });
  const cd = (await store.getDecision(A, c.decisionId!))!;
  expect(cd).toMatchObject({ skillId: "goals", kind: "goal", response: "edited", goalId: s.goal.id });
  expect((cd.detail as unknown as GoalChangeDetail).from).toMatchObject({ text: "Land my first paid partnership", horizon: "next", gamePlan: "Pitch two shops.", gamePlanBy: "mila" });
  expect(c.card).toMatchObject({ op: "change", before: { text: "Land my first paid partnership", horizon: "next", status: "active" }, after: { horizon: "now" } });
  await expect(changeGoal(A, s.goal.id, {}, { store })).rejects.toBeInstanceOf(GoalsError);
  await expect(changeGoal(A, s.goal.id, { horizon: "someday" }, { store })).rejects.toMatchObject({ status: 400 });
  await undoChange(A, c.decisionId!, { store, now: NOW });
  expect((await store.getGoal(A, s.goal.id))!).toMatchObject({ text: "Land my first paid partnership", horizon: "next", gamePlan: "Pitch two shops.", gamePlanBy: "mila" });

  // Set aside: paused; waiting actions expire, but never one in the approval queue.
  (store as any).dump().decisions.find((d: Decision) => d.id === s.a2.id).approvalId = "00000000-0000-4000-8000-00000000a99a";
  const sa = await setAsideGoal(A, s.goal.id, { reason: "after the season" }, { store, now: NOW });
  expect(sa.goal!.status).toBe("paused");
  expect(Object.fromEntries((await store.listDecisions(A, { kinds: ["action"], goalId: s.goal.id })).map((d) => [d.suggested, d.response]))).toEqual({
    "Opener post": "expired", "Pitch a shop": "pending", "Connect Instagram": "expired",
  });
  expect((await readGoals(A, { store, now: NOW })).setAside.map((g) => g.id)).toEqual([s.goal.id]);
  await expect(setAsideGoal(A, s.goal.id, {}, { store })).rejects.toMatchObject({ status: 409 });
  await undoChange(A, sa.decisionId!, { store, now: NOW });
  expect((await store.getGoal(A, s.goal.id))!.status).toBe("active");
  expect((await store.getDecision(A, s.a1.id))!.response).toBe("pending");          // restored with the goal

  const sa2 = await setAsideGoal(A, s.goal.id, {}, { store, now: NOW });
  const back = await bringBackGoal(A, s.goal.id, {}, { store, now: NOW });
  expect(back.goal!.status).toBe("active");
  void sa2;
  const d = await dropGoal(A, s.goal.id, { reason: "not this year" }, { store, now: NOW });
  expect(d.goal!.status).toBe("dropped");
  expect((await store.getDecision(A, d.decisionId!))!).toMatchObject({ why: "not this year", response: "accepted" });
  expect((await readGoals(A, { store, now: NOW })).goals).toEqual([]);
  await expect(changeGoal(A, s.goal.id, { text: "x" }, { store })).rejects.toMatchObject({ status: 404 });   // dropped: gone from the tab
});

test("G4: add (your words; no duplicate), suggest (a recommendation only, on real facts), skip (not now)", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const a = await addGoal(A, { text: "  Grow my audience on  [Platform A] ", horizon: "now" }, { store, now: NOW });
  expect(a.goal).toMatchObject({ text: "Grow my audience on [Platform A]", source: "said", horizon: "now", status: "active" });
  expect(a.card).toMatchObject({ op: "add", after: { text: "Grow my audience on [Platform A]", status: "active" }, undoDecisionId: a.decisionId });
  await expect(addGoal(A, { text: "grow my audience on [platform a]" }, { store })).rejects.toMatchObject({ status: 409 });
  await expect(addGoal(A, { text: "   " }, { store })).rejects.toMatchObject({ status: 400 });

  await expect(suggestGoal(A, { goal: "Tell your comeback story", horizon: "now", whyNow: "w", factIds: [s.care.id] }, { store })).rejects.toMatchObject({ status: 400 });   // a personal care fact alone
  await expect(suggestGoal(A, { goal: "Grow my audience on [Platform A]", horizon: "now", whyNow: "w", factIds: [s.result.id] }, { store })).rejects.toMatchObject({ status: 409 });
  const sg = await suggestGoal(A, { goal: "Speak at a local school", horizon: "next", whyNow: "Your final is fresh news.", factIds: [s.result.id, "not-a-fact"] }, { store, now: NOW });
  expect(sg.card).toMatchObject({ op: "suggest", goalId: null, after: { status: "recommended" }, undoDecisionId: null });
  expect((await store.listGoals(A)).map((g) => g.text)).not.toContain("Speak at a local school");                  // nothing held changed
  const v = await readGoals(A, { store, now: NOW });
  expect(v.recommended.map((r) => r.goal)).toEqual(["Be the face of your community work", "Speak at a local school"]);

  const sk = await skipRecommended(A, s.rec.id, { reason: "not now" }, { store });
  expect(sk.expiredActionIds).toEqual([s.held.id]);
  expect((await store.getDecision(A, s.rec.id))!).toMatchObject({ response: "skipped", responseReason: "not now" });
});

test("G5: results — per goal, what you did and what came back", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  await store.respondDecision(A, s.a2.id, "accepted", null);
  (store as any).dump().decisions.find((d: Decision) => d.id === s.a2.id).outcomeNote = "They asked for your rates";
  await store.respondDecision(A, s.a3.id, "skipped", "later");
  const r = await readResults(A, { store, now: NOW });
  expect(r.contract).toBe("agent-results/1");
  expect(r.goals).toHaveLength(1);
  expect(r.goals[0]).toMatchObject({ goalId: s.goal.id, counts: { done: 1, skipped: 1, toDo: 1 }, next: { title: "Opener post", dueOn: "2026-10-16" } });
  expect(r.goals[0].actions.find((a) => a.title === "Pitch a shop")).toMatchObject({ response: "accepted", outcomeNote: "They asked for your rates", state: "done" });
});

test("G6: the goal tools — permissions, code-built goal-change cards with Undo, refusals in words, refresh off by default", async () => {
  // The tools read the clock (no `now` seam): pin the date so the seeded events stay upcoming whatever day this runs.
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "clearImmediate", "queueMicrotask", "performance", "hrtime"] });
  const store = createMemoryStore();
  const s = await seed(store);
  const tools = new Map(goalTools(store).map((t) => [t.name, t]));
  expect([...tools.values()].map((t) => [t.name, t.permission])).toEqual([
    ["list_goals", "read"], ["keep_goal", "draft"], ["change_goal", "draft"], ["set_aside_goal", "draft"], ["drop_goal", "draft"],
    ["bring_back_goal", "draft"], ["add_goal", "draft"], ["suggest_goal", "draft"], ["refresh_plan", "draft"],
  ]);
  const ctx = { athleteId: A, runId: "run-1", skillId: "chat" };
  const listed = (await tools.get("list_goals")!.execute!(ctx, {})) as any;
  expect(listed.recommended).toEqual([expect.objectContaining({ decision_id: s.rec.id, goal: "Be the face of your community work" })]);
  expect(listed.coming_up.map((c: any) => c.label)).toEqual(["Home opener", "Pat Example runs a youth clinic on 22 October"]);

  const changed = await tools.get("change_goal")!.execute!(ctx, { goal_id: s.goal.id, horizon: "now" });
  const card = tools.get("change_goal")!.card!(changed, ctx)!;
  expect(card).toMatchObject({ kind: "goal-change", title: "Goal changed", runId: "run-1", payload: { op: "change", goalId: s.goal.id, after: { horizon: "now" } }, links: [{ label: "See your goals", target: { screen: "goals" } }] });
  expect((card.payload as any).undoDecisionId).toBeTruthy();
  const refused = await tools.get("drop_goal")!.execute!(ctx, { goal_id: "00000000-0000-4000-8000-000000000000" });
  expect(refused).toEqual({ status: "error", reason: "goal not found" });
  expect(tools.get("drop_goal")!.card!(refused, ctx)).toBeNull();
  // Another athlete's run cannot touch this goal.
  expect(await tools.get("set_aside_goal")!.execute!({ ...ctx, athleteId: B }, { goal_id: s.goal.id })).toEqual({ status: "error", reason: "goal not found" });
  // Refused: the facts Mila says it from, in the same turn; no card.
  const notRefreshed = await tools.get("refresh_plan")!.execute!(ctx, {});
  expect(notRefreshed).toEqual({ status: "error", reason: `the plan was not refreshed: ${JSON.stringify({ refused: "off", used: 0, limit: 4, next_plan_on: null })}` });
  expect(tools.get("refresh_plan")!.card!(notRefreshed, ctx)).toBeNull();
  // Success says what changed, explicitly.
  expect(changed).toMatchObject({ status: "ok", changed: "change" });
  // The context block's "G:<id>" form is accepted; a chat's F-keys resolve to fact ids for suggest_goal.
  expect(await tools.get("change_goal")!.prepare!(ctx, { goal_id: `G:${s.goal.id}` })).toEqual({ args: { goal_id: s.goal.id } });
  const turn = { factKeys: new Map([["F1", s.result.id]]), conversationId: null, offeredConnectors: [], today: "2026-10-10" };
  expect(await tools.get("suggest_goal")!.prepare!({ ...ctx, turn }, { goal: "g", horizon: "next", why_now: "w", fact_ids: ["F1"] })).toEqual({ args: { goal: "g", horizon: "next", why_now: "w", fact_ids: [s.result.id] } });
  expect(await tools.get("suggest_goal")!.prepare!({ ...ctx, turn }, { goal: "g", horizon: "next", why_now: "w", fact_ids: ["F9"] })).toEqual({ error: expect.stringMatching(/none of those keys/) });
});

test("G7 (0119): a goal's domain is served and a kept recommendation brings its domain; Coming up keeps a month-only date as a month", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  await store.updateGoal(A, s.goal.id, { domain: "commercial" });
  await store.insertFacts(A, [{ subject: { kind: "event", name: "Winter showcase" }, claim: "The winter showcase is in November.", type: "found", source: { url: "https://example.org/s7" }, date: "2026-11-01", datePrecision: "month", confidence: 0.9, runId: null, topic: "upcoming" }]);
  const rec = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "Grow a following around your clinics", why: "w", evidence: [{ kind: "fact", factId: s.result.id }],
    detail: { key: "R2", horizon: "next", domain: "audience", value: { text: "Reach", low: null, high: null, currency: null, drivers: [] }, valueConfidence: "low", nextDecision: "n", gamePlan: [] } });
  const v = await readGoals(A, { store, now: NOW });
  expect(v.goals[0].domain).toBe("commercial");
  expect(v.recommended.map((r) => [r.goal, r.domain])).toEqual([["Be the face of your community work", null], ["Grow a following around your clinics", "audience"]]);
  expect(v.comingUp.map((c) => [c.label, c.date, c.precision])).toEqual([
    ["Home opener", "2026-10-18", "day"], ["Pat Example runs a youth clinic on 22 October", "2026-10-22", "day"], ["Winter showcase", "2026-11-01", "month"],
  ]);
  const kept = await keepRecommended(A, rec.id, {}, { store, now: NOW, start: async () => null } as any);
  expect(kept.goal).toMatchObject({ text: "Grow a following around your clinics", domain: "audience", horizon: "next" });
});

test("G8: a prepared post action opens its post kit directly; another prepared kind opens the library focused on it", async () => {
  const store = createMemoryStore();
  const post = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Opener post", why: "-", evidence: [],
    detail: detail({ kind: "post", what: "Opener post", button: "post", state: "made", prepared: { studioItemId: "placeholder" } }) });
  await store.updateDecision(A, post.id, { detail: { ...(post.detail as any), prepared: { studioItemId: post.id } } });
  const freshPost = await store.getDecision(A, post.id);
  expect(actionView(freshPost!).open).toEqual({ screen: "post-kit", params: { id: post.id } });

  const deck = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Pitch a shop", why: "-", evidence: [],
    detail: detail({ kind: "pitch", what: "Pitch a shop", button: "send", state: "made", prepared: { studioItemId: "placeholder" } }) });
  await store.updateDecision(A, deck.id, { detail: { ...(deck.detail as any), prepared: { studioItemId: deck.id } } });
  const freshDeck = await store.getDecision(A, deck.id);
  expect(actionView(freshDeck!).open).toEqual({ screen: "studio-item", params: { id: deck.id } });
});

test("G9: a post action carries its idea, pillar and kit in short, and always opens its post kit; other kinds carry nulls", async () => {
  const store = createMemoryStore();
  const goal = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
  const idea = { hook: "Nobody sees the early part.", format: "reel" as const, show: "The quiet start.", captionAngle: "What the early hours give.", avoid: "Other people's faces.", mediaNeeds: "One warm-up clip." };
  const pillar = { key: "P1", name: "Behind the scenes" };
  const kit = (assets: number, preview?: Record<string, unknown>) => ({
    contract: "post-kit/1", assets: Array.from({ length: assets }, (_, i) => ({ assetId: `asset-${i}` })), aiGenerationNeeded: { value: assets === 0, reason: "" },
    ...(preview ? { preview } : {}),
  });
  const ins = (what: string, over: Record<string, unknown>) => store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: what, why: "-", evidence: [], goalId: goal.id, detail: detail({ kind: "post", what, button: "post", ...over } as Partial<ActionDecisionDetail>) });

  const ready = await ins("Ready post", { state: "made", post: idea, idea: { ideaId: null, pillar }, prepared: { studioItemId: "x", postKit: kit(2, { status: "ready", requestedAt: "2026-10-10T08:00:00.000Z", outputs: [] }) } });
  const empty = await ins("Needs media", { prepared: { postKit: kit(0) } });
  const unbuilt = await ins("No kit yet", { post: idea });
  const older = await ins("Older post", {});
  const pitch = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Pitch a shop", why: "-", evidence: [], goalId: goal.id, detail: detail({ post: idea }) });

  expect(actionView(ready)).toMatchObject({ post: idea, pillar, kit: { built: true, assets: 2, aiGenerationNeeded: false, preview: { status: "ready", requestedAt: "2026-10-10T08:00:00.000Z" } }, open: { screen: "post-kit", params: { id: ready.id } } });
  expect(actionView(empty)).toMatchObject({ post: null, pillar: null, kit: { built: true, assets: 0, aiGenerationNeeded: true, preview: null } });
  // Not built yet: no kit, but the row still opens the kit screen (it says nothing is built yet).
  expect(actionView(unbuilt)).toMatchObject({ post: idea, kit: null, open: { screen: "post-kit", params: { id: unbuilt.id } } });
  // A post written before plan 1.3.0: nulls, and today's title stays.
  expect(actionView(older)).toMatchObject({ title: "Older post", post: null, pillar: null, kit: null });
  // Not a post: nulls, whatever the detail holds.
  expect(actionView(pitch)).toMatchObject({ post: null, pillar: null, kit: null, open: null });
});

test("G10: the read says whether a plan run is in progress (deps.planning), null without it", async () => {
  const store = createMemoryStore();
  expect((await readGoals(A, { store, now: NOW })).planning).toBeNull();
  const planning = { runId: "run-1", step: "post_kits" as const, startedAt: NOW.toISOString() };
  const asked: string[] = [];
  const v = await readGoals(A, { store, now: NOW, planning: async (id) => { asked.push(id); return planning; } });
  expect(v.planning).toEqual(planning);
  expect(asked).toEqual([A]);                                                       // only the session's athlete
});

test("G11: plan 1.5.0 — once or standing: a recommendation and the goal kept from it say what repeats them; every waiting post shows", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  // An older recommendation (no repeats) reads "once"; a standing one says its trigger, and the goal kept from it too.
  const standing = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "A post before every home race", why: "w", evidence: [{ kind: "fact", factId: s.result.id }],
    detail: { key: "R2", horizon: "now", value: { text: "Reach", low: null, high: null, currency: null, drivers: [] }, valueConfidence: "low", nextDecision: "n", gamePlan: [], repeats: "before_event" } });
  let view = await readGoals(A, { store, now: NOW });
  expect(view.recommended.find((r) => r.decisionId === s.rec.id)!.repeats).toBe("once");
  expect(view.recommended.find((r) => r.decisionId === standing.id)!.repeats).toBe("before_event");
  expect(view.recommended.find((r) => r.decisionId === s.rec.id)!.actions.map((a) => a.title)).toEqual(["Film a clinic"]);
  await keepRecommended(A, standing.id, {}, { store, now: NOW, start: async () => ({ runId: "wf", created: true }) });
  view = await readGoals(A, { store, now: NOW });
  expect(view.goals.find((g) => g.text === "A post before every home race")!.repeats).toBe("before_event");
  expect(view.goals.find((g) => g.id === s.goal.id)!.repeats).toBe("once");

  // Posts are not capped per goal: five waiting posts all show (what was done fills up to three rows).
  for (const n of [1, 2, 3, 4]) {
    await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: `Post ${n}`, why: "w", evidence: [], goalId: s.goal.id, detail: detail({ kind: "post", what: `Post ${n}`, button: "post", dueOn: `2026-10-2${n}` }) });
  }
  view = await readGoals(A, { store, now: NOW });
  expect(view.goals.find((g) => g.id === s.goal.id)!.actions).toHaveLength(7);
});

test("G12: Moments — what the moments step chose and still holds, every kind, next 60 days, soonest first", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const [holiday, league, gone] = await store.insertFacts(A, [
    { subject: { kind: "event", name: "A holiday" }, claim: "A holiday on 20 October.", type: "found", source: { url: "https://example.org/h" }, date: "2026-10-20", confidence: 0.9, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "A league final" }, claim: "A league final on 15 November.", type: "found", source: { url: "https://example.org/l" }, date: "2026-11-15", confidence: 0.9, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "Retired" }, claim: "Retired moment.", type: "found", source: { url: "https://example.org/r" }, date: "2026-10-25", confidence: 0.9, runId: null, topic: "moment" },
  ]);
  const md = (f: { id: string; subject: { name: string }; date: string | null }, category: string, over: Record<string, unknown> = {}) => ({
    kind: "moment", factId: f.id, name: f.subject.name, date: f.date, datePrecision: "day", category, whyNow: `Why ${f.subject.name}`, rank: 1,
    idea: { hook: `Hook ${f.subject.name}`, angle: `Angle ${f.subject.name}` }, scannedAt: NOW.toISOString(), ...over,
  });
  await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Hook", why: "w", evidence: [{ kind: "fact", factId: league.id }], detail: md(league, "league") });
  await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Hook", why: "w", evidence: [{ kind: "fact", factId: holiday.id }], detail: md(holiday, "holiday_awareness") });
  await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Hook", why: "w", evidence: [{ kind: "fact", factId: gone.id }], detail: md(gone, "cultural_trend", { retiredWhy: "cancelled" }) });
  await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Hook", why: "w", evidence: [{ kind: "fact", factId: s.opener.id }], detail: md({ id: s.opener.id, subject: s.opener.subject, date: s.opener.date }, "schedule") });
  await store.insertDecision(A, { runId: null, skillId: "moments", kind: "other", suggested: "Hook", why: "w", evidence: [{ kind: "fact", factId: s.far.id }], detail: md({ id: s.far.id, subject: s.far.subject, date: s.far.date }, "league") });

  const v = await readGoals(A, { store, now: NOW });
  expect(v.moments!.map((m) => [m.name, m.category])).toEqual([
    ["Home opener", "schedule"], ["A holiday", "holiday_awareness"], ["A league final", "league"],
  ]);
  expect(v.moments![1]).toMatchObject({ whyNow: "Why A holiday", angle: "Angle A holiday", hook: "Hook A holiday", actionsReady: 0, kitActionId: null });
  // The opener's waiting post action is counted as for Coming up.
  expect(v.moments![0].actionsReady).toBeGreaterThan(0);
});

test("G13: plan 1.7.0 — a post_brief's caption, tags and shots reach Mila's start prompt (they no longer live in the body)", async () => {
  const store = createMemoryStore();
  const goal = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
  const d = await store.insertDecision(A, {
    runId: null, skillId: "plan", kind: "action", suggested: "Post a countdown", why: "-", evidence: [], goalId: goal.id,
    detail: detail({
      kind: "post", what: "Post a countdown", button: "post",
      deliverable: {
        type: "post_brief", title: "Countdown", body: "Format: carousel.", target: null, platform: "instagram", thread: null, connector: null,
        caption: "Four weeks out.", hashtags: ["#seasonprep"], shots: ["the track", "laces tied"],
      },
    }),
  });
  expect(actionView(d).startPrompt).toBe("Post a countdown\n\nStart from this draft:\nFormat: carousel.\nCaption: Four weeks out.\n\n#seasonprep\nShots: the track; laces tied");
});
