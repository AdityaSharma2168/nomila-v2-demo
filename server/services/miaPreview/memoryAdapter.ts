/**
 * miaPreview/memoryAdapter.ts — THE M.I.A. input adapter for athletes on the new agent's memory (memory_facts, 0105/0106).
 *
 * The evaluator's Nomila-supplied input is, as before, three things: the athlete's name, their sport and one evidence
 * block (marketabilityBeta1Snapshot.ts). For a memory athlete this module builds that block from memory instead of the
 * old research substrate:
 *
 *   AUTHORITATIVE SOCIAL DATA   measured data from her connected accounts — ONE measured source: her MEASURED memory
 *                               facts, the latest reading per metric (numbers code read straight from the connected
 *                               account; latestMeasuredPerMetric, authoritativeAccounts). The connected social-features
 *                               block is not read for a memory athlete (it was a second, differently computed source:
 *                               two engagement rates for one account) — its metrics now reach memory as measured facts,
 *                               so nothing is lost. Nothing found on the web is ever put here. With
 *                               no measured data it says so, in the frozen fallback's words.
 *   PUBLIC FACTS NOMILA FOUND   her active FOUND facts (public follower counts, results, press, partners …), each with
 *                               its source, date and confidence, labelled as researched evidence for the evaluator to
 *                               weigh and verify — never as authoritative. Absent when there are none.
 *
 * The frozen rubric is untouched (its canonical digest is pinned); only this per-athlete evidence text is new. An athlete
 * whose memory holds no found or measured facts produces the same prompt the legacy path would.
 *
 * Who is a memory athlete: anyone with at least one memory_facts row. The new onboarding writes her name and sport as
 * said facts the moment it starts, so every new-agent athlete qualifies; nobody else does (clean start, no backfill).
 *
 * Identity, from memory (replaces athlete_research_state for these athletes): uncertain while a DISPUTED identity fact
 * stands unsettled — a fact anchored on who she is (her said name/sport, or the research's own identity record) or a
 * fact that disputes one. Settled when she confirms, corrects (superseded) or removes it.
 *
 * READS ONLY: athletes (name, sport), memory_facts, memory_fact_reviews and connected_accounts (handles). It no longer
 * reads social_features (one measured source, above). It never reads a retiring table (athlete_facts, research_*,
 * athlete_research_state, athlete_inferences, identity_intelligence_*); miaPreview.boundary.test.ts fails if it starts to.
 */
import { and, eq, gte, inArray, or } from "drizzle-orm";
import { db } from "../../db";
import { athletes, connectedAccounts, memoryFactReviews, memoryFacts } from "../../../shared/schema";
import { workflowRuns } from "../../../shared/schemaWorkflow";
import { isAboutAthlete } from "../../../shared/agent";
import { CROSS_PLATFORM } from "../../agent/research/connected";
import { isPublicPlatformRef } from "../../agent/research/publicPlatform";
import { renderBlock, type SocialAccountBlock, type SocialBlockRecord } from "../marketabilityBeta1SocialBlock";
import { evidenceAsOfFor, snapshotDigest, type EvidenceSnapshot, type SnapshotSource, type TriggerReason } from "../marketabilityBeta1Snapshot";
import { NO_AUTHORITATIVE_SOCIAL_DATA } from "../marketabilityBeta1EvaluatorSpec";
import {
  CARE_CONDUCT_HEADING, CARE_CONDUCT_LEAD, CARE_CONDUCT_SOURCE_CLASS, CARE_PERSONAL_HEADING, CARE_PERSONAL_LEAD, CARE_SOURCE_CLASS,
  CONTEXT_HEADING, CONTEXT_LEAD, CONTEXT_SOURCE_CLASS, FACTS_HEADING, FACTS_LEAD, miaFactsEvaluatorVersion, NO_FACTS_LINE,
} from "./factsOnlySpec";

/** The platforms the authoritative block reports on (the same four the legacy snapshot lists). */
export const BLOCK_PLATFORMS = ["instagram", "youtube", "tiktok", "x"] as const;

