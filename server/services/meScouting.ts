/**
 * services/meScouting.ts — the Scouting report on the agent memory (contract scouting/1, shared/meScouting.ts).
 *
 * One read, no model call. Everything is read as stored:
 *   hero          the current Brief's display: positioning.statement, and stage { label, band } (null for an unclear band);
 *                 identity: team · position · level from the identity facts about you (memory_facts.field, 0119)
 *   defines       display.positioning: from (today) → to (where you're headed), and its first three pillars
 *   mia           the M.I.A. preview of record (readMiaPreview, SELECTs only), in Home's shape
 *   notes         the read's strengths / constraints / missing data (the assessment's notes), each tagged with the
 *                 dimension the facts-only evaluator (0.4.0) gave it — recovered from that evaluation run's stored raw
 *                 answer; a note with no tag stays untagged (dimension and group null), never guessed
 *   brands        the Brief's internal sponsor lists, kept only where a fact ABOUT YOU backs the brand (isAboutAthlete:
 *                 a team's, club's or school's sponsor never shows as yours); logos from inbox_brands (brandDomainsFor);
 *                 startedOn = the earliest start a backed entry states (understand 1.10.0 `since`), else null
 *   conflicts     the Brief's exclusivity and category conflicts (Understand 1.9.0): what each is and what it blocks,
 *                 kept only while a fact it rests on is still in use
 *   knows         the What Nomila knows counts (the same view, subject = you)
 *   riskUpside    the Brief's biggest upside and risk (agent/plan/input riskUpsideOf, the same read the Goals route makes)
 *
 * The internal read itself never leaves the server whole: only brand names that facts about you back, with those facts'
 * ids, and the conflicts' words.
 * Nothing here names an athlete, sport, school or brand.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { miaEvaluationRuns } from "../../shared/schema";
import { IDENTITY_FIELDS, isAboutAthlete, type IdentityField, type MemoryFact, type MiaPreview } from "../../shared/agent";
import {
  CAREER_BANDS, IDENTITY_LINE_FIELDS, MIA_DIMENSION_GROUP, miaDimensionOf, SCOUTING_CONTRACT,
  type CareerBand, type ScoutBrand, type ScoutConflict, type ScoutIdentityPart, type ScoutingReport, type ScoutingResponse, type ScoutNote,
} from "../../shared/meScouting";
import type { BriefInternal, StoredBrief } from "../agent/research/store";
import { dbStore } from "../agent/research/dbStore";
import { buildKnowsView, knowsInputs } from "./meKnows";
import { notesFrom, type TaggedNote, type TaggedNotes } from "./miaPreview/factsOnlySpec";
import { riskUpsideOf } from "../agent/plan/input";

/** How many notes "Working for you" and "Room to grow" show. */
export const TOP_NOTES = 2;

// ─── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** A note's text tagged with the dimension the evaluator gave the same text, or untagged. */
export function tagNote(text: string, tagged: readonly TaggedNote[]): ScoutNote {
  const hit = tagged.find((t) => norm(t.text) === norm(text));
  const dimension = miaDimensionOf(hit?.dimension);
  return { text, dimension, group: dimension ? MIA_DIMENSION_GROUP[dimension] : null };
}

