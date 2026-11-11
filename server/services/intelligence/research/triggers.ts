/**
 * research/triggers.ts — event/manual refresh REQUESTS (Step 2b design §4.3, E7).
 *
 * A request is queued on the athlete's state row (`pending`, `next_due_at = now`) and admitted by
 * the next planner pass under budget. Never executes anything. A NO-OP unless the one execution
 * gate is true: with either flag false a social connection or an operator re-research must not
 * add `pending`, change `next_due_at` or otherwise mutate the 2b lifecycle substrate.
 *
 * Concurrency-safe (review of PR #400): the merge runs in ONE transaction — insert the state row
 * on conflict do nothing, SELECT … FOR UPDATE, merge (de-dupe by domain, 50-entry bound), UPDATE —
 * so two triggers arriving at once serialise on the row lock and neither request is lost.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athleteResearchState } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { researchPlannerExecutionEnabled, researchRefreshProviderBinding } from "./config";
import { plannableDomainsFor, type ResearchDomain, type ResearchTrigger } from "./registries";
import { isAgentFrontAthlete } from "../../agentFrontAthlete";

const logger = createLogger("research-planner");

export interface PendingRequest { domain: ResearchDomain; trigger: "event" | "manual"; reason: string; requestedAt: string }

export async function requestRefresh(athleteId: string, domains: ResearchDomain[], trigger: Extract<ResearchTrigger, "event" | "manual">, reason: string, asOf: Date = new Date()): Promise<{ queued: number } | null> {
  if (!researchPlannerExecutionEnabled()) return null;
  // Legacy intelligence switch-off (12 Oct 2026): an agent-front athlete is researched by the agent, never queued here.
  if (await isAgentFrontAthlete(athleteId)) { logger.info({ athleteId, trigger, reason }, "research refresh skipped: agent-front athlete"); return null; }
  // kimi: PLANNABLE_DOMAINS, unchanged; direct (PR E2b, D11): + profile, which v3 plans on its own.
  const plannable = plannableDomainsFor(researchRefreshProviderBinding());
  const wanted = domains.filter((d) => plannable.includes(d));
  if (!wanted.length) return { queued: 0 };
  const requests: PendingRequest[] = wanted.map((domain) => ({ domain, trigger, reason: reason.slice(0, 120), requestedAt: asOf.toISOString() }));
  await db.transaction(async (tx) => {
    await tx.insert(athleteResearchState).values({ athlete_id: athleteId, research_status: "seed_only" }).onConflictDoNothing();
    const [row] = await tx.select({ pending: athleteResearchState.pending }).from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)).limit(1).for("update");
    const existing = ((row?.pending ?? []) as PendingRequest[]);
    const merged = [...existing.filter((p) => !wanted.includes(p.domain)), ...requests].slice(-50);
    await tx.update(athleteResearchState).set({ pending: merged as any, next_due_at: sql`LEAST(COALESCE(${athleteResearchState.next_due_at}, ${asOf}), ${asOf})`, updated_at: new Date() }).where(eq(athleteResearchState.athlete_id, athleteId));
  });
  logger.info({ athleteId, domains: wanted, trigger, reason }, "research refresh requested");
  return { queued: wanted.length };
}