/** A memory input's source class on the snapshot. Measured = connected data; found = researched public evidence. */
export const MEMORY_SOURCE_PLATFORM = "memory";
export const MEASURED_SOURCE_CLASS = "connected_verified";
export const FOUND_SOURCE_CLASS = "web_researched";
/** A measured reading from a platform's public API for a handle she confirmed (agent/research/publicPlatform.ts). */
export const PUBLIC_PLATFORM_SOURCE_CLASS = "platform_public";
/** The measured-fact source class of one reading: her connected account, or a platform's public API. */
export const measuredSourceClassOf = (f: Pick<PreviewFact, "sourceRef">) => (isPublicPlatformRef(f.sourceRef) ? PUBLIC_PLATFORM_SOURCE_CLASS : MEASURED_SOURCE_CLASS);
/** How the evidence block names the identity basis of a public-platform account (model-facing; Prompt Register). */
export const PUBLIC_PLATFORM_IDENTITY_BASIS = "handle the athlete confirmed as their own; public profile read through the platform's own API by Nomila (not an athlete-connected account)";
/** "@handle" as a public-platform reading names it ("Instagram (@x) has …"), or null. */
const publicHandleOf = (facts: PreviewFact[]) => facts.map((f) => f.claim.match(/\(@([A-Za-z0-9._-]+)\)/)?.[1]).find(Boolean) ?? null;

/** At most this many public facts go to the evaluator (the merge step itself writes at most 60 per run). */
export const MAX_PUBLIC_FACTS = 60;
/** A claim is cut to this many characters in the block. */
const MAX_CLAIM_CHARS = 400;

export interface PreviewFact {
  id: string;
  type: string;
  status: string;
  claim: string;
  subjectKind: string;
  subjectName: string;
  sourceUrl: string | null;
  sourceRef: string | null;
  sourceTitle: string | null;
  observedOn: string | null;
  confidence: number;
  sensitive: boolean;
  /** Care facts only (0113): personal | conduct; null = not care, or care written before 0113 (read as personal). */
  careKind?: "personal" | "conduct" | null;
  disputes: string | null;
  createdAt: string;
  /** The research topic (0115); "moment" marks a dated moment (the moments store), never evaluator input. */
  topic?: string | null;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function toPreviewFact(r: typeof memoryFacts.$inferSelect): PreviewFact {
  return {
    id: r.id, type: r.type, status: r.status, claim: r.claim, subjectKind: r.subject_kind, subjectName: r.subject_name,
    sourceUrl: r.source_url ?? null, sourceRef: r.source_ref ?? null, sourceTitle: r.source_title ?? null,
    observedOn: r.observed_on ?? null, confidence: Number(r.confidence), sensitive: !!r.sensitive,
    careKind: r.sensitive ? (r.care_kind === "conduct" ? "conduct" : "personal") : null, disputes: r.disputes ?? null,
    createdAt: iso(r.created_at), topic: r.topic ?? null,
  };
}

// ── who is on the new path ────────────────────────────────────────────────────

/** True when the athlete has any memory_facts row: the new agent's memory is the source of their M.I.A. input. */
export async function isMemoryAthlete(athleteId: string): Promise<boolean> {
  const [row] = await db.select({ id: memoryFacts.id }).from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId)).limit(1);
  return !!row;
}

// ── selection (pure) ──────────────────────────────────────────────────────────

/** "instagram.followers" → { platform: "instagram", metric: "followers" } from a measured fact's source ref, else null. */
export function measuredMetricOf(ref: string | null): { platform: string; metric: string } | null {
  if (!ref || !ref.includes("#")) return null;
  const m = ref.slice(ref.indexOf("#") + 1);
  const dot = m.indexOf(".");
  if (dot <= 0 || dot === m.length - 1) return null;
  return { platform: m.slice(0, dot).toLowerCase(), metric: m.slice(dot + 1) };
}

