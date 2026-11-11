/**
 * services/meKnows.ts — What Nomila knows on the agent memory (contract knows/1, shared/meScouting.ts): every fact
 * in memory_facts with where it came from, grouped by topic, and your edits to them.
 *
 *   read     getKnows(athleteId, subject)   facts that are active or disputed, filed by research topic into the
 *                                           screen's sections; care facts (sensitive) only in `private`; hidden facts
 *                                           (status removed) in `hidden`; "made" facts never (they show where used)
 *            getFactDetail(athleteId, id)   one fact, its supersede chain and every review of it, and where it is used
 *   writes   correct · hide · restore · dispute · confirm — each a memory_fact_reviews row; a correction is a NEW
 *            "said" fact that supersedes the old one (nothing is overwritten). Every write but confirm asks for a
 *            re-run (agent/memoryRerun.ts), which re-runs only what used the fact after a 30-minute quiet window.
 *
 * Tenancy: every statement filters by the athlete id from the token; another athlete's fact id reads as not found.
 * No model call anywhere here. Nothing names an athlete, sport, school or brand.
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db } from "../db";
import { memoryBriefs, memoryFactReviews, memoryFacts } from "../../shared/schema";
import { isAboutAthlete, type FactSubjectFilter, type MemoryFact } from "../../shared/agent";
import {
  KNOWS_CONTRACT, KNOWS_SECTIONS, knowsSectionOf,
  type DisputeSeed, type KnowsFact, type KnowsFactDetail, type KnowsResponse, type KnowsView, type Provenance, type RerunNotice,
} from "../../shared/meScouting";
import { factFromRow } from "../agent/research/dbStore";
import { cleanNewFact, FactHygieneError } from "../agent/factHygiene";
import { checkFactSource } from "../agent/policy";
import { athleteNameFor } from "../agent/onboarding/service";
import { requestMemoryRerun } from "../agent/memoryRerun";

export class KnowsError extends Error {
  constructor(message: string, public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Below this, a fact reads as "couldn't confirm". */
export const UNCONFIRMED_BELOW = 0.5;

// ─── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** you = said · found = found with a public URL · accounts = measured, or found with only a reference (inbox, deals). */
export function provenanceOf(f: Pick<MemoryFact, "type" | "source">): Provenance {
  if (f.type === "said") return "you";
  if (f.type === "found" && f.source.url) return "found";
  return "accounts";
}

function sourcesOf(f: MemoryFact): KnowsFact["sources"] {
  const first = f.type === "said" ? { label: "You told us" }
    : f.source.url ? { label: f.source.title || hostOf(f.source.url), url: f.source.url }
    : { label: f.source.title || "Your accounts" };
  return [first, ...(f.alsoSeenAt ?? []).map((s) => ({ label: s.title || hostOf(s.url), url: s.url }))];
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export function toKnowsFact(f: MemoryFact, ctx: { athleteName: string; disputedBy: ReadonlySet<string>; confirmed: ReadonlySet<string> }): KnowsFact {
  return {
    id: f.id, claim: f.claim, topic: f.topic ?? null, provenance: provenanceOf(f),
    unconfirmed: f.status === "disputed" || f.confidence < UNCONFIRMED_BELOW || ctx.disputedBy.has(f.id),
    confirmedByYou: ctx.confirmed.has(f.id),
    date: f.date, datePrecision: f.datePrecision ?? null, confidence: f.confidence, status: f.status === "disputed" ? "disputed" : "active",
    sources: sourcesOf(f), alsoSeen: (f.alsoSeenAt ?? []).length,
    subject: { kind: f.subject.kind, name: f.subject.name },
    about: isAboutAthlete(f.subject, ctx.athleteName) ? "athlete" : "others",
    editable: f.type !== "measured",
  };
}

const byNewest = (a: MemoryFact, b: MemoryFact) =>
  (b.date ?? "").localeCompare(a.date ?? "") || b.createdAt.localeCompare(a.createdAt);

/**
 * Pure: the grouped view from every fact the athlete holds (any status). `confirmed` = fact ids with a confirm review.
 */
export function buildKnowsView(all: MemoryFact[], o: { athleteName: string; subject: FactSubjectFilter; confirmed: ReadonlySet<string>; asOf: string }): KnowsView {
  const keep = (f: MemoryFact) => f.type !== "made" && (o.subject === "all" || isAboutAthlete(f.subject, o.athleteName) === (o.subject === "athlete"));
  const visible = all.filter((f) => (f.status === "active" || f.status === "disputed") && keep(f)).sort(byNewest);
  const hidden = all.filter((f) => f.status === "removed" && keep(f)).sort(byNewest);
  const disputedBy = new Set(all.filter((f) => f.status === "active" || f.status === "disputed").map((f) => f.disputes).filter((x): x is string => !!x));
  const ctx = { athleteName: o.athleteName, disputedBy, confirmed: o.confirmed };
  const shown = visible.map((f) => ({ f, k: toKnowsFact(f, ctx) }));
  const priv = shown.filter((x) => x.f.sensitive).map((x) => x.k);
  const open = shown.filter((x) => !x.f.sensitive);
  const facts = shown.map((x) => x.k);
  return {
    contract: KNOWS_CONTRACT, status: "ready", asOf: o.asOf, subject: o.subject,
    counts: {
      total: facts.length,
      you: facts.filter((k) => k.provenance === "you").length,
      found: facts.filter((k) => k.provenance === "found").length,
      accounts: facts.filter((k) => k.provenance === "accounts").length,
      unconfirmed: facts.filter((k) => k.unconfirmed).length,
      hidden: hidden.length,
      private: priv.length,
    },
    sections: KNOWS_SECTIONS.map((key) => ({ key, facts: open.filter((x) => knowsSectionOf({ topic: x.f.topic ?? null, type: x.f.type }) === key).map((x) => x.k) })),
    private: priv,
    hidden: hidden.map((f) => ({ id: f.id, claim: f.claim })),
  };
}

// ─── reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function allFacts(athleteId: string): Promise<MemoryFact[]> {
  const rows = await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId)).orderBy(asc(memoryFacts.created_at));
  return rows.map(factFromRow);
}

