/**
 * planMix.test.ts — plan 1.3.0, the idea bank and the plan mix (design "Moments → post kits" v2 §6–§7, build step 8),
 * end to end on the in-memory store with the model faked (no provider is reached).
 *
 *   (B1, the idea bank off, went with AGENT_IDEA_BANK on 2 Nov 2026: the bank is always on.)
 *   B2 the input: CONTENT PILLARS (P-keys, why, when each last had a post, its facts' keys); a moment's own bank
 *      entry rides on its MOMENTS line as an I-key; IDEA BANK (timely under its E-key, evergreen under its pillar, where
 *      it came from), never a used or skipped idea; MISSED IDEAS (X-keys); PLAYBOOK (default posts a week, formats,
 *      length, hooks, or "no playbook yet") — the athlete's own frequency words stay in PREFERENCES, verbatim
 *   B3 on, the write: a reused bank idea and a moment's entry are marked used by their action; a fresh evergreen post is
 *      filed as a new used idea under its pillar; a missed idea used for a later event is adapted (old adapted, new row
 *      used, bound to that event's moment); an idea move skips an I-key and adapts an X-key to a later event; each action
 *      names its bank row and pillar; a moment whose entry was used is not offered again
 *   B4 the digest: what the plan itself filed in the bank does not change the next plan's input — same week, no other
 *      change → reused, no call; nor does a skip two runs back (run 1 skips, run 2 replans on a real change, run 3 on
 *      nothing new is reused: every skip a plan run made is undone, read off the row's skippedByRunId — however old,
 *      B4e past the 7-day reuse window; B4d a care moment's skip is not the plan's and stays)
 *   B5 an action a later plan does not repeat expires and hands its idea back (used → new): the idea is offered again
 *   B6 the pillar rotation: a post action's pillar is the "last post" date the next plan reads
 *   B7 a reworded re-plan: an idea held by one of the plan's own pending actions is offered again, and the action that
 *      rewords it takes it from the one this run expires (never handed back, never lost)
 *   B8 a retry after a partial apply: the answer's refs resolve against the keys the run was shown (kept on the run),
 *      nothing is filed twice, and what the crash left half-done (a claimed idea with no adapted row) is finished
 *   B9 plan 1.5.0, the week's inputs: PLAYBOOK carries the target, the format mix and the stories range; POSTING PACE
 *      reads the athlete's measured posts a week (30 and 90 days) and their format split; RATES reads the stored
 *      suggested ranges (else the Brief's); POST KIT LIMITS states what a kit builds; a goal kept from a standing
 *      recommendation shows what it repeats on
 *   B10 plan 1.6.0, WHAT WORKS FOR THIS ATHLETE: only lines resting on 3 or more of the athlete's own posts, each marked
 *      "leads" (8 or more) or "early sign"; "(none)" without the source, with the loop off or on a failed read; the
 *      digest reads each line's mark and direction only, so a ratio drifting inside its band does not re-plan
 */
jest.mock("../../db", () => ({ db: {} }));

import type { Decision } from "../../../shared/agent";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { IdeaBankEntry } from "../../../shared/postKit";
import { fakeResponses } from "../../testUtils/agentModel";
import { setResponsesTransport } from "../research/llm";
import { createMemoryStore, type AgentStore } from "../research/store";
import { rewindForDigest } from "../ideaBank/bank";
import type { WhatWorks, WhatWorksLine } from "../learning/core";
import { buildPlanInput, type PlanSources } from "./input";
import { runPlan, type PlanRunOutput } from "./run";

const A = "00000000-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-10T09:00:00.000Z");
afterEach(() => { setResponsesTransport(null); });

let playbookReads = 0;
const sources = (): PlanSources => ({
  mia: async () => null,
  connected: async () => [{ id: "instagram", lastReadAt: "2026-10-09T00:00:00.000Z" }],
  openThreads: async () => [],
  preferences: async () => [
    { id: "p1", athleteId: A, kind: "style", statement: "I only want to post twice a week.", source: "said", status: "active", runId: null, createdAt: "2026-10-01T00:00:00.000Z" },
  ],
  playbook: async () => {
    playbookReads++;
    return [
      {
        platform: "instagram", version: "v1", activatedAt: "2026-10-01T00:00:00.000Z",
        config: {
          formats: [{ name: "a short vertical video", postFormat: "reel", whenToUse: "action and behind the scenes" }],
          hooks: ["Open on the moment of effort."], idealLengthSec: { min: 7, max: 20 }, cadence: { postsPerWeek: { min: 3, max: 4 } },
          crossPlatformReuse: [], sources: [{ url: "https://example.org/guide", title: "Guide" }], refreshedAt: "2026-10-01",
        },
        cadence: { postsPerWeek: { min: 3, max: 4 }, preferenceStatements: ["I only want to post twice a week."] },
      },
      { platform: "tiktok", version: null, activatedAt: null, config: null, cadence: { postsPerWeek: null, preferenceStatements: [] } },
    ];
  },
});

const entry = (over: Partial<IdeaBankEntry>): IdeaBankEntry => ({
  kind: "idea", timeBound: false, pillarKey: null, pillarName: null, momentDecisionId: null, expiresOn: null,
  idea: { hook: "A hook.", format: "reel", platform: "instagram", timing: "this week" },
  brief: { show: "The work.", captionAngle: "Effort.", avoid: "Anything staged." }, mediaNeeds: "an action clip",
  status: "new", usedInDecisionId: null, adaptedFromIdeaId: null, ...over,
});

