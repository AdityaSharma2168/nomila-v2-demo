/**
 * agent/learning/wins.ts — GET /api/v1/me/agent/wins (Home v3's Wins circle, EXPO_PUBLIC_HOME_V3): the learning loop's
 * exceptional-post messages of the last WIN_DAYS days (and brands' direct payments to her in the same window), read back from where the loop already stores them
 * (memory_decisions, skill learning, kind other, detail.kind exceptional_post; job.ts maybeMessage). Read-only: nothing
 * is written, judged or worded here — the ratio and metric are the loop's own stored reading.
 *
 * Pure over the store (AgentStore), so it unit-tests without a database. Nothing here names an athlete, sport or brand.
 */
import type { AgentWinPayment, AgentWinPost, AgentWinsResponse } from "../../../shared/plan";
import type { AgentStore } from "../research/store";
import { EXCEPTIONAL_DETAIL_KIND, LEARNING } from "./config";
import { LEARNING_METRICS, type MetricKey } from "./core";

/** A win shows for this many days after the loop noticed it. */
export const WIN_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * `payments` (optional): her direct payments since a date (services/moneySummary recentDirectPayments) — a brand paying
 * her is a win too. Left out, the response carries no payments.
 */
export async function readWins(
  athleteId: string,
  store: Pick<AgentStore, "listDecisions">,
  now: Date = new Date(),
  payments?: (since: Date) => Promise<AgentWinPayment[]>,
): Promise<AgentWinsResponse> {
  const rows = await store.listDecisions(athleteId, { skillId: LEARNING.SKILL_ID, kinds: ["other"] });
  const since = now.getTime() - WIN_DAYS * DAY_MS;
  const posts: AgentWinPost[] = [];
  for (const d of rows) {
    // Tenancy belt and braces: the store is already scoped, but never return another athlete's row.
    if (d.athleteId !== athleteId) continue;
    const detail = (d.detail ?? {}) as Record<string, unknown>;
    if (detail.kind !== EXCEPTIONAL_DETAIL_KIND) continue;
    const at = Date.parse(d.createdAt);
    if (Number.isNaN(at) || at < since || at > now.getTime()) continue;
    const ratio = typeof detail.ratio === "number" && Number.isFinite(detail.ratio) ? detail.ratio : null;
    const metricKey = typeof detail.metric === "string" ? detail.metric : null;
    if (ratio == null || !metricKey || !(metricKey in LEARNING_METRICS)) continue;
    posts.push({
      id: d.id,
      at: d.createdAt,
      platform: typeof detail.platform === "string" ? detail.platform : "",
      format: typeof detail.format === "string" ? detail.format : null,
      ratio,
      metric: LEARNING_METRICS[metricKey as MetricKey],
      conversationId: typeof detail.conversationId === "string" ? detail.conversationId : null,
    });
  }
  posts.sort((a, b) => b.at.localeCompare(a.at));
  if (!payments) return { contract: "agent-wins/1", posts };
  const paid = (await payments(new Date(since))).filter((p) => Date.parse(p.at) <= now.getTime());
  return { contract: "agent-wins/1", posts, payments: paid };
}
