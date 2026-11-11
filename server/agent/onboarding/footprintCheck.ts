/**
 * agent/onboarding/footprintCheck.ts — the "real athlete?" check in front of the full sign-up research (anti-fake plan,
 * owner, 24 Oct 2026; ATHLETE_FOOTPRINT_CHECK, exactly "true" turns it on).
 *
 * Before signup_research starts for a waitlisted athlete, ONE cheap structured call with ONE web search (skill
 * onboarding/athlete-footprint, model tier `fast` = OpenAI by the provider rule: all web search is OpenAI; listed in the
 * Prompt Register) asks whether a public footprint exists of an athlete with this name + sport (+ team, + a connected
 * Instagram with posts). Its answer: { found, confidence, evidence_url, reason }.
 *
 *   found          the full research starts exactly as before (startSignupAgentResearch); a stale
 *                  no_athlete_footprint flag is cleared
 *   not found      no full research. She still joins the waitlist (never refused). Her row gets the admin flag
 *                  no_athlete_footprint { at, reason, confidence, key } (lib/signupFlags.ts), and GET /waitlist/progress
 *                  answers research.state "needs_more" with the reason (needsMoreFrom). Adding a team (POST /waitlist)
 *                  or connecting a real Instagram account with posts (oauthCallback → recheckAfterInstagram) re-runs
 *                  the check with the new input, then the full research when found.
 *   error          treated as FOUND (fail open for real people; the daily cap still bounds the research spend)
 *   cap spent      today's sign-up spend already at DAILY_RESEARCH_CAP_USD ⇒ no check (it would spend past the cap);
 *                  the research starts held under the cap as before, so a fake costs nothing today either
 *
 * Cost: one fast-tier call with one search (about $0.01 for the search plus well under a cent of tokens; ≤ $0.05). It
 * runs through runSkill, so it is an agent_runs row with its cost, and dailyCap.ts counts FOOTPRINT_SKILL_ID runs as
 * sign-up spend for every athlete (also when no research run follows). The same inputs never pay twice: the run's
 * parentRef is a hash of the inputs, and runSkill returns a finished run with the same parentRef as is.
 */
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes, connectedAccounts } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { dbStore } from "../research/dbStore";
import { runSkill } from "../research/runSkill";
import { clearSignupFlag, setSignupFlags } from "../../lib/signupFlags";
import { dailyResearchCapMicroUsd, FOOTPRINT_SKILL_ID, signupSpendTodayMicroUsd, SIGNUP_RESEARCH_PROCESS } from "./dailyCap";
import { latestRunOf, researchableName, startSignupAgentResearch } from "./signupResearch";
import { readLegacyRow } from "../../services/intelligence/context/legacyAdapter";

const logger = createLogger("agent/onboarding/footprint");

export { FOOTPRINT_SKILL_ID } from "./dailyCap";
export const athleteFootprintCheckEnabled = (): boolean => process.env.ATHLETE_FOOTPRINT_CHECK === "true";

export interface FootprintInputs {
  athlete_name: string;
  sport: string;
  team: string | null;
  instagram: { handle: string | null; posts: number } | null;
}
export interface FootprintAnswer {
  found: boolean;
  confidence: "high" | "medium" | "low";
  evidence_url: string | null;
  reason: string;
  /** Why no model answer was used: "error" (fail open) or "cap" (today's budget spent). */
  skipped?: "error" | "cap";
}

export const FOOTPRINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "confidence", "evidence_url", "reason"],
  properties: {
    found: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence_url: { type: ["string", "null"] },
    reason: { type: "string" },
  },
};

/** A stable short hash of the inputs: the check's parentRef (same inputs ⇒ the finished run is reused) and the flag's key. */
export function inputsKey(i: FootprintInputs): string {
  const norm = { n: i.athlete_name.trim().toLowerCase(), s: i.sport.trim().toLowerCase(), t: i.team?.trim().toLowerCase() || null, ig: i.instagram ? (i.instagram.handle ?? "").toLowerCase() : null };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 24);
}

/** Pure: the model's JSON as a FootprintAnswer; anything unreadable is found (fail open). */
export function readAnswer(json: unknown): FootprintAnswer {
  const j = (json ?? {}) as Record<string, unknown>;
  if (typeof j.found !== "boolean") return { found: true, confidence: "low", evidence_url: null, reason: "The check gave no clear answer.", skipped: "error" };
  const confidence = j.confidence === "high" || j.confidence === "medium" || j.confidence === "low" ? j.confidence : "low";
  const url = typeof j.evidence_url === "string" && /^https?:\/\//i.test(j.evidence_url) && j.evidence_url.length <= 2048 ? j.evidence_url : null;
  const reason = typeof j.reason === "string" ? j.reason.trim().slice(0, 300) : "";
  return { found: j.found, confidence, evidence_url: url, reason };
}

