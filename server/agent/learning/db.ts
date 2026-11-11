/**
 * agent/learning/db.ts — the learning loop against Nomila's database: the real reads and writes behind job.ts, the
 * nightly entry (after the social sync) and the read the later plan / Understand / chat wiring uses.
 *
 *   runLearningLoopNightly(athleteIds)   called by collectAllAnalyticsSnapshots (skills/collectSocialAnalytics.ts) with
 *                                        the athletes it just collected, after their measured memory sync. Off unless
 *                                        AGENT_LEARNING_LOOP; only athletes on the new memory; never throws.
 *   whatWorksFor(athleteId)              the athlete's "what works for you" (core.ts WhatWorks), computed from the
 *                                        athlete's own rows.
 *   whatWorksIfOn(athleteId)             the same, only while AGENT_LEARNING_LOOP is on (else null), never throwing:
 *                                        what the plan, Understand and chat read under WHAT WORKS FOR THIS ATHLETE.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { chatMessages, mediaAssets, memoryFacts, pushDevices, socialMetricObservations } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { upsertConversationOnMessage } from "../../mila/conversations";
import { sendPush } from "../../services/push/push";
import { recordOutcome } from "../memory";
import { dbStore } from "../research/dbStore";
import { agentLearningLoopEnabled } from "./config";
import { METRIC_KEYS, type ContentObservation, type WhatWorks } from "./core";
import { runLearningLoop, whatWorksFrom, type LearningDeps } from "./job";

const logger = createLogger("agent/learning");

async function loadContentObservations(athleteId: string, since: Date): Promise<ContentObservation[]> {
  const rows = await db.select({
    athleteId: socialMetricObservations.athlete_id, platform: socialMetricObservations.platform, entityId: socialMetricObservations.entity_id,
    entityTime: socialMetricObservations.entity_time, entityFormat: socialMetricObservations.entity_format,
    metricKey: socialMetricObservations.metric_key, value: socialMetricObservations.value, observedAt: socialMetricObservations.observed_at,
    // The post's own link, from its library row (the athlete's own: the join is on both the asset and the athlete).
    permalink: mediaAssets.permalink,
  }).from(socialMetricObservations)
    .leftJoin(mediaAssets, and(eq(mediaAssets.id, socialMetricObservations.asset_id), eq(mediaAssets.athlete_id, socialMetricObservations.athlete_id)))
    .where(and(
    eq(socialMetricObservations.athlete_id, athleteId),
    eq(socialMetricObservations.entity_type, "content"),
    eq(socialMetricObservations.source_class, "connected_verified"),
    inArray(socialMetricObservations.metric_key, METRIC_KEYS),
    gte(socialMetricObservations.entity_time, since),
  ));
  return rows.map((r) => ({
    athleteId: r.athleteId, platform: r.platform, entityId: r.entityId, entityTime: r.entityTime ? r.entityTime.toISOString() : null,
    entityFormat: r.entityFormat ?? null, metricKey: r.metricKey, value: Number(r.value), observedAt: r.observedAt.toISOString(),
    permalink: r.permalink ?? null,
  }));
}

/** The athlete's phone time zone: the newest push device registration (POST /me/push/devices) that sent one. */
async function loadTimeZone(athleteId: string): Promise<string | null> {
  const [row] = await db.select({ tz: pushDevices.time_zone }).from(pushDevices)
    .where(and(eq(pushDevices.athlete_id, athleteId), isNotNull(pushDevices.time_zone)))
    .orderBy(desc(pushDevices.last_seen_at)).limit(1);
  return row?.tz ?? null;
}

export const dbLearningDeps: LearningDeps = {
  store: dbStore,
  loadContentObservations,
  loadTimeZone,
  recordOutcome: (athleteId, decisionId, outcome, note) => recordOutcome(athleteId, decisionId, outcome, note),
  announcer: {
    // The same path as Mila's other proactive suggestion (researchRefresh/proposal.ts dbAnnouncer): a new chat of the
    // athlete's with Mila's message in it, then one push of kind mila_suggestion (the athlete's switch, quiet hours and
    // the daily cap apply).
    async postMilaMessage(athleteId, title, text) {
      const conversationId = randomUUID();
      await upsertConversationOnMessage(athleteId, conversationId, title);
      await db.insert(chatMessages).values({ athlete_id: athleteId, role: "assistant", content: text, conversation_id: conversationId });
      return conversationId;
    },
    push: (athleteId, event) => sendPush(athleteId, event),
  },
  log: (msg, meta) => logger.info(meta, msg),
};

/** The athlete's "what works for you", from the athlete's own rows: the read the plan, Understand and chat wiring will use. */
export async function whatWorksFor(athleteId: string, now: Date = new Date()): Promise<WhatWorks> {
  return whatWorksFrom(dbLearningDeps, athleteId, now);
}

/**
 * What the plan, Understand and chat read (plan 1.6.0, understand 1.15.0, chat 1.2.0): the athlete's "what works for
 * you" while AGENT_LEARNING_LOOP is on, else null (their input then reads as before). Never throws: a failed read is null.
 */
export async function whatWorksIfOn(athleteId: string, now: Date = new Date()): Promise<WhatWorks | null> {
  if (!agentLearningLoopEnabled()) return null;
  try {
    return await whatWorksFor(athleteId, now);
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "what works: not read");
    return null;
  }
}

async function hasMemory(athleteId: string): Promise<boolean> {
  const [row] = await db.select({ id: memoryFacts.id }).from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId)).limit(1);
  return !!row;
}

/** The nightly pass over the athletes the social sync just collected. Off unless AGENT_LEARNING_LOOP. Never throws. */
export async function runLearningLoopNightly(athleteIds: Iterable<string>, deps: LearningDeps = dbLearningDeps): Promise<{ ran: number; failed: number }> {
  let ran = 0, failed = 0;
  if (!agentLearningLoopEnabled()) return { ran, failed };
  for (const athleteId of athleteIds) {
    try {
      if (!(await hasMemory(athleteId))) continue;
      const r = await runLearningLoop(athleteId, deps);
      if (r.ran) ran++;
    } catch (err: any) {
      failed++;
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "learning loop failed for an athlete");
    }
  }
  logger.info({ ran, failed }, "learning loop nightly pass complete");
  return { ran, failed };
}