/**
 * The facts a preview may use. Public = active FOUND facts that are not sensitive, most confident first (ties: oldest,
 * then id — a stable order, so the digest only moves when the facts do), capped. Measured = the latest active MEASURED
 * fact per metric (latestMeasuredPerMetric). Said, made, disputed, superseded and removed facts are never evaluator input.
 */
export function selectPreviewFacts(facts: PreviewFact[]): { public: PreviewFact[]; measured: PreviewFact[] } {
  const usable = facts.filter((f) => f.status === "active" && !f.sensitive);
  const pub = usable.filter((f) => f.type === "found")
    .sort((a, b) => b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_PUBLIC_FACTS);
  return { public: pub, measured: latestMeasuredPerMetric(usable.filter((f) => f.type === "measured")) };
}

/**
 * ONE reading per metric: of the measured facts for the same "platform.metric" (their source ref), the newest
 * (observed date, then when recorded). syncMeasured already supersedes an older reading, so this is the guard for any
 * that still stand side by side. A measured fact whose ref names no metric is not a reading and is left out. Sorted by
 * ref, then id, so the digest moves only when a reading does.
 */
export function latestMeasuredPerMetric(measured: PreviewFact[]): PreviewFact[] {
  // Connected data wins: a platform with any connected reading uses none of its public-platform readings.
  const connectedPlatforms = new Set(measured.filter((f) => !isPublicPlatformRef(f.sourceRef)).map((f) => measuredMetricOf(f.sourceRef)?.platform).filter(Boolean));
  const latest = new Map<string, PreviewFact>();
  for (const f of measured) {
    const m = measuredMetricOf(f.sourceRef);
    if (!m) continue;
    if (isPublicPlatformRef(f.sourceRef) && connectedPlatforms.has(m.platform)) continue;
    const key = `${m.platform}.${m.metric}`;
    const cur = latest.get(key);
    const newer = !cur || (f.observedOn ?? "").localeCompare(cur.observedOn ?? "") > 0
      || ((f.observedOn ?? "") === (cur.observedOn ?? "") && f.createdAt.localeCompare(cur.createdAt) > 0);
    if (newer) latest.set(key, f);
  }
  return [...latest.values()].sort((a, b) => (a.sourceRef ?? "").localeCompare(b.sourceRef ?? "") || a.id.localeCompare(b.id));
}

// ── rendering (pure) ──────────────────────────────────────────────────────────

const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

export const PUBLIC_FACTS_HEADING = "PUBLIC FACTS NOMILA FOUND";
export const PUBLIC_FACTS_LEAD = "Researched public facts Nomila found about this athlete, each with its source, date and Nomila's confidence (0–1). They are public evidence, not authoritative platform data: weigh and verify them as you would any public source you retrieve, and cite the source URL of any you rely on.";

/** The public-facts section, or null when there are none. */
export function renderPublicFacts(facts: PreviewFact[]): string | null {
  if (!facts.length) return null;
  const lines = [PUBLIC_FACTS_HEADING, "", PUBLIC_FACTS_LEAD];
  for (const f of facts) {
    const about = f.subjectKind !== "athlete" ? ` (about ${f.subjectKind} ${oneLine(f.subjectName, 120)})` : "";
    const where = [f.sourceTitle ? oneLine(f.sourceTitle, 160) : null, f.sourceUrl ?? f.sourceRef].filter(Boolean).join(" ");
    lines.push(`- ${oneLine(f.claim, MAX_CLAIM_CHARS)}${about} — source: ${where}; ${f.observedOn ? `dated ${f.observedOn}` : "undated"}; confidence ${f.confidence.toFixed(2)}`);
  }
  return lines.join("\n");
}

/**
 * One account per platform from her measured memory facts, for platforms the social-features block did not cover.
 * Rendered by the existing renderBlock, so a measured account reads exactly like a connected one.
 */
