/**
 * research/lifecycle.ts — how an athlete ENTERS and RE-ENTERS governed identity resolution (PR E2b; design record
 * docs/architecture/phase-a/pr-e-identity-resolution-design.md §1.2 T1/T7/T9, §5.4, D14, D18).
 *
 *   startLifecycleResearch   T1 (NULL → pending, trigger signup | claim), then the research_refresh v3 run directly
 *                            (all six queries + the signals lane, governIdentity: true) under the planner's own key
 *                            research_refresh:<athlete>:<UTC day>, so a same-day planner pass or a retry returns the
 *                            same run. Reached only through lifecycleHooks.enterLifecycleResearch, from every signup /
 *                            claim-link entry point (auth.ts, waitlist.ts, the claim confirmations; pinned by the
 *                            exhaustiveness guard); never awaited, never fatal. Waits (writes nothing) until a sport.
 *   adminResolveIdentity     the deliberate operator act (how Mia and the wanted testers are entered): T1 (trigger
 *                            admin) from NULL, T7 (trigger admin) from ambiguous | failed, then a Q1-only governed run.
 *                            With `allowWithoutAccount` (the admin route's explicit `promoteWithoutAccount`) it may also
 *                            enter a public athlete who has NO Nomila account: the design record's "deliberately
 *                            promoted" clause (§1.1, §2.3), so a public athlete can be researched before she is a user.
 *                            Only this explicit operator act does that; lifecycle entry still requires a self membership.
 *   adminRunResearch         the dev/admin seam: a governed v3 run for an athlete ALREADY in governed resolution (the
 *                            full plan Q1–Q6 + signals, or chosen domains) on demand, under its own idempotency key
 *                            (adminRunKey), so it never collides with the same UTC day's Q1 run. The identity gate still
 *                            applies inside the run: Q2–Q6 run only once identity is resolved.
 *   reenterIdentityResolution  T7 (ambiguous | failed → pending) on an anchor change or the identity TTL, and T9
 *                            (resolved → pending) on a name or sport change. The planner calls it for anchor_changed /
 *                            ttl at enqueue; every production name / sport writer calls it through
 *                            lifecycleHooks.reenterOnAnchorEdit. It starts no run itself (the planner's admission and
 *                            budget decide that).
 *
 * Every write goes through applyIdentityTransition (the ONE writer of the two columns, compare-and-set); this module is
 * on its importer allow-list by the design record §5.8 ("the v3 Q1 step, lifecycle.ts and the confirmation service").
 *
 * Boundaries:
 *   - Everything is a NO-OP unless identityResolutionEnabled() (the one execution gate AND binding = direct): no read
 *     beyond the flag, no write, no run. With it false, today's behaviour is unchanged.
 *   - Only an athlete with an active SELF membership is ever entered. Seeded and calibration rows have none, so they are
 *     never entered and stay NULL (§1.1, §2.3). The membership only ADMITS her to resolution; it never resolves anything.
 *   - The identity anchor is built exactly as the v3 stage builds it (v3Stage.athleteContext): name + sport + known
 *     handles. Its team is always null (no caller hands searchInputsFor a team), so a new affiliation does not re-enter on
 *     its own (lifecycle.test.ts pins it). lifecycle.test.ts pins the two hashes equal.
 */

import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { athletes, athleteResearchState } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { searchInputsFor } from "../context/searchInputs";
import { selfMembershipFor } from "../identity/users";
import { getResearchPolicy, identityResolutionEnabled } from "./config";
import { anchorHash, applyIdentityTransition, readIdentityState, type ApplyResult, type IdentityAnchor, type IdentityState, type IdentityValue } from "./identityResolution";
import { v3PlanBudget } from "./plans";
import { buildSearchName, knownHandlesFor } from "./refresh";
import type { ResearchDomain } from "./registries";
import { QUERY_IDS } from "./spec/researchSpecV1";
import { resolveV3Plan, type V3RunInput } from "./v3Stage";