async function confirmedIds(athleteId: string): Promise<Set<string>> {
  const rows = await db.select({ id: memoryFactReviews.fact_id }).from(memoryFactReviews)
    .where(and(eq(memoryFactReviews.athlete_id, athleteId), eq(memoryFactReviews.action, "confirm")));
  return new Set(rows.map((r) => r.id));
}

/** The facts, the athlete's name (for the about-you rule) and the confirmed ids: what every Knows read starts from. */
export async function knowsInputs(athleteId: string): Promise<{ facts: MemoryFact[]; athleteName: string; confirmed: Set<string> }> {
  const facts = await allFacts(athleteId);
  if (!facts.length) return { facts, athleteName: "", confirmed: new Set() };
  const [athleteName, confirmed] = await Promise.all([athleteNameFor(athleteId, facts), confirmedIds(athleteId)]);
  return { facts, athleteName, confirmed };
}

/** GET /me/facts. An athlete with no memory facts gets the explicit empty state (the client keeps the old screens). */
export async function getKnows(athleteId: string, subject: FactSubjectFilter = "athlete", now: Date = new Date()): Promise<KnowsResponse> {
  const i = await knowsInputs(athleteId);
  if (!i.facts.length) return { contract: KNOWS_CONTRACT, status: "no_memory" };
  return buildKnowsView(i.facts, { athleteName: i.athleteName, subject, confirmed: i.confirmed, asOf: now.toISOString() });
}

async function factRow(athleteId: string, id: string): Promise<MemoryFact> {
  if (!UUID.test(id)) throw new KnowsError("fact not found", 404, "not_found");
  const [row] = await db.select().from(memoryFacts).where(and(eq(memoryFacts.id, id), eq(memoryFacts.athlete_id, athleteId))).limit(1);
  if (!row) throw new KnowsError("fact not found", 404, "not_found");
  return factFromRow(row);
}

