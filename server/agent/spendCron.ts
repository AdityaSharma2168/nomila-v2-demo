/**
 * agent/spendCron.ts — POST /api/internal/agent-spend-cron, called by Cloud Scheduler every hour
 * (scripts/provision-schedulers.sh, agent-spend-cron): today's model spend (UTC day) from agent_runs, by provider, as
 * structured log lines that Cloud Logging turns into metrics and alerts (scripts/monitoring/prod-release-monitoring.sh).
 *
 *   "agent spend"                 one info line per provider: { event: "agent_spend", provider, usd, micro_usd, runs }
 *   "agent spend over threshold"  one warn line per provider at or over AGENT_SPEND_ALERT_USD (default 50):
 *                                 { event: "agent_spend_over_threshold", provider, usd, threshold_usd } — the alert counts
 *                                 these, so a threshold change is an env flip, never an alert-policy edit.
 *
 * Read-only (one grouped SELECT), $0, no flag: it changes nothing, and without its scheduler job nothing calls it.
 * Protected by the CRON_SECRET header (`cronSecretValid` is the app's own; server/index.ts passes it in).
 */
import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";

const logger = createLogger("agent/spend");

export interface ProviderSpend { provider: string; microUsd: number; runs: number }

/** AGENT_SPEND_ALERT_USD (a positive number) or 50. */
export function spendAlertUsd(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AGENT_SPEND_ALERT_USD?.trim());
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/** Today's (UTC day) agent_runs spend by provider. */
export async function dbSpendToday(): Promise<ProviderSpend[]> {
  const [{ db }, { sql }] = await Promise.all([import("../db"), import("drizzle-orm")]);
  const res: any = await db.execute(sql`
    SELECT provider, count(*)::int AS runs, coalesce(sum(cost_micro_usd), 0)::bigint AS micro_usd
    FROM agent_runs
    WHERE started_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    GROUP BY provider`);
  const rows: Array<{ provider: string; runs: number; micro_usd: string | number }> = Array.isArray(res) ? res : res?.rows ?? [];
  return rows.map((r) => ({ provider: String(r.provider), runs: Number(r.runs), microUsd: Number(r.micro_usd) }));
}

/** Log the day's spend; returns what was logged (the route's answer). */
export function reportSpend(rows: ProviderSpend[], thresholdUsd: number) {
  const providers = rows.map((r) => ({ provider: r.provider, usd: Math.round(r.microUsd / 10_000) / 100, runs: r.runs }));
  const over: string[] = [];
  for (const p of providers) {
    logger.info({ event: "agent_spend", provider: p.provider, usd: p.usd, micro_usd: rows.find((r) => r.provider === p.provider)!.microUsd, runs: p.runs }, "agent spend");
    if (p.usd >= thresholdUsd) {
      over.push(p.provider);
      logger.warn({ event: "agent_spend_over_threshold", provider: p.provider, usd: p.usd, threshold_usd: thresholdUsd }, "agent spend over threshold");
    }
  }
  return { window: "utc_day" as const, thresholdUsd, providers, over };
}

export function agentSpendCronRouter(cronSecretValid: (req: Request) => boolean, spendToday: () => Promise<ProviderSpend[]> = dbSpendToday): Router {
  const r = Router();
  r.post("/api/internal/agent-spend-cron", async (req: Request, res: Response) => {
    if (!cronSecretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      res.json({ ok: true, ...reportSpend(await spendToday(), spendAlertUsd()) });
    } catch (err: any) {
      logger.error({ error: String(err?.message ?? err).slice(0, 300) }, "agent spend report failed");
      res.status(500).json({ error: "Internal server error" });
    }
  });
  return r;
}