export function measuredAccounts(measured: PreviewFact[], handles: Map<string, string>, covered: Set<string>): Array<{ account: SocialAccountBlock; facts: PreviewFact[] }> {
  const byPlatform = new Map<string, PreviewFact[]>();
  // Cross-platform readings (ref "#all.<metric>": effective reach, platform breadth) go on the first account, as the
  // connected block put them.
  const cross: PreviewFact[] = [];
  for (const f of measured) {
    const m = measuredMetricOf(f.sourceRef);
    if (!m || covered.has(m.platform)) continue;
    if (m.platform === CROSS_PLATFORM) { cross.push(f); continue; }
    byPlatform.set(m.platform, [...(byPlatform.get(m.platform) ?? []), f]);
  }
  const out: Array<{ account: SocialAccountBlock; facts: PreviewFact[] }> = [];
  for (const [platform, facts] of [...byPlatform.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const observedAt = facts.map((f) => f.observedOn ?? f.createdAt.slice(0, 10)).sort().slice(-1)[0];
    const metrics: Record<string, string> = {};
    for (const f of facts) metrics[measuredMetricOf(f.sourceRef)!.metric.replace(/_/g, " ")] = oneLine(f.claim, MAX_CLAIM_CHARS);
    // A platform read only through its public API (a handle she confirmed; agent/research/publicPlatform.ts) is labelled
    // as that API — the block's existing discovery source names — never as her connected account.
    const pub = facts.every((f) => isPublicPlatformRef(f.sourceRef));
    const handle = handles.get(platform) ?? publicHandleOf(facts) ?? platform;
    out.push({
      account: pub
        ? { platform, handle, source: platform === "youtube" ? "youtube_data_api" : "meta_business_discovery", observedAt, identityBasis: PUBLIC_PLATFORM_IDENTITY_BASIS, identityConfidence: "HIGH", metrics }
        : { platform, handle, source: "connected_verified", observedAt, identityBasis: "athlete-connected account (OAuth), measured facts in Nomila memory", identityConfidence: "HIGH", metrics },
      facts,
    });
  }
  if (out.length && cross.length) {
    for (const f of cross) out[0].account.metrics[`cross-platform ${measuredMetricOf(f.sourceRef)!.metric.replace(/_/g, " ")}`] = oneLine(f.claim, MAX_CLAIM_CHARS);
    out[0].facts = [...out[0].facts, ...cross];
  }
  return out;
}

/** The whole evidence block: authoritative section (or the frozen "none" text) + the public-facts section. */
export function composeBlock(accounts: SocialAccountBlock[], publicFacts: PreviewFact[]): string | null {
  const pub = renderPublicFacts(publicFacts);
  let authoritative: string | null = null;
  if (accounts.length) {
    const rec: SocialBlockRecord = { athlete: { key: "", name: "", sport: "" }, accounts, unavailable: [], candidates: [], text: "" };
    for (const p of BLOCK_PLATFORMS) {
      if (!accounts.some((a) => a.platform === p)) rec.unavailable.push({ platform: p, reason: p === "tiktok" || p === "x" ? "no authoritative route" : "no confidently resolved account" });
    }
    authoritative = renderBlock(rec);
  }
  if (!pub) return authoritative;
  return `${authoritative ?? NO_AUTHORITATIVE_SOCIAL_DATA}\n\n${pub}`;
}

// ── the FACTS-ONLY input (facts-eval-spec/0.4.0; the only evaluator input since 4 Nov 2026) ─────────────────────────

/** At most this many care facts go to the facts-only evaluator (personal and conduct together). */
export const MAX_CARE_FACTS = 15;
/** At most this many context facts (about others) go to the facts-only evaluator. */
export const MAX_CONTEXT_FACTS = 20;

const byConfidence = (a: PreviewFact, b: PreviewFact) => b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Is this fact about the athlete? (shared/agent.ts isAboutAthlete: subject kind athlete, and the athlete's name.) */
export const aboutAthlete = (f: PreviewFact, athleteName: string) => isAboutAthlete({ kind: f.subjectKind, name: f.subjectName }, athleteName);

/**
 * Pure. The facts-only evaluator's input, every list in the same stable order (most confident first):
 *   public    her active, non-care FOUND facts ABOUT HER (isAboutAthlete), capped;
 *   context   active, non-care FOUND facts about anyone or anything else — a teammate, the team's schedule, a school's
 *             sponsor, the market — listed apart under CONTEXT — ABOUT OTHERS (0.4.0): the first real run counted
 *             facts about others as the athlete's own, and cited a teammate's deal as her constraint;
 *   care      her active FOUND facts marked care, split by kind: personal (momentum only; also any care fact with no
 *             kind) and conduct (brand safety and momentum); the cap covers both kinds;
 *   measured  ONE reading per metric (latestMeasuredPerMetric).
 * Said, made, disputed, superseded and removed facts are never evaluator input, and nor are dated moments (topic
 * "moment": the moments scan's content calendar — what is coming up is not evidence of marketability).
 */
export function selectFactsOnlyInput(facts: PreviewFact[], athleteName: string, opts: { balanced?: boolean } = {}): {
  public: PreviewFact[]; context: PreviewFact[]; care: PreviewFact[]; carePersonal: PreviewFact[]; careConduct: PreviewFact[]; measured: PreviewFact[];
} {
  // Web-found audience numbers (a follower count on a news page) are FOUND facts: they go in the public facts like any
  // other, as public evidence to weigh and verify — never in the authoritative accounts, which only measured facts
  // (connected, else a confirmed handle's public-platform reading) fill. Owner, 26 Oct 2026, reversing #1142's hold-back.
  const found = facts.filter((f) => f.status === "active" && f.type === "found" && f.topic !== "moment");
  const ordinary = found.filter((f) => !f.sensitive).sort(byConfidence);
  const about = ordinary.filter((f) => aboutAthlete(f, athleteName));
  const pub = opts.balanced ? balancedByTopic(about, MAX_PUBLIC_FACTS) : about.slice(0, MAX_PUBLIC_FACTS);
  const context = ordinary.filter((f) => !aboutAthlete(f, athleteName)).slice(0, MAX_CONTEXT_FACTS);
  const care = found.filter((f) => f.sensitive).sort(byConfidence).slice(0, MAX_CARE_FACTS);
  const isConduct = (f: PreviewFact) => f.careKind === "conduct";
  return {
    public: pub, context, care, carePersonal: care.filter((f) => !isConduct(f)), careConduct: care.filter(isConduct),
    measured: latestMeasuredPerMetric(facts.filter((f) => f.status === "active" && !f.sensitive && f.type === "measured")),
  };
}

/**
 * Pure. TOPIC-BALANCED selection into the public-facts cap (an option of selectFactsOnlyInput, used only for lean
 * research athletes while LEAN_SIGNUP_RESEARCH is on, and by the leanRun command; the default selection is unchanged).
 * Why (owner, 26 Oct 2026): lean research extracts every fact, and a famous athlete's record is mostly stats and
 * honours — by confidence alone the cap filled with bio and award lines (83 of one athlete's 147 facts cut) and the
 * partner, audience and media facts never reached the score. So: group by topic (no topic ⇒ "other"); within a topic
 * newest first (observed date, then confidence); take one from each topic in turn — topics ordered by their best
 * fact's confidence, then name — until the cap. The result keeps the usual most-confident-first order.
 */
export function balancedByTopic(facts: PreviewFact[], cap: number): PreviewFact[] {
  if (facts.length <= cap) return facts;
  const groups = new Map<string, PreviewFact[]>();
  for (const f of facts) { const k = f.topic || "other"; groups.set(k, [...(groups.get(k) ?? []), f]); }
  const newest = (a: PreviewFact, b: PreviewFact) => (b.observedOn ?? "").localeCompare(a.observedOn ?? "") || byConfidence(a, b);
  const queues = [...groups.entries()]
    .map(([topic, fs]) => ({ topic, best: Math.max(...fs.map((f) => f.confidence)), fs: [...fs].sort(newest) }))
    .sort((a, b) => b.best - a.best || a.topic.localeCompare(b.topic));
  const picked: PreviewFact[] = [];
  for (let round = 0; picked.length < cap; round++) {
    let any = false;
    for (const q of queues) {
      if (picked.length >= cap) break;
      if (q.fs[round]) { picked.push(q.fs[round]); any = true; }
    }
    if (!any) break;
  }
  return picked.sort(byConfidence);
}

/**
 * Whether this athlete's M.I.A. input uses the topic-balanced selection: only while LEAN_SIGNUP_RESEARCH is on, and only
 * for an athlete whose research was lean (a signup_research v4 run, or a lean_research_refresh run). Everyone else —
 * and everyone with the flag off (prod) — keeps the default selection.
 */
export async function leanBalancedFor(athleteId: string): Promise<boolean> {
  if (process.env.LEAN_SIGNUP_RESEARCH !== "true") return false;
  const [r] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.athlete_id, athleteId),
    or(and(eq(workflowRuns.process, "signup_research"), gte(workflowRuns.definition_version, 4)), eq(workflowRuns.process, "lean_research_refresh")),
  )).limit(1);
  return !!r;
}

