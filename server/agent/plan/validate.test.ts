/**
 * validate.test.ts — the code checks after the plan call (pure; no model, no database).
 *
 *   V1 refs: unknown fact keys are dropped and an item with none is held; removed facts and personal care facts never
 *      support a goal or an action; E-keys count as facts
 *   V2 caps: 3 recommended goals, 3 actions per goal (posts aside), 2 plan lines (≤ 160 chars), goal ≤ 90 chars, title ≤ 60 chars
 *   V3 no repeats: a goal held (active or set aside), one dropped or skipped in the last 90 days, a recommendation
 *      already waiting, or the model's own duplicate flag
 *   V4 goal_ref must be an active goal (G:<id>) or an R-key of this output
 *   V5 reply needs a T-key from the input; connect needs a connector that can be offered now
 *   V6 event_ref must be an E-key; due_on on or before the event's date (month-only: before the month); not in the past
 *   V7 deliverables: never-content and never-use names, care-fact text, avoid-list and conflict targets are held
 *   V8 money only with drivers; confidence "low" without measured data; leaked keys stripped; "AI" / "brain" held
 *   V9 the athlete's own game plan is never rewritten
 *   V10 a goal's domain (plan 1.1.0) is one from the list or null
 *   V11 month- and year-only events: due before the period starts; a conflict blocks what it names, not its holder
 *   V13 plan 1.5.0: posts are never capped per goal, only by the week's number (stories apart); the week is read and
 *       bounded; repeats is one from the list, else once
 *   V12 plan 1.3.0, the idea bank: a post's idea is checked (hook, format, what to show; never-content, care text and
 *      "AI"/"brain" drop it, never the action); an I-key reuses, an X-key adapts (only with an event), each idea once;
 *      a post with no idea and no event is fresh (filed only with its idea); a P-key from the input or nothing; idea
 *      moves skip I-keys and adapt X-keys to an E-key, never an idea an action uses; a bad ref drops the ref, never the
 *      action — except a second post citing an idea another action already uses (1.3.1, one idea one post): held whole;
 *      with the bank off, no post has a source and no move is read
 *   V14 plan 1.7.0: a post_brief keeps its caption, hashtags and shots as fields of their own — a stray label off the
 *      caption, brief lines make it no caption, tags made safe and capped at five, shots capped; they pass the same
 *      never-content and care checks as the body; every other type carries none of the three
 */
jest.mock("../../db", () => ({ db: {} }));

import type { Decision, Goal, MemoryFact } from "../../../shared/agent";
import type { IdeaBankEntry } from "../../../shared/postKit";
import type { BankIdea } from "../ideaBank/bank";
import { blockedBy, lastDueFor, NO_BANK, sameGoal, stripPlanKeys, validatePlan, type PlanCheckContext } from "./validate";

const A = "00000000-0000-4000-8000-0000000000aa";
const fact = (id: string, over: Partial<MemoryFact> = {}): MemoryFact => ({
  id, athleteId: A, subject: { kind: "athlete", name: "Pat Example" }, claim: `Claim ${id}.`, type: "found", source: { url: `https://example.org/${id}` },
  date: null, confidence: 0.9, status: "active", supersededBy: null, runId: null, createdAt: "2026-10-01T00:00:00.000Z", ...over,
});
const goal = (id: string, text: string, over: Partial<Goal> = {}): Goal => ({
  id, athleteId: A, text, source: "said", status: "active", priority: null, gamePlan: null, decisionId: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", horizon: null, gamePlanBy: "mila", ...over,
});
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";

function ctx(over: Partial<PlanCheckContext> = {}): PlanCheckContext {
  const event = fact("ev1", { subject: { kind: "event", name: "Home opener" }, date: "2026-10-18", topic: "upcoming" });
  return {
    today: "2026-10-10",
    facts: new Map([
      ["F1", fact("f1")], ["F2", fact("f2")],
      ["F3", fact("f3", { sensitive: true, careKind: "personal", claim: "Pat Example missed the spring season with a knee injury in March." })],
      ["F4", fact("f4", { sensitive: true, careKind: "conduct", claim: "A league review cleared Pat Example." })],
      ["F5", fact("f5", { status: "removed" })],
    ]),
    events: new Map([
      ["E1", { fact: event, factId: event.id, label: "Home opener", date: "2026-10-18", precision: "day" as const }],
      ["E2", { fact: fact("ev2"), factId: "ev2", label: "Winter showcase", date: "2026-12-01", precision: "month" as const }],
    ]),
    threads: new Map([["T1", { opportunityId: "opp-1", threadId: "th-1", brand: "Brand B", line: "They asked for your rates", since: null }]]),
    goals: [goal(G1, "Land a first paid partnership this season", { gamePlan: "My own plan.", gamePlanBy: "athlete" }), goal(G2, "Grow my audience")],
    decisions: [],
    offerableConnectors: ["instagram", "tiktok"],
    connectorIds: ["instagram", "tiktok", "youtube", "gmail", "outlook"],
    neverTerms: ["Robin"],
    avoid: ["Avoid energy drink brands like Brand Z."],
    // Understand 1.9.0's internal read: Brand A (the current partner) holds the category; it blocks Brand Q.
    conflicts: [{ what: "Brand A holds your apparel category.", blocks: ["Brand Q", "other apparel brands"], factIds: ["f1"] }],
    hasMeasured: false,
    bank: NO_BANK,
    ...over,
  };
}

