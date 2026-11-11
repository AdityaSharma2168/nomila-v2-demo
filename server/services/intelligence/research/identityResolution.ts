/**
 * research/identityResolution.ts — athlete-level public-identity resolution (PR E1; design record
 * docs/architecture/phase-a/pr-e-identity-resolution-design.md §1, §2.2, §4, §5.7).
 *
 * Axis 2 of the research status contract: WHO the research concerns. It is never derived from account ownership
 * (claim / auth / self-membership / OAuth), from existing research or facts, or from the legacy
 * identity_confidence / identity_resolved_at / research_status columns — those are ACCOUNT-ownership signals.
 *
 *   NULL       no determination has ever been recorded (historical). NOT pending; nothing is owed.
 *   pending    entered governed resolution (lifecycle event or deliberate admin act); no determination in force.
 *   resolved   the public person is anchored by a Q1 result, or by the athlete's confirmation over Q1 evidence.
 *   ambiguous  a completed determination found an anchor conflict or namesakes it could not separate.
 *   failed     a completed determination found NO public person matching the anchor (never "the call failed").
 *
 * Workflow facts (attempts, retry time, queued/running, lease, budget refusals) never enter the column or its
 * provenance: they live in workflow_steps / research_runs / refresh_failures / pending.
 *
 * Contents:
 *   - anchorHash: a stable hash of the identity anchor (name + sport + current team + known handles);
 *   - classifyQ1: the deterministic Q1 classifier, thresholds T-a … T-e (pure; no database, no provider);
 *   - planIdentityTransition: transitions T1–T10 as one pure, typed function (illegal moves are refused);
 *   - applyIdentityTransition: the compare-and-set writer, behind identityResolutionEnabled(). A lost CAS is a
 *     returned result, never an error. It is the ONLY writer of the two columns; its importers are allow-listed
 *     (identityResolution.test.ts).
 *
 * E1 ships no caller: nothing here runs until E2a/E2b wire the v3 Q1 step, lifecycle start and the confirmation service.
 *   - onIdentityResolved (PR H2): a listener seam fired after every written transition into `resolved`.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../db";
import { createLogger } from "../../../logger";
import { athleteResearchState } from "../../../../shared/schema";
import { normalizeHandle } from "../identity/policy";
import { identityResolutionEnabled } from "./config";
import { normalizeText } from "./factRegistry";
import { IDENTITY_RESOLUTIONS, type IdentityResolution } from "./registries";
import { ACCEPTED_LEVELS } from "./spec/directEvidenceV1";
import { directDegenerateV2, type Finding, type ParsedDirectV2 } from "./spec/directEvidenceV2";

const logger = createLogger("research-identity-resolution");

export { IDENTITY_RESOLUTIONS, type IdentityResolution };
/** The column value: one of IDENTITY_RESOLUTIONS, or NULL = no determination recorded (never "pending"). */
export type IdentityValue = IdentityResolution | null;

// ── the anchor ────────────────────────────────────────────────────────────────

/** What Q1 is asked to anchor: name + sport + current said/proof/primary team + known handles (searchInputsFor's inputs). */
export interface IdentityAnchor {
  fullName: string;
  sport: string;
  /** The current team the anchor supplies (SearchInputs.currentTeam), or null. */
  team: string | null;
  /** platform → handle (SearchInputs.handles). `twitter` is read as `x`. */
  handles: Readonly<Record<string, string | null | undefined>>;
}

export const IDENTITY_ANCHOR_VERSION = "identity-anchor/1";
const platformKey = (p: string) => { const k = p.trim().toLowerCase(); return k === "twitter" ? "x" : k; };

/** Known handles, platform-keyed and normalized with normalizeHandle; empty values dropped. */
export function anchorHandles(a: IdentityAnchor): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, h] of Object.entries(a.handles ?? {})) { const n = normalizeHandle(h); if (n) out[platformKey(p)] = n; }
  return out;
}