/** One fact line in the facts-only block: its ID first, so the evaluator cites Nomila's own fact IDs. */
export function factLine(f: PreviewFact): string {
  const about = f.subjectKind !== "athlete" ? ` (about ${f.subjectKind} ${oneLine(f.subjectName, 120)})` : "";
  const where = [f.sourceTitle ? oneLine(f.sourceTitle, 160) : null, f.sourceUrl ?? f.sourceRef].filter(Boolean).join(" ");
  return `- [${f.id}] ${oneLine(f.claim, MAX_CLAIM_CHARS)}${about} — source: ${where || "-"}; ${f.observedOn ? `dated ${f.observedOn}` : "undated"}; confidence ${f.confidence.toFixed(2)}`;
}

/**
 * The facts-only evidence block: FACTS NOMILA HOLDS (public facts about her), then CONTEXT — ABOUT OTHERS: never a
 * fact about this athlete, CARE FACTS — PERSONAL (MOMENTUM ONLY) and CARE FACTS — CONDUCT (MAY INFORM BRAND SAFETY AND
 * MOMENTUM), each only when it has facts, then the authoritative social section exactly as the legacy block states it
 * (or the frozen "none" text).
 * THE CARE RULE, AT INPUT: a care fact is never listed among the ordinary facts — only under its kind's heading, whose
 * instruction says what it may inform; a care fact with no kind goes under PERSONAL. THE SUBJECT RULE, AT INPUT: a
 * fact about anyone else is never listed among hers. factsOnlySpec.enforceFactsOnly holds the answer to both rules.
 */
