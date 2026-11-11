/**
 * agent/moments/triggers.ts — what starts a weekly moments scan, and the guards on it.
 *
 *   weekly   the daily cron (POST /api/internal/moments-scan-cron, 12:00 UTC: before the post-ideas pass at 13:00 and
 *            the plan sweep at 14:00, so a fresh moment is in the store before either reads it) ENQUEUES a scheduled scan for every athlete with a
 *            current Brief and no moments scan in the last 7 days. It starts runs with kick: false — the cron request
 *            never runs a scan itself; the every-minute workflow tick does — and idempotency key
 *            "moments:<athlete>:<day>", so a re-sent cron the same day starts nothing new.
 *   onboarding  the agent onboarding runs its own first scan as a workflow step (onboarding/workflow.ts), not here.
 *
 * Guards: off unless AGENT_MOMENTS; nothing without a current Brief; one scan in flight per athlete (the runner: a
 * request while one is active JOINS it); at most one scan per athlete per 7 days. A failed run does not count, and nor
 * does one stuck "running" for more than 2 hours (its process crashed: it will never finish). The scan itself also
 * skips when a cost cap would be passed (scan.ts). Never throws: a trigger is fire-and-forget for its caller.
 */
import { and, eq, sql } from "drizzle-orm";
import { createLogger } from "../../logger";
import type { AgentStore, StoredRun } from "../research/store";
import { agentMomentsEnabled, MOMENTS, MOMENTS_PROCESS, MOMENTS_SKILL_ID } from "./config";
import type { MomentsScanInput } from "./workflow";
import { enabledChoiceSql, jobGate } from "../welcome/gate";

const logger = createLogger("agent/moments/triggers");
const DAY = 86_400_000;
/** A run still "running" this long after it started crashed: it never finishes and never counts. */
export const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;

/** A moments run that counts against the weekly limit: finished, or still plausibly running. */
export const countsAsScan = (r: Pick<StoredRun, "status" | "startedAt">, now: Date): boolean =>
  r.status !== "failed" && !(r.status === "running" && now.getTime() - Date.parse(r.startedAt) > STALE_RUNNING_MS);

export interface MomentsTriggerRequest {
  reason: string;
  /** Default "moments:<athlete>:<day>": one scheduled scan per athlete per day, whoever asks. */
  idempotencyKey?: string;
  now?: Date;
}

export type MomentsScanStart =
  | { started: true; runId: string; joined: boolean }
  | { started: false; reason: "off" | "no_brief" | "weekly_cap" | "error" };

/** Starting a run (injectable for tests). */
export type MomentsRunStarter = (opts: { process: string; athleteId: string; input: MomentsScanInput; createdBy: string; idempotencyKey: string; kick: false }) => Promise<{ runId: string; created: boolean }>;

const defaultStarter: MomentsRunStarter = async (o) => {
  await import("./workflow"); // registers moments_scan (a no-op once the server has loaded every definition)
  const { startRun } = await import("../../workflow/runner");
  const { run, created } = await startRun({ process: o.process, athleteId: o.athleteId, input: o.input, createdBy: o.createdBy, idempotencyKey: o.idempotencyKey, kick: o.kick });
  return { runId: run.id, created };
};

async function storeOf(store?: AgentStore): Promise<AgentStore> {
  return store ?? (await import("../research/dbStore")).dbStore;
}

export async function requestMomentsScan(athleteId: string, req: MomentsTriggerRequest, deps: { store?: AgentStore; start?: MomentsRunStarter } = {}): Promise<MomentsScanStart> {
  if (!agentMomentsEnabled()) return { started: false, reason: "off" };
  try {
    const store = await storeOf(deps.store);
    const now = req.now ?? new Date();
    if (!(await store.currentBrief(athleteId))) return { started: false, reason: "no_brief" };
    const runs = await store.listRunsSince(athleteId, { since: new Date(now.getTime() - MOMENTS.SCAN_EVERY_DAYS * DAY).toISOString(), skillId: MOMENTS_SKILL_ID });
    if (runs.some((r) => countsAsScan(r, now))) return { started: false, reason: "weekly_cap" };

    const input: MomentsScanInput = { trigger: "schedule", reason: req.reason.slice(0, 200) };
    const idempotencyKey = req.idempotencyKey ?? `moments:${athleteId}:${now.toISOString().slice(0, 10)}`;
    // Enqueue only (kick: false): the workflow tick runs the scan, never the request that asked for it.
    const r = await (deps.start ?? defaultStarter)({ process: MOMENTS_PROCESS, athleteId, input, createdBy: "moments:schedule", idempotencyKey, kick: false });
    logger.info({ athleteId, reason: req.reason, runId: r.runId, joined: !r.created }, "moments scan enqueued");
    return { started: true, runId: r.runId, joined: !r.created };
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "moments scan request failed");
    return { started: false, reason: "error" };
  }
}

/**
 * The daily sweep (POST /api/internal/moments-scan-cron): for every athlete with a current Brief, ENQUEUE a scheduled
 * scan when none ran in the last 7 days (the tick runs it). Batched (`limit` athletes per call, the longest-unscanned
 * first). Returns what it enqueued.
 */
export async function sweepMomentsScan(opts: { now?: Date; limit?: number; start?: MomentsRunStarter; store?: AgentStore } = {}): Promise<{ checked: number; started: number; skipped: Record<string, number> }> {
  const out = { checked: 0, started: 0, skipped: {} as Record<string, number> };
  if (!agentMomentsEnabled()) return out;
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS).toISOString();
  const { db } = await import("../../db");
  const { memoryBriefs } = await import("../../../shared/schema");
  const rows = await db.select({
    athleteId: memoryBriefs.athlete_id,
    lastScan: sql<string | null>`(SELECT max(r.started_at)::text FROM agent_runs r WHERE r.athlete_id = memory_briefs.athlete_id AND r.skill_id = ${MOMENTS_SKILL_ID}
      AND r.status <> 'failed' AND NOT (r.status = 'running' AND r.started_at < ${staleBefore}::timestamptz))`,
  }).from(memoryBriefs).where(and(eq(memoryBriefs.status, "current"),
    // MILA_WELCOME: the weekly scan is optional — only athletes who said yes (no-op SQL while the flag is off).
    enabledChoiceSql(memoryBriefs.athlete_id, "moments_scan")))
    .orderBy(sql`2 ASC NULLS FIRST`).limit(Math.max(1, Math.min(opts.limit ?? 200, 1000)));

  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };
  const weekAgo = now.getTime() - MOMENTS.SCAN_EVERY_DAYS * DAY;
  const chose = jobGate("moments_scan");
  for (const r of rows) {
    out.checked++;
    if (r.lastScan && Date.parse(r.lastScan) >= weekAgo) { skip("recent"); continue; }
    if (!(await chose(r.athleteId))) { skip("not_chosen"); continue; }
    const s = await requestMomentsScan(r.athleteId, { reason: "weekly moments scan", now }, { start: opts.start, store: opts.store });
    if (s.started) out.started++; else skip(s.reason);
  }
  logger.info({ ...out, today: now.toISOString().slice(0, 10) }, "moments scan sweep");
  return out;
}