/** Pure: partners from the Brief's sponsor lists, each kept only when an in-use fact about you backs it. */
export function scoutBrands(internal: BriefInternal | null, facts: readonly MemoryFact[], athleteName: string, logos: { domains: Map<string, string>; logoUrls: Map<string, string> }): ScoutingReport["brands"] {
  const aboutYou = new Map(facts.filter((f) => (f.status === "active" || f.status === "disputed") && isAboutAthlete(f.subject, athleteName)).map((f) => [f.id, f]));
  const byName = new Map<string, { name: string; current: boolean; past: boolean; facts: MemoryFact[]; since: string[] }>();
  const add = (list: BriefInternal["currentSponsors"] | undefined, which: "current" | "past") => {
    for (const s of list ?? []) {
      const name = (s?.name ?? "").trim();
      if (!name) continue;
      const backing = (s.factIds ?? []).map((id) => aboutYou.get(id)).filter((f): f is MemoryFact => !!f);
      if (!backing.length) continue;   // not about you: someone else's partner, or nothing on record any more
      const key = name.toLowerCase();
      const e = byName.get(key) ?? { name, current: false, past: false, facts: [], since: [] };
      e[which] = true;
      if (typeof s.since === "string" && /^\d{4}(-\d{2})?$/.test(s.since)) e.since.push(s.since);
      for (const f of backing) if (!e.facts.some((x) => x.id === f.id)) e.facts.push(f);
      byName.set(key, e);
    }
  };
  add(internal?.currentSponsors, "current");
  add(internal?.pastSponsors, "past");
  const out: ScoutingReport["brands"] = { current: [], past: [], unclear: [] };
  for (const [key, e] of byName) {
    const settled = e.facts.filter((f) => f.status === "active");
    // Unclear: the record lists it as both current and past, or every fact behind it is disputed.
    const status: ScoutBrand["status"] = (e.current && e.past) || !settled.length ? "unclear" : e.current ? "current" : "past";
    const dates = settled.map((f) => f.date).filter((d): d is string => !!d).sort();
    out[status].push({
      name: e.name, logoDomain: logos.domains.get(key) ?? null, logoUrl: logos.logoUrls.get(key) ?? null,
      latestConfirmedOn: dates.length ? dates[dates.length - 1] : null, startedOn: e.since.sort()[0] ?? null, status, factIds: e.facts.map((f) => f.id),
    });
  }
  return out;
}

/**
 * Pure: the identity line from the identity facts about you (active only). One fact per field: what you told us (said)
 * first, then the newest date, then the most confident, then the newest written.
 */