async function seed(store: AgentStore) {
  const [, result, opener, derby, gala] = await store.insertFacts(A, [
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "The athlete's name is Pat Example.", type: "said", source: { ref: "onboarding/wf#name" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example won the conference final in 2026.", type: "found", source: { url: "https://example.org/final" }, date: "2026-05-01", confidence: 0.9, runId: null, topic: "achievement" },
    { subject: { kind: "event", name: "Home opener" }, claim: "The home opener is on 18 October 2026.", type: "found", source: { url: "https://example.org/opener" }, date: "2026-10-18", confidence: 0.9, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "City derby" }, claim: "The city derby is on 25 October 2026.", type: "found", source: { url: "https://example.org/derby" }, date: "2026-10-25", confidence: 0.9, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "Autumn gala" }, claim: "The autumn gala is on 30 October 2026.", type: "found", source: { url: "https://example.org/gala" }, date: "2026-10-30", confidence: 0.9, runId: null, topic: "moment" },
  ]);
  await store.writeBrief(A, {
    summary: "A conference champion.", runId: null, factIds: [result.id], internal: { currentSponsors: [], pastSponsors: [] },
    sections: [{ key: "brand_now_next", title: "Brand", text: "", factIds: [result.id], lines: [{ text: "Champion in 2026.", kind: "fact", factIds: [result.id] }] }],
    display: {
      stage: { label: "College athlete", band: "developing", confidence: 0.8, why: "w", factIds: [] },
      positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] },
      contentPillars: [
        { key: "P1", name: "Training and the work", whyThisAthlete: "The title came from the work.", factIds: [result.id] },
        { key: "P2", name: "Race days", whyThisAthlete: "A champion on the day.", factIds: [result.id] },
      ],
    },
  });
  const mine = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null, horizon: "now" });
  const theirs = await store.insertGoal(A, { text: "Land a first paid partnership", source: "said", decisionId: null });

  const moment = (factId: string, name: string, date: string, rank: number, hook: string) => store.insertDecision(A, {
    runId: null, skillId: "moments", kind: "other", suggested: hook, why: `${name} is close.`, evidence: [{ kind: "fact", factId }],
    detail: {
      kind: "moment", factId, name, date, datePrecision: "day", category: "schedule", whyNow: `${name} is close.`, rank,
      idea: { hook, format: "reel", platform: "instagram", timing: "two days before" },
      brief: { show: "Warm-up to the whistle.", captionAngle: "Home.", avoid: "Anything forced." }, mediaNeeds: "an action shot", scannedAt: "2026-10-09T13:00:00.000Z",
    },
  });
  const m = { opener: await moment(opener.id, "Home opener", "2026-10-18", 1, "OPENER-HOOK"), derby: await moment(derby.id, "City derby", "2026-10-25", 2, "DERBY-HOOK"), gala: await moment(gala.id, "Autumn gala", "2026-10-30", 3, "GALA-HOOK") };
  // The gala was judged not worth a post: its candidate expired, its idea is missed (adaptable).
  await store.respondDecision(A, m.gala.id, "expired", "the moments scan: not_worth_a_post");

  const file = (skillId: string, e: IdeaBankEntry, evidence: Decision["evidence"]) => store.insertDecision(A, { runId: null, skillId, kind: "other", suggested: e.idea.hook, why: "w", evidence, detail: e as unknown as Record<string, unknown> });
  const assets = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "record" as const, table: "media_assets", id: `asset-${i}` }));
  const ideas = {
    opener: await file("moments", entry({ timeBound: true, momentDecisionId: m.opener.id, expiresOn: "2026-10-18", idea: { hook: "OPENER-HOOK", format: "reel", platform: "instagram", timing: "two days before" } }), [{ kind: "fact", factId: opener.id }]),
    derby: await file("moments", entry({ timeBound: true, momentDecisionId: m.derby.id, expiresOn: "2026-10-25", idea: { hook: "DERBY-HOOK", format: "reel", platform: "instagram", timing: "two days before" } }), [{ kind: "fact", factId: derby.id }]),
    gala: await file("moments", entry({ timeBound: true, momentDecisionId: m.gala.id, expiresOn: "2026-10-30", idea: { hook: "GALA-HOOK", format: "carousel", platform: "instagram", timing: "the week before" } }), [{ kind: "fact", factId: gala.id }]),
    racePhoto: await file("post-kit/ideas", entry({ pillarKey: "P2", pillarName: "Race days", idea: { hook: "RACE-PHOTO-HOOK", format: "feed", platform: "instagram", timing: "this week" } }), assets(1)),
    derbyClip: await file("post-kit/ideas", entry({ timeBound: true, momentDecisionId: m.derby.id, expiresOn: "2026-10-25", idea: { hook: "DERBY-CLIP-HOOK", format: "reel", platform: "instagram", timing: "the day before" } }), assets(2)),
    skipped: await file("post-kit/ideas", entry({ status: "skipped", idea: { hook: "SKIPPED-HOOK", format: "feed", platform: "instagram", timing: "-" } }), assets(1)),
    used: await file("post-kit/ideas", entry({ status: "used", usedInDecisionId: "someone", idea: { hook: "USED-HOOK", format: "feed", platform: "instagram", timing: "-" } }), assets(1)),
  };
  return { result, opener, derby, gala, mine, theirs, m, ideas };
}