const logger = createLogger("research-lifecycle");

export type LifecycleTrigger = "signup" | "claim";

/** The idempotency key the planner uses (planner.ts): one research_refresh run per athlete per UTC day. */
export const researchRunKey = (athleteId: string, asOf: Date): string => `research_refresh:${athleteId}:${asOf.toISOString().slice(0, 10)}`;

/** The identity anchor as the v3 stage reads it (v3Stage.athleteContext, byte for byte), or null when the athlete is gone. */
export async function currentIdentityAnchor(athleteId: string): Promise<IdentityAnchor | null> {
  const [a] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return null;
  const inputs = await searchInputsFor(a.id, { anchor: buildSearchName(a), handles: await knownHandlesFor(a.id, a.socials) });
  return { fullName: a.full_name, sport: a.sport ?? "", team: inputs.currentTeam, handles: inputs.handles };
}

/**
 * Admission to governed resolution: the athlete exists and has an active self membership (seeded/calibration rows never
 * do). `allowWithoutAccount` is ONLY ever passed by the explicit admin act (adminResolveIdentity): a deliberately
 * promoted public athlete with no account is admitted with selfUserId null. Lifecycle entry never passes it.
 */
async function admit(athleteId: string, opts: { allowWithoutAccount?: boolean } = {}): Promise<{ ok: true; selfUserId: string | null; hasSport: boolean } | { ok: false; reason: "no_athlete" | "no_self_membership" }> {
  const [a] = await db.select({ id: athletes.id, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return { ok: false, reason: "no_athlete" };
  const m = await selfMembershipFor(athleteId);
  if (m) return { ok: true, selfUserId: m.userId, hasSport: !!a.sport?.trim() };
  return opts.allowWithoutAccount === true ? { ok: true, selfUserId: null, hasSport: !!a.sport?.trim() } : { ok: false, reason: "no_self_membership" };
}

/** The compare-and-set needs a row: create the state row exactly as requestRefresh / the gate hold do (never touches identity). */
async function ensureStateRow(athleteId: string): Promise<IdentityState> {
  await db.insert(athleteResearchState).values({ athlete_id: athleteId, research_status: "seed_only" }).onConflictDoNothing();
  return (await readIdentityState(athleteId)) ?? { value: null, detail: null };
}

const summarize = (r: ApplyResult): Record<string, unknown> => (r.written ? { written: true, transition: r.transition, from: r.from, to: r.to } : { ...r });

/**
 * Start the governed research_refresh v3 run with the ledger reservation the planner would record. Key: the planner's
 * day key unless the caller names another (the admin seams do, so they never collide with that day's run). A run that
 * comes back with a DIFFERENT key is the athlete's one active research_refresh run (the runner's active scope), not ours.
 */
async function startGovernedRun(athleteId: string, input: V3RunInput, createdBy: string, asOf: Date, opts: { idempotencyKey?: string; kick?: boolean; signup?: boolean } = {}): Promise<{ workflowRunId: string; created: boolean; idempotencyKey: string; joinedOtherRun: boolean; runStatus: string }> {
  const policy = await getResearchPolicy();
  const plan = resolveV3Plan(input);
  const b = v3PlanBudget(plan, policy);
  const idempotencyKey = opts.idempotencyKey ?? researchRunKey(athleteId, asOf);
  const start = { process: "research_refresh" as const, version: 3, athleteId, createdBy, idempotencyKey, kick: opts.kick, input: { ...input, reserveCalls: b.reserveCalls, estUsd: b.estUsd, policyVersion: policy.version ?? "defaults" } };
  // A sign-up / claim lifecycle entry is sign-up research: through the one chokepoint, under the daily cap (held when
  // over budget, released by the minute tick). The operator acts below are not sign-ups and start as before.
  let r: { run: { id: string; idempotency_key: string | null; status: string }; created: boolean };
  if (opts.signup) {
    const { startSignupResearchRun } = await import("../../../agent/onboarding/signupResearch");
    r = await startSignupResearchRun(start, { capped: true });
  } else {
    const { startRun } = await import("../../../workflow/runner");
    r = await startRun(start);
  }
  return { workflowRunId: r.run.id, created: r.created, idempotencyKey, joinedOtherRun: r.run.idempotency_key !== idempotencyKey, runStatus: r.run.status };
}

export type EntryResult =
  | { started: true; transition: string | null; workflowRunId: string; created: boolean }
  | { started: false; reason: "disabled" | "no_athlete" | "no_self_membership" | "no_sport" | "already_governed" | "resolved_sticky" | "transition_refused"; value?: IdentityValue; detail?: unknown };

/**
 * T1 from NULL (or nothing, when she is already `pending` — a retried signup), then the full governed v3 run. Any other
 * value means she is already governed: re-entry is T7/T9, never a second T1, and no run is started here.
 */
export async function startLifecycleResearch(athleteId: string, trigger: LifecycleTrigger, opts: { asOf?: Date } = {}): Promise<EntryResult> {
  if (!identityResolutionEnabled()) return { started: false, reason: "disabled" };
  const asOf = opts.asOf ?? new Date();
  const adm = await admit(athleteId);
  if (!adm.ok) { logger.info({ athleteId, trigger, reason: adm.reason }, "lifecycle research: not entered"); return { started: false, reason: adm.reason }; }
  // Q1 anchors name + sport: without a sport there is nothing to resolve yet. Nothing is written; the entry point that
  // later supplies the sport (the onboarding guard, e.g. the waitlist step that posts it) enters her then.
  if (!adm.hasSport) return { started: false, reason: "no_sport" };
  const current = await ensureStateRow(athleteId);
  let transition: string | null = null;
  if (current.value === null) {
    const anchor = await currentIdentityAnchor(athleteId);
    if (!anchor) return { started: false, reason: "no_athlete" };
    const r = await applyIdentityTransition(athleteId, current, { kind: "enter", trigger, by: adm.selfUserId, anchorHash: anchorHash(anchor) }, { at: asOf });
    if (r.written) transition = r.transition;
    else if (!(r.reason === "cas_lost" && r.observed === "pending")) return { started: false, reason: "transition_refused", detail: summarize(r) };
  } else if (current.value !== "pending") {
    return { started: false, reason: "already_governed", value: current.value };
  }
  const { workflowRunId, created } = await startGovernedRun(athleteId, { queries: [...QUERY_IDS], signals: true, trigger: "signup", reason: `lifecycle:${trigger}`, governIdentity: true }, `lifecycle_${trigger}`, asOf, { signup: true });
  logger.info({ athleteId, trigger, transition, workflowRunId, created }, "lifecycle research started");
  return { started: true, transition, workflowRunId, created };
}

/**
 * The idempotency key of an explicit admin act (dev/admin seams). Distinct from the planner's / lifecycle's day key
 * (researchRunKey), so an admin full run on the same UTC day as her Q1 run is a NEW run instead of the Q1-only one coming
 * back. Deterministic per (athlete, UTC day, act, scope[, label]): a repeated identical request returns the same run (no
 * double spend); `label` is the operator's explicit "run it again today".
 */
export const adminRunKey = (athleteId: string, asOf: Date, act: "resolve" | "research", scope: string, label?: string | null): string =>
  `${researchRunKey(athleteId, asOf)}:admin_${act}:${scope}${label ? `:${label}` : ""}`;

export type AdminResolveResult = EntryResult & { idempotencyKey?: string; joinedOtherRun?: boolean; runStatus?: string; account?: boolean };

/**
 * The deliberate admin act: T1 (trigger admin) from NULL, T7 (trigger admin) from ambiguous | failed, nothing from
 * pending; then a Q1-only governed run (identity first — the held and due domains follow through the planner once she
 * resolves, D18). `resolved` is sticky (D7): an admin cannot re-open it (T9 is a name/sport change only).
 *
 * Options (all off by default, so every existing caller behaves exactly as before):
 *   allowWithoutAccount  admit an athlete with no self membership (a deliberately promoted public athlete). The T1
 *                        provenance records the operator as `by`, as for any admin entry.
 *   perEpisodeKey        key the Q1 run by the pending EPISODE (the `at` of the pending entry in force) instead of the day
 *                        key, so a re-resolve after an ambiguous / failed result on the same UTC day (T7: a new episode)
 *                        really runs Q1 again, while a double submit within one episode returns the one run.
 *   label                appended to that key: the operator's explicit retry within one episode (e.g. after a T5).
 *   requireSport         refuse (no_sport) when the athlete has no sport: Q1 anchors name + sport.
 */
export async function adminResolveIdentity(athleteId: string, opts: { by: string; asOf?: Date; allowWithoutAccount?: boolean; perEpisodeKey?: boolean; label?: string | null; requireSport?: boolean }): Promise<AdminResolveResult> {
  if (!identityResolutionEnabled()) return { started: false, reason: "disabled" };
  const asOf = opts.asOf ?? new Date();
  const adm = await admit(athleteId, { allowWithoutAccount: opts.allowWithoutAccount });
  if (!adm.ok) return { started: false, reason: adm.reason };
  if (opts.requireSport && !adm.hasSport) return { started: false, reason: "no_sport" };
  const current = await ensureStateRow(athleteId);
  if (current.value === "resolved") return { started: false, reason: "resolved_sticky", value: current.value };
  let transition: string | null = null;
  let pendingAt = (current.detail as { at?: string } | null)?.at ?? asOf.toISOString();
  if (current.value !== "pending") {
    const anchor = await currentIdentityAnchor(athleteId);
    if (!anchor) return { started: false, reason: "no_athlete" };
    const hash = anchorHash(anchor);
    const r = current.value === null
      ? await applyIdentityTransition(athleteId, current, { kind: "enter", trigger: "admin", by: opts.by, anchorHash: hash }, { at: asOf })
      : await applyIdentityTransition(athleteId, current, { kind: "reenter", trigger: "admin", anchorHash: hash, nameOrSportChanged: false }, { at: asOf });
    if (!r.written) return { started: false, reason: "transition_refused", detail: summarize(r) };
    transition = r.transition;
    pendingAt = (r.detail as { at: string }).at;
  }
  const domains: ResearchDomain[] = ["identity"];
  const idempotencyKey = opts.perEpisodeKey ? adminRunKey(athleteId, asOf, "resolve", String(Date.parse(pendingAt)), opts.label) : undefined;
  const run = await startGovernedRun(athleteId, { domains, trigger: "manual", reason: "admin:resolve_identity", governIdentity: true }, "admin", asOf, { idempotencyKey });
  logger.info({ athleteId, by: opts.by, account: adm.selfUserId !== null, transition, ...run }, "admin resolve identity");
  if (!opts.perEpisodeKey) return { started: true, transition, workflowRunId: run.workflowRunId, created: run.created };
  return { started: true, transition, ...run, account: adm.selfUserId !== null };
}

export type AdminResearchResult =
  | { started: true; workflowRunId: string; created: boolean; idempotencyKey: string; plan: { queries: string[]; signals: boolean; domains: ResearchDomain[] }; identity: IdentityValue; runStatus: string }
  | { started: false; reason: "disabled" | "no_athlete" | "no_sport" | "identity_not_entered" | "identity_not_resolved" | "run_in_flight"; value?: IdentityValue; workflowRunId?: string };

/**
 * The dev/admin seam: run governed research_refresh v3 for one athlete on demand — the FULL plan (Q1–Q6 + signals, the
 * lifecycle run's shape) or the queries of chosen domains — under adminRunKey, never the day key.
 *
 * The identity gate is never bypassed:
 *   NULL / no row         refused (identity_not_entered): entry is adminResolveIdentity's job (or a lifecycle event).
 *   ambiguous / failed    refused (identity_not_resolved): a Q1 determination cannot apply from them, and Q2–Q6 would
 *                         only be held. Settle it first (her confirmation, or an admin re-resolve).
 *   pending               only a plan that includes Q1: Q1 runs first and Q2–Q6 read its determination fresh. A pending
 *                         plan without Q1 is refused (identity_not_resolved).
 *   resolved              the plan runs (Q1 again in a full plan: T10 or a sticky no-op).
 * Admission asks for no account: she is already governed (entered by a lifecycle event or the admin act).
 * kick:false (the default) leaves execution to the service's workflow tick; true runs it inline.
 */
export async function adminRunResearch(athleteId: string, opts: { by: string; domains?: ResearchDomain[] | null; asOf?: Date; kick?: boolean; label?: string | null }): Promise<AdminResearchResult> {
  if (!identityResolutionEnabled()) return { started: false, reason: "disabled" };
  const asOf = opts.asOf ?? new Date();
  const [a] = await db.select({ id: athletes.id, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return { started: false, reason: "no_athlete" };
  if (!a.sport?.trim()) return { started: false, reason: "no_sport" };
  const value = (await readIdentityState(athleteId))?.value ?? null;
  if (value === null) return { started: false, reason: "identity_not_entered", value };
  if (value === "ambiguous" || value === "failed") return { started: false, reason: "identity_not_resolved", value };
  const full = !opts.domains?.length;
  const input: V3RunInput = full
    ? { queries: [...QUERY_IDS], signals: true, trigger: "manual", reason: "admin:research_full", governIdentity: true }
    : { domains: [...opts.domains!], trigger: "manual", reason: "admin:research_domains", governIdentity: true };
  const plan = resolveV3Plan(input);
  if (value === "pending" && !plan.queries.includes("Q1")) return { started: false, reason: "identity_not_resolved", value };
  const scope = full ? "full" : [...plan.domains].sort().join("+");
  const run = await startGovernedRun(athleteId, input, "admin", asOf, { idempotencyKey: adminRunKey(athleteId, asOf, "research", scope, opts.label), kick: opts.kick ?? false });
  if (run.joinedOtherRun) return { started: false, reason: "run_in_flight", value, workflowRunId: run.workflowRunId };
  logger.info({ athleteId, by: opts.by, scope, identity: value, ...run }, "admin research run");
  return { started: true, workflowRunId: run.workflowRunId, created: run.created, idempotencyKey: run.idempotencyKey, plan: { queries: plan.queries, signals: plan.signals, domains: plan.domains }, identity: value, runStatus: run.runStatus };
}

export type ReentryResult = ApplyResult | { written: false; reason: "no_athlete" };

/**
 * T7 (ambiguous | failed → pending: anchor_changed / ttl) or T9 (resolved → pending: anchor_changed with a NAME or SPORT
 * change). The anchor is read now and recorded; an anchor_changed re-entry with an unchanged anchorHash is refused, and so
 * is any re-entry from NULL or pending (E1's table). Starts no run.
 */
export async function reenterIdentityResolution(athleteId: string, opts: { trigger: "anchor_changed" | "ttl"; nameOrSportChanged?: boolean; asOf?: Date }): Promise<ReentryResult> {
  if (!identityResolutionEnabled()) return { written: false, reason: "disabled" };
  const current = (await readIdentityState(athleteId)) ?? { value: null, detail: null };
  const anchor = await currentIdentityAnchor(athleteId);
  if (!anchor) return { written: false, reason: "no_athlete" };
  const r = await applyIdentityTransition(athleteId, current, { kind: "reenter", trigger: opts.trigger, anchorHash: anchorHash(anchor), nameOrSportChanged: opts.nameOrSportChanged === true }, { at: opts.asOf });
  logger.info({ athleteId, trigger: opts.trigger, result: summarize(r) }, "identity re-entry");
  return r;
}