const deliverable = (over: Record<string, unknown> = {}) => ({ type: "checklist", title: "Steps", body: "Do the thing.", target: null, platform: null, thread_ref: null, connector: null, ...over });
const action = (over: Record<string, unknown> = {}) => ({ goal_ref: `G:${G2}`, kind: "other", what: "Do one thing", why: "It helps.", due_on: null, event_ref: null, button: "start", deliverable: deliverable(), fact_keys: ["F1"], ...over });
const rec = (over: Record<string, unknown> = {}) => ({
  key: "R1", goal: "Get a first local partner before playoffs", horizon: "next", why_now: "Your opener gets press soon.",
  value: { text: "A first deal on record", low: 500, high: 2000, currency: "usd", drivers: ["local reach"] }, value_confidence: "high",
  next_decision: "Pick two shops.", fact_keys: ["F1"], similar_to_goal_id: null, ...over,
});
const plan = (over: Record<string, unknown> = {}) => ({ contract: "plan/1", stage_read: { band: "developing", why: "College." }, recommended_goals: [], game_plans: [], actions: [], goal_notes: [], missing: [], path_note: "p", ...over });
const reasons = (r: ReturnType<typeof validatePlan>) => r.held.map((h) => h.reason);

test("V1: refs — unknown keys dropped, items with none held; removed and personal care facts never support; E-keys count", () => {
  const r = validatePlan(plan({
    recommended_goals: [
      rec({ key: "R1", fact_keys: ["F1", "F99"] }),
      rec({ key: "R2", goal: "Make your story the lead", fact_keys: ["F99", "F5"] }),
      rec({ key: "R3", goal: "Train for the comeback season", fact_keys: ["F3"] }),
    ],
    actions: [action({ fact_keys: ["E1"] }), action({ what: "Lean on the review", fact_keys: ["F4"] })],
  }), ctx());
  expect(r.plan.recommendedGoals.map((g) => [g.key, g.factIds])).toEqual([["R1", ["f1"]]]);
  expect(reasons(r)).toEqual(expect.arrayContaining(["rests on no real fact"]));
  expect(r.held.filter((h) => h.reason === "rests on no real fact")).toHaveLength(2);   // R2 (unknown + removed), R3 (personal care)
  expect(r.plan.actions.map((a) => a.factIds)).toEqual([["ev1"], ["f4"]]);             // a conduct care fact may support (risk, timing)
});

test("V2: caps", () => {
  const r = validatePlan(plan({
    recommended_goals: [rec({ key: "R1" }), rec({ key: "R2", goal: "Grow a newsletter of fans" }), rec({ key: "R3", goal: "Speak at a local school" }), rec({ key: "R4", goal: "Open a camp next summer" }),
      rec({ key: "R1", goal: "x".repeat(91) })],
    game_plans: [{ goal_ref: `G:${G2}`, lines: ["One.", "Two.", "Three."], kept_athlete_text: false }],
    actions: [1, 2, 3, 4].map((n) => action({ what: `Action ${n}` })).concat([action({ what: "y".repeat(61) })]),
  }), ctx());
  expect(r.plan.recommendedGoals).toHaveLength(3);
  expect(r.plan.gamePlans[0].lines).toEqual(["One.", "Two."]);
  expect(r.plan.actions.map((a) => a.what)).toEqual(["Action 1", "Action 2", "Action 3"]);
  expect(reasons(r)).toEqual(expect.arrayContaining(["cap: 3 recommended goals", "cap: 2 lines (kept the first)", "cap: 3 actions per goal (posts aside)"]));
  const long = validatePlan(plan({ recommended_goals: [rec({ goal: "x".repeat(91) })], game_plans: [{ goal_ref: `G:${G2}`, lines: ["z".repeat(200)], kept_athlete_text: false }] }), ctx());
  expect(reasons(long)).toContain("goal over 90 characters");
  expect(long.plan.gamePlans[0].lines[0].length).toBe(160);
  expect(reasons(validatePlan(plan({ actions: [action({ what: "y".repeat(61) })] }), ctx()))).toContain("title over 60 characters");
});

