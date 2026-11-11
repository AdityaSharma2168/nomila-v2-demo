/**
 * agent/plan/sources.ts — the plan's non-memory inputs, read from the database (input.ts PlanSources). Every query is
 * scoped to the athlete. Each source is read on its own; the input builder treats a failure as "none".
 *
 *   mia          the current M.I.A. read through the read-only preview seam (onboarding/miaPreview.ts): never computes
 *   connected    active connected_accounts rows for the onboarding connectors, with when each was last read
 *   openThreads  the deal pipeline's needs-you list (services/opportunityBoard), as T-keys
 *   preferences  active memory_preferences
 *   playbook     the shared playbook (agent/playbook/read.ts getPlaybookForAthlete) for the athlete's sport and stage, on
 *                each platform the athlete has an active social identity on (the same platform list the playbook's own
 *                roster keys are built from, agent/playbook/keys.ts)
 *   rates        (plan 1.5.0) the athlete's suggested rate ranges as stored (services/rates.ts loadRateRanges,
 *                athlete_rate_ranges): what a goal's money value is read from
 *   postingFormats (plan 1.5.0) the share of the athlete's own posts by format, per platform and window: the newest
 *                connected-account format_mix row (social_features, connected_verified, the current calculation)
 *   whatWorks    (plan 1.6.0) the athlete's "what works for you" (agent/learning/db.ts whatWorksIfOn): null while
 *                AGENT_LEARNING_LOOP is off
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts, socialFeatures, socialIdentities } from "../../../shared/schema";
import { listPreferences } from "../memory";
import { CONNECTORS } from "../onboarding/catalog";
import { getMiaPreview } from "../onboarding/miaPreview";
import type { PlanRate, PlanSources, PostingFormatMix } from "./input";
import type { OpenThread } from "./validate";

async function connected(athleteId: string): Promise<Array<{ id: string; lastReadAt: string | null }>> {
  const rows = await db.select({ platform: connectedAccounts.platform, last: connectedAccounts.last_fetched_at }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"), inArray(connectedAccounts.platform, CONNECTORS.map((c) => c.id))));
  const by = new Map<string, string | null>();
  for (const r of rows) {
    const at = r.last ? new Date(r.last).toISOString() : null;
    const cur = by.get(r.platform);
    if (cur === undefined || (at && (!cur || at > cur))) by.set(r.platform, at);
  }
  return [...by].map(([id, lastReadAt]) => ({ id, lastReadAt }));
}

async function openThreads(athleteId: string): Promise<OpenThread[]> {
  const { readOpportunityBoard } = await import("../../services/opportunityBoard");
  const board = await readOpportunityBoard(athleteId);
  return board.needsYou.map((it) => ({
    opportunityId: it.opportunity_id, threadId: it.lead_thread_id, brand: it.brand.name,
    line: [it.next?.label, it.line].filter(Boolean).join(" — ") || "Waiting on you", since: it.her_move_since ?? null,
  }));
}

async function playbook(athleteId: string): ReturnType<PlanSources["playbook"]> {
  const rows = await db.selectDistinct({ platform: socialIdentities.platform }).from(socialIdentities)
    .where(and(eq(socialIdentities.athlete_id, athleteId), eq(socialIdentities.status, "active")));
  if (!rows.length) return [];
  const { getPlaybookForAthlete } = await import("../playbook/read");
  return getPlaybookForAthlete(athleteId, rows.map((r) => r.platform).sort());
}

async function rates(athleteId: string): Promise<PlanRate[]> {
  const { loadRateRanges } = await import("../../services/rates");
  return [...(await loadRateRanges(athleteId)).values()].map((r) => ({
    rateType: r.rateType, low: r.low, high: r.high, currency: r.currency, confidence: r.confidence, drivers: r.drivers,
  }));
}

async function postingFormats(athleteId: string): Promise<PostingFormatMix[]> {
  const { FEATURE_CALCULATION_VERSION } = await import("../../services/intelligence/social/metrics");
  const rows = await db.select({ platform: socialFeatures.platform, window: socialFeatures.window_days, mix: socialFeatures.value_json })
    .from(socialFeatures).where(and(
      eq(socialFeatures.athlete_id, athleteId), eq(socialFeatures.feature_key, "format_mix"),
      eq(socialFeatures.source_class, "connected_verified"), eq(socialFeatures.calculation_version, FEATURE_CALCULATION_VERSION),
    )).orderBy(desc(socialFeatures.as_of)).limit(40);
  const out: PostingFormatMix[] = [];
  for (const r of rows) {
    if (!r.platform || !r.mix || typeof r.mix !== "object" || out.some((x) => x.platform === r.platform && x.windowDays === r.window)) continue;
    const mix = Object.fromEntries(Object.entries(r.mix as Record<string, unknown>).filter(([, v]) => typeof v === "number" && Number.isFinite(v)) as Array<[string, number]>);
    if (Object.keys(mix).length) out.push({ platform: r.platform, windowDays: r.window, mix });
  }
  return out;
}

async function whatWorks(athleteId: string): ReturnType<NonNullable<PlanSources["whatWorks"]>> {
  const { whatWorksIfOn } = await import("../learning/db");
  return whatWorksIfOn(athleteId);
}

export const dbPlanSources: PlanSources = {
  mia: (athleteId) => getMiaPreview(athleteId),
  connected,
  openThreads,
  preferences: (athleteId) => listPreferences(athleteId),
  playbook,
  rates,
  postingFormats,
  whatWorks,
};
