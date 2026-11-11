/**
 * agent/engine/config.ts — the Mastra engine's settings and the switches of the surfaces that run on it.
 *
 * Mila runs on Mastra (@mastra/core as a library inside this Express app, agent/engine/mastra), always: there is no
 * engine switch any more (Mastra-only, PR 2 of 3, Nov 2026). MILA_ENGINE and MILA_MASTRA_ATHLETES are read by nothing,
 * so a service that still carries them is unaffected by them (the prod YAML dropped its leftover MILA_ENGINE in the
 * Nov 2026 catch-up).
 *
 *   MILA_TF_TURN_TIMEOUT_MS  the longest a turn may run before it is cancelled (default 240 s; capped below the athlete
 *                        pass's 10-minute life). The name is kept for now (a rename is cleanup).
 *   MILA_MASTRA_MODEL    "<provider>/<model>" (default "openai/gpt-6-luna", the model TrueForge's mila-dev ran). Only
 *                        "openai/…" is accepted: the model is built as an @ai-sdk/openai provider INSTANCE, never handed
 *                        to Mastra as a string (a string resolves through Mastra's gateway registry lookups).
 *   MILA_MASTRA_EFFORT   OpenAI reasoning effort (default "low", as mila-dev; minimal | low | medium | high). It is what
 *                        agent_runs.effort records for a Mastra turn.
 *   MILA_MASTRA_SCHEMA   Mastra's own Postgres schema (default "mastra"; tables from migrations/0147_mastra_engine.sql,
 *                        never created at runtime).
 *   MILA_MASTRA_HISTORY  messages of the thread Mastra replays per turn (default 40).
 *   MILA_MASTRA_POOL_MAX connections in Mastra's own pg pool (PostgresStore), per instance (default 4). It sits on top of
 *                        the app pool (DB_POOL_MAX, server/db.ts), so maxScale × (DB_POOL_MAX + this) must fit the Cloud
 *                        SQL instance: server/lib/dbPoolBudget.test.ts pins that for both gcp/cloud-run-*.yaml.
 *   MILA_MAX_CONCURRENT_TURNS  Mastra turns one athlete may have running at once, across conversations and instances
 *                        (default 2; a tuning value, not a feature flag). A newer turn in the SAME conversation replaces
 *                        that conversation's turn, so it never counts against it. Over it, a chat turn is refused with
 *                        a plain line and a background turn is skipped quietly (proactive defers) (mastra/turn.ts
 *                        admitRun).
 *
 * Off by policy, with no switch (security review 28 Oct 2026, docs/release/mila-engine-mastra-cutover.md): automatic
 * working memory, semantic recall, observational memory, generated titles, ResponseCache, durable/evented agents,
 * dynamic workflows, Mastra Studio/editor, Mastra auth/FGA, agent-controller Session approvals, Mastra's HTTP server.
 */
import { readCap } from "../../lib/spendCap";
import { PASS_TTL_SECONDS } from "./tools/config";

/**
 * The engine that ran a runMilaTurn turn: always Mastra. Kept as a name because rows, logs and traces still record an
 * `engine` field (agent_onboarding's pathNote, the chat route's logs); every new one says "mastra".
 */
export type MilaEngineName = "mastra";

/**
 * MILA_TF_WAITLIST (docs/design/mila-hosted-waitlist.md): Mila hosts the landing's waitlist join flow, and
 * agent_onboarding's turns continue in that conversation. Only the exact string "true". The name is kept for now (a
 * rename touches the prod config). It needs no other setting. Dev on, prod off.
 */
export function milaWaitlistEnabled(): boolean {
  return process.env.MILA_TF_WAITLIST === "true";
}

function positiveMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Settings of every Mila turn. */
export const MILA_TURN = {
  /** Capped below the pass's life, so a pass never expires mid-turn. */
  get timeoutMs(): number { return Math.min(Math.floor(positiveMs("MILA_TF_TURN_TIMEOUT_MS", 240_000)), (PASS_TTL_SECONDS - 30) * 1000); },
} as const;

const trimmed = (name: string): string | null => process.env[name]?.trim() || null;
function positive(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Mastra's own pg pool per instance when MILA_MASTRA_POOL_MAX is unset (server/lib/dbPoolBudget.test.ts reads it). */
export const MASTRA_POOL_MAX_DEFAULT = 4;

export const MASTRA = {
  get model(): string { return trimmed("MILA_MASTRA_MODEL") ?? "openai/gpt-6-luna"; },
  /** One of agent_runs.effort's values (minimal | low | medium | high); anything else is "low". */
  get effort(): "minimal" | "low" | "medium" | "high" {
    const v = trimmed("MILA_MASTRA_EFFORT");
    return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : "low";
  },
  get schema(): string { return trimmed("MILA_MASTRA_SCHEMA") ?? "mastra"; },
  get history(): number { return positive("MILA_MASTRA_HISTORY", 40); },
  get poolMax(): number { return positive("MILA_MASTRA_POOL_MAX", MASTRA_POOL_MAX_DEFAULT); },
  /** Hard maximum 10 (lib/spendCap.ts): each running turn can spend, so the override is clamped, never unbounded. */
  get maxConcurrentTurns(): number { return Math.floor(readCap("MILA_MAX_CONCURRENT_TURNS", 2, 10)); },
  /** The model id our price table knows (agent/models.ts): the part after the provider. */
  get priceModel(): string { return this.model.includes("/") ? this.model.split("/").slice(1).join("/") : this.model; },
} as const;

/** agent_runs.provider for a Mastra turn (dashboards split cost, latency and tool errors per engine on it). */
export const MASTRA_PROVIDER = "mastra";
/** mila_tf_sessions.tf_session_id of a Mastra mapping row: "mastra:<thread id>". (Rows TrueForge made hold its own ids.) */
export const MASTRA_SESSION_PREFIX = "mastra:";

/** The requestContext key that carries the (signed) athlete pass to our tools. */
export const PASS_CONTEXT_KEY = "nomila.athletePass";