test("V3: no repeats — held goals, dropped or skipped in the last 90 days, waiting elsewhere, or flagged by the model", () => {
  const skipped: Decision = { id: "d1", athleteId: A, runId: null, skillId: "plan", kind: "goal", suggested: "Start a youth clinic series", why: "w", evidence: [], response: "skipped", responseReason: null, respondedAt: "2026-09-20T00:00:00.000Z", outcome: "unknown", outcomeNote: null, outcomeAt: null, approvalId: null, createdAt: "2026-09-19T00:00:00.000Z" };
  const oldSkip: Decision = { ...skipped, id: "d2", suggested: "Write a column for a local paper", respondedAt: "2026-05-01T00:00:00.000Z", createdAt: "2026-05-01T00:00:00.000Z" };
  const waiting: Decision = { ...skipped, id: "d3", skillId: "goals", suggested: "Host a fan meetup", response: "pending", respondedAt: null };
  const dropped = goal("33333333-3333-4333-8333-333333333333", "Launch a podcast", { status: "dropped", updatedAt: "2026-09-30T00:00:00.000Z" });
  const paused = goal("44444444-4444-4444-8444-444444444444", "Get a training sponsor", { status: "paused" });
  const r = validatePlan(plan({ recommended_goals: [
    rec({ key: "R1", goal: "Land my first paid partnership this season" }),        // active goal, reworded
    rec({ key: "R2", goal: "Get a training sponsor" }),                             // set aside
    rec({ key: "R3", goal: "Launch a podcast" }),                                   // dropped 10 days ago
  ] }), ctx({ goals: [...ctx().goals, dropped, paused], decisions: [skipped, oldSkip, waiting] }));
  expect(r.plan.recommendedGoals).toEqual([]);
  expect(reasons(r)).toEqual(expect.arrayContaining(["repeats a goal you hold", "you dropped it in the last 90 days"]));
  const r2 = validatePlan(plan({ recommended_goals: [
    rec({ key: "R1", goal: "Start a youth clinic series" }),                        // skipped 3 weeks ago
    rec({ key: "R2", goal: "Host a fan meetup" }),                                  // a chat suggestion still waiting
    rec({ key: "R3", goal: "Write a column for a local paper" }),                   // skipped long ago: may come back
  ] }), ctx({ decisions: [skipped, oldSkip, waiting] }));
  expect(r2.plan.recommendedGoals.map((g) => g.goal)).toEqual(["Write a column for a local paper"]);
  expect(reasons(r2)).toEqual(expect.arrayContaining(["you skipped it in the last 90 days", "repeats a recommendation already waiting for you"]));
  const flagged = validatePlan(plan({ recommended_goals: [rec({ goal: "Something new entirely", similar_to_goal_id: `G:${G2}` })] }), ctx());
  expect(reasons(flagged)).toEqual(["the model flagged it as a repeat of a goal you have", "none survived the checks"]);
  expect(sameGoal("Grow my audience on [Platform A]", "Grow your audience on [Platform A]")).toBe(true);
  expect(sameGoal("Grow my audience", "Launch a podcast")).toBe(false);
});

test("V4: goal_ref is an active goal or an R-key of this output", () => {
  const r = validatePlan(plan({
    recommended_goals: [rec()],
    game_plans: [{ goal_ref: "R1", lines: ["Pitch two shops."], kept_athlete_text: false }, { goal_ref: "R9", lines: ["x"], kept_athlete_text: false }],
    actions: [action({ goal_ref: "R1" }), action({ goal_ref: "G:not-a-goal" }), action({ goal_ref: "R2" })],
  }), ctx());
  expect(r.plan.gamePlans.map((g) => g.goalRef)).toEqual([{ kind: "recommended", key: "R1" }]);
  expect(r.plan.actions.map((a) => a.goalRef)).toEqual([{ kind: "recommended", key: "R1" }]);
  expect(r.held.filter((h) => /goal_ref/.test(h.reason))).toHaveLength(3);
});

test("V5: reply needs a thread from the input; connect needs a connector that can be offered now", () => {
  const r = validatePlan(plan({ actions: [
    action({ kind: "reply", what: "Reply to Brand B", button: "send", deliverable: deliverable({ type: "reply_draft", thread_ref: "T1", body: "Thanks — here are my rates." }) }),
    action({ kind: "reply", what: "Reply to nobody", deliverable: deliverable({ type: "reply_draft", thread_ref: "T9" }) }),
    action({ kind: "connect", what: "Connect TikTok", button: "connect", deliverable: deliverable({ type: "connect_request", connector: "tiktok" }) }),
  ] }), ctx());
  expect(r.plan.actions.map((a) => [a.what, a.deliverable.thread, a.deliverable.connector])).toEqual([
    ["Reply to Brand B", { opportunityId: "opp-1", threadId: "th-1", label: "Brand B" }, null],
    ["Connect TikTok", null, "tiktok"],
  ]);
  const gmail = validatePlan(plan({ actions: [action({ kind: "connect", what: "Connect Gmail", deliverable: deliverable({ connector: "gmail" }) })] }), ctx());
  expect(reasons(gmail)).toEqual(["connect needs a connector that can be offered now (gmail)"]);
});

test("V6: events and due dates", () => {
  expect(lastDueFor({ factId: "x", label: "x", date: "2026-12-01", precision: "month" })).toBe("2026-11-30");
  const r = validatePlan(plan({ actions: [
    action({ what: "Before the opener", event_ref: "E1", due_on: "2026-10-16" }),
    action({ what: "On the day", event_ref: "E1", due_on: "2026-10-18" }),
    action({ what: "Too late", event_ref: "E1", due_on: "2026-10-19" }),
    action({ what: "Unknown event", event_ref: "E7" }),
    action({ what: "In the past", due_on: "2026-10-01" }),
    action({ what: "Not a date", due_on: "next week" }),
    action({ goal_ref: `G:${G1}`, what: "Month-only event", event_ref: "E2", due_on: "2026-12-01" }),
  ] }), ctx());
  expect(r.plan.actions.map((a) => [a.what, a.dueOn, a.event?.label ?? null])).toEqual([["Before the opener", "2026-10-16", "Home opener"], ["On the day", "2026-10-18", "Home opener"]]);
  expect(reasons(r)).toEqual(expect.arrayContaining([
    "due_on 2026-10-19 falls after the event (2026-10-18)", "event_ref E7 is not a dated event from the input", "due_on is in the past", "due_on is not a date",
    "due_on 2026-12-01 falls after the event (2026-12-01)",
  ]));
});