/** The canonical, order-independent text of an anchor (the hash input). Normalization only; nothing inferred. */
export function canonicalAnchor(a: IdentityAnchor): string {
  const handles = Object.entries(anchorHandles(a)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const team = a.team == null ? null : normalizeText(a.team) || null;
  return JSON.stringify({ v: IDENTITY_ANCHOR_VERSION, name: normalizeText(a.fullName), sport: normalizeText(a.sport), team, handles });
}

/** sha256 of the canonical anchor (hex). Recorded in provenance so a re-entry can tell whether the inputs changed. */
export function anchorHash(a: IdentityAnchor): string {
  return createHash("sha256").update(canonicalAnchor(a)).digest("hex");
}

// ── the Q1 classifier (§2.2; T-a … T-e APPROVED, T-e as tightened) ─────────────

/** Accepted lineage on the direct path: native_supported / native_retrieved (directResearch.ts ACCEPTED). */
const ACCEPTED = new Set<string>(ACCEPTED_LEVELS.retrieved);
const isAccepted = (f: Finding) => ACCEPTED.has(f.lineage.level);

/** The platform hosts a handle may be corroborated on (T-e). A subdomain (www., m.) of a listed host counts. */
export const HANDLE_PLATFORM_HOSTS: Readonly<Record<string, readonly string[]>> = {
  instagram: ["instagram.com"], tiktok: ["tiktok.com"], x: ["x.com", "twitter.com"], youtube: ["youtube.com"],
};

/** One completed-or-not Q1 call, as the v3 Q1 step will hold it after persist. */
export interface Q1Result {
  /** The adapter's `completed` (parsed v2, no parse error, hybrid marker found). */
  completed: boolean;
  parsed: ParsedDirectV2 | null;
  /** Provider-native retrieved sources for this call (directDegenerateV2's input). */
  nativeSources: number;
  /** Items Q1 asked for (directDegenerateV2's input). */
  askedItems: number;
  /** T-c: this run's persist raised a blockingDispute on identity/affiliations against an athlete_asserted/athlete_proof value. */
  conflictsAthleteStatement: boolean;
}

export type AmbiguousReason = "uncertain" | "namesakes_unseparated" | "namesakes_uncorroborated" | "conflicts_athlete_statement";
export type NoDeterminationReason = "not_completed" | "unparseable" | "degenerate" | "anchor_match_null" | "no_accepted_evidence";
export type Corroboration = "team" | "handle";
type AnchorMatch = "matched" | "uncertain" | "not_resolved";

interface DeterminationBase { confidence: number | null; namesakes: number }
export type Q1Determination =
  | (DeterminationBase & { outcome: "resolved"; anchorMatch: "matched"; corroboratedBy: Corroboration[] })
  | (DeterminationBase & { outcome: "ambiguous"; anchorMatch: AnchorMatch; reason: AmbiguousReason })
  | (DeterminationBase & { outcome: "failed"; anchorMatch: "not_resolved"; reason: "no_public_match" })
  /** T5: no determination — nothing is written to the column. */
  | (DeterminationBase & { outcome: "no_determination"; anchorMatch: AnchorMatch | null; reason: NoDeterminationReason; detail: string | null });

const allFindings = (p: ParsedDirectV2): Finding[] => Object.values(p.items).flatMap((i) => i?.findings ?? []);

/** Namesakes Q1 reported: the identity block's namesakes[], or the S1 `namesakes` item's findings — whichever is larger. */
export function namesakeCount(p: ParsedDirectV2): number {
  return Math.max(p.identity.namesakes.length, p.items.namesakes?.findings.length ?? 0);
}

/** T-e team: an accepted S2 current_affiliation whose organization, normalizeText'ed, EQUALS the normalized anchor team. */
export function teamCorroborated(findings: Finding[], anchor: IdentityAnchor): boolean {
  const team = anchor.team == null ? "" : normalizeText(anchor.team);
  if (!team) return false;
  return findings.some((f) => f.section === "S2" && f.item === "current_affiliation" && isAccepted(f)
    && normalizeText(f.value.organization ?? f.value.org) === team);
}

function hostMatches(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((x) => h === x || h.endsWith(`.${x}`));
}
function firstPathSegment(url: URL): string | null {
  const seg = url.pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/** T-e handle: an accepted S1/S2 finding cites a URL on the handle's platform host whose first path segment, normalizeHandle'd, EQUALS that handle. */
export function handleCorroborated(findings: Finding[], anchor: IdentityAnchor): boolean {
  const known = Object.entries(anchorHandles(anchor)).filter(([p]) => p in HANDLE_PLATFORM_HOSTS);
  if (!known.length) return false;
  for (const f of findings) {
    if ((f.section !== "S1" && f.section !== "S2") || !isAccepted(f)) continue;
    for (const s of f.sources) {
      let u: URL;
      try { u = new URL(s.url); } catch { continue; }
      const seg = normalizeHandle(firstPathSegment(u));
      if (!seg) continue;
      if (known.some(([p, h]) => h === seg && hostMatches(u.hostname, HANDLE_PLATFORM_HOSTS[p]))) return true;
    }
  }
  return false;
}

/**
 * Classify ONE Q1 result (§2.2). Pure: no database, no provider. Exact matches after normalization only; no fuzzy or
 * substring match; `confidence` is recorded, never thresholded (T-d).
 *
 *   no determination  not completed / unparseable / degenerate / anchorMatch null (T-a); matched with no accepted S1/S2 finding (T-b)
 *   failed            not_resolved with zero namesakes
 *   ambiguous         uncertain; not_resolved with ≥ 1 namesake; matched but conflicts with her said/proof (T-c);
 *                     matched with ≥ 1 namesake and no exact team/handle corroboration (T-e)
 *   resolved          matched + ≥ 1 accepted S1/S2 finding + no conflict + (no namesakes, or corroborated)
 */
export function classifyQ1(r: Q1Result, anchor: IdentityAnchor): Q1Determination {
  const p = r.parsed;
  const none = (reason: NoDeterminationReason, detail: string | null = null): Q1Determination =>
    ({ outcome: "no_determination", reason, detail, anchorMatch: p?.identity.anchorMatch ?? null, confidence: p?.identity.confidence ?? null, namesakes: p ? namesakeCount(p) : 0 });
  // T-a: no determination
  if (!r.completed) return none("not_completed");
  if (!p || p.parseError) return none("unparseable", p?.parseError ?? null);
  const deg = directDegenerateV2(p, r.nativeSources, r.askedItems);
  if (deg.degenerate) return none("degenerate", deg.reason);
  const { anchorMatch, confidence } = p.identity;
  if (anchorMatch == null) return none("anchor_match_null");

  const namesakes = namesakeCount(p);
  const base = { confidence, namesakes };
  if (anchorMatch === "uncertain") return { ...base, outcome: "ambiguous", anchorMatch, reason: "uncertain" };
  if (anchorMatch === "not_resolved") {
    return namesakes > 0
      ? { ...base, outcome: "ambiguous", anchorMatch, reason: "namesakes_unseparated" }
      : { ...base, outcome: "failed", anchorMatch, reason: "no_public_match" };
  }
  // matched
  const findings = allFindings(p);
  // T-b: at least one accepted S1/S2 finding about her (a namesake finding is about someone else and does not count)
  if (!findings.some((f) => (f.section === "S1" || f.section === "S2") && f.item !== "namesakes" && isAccepted(f))) return none("no_accepted_evidence");
  // T-c: it conflicts with what she said / proved
  if (r.conflictsAthleteStatement) return { ...base, outcome: "ambiguous", anchorMatch, reason: "conflicts_athlete_statement" };
  // T-e: namesakes reported ⇒ a supplied discriminator beyond name/sport must be corroborated exactly
  const corroboratedBy: Corroboration[] = [];
  if (teamCorroborated(findings, anchor)) corroboratedBy.push("team");
  if (handleCorroborated(findings, anchor)) corroboratedBy.push("handle");
  if (namesakes > 0 && corroboratedBy.length === 0) return { ...base, outcome: "ambiguous", anchorMatch, reason: "namesakes_uncorroborated" };
  return { ...base, outcome: "resolved", anchorMatch, corroboratedBy };
}

// ── provenance ("current plus one") ───────────────────────────────────────────

export type EntryTrigger = "signup" | "claim" | "admin";
export type ReentryTrigger = "anchor_changed" | "ttl" | "admin";

/** The immediate predecessor, flattened: never carries its own `previous` (only current + one sit in the row). */
export interface PreviousDetermination { value: IdentityResolution; at: string | null; basis: string | null; reason: string | null }

/** pending (T1, T7, T9). */
export interface EnteredDetail { at: string; trigger: EntryTrigger | ReentryTrigger; by?: string | null; anchorHash: string; previous: PreviousDetermination | null }
/** resolved / ambiguous / failed from a Q1 result (T2, T3, T4, T10). */
export interface Q1Detail {
  at: string; basis: "q1"; researchRunId: string; workflowRunId: string | null; queryId: "Q1";
  anchorMatch: AnchorMatch; confidence: number | null; namesakes: number; namesakeEvidenceIds: string[]; anchorHash: string;
  reason?: AmbiguousReason | "no_public_match"; corroboratedBy?: Corroboration[]; previous: PreviousDetermination | null;
}
/** resolved by her confirmation over Q1 evidence (T6). */
export interface ConfirmedDetail { at: string; basis: "athlete_confirmed"; assertedId: string; evidenceIds: string[]; q1ResearchRunId: string; by: string; previous: PreviousDetermination | null }
/** ambiguous by her rejection (T8). */
export interface RejectedDetail { at: string; basis: "athlete_rejected"; assertedId: string; by: string; previous: PreviousDetermination | null }
export type IdentityDetail = EnteredDetail | Q1Detail | ConfirmedDetail | RejectedDetail;

export interface IdentityState { value: IdentityValue; detail: IdentityDetail | null }

function previousOf(s: IdentityState): PreviousDetermination | null {
  if (s.value == null) return null;
  const d = (s.detail ?? {}) as { at?: string; basis?: string; reason?: string };
  return { value: s.value, at: d.at ?? null, basis: d.basis ?? null, reason: d.reason ?? null };
}

// ── transitions (§1.2) ────────────────────────────────────────────────────────

export type IdentityEvent =
  /** T1 — lifecycle start (signup / claim) or a deliberate admin act. Only from NULL. */
  | { kind: "enter"; trigger: EntryTrigger; by: string | null; anchorHash: string }
  /** T2/T3/T4 (from pending), T10 (resolved → resolved), T5 (no determination: no write). */
  | { kind: "q1"; determination: Q1Determination; researchRunId: string; workflowRunId: string | null; requestAnchorHash: string; currentAnchorHash: string; namesakeEvidenceIds?: string[] }
  /** T6 — she confirms one Q1 candidate/evidence set (or a proof affiliation separates the namesakes). Only from ambiguous. */
  | { kind: "athlete_confirmed"; assertedId: string; evidenceIds: string[]; q1ResearchRunId: string; by: string }
  /** T7 (ambiguous | failed → pending) or T9 (resolved → pending, name/sport change only). */
  | { kind: "reenter"; trigger: ReentryTrigger; anchorHash: string; nameOrSportChanged: boolean }
  /** T8 — "that is not me". Only from resolved. */
  | { kind: "athlete_rejected"; assertedId: string; by: string };

export type TransitionId = "T1" | "T2" | "T3" | "T4" | "T6" | "T7" | "T8" | "T9" | "T10";
export type TransitionPlan =
  | { ok: true; transition: TransitionId; from: IdentityValue; to: IdentityResolution; detail: IdentityDetail }
  /** Legal, but nothing is written: T5 (no determination), D7 (resolved is sticky against automation), a kept confirmation. */
  | { ok: false; kind: "noop"; from: IdentityValue; reason: "no_determination" | "resolved_sticky" | "athlete_confirmed_kept" }
  /** Not a transition the table allows. */
  | { ok: false; kind: "refused"; from: IdentityValue; reason: string };

/**
 * The transition table, pure. `current` is the row as the caller read it; the writer compares-and-sets on its value.
 * There is no event that yields NULL: any → NULL is impossible by construction.
 */
export function planIdentityTransition(current: IdentityState, event: IdentityEvent, at: Date): TransitionPlan {
  const from = current.value;
  const iso = at.toISOString();
  const refused = (reason: string): TransitionPlan => ({ ok: false, kind: "refused", from, reason });
  const noop = (reason: "no_determination" | "resolved_sticky" | "athlete_confirmed_kept"): TransitionPlan => ({ ok: false, kind: "noop", from, reason });
  const go = (transition: TransitionId, to: IdentityResolution, detail: IdentityDetail): TransitionPlan => ({ ok: true, transition, from, to, detail });
  const previous = previousOf(current);

  switch (event.kind) {
    case "enter": {
      if (from !== null) return refused(`enter is T1 (NULL → pending) only; from ${from} re-entry is T7/T9`);
      return go("T1", "pending", { at: iso, trigger: event.trigger, by: event.by, anchorHash: event.anchorHash, previous: null });
    }
    case "q1": {
      const d = event.determination;
      if (d.outcome === "no_determination") return noop("no_determination");                       // T5, from any value
      if (from !== "pending" && from !== "resolved") return refused(`a Q1 determination applies only from pending (T2–T4) or resolved (T10), not ${from ?? "NULL"}`);
      if (event.requestAnchorHash !== event.currentAnchorHash) return refused("anchor changed since the Q1 request");
      const detail: Q1Detail = {
        at: iso, basis: "q1", researchRunId: event.researchRunId, workflowRunId: event.workflowRunId, queryId: "Q1",
        anchorMatch: d.anchorMatch as AnchorMatch, confidence: d.confidence, namesakes: d.namesakes, namesakeEvidenceIds: [...(event.namesakeEvidenceIds ?? [])],
        anchorHash: event.requestAnchorHash, previous,
        ...(d.outcome === "resolved" ? { corroboratedBy: d.corroboratedBy } : { reason: d.reason }),
      };
      if (from === "resolved") {
        if (d.outcome !== "resolved") return noop("resolved_sticky");                                   // D7: a review signal, not a transition
        if ((current.detail as Partial<Q1Detail> | null)?.basis !== "q1") return noop("athlete_confirmed_kept");
        return go("T10", "resolved", detail);
      }
      return d.outcome === "resolved" ? go("T2", "resolved", detail) : d.outcome === "ambiguous" ? go("T3", "ambiguous", detail) : go("T4", "failed", detail);
    }
    case "athlete_confirmed": {
      if (from !== "ambiguous") return refused(`athlete confirmation resolves only from ambiguous (T6), not ${from ?? "NULL"}`);
      return go("T6", "resolved", { at: iso, basis: "athlete_confirmed", assertedId: event.assertedId, evidenceIds: [...event.evidenceIds], q1ResearchRunId: event.q1ResearchRunId, by: event.by, previous });
    }
    case "reenter": {
      const prevHash = (current.detail as Partial<Q1Detail> | null)?.anchorHash;
      if (event.trigger === "anchor_changed" && prevHash && prevHash === event.anchorHash) return refused("anchor_changed re-entry with an unchanged anchor hash");
      const detail: EnteredDetail = { at: iso, trigger: event.trigger, anchorHash: event.anchorHash, previous };
      if (from === "ambiguous" || from === "failed") return go("T7", "pending", detail);
      if (from === "resolved") {
        if (event.trigger === "anchor_changed" && event.nameOrSportChanged) return go("T9", "pending", detail);
        return refused("resolved re-enters only on a name or sport change (T9); a TTL re-run is T10, other anchor changes leave it resolved");
      }
      return refused(`re-entry applies only from ambiguous, failed (T7) or resolved (T9), not ${from ?? "NULL"}`);
    }
    case "athlete_rejected": {
      if (from !== "resolved") return refused(`athlete rejection applies only from resolved (T8), not ${from ?? "NULL"}`);
      return go("T8", "ambiguous", { at: iso, basis: "athlete_rejected", assertedId: event.assertedId, by: event.by, previous });
    }
  }
}

// ── the reader and the compare-and-set writer ─────────────────────────────────

/** The athlete's identity state, or null when no athlete_research_state row exists. */
export async function readIdentityState(athleteId: string): Promise<IdentityState | null> {
  const [row] = await db.select({ value: athleteResearchState.identity_resolution, detail: athleteResearchState.identity_resolution_detail })
    .from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)).limit(1);
  if (!row) return null;
  return { value: (row.value as IdentityValue) ?? null, detail: (row.detail as IdentityDetail | null) ?? null };
}