/** The first key on a line that starts with `prefix` and contains `text`. */
const lineKey = (input: string, prefix: string, text: string) => input.split("\n").find((l) => l.startsWith(prefix) && l.includes(text))?.split(" | ")[0] ?? `${prefix}0`;
const block = (input: string, from: string, to: string) => { const i = input.indexOf(from); return input.slice(i, input.indexOf(to, i + from.length)); };
const post = (hook: string, format = "reel") => ({ hook, format, show: "The work, then the result.", caption_angle: "Effort pays.", avoid: "Anything staged.", media_needs: "an action clip" });
const deliverable = (title: string) => ({ type: "post_brief", title, body: `Caption: ${title}.\nShots: the work.`, target: null, platform: "instagram", thread_ref: null, connector: null });

/** The plan the fake model writes: refs resolved from the input it was given. */
function mixJson(input: string, s: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}) {
  const f = lineKey(input, "F", "won the conference final");
  const openerIdea = /^E\d+ \| Home opener \|.*\| idea (I\d+)$/m.exec(input)?.[1] ?? null;
  const e1 = lineKey(input, "E", "Home opener");
  const e2 = lineKey(input, "E", "City derby");
  return {
    contract: "plan/1", stage_read: { band: "developing", why: "w" }, recommended_goals: [], game_plans: [], goal_notes: [], missing: [],
    actions: [
      { goal_ref: `G:${s.mine.id}`, kind: "post", what: "Opener reel", why: "Your opener is close.", due_on: "2026-10-16", event_ref: e1, button: "post", deliverable: deliverable("Opener reel"), fact_keys: [e1], post: post("Back home."), idea_ref: openerIdea, pillar_ref: null },
      { goal_ref: `G:${s.mine.id}`, kind: "post", what: "Race-day photo", why: "Your best race photo.", due_on: "2026-10-13", event_ref: null, button: "post", deliverable: deliverable("Race-day photo"), fact_keys: [f], post: post("RACE-PHOTO-HOOK", "feed"), idea_ref: lineKey(input, "I", "RACE-PHOTO-HOOK"), pillar_ref: null },
      { goal_ref: `G:${s.mine.id}`, kind: "post", what: "A training day", why: "The work behind the title.", due_on: "2026-10-14", event_ref: null, button: "post", deliverable: deliverable("A training day"), fact_keys: [f], post: post("FRESH-HOOK"), idea_ref: null, pillar_ref: lineKey(input, "P", "Training and the work") },
      { goal_ref: `G:${s.theirs.id}`, kind: "post", what: "Derby carousel", why: "The gala idea fits the derby.", due_on: "2026-10-23", event_ref: e2, button: "post", deliverable: deliverable("Derby carousel"), fact_keys: [e2], post: post("GALA-FOR-DERBY", "carousel"), idea_ref: lineKey(input, "X", "GALA-HOOK"), pillar_ref: null },
    ],
    idea_moves: [],
    path_note: "mixed the week",
    ...over,
  };
}

const detailOf = async (store: AgentStore, id: string) => (await store.getDecision(A, id))!.detail as unknown as IdeaBankEntry;

