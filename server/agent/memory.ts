/**
 * agent/memory.ts — the four memory layers. Every function takes the athlete id first and filters by it; nothing here
 * reads or writes across athletes.
 *
 *   evidence      memory_facts       sourced facts; a new fact can supersede an old one; conflicts are 'disputed'
 *   brief         memory_briefs      the current read, versioned; writing a new one supersedes the current one
 *   decisions     memory_decisions   suggested / why / evidence → her response → the outcome
 *   preferences   memory_preferences voice, avoid, standing rules, style
 *
 * CLEAN START: these begin empty; nothing is imported from the old intelligence tables.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { memoryBriefs, memoryDecisions, memoryFacts, memoryPreferences, type MemoryBriefRow, type MemoryDecisionRow, type MemoryFactRow, type MemoryPreferenceRow } from "../../shared/schema";
import type { Brief, BriefSection, Decision, DecisionOutcome, DecisionResponse, EvidenceRef, FactStatus, FactType, MemoryFact, Preference, PreferenceKind, SubjectRef } from "../../shared/agent";
import { checkFactSource } from "./policy";
import { cleanNewFact, FactHygieneError } from "./factHygiene";

export class MemoryError extends Error {}

// ─── evidence ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewFact {
  subject: SubjectRef;
  claim: string;
  type: FactType;
  source: { url?: string | null; ref?: string | null; title?: string | null };
  date?: string | null;
  confidence: number;
  status?: Exclude<FactStatus, "superseded">;
}

export function toMemoryFact(r: MemoryFactRow): MemoryFact {
  return {
    id: r.id,
    athleteId: r.athlete_id,
    subject: { kind: r.subject_kind as SubjectRef["kind"], name: r.subject_name, ...(r.subject_id ? { id: r.subject_id } : {}) },
    claim: r.claim,
    type: r.type as FactType,
    source: { ...(r.source_url ? { url: r.source_url } : {}), ...(r.source_ref ? { ref: r.source_ref } : {}), ...(r.source_title ? { title: r.source_title } : {}) },
    date: r.observed_on ?? null,
    confidence: r.confidence,
    status: r.status as FactStatus,
    supersededBy: r.superseded_by ?? null,
    runId: r.run_id ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function writeFact(athleteId: string, raw: NewFact, runId: string | null = null, tx: typeof db = db): Promise<MemoryFact> {
  // The same formatting rules as every other memory_facts writer (agent/factHygiene.ts).
  let f: NewFact;
  try { f = cleanNewFact(raw); } catch (err) { throw new MemoryError(err instanceof FactHygieneError ? err.message : String(err)); }
  const verdict = checkFactSource(f.source);
  if (verdict.decision !== "allow") throw new MemoryError(verdict.reason);
  if (!(f.confidence >= 0 && f.confidence <= 1)) throw new MemoryError("confidence must be between 0 and 1");
  const [row] = await tx.insert(memoryFacts).values({
    athlete_id: athleteId,
    subject_kind: f.subject.kind,
    subject_name: f.subject.name,
    subject_id: f.subject.id ?? null,
    claim: f.claim,
    type: f.type,
    source_url: f.source.url?.trim() || null,
    source_ref: f.source.ref?.trim() || null,
    source_title: f.source.title?.trim() || null,
    observed_on: f.date ?? null,
    confidence: f.confidence,
    status: f.status ?? "active",
    run_id: runId,
  }).returning();
  return toMemoryFact(row);
}

export async function listFacts(athleteId: string, opts: { status?: FactStatus; limit?: number } = {}): Promise<MemoryFact[]> {
  const where = opts.status ? and(eq(memoryFacts.athlete_id, athleteId), eq(memoryFacts.status, opts.status)) : eq(memoryFacts.athlete_id, athleteId);
  const rows = await db.select().from(memoryFacts).where(where).orderBy(desc(memoryFacts.created_at)).limit(Math.min(opts.limit ?? 50, 200));
  return rows.map(toMemoryFact);
}

export async function factsByIds(athleteId: string, ids: string[]): Promise<MemoryFact[]> {
  if (!ids.length) return [];
  const rows = await db.select().from(memoryFacts).where(and(eq(memoryFacts.athlete_id, athleteId), inArray(memoryFacts.id, ids)));
  return rows.map(toMemoryFact);
}

/** Replace a fact with a newer one: the old one becomes 'superseded' and points at the new one. One transaction. */
export async function supersedeFact(athleteId: string, oldId: string, next: NewFact, runId: string | null = null): Promise<MemoryFact> {
  return db.transaction(async (tx) => {
    const [old] = await tx.select({ id: memoryFacts.id, status: memoryFacts.status }).from(memoryFacts)
      .where(and(eq(memoryFacts.id, oldId), eq(memoryFacts.athlete_id, athleteId))).limit(1);
    if (!old) throw new MemoryError("fact not found");
    if (old.status === "superseded") throw new MemoryError("fact is already superseded");
    const created = await writeFact(athleteId, next, runId, tx as unknown as typeof db);
    await tx.update(memoryFacts).set({ status: "superseded", superseded_by: created.id, updated_at: new Date() })
      .where(and(eq(memoryFacts.id, oldId), eq(memoryFacts.athlete_id, athleteId)));
    return created;
  });
}

