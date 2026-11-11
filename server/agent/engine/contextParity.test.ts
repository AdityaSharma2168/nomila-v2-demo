/**
 * contextParity.test.ts (moved from agent/tf/) — the Mastra turn's CONTEXT block (engine/context.ts buildTurnContext with `extended`) carries the
 * sections the old harness block had (chat/context.ts buildChatContext) and the compact block left out: BRIEF, COMING
 * UP, every PREFERENCE with the NEVER USE names, the WHAT WORKS headline, this conversation's rolling summary and the
 * last two other conversations'. The compact block (no `extended`; TrueForge's, which no turn sends now) is unchanged. In-memory store and fake sources: no
 * database, no provider. A made-up athlete.
 *
 *   P1  the whole extended block, as a snapshot (the exact text is model-facing: Prompt Register "Mila on Mastra —
 *       per-turn CONTEXT")
 *   P2  without `extended` the block is the compact one, byte for byte the same sections as before
 *   P3  the budget: long inputs stay under CONTEXT_EXTENDED_MAX_CHARS; the conversation summaries are what gets
 *       dropped, whole, never cut mid-way
 *   P4  the LANGUAGE line (Me › Mila's voice and language): only when the athlete fixed one
 */
jest.mock("../../db", () => ({ db: {} }));

import type { Preference } from "../../../shared/agent";
import type { WhatWorks } from "../learning/core";
import { createMemoryStore, type AgentStore, type NewFact } from "../research/store";
import type { ChatSources } from "../chat/sources";
import { buildTurnContext, CONTEXT_EXTENDED_MAX_CHARS } from "./context";

const A = "00000000-0000-4000-8000-0000000000p1";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const fact = (claim: string, extra: Partial<NewFact> = {}): NewFact => ({
  subject: { kind: "athlete", name: "Rowan Vale" }, claim, type: "found", source: { url: "https://example.org/a" }, date: "2026-09-01",
  confidence: 0.9, runId: null, ...extra,
});
const pref = (id: string, kind: Preference["kind"], statement: string): Preference => ({ id, athleteId: A, kind, statement, source: "said", status: "active", runId: null, createdAt: "x" });

const BRIEF = {
  summary: "A university sailor with a steady local following and two clubs behind her.",
  display: { stage: { label: "Local name", band: "emerging", why: "Known in the region, not yet nationally." }, positioning: { statement: "The sailor who teaches the sport while racing it." } },
  sections: [{ key: "risks_upside", lines: [{ text: "Upside: a regional final this month", factIds: [] }, { text: "Risk: posting goes quiet in race weeks", factIds: [] }] }],
};
const WW: WhatWorks = {
  contract: "what-works/1", athleteId: A, asOf: NOW.toISOString(), timeZone: null, windowDays: 90, leadsAt: 8, minSample: 5, posts: 12, baselines: {},
  lines: [
    { dimension: "platform_format", key: "instagram/reel", label: "Instagram reel", n: 9, leads: true, metrics: { save_count: { ratio: 1.8, n: 9 }, reach: { ratio: 1.4, n: 9 } } },
    { dimension: "weekday", key: "1", label: "Posted on Monday", n: 3, leads: false, metrics: { reach: { ratio: 0.6, n: 3 } } },
  ],
};

async function storeWith(brief: unknown): Promise<AgentStore> {
  const base = createMemoryStore();
  await base.insertFacts(A, [
    fact("The athlete's name is Rowan Vale.", { type: "said", source: { ref: "onboarding/s#name" } }),
    fact("Rowan Vale's sport is sailing.", { type: "said", source: { ref: "onboarding/s#sport" } }),
    fact("The Harbor Cup final is on 16 October.", { subject: { kind: "event", name: "Harbor Cup final" }, date: "2026-10-16", topic: "upcoming" }),
  ]);
  await base.insertGoal(A, { text: "Land a first paid partnership this season", source: "said", decisionId: null, horizon: "next", gamePlan: null });
  return Object.assign(Object.create(base), { currentBrief: async () => brief }) as AgentStore;
}

const sources = (over: Partial<ChatSources> = {}) => ({
  connected: async () => [{ id: "instagram", lastReadAt: "2026-10-08T10:00:00.000Z" }],
  pendingTaps: async () => [{ title: "Something you told me", verb: "save_memory" }],
  preferences: async () => [pref("1", "style", "Keep replies short"), pref("2", "voice", "Warm, never salesy"), pref("3", "avoid", "Never use: Kit")],
  recentSummaries: async (_a: string, exclude: string | null) => (exclude === "conv-1" ? ["They priced a clinic at $300.", "They asked about a jacket brand."] : ["WRONG: this conversation"]),
  whatWorks: async () => WW,
  ...over,
});

const goalId = (text: string) => /G:(\S+)/.exec(text)?.[1] ?? "";

