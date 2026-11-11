/**
 * planInput.test.ts — idea-bank rows never show as decisions in the plan's input (agent/plan/input.ts): an idea is not a
 * decision anyone made. Rows are left out by their skill (post-kit/ideas) and by their shape (detail.kind "idea"), each
 * on its own; every other decision still shows. The digest does
 * not move when only ideas were added; a usable idea reaches the plan only in its own IDEA BANK block.
 */
jest.mock("../../db", () => ({ db: {} }));

import { buildPlanInput, type PlanSources } from "../plan/input";
import { createMemoryStore } from "../research/store";
import { IDEAS_SKILL_ID } from "./config";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:00Z");

const sources: PlanSources = { mia: async () => null, connected: async () => [], openThreads: async () => [], preferences: async () => [], playbook: async () => [] };

test("idea rows are left out of the plan's decisions block, by skill and by shape; the digest ignores them", async () => {
  const store = createMemoryStore();
  await store.insertDecision(A, { runId: null, skillId: "goals", kind: "other", suggested: "A real decision", why: "w", evidence: [] });
  const before = await buildPlanInput(store, sources, A, NOW);
  expect(before.input).toContain("A real decision");

  await store.insertDecision(A, { runId: null, skillId: IDEAS_SKILL_ID, kind: "other", suggested: "Idea by its skill", why: "w", evidence: [], detail: { kind: "idea" } });
  await store.insertDecision(A, { runId: null, skillId: "some-other-writer", kind: "other", suggested: "Idea by its shape", why: "w", evidence: [], detail: { kind: "idea" } });
  await store.insertDecision(A, { runId: null, skillId: IDEAS_SKILL_ID, kind: "other", suggested: "Untyped row from the ideas skill", why: "w", evidence: [] });
  const after = await buildPlanInput(store, sources, A, NOW);
  expect(after.input).toContain("A real decision");
  for (const s of ["Idea by its skill", "Idea by its shape", "Untyped row from the ideas skill"]) expect(after.input).not.toContain(s);
  expect(after.digest).toBe(before.digest);
});

test("with the idea bank on, a usable idea shows in IDEA BANK only — never as a decision", async () => {
  const store = createMemoryStore();
  await store.insertDecision(A, {
    runId: null, skillId: IDEAS_SKILL_ID, kind: "other", suggested: "BANKED-HOOK", why: "w", evidence: [],
    detail: { kind: "idea", timeBound: false, idea: { hook: "BANKED-HOOK", format: "feed", platform: "instagram", timing: "t" }, brief: { show: "s" }, status: "new" },
  });
  const { input } = await buildPlanInput(store, sources, A, NOW);
  const decisions = input.slice(input.indexOf("DECISIONS AND OUTCOMES"), input.indexOf("PREFERENCES AND AVOID-LIST"));
  const bank = input.slice(input.indexOf("IDEA BANK"), input.indexOf("MISSED IDEAS"));
  expect(decisions).not.toContain("BANKED-HOOK");
  expect(bank).toContain("I1 | evergreen | no pillar | from the athlete's new photos and clips (0) | hook: BANKED-HOOK | feed on instagram | timing: t");
});