/** The check itself. Never throws: an error is found; a spent daily cap skips the call (found, so research queues held). */
export async function checkFootprint(athleteId: string, inputs: FootprintInputs): Promise<FootprintAnswer> {
  try {
    const cap = dailyResearchCapMicroUsd();
    if (cap !== null && (await signupSpendTodayMicroUsd()).total >= cap) {
      logger.info({ athleteId }, "footprint check skipped: today's sign-up budget is spent (the research waits under the cap)");
      return { found: true, confidence: "low", evidence_url: null, reason: "Not checked: today's budget is spent.", skipped: "cap" };
    }
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "footprint budget read failed (checking anyway)");
  }
  try {
    const r = await runSkill({
      store: dbStore, athleteId, skillId: FOOTPRINT_SKILL_ID, trigger: "event", parentRef: `footprint:${inputsKey(inputs)}`,
      input: JSON.stringify(inputs), schemaName: "athlete_footprint", schema: FOOTPRINT_SCHEMA as any,
      webSearch: { maxCalls: 1, contextSize: "low" }, maxOutputTokens: 600,
    });
    const answer = readAnswer(r.json);
    logger.info({ athleteId, found: answer.found, confidence: answer.confidence, reused: r.reused, costMicroUsd: r.cost?.microUsd ?? 0 }, "footprint check");
    return answer;
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "footprint check failed: treated as found (fail open)");
    return { found: true, confidence: "low", evidence_url: null, reason: "The check could not run.", skipped: "error" };
  }
}

/** Her active Instagram connection with a post count (one Graph call), or null. */
async function instagramOf(athleteId: string): Promise<FootprintInputs["instagram"]> {
  const [ig] = await db.select({ id: connectedAccounts.id, username: connectedAccounts.platform_username }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.platform, "instagram"), eq(connectedAccounts.status, "active")))
    .orderBy(desc(connectedAccounts.connected_at)).limit(1);
  if (!ig) return null;
  const { fetchInstagramProfileCounts } = await import("../../lib/integrations/instagram");
  const counts = await fetchInstagramProfileCounts(ig.id).catch(() => null);
  const posts = counts?.mediaCount ?? 0;
  // Only a real account with posts is evidence; an empty one adds nothing to the check.
  return posts > 0 ? { handle: counts?.username ?? ig.username ?? null, posts } : null;
}

/** What the check would be asked for this athlete now, or null when there is no name or sport to search for yet. */
export async function footprintInputsOf(athleteId: string): Promise<FootprintInputs | null> {
  const [a] = await db.select({ full_name: athletes.full_name, email: athletes.email, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const name = a ? researchableName(a.full_name, a.email) : null;
  if (!a || !name || !a.sport?.trim()) return null;
  // The team she typed lives in the school projection column: read through its one sanctioned reader (sourceGuard G5).
  const team = ((await readLegacyRow(athleteId))?.school ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  return { athlete_name: name, sport: a.sport.trim(), team, instagram: await instagramOf(athleteId) };
}

type StartResult = Awaited<ReturnType<typeof startSignupAgentResearch>> | { started: false; reason: "no_footprint" };

/**
 * The waitlist's research start with the check in front (flag off ⇒ exactly startSignupAgentResearch). An athlete who
 * already has a signup_research run is never checked again (that start is idempotent).
 */
export async function startSignupResearchChecked(athleteId: string, opts: { createdBy: string }): Promise<StartResult> {
  if (!athleteFootprintCheckEnabled()) return startSignupAgentResearch(athleteId, opts);
  if (await latestRunOf(athleteId, SIGNUP_RESEARCH_PROCESS)) return startSignupAgentResearch(athleteId, opts);
  const inputs = await footprintInputsOf(athleteId);
  if (!inputs) return startSignupAgentResearch(athleteId, opts);   // it refuses with its own reason (no name / no sport)
  const answer = await checkFootprint(athleteId, inputs);
  if (!answer.found) {
    await setSignupFlags(athleteId, { no_athlete_footprint: { at: new Date().toISOString(), reason: answer.reason, confidence: answer.confidence, key: inputsKey(inputs) } });
    logger.info({ athleteId }, "no public footprint found: full research held until she adds a team or connects Instagram");
    return { started: false, reason: "no_footprint" };
  }
  await clearSignupFlag(athleteId, "no_athlete_footprint").catch(() => undefined);
  return startSignupAgentResearch(athleteId, opts);
}

/**
 * After an Instagram connect (oauthCallback): a waitlisted athlete the check held re-runs it with the account, then the
 * full research when found. Anyone else: nothing. Never throws.
 */
export async function recheckAfterInstagram(athleteId: string): Promise<void> {
  try {
    if (!athleteFootprintCheckEnabled()) return;
    const [a] = await db.select({ status: athletes.status, flags: athletes.signup_flags }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    if (!a || a.status !== "waitlisted" || !(a.flags && typeof a.flags === "object" && "no_athlete_footprint" in (a.flags as object))) return;
    const r = await startSignupResearchChecked(athleteId, { createdBy: "signup" });
    logger.info({ athleteId, started: r.started, reason: r.started ? undefined : r.reason }, "footprint re-check after Instagram connect");
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "footprint re-check after Instagram failed");
  }
}

/** For GET /waitlist/progress: the held state and its reason, or null when the check is not holding her research. */
export function needsMoreFrom(flags: unknown, researchState: string): { reason: string } | null {
  if (!athleteFootprintCheckEnabled() || researchState !== "not_started") return null;
  const f = flags && typeof flags === "object" ? (flags as Record<string, any>).no_athlete_footprint : null;
  if (!f) return null;
  return { reason: typeof f.reason === "string" && f.reason ? f.reason : "We couldn't find you online yet." };
}