/** GET /me/facts/:id — the fact sheet: provenance, sources, history (versions oldest first, then reviews), where used. */
export async function getFactDetail(athleteId: string, id: string): Promise<KnowsFactDetail> {
  const fact = await factRow(athleteId, id);
  const i = await knowsInputs(athleteId);
  // The chain: walk back through what this fact superseded, and forward through what superseded it.
  const byId = new Map(i.facts.map((f) => [f.id, f]));
  const supersededBy = new Map(i.facts.filter((f) => f.supersededBy).map((f) => [f.supersededBy!, f.id]));
  const chain: MemoryFact[] = [fact];
  for (let prev = supersededBy.get(fact.id); prev && chain.length < 50; prev = supersededBy.get(prev)) chain.unshift(byId.get(prev)!);
  for (let next = fact.supersededBy; next && byId.get(next) && chain.length < 50; next = byId.get(next)!.supersededBy) chain.push(byId.get(next)!);
  const ids = chain.map((f) => f.id);
  const reviews = await db.select().from(memoryFactReviews)
    .where(and(eq(memoryFactReviews.athlete_id, athleteId), inArray(memoryFactReviews.fact_id, ids))).orderBy(asc(memoryFactReviews.created_at));
  const [brief] = await db.select({ ids: memoryBriefs.fact_ids }).from(memoryBriefs)
    .where(and(eq(memoryBriefs.athlete_id, athleteId), eq(memoryBriefs.status, "current"))).limit(1);
  const cited = new Set(Array.isArray(brief?.ids) ? (brief!.ids as unknown[]).map(String) : []);
  const { readMiaPreview } = await import("./miaPreview/preview");
  const preview = await readMiaPreview(athleteId);
  const inMia = new Set([...preview.inputs.public, ...preview.inputs.measured].map((x) => x.factId).filter(Boolean));
  const disputedBy = new Set(i.facts.filter((f) => f.status === "active" || f.status === "disputed").map((f) => f.disputes).filter((x): x is string => !!x));
  const k = toKnowsFact(fact, { athleteName: i.athleteName, disputedBy, confirmed: i.confirmed });
  return {
    fact: { ...k, status: fact.status as KnowsFactDetail["fact"]["status"] },
    history: [
      ...chain.map((f) => ({ kind: "version" as const, id: f.id, claim: f.claim, provenance: provenanceOf(f), status: f.status, at: f.createdAt })),
      ...reviews.map((r) => ({ kind: "review" as const, action: r.action, correction: r.correction ?? null, at: r.created_at.toISOString() })),
    ],
    usedIn: { scouting: ids.some((x) => cited.has(x)), mia: ids.some((x) => inMia.has(x)) },
  };
}

// ─── writes ───────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * PATCH /me/facts/:id — your correction: a new "said" fact (confidence 1, your words) supersedes the old one, and a
 * `correct` review links the two. One transaction. Only an active or disputed fact can be corrected; one already
 * superseded answers 409 with the fact that replaced it; a measured fact is fixed at its source (400).
 */
export async function correctFact(athleteId: string, id: string, body: { claim?: unknown; date?: unknown }): Promise<{ fact: KnowsFact; rerun: RerunNotice }> {
  const claim = typeof body.claim === "string" ? body.claim.trim() : "";
  if (!claim || claim.length > 2000) throw new KnowsError("claim is required (at most 2000 characters)", 400, "invalid");
  if (body.date != null && (typeof body.date !== "string" || !DAY.test(body.date))) throw new KnowsError("date must be YYYY-MM-DD", 400, "invalid");
  const old = await factRow(athleteId, id);
  if (old.status === "superseded") throw new KnowsError("this fact was already replaced", 409, "superseded", { currentId: old.supersededBy });
  if (old.status === "removed") throw new KnowsError("this fact is hidden; restore it first", 409, "hidden");
  if (old.type === "measured") throw new KnowsError("this number comes from your connected account; it updates from there", 400, "not_editable");

  let next;
  try {
    next = cleanNewFact({
      subject: old.subject, claim, type: "said",
      source: { ref: `knows:${old.id}#correction`, title: "You told us" },
      date: (body.date as string | null | undefined) ?? new Date().toISOString().slice(0, 10), confidence: 1, runId: null,
    });
  } catch (err) {
    throw new KnowsError(err instanceof FactHygieneError ? err.message : "invalid claim", 400, "invalid");
  }
  const verdict = checkFactSource(next.source);
  if (verdict.decision !== "allow") throw new KnowsError(verdict.reason, 400, "invalid");

  const { created, at } = await db.transaction(async (tx) => {
    const [row] = await tx.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: next.subject.kind, subject_name: next.subject.name.slice(0, 300), subject_id: next.subject.id ?? null,
      claim: next.claim, type: "said", source_ref: next.source.ref ?? null, source_title: next.source.title ?? null,
      observed_on: next.date, confidence: 1, status: "active",
      // Your version keeps what the fact was about and how carefully it is handled.
      sensitive: !!old.sensitive, care_kind: old.sensitive ? old.careKind ?? null : null, topic: old.topic ?? null,
    }).returning();
    const moved = await tx.update(memoryFacts).set({ status: "superseded", superseded_by: row.id, updated_at: new Date() })
      .where(and(eq(memoryFacts.id, old.id), eq(memoryFacts.athlete_id, athleteId), or(eq(memoryFacts.status, "active"), eq(memoryFacts.status, "disputed"))))
      .returning({ id: memoryFacts.id });
    if (!moved.length) throw new KnowsError("this fact changed while you were editing it", 409, "conflict");
    const [review] = await tx.insert(memoryFactReviews).values({ athlete_id: athleteId, fact_id: old.id, action: "correct", correction: claim, replacement_fact_id: row.id })
      .returning({ at: memoryFactReviews.created_at });
    return { created: factFromRow(row), at: review.at };
  });
  const i = await knowsInputs(athleteId);
  return { fact: toKnowsFact(created, { athleteName: i.athleteName, disputedBy: new Set(), confirmed: new Set() }), rerun: await requestMemoryRerun(athleteId, at) };
}