test("V7: deliverables — never-content, care text, avoid-list and conflict targets", () => {
  const r = validatePlan(plan({ actions: [
    action({ what: "Email with contact", deliverable: deliverable({ body: "Write to me at pat@example-mail.com" }) }),
    action({ what: "Name the child", deliverable: deliverable({ body: "Bring Robin to the shoot." }) }),
    action({ what: "Injury story post", deliverable: deliverable({ body: "missed the spring season with a knee injury — back now" }) }),
    action({ kind: "pitch", what: "Pitch Brand Z", deliverable: deliverable({ type: "pitch", target: { subject_kind: "brand", name: "Brand Z" } }) }),
    action({ kind: "pitch", what: "Pitch Brand Q", deliverable: deliverable({ type: "pitch", target: { subject_kind: "brand", name: "Brand Q" } }) }),
    action({ kind: "pitch", what: "Pitch Brand C", button: "send", deliverable: deliverable({ type: "pitch", target: { subject_kind: "brand", name: "Brand C" }, body: "Hi — I'd love to work with you." }) }),
    // The partner holding the category is not what the conflict blocks: a renewal pitch to it stands.
    action({ goal_ref: `G:${G1}`, kind: "pitch", what: "Renew with Brand A", deliverable: deliverable({ type: "pitch", target: { subject_kind: "brand", name: "Brand A" } }) }),
  ] }), ctx());
  expect(r.plan.actions.map((a) => a.what)).toEqual(["Pitch Brand C", "Renew with Brand A"]);
  expect(reasons(r)).toEqual([
    "the deliverable carries never-content (contact details or a never-use name)",
    "the deliverable carries never-content (contact details or a never-use name)",
    "a care fact appears in the deliverable",
    "the pitch target is on your avoid-list",
    "the pitch target is in an exclusivity or category conflict",
  ]);
});

test("V8: money with drivers only; low confidence without measured data; keys stripped; never \"AI\" or \"brain\"", () => {
  const r = validatePlan(plan({
    recommended_goals: [
      rec({ key: "R1", why_now: "Your opener (F1, E1) gets press.", value: { text: "Worth it [F1]", low: 500, high: 2000, currency: "usd", drivers: [] } }),
      rec({ key: "R2", goal: "Sign a second partner", value: { text: "A range", low: 300, high: 900, currency: "usd", drivers: ["measured reach"] } }),
      rec({ key: "R3", goal: "Let the AI handle your pitches" }),
    ],
    missing: [{ text: "Connect Instagram so your reach is measured", unlocks: "connect", connector: "instagram" }, { text: "x", unlocks: "connect", connector: "myspace" }],
  }), ctx());
  const [r1, r2] = r.plan.recommendedGoals;
  expect(r1).toMatchObject({ whyNow: "Your opener gets press.", value: { text: "Worth it", low: null, high: null, currency: null }, valueConfidence: "low" });
  expect(r2.value).toEqual({ text: "A range", low: 300, high: 900, currency: "USD", drivers: ["measured reach"] });
  expect(r2.valueConfidence).toBe("low");                                     // the model said high; no measured data
  expect(reasons(r)).toContain("copy rule: never \"AI\" or \"brain\"");
  expect(r.plan.missing).toEqual([{ text: "Connect Instagram so your reach is measured", unlocks: "connect", connector: "instagram" }, { text: "x", unlocks: "connect", connector: null }]);
  expect(validatePlan(plan({ recommended_goals: [rec({ value_confidence: "high" })] }), ctx({ hasMeasured: true })).plan.recommendedGoals[0].valueConfidence).toBe("high");
  expect(stripPlanKeys("Lead with F1 and F2 [F1, F2] for G:11111111-1111-4111-8111-111111111111.", new Set(["F1", "F2"]))).toBe("Lead with and for.");
  expect(stripPlanKeys("An F1 fan base", new Set())).toBe("An F1 fan base");   // not a key this input used
});

test("V9: the athlete's own game plan is never rewritten", () => {
  const r = validatePlan(plan({ game_plans: [
    { goal_ref: `G:${G1}`, lines: ["Mila's rewrite."], kept_athlete_text: false },
    { goal_ref: `G:${G2}`, lines: ["Two posts a week."], kept_athlete_text: false },
  ] }), ctx());
  expect(r.plan.gamePlans).toEqual([
    { goalRef: { kind: "goal", goalId: G1 }, domain: null, lines: ["My own plan."], keptAthleteText: true },
    { goalRef: { kind: "goal", goalId: G2 }, domain: null, lines: ["Two posts a week."], keptAthleteText: false },
  ]);
});