export async function disputeFact(athleteId: string, id: string): Promise<boolean> {
  const rows = await db.update(memoryFacts).set({ status: "disputed", updated_at: new Date() })
    .where(and(eq(memoryFacts.id, id), eq(memoryFacts.athlete_id, athleteId), eq(memoryFacts.status, "active")))
    .returning({ id: memoryFacts.id });
  return rows.length > 0;
}

// ─── brief ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function toBrief(r: MemoryBriefRow): Brief {
  return {
    id: r.id, athleteId: r.athlete_id, version: r.version, status: r.status as Brief["status"], summary: r.summary,
    sections: r.sections as BriefSection[], factIds: r.fact_ids as string[], runId: r.run_id ?? null, createdAt: r.created_at.toISOString(),
  };
}

export async function currentBrief(athleteId: string): Promise<Brief | null> {
  const [row] = await db.select().from(memoryBriefs).where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current"))).limit(1);
  return row ? toBrief(row) : null;
}

/** Write a new current brief (version + 1); the previous current one becomes superseded. One transaction. */
export async function writeBrief(athleteId: string, b: { summary: string; sections: BriefSection[] }, runId: string | null = null): Promise<Brief> {
  const factIds = [...new Set(b.sections.flatMap((s) => s.factIds))];
  return db.transaction(async (tx) => {
    const [latest] = await tx.select({ version: memoryBriefs.version }).from(memoryBriefs)
      .where(eq(memoryBriefs.athlete_id, athleteId)).orderBy(desc(memoryBriefs.version)).limit(1);
    await tx.update(memoryBriefs).set({ status: "superseded" }).where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current")));
    const [row] = await tx.insert(memoryBriefs).values({
      athlete_id: athleteId, version: (latest?.version ?? 0) + 1, summary: b.summary, sections: b.sections, fact_ids: factIds, run_id: runId,
    }).returning();
    return toBrief(row);
  });
}

// ─── decisions + outcomes ─────────────────────────────────────────────────────────────────────────────────────────

export function toDecision(r: MemoryDecisionRow): Decision {
  return {
    id: r.id, athleteId: r.athlete_id, runId: r.run_id ?? null, skillId: r.skill_id, suggested: r.suggested, why: r.why,
    evidence: r.evidence as EvidenceRef[], response: r.response as DecisionResponse, responseReason: r.response_reason ?? null,
    respondedAt: r.responded_at ? r.responded_at.toISOString() : null, outcome: r.outcome as DecisionOutcome,
    outcomeNote: r.outcome_note ?? null, outcomeAt: r.outcome_at ? r.outcome_at.toISOString() : null,
    approvalId: r.approval_id ?? null, createdAt: r.created_at.toISOString(),
  };
}