test("B2–B3: idea bank on — the input carries pillars, the bank, missed ideas and the playbook; the plan files back", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  playbookReads = 0;
  const t = fakeResponses((body) => {
    const input = String(body.input);
    return { json: mixJson(input, s, { idea_moves: [
      { idea_ref: lineKey(input, "I", "DERBY-CLIP-HOOK"), move: "skip", event_ref: null, timing: null, why: "The derby already has a post." },
    ] }) };
  });
  setResponsesTransport(t);
  const out = await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b2:plan", now: NOW });
  expect(out).toMatchObject({ status: "planned", actions: 4 });
  expect(playbookReads).toBe(1);

  // B2: the input.
  const input = String(t.calls[0].input);
  const fKey = lineKey(input, "F", "won the conference final");
  const pillars = block(input, "CONTENT PILLARS", "IDEA BANK");
  expect(pillars).toContain(`P1 | Training and the work | why: The title came from the work. | last post: none in the last 30 days [${fKey}]`);
  expect(pillars).toContain(`P2 | Race days | why: A champion on the day. | last post: none in the last 30 days [${fKey}]`);
  const moments = block(input, "MOMENTS (candidate", "CONTENT PILLARS");
  expect(moments).toMatch(/^E\d+ \| Home opener \| schedule \| why now: Home opener is close\. \| idea I1$/m);
  expect(moments).toMatch(/^E\d+ \| City derby \| schedule \| why now: City derby is close\. \| idea I2$/m);
  expect(moments).not.toContain("Autumn gala");                                       // its candidate expired
  const bank = block(input, "IDEA BANK", "MISSED IDEAS");
  const e2 = lineKey(input, "E", "City derby");
  expect(bank).toContain(`I3 | timely | ${e2} City derby | from the athlete's new photos and clips (2) | hook: DERBY-CLIP-HOOK | reel on instagram | timing: the day before`);
  expect(bank).toContain("I4 | evergreen | P2 Race days | from the athlete's new photos and clips (1) | hook: RACE-PHOTO-HOOK | feed on instagram | timing: this week");
  expect(bank).toContain("  brief: show The work. | caption angle: Effort. | avoid: Anything staged.");
  expect(bank).not.toMatch(/OPENER-HOOK|DERBY-HOOK \||SKIPPED-HOOK|USED-HOOK/);         // moments' own entries ride on MOMENTS; never used or skipped
  const missed = block(input, "MISSED IDEAS", "PLAYBOOK");
  expect(missed).toContain("X1 | missed: Autumn gala (2026-10-30) | hook: GALA-HOOK | carousel on instagram | timing: the week before");
  const playbook = block(input, "PLAYBOOK", "POSTING PACE");
  expect(playbook).toContain("- instagram | target posts a week (feed posts, reels, carousels; never stories): 3-4 | format mix a week: - | stories a week: - | ideal length 7-20s");
  expect(playbook).toContain("  formats: reel (a short vertical video: action and behind the scenes)");
  expect(playbook).toContain("  hooks: Open on the moment of effort.");
  expect(playbook).toContain("- tiktok | no playbook yet");
  expect(block(input, "PREFERENCES AND AVOID-LIST", "CONNECTED ACCOUNTS")).toContain("- style: I only want to post twice a week.");   // her words, verbatim
  expect(t.calls[0].text.format.schema.properties.idea_moves).toBeDefined();

  // B3: the write.
  const run = (await store.getRun(A, (out as any).runId))!;
  const applied = (run.output as PlanRunOutput).applied!;
  const actions = new Map((await store.listDecisions(A, { skillId: "plan", kinds: ["action"] })).map((d) => [d.suggested, d]));
  const det = (what: string) => actions.get(what)!.detail as unknown as ActionDecisionDetail;

  // A moment's own entry, reused.
  expect(det("Opener reel").idea).toEqual({ ideaId: s.ideas.opener.id, pillar: null });
  expect(det("Opener reel").post).toEqual({ hook: "Back home.", format: "reel", show: "The work, then the result.", captionAngle: "Effort pays.", avoid: "Anything staged.", mediaNeeds: "an action clip" });
  expect(await detailOf(store, s.ideas.opener.id)).toMatchObject({ status: "used", usedInDecisionId: actions.get("Opener reel")!.id });
  // A reverse-pass evergreen idea, reused, keeps its pillar.
  expect(det("Race-day photo").idea).toEqual({ ideaId: s.ideas.racePhoto.id, pillar: { key: "P2", name: "Race days" } });
  expect(await detailOf(store, s.ideas.racePhoto.id)).toMatchObject({ status: "used", usedInDecisionId: actions.get("Race-day photo")!.id });
  // A fresh evergreen post: a new bank row, written by the plan, used at once, under its pillar.
  const fresh = det("A training day").idea!;
  expect(fresh.pillar).toEqual({ key: "P1", name: "Training and the work" });
  const freshRow = (await store.getDecision(A, fresh.ideaId!))!;
  expect(freshRow).toMatchObject({ skillId: "plan", kind: "other", suggested: "FRESH-HOOK", response: "pending", runId: run.id, evidence: [{ kind: "fact", factId: s.result.id }] });
  expect(freshRow.detail).toEqual({
    kind: "idea", timeBound: false, pillarKey: "P1", pillarName: "Training and the work", momentDecisionId: null, expiresOn: null,
    idea: { hook: "FRESH-HOOK", format: "reel", platform: "instagram", timing: "by 2026-10-14" },
    brief: { show: "The work, then the result.", captionAngle: "Effort pays.", avoid: "Anything staged." }, mediaNeeds: "an action clip",
    status: "used", usedInDecisionId: actions.get("A training day")!.id, adaptedFromIdeaId: null,
  });
  // The missed gala idea, used for the derby: adapted (the old row kept, marked), a new row bound to the derby's moment.
  const adapted = det("Derby carousel").idea!;
  expect(await detailOf(store, s.ideas.gala.id)).toMatchObject({ status: "adapted", usedInDecisionId: null });
  expect(await detailOf(store, adapted.ideaId!)).toMatchObject({
    timeBound: true, momentDecisionId: s.m.derby.id, expiresOn: "2026-10-25", adaptedFromIdeaId: s.ideas.gala.id,
    idea: { hook: "GALA-FOR-DERBY", format: "carousel", timing: "by 2026-10-23" }, status: "used", usedInDecisionId: actions.get("Derby carousel")!.id,
  });
  // The idea move: skipped.
  expect(await detailOf(store, s.ideas.derbyClip.id)).toMatchObject({ status: "skipped" });
  // Untouched: the derby's own entry, the used and the skipped rows.
  expect(await detailOf(store, s.ideas.derby.id)).toMatchObject({ status: "new" });
  expect(applied.ideas).toEqual({
    used: [s.ideas.opener.id, s.ideas.racePhoto.id], written: [fresh.ideaId, adapted.ideaId], adapted: [s.ideas.gala.id], skipped: [s.ideas.derbyClip.id], returned: [],
  });

  // A moment whose entry was used by a post the athlete took is not offered again; the skipped and adapted ideas are
  // gone from the bank.
  await store.updateDecision(A, actions.get("Opener reel")!.id, { response: "accepted" });
  const next = fakeResponses(() => ({ json: { contract: "plan/1", stage_read: { band: "developing", why: "w" }, recommended_goals: [], game_plans: [], actions: [], goal_notes: [], missing: [], idea_moves: [], path_note: "p" } }));
  setResponsesTransport(next);
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example was named captain.", type: "found", source: { url: "https://example.org/captain" }, date: "2026-10-09", confidence: 0.9, runId: null }]);
  await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b3:plan", now: NOW });
  const input2 = String(next.calls[0].input);
  expect(block(input2, "MOMENTS (candidate", "CONTENT PILLARS")).not.toContain("Home opener |");
  expect(input2).not.toMatch(/DERBY-CLIP-HOOK|X\d+ \| missed: Autumn gala/);
});