test("V10: a goal's domain is one from the list or null, never guessed (recommended goals and game plans)", () => {
  const r = validatePlan(plan({
    recommended_goals: [rec({ key: "R1", domain: "commercial" }), rec({ key: "R2", goal: "Post twice a week through the season", domain: "performance" })],
    game_plans: [
      { goal_ref: `G:${G2}`, domain: "audience", lines: ["Two posts a week."], kept_athlete_text: false },
      { goal_ref: "R1", domain: "owned_venture", lines: ["Start with one shop."], kept_athlete_text: false },
      { goal_ref: "R2", domain: "", lines: ["Plan the posts."], kept_athlete_text: false },
    ],
  }), ctx());
  expect(r.plan.recommendedGoals.map((g) => [g.key, g.domain])).toEqual([["R1", "commercial"], ["R2", null]]);
  expect(r.plan.gamePlans.map((p) => p.domain)).toEqual(["audience", "owned_venture", null]);
});

test("V11: due dates against a month- or year-only event fall before the period starts", () => {
  expect(lastDueFor({ factId: "x", label: "x", date: "2026-12-01", precision: "month" })).toBe("2026-11-30");
  expect(lastDueFor({ factId: "x", label: "x", date: "2027-01-01", precision: "year" })).toBe("2026-12-31");
  expect(lastDueFor({ factId: "x", label: "x", date: "2026-12-05", precision: "day" })).toBe("2026-12-05");
  // A month that has already started by today: no "before" is left, so the action may be due through the month's end.
  expect(lastDueFor({ factId: "x", label: "x", date: "2026-10-01", precision: "month" }, "2026-10-15")).toBe("2026-10-31");
  expect(lastDueFor({ factId: "x", label: "x", date: "2026-12-01", precision: "month" }, "2026-10-15")).toBe("2026-11-30");
  expect(lastDueFor({ factId: "x", label: "x", date: "2026-10-18", precision: "day" }, "2026-10-15")).toBe("2026-10-18");
  expect(blockedBy("brand q", [{ what: "w", blocks: ["Brand Q"], factIds: ["f"] }])).not.toBeNull();
  expect(blockedBy("Brand A", [{ what: "Brand A holds it", blocks: ["Brand Q"], factIds: ["f"] }])).toBeNull();
});