/** PR E2b: the identity state of several athletes in one read (the planner). Athletes with no state row are absent. */
export async function readIdentityStates(athleteIds: readonly string[]): Promise<Map<string, IdentityState>> {
  const out = new Map<string, IdentityState>();
  if (!athleteIds.length) return out;
  const rows = await db.select({ athleteId: athleteResearchState.athlete_id, value: athleteResearchState.identity_resolution, detail: athleteResearchState.identity_resolution_detail })
    .from(athleteResearchState).where(inArray(athleteResearchState.athlete_id, [...athleteIds]));
  for (const r of rows) out.set(r.athleteId, { value: (r.value as IdentityValue) ?? null, detail: (r.detail as IdentityDetail | null) ?? null });
  return out;
}

export type ApplyResult =
  | { written: true; transition: TransitionId; from: IdentityValue; to: IdentityResolution; detail: IdentityDetail }
  /** identityResolutionEnabled() is false: refused before any read or write. */
  | { written: false; reason: "disabled" }
  | { written: false; reason: "noop" | "refused"; from: IdentityValue; detail: string }
  /** Someone else moved the row first (or it does not exist). Not an error: the caller records it and moves on. */
  | { written: false; reason: "cas_lost"; expected: IdentityValue; observed: IdentityValue | "no_row" };