async function review(athleteId: string, factId: string, action: "confirm" | "remove" | "restore" | "dispute", note: string | null): Promise<Date> {
  const [r] = await db.insert(memoryFactReviews).values({ athlete_id: athleteId, fact_id: factId, action, note }).returning({ at: memoryFactReviews.created_at });
  return r.at;
}

const noteOf = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v !== "string" || v.length > 2000) throw new KnowsError("note must be text (at most 2000 characters)", 400, "invalid");
  return v.trim() || null;
};

/** DELETE /me/facts/:id — hide: status removed. The row is kept and never used again; Restore undoes it. */
export async function hideFact(athleteId: string, id: string, body: { note?: unknown } = {}): Promise<RerunNotice> {
  const note = noteOf(body.note);
  const f = await factRow(athleteId, id);
  if (f.status === "removed") return { runId: null, after: null };
  if (f.status === "superseded") throw new KnowsError("this fact was already replaced", 409, "superseded", { currentId: f.supersededBy });
  await db.update(memoryFacts).set({ status: "removed", updated_at: new Date() }).where(and(eq(memoryFacts.id, f.id), eq(memoryFacts.athlete_id, athleteId)));
  return requestMemoryRerun(athleteId, await review(athleteId, f.id, "remove", note));
}

/** POST /me/facts/:id/restore — undo a hide: back to active. */
export async function restoreFact(athleteId: string, id: string): Promise<{ fact: KnowsFact; rerun: RerunNotice }> {
  const f = await factRow(athleteId, id);
  if (f.status !== "removed") throw new KnowsError("only a hidden fact can be restored", 409, "not_hidden");
  await db.update(memoryFacts).set({ status: "active", updated_at: new Date() }).where(and(eq(memoryFacts.id, f.id), eq(memoryFacts.athlete_id, athleteId), eq(memoryFacts.status, "removed")));
  const rerun = await requestMemoryRerun(athleteId, await review(athleteId, f.id, "restore", null));
  const i = await knowsInputs(athleteId);
  return { fact: toKnowsFact({ ...f, status: "active" }, { athleteName: i.athleteName, disputedBy: new Set(), confirmed: i.confirmed }), rerun };
}

/**
 * POST /me/facts/:id/dispute — "this isn't right": status disputed, a `dispute` review (your words, if any, as its
 * note), and a seed the app opens Mila with: the fact and the other facts about the same subject and topic. A fact
 * already disputed answers the seed again (no second review).
 */
export async function disputeFact(athleteId: string, id: string, body: { said?: unknown } = {}): Promise<{ seed: DisputeSeed; rerun: RerunNotice }> {
  const said = noteOf(body.said);
  const f = await factRow(athleteId, id);
  if (f.status === "superseded") throw new KnowsError("this fact was already replaced", 409, "superseded", { currentId: f.supersededBy });
  if (f.status === "removed") throw new KnowsError("this fact is hidden; restore it first", 409, "hidden");
  let rerun: RerunNotice = { runId: null, after: null };
  if (f.status === "active") {
    await db.update(memoryFacts).set({ status: "disputed", updated_at: new Date() }).where(and(eq(memoryFacts.id, f.id), eq(memoryFacts.athlete_id, athleteId), eq(memoryFacts.status, "active")));
    rerun = await requestMemoryRerun(athleteId, await review(athleteId, f.id, "dispute", said));
  }
  const all = await allFacts(athleteId);
  const alternatives = all
    .filter((x) => x.id !== f.id && (x.status === "active" || x.status === "disputed") && x.type !== "made" && !x.sensitive
      && x.subject.kind === f.subject.kind && x.subject.name.trim().toLowerCase() === f.subject.name.trim().toLowerCase()
      && (x.topic ?? null) === (f.topic ?? null))
    .sort(byNewest).slice(0, 4).map((x) => ({ id: x.id, claim: x.claim }));
  return { seed: { factId: f.id, claim: f.claim, alternatives }, rerun };
}

/** POST /me/facts/:id/confirm — "that's right": a confirm review. Re-runs nothing. */
export async function confirmFact(athleteId: string, id: string): Promise<void> {
  const f = await factRow(athleteId, id);
  if (f.status !== "active" && f.status !== "disputed") throw new KnowsError("only a fact in use can be confirmed", 409, "not_active");
  await review(athleteId, f.id, "confirm", null);
}
