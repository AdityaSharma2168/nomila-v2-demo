/**
 * promptDigest.test.ts — every agent run records which prompt text produced it (launch item 3 of the content-prompt
 * review): sha256 of the final instructions after includes and the harness rules, beside the skill's semver, on the run's
 * "skill" trace step (agent_runs.steps). The athlete's data is never part of it.
 *
 *   D1  the digest is sha256 of exactly what the model receives as instructions (instructionsFor)
 *   D2  an edit to a shared include changes the digest even when nobody bumps the skill's version
 *   D3  a structured run (runSkill) records it on success and on failure, the same for two athletes with different data
 *
 * No provider is reached: the OpenAI transport is a fake.
 */
jest.mock("../db", () => ({ db: {} }));

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeResponses } from "../testUtils/agentModel";
import { setResponsesTransport } from "./research/llm";
import { runSkill } from "./research/runSkill";
import { RESEARCH_PASS_SCHEMA } from "./research/schemas";
import { createMemoryStore } from "./research/store";
import { clearJobCache, instructionsFor, loadJob, promptDigest } from "./jobs";

afterEach(() => { setResponsesTransport(null); delete process.env.AGENT_JOBS_DIR; clearJobCache(); });

test("D1: the digest is sha256 of exactly the instructions the model receives", () => {
  for (const id of ["research", "plan", "chat", "moments", "post-kit/ideas"]) {
    const skill = loadJob(id);
    expect(promptDigest(skill)).toBe(createHash("sha256").update(instructionsFor(skill)).digest("hex"));
    expect(promptDigest(skill)).toMatch(/^[0-9a-f]{64}$/);
  }
  // Includes are expanded before hashing: the shared voice text is inside what is hashed, not the include line.
  const plan = loadJob("plan");
  expect(instructionsFor(plan)).not.toContain("{{include");
});

test("D2: an edit to a shared include changes the digest even when the skill's version is not bumped", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-digest-"));
  mkdirSync(join(dir, "_shared"), { recursive: true });
  mkdirSync(join(dir, "t"), { recursive: true });
  writeFileSync(join(dir, "t", "voice-user.md"), "---\nid: t/voice-user\nversion: 1.0.0\ndescription: d\neffort: low\nmodel: fast\n---\nDo the thing.\n\n{{include _shared/voice}}\n");
  process.env.AGENT_JOBS_DIR = dir;

  writeFileSync(join(dir, "_shared", "voice.md"), "Speak plainly.");
  clearJobCache();
  const before = loadJob("t/voice-user");
  writeFileSync(join(dir, "_shared", "voice.md"), "Speak plainly and warmly.");
  clearJobCache();
  const after = loadJob("t/voice-user");

  expect(after.version).toBe(before.version);
  expect(promptDigest(after)).not.toBe(promptDigest(before));
});

test("D3: a structured run records the digest beside its semver, on success and on failure; athlete data never moves it", async () => {
  const store = createMemoryStore();
  const skill = loadJob("research");
  setResponsesTransport(fakeResponses(() => ({ json: { identity: { description: "x", ambiguity: "" }, facts: [], gaps: [], narrative: "n" } })));
  await runSkill({ store, athleteId: "a1", skillId: "research", trigger: "test", parentRef: null, input: "ATHLETE\n- Name: Pat One\n- Sport: rowing", schemaName: "research_pass", schema: RESEARCH_PASS_SCHEMA });
  await runSkill({ store, athleteId: "a2", skillId: "research", trigger: "test", parentRef: null, input: "ATHLETE\n- Name: Sam Two\n- Sport: fencing", schemaName: "research_pass", schema: RESEARCH_PASS_SCHEMA });
  setResponsesTransport(fakeResponses(() => ({ json: null, rawText: "not json" })));
  await expect(runSkill({ store, athleteId: "a3", skillId: "research", trigger: "test", parentRef: null, input: "x", schemaName: "research_pass", schema: RESEARCH_PASS_SCHEMA })).rejects.toThrow(/no valid JSON/);

  const runs: any[] = (store as any).dump().runs;
  expect(runs.map((r) => r.status)).toEqual(["completed", "completed", "failed"]);
  for (const r of runs) {
    expect(r.skillVersion).toBe(skill.version);
    expect(r.steps[0]).toEqual({ seq: 0, at: expect.any(String), type: "skill", skillId: "research", version: skill.version, digest: promptDigest(skill) });
  }
});
