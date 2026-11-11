/**
 * research/lifecycleHooks.ts — the ONE way request handlers and profile writers reach governed identity resolution
 * (PR E2b; design record docs/architecture/phase-a/pr-e-identity-resolution-design.md §1.2 T1/T9, §5.4, D14).
 *
 * A deliberately light module (logger, db, config): call sites import it statically, and it loads research/lifecycle.ts
 * (the v3 stage, the planner's helpers) only when the boundary is open. Every function here is a NO-OP unless
 * identityResolutionEnabled(), never throws and never fails its caller.
 *
 *   enterLifecycleResearch   every signup / claim-link entry point (auth.ts, waitlist.ts, the claim confirmations)
 *                            converges here → startLifecycleResearch (T1 + the governed v3 run). Fire and forget: the
 *                            run is kicked inline, so a request handler must not await it.
 *   anchorFieldsBefore +     every production writer of the identity anchor's own fields (athletes.full_name, .sport)
 *   reenterOnAnchorEdit      snapshots them before its write and, after it, re-enters a changed name or sport through
 *                            reenterIdentityResolution: T9 for `resolved` (a resolved identity must not stay resolved
 *                            against an obsolete anchor), T7 for ambiguous / failed. An unchanged name and sport does
 *                            nothing. first_name is not part of the anchor (anchorHash reads full_name), so it never
 *                            re-enters on its own.
 *
 * Both are pinned by the exhaustiveness guards in lifecycleHooks.test.ts: a new entry point or anchor writer that is not
 * wired here fails CI.
 *
 * Legacy intelligence switch-off (12 Oct 2026): an AGENT-FRONT athlete (agentFrontAthlete.ts) is skipped by all three —
 * the agent's own onboarding researches her, so legacy lifecycle research would spend twice. Older athletes unchanged.
 */

import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { athletes } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { identityResolutionEnabled } from "./config";
import { normalizeText } from "./factRegistry";
import { isAgentFrontAthlete } from "../../agentFrontAthlete";

const logger = createLogger("research-lifecycle-hooks");

export type LifecycleEntryTrigger = "signup" | "claim";

/** Converge an entry point on startLifecycleResearch. Never rejects; a no-op unless the boundary is open. */
export function enterLifecycleResearch(athleteId: string, trigger: LifecycleEntryTrigger): Promise<void> {
  if (!identityResolutionEnabled()) return Promise.resolve();
  return isAgentFrontAthlete(athleteId)
    .then(async (agentFront) => {
      if (agentFront) { logger.info({ athleteId, trigger }, "lifecycle entry skipped: agent-front athlete (the agent researches her)"); return; }
      const { startLifecycleResearch } = await import("./lifecycle.js");
      const r = await startLifecycleResearch(athleteId, trigger);
      logger.info({ athleteId, trigger, result: r }, "lifecycle entry");
    })
    .catch((err: any) => { logger.error({ athleteId, trigger, error: err?.message }, "lifecycle research start failed"); });
}

/** The identity anchor's own fields as stored on the athlete row (what anchorHash reads as name and sport). */
export interface AnchorFields { fullName: string; sport: string }

/** Snapshot before an anchor-field write. null (and no read at all) unless the boundary is open. Never throws. */
export async function anchorFieldsBefore(athleteId: string): Promise<AnchorFields | null> {
  if (!identityResolutionEnabled()) return null;
  try { return (await isAgentFrontAthlete(athleteId)) ? null : await readAnchorFields(athleteId); }
  catch (err: any) { logger.error({ athleteId, error: err?.message }, "anchor snapshot failed"); return null; }
}

async function readAnchorFields(athleteId: string): Promise<AnchorFields | null> {
  const [a] = await db.select({ fullName: athletes.full_name, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  return a ? { fullName: a.fullName, sport: a.sport ?? "" } : null;
}

/**
 * After the write: a changed name or sport (normalizeText, as anchorHash compares them) re-enters through
 * reenterIdentityResolution (T9 from resolved, T7 from ambiguous / failed). Nothing changed, or no snapshot (boundary
 * closed) ⇒ nothing. Never throws.
 */
export async function reenterOnAnchorEdit(athleteId: string, before: AnchorFields | null): Promise<void> {
  if (!before || !identityResolutionEnabled()) return;
  try {
    const after = await readAnchorFields(athleteId);
    if (!after) return;
    const changed = normalizeText(after.fullName) !== normalizeText(before.fullName) || normalizeText(after.sport) !== normalizeText(before.sport);
    if (!changed) return;
    const { reenterIdentityResolution } = await import("./lifecycle.js");
    const r = await reenterIdentityResolution(athleteId, { trigger: "anchor_changed", nameOrSportChanged: true });
    logger.info({ athleteId, result: r }, "anchor edit: identity re-entry");
  } catch (err: any) {
    logger.error({ athleteId, error: err?.message }, "anchor edit re-entry failed");
  }
}