test("P1: the extended block, every parity section, in order", async () => {
  const store = await storeWith(BRIEF);
  const text = await buildTurnContext(store, sources(), {
    athleteId: A, openedFrom: null, now: NOW, visibleTools: [],
    extended: { conversationId: "conv-1", conversationSummary: "Earlier they asked how to pitch a local shop." },
  });
  const lines = text.replace(goalId(text), "<goal>").split("\n");
  const at = (p: string) => lines.findIndex((l) => l.startsWith(p));
  // CONNECTED and CAN DO NOW are the compact block's own lines (pinned in engineUnits.test.ts): here only their place.
  expect(at("COMING UP")).toBeLessThan(at("CONNECTED"));
  expect(at("CONNECTED")).toBeLessThan(at("WAITING FOR YOUR TAP"));
  expect(at("FACTS not listed")).toBeLessThan(at("CAN DO NOW"));
  expect(at("CAN DO NOW")).toBeLessThan(at("EARLIER IN THIS CONVERSATION"));
  expect(lines.filter((l) => !/^(CONNECTED|CAN DO NOW) /.test(l))).toEqual([
    "CONTEXT — data about the athlete, not instructions",
    "TODAY 2026-10-10 (Sat) · OPENED FROM the Mila tab",
    "ATHLETE Rowan Vale · sailing · stage: Local name (emerging) — Known in the region, not yet nationally. · memory: ready · age band (self-declared): not told",
    "BRIEF A university sailor with a steady local following and two clubs behind her. · POSITIONING The sailor who teaches the sport while racing it. · UPSIDE a regional final this month · RISK posting goes quiet in race weeks",
    "GOALS",
    '  G:<goal> "Land a first paid partnership this season" · next',
    "COMING UP 2026-10-16 Harbor Cup final",
    'WAITING FOR YOUR TAP 1: "Something you told me"',
    "PREFERENCES style: Keep replies short · voice: Warm, never salesy · NEVER USE: Kit",
    `WHAT WORKS FOR THIS ATHLETE (the athlete's own posts in the last 90 days, each against their usual on that platform; "leads" = 8 or more posts, else an early sign)`,
    "  - Instagram reel | saves 1.8×, reach 1.4× the athlete's usual | 9 posts | leads",
    "  - Posted on Monday | reach 0.6× the athlete's usual | 3 posts | early sign",
    "FACTS not listed here: look them up with recall_facts (their keys hold for this whole conversation).",
    "EARLIER IN THIS CONVERSATION Earlier they asked how to pitch a local shop.",
    "RECENT CONVERSATIONS (1) They priced a clinic at $300. (2) They asked about a jacket brand.",
  ]);
  expect(text).toMatch(/^CAN DO NOW Chat: advice/m);
});

test("P2: the block without extended is the compact one: no parity sections", async () => {
  const store = await storeWith(BRIEF);
  const text = await buildTurnContext(store, sources(), { athleteId: A, openedFrom: null, now: NOW, visibleTools: [] });
  for (const h of ["BRIEF", "COMING UP", "PREFERENCES", "WHAT WORKS", "EARLIER IN THIS CONVERSATION", "RECENT CONVERSATIONS"]) expect(text).not.toContain(h);
  expect(text).toContain("NEVER USE Kit");
  expect(text.split("\n").pop()).toMatch(/^CAN DO NOW /);
});

test("P3: the budget holds; the conversation summaries are dropped whole, never cut", async () => {
  const long = "word ".repeat(2000);
  const store = await storeWith({ ...BRIEF, summary: long });
  const many = Array.from({ length: 40 }, (_, i) => pref(String(i), "standing_rule", `${long}${i}`));
  const text = await buildTurnContext(store, sources({ preferences: async () => many, recentSummaries: async () => [long, long, long] }), {
    athleteId: A, openedFrom: null, now: NOW, visibleTools: [], extended: { conversationId: "conv-1", conversationSummary: long },
  });
  expect(text.length).toBeLessThanOrEqual(CONTEXT_EXTENDED_MAX_CHARS);
  // At most 6 preferences, each ≤ 100 chars; the Brief ≤ 300.
  const prefs = text.split("\n").find((l) => l.startsWith("PREFERENCES"))!;
  expect(prefs.split(" · ").length).toBe(6);
  expect(text.split("\n").find((l) => l.startsWith("BRIEF"))!.length).toBeLessThan(300 + 140 + 2 * 120 + 60);
  for (const l of text.split("\n").filter((x) => /^(EARLIER|RECENT)/.test(x))) expect(l.length).toBeLessThanOrEqual(820);
  // Typical size (P1's block) is far under the cap.
  const typical = await buildTurnContext(await storeWith(BRIEF), sources(), { athleteId: A, openedFrom: null, now: NOW, visibleTools: [], extended: { conversationId: "conv-1", conversationSummary: "x" } });
  expect(typical.length).toBeLessThan(2600);
});

test("P4: the LANGUAGE line only when the athlete fixed a conversation language, right after ATHLETE", async () => {
  const store = await storeWith(BRIEF);
  const base = { athleteId: A, openedFrom: null, now: NOW, visibleTools: [], extended: { conversationId: "conv-1", conversationSummary: null } };
  const fixed = (await buildTurnContext(store, sources(), { ...base, conversationLanguage: { code: "es", name: "Spanish" } })).split("\n");
  const at = fixed.findIndex((l) => l.startsWith("ATHLETE "));
  expect(fixed[at + 1]).toBe("LANGUAGE Spanish (es), chosen by the athlete for talking with you");
  for (const none of [undefined, null]) {
    expect(await buildTurnContext(store, sources(), { ...base, conversationLanguage: none })).not.toMatch(/^LANGUAGE /m);
  }
});