export function composeFactsOnlyBlock(accounts: SocialAccountBlock[], publicFacts: PreviewFact[], careFacts: PreviewFact[], contextFacts: PreviewFact[] = []): string {
  const parts = [[FACTS_HEADING, "", FACTS_LEAD, ...(publicFacts.length ? publicFacts.map(factLine) : [NO_FACTS_LINE])].join("\n")];
  if (contextFacts.length) parts.push([CONTEXT_HEADING, "", CONTEXT_LEAD, ...contextFacts.map(factLine)].join("\n"));
  const personal = careFacts.filter((f) => f.careKind !== "conduct");
  const conduct = careFacts.filter((f) => f.careKind === "conduct");
  if (personal.length) parts.push([CARE_PERSONAL_HEADING, "", CARE_PERSONAL_LEAD, ...personal.map(factLine)].join("\n"));
  if (conduct.length) parts.push([CARE_CONDUCT_HEADING, "", CARE_CONDUCT_LEAD, ...conduct.map(factLine)].join("\n"));
  parts.push(composeBlock(accounts, []) ?? NO_AUTHORITATIVE_SOCIAL_DATA);
  return parts.join("\n\n");
}

/**
 * Pure post-check on a built block (the subject rule held at input): every fact line under FACTS NOMILA HOLDS is one
 * of the athlete's own facts. Returns the ids listed there that are not (empty = the block is sound).
 */
