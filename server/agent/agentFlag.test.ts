/**
 * agentFlag.test.ts — AGENT_V3 is pinned ON in the dev Cloud Run yaml and OFF in prod (exactly once each; DEV ONLY —
 * the owner's call), OPENAI_API_KEY is a Secret Manager mount (dev: OPENAI_API_KEY; prod: its own OPENAI_API_KEY_PROD), only the exact string "true"
 * turns it on, and the harness limits have sane defaults that env can tune but not break.
 */
jest.mock("../db", () => ({ db: {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { AGENT, agentV3Enabled, runLimitsFor } from "./config";

const GCP = join(__dirname, "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string; valueFrom?: unknown }[]);

const KEYS = ["AGENT_V3", "AGENT_MAX_STEPS", "AGENT_RUN_COST_CAP_USD", "AGENT_DAY_COST_CAP_USD", "AGENT_CHAT_SKILL"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("AGENT_V3", () => {
  // Stage 1 (owner, 25 Oct 2026): on in prod too.
  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "true"]])("%s pins it to %j, exactly once", (file, value) => {
    expect(envOf(file).filter((e) => e.name === "AGENT_V3")).toEqual([{ name: "AGENT_V3", value }]);
  });

  it("OPENAI_API_KEY is a Secret Manager mount, never a literal: dev's shared secret, prod's own OPENAI_API_KEY_PROD", () => {
    expect(envOf("cloud-run-dev.yaml").filter((e) => e.name === "OPENAI_API_KEY"))
      .toEqual([{ name: "OPENAI_API_KEY", valueFrom: { secretKeyRef: { name: "OPENAI_API_KEY", key: "latest" } } }]);
    expect(envOf("cloud-run-prod.yaml").filter((e) => e.name === "OPENAI_API_KEY"))
      .toEqual([{ name: "OPENAI_API_KEY", valueFrom: { secretKeyRef: { name: "OPENAI_API_KEY_PROD", key: "latest" } } }]);
  });

  it("only the exact string \"true\" is on", () => {
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      if (v === undefined) delete process.env.AGENT_V3; else process.env.AGENT_V3 = v;
      expect(agentV3Enabled()).toBe(false);
    }
    process.env.AGENT_V3 = "true";
    expect(agentV3Enabled()).toBe(true);
  });
});

describe("limits", () => {
  it("defaults", () => {
    expect({ steps: AGENT.MAX_STEPS, run: AGENT.RUN_COST_CAP_MICRO_USD, day: AGENT.DAY_COST_CAP_MICRO_USD, skill: AGENT.CHAT_SKILL })
      .toEqual({ steps: 8, run: 500_000, day: 5_000_000, skill: "chat" });
  });

  it("a skill's own limits replace the run defaults; AGENT_SKILL_CAPS overrides them without a deploy", () => {
    const chat = { id: "chat", limits: { maxSteps: 6, costCapUsd: 0.15, maxWebSearches: 2 } };
    expect(runLimitsFor(chat)).toEqual({ maxSteps: 6, costCapMicroUsd: 150_000, maxWebSearches: 2 });
    expect(runLimitsFor({ id: "plain" })).toEqual({ maxSteps: 8, costCapMicroUsd: 500_000, maxWebSearches: null });
    process.env.AGENT_SKILL_CAPS = JSON.stringify({ chat: { max_steps: 4, cost_cap_usd: 0.1, max_web_searches: 1 } });
    try {
      expect(runLimitsFor(chat)).toEqual({ maxSteps: 4, costCapMicroUsd: 100_000, maxWebSearches: 1 });
      process.env.AGENT_SKILL_CAPS = "not json";
      expect(runLimitsFor(chat)).toEqual({ maxSteps: 6, costCapMicroUsd: 150_000, maxWebSearches: 2 });
    } finally { delete process.env.AGENT_SKILL_CAPS; }
  });

  it("env tunes them; nonsense, zero and negatives fall back", () => {
    process.env.AGENT_MAX_STEPS = "3";
    process.env.AGENT_RUN_COST_CAP_USD = "0.05";
    process.env.AGENT_DAY_COST_CAP_USD = "abc";
    expect([AGENT.MAX_STEPS, AGENT.RUN_COST_CAP_MICRO_USD, AGENT.DAY_COST_CAP_MICRO_USD]).toEqual([3, 50_000, 5_000_000]);
    process.env.AGENT_MAX_STEPS = "0";
    process.env.AGENT_RUN_COST_CAP_USD = "-1";
    expect([AGENT.MAX_STEPS, AGENT.RUN_COST_CAP_MICRO_USD]).toEqual([8, 500_000]);
  });
});