test("V12: the idea bank — post ideas, refs and moves checked; a bad ref never holds the action", () => {
  const idea = (id: string, over: Partial<IdeaBankEntry> = {}, more: Partial<BankIdea> = {}): BankIdea => ({
    decisionId: id, skillId: "post-kit/ideas", eventFactId: null, momentPending: null, momentName: null, momentCategory: null, momentRetiredWhy: null, assets: 1, createdAt: "2026-10-01T00:00:00.000Z",
    entry: {
      kind: "idea", timeBound: false, pillarKey: null, pillarName: null, momentDecisionId: null, expiresOn: null,
      idea: { hook: "h", format: "feed", platform: "instagram", timing: "t" }, brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m",
      status: "new", usedInDecisionId: null, adaptedFromIdeaId: null, ...over,
    },
    ...more,
  });
  const bank = {
    on: true,
    ideas: new Map([["I1", idea("idea-1", { pillarKey: "P1", pillarName: "Race days" })], ["I2", idea("idea-2")]]),
    missed: new Map([["X1", idea("idea-x", { timeBound: true, expiresOn: "2026-10-05" }, { momentPending: false })]]),
    pillars: new Map([["P1", { key: "P1", name: "Race days" }], ["P2", { key: "P2", name: "Training" }]]),
    momentByFact: new Map([["ev1", "moment-1"]]),
  };
  const post = (over: Record<string, unknown> = {}) => ({ hook: "A hook.", format: "reel", show: "The start.", caption_angle: "Home.", avoid: "Nothing forced.", media_needs: "a clip", ...over });
  const postAction = (what: string, over: Record<string, unknown> = {}) => action({ kind: "post", button: "post", what, deliverable: deliverable({ type: "post_brief" }), post: post(), idea_ref: null, pillar_ref: null, ...over });
  const r = validatePlan(plan({
    actions: [
      postAction("Reuse the photo", { idea_ref: "I1", pillar_ref: "P2" }),                    // the idea's own pillar wins
      postAction("Reuse the photo again", { idea_ref: "I1" }),                               // already used: a second post, held whole
      postAction("Adapt the gala idea", { idea_ref: "X1", event_ref: "E1", due_on: "2026-10-15" }),
      { ...postAction("Fresh, training", { pillar_ref: "P2" }), goal_ref: `G:${G1}` },
      { ...postAction("Fresh, no idea", { post: null }), goal_ref: `G:${G1}` },
      { ...postAction("Bad idea words", { idea_ref: "I9", post: post({ show: "Call me at robin@example.com" }) }), goal_ref: `G:${G1}` },
    ],
    idea_moves: [
      { idea_ref: "I2", move: "skip", event_ref: null, timing: null, why: "Not worth it." },
      { idea_ref: "I1", move: "skip", event_ref: null, timing: null, why: "x" },     // used by an action
      { idea_ref: "X1", move: "adapt", event_ref: "E1", timing: "t", why: "x" },     // used by an action
      { idea_ref: "I2", move: "adapt", event_ref: "E1", timing: "t", why: "x" },     // adapt needs an X-key
      { idea_ref: "X1", move: "keep", event_ref: null, timing: null, why: "x" },
    ],
  }), ctx({ bank }));
  const by = new Map(r.plan.actions.map((a) => [a.what, a]));
  expect(by.get("Reuse the photo")!.source).toEqual({ from: "bank", ideaId: "idea-1", pillar: { key: "P1", name: "Race days" }, momentDecisionId: null });
  expect(by.get("Reuse the photo")!.post).toEqual({ hook: "A hook.", format: "reel", show: "The start.", captionAngle: "Home.", avoid: "Nothing forced.", mediaNeeds: "a clip" });
  // One idea, one post (1.3.1): the second action citing I1 is not kept as a fresh post — it is held.
  expect(by.has("Reuse the photo again")).toBe(false);
  expect(r.held).toContainEqual({ what: "Reuse the photo again", reason: "a second post for idea I1: another action in this plan already uses it" });
  expect(by.get("Adapt the gala idea")!.source).toEqual({ from: "adapted", ideaId: "idea-x", pillar: null, momentDecisionId: "moment-1" });
  expect(by.get("Fresh, training")!.source).toEqual({ from: "fresh", ideaId: null, pillar: { key: "P2", name: "Training" }, momentDecisionId: null });
  expect(by.get("Fresh, no idea")!.source).toBeNull();
  // Never-content in the idea drops the idea (and the unknown ref), never the action.
  expect(by.get("Bad idea words")).toMatchObject({ post: null, source: null });
  expect(r.plan.ideaMoves).toEqual([{ move: "skip", ideaId: "idea-2", event: null, momentDecisionId: null, timing: null, why: "Not worth it." }]);
  expect(reasons(r)).toEqual([
    "a second post for idea I1: another action in this plan already uses it",
    "a fresh evergreen post needs its idea (post) to go in the idea bank (not filed)",
    "the post's idea carries never-content, a care fact or \"AI\"/\"brain\" (dropped; the action kept)",
    "idea_ref I9 is not an idea from the input (dropped)",
    "a fresh evergreen post needs its idea (post) to go in the idea bank (not filed)",
    "an action this plan wrote uses it", "an action this plan wrote uses it", "adapt needs an X-key from the missed ideas", "move is neither skip nor adapt",
  ]);

  // An X-key with no event to time it to is dropped; an adapt move resolves its event and moment.
  const x = validatePlan(plan({
    actions: [postAction("Adapt, no event", { idea_ref: "X1" })],
    idea_moves: [{ idea_ref: "X1", move: "adapt", event_ref: "E1", timing: "a week before", why: "Fits." }],
  }), ctx({ bank }));
  expect(x.plan.actions[0].source).toEqual({ from: "fresh", ideaId: null, pillar: null, momentDecisionId: null });
  expect(reasons(x)).toContain("adapting X1 needs the later event it is for (dropped)");
  expect(x.plan.ideaMoves).toEqual([{ move: "adapt", ideaId: "idea-x", event: { factId: "ev1", label: "Home opener", date: "2026-10-18", precision: "day" }, momentDecisionId: "moment-1", timing: "a week before", why: "Fits." }]);

  // The bank off: no source, no moves, whatever the model said; the post's idea is still kept on the action.
  const off = validatePlan(plan({ actions: [postAction("Reuse the photo", { idea_ref: "I1" })], idea_moves: [{ idea_ref: "I2", move: "skip", event_ref: null, timing: null, why: "x" }] }), ctx());
  expect(off.plan.actions[0]).toMatchObject({ source: null, post: { hook: "A hook." } });
  expect(off.plan.ideaMoves).toEqual([]);
  expect(off.held).toEqual([]);
  // A post timed to a moment with no idea named takes that moment's own bank entry (once); without one, no source.
  const own = { ...bank, ideas: new Map([["I1", idea("own-opener", { timeBound: true, momentDecisionId: "moment-1" }, { skillId: "moments", eventFactId: "ev1", momentPending: true })]]) };
  const timed = validatePlan(plan({ actions: [
    postAction("Opener post", { event_ref: "E1", due_on: "2026-10-15" }),
    postAction("Second opener post", { event_ref: "E1", due_on: "2026-10-16" }),
    postAction("Showcase post", { event_ref: "E2", due_on: "2026-10-20" }),
  ] }), ctx({ bank: own }));
  expect(timed.plan.actions.map((a) => a.source)).toEqual([{ from: "bank", ideaId: "own-opener", pillar: null, momentDecisionId: null }, null, null]);
  // A timely bank idea belongs to its own event: on another event's post, or a post with no event, the ref is dropped.
  const timelyBank = { ...bank, ideas: new Map([["I1", idea("derby-clip", { timeBound: true }, { eventFactId: "ev1", momentPending: true })]]) };
  const offEvent = validatePlan(plan({ actions: [
    postAction("Showcase post", { idea_ref: "I1", event_ref: "E2", due_on: "2026-10-20" }),
    postAction("Undated post", { idea_ref: "I1" }),
    postAction("Opener post", { idea_ref: "I1", event_ref: "E1", due_on: "2026-10-15" }),
  ] }), ctx({ bank: timelyBank }));
  expect(offEvent.plan.actions.map((a) => a.source?.from ?? null)).toEqual([null, "fresh", "bank"]);
  expect(offEvent.plan.actions[2].source!.ideaId).toBe("derby-clip");
  expect(reasons(offEvent).filter((r) => /another event/.test(r))).toEqual(["idea_ref I1 is a timely idea for another event (dropped)", "idea_ref I1 is a timely idea for another event (dropped)"]);

  // Adapting copies the missed idea's words: the same checks as a post's — for a move and for an action without its own idea.
  const dirty = { ...bank, missed: new Map([["X1", idea("dirty-x", { timeBound: true, expiresOn: "2026-10-05", brief: { show: "Call robin@example.com", captionAngle: "c", avoid: "a" } }, { momentPending: false })]]) };
  const adapt = validatePlan(plan({
    actions: [postAction("Adapt it", { idea_ref: "X1", event_ref: "E1", due_on: "2026-10-15", post: null })],
    idea_moves: [{ idea_ref: "X1", move: "adapt", event_ref: "E1", timing: "t", why: "x" }],
  }), ctx({ bank: dirty }));
  expect(adapt.plan.actions[0].source).toBeNull();
  expect(adapt.plan.ideaMoves).toEqual([]);
  expect(reasons(adapt)).toEqual(expect.arrayContaining(["adapting X1 would copy never-content, a care fact or \"AI\"/\"brain\" (dropped)", "adapting would copy never-content, a care fact or \"AI\"/\"brain\""]));
  // With its own clean idea, the action may still adapt it (the dirty words are not copied).
  expect(validatePlan(plan({ actions: [postAction("Adapt it", { idea_ref: "X1", event_ref: "E1", due_on: "2026-10-15" })] }), ctx({ bank: dirty })).plan.actions[0].source).toMatchObject({ from: "adapted", ideaId: "dirty-x" });

  // One idea, one post holds for a missed idea too, and for a moment's own entry a first post took without naming it.
  const twice = validatePlan(plan({ actions: [
    postAction("Adapt for the opener", { idea_ref: "X1", event_ref: "E1", due_on: "2026-10-15" }),
    postAction("Adapt it again", { idea_ref: "X1", event_ref: "E1", due_on: "2026-10-16" }),
  ] }), ctx({ bank }));
  expect(twice.plan.actions.map((a) => a.what)).toEqual(["Adapt for the opener"]);
  expect(reasons(twice)).toEqual(["a second post for idea X1: another action in this plan already uses it"]);
  const ownTwice = validatePlan(plan({ actions: [
    postAction("Opener post", { event_ref: "E1", due_on: "2026-10-15" }),
    postAction("Opener post, by its key", { idea_ref: "I1", event_ref: "E1", due_on: "2026-10-16" }),
  ] }), ctx({ bank: own }));
  expect(ownTwice.plan.actions.map((a) => a.what)).toEqual(["Opener post"]);

  // With the bank off, a bad post idea is dropped quietly.
  const quiet = validatePlan(plan({ actions: [postAction("Bad idea", { post: post({ show: "Call robin@example.com" }) }), postAction("No format", { post: post({ format: "billboard" }) })] }), ctx());
  expect(quiet.plan.actions.map((a) => a.post)).toEqual([null, null]);
  expect(quiet.held).toEqual([]);
  // Keys never reach the athlete's words: I-, X- and P-keys are stripped like the rest.
  expect(validatePlan(plan({ actions: [postAction("Post it", { why: "Reuse the idea (I1, P2)." })] }), ctx({ bank })).plan.actions[0].why).toBe("Reuse the idea.");
});