test("B4: what the plan filed does not change the next plan's input — same week, nothing else new → reused", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const t = fakeResponses((body) => ({ json: mixJson(String(body.input), s) }));
  setResponsesTransport(t);
  const first = await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b4a:plan", now: NOW });
  expect(first.status).toBe("planned");
  const again = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b4b:plan", now: new Date("2026-10-11T09:00:00.000Z") });
  expect(again).toEqual({ status: "reused", runId: (first as any).runId, why: "unchanged_input" });
  expect(t.calls).toHaveLength(1);
});

test("B4b: a plan's own skip does not change the next plan's input either", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const t = fakeResponses((body) => {
    const input = String(body.input);
    return { json: mixJson(input, s, { idea_moves: [{ idea_ref: lineKey(input, "I", "DERBY-CLIP-HOOK"), move: "skip", event_ref: null, timing: null, why: "Not worth it." }] }) };
  });
  setResponsesTransport(t);
  const first = await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b4c:plan", now: NOW });
  expect(((await store.getRun(A, (first as any).runId))!.output as PlanRunOutput).applied!.ideas.skipped).toEqual([s.ideas.derbyClip.id]);
  const again = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b4d:plan", now: new Date("2026-10-11T09:00:00.000Z") });
  expect(again).toEqual({ status: "reused", runId: (first as any).runId, why: "unchanged_input" });
  expect(t.calls).toHaveLength(1);
});

test("B4c: a skip two runs back still does not change the input — run 1 skips, run 2 sees a real change, run 3 is reused", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  // The model skips the derby clip whenever it is shown it (only run 1 is).
  const t = fakeResponses((body) => {
    const input = String(body.input);
    const shown = input.includes("DERBY-CLIP-HOOK");
    return { json: mixJson(input, s, { idea_moves: shown ? [{ idea_ref: lineKey(input, "I", "DERBY-CLIP-HOOK"), move: "skip", event_ref: null, timing: null, why: "Not worth it." }] : [] }) };
  });
  setResponsesTransport(t);
  const run1 = await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b4e:plan", now: NOW });
  expect(run1.status).toBe("planned");
  // The row carries the run that skipped it.
  expect(await detailOf(store, s.ideas.derbyClip.id)).toMatchObject({ status: "skipped", skippedByRunId: (run1 as any).runId });

  // Run 2: something real changed (a new fact), so it plans again — and skips nothing (the clip is no longer shown).
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example was named captain.", type: "found", source: { url: "https://example.org/captain" }, date: "2026-10-09", confidence: 0.9, runId: null }]);
  const run2 = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b4f:plan", now: new Date("2026-10-10T15:00:00.000Z") });
  expect(run2.status).toBe("planned");
  expect(String(t.calls[1].input)).not.toContain("DERBY-CLIP-HOOK");
  expect(((await store.getRun(A, (run2 as any).runId))!.output as PlanRunOutput).applied!.ideas.skipped).toEqual([]);

  // Run 3: nothing new. Run 1's skip is still undone for the digest (run 1 is in the window), so run 2 stands.
  const run3 = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b4g:plan", now: new Date("2026-10-11T09:00:00.000Z") });
  expect(run3).toEqual({ status: "reused", runId: (run2 as any).runId, why: "unchanged_input" });
  expect(t.calls).toHaveLength(2);
});

test("B4d: a care moment's skip is not the plan's own — it is not undone for the digest", () => {
  const care = { decisionId: "i-care", skillId: "post-kit/ideas", entry: entry({ status: "skipped" }), eventFactId: null, momentPending: null, momentName: null, momentCategory: null, momentRetiredWhy: null, assets: 1, createdAt: "2026-10-01T00:00:00.000Z" };
  const planSkip = { ...care, decisionId: "i-plan", entry: entry({ status: "skipped", skippedByRunId: "run-1" }) };
  const rewound = rewindForDigest([care, planSkip], new Set());
  expect(rewound.map((b) => [b.decisionId, b.entry.status])).toEqual([["i-care", "skipped"], ["i-plan", "new"]]);
  expect(rewound[1].entry.skippedByRunId).toBeUndefined();
});

test("B4e: a plan's skip is undone for the digest however old — past the 7-day reuse window too", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const later = new Date(NOW.getTime() + 9 * 86_400_000);   // past PLAN.REUSE_MAX_AGE_MS from the skip
  const before = await buildPlanInput(store, sources(), A, later);
  // A plan run 9 days earlier skipped the idea: it carries that run's id, and no run list is consulted.
  const row = (await store.getDecision(A, s.ideas.racePhoto.id))!;
  await store.updateDecision(A, row.id, { detail: { ...row.detail, status: "skipped", skippedByRunId: "a-run-nine-days-old" } });
  const after = await buildPlanInput(store, sources(), A, later);
  expect(after.digest).toBe(before.digest);
  // The model's own input does change: the skipped idea is no longer offered.
  expect(before.input).toContain("RACE-PHOTO-HOOK");
  expect(after.input).not.toContain("RACE-PHOTO-HOOK");
});