export function scoutIdentity(facts: readonly MemoryFact[], athleteName: string): ScoutingReport["hero"]["identity"] {
  const best = new Map<IdentityField, MemoryFact>();
  const rank = (f: MemoryFact) => [f.type === "said" ? 1 : 0, f.date ?? "", f.confidence, f.createdAt] as const;
  const better = (a: MemoryFact, b: MemoryFact) => {
    const x = rank(a); const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  for (const f of facts) {
    if (f.status !== "active" || !f.field || !f.fieldValue?.trim() || !isAboutAthlete(f.subject, athleteName)) continue;
    const cur = best.get(f.field);
    if (!cur || better(f, cur)) best.set(f.field, f);
  }
  const parts: ScoutIdentityPart[] = IDENTITY_FIELDS.filter((k) => best.has(k)).map((k) => ({ field: k, value: best.get(k)!.fieldValue!.trim(), factId: best.get(k)!.id }));
  const shown = IDENTITY_LINE_FIELDS.map((k) => parts.find((p) => p.field === k)?.value).filter((v): v is string => !!v);
  return { line: shown.length ? shown.join(" · ") : null, parts };
}

/** Pure: the Brief's conflicts, each keeping only the facts still in use; one with none left is not shown. */
export function scoutConflicts(internal: BriefInternal | null, facts: readonly MemoryFact[]): ScoutConflict[] {
  const inUse = new Set(facts.filter((f) => f.status === "active" || f.status === "disputed").map((f) => f.id));
  return (internal?.exclusivityConflicts ?? []).flatMap((c) => {
    const factIds = (c?.factIds ?? []).filter((id) => inUse.has(id));
    const what = (c?.what ?? "").trim();
    const blocks = (c?.blocks ?? []).map((b) => String(b ?? "").trim()).filter(Boolean);
    return what && blocks.length && factIds.length ? [{ what, blocks, factIds }] : [];
  });
}

export interface ScoutingInputs {
  brief: StoredBrief | null;
  internal: BriefInternal | null;
  facts: MemoryFact[];
  athleteName: string;
  confirmed: ReadonlySet<string>;
  preview: MiaPreview | null;
  tagged: TaggedNotes | null;
  logos: { domains: Map<string, string>; logoUrls: Map<string, string> };
}

/** Pure: the report from what is stored. */
export function buildScoutingReport(i: ScoutingInputs): ScoutingReport {
  const display = i.brief?.display ?? null;
  const band = display?.stage?.band;
  const stage = display?.stage?.label?.trim() && (CAREER_BANDS as readonly string[]).includes(band ?? "")
    ? { label: display.stage.label.trim(), band: band as CareerBand } : null;
  const p = display?.positioning ?? null;
  const pillars = (p?.pillars ?? []).filter((x) => x?.name?.trim()).slice(0, 3)
    .map((x, n) => ({ key: `pillar_${n + 1}`, label: x.name.trim(), definition: (x.line ?? "").trim() }));
  const today = p?.from?.trim() || null;
  const headed = p?.to?.trim() || null;

  const preview = i.preview && i.preview.status === "ready" && i.preview.score != null ? i.preview : null;
  const a = preview?.assessment ?? null;
  const tag = (list: string[], tagged: TaggedNote[] | undefined) => list.map((t) => tagNote(t, tagged ?? []));
  const notes = a ? {
    strengths: tag(a.notes.strengths, i.tagged?.keyStrengths),
    growth: tag(a.notes.constraints, i.tagged?.keyConstraints),
    missing: tag(a.notes.missingEvidence, i.tagged?.importantMissingData),
  } : null;

  const knows = buildKnowsView(i.facts, { athleteName: i.athleteName, subject: "athlete", confirmed: i.confirmed, asOf: "" });
  return {
    contract: SCOUTING_CONTRACT,
    status: i.brief ? "ready" : "no_brief",
    version: i.brief?.version ?? null,
    updatedOn: i.brief ? i.brief.createdAt.slice(0, 10) : null,
    hero: { statement: p?.statement?.trim() || null, stage, identity: scoutIdentity(i.facts, i.athleteName) },
    defines: today || headed || pillars.length ? { today, headed, pillars } : null,
    mia: preview ? {
      status: preview.status, score: preview.score, scale: preview.scale, groups: preview.groups, assessment: preview.assessment,
      preliminary: preview.preliminary, label: preview.label, confidence: preview.confidence, sharpen: preview.sharpen, evidenceAsOf: preview.evidenceAsOf,
    } : null,
    notes: notes ? {
      workingForYou: notes.strengths.slice(0, TOP_NOTES),
      roomToGrow: notes.growth.slice(0, TOP_NOTES),
      notOnRecordCount: notes.missing.length,
      detail: notes,
    } : null,
    brands: scoutBrands(i.internal, i.facts, i.athleteName, i.logos),
    conflicts: scoutConflicts(i.internal, i.facts),
    knows: { facts: knows.counts.total, unconfirmed: knows.counts.unconfirmed },
    riskUpside: riskUpsideOf(i.brief),
  };
}

// ─── reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The tagged notes of the evaluation run behind the read, from its stored raw answer. Null when there are none. */
export async function taggedNotesFor(athleteId: string, evaluationRunId: string | null | undefined): Promise<TaggedNotes | null> {
  if (!evaluationRunId) return null;
  const [run] = await db.select({ raw: miaEvaluationRuns.raw }).from(miaEvaluationRuns)
    .where(and(eq(miaEvaluationRuns.id, evaluationRunId), eq(miaEvaluationRuns.athlete_id, athleteId))).limit(1);
  const text = (run?.raw as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || !text) return null;
  const { extractJson } = await import("./marketabilityBeta1Evaluator");
  const { json } = extractJson(text);
  return json ? notesFrom(json) : null;
}

/** GET /me/scouting. An athlete with no memory facts gets the explicit empty state (the client keeps the old screens). */
export async function getScoutingReport(athleteId: string): Promise<ScoutingResponse> {
  const k = await knowsInputs(athleteId);
  if (!k.facts.length) return { contract: SCOUTING_CONTRACT, status: "no_memory" };
  const { readMiaPreview } = await import("./miaPreview/preview");
  const { brandDomainsFor } = await import("./athleteKnowledge");
  const [brief, internal, preview] = await Promise.all([dbStore.currentBrief(athleteId), dbStore.currentBriefInternal(athleteId), readMiaPreview(athleteId)]);
  const names = [...(internal?.currentSponsors ?? []), ...(internal?.pastSponsors ?? [])].map((s) => s?.name ?? "").filter(Boolean);
  const [tagged, logos] = await Promise.all([
    taggedNotesFor(athleteId, preview.provenance?.evaluationRunId),
    names.length ? brandDomainsFor(names) : Promise.resolve({ domains: new Map<string, string>(), logoUrls: new Map<string, string>() }),
  ]);
  return buildScoutingReport({ brief, internal, facts: k.facts, athleteName: k.athleteName, confirmed: k.confirmed, preview, tagged, logos });
}