test("V13: plan 1.5.0 — posts are never capped per goal, only by the week's number (stories apart); repeats is from the list", () => {
  const post = (n: number, format = "reel") => action({
    kind: "post", what: `Post ${n}`, button: "post", deliverable: deliverable({ type: "post_brief", platform: "instagram" }),
    post: { hook: `Hook ${n}.`, format, show: "The warm-up.", caption_angle: "The work.", avoid: "", media_needs: "a clip" },
  });
  // Five posts and three other actions on one goal; the week says four posts and one story.
  const r = validatePlan(plan({
    actions: [post(1), post(2), post(3), post(4), post(5), post(6, "story"), post(7, "story"),
      action({ what: "Task 1" }), action({ what: "Task 2" }), action({ what: "Task 3" }), action({ what: "Task 4" })],
    week: { posts: 4, target: 5, stories: 1, why: "Building from two a week toward five." },
  }), ctx());
  expect(r.plan.actions.map((a) => a.what)).toEqual(["Post 1", "Post 2", "Post 3", "Post 4", "Post 6", "Task 1", "Task 2", "Task 3"]);
  expect(reasons(r)).toEqual(expect.arrayContaining(["the week's posts are full (4)", "the week's stories are full (1)", "cap: 3 actions per goal (posts aside)"]));
  expect(r.plan.week).toEqual({ posts: 4, target: 5, stories: 1, why: "Building from two a week toward five." });

  // No week from the model: the sane ceiling (21) holds, and the week is null.
  const none = validatePlan(plan({ actions: [1, 2, 3, 4, 5].map((n) => post(n)) }), ctx());
  expect(none.plan.actions).toHaveLength(5);
  expect(none.plan.week).toBeNull();
  // A bad week: numbers rounded and bounded; no posts number → no week.
  expect(validatePlan(plan({ week: { posts: 3.6, target: 40, stories: -1, why: "w" } }), ctx()).plan.week).toEqual({ posts: 4, target: 21, stories: 0, why: "w" });
  expect(validatePlan(plan({ week: { posts: "four", target: 5, stories: 0, why: "w" } }), ctx()).plan.week).toBeNull();

  // repeats: one of the list, else once.
  const reps = validatePlan(plan({ recommended_goals: [rec({ key: "R1", repeats: "before_event" }), rec({ key: "R2", goal: "Grow a newsletter of fans", repeats: "every_tuesday" }), rec({ key: "R3", goal: "Speak at a local school" })] }), ctx());
  expect(reps.plan.recommendedGoals.map((g) => g.repeats)).toEqual(["before_event", "once", "once"]);
});