test("B7: a reworded re-plan takes the idea from the action it replaces", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  let reword = false;
  const t = fakeResponses((body) => {
    const input = String(body.input);
    const json = mixJson(input, s);
    if (reword) json.actions[1] = { ...json.actions[1], what: "Race photo on Tuesday" };
    return { json };
  });
  setResponsesTransport(t);
  await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b7a:plan", now: NOW });
  const old = (await store.listDecisions(A, { skillId: "plan", kinds: ["action"] })).find((d) => d.suggested === "Race-day photo")!;
  expect(await detailOf(store, s.ideas.racePhoto.id)).toMatchObject({ status: "used", usedInDecisionId: old.id });

  reword = true;
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example was named captain.", type: "found", source: { url: "https://example.org/captain" }, date: "2026-10-09", confidence: 0.9, runId: null }]);
  const second = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b7b:plan", now: new Date("2026-10-11T09:00:00.000Z") });
  // The idea held by the old action was offered again …
  expect(block(String(t.calls[1].input), "IDEA BANK", "MISSED IDEAS")).toContain("hook: RACE-PHOTO-HOOK");
  // … and the reworded action took it; the old one expired without handing it back.
  const reworded = (await store.listDecisions(A, { skillId: "plan", kinds: ["action"] })).find((d) => d.suggested === "Race photo on Tuesday")!;
  expect((await store.getDecision(A, old.id))!.response).toBe("expired");
  expect(await detailOf(store, s.ideas.racePhoto.id)).toMatchObject({ status: "used", usedInDecisionId: reworded.id });
  expect((reworded.detail as unknown as ActionDecisionDetail).idea).toEqual({ ideaId: s.ideas.racePhoto.id, pillar: { key: "P2", name: "Race days" } });
  const applied = ((await store.getRun(A, (second as any).runId))!.output as PlanRunOutput).applied!;
  expect(applied.ideas.used).toContain(s.ideas.racePhoto.id);
  expect(applied.ideas.returned).not.toContain(s.ideas.racePhoto.id);
});

