/**
 * agent/config.ts — the agent's flag and limits (the run caps every Mila turn and background skill reads), in one place. Getters, so env is read at call time (tests and late
 * env injection rely on that, same as server/mila/config.ts).
 *
 * AGENT_V3 — ON in dev and prod (gcp/cloud-run-*.yaml, pinned by agentFlag.test.ts). Only the exact string "true"
 * turns it on. It no longer picks the chat's engine (Mila always runs on Mastra: agent/engine). What it gates now: the
 * app's new layout (EXPO_PUBLIC_AGENT_V3 in the client), including the Studio v3 tab root (the library), and on the
 * server the Studio library route (agent/studio/routes.ts) and the onboarding content capability (onboarding/catalog.ts).
 * Studio's own server features are switched by STUDIO_ALL_ON, not by this flag.
 */

import { clampCap, readCap } from "../lib/spendCap";

/**
 * Hard maxima for the spend caps below (lib/spendCap.ts): an env override is clamped to these, and a value that is not
 * a usable number falls back to the default. About 10× the defaults.
 */
export const AGENT_CAP_MAX = {
  RUN_USD: 5,
  DAY_USD: 50,
  STEPS: 50,
  WEB_SEARCHES: 50,
} as const;

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function agentV3Enabled(): boolean {
  return process.env.AGENT_V3 === "true";
}

export const AGENT = {
  /** Model calls per run before the harness stops it (stop_reason max_steps). */
  get MAX_STEPS(): number { return Math.floor(readCap("AGENT_MAX_STEPS", 8, AGENT_CAP_MAX.STEPS)); },
  /** Per-run spend cap (USD → micro-dollars). Checked before every model call. */
  get RUN_COST_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_RUN_COST_CAP_USD", 0.5, AGENT_CAP_MAX.RUN_USD) * 1_000_000); },
  /** Per-athlete per-UTC-day spend cap (USD → micro-dollars), summed over agent_runs. */
  get DAY_COST_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_DAY_COST_CAP_USD", 5, AGENT_CAP_MAX.DAY_USD) * 1_000_000); },
  /** Per-tool execution timeout (ms). */
  get TOOL_TIMEOUT_MS(): number { return Math.floor(positive("AGENT_TOOL_TIMEOUT_MS", 15_000)); },
  /** Budget for one serialized tool result handed back to the model. */
  get TOOL_RESULT_MAX_CHARS(): number { return Math.floor(positive("AGENT_TOOL_RESULT_MAX_CHARS", 8000)); },
  /** The skill whose tools, limits and description bound a Mila chat turn on Mastra (jobs/chat.yaml). */
  get CHAT_SKILL(): string { return process.env.AGENT_CHAT_SKILL?.trim() || "chat"; },
  /** How long an approval item stays approvable. */
  get APPROVAL_TTL_DAYS(): number { return positive("AGENT_APPROVAL_TTL_DAYS", 7); },
  /** The chat context block's size budget (characters, ≈ 3,000 tokens). */
  get CHAT_CONTEXT_MAX_CHARS(): number { return Math.floor(positive("AGENT_CHAT_CONTEXT_MAX_CHARS", 12_000)); },
} as const;

/** The limits one run of a skill runs under (shared/agent.ts SkillLimits), resolved. */
export interface RunLimits {
  maxSteps: number;
  costCapMicroUsd: number;
  /** Provider web searches per run; null = no count (the skill's prompt is the only limit). */
  maxWebSearches: number | null;
}

/**
 * The limits for a skill: AGENT_SKILL_CAPS (JSON keyed by skill id: { max_steps, cost_cap_usd, max_web_searches }) over
 * the skill's front-matter `limits`, over the harness defaults (AGENT_MAX_STEPS, AGENT_RUN_COST_CAP_USD). A skill's own
 * cap replaces the global run cap for that skill (chat: $0.15 a turn, not $0.50). The per-athlete day cap always applies.
 */
export function runLimitsFor(skill: { id: string; limits?: { maxSteps?: number; costCapUsd?: number; maxWebSearches?: number } }): RunLimits {
  let env: { max_steps?: unknown; cost_cap_usd?: unknown; max_web_searches?: unknown } = {};
  try { env = (JSON.parse(process.env.AGENT_SKILL_CAPS || "{}") as Record<string, typeof env>)[skill.id] ?? {}; } catch { env = {}; }
  // Every value is clamped to the harness maxima (AGENT_CAP_MAX); a field that is there but not a usable number falls
  // back to the skill's own limit or the harness default (fail closed), never to "no limit".
  const steps0 = skill.limits?.maxSteps ?? AGENT.MAX_STEPS;
  const steps = env.max_steps != null ? Math.max(1, clampCap(`AGENT_SKILL_CAPS.${skill.id}.max_steps`, env.max_steps, steps0, AGENT_CAP_MAX.STEPS)) : Math.min(steps0, AGENT_CAP_MAX.STEPS);
  const usd0 = skill.limits?.costCapUsd ?? AGENT.RUN_COST_CAP_MICRO_USD / 1_000_000;
  const usd = env.cost_cap_usd != null ? clampCap(`AGENT_SKILL_CAPS.${skill.id}.cost_cap_usd`, env.cost_cap_usd, usd0, AGENT_CAP_MAX.RUN_USD)
    : skill.limits?.costCapUsd != null ? Math.min(skill.limits.costCapUsd, AGENT_CAP_MAX.RUN_USD) : null;
  const search0 = skill.limits?.maxWebSearches ?? null;
  const searches = env.max_web_searches != null
    ? clampCap(`AGENT_SKILL_CAPS.${skill.id}.max_web_searches`, env.max_web_searches, search0 ?? 0, AGENT_CAP_MAX.WEB_SEARCHES, { allowZero: true })
    : search0 != null ? Math.min(search0, AGENT_CAP_MAX.WEB_SEARCHES) : null;
  return {
    maxSteps: Math.floor(steps),
    costCapMicroUsd: usd != null ? Math.round(usd * 1_000_000) : AGENT.RUN_COST_CAP_MICRO_USD,
    maxWebSearches: searches != null ? Math.floor(searches) : null,
  };
}