test("V14: plan 1.7.0 — a post_brief carries its caption, hashtags and shots; they are checked like the body", () => {
  const post = (d: Record<string, unknown>, what = "Post one") => action({
    kind: "post", what, button: "post", deliverable: deliverable({ type: "post_brief", platform: "instagram", body: "Format: reel. Warm-up, then the finish.", ...d }),
    post: { hook: "The work.", format: "reel", show: "The warm-up.", caption_angle: "The work.", avoid: "", media_needs: "a clip" },
  });
  const r = validatePlan(plan({ actions: [
    post({ caption: "Caption: Four weeks out. Every lap counts.", hashtags: ["#Training", "training", "game day", "#ok!", 7, "#a", "#b", "#c", "#d"], shots: [" warm-up ", "", "the finish"] }),
    post({ caption: "Format: carousel. Slide 1: the track. Slide 2: the finish.", hashtags: [], shots: [] }, "Post two"),
    post({ caption: "Call 555-123-4567 for more.", hashtags: [], shots: [] }, "Post three"),
    post({ caption: "Back soon.", hashtags: [], shots: ["Pat Example missed the spring season with a knee injury"] }, "Post four"),
    action({ what: "Steps", deliverable: deliverable({ caption: "ignored", hashtags: ["#x"], shots: ["y"] }) }),
  ] }), ctx());
  const [one, two, steps] = r.plan.actions;
  // The label comes off; the tags are "#" + word, unique, five at most; empty shots are dropped.
  expect(one.deliverable).toMatchObject({
    body: "Format: reel. Warm-up, then the finish.", caption: "Four weeks out. Every lap counts.",
    hashtags: ["#Training", "#gameday", "#a", "#b", "#c"], shots: ["warm-up", "the finish"],
  });
  // A "caption" that is really a production brief is no caption at all: "" — never the brief.
  expect(two.deliverable.caption).toBe("");
  // Never-content and care text in the new fields hold the action, as they would in the body.
  expect(r.plan.actions.map((a) => a.what)).toEqual(["Post one", "Post two", "Steps"]);
  expect(reasons(r)).toEqual(expect.arrayContaining(["the deliverable carries never-content (contact details or a never-use name)", "a care fact appears in the deliverable"]));
  // Every other type stays the shape it was.
  expect(steps.deliverable).not.toHaveProperty("caption");
  expect(steps.deliverable).not.toHaveProperty("hashtags");
  expect(steps.deliverable).not.toHaveProperty("shots");
  // Never cut mid-caption: brief-sounding words inside the caption stay; tags the model left in it move to hashtags
  // (after its own list, unique, five at most); an inline tag keeps its word.
  const kept = validatePlan(plan({ actions: [
    post({ caption: "Four weeks out. Note: the work starts now. Music: loud. #Ready", hashtags: ["#seasonprep", "#ready"], shots: [] }),
    post({ caption: "Big #GameDay energy. #a #b #c #d #e", hashtags: ["#x"], shots: [] }, "Post two"),
  ] }), ctx());
  expect(kept.plan.actions[0].deliverable).toMatchObject({ caption: "Four weeks out. Note: the work starts now. Music: loud.", hashtags: ["#seasonprep", "#ready"] });
  expect(kept.plan.actions[1].deliverable).toMatchObject({ caption: "Big GameDay energy.", hashtags: ["#x", "#GameDay", "#a", "#b", "#c"] });

  // An answer without the caption key (an older model output) still validates and writes none of the three: the kit reads its body.
  const old = validatePlan(plan({ actions: [action({ kind: "post", button: "post", what: "Old", deliverable: deliverable({ type: "post_brief", body: "Caption: Hi.\nShots: one." }) })] }), ctx());
  expect(old.plan.actions[0].deliverable).toMatchObject({ body: "Caption: Hi.\nShots: one." });
  expect(old.plan.actions[0].deliverable).not.toHaveProperty("caption");
  // A post's deliverable is always a post_brief, whatever type the model named — so its three fields are always written.
  const typed = validatePlan(plan({ actions: [post({ type: "checklist", caption: "Four weeks out.", hashtags: ["#ready"], shots: [] })] }), ctx());
  expect(typed.plan.actions[0].deliverable).toMatchObject({ type: "post_brief", caption: "Four weeks out.", hashtags: ["#ready"] });
  // A null caption (Structured Outputs' "none") is a 1.7.0 answer: the key is written, "".
  expect(validatePlan(plan({ actions: [post({ caption: null, hashtags: [], shots: [] })] }), ctx()).plan.actions[0].deliverable.caption).toBe("");
});