test("B8: a retry after a partial apply resolves its refs as the run saw them and files nothing twice", async () => {
  const real = createMemoryStore();
  const s = await seed(real);
  const t = fakeResponses((body) => ({ json: mixJson(String(body.input), s) }));
  setResponsesTransport(t);
  // The first attempt dies writing the adapted row: the gala idea is already claimed, its new row never written.
  let crashed = false;
  const flaky: AgentStore = {
    ...real,
    async insertDecision(athleteId, d) {
      if (!crashed && (d.detail as Partial<IdeaBankEntry> | undefined)?.adaptedFromIdeaId) { crashed = true; throw new Error("connection lost"); }
      return real.insertDecision(athleteId, d);
    },
  };
  await expect(runPlan({ store: flaky, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b8:plan", now: NOW })).rejects.toThrow(/connection lost/);
  expect(await detailOf(real, s.ideas.gala.id)).toMatchObject({ status: "adapted" });
  const run = (await real.listRunsSince(A, { since: new Date(0).toISOString(), skillId: "plan" }))[0];
  // The keys the model was shown were kept before anything was written.
  expect((run.output as PlanRunOutput).bankKeys!.missed).toEqual({ X1: s.ideas.gala.id });

  // The retry: no second call; X1 still means the gala idea (a rebuilt input would no longer list it as missed).
  const out = await runPlan({ store: real, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b8:plan", now: NOW });
  expect(out).toMatchObject({ status: "planned", actions: 4 });
  expect(t.calls).toHaveLength(1);
  const planRows = (await real.listDecisions(A, { skillId: "plan", kinds: ["other"] })).map((d) => d.detail as unknown as IdeaBankEntry);
  expect(planRows.filter((e) => e.idea.hook === "FRESH-HOOK")).toHaveLength(1);                     // the fresh idea once
  expect(planRows.filter((e) => e.adaptedFromIdeaId === s.ideas.gala.id)).toHaveLength(1);           // the adapted row, now written
  const actions = new Map((await real.listDecisions(A, { skillId: "plan", kinds: ["action"] })).map((d) => [d.suggested, d]));
  expect(actions.size).toBe(4);
  for (const what of ["Opener reel", "Race-day photo", "A training day", "Derby carousel"]) expect((actions.get(what)!.detail as unknown as ActionDecisionDetail).idea?.ideaId).toBeTruthy();
  expect(await detailOf(real, s.ideas.opener.id)).toMatchObject({ status: "used", usedInDecisionId: actions.get("Opener reel")!.id });
  expect(await detailOf(real, s.ideas.racePhoto.id)).toMatchObject({ status: "used", usedInDecisionId: actions.get("Race-day photo")!.id });
});

test("B5–B6: an action not repeated hands its idea back; a post's pillar is the next plan's last post", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  let json: (input: string) => unknown = (input) => mixJson(input, s);
  const t = fakeResponses((body) => ({ json: json(String(body.input)) }));
  setResponsesTransport(t);
  await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:b5a:plan", now: NOW });
  const actions = new Map((await store.listDecisions(A, { skillId: "plan", kinds: ["action"] })).map((d) => [d.suggested, d]));
  const freshId = (actions.get("A training day")!.detail as unknown as ActionDecisionDetail).idea!.ideaId!;

  // The athlete says the training post is going up: it stays; the rest are not repeated by the next plan.
  await store.updateDecision(A, actions.get("A training day")!.id, { response: "accepted" });
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example was named captain.", type: "found", source: { url: "https://example.org/captain" }, date: "2026-10-09", confidence: 0.9, runId: null }]);
  json = () => ({ contract: "plan/1", stage_read: { band: "developing", why: "w" }, recommended_goals: [], game_plans: [], actions: [], goal_notes: [], missing: [], idea_moves: [], path_note: "p" });
  const second = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b5b:plan", now: new Date("2026-10-11T09:00:00.000Z") });
  expect(second).toMatchObject({ status: "planned", expired: 3 });
  const applied = ((await store.getRun(A, (second as any).runId))!.output as PlanRunOutput).applied!;
  // Handed back: the opener's entry, the race photo and the adapted derby row; the accepted training post keeps its idea.
  expect(applied.ideas.returned.sort()).toEqual([s.ideas.opener.id, s.ideas.racePhoto.id, (actions.get("Derby carousel")!.detail as unknown as ActionDecisionDetail).idea!.ideaId!].sort());
  expect(await detailOf(store, s.ideas.racePhoto.id)).toMatchObject({ status: "new", usedInDecisionId: null });
  expect(await detailOf(store, freshId)).toMatchObject({ status: "used" });

  // The next plan offers them again, and reads the training post as P1's last post.
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example set a record.", type: "found", source: { url: "https://example.org/record" }, date: "2026-10-10", confidence: 0.9, runId: null }]);
  await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:b5c:plan", now: new Date("2026-10-11T10:00:00.000Z") });
  const input = String(t.calls[2].input);
  expect(input).toMatch(/^E\d+ \| Home opener \|.*\| idea I1$/m);
  expect(block(input, "IDEA BANK", "MISSED IDEAS")).toContain("hook: RACE-PHOTO-HOOK");
  expect(block(input, "IDEA BANK", "MISSED IDEAS")).toContain("adapted from a missed idea | hook: GALA-FOR-DERBY");
  const lastPost = actions.get("A training day")!.createdAt.slice(0, 10);
  expect(block(input, "CONTENT PILLARS", "IDEA BANK")).toContain(`P1 | Training and the work | why: The title came from the work. | last post: ${lastPost}`);
  expect(block(input, "CONTENT PILLARS", "IDEA BANK")).toContain("P2 | Race days | why: A champion on the day. | last post: none in the last 30 days");
});

test("B9: plan 1.5.0 — the playbook's target and mix, the athlete's posting pace, their rates, the kit's limits, a standing goal", async () => {
  const store = createMemoryStore();
  await store.insertFacts(A, [
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "The athlete's name is Pat Example.", type: "said", source: { ref: "onboarding/wf#name" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Instagram (@pat) posts per week (30 days): 1.5 per week.", type: "measured", source: { ref: "social_features/7#instagram.posts_per_week_30d" }, date: "2026-10-08", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Instagram (@pat) posts per week (90 days): 2 per week.", type: "measured", source: { ref: "social_features/8#instagram.posts_per_week_90d" }, date: "2026-10-08", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "TikTok (@pat) published 6 posts in the last 30 days.", type: "measured", source: { ref: "social_analytics_snapshots/s1#tiktok.posts_last_30d" }, date: "2026-10-08", confidence: 1, runId: null },
  ]);
  await store.writeBrief(A, {
    summary: "A rower.", sections: [], factIds: [], runId: null,
    internal: { currentSponsors: [], pastSponsors: [], rateRanges: [{ rateType: "ig_reel", low: 50, high: 150, currency: "USD", confidence: "low", drivers: ["local reach"], factIds: [] }] },
  });
  const rec = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "A post before every home race", why: "w", evidence: [], detail: { key: "R1", horizon: "now", value: { text: "", low: null, high: null, currency: null, drivers: [] }, valueConfidence: "low", nextDecision: "n", gamePlan: [], repeats: "before_event" } });
  await store.respondDecision(A, rec.id, "accepted", null);
  await store.insertGoal(A, { text: "A post before every home race", source: "proposed_accepted", decisionId: rec.id });
  await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
  const withMix = (): PlanSources => ({
    ...sources(),
    playbook: async () => [{
      platform: "instagram", version: "v2", activatedAt: "2026-10-01T00:00:00.000Z",
      config: {
        formats: [{ name: "a short vertical video", postFormat: "reel", whenToUse: "action" }], hooks: ["Open on effort."], idealLengthSec: { min: 7, max: 20 },
        cadence: { postsPerWeek: { min: 3, max: 5 }, formatMix: { reel: 2, carousel: 1, feed: 0 }, storiesPerWeek: { min: 3, max: 7 } },
        crossPlatformReuse: [], sources: [], refreshedAt: "2026-10-01",
      },
      cadence: { postsPerWeek: { min: 3, max: 5 }, preferenceStatements: [] },
    }],
    postingFormats: async () => [{ platform: "instagram", windowDays: 30, mix: { reel: 0.5, image: 0.25, carousel: 0.25 } }],
  });
  const { input } = await buildPlanInput(store, withMix(), A, NOW);
  expect(block(input, "PLAYBOOK", "POSTING PACE")).toContain("- instagram | target posts a week (feed posts, reels, carousels; never stories): 3-5 | format mix a week: reel 2, carousel 1, feed 0 | stories a week: 3-7 | ideal length 7-20s");
  const pace = block(input, "POSTING PACE", "RATES");
  expect(pace).toContain("- instagram | posts a week, last 30 days: 1.5 | last 90 days: 2 | by format: reel 50%, image 25%, carousel 25%");
  expect(pace).toContain("- tiktok | posts a week, last 30 days: 1.4 | last 90 days: -");
  // No stored ranges: the Brief's own are what a goal's money value is read from.
  expect(block(input, "RATES", "POST KIT LIMITS")).toContain("- ig_reel | 50-150 USD | confidence low | drivers: local reach");
  expect(block(input, "POST KIT LIMITS", "OPEN THREADS")).toContain("- a carousel holds at most 10 photos or clips; a reel or story at most 3; a feed post one photo");
  expect(block(input, "POST KIT LIMITS", "OPEN THREADS")).toContain("- a video is at most 30 seconds in all, each clip at most 12 seconds");
  const goals = block(input, "GOALS", "DECISIONS AND OUTCOMES");
  expect(goals).toMatch(/kept from a recommendation \| repeats: before_event \| A post before every home race/);
  expect(goals).not.toMatch(/repeats: [a-z_]+ \| Grow my audience/);

  // Stored ranges (athlete_rate_ranges) win over the Brief's.
  const stored = await buildPlanInput(store, { ...withMix(), rates: async () => [{ rateType: "ig_post", low: 80, high: 200, currency: "USD", confidence: "medium", drivers: ["measured reach"] }] }, A, NOW);
  expect(block(stored.input, "RATES", "POST KIT LIMITS")).toContain("- ig_post | 80-200 USD | confidence medium | drivers: measured reach");
  expect(block(stored.input, "RATES", "POST KIT LIMITS")).not.toContain("ig_reel");
});

/** A "what works for you" summary (agent/learning core.ts WhatWorks) with the given lines. */
function whatWorksOf(lines: Array<{ dimension: WhatWorksLine["dimension"]; key: string; label: string; n: number; metrics: WhatWorksLine["metrics"] }>): WhatWorks {
  return {
    contract: "what-works/1", athleteId: A, asOf: NOW.toISOString(), timeZone: null, windowDays: 90, leadsAt: 8, minSample: 5, posts: 20, baselines: {},
    lines: lines.map((l) => ({ ...l, leads: l.n >= 8 })),
  };
}

test("B10: plan 1.6.0 — WHAT WORKS FOR THIS ATHLETE: lines from 3 posts, leads marked from 8, (none) without it; the digest ignores a ratio's drift", async () => {
  const store = createMemoryStore();
  const reel = (save: number, reach: number, n = 9) => ({ dimension: "platform_format" as const, key: "instagram/reel", label: "Instagram reel", n, metrics: { save_count: { ratio: save, n }, reach: { ratio: reach, n } } });
  const carousel = (reach: number, n = 4) => ({ dimension: "platform_format" as const, key: "instagram/carousel", label: "Instagram carousel", n, metrics: { reach: { ratio: reach, n } } });
  const friday = (reach: number) => ({ dimension: "weekday" as const, key: "5", label: "Posted on Friday", n: 3, metrics: { reach: { ratio: reach, n: 3 } } });
  const pillar = (reach: number) => ({ dimension: "pillar" as const, key: "training", label: "Training", n: 2, metrics: { reach: { ratio: reach, n: 2 } } });
  const ww = whatWorksOf([reel(1.84, 1.42), carousel(0.71), pillar(3.2), friday(1.1)]);
  const { input, digest } = await buildPlanInput(store, { ...sources(), whatWorks: async () => ww }, A, NOW);
  const b = block(input, "WHAT WORKS FOR THIS ATHLETE", "POST KIT LIMITS");
  expect(b).toContain(`WHAT WORKS FOR THIS ATHLETE (the athlete's own posts in the last 90 days, each against their usual on that platform; "leads" = 8 or more posts, else an early sign)`);
  expect(b).toContain("- Instagram reel | saves 1.8×, reach 1.4× the athlete's usual | 9 posts | leads");
  expect(b).toContain("- Instagram carousel | reach 0.7× the athlete's usual | 4 posts | early sign");
  expect(b).toContain("- Posted on Friday | reach 1.1× the athlete's usual | 3 posts | early sign");
  // Fewer than 3 posts: nothing to say yet.
  expect(b).not.toContain("Training");
  expect(input.indexOf("WHAT WORKS FOR THIS ATHLETE")).toBeGreaterThan(input.indexOf("RATES ("));

  // Without the source, with the loop off (null) or on a failed read, the block reads (none).
  for (const s of [sources(), { ...sources(), whatWorks: async () => null }, { ...sources(), whatWorks: async () => { throw new Error("down"); } }]) {
    expect(block((await buildPlanInput(store, s, A, NOW)).input, "WHAT WORKS FOR THIS ATHLETE", "POST KIT LIMITS")).toMatch(/\n- \(none\)\n/);
  }

  // A ratio drifting inside its band does not change the digest; a line crossing a band, or starting to lead, does.
  const drift = whatWorksOf([reel(1.95, 1.5), carousel(0.68), pillar(1), friday(1.05)]);
  expect((await buildPlanInput(store, { ...sources(), whatWorks: async () => drift }, A, NOW)).digest).toBe(digest);
  const crossed = whatWorksOf([reel(1.84, 1.42), carousel(1.3), pillar(3.2), friday(1.1)]);
  expect((await buildPlanInput(store, { ...sources(), whatWorks: async () => crossed }, A, NOW)).digest).not.toBe(digest);
  const leads = whatWorksOf([reel(1.84, 1.42), carousel(0.71, 8), pillar(3.2), friday(1.1)]);
  expect((await buildPlanInput(store, { ...sources(), whatWorks: async () => leads }, A, NOW)).digest).not.toBe(digest);
});