export function factsBlockSubjectViolations(block: string, facts: PreviewFact[], athleteName: string): string[] {
  const start = block.indexOf(FACTS_HEADING);
  if (start < 0) return [];
  const end = block.indexOf("\n\n", block.indexOf(FACTS_LEAD, start) + FACTS_LEAD.length);
  const section = block.slice(start, end < 0 ? undefined : end);
  const byId = new Map(facts.map((f) => [f.id, f]));
  return [...section.matchAll(/^- \[([0-9a-f-]{36})\]/gim)].map((m) => m[1]).filter((id) => {
    const f = byId.get(id);
    return !f || !aboutAthlete(f, athleteName);
  });
}

/**
 * Build the FACTS-ONLY evaluator snapshot for a memory athlete (the only snapshot built since 4 Nov 2026). Connected
 * accounts and memory facts as provenance, plus care facts recorded with source class web_researched_care
 * (personal) or web_researched_care_conduct (conduct) and context facts with web_researched_context — never shown as
 * preview inputs. The digest also covers the evaluator version, so a facts-only answer is never reused for a
 * frozen-evaluator question or the reverse. The block is post-checked (factsBlockSubjectViolations): a build that
 * lists another subject's fact among hers throws rather than reach the evaluator.
 */
export async function buildMemoryFactsSnapshot(
  athleteId: string,
  triggerReason: TriggerReason,
  opts: { triggerDetail?: string | null; now?: Date } = {},
): Promise<MemoryEvidenceSnapshot | null> {
  const [row] = await db.select({ id: athletes.id, name: athletes.full_name, sport: athletes.sport, createdAt: athletes.created_at })
    .from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!row?.name || !row.sport) return null;

  const facts = await loadMemoryFacts(athleteId, ["active"]);
  // Topic-balanced into the cap only for a lean-research athlete while LEAN_SIGNUP_RESEARCH is on (default otherwise).
  const selected = selectFactsOnlyInput(facts, row.name, { balanced: await leanBalancedFor(athleteId) });
  const { accounts, usedMeasured, connectedPlatforms } = await authoritativeAccounts(athleteId, selected.measured);

  const socialBlock = composeFactsOnlyBlock(accounts, selected.public, selected.care, selected.context);
  const violations = factsBlockSubjectViolations(socialBlock, facts, row.name);
  if (violations.length) throw new Error(`M.I.A. facts block lists ${violations.length} fact(s) about another subject as the athlete's`);
  const socialSources: SnapshotSource[] = [
    ...accounts.map((a) => ({ platform: a.platform, accountId: a.handle, observedAt: a.observedAt, sourceClass: a.source })),
    ...usedMeasured.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: measuredSourceClassOf(f) })),
    ...selected.public.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: FOUND_SOURCE_CLASS })),
    ...selected.context.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: CONTEXT_SOURCE_CLASS })),
    ...selected.carePersonal.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: CARE_SOURCE_CLASS })),
    ...selected.careConduct.map((f) => ({ platform: MEMORY_SOURCE_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: CARE_CONDUCT_SOURCE_CLASS })),
  ];
  const now = opts.now ?? new Date();
  return {
    athleteId: row.id,
    name: row.name,
    sport: row.sport,
    socialBlock,
    socialSources,
    evidenceAsOf: evidenceAsOfFor(socialSources, row.createdAt ?? now),
    digest: snapshotDigest({ name: row.name, sport: row.sport, socialBlock, evaluator: miaFactsEvaluatorVersion() }),
    triggerReason,
    triggerDetail: opts.triggerDetail ?? null,
    builtAt: now.toISOString(),
    inputs: {
      publicFactIds: selected.public.map((f) => f.id), measuredFactIds: usedMeasured.map((f) => f.id), connectedPlatforms,
      careFactIds: selected.care.map((f) => f.id), contextFactIds: selected.context.map((f) => f.id),
    },
  };
}