export async function recordDecision(athleteId: string, d: { skillId: string; suggested: string; why: string; evidence: EvidenceRef[]; approvalId?: string | null }, runId: string | null = null): Promise<Decision> {
  const [row] = await db.insert(memoryDecisions).values({
    athlete_id: athleteId, run_id: runId, skill_id: d.skillId, suggested: d.suggested, why: d.why, evidence: d.evidence, approval_id: d.approvalId ?? null,
  }).returning();
  return toDecision(row);
}

export async function respondToDecision(athleteId: string, id: string, response: Exclude<DecisionResponse, "pending">, reason: string | null = null): Promise<Decision | null> {
  const [row] = await db.update(memoryDecisions).set({ response, response_reason: reason, responded_at: new Date() })
    .where(and(eq(memoryDecisions.id, id), eq(memoryDecisions.athlete_id, athleteId))).returning();
  return row ? toDecision(row) : null;
}

export async function recordOutcome(athleteId: string, id: string, outcome: Exclude<DecisionOutcome, "unknown">, note: string | null = null): Promise<Decision | null> {
  const [row] = await db.update(memoryDecisions).set({ outcome, outcome_note: note, outcome_at: new Date() })
    .where(and(eq(memoryDecisions.id, id), eq(memoryDecisions.athlete_id, athleteId))).returning();
  return row ? toDecision(row) : null;
}

export async function listDecisions(athleteId: string, limit = 50): Promise<Decision[]> {
  const rows = await db.select().from(memoryDecisions).where(eq(memoryDecisions.athlete_id, athleteId)).orderBy(desc(memoryDecisions.created_at)).limit(Math.min(limit, 200));
  return rows.map(toDecision);
}

// ─── preferences ──────────────────────────────────────────────────────────────────────────────────────────────────

export function toPreference(r: MemoryPreferenceRow): Preference {
  return {
    id: r.id, athleteId: r.athlete_id, kind: r.kind as PreferenceKind, statement: r.statement, source: r.source as Preference["source"],
    status: r.status as Preference["status"], runId: r.run_id ?? null, createdAt: r.created_at.toISOString(),
  };
}

export async function addPreference(athleteId: string, p: { kind: PreferenceKind; statement: string; source: Preference["source"] }, runId: string | null = null): Promise<Preference> {
  const [row] = await db.insert(memoryPreferences).values({ athlete_id: athleteId, kind: p.kind, statement: p.statement, source: p.source, run_id: runId }).returning();
  return toPreference(row);
}

/**
 * Terms the athlete has marked never-use (e.g. a child's name): "avoid" preferences written as "Never use: Name[, Name]"
 * (or "Never name: …"). The policy blocks them in anything outgoing. The parse is pure and lives in neverTerms.ts.
 */
export { NEVER_TERMS_RE, neverTermsFrom } from "./neverTerms";
import { neverTermsFrom } from "./neverTerms";
export async function neverTermsFor(athleteId: string): Promise<string[]> {
  return neverTermsFrom(await listPreferences(athleteId));
}

export async function listPreferences(athleteId: string): Promise<Preference[]> {
  const rows = await db.select().from(memoryPreferences)
    .where(and(eq(memoryPreferences.athlete_id, athleteId), eq(memoryPreferences.status, "active")))
    .orderBy(desc(memoryPreferences.created_at));
  return rows.map(toPreference);
}

export async function retirePreference(athleteId: string, id: string): Promise<boolean> {
  const rows = await db.update(memoryPreferences).set({ status: "retired", retired_at: new Date() })
    .where(and(eq(memoryPreferences.id, id), eq(memoryPreferences.athlete_id, athleteId), eq(memoryPreferences.status, "active")))
    .returning({ id: memoryPreferences.id });
  return rows.length > 0;
}
