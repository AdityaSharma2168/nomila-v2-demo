/**
 * agent/researchRefresh/state.ts — the reads the refresh decides with (no model, no writes).
 *
 *   currentAnchor        her identity anchor now: name and sport from the athlete row, team from her current memory
 *                        (the newest active athlete fact labelled `team`)
 *   lastRefreshAnchor    the anchor recorded at the end of her last finished refresh (its `finish` step), or null
 *   anchorChanged        name, sport or team differ (case, accents and spacing ignored)
 *   todaySpendMicroUsd   what every refresh run started today (UTC) has spent, all athletes — the day cap's input
 *
 * The anchor is recorded AFTER the merge, from the same read, so a refresh that itself finds a team fact does not look
 * like an edit to the next sweep: only a change made after the refresh (her correction, a profile edit) does.
 */
import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { db } from "../../db";
import { agentRuns, athletes, memoryFacts } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { RESEARCH_REFRESH_PARENT, RESEARCH_REFRESH_PROCESS } from "./config";

export interface ResearchAnchor { name: string; sport: string; team: string | null }

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

export function anchorChanged(before: ResearchAnchor, now: ResearchAnchor): boolean {
  return norm(before.name) !== norm(now.name) || norm(before.sport) !== norm(now.sport) || norm(before.team) !== norm(now.team);
}

export async function currentAnchor(athleteId: string): Promise<ResearchAnchor | null> {
  const [a] = await db.select({ name: athletes.full_name, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return null;
  const [team] = await db.select({ value: memoryFacts.field_value }).from(memoryFacts)
    .where(and(eq(memoryFacts.athlete_id, athleteId), eq(memoryFacts.field, "team"), eq(memoryFacts.status, "active"), eq(memoryFacts.subject_kind, "athlete")))
    .orderBy(desc(memoryFacts.created_at)).limit(1);
  return { name: a.name ?? "", sport: a.sport ?? "", team: team?.value ?? null };
}

export async function lastRefreshAnchor(athleteId: string): Promise<ResearchAnchor | null> {
  const [row] = await db.select({ output: workflowSteps.output }).from(workflowSteps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.run_id))
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, RESEARCH_REFRESH_PROCESS), eq(workflowRuns.status, "done"),
      eq(workflowSteps.step, "finish"), eq(workflowSteps.status, "done")))
    .orderBy(desc(workflowRuns.started_at)).limit(1);
  const a = (row?.output as { anchor?: ResearchAnchor } | null | undefined)?.anchor;
  return a && typeof a.name === "string" && typeof a.sport === "string" ? { name: a.name, sport: a.sport, team: a.team ?? null } : null;
}

export const utcMidnight = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export async function todaySpendMicroUsd(now: Date): Promise<number> {
  const [r] = await db.select({ m: sql<string>`coalesce(sum(${agentRuns.cost_micro_usd}),0)::text` }).from(agentRuns)
    .where(and(like(agentRuns.parent_ref, `${RESEARCH_REFRESH_PARENT}:%`), gte(agentRuns.started_at, utcMidnight(now))));
  return Number(r?.m ?? 0);
}