/**
 * The authoritative accounts — ONE MEASURED SOURCE (Oct 2026): her MEASURED memory facts, the latest reading per metric
 * (selectPreviewFacts / selectFactsOnlyInput → latestMeasuredPerMetric), rendered one account per platform.
 *
 * The connected social-features block (connectedBlock) is NOT read here directly: reading it beside memory gave the
 * evaluator two measured sources for one account (the first real run showed two different engagement rates). ONE PLACE,
 * NO LOSS: every metric that block supplied — and every other numeric derived feature — is written into memory as a
 * measured fact (agent/research/measuredSync.ts; latest per metric, with its window, date and a ref to its
 * social_features row), so the M.I.A. reads all of it from memory. Measured memory facts are refreshed right before a
 * preview is computed (preview.ts → syncMemoryMeasured) and after every social sync (on connect, the nightly collection
 * and the nightly feature derivation), so they are the current reading.
 * `connectedPlatforms` (platforms read from the social-features block directly) is therefore always empty.
 */
async function authoritativeAccounts(athleteId: string, measured: PreviewFact[]): Promise<{ accounts: SocialAccountBlock[]; usedMeasured: PreviewFact[]; connectedPlatforms: string[] }> {
  const conns = await db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  const handles = new Map(conns.filter((c) => c.username).map((c) => [c.platform, String(c.username).replace(/^@+/, "")]));
  const fromMemory = measuredAccounts(measured, handles, new Set());
  return { accounts: fromMemory.map((m) => m.account), usedMeasured: fromMemory.flatMap((m) => m.facts), connectedPlatforms: [] };
}

// ── the snapshot ──────────────────────────────────────────────────────────────

export async function loadMemoryFacts(athleteId: string, statuses?: string[]): Promise<PreviewFact[]> {
  const rows = await db.select().from(memoryFacts)
    .where(and(eq(memoryFacts.athlete_id, athleteId), statuses?.length ? inArray(memoryFacts.status, statuses) : undefined));
  return rows.map(toPreviewFact);
}

/** The memory snapshot plus which facts it used (the preview lists them as public vs measured inputs). */
export interface MemoryEvidenceSnapshot extends EvidenceSnapshot {
  inputs: { publicFactIds: string[]; measuredFactIds: string[]; connectedPlatforms: string[]; careFactIds?: string[]; contextFactIds?: string[] };
}

// ── identity, from memory ─────────────────────────────────────────────────────

/** Source refs that anchor who she is: her own name and sport (onboarding) and research's identity record. */
export const IDENTITY_ANCHOR_REF = /#(name|sport|identity)$/;

export interface MemoryIdentity {
  /** True while a disputed identity fact stands unsettled: M.I.A. is withheld and not evaluated. */
  uncertain: boolean;
  /** The disputed identity facts behind it. */
  factIds: string[];
  /** When the earliest of them was recorded (ISO), or null. */
  since: string | null;
}

/**
 * Pure. Uncertain ⇔ some fact is DISPUTED and is an identity anchor or disputes one, and she has not confirmed it.
 * Corrected (superseded) and removed facts are settled by their status; a confirmation settles a disputed one.
 */
export function memoryIdentityFrom(facts: PreviewFact[], confirmedFactIds: ReadonlySet<string>): MemoryIdentity {
  const anchors = new Set(facts.filter((f) => f.sourceRef && IDENTITY_ANCHOR_REF.test(f.sourceRef)).map((f) => f.id));
  const open = facts.filter((f) => f.status === "disputed" && (anchors.has(f.id) || (f.disputes != null && anchors.has(f.disputes))) && !confirmedFactIds.has(f.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { uncertain: open.length > 0, factIds: open.map((f) => f.id), since: open[0]?.createdAt ?? null };
}

export async function readMemoryIdentity(athleteId: string): Promise<MemoryIdentity> {
  const facts = await loadMemoryFacts(athleteId);
  if (!facts.some((f) => f.status === "disputed")) return { uncertain: false, factIds: [], since: null };
  const confirmed = await db.select({ factId: memoryFactReviews.fact_id }).from(memoryFactReviews)
    .where(and(eq(memoryFactReviews.athlete_id, athleteId), eq(memoryFactReviews.action, "confirm")));
  return memoryIdentityFrom(facts, new Set(confirmed.map((c) => c.factId)));
}