/**
 * Plan the transition from `current` (as the caller read it) and write it with compare-and-set:
 *   UPDATE athlete_research_state SET identity_resolution=$to, identity_resolution_detail=$detail
 *    WHERE athlete_id=$a AND identity_resolution IS NOT DISTINCT FROM $from
 * A late Q1 therefore never overwrites an athlete's confirmation. The writer touches only these two columns.
 */
export async function applyIdentityTransition(athleteId: string, current: IdentityState, event: IdentityEvent, opts: { at?: Date } = {}): Promise<ApplyResult> {
  if (!identityResolutionEnabled()) return { written: false, reason: "disabled" };
  const plan = planIdentityTransition(current, event, opts.at ?? new Date());
  if (!plan.ok) return { written: false, reason: plan.kind, from: plan.from, detail: plan.reason };
  if (!(IDENTITY_RESOLUTIONS as readonly string[]).includes(plan.to)) throw new Error(`identity_resolution: refusing to write ${String(plan.to)}`);
  const updated = await db.update(athleteResearchState)
    .set({ identity_resolution: plan.to, identity_resolution_detail: plan.detail as any })
    .where(and(eq(athleteResearchState.athlete_id, athleteId), sql`${athleteResearchState.identity_resolution} IS NOT DISTINCT FROM ${plan.from}`))
    .returning({ athleteId: athleteResearchState.athlete_id });
  if (updated.length === 0) {
    const now = await readIdentityState(athleteId);
    return { written: false, reason: "cas_lost", expected: plan.from, observed: now ? now.value : "no_row" };
  }
  if (plan.to === "resolved") await notifyIdentityResolved({ athleteId, transition: plan.transition, from: plan.from });
  return { written: true, transition: plan.transition, from: plan.from, to: plan.to, detail: plan.detail };
}

// ── "identity is now resolved": a listener seam (PR H2, R-a) ──────────────────

/**
 * Fired after EVERY written transition into `resolved` — T2 (Q1), T6 (her confirmation), T10 (an identity-TTL Q1 re-run
 * refreshing provenance) — here, in the one writer, so no resolving path can be missed. A lost CAS, a no-op or a
 * refusal writes nothing and fires nothing.
 *
 * A SEAM, NOT A CALL. Identity resolution must never depend on the work it unblocks: this module does not import the
 * M.I.A. orchestrator (pinned by miaIdentityGate.test.ts). The mia_evaluation workflow registers its listener where it
 * is defined (workflow/definitions/miaEvaluation.ts) and decides there whether an evaluation is owed.
 *
 * A listener can never fail the transition: it runs after the write, and anything it throws is logged and swallowed.
 * Keyed by name, so registering twice replaces rather than duplicates.
 */
export interface IdentityResolvedEvent { athleteId: string; transition: TransitionId; from: IdentityValue }
export type IdentityResolvedListener = (e: IdentityResolvedEvent) => Promise<unknown> | unknown;
const resolvedListeners = new Map<string, IdentityResolvedListener>();

export function onIdentityResolved(name: string, listener: IdentityResolvedListener): void { resolvedListeners.set(name, listener); }
export function offIdentityResolved(name: string): void { resolvedListeners.delete(name); }

async function notifyIdentityResolved(e: IdentityResolvedEvent): Promise<void> {
  for (const [name, listener] of resolvedListeners) {
    try { await listener(e); }
    catch (err: any) { logger.error({ athleteId: e.athleteId, transition: e.transition, listener: name, error: err?.message }, "identity-resolved listener failed; the transition stands"); }
  }
}
