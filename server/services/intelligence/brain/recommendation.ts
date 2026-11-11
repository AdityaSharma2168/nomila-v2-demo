/**
 * brain/recommendation.ts — Brain Decision → reconciliation → Recommendation. EXPERIMENTAL; pure; file-backed in the
 * harness (nothing materialised). brain-recommendation-execution-path-checkpoint.md §2–§3, §14, as approved 26 Sep.
 *
 * A Brain DECISION is one answer in one run. A RECOMMENDATION is the durable strategic judgment derived from a RECOMMEND
 * after reconciliation. NO_ACTION and REQUEST_INTELLIGENCE never become one. A later run producing the same judgment
 * reaffirms the existing Recommendation; a different judgment on the same decision supersedes it. The record's shape
 * mirrors an intelligence_ledger entry of kind RECOMMENDATION (subject_type/subject_id, value, versions, superseded_by)
 * so that materialising it later is a write, not a redesign.
 *
 * FOUR THINGS KEPT APART, each its own field with its own transitions — never one state standing for another:
 *   response       what the athlete said about the recommendation (accept · modify · decline · defer)
 *   authorization  whether the consumer may PREPARE (draft, plan, originate) — set by an explicit event, not implied
 *                  by acceptance; never a send/post/pay authorization, which stays on the execution record
 *   execution      what execution records exist and what they did (proposed · executed · failed), by reference
 *   outcome        what happened afterwards, paired later (P-7); null until MEASURE writes it
 */
import { createHash } from "node:crypto";
import { ABOUT_KINDS, BRAIN_TITLE_MAX, COMMERCIAL_INTENTS, DECISIONS, EXECUTION_PATHS, WORK_RELATIONS, parseSubjectRef, subjectRefString, type AboutKind, type Cite, type SubjectRef, CAMPAIGN_END_SOURCES, type CampaignEnd } from "./contract";

/**
 * 0.3.0-exp (Brain PR B): `value.title` and `value.about` — both inside the jsonb `value`, neither part of the key or of
 * `sameJudgment`. Records written before carry neither; they are NOT backfilled (the view derives a fallback at read).
 */
export const RECOMMENDATION_VERSION = "recommendation/0.3.0-exp";
/** Every version a stored record may carry. */
export type RecommendationVersion = "recommendation/0.2.0-exp" | typeof RECOMMENDATION_VERSION;

export const RECOMMENDATION_EVENTS = [
  "created",              // system: a reconciled RECOMMEND with no open Recommendation on its key
  "reaffirmed_by_run",    // system: a later run produced the same judgment; no new row
  "reworded_by_run",      // system: the same judgment with different wording — wording drifts freely (1B); the record keeps the latest words
  "superseded",           // system: a later run produced a different judgment on the same decision; the old one closes
  "withdrawn_by_run",     // system: a later run answered the same decision with NO_ACTION or REQUEST, and the Recommendation was UNGOVERNED (no response, no authorization, no execution) — it closes
  "reconsidered_by_run",  // system: a later run judged differently on a GOVERNED Recommendation (responded, authorized, or in execution) — recorded on it; nothing closes, nothing is rewritten
  "presented",            // system/surface: shown to the athlete
  "accept", "modify", "decline", "defer",   // athlete: the RESPONSE — never authorization
  "prepare_authorized",   // athlete/system: the consumer may prepare — distinct from the response
  "execution_proposed",   // consumer: an execution record exists (a pending action, an origin, a job)
  "executed", "execution_failed",
  "outcome_recorded",
  "withdrawn_goal_closed", // system: the only goal it served was achieved or abandoned, and it was UNGOVERNED — it closes
  "goal_closed_noted",     // system: the same, on a GOVERNED record — recorded on it; nothing closes, nothing is rewritten
] as const;
export type RecommendationEvent = (typeof RECOMMENDATION_EVENTS)[number];

export interface RecommendationValue {
  what: string; why: string; cites: Cite[];
  executionPath: (typeof EXECUTION_PATHS)[number];
  relationToExistingWork: (typeof WORK_RELATIONS)[number];
  advances: string | null;
  notSeen: string[];
  /** 0.7.0-exp: the strategic instruction for a commercial subject; null when the subject is not commercial. */
  intent: (typeof COMMERCIAL_INTENTS)[number] | null;
  /** 0.2.0-exp (R17): the typed reference to what ends a campaign; null on every other shape. Records written before 0.2.0 carry none. */
  ends: CampaignEnd | null;
  /**
   * 0.3.0-exp: the Brain's short title (≤ BRAIN_TITLE_MAX). Set once, by the run that first gives one, and stable for the
   * life of the record: a reword updates `what`/`why`, never the title. Absent on records written before 0.3.0.
   */
  title?: string | null;
  /** 0.3.0-exp: what the move is about, for the surfaces (not the decision subject). Set once, like `title`. */
  about?: RecommendationAbout | null;
}

/** What a move is about, as stored: the kind, the name the Brain gave, and the inbox_brands id when it is a known brand. */
export interface RecommendationAbout { kind: AboutKind; name: string | null; brandId: number | null }

export interface RecommendationRecord {
  version: RecommendationVersion;
  id: string;
  /** Decision identity: source + subject + question — plus the routing that makes a judgment the same judgment. */
  key: string;
  source: string;
  subject: SubjectRef;
  question: string;
  objectiveIds: string[];
  value: RecommendationValue;
  versions: { spec: string; runId: string; runAt: string };
  /** Which run first produced it and which runs reaffirmed it. */
  runs: string[];
  response: { state: "none" | "accepted" | "modified" | "declined" | "deferred"; at: string | null; actor: string | null; said?: string };
  authorization: { state: "none" | "prepare_authorized" | "revoked"; at: string | null; actor: string | null };
  execution: { state: "none" | "proposed" | "executed" | "failed"; refs: Array<{ kind: string; id: string; at: string }> };
  outcome: null | { at: string; followed: boolean | null; result: unknown };
  supersededBy: string | null;
  /** Set on a record created while a GOVERNED Recommendation on the same decision stayed open: the new judgment relates to it, it does not replace it. */
  reconsiders: string | null;
  closed: boolean;
  events: Array<{ at: string; event: RecommendationEvent; actor: string; note?: string }>;
}

export interface RecommendationLedger { version: RecommendationVersion; records: RecommendationRecord[] }
export const emptyLedger = (): RecommendationLedger => ({ version: RECOMMENDATION_VERSION, records: [] });

/** One decision as it appears in a run's gated output, with the identity the run supplies. */
export interface DecisionInRun {
  source: string;
  subject: SubjectRef;
  question: string;
  objectiveIds: string[];
  decision: (typeof DECISIONS)[number];
  body: Record<string, unknown>;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/**
 * THE WITHDRAWAL RULE. A Recommendation is UNGOVERNED while nothing but the Brain has touched it: no athlete response,
 * no authorization, no execution record. Only an ungoverned Recommendation may be withdrawn or superseded by a later
 * Brain run. Once governance or execution has occurred, a later Brain judgment is RECORDED on the record as
 * `reconsidered_by_run` (and a different RECOMMEND is created as a new record that `reconsiders` it) — the athlete's
 * response, the authorization and the execution history are never rewritten, and nothing in motion is closed by
 * intelligence alone. Reconsideration of the intelligence does not rewrite governed history.
 */
export const isGoverned = (r: RecommendationRecord): boolean =>
  r.response.state !== "none" || r.authorization.state !== "none" || r.execution.state !== "none";

/** The identity of a judgment: the decision (source · subject · question) plus how it would be executed. Evidence is never part of it. */
export function recommendationKey(d: { source: string; subject: SubjectRef; question: string; executionPath: string; advances: string | null }): string {
  return sha(JSON.stringify([d.source, subjectRefString(d.subject), d.question, d.executionPath, d.advances ?? null]));
}

function endsFrom(e: unknown): CampaignEnd | null {
  if (!e || typeof e !== "object") return null;
  const { source, ref } = e as Record<string, unknown>;
  return (CAMPAIGN_END_SOURCES as readonly string[]).includes(String(source)) && typeof ref === "string" && ref ? { source: source as CampaignEnd["source"], ref } : null;
}
/** `brand[<id>]` → the numeric id, else null. */
export function brandIdOfRef(ref: unknown): number | null {
  const m = typeof ref === "string" ? /^brand\[(\d+)\]$/.exec(ref.trim()) : null;
  return m ? Number(m[1]) : null;
}

function titleFrom(t: unknown): string | null {
  const s = typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, BRAIN_TITLE_MAX) : null;
}

/** The Brain's `about` → the stored shape. `brand_id` is what the loop resolved for a brand named without a ref. */
export function aboutFrom(a: unknown): RecommendationAbout | null {
  if (!a || typeof a !== "object") return null;
  const x = a as Record<string, unknown>;
  if (!(ABOUT_KINDS as readonly string[]).includes(String(x.kind))) return null;
  const kind = x.kind as AboutKind;
  const name = typeof x.name === "string" && x.name.trim() ? x.name.trim() : null;
  const resolved = typeof x.brand_id === "number" && Number.isInteger(x.brand_id) ? x.brand_id : null;
  const brandId = kind === "brand" ? brandIdOfRef(x.ref) ?? resolved : null;
  return { kind, name, brandId };
}

function valueFrom(body: Record<string, unknown>): RecommendationValue {
  return {
    title: titleFrom(body.title),
    about: aboutFrom(body.about),
    what: String(body.what ?? ""), why: String(body.why ?? ""), cites: Array.isArray(body.cites) ? (body.cites as Cite[]) : [],
    executionPath: body.execution_path as RecommendationValue["executionPath"],
    relationToExistingWork: body.relation_to_existing_work as RecommendationValue["relationToExistingWork"],
    advances: typeof body.advances === "string" && body.advances ? body.advances : null,
    notSeen: Array.isArray(body.not_seen) ? (body.not_seen as string[]) : [],
    intent: (COMMERCIAL_INTENTS as readonly string[]).includes(String(body.intent)) ? (body.intent as RecommendationValue["intent"]) : null,
    ends: endsFrom(body.ends),
  };
}

/**
 * The same judgment = the same routing (execution path, what it advances) and, for a commercial subject, the same typed
 * intent. Wording is NOT identity: 1B established that `what` drifts freely across identical inputs while type, path and
 * relation hold. Pre-0.7.0 runs carry no intent; for a commercial subject without one, the wording is the only signal
 * and is used, flagged, so recorded artifacts can still be reconciled offline.
 */
const sameJudgment = (subject: SubjectRef, a: RecommendationValue, b: RecommendationValue): boolean => {
  if (a.executionPath !== b.executionPath || (a.advances ?? null) !== (b.advances ?? null)) return false;
  if (subject.kind === "deal") return a.intent || b.intent ? (a.intent ?? null) === (b.intent ?? null) : a.what.trim() === b.what.trim();
  return true;
};

/**
 * Reconcile one run's decisions against the ledger. Pure. Returns the new ledger and what happened, decision by decision.
 * RECOMMEND → created | reaffirmed_by_run | superseded (+created). NO_ACTION / REQUEST → withdrawn_by_run if an open
 * Recommendation exists on that decision's key family (same source · subject · question), else nothing.
 */
export function reconcileRun(ledger: RecommendationLedger, run: { id: string; at: string; spec: string }, decisions: DecisionInRun[]): { ledger: RecommendationLedger; events: Array<{ decision: string; event: RecommendationEvent | "none"; recommendationId: string | null; note: string }> } {
  const records = ledger.records.map((r) => ({ ...r, events: [...r.events], runs: [...r.runs] }));
  const out: Array<{ decision: string; event: RecommendationEvent | "none"; recommendationId: string | null; note: string }> = [];
  const decisionLabel = (d: DecisionInRun) => `${d.source} · ${subjectRefString(d.subject)} · ${JSON.stringify(d.question)}`;
  const family = (d: DecisionInRun) => records.filter((r) => !r.closed && r.source === d.source && subjectRefString(r.subject) === subjectRefString(d.subject) && r.question === d.question);

  for (const d of decisions) {
    if (d.decision !== "RECOMMEND") {
      const open = family(d);
      for (const r of open) {
        if (isGoverned(r)) {
          r.events.push({ at: run.at, event: "reconsidered_by_run", actor: "system", note: `run ${run.id} answered ${d.decision}; governed (${r.response.state} · ${r.authorization.state} · ${r.execution.state}) — history kept, nothing closed` });
          out.push({ decision: decisionLabel(d), event: "reconsidered_by_run", recommendationId: r.id, note: `${d.decision} on a governed Recommendation — recorded, not withdrawn` });
        } else {
          r.closed = true;
          r.events.push({ at: run.at, event: "withdrawn_by_run", actor: "system", note: `run ${run.id} answered ${d.decision}` });
          out.push({ decision: decisionLabel(d), event: "withdrawn_by_run", recommendationId: r.id, note: `${d.decision} on an ungoverned Recommendation — withdrawn` });
        }
      }
      if (!open.length) out.push({ decision: decisionLabel(d), event: "none", recommendationId: null, note: `${d.decision} creates nothing` });
      continue;
    }
    const value = valueFrom(d.body);
    const key = recommendationKey({ source: d.source, subject: d.subject, question: d.question, executionPath: value.executionPath, advances: value.advances });
    const open = family(d);
    const same = open.find((r) => r.key === key && sameJudgment(d.subject, r.value, value));
    if (same) {
      same.runs.push(run.id);
      const reworded = same.value.what.trim() !== value.what.trim();
      if (reworded) same.value = { ...same.value, what: value.what, why: value.why, cites: value.cites, notSeen: value.notSeen };
      // 0.3.0-exp: the title and about are set ONCE — by the first run that gives them — and never reworded after.
      if (!same.value.title && value.title) same.value = { ...same.value, title: value.title };
      if (!same.value.about && value.about) same.value = { ...same.value, about: value.about };
      same.events.push({ at: run.at, event: reworded ? "reworded_by_run" : "reaffirmed_by_run", actor: "system", note: `run ${run.id}` });
      out.push({ decision: decisionLabel(d), event: reworded ? "reworded_by_run" : "reaffirmed_by_run", recommendationId: same.id, note: reworded ? "same judgment, new wording; no new row" : "same judgment; no new row" });
      continue;
    }
    const id = `rec_${sha(`${key}:${run.id}:${value.what}`)}`;
    let reconsiders: string | null = null;
    for (const r of open) {
      if (isGoverned(r)) {
        reconsiders = r.id;
        r.events.push({ at: run.at, event: "reconsidered_by_run", actor: "system", note: `run ${run.id} judged differently → ${id}; governed (${r.response.state} · ${r.authorization.state} · ${r.execution.state}) — history kept, nothing closed` });
        out.push({ decision: decisionLabel(d), event: "reconsidered_by_run", recommendationId: r.id, note: `a different judgment on a governed Recommendation — recorded, not superseded; the new record reconsiders it` });
      } else {
        r.closed = true; r.supersededBy = id;
        r.events.push({ at: run.at, event: "superseded", actor: "system", note: `by ${id} (run ${run.id})` });
        out.push({ decision: decisionLabel(d), event: "superseded", recommendationId: r.id, note: `a different judgment on the same decision: "${r.value.what.slice(0, 60)}…" → "${value.what.slice(0, 60)}…"` });
      }
    }
    records.push({
      version: RECOMMENDATION_VERSION, id, key, source: d.source, subject: d.subject, question: d.question, objectiveIds: d.objectiveIds, value,
      versions: { spec: run.spec, runId: run.id, runAt: run.at }, runs: [run.id],
      response: { state: "none", at: null, actor: null }, authorization: { state: "none", at: null, actor: null }, execution: { state: "none", refs: [] }, outcome: null,
      supersededBy: null, reconsiders, closed: false, events: [{ at: run.at, event: "created", actor: "system", note: `run ${run.id}${reconsiders ? ` · reconsiders ${reconsiders}` : ""}` }],
    });
    out.push({ decision: decisionLabel(d), event: "created", recommendationId: id, note: value.intent ? `intent ${value.intent}` : "no intent (not a commercial subject, or a pre-0.7.0 run)" });
  }
  return { ledger: { version: RECOMMENDATION_VERSION, records }, events: out };
}

/**
 * HER GOAL CLOSED (Goals PR). When she marks a goal achieved or abandons it, the moves that served ONLY that goal are
 * withdrawn — by the same withdrawal rule as a run's: an ungoverned record closes (`withdrawn_goal_closed`); a governed
 * one (she answered it, authorized it, or it is in execution) keeps its history and stays open, with the closing noted
 * (`goal_closed_noted`). A record that also serves another goal is untouched. Pure; returns null when nothing changes.
 */
export function goalClosed(r: RecommendationRecord, objectiveId: string, action: "achieve" | "abandon", at: string): RecommendationRecord | null {
  if (r.closed || !r.objectiveIds.includes(objectiveId) || r.objectiveIds.some((id) => id !== objectiveId)) return null;
  const note = `her goal ${objectiveId} was ${action === "achieve" ? "achieved" : "abandoned"}`;
  if (isGoverned(r)) {
    if (r.events.some((e) => e.event === "goal_closed_noted" && (e.note ?? "").startsWith(note))) return null;
    return { ...r, events: [...r.events, { at, event: "goal_closed_noted", actor: "system", note: `${note}; governed (${r.response.state} · ${r.authorization.state} · ${r.execution.state}) — history kept, nothing closed` }] };
  }
  return { ...r, closed: true, events: [...r.events, { at, event: "withdrawn_goal_closed", actor: "system", note }] };
}

/** The athlete's RESPONSE. Changes nothing about authorization or execution. */
export function respond(r: RecommendationRecord, response: "accept" | "modify" | "decline" | "defer", actor: string, at: string, said?: string): RecommendationRecord {
  const state = response === "accept" ? "accepted" : response === "modify" ? "modified" : response === "decline" ? "declined" : "deferred";
  return { ...r, response: { state, at, actor, said }, closed: r.closed || response === "decline", events: [...r.events, { at, event: response, actor, note: said }] };
}

/** AUTHORIZATION to prepare. An explicit event; not implied by `accept`. Refused unless the response is accepted or modified. */
export function authorizePrepare(r: RecommendationRecord, actor: string, at: string): RecommendationRecord {
  if (r.response.state !== "accepted" && r.response.state !== "modified") throw new Error(`cannot authorize preparation: response is ${r.response.state}`);
  return { ...r, authorization: { state: "prepare_authorized", at, actor }, events: [...r.events, { at, event: "prepare_authorized", actor }] };
}

/** An execution record now exists (a pending action, an origin, a job) — by reference, never by copying its content. */
/**
 * OUTCOME — what happened afterwards, recorded once by whoever measured it (a campaign closing, a deal settling). Closes
 * the record: an outcome is the end of a Recommendation's life, so later runs on the same decision mint a new one and
 * the router's dedup no longer sees this one as execution underway. Requires execution to have been proposed.
 */
export function recordOutcome(r: RecommendationRecord, outcome: { followed: boolean | null; result: unknown }, at: string, actor = "measure"): RecommendationRecord {
  if (r.execution.state === "none") throw new Error("an outcome needs an execution to be the outcome of");
  if (r.outcome) return r;
  return { ...r, outcome: { at, ...outcome }, closed: true, events: [...r.events, { at, event: "outcome_recorded", actor }] };
}

export function recordExecution(r: RecommendationRecord, ref: { kind: string; id: string }, at: string, event: "execution_proposed" | "executed" | "execution_failed" = "execution_proposed"): RecommendationRecord {
  if (r.authorization.state !== "prepare_authorized") throw new Error("execution before preparation was authorized");
  const state = event === "executed" ? "executed" : event === "execution_failed" ? "failed" : "proposed";
  return { ...r, execution: { state, refs: [...r.execution.refs, { ...ref, at }] }, events: [...r.events, { at, event, actor: "consumer", note: `${ref.kind}:${ref.id}` }] };
}

/** Read a request's subject from a recorded artifact's inputs (string or typed forms). */
export const subjectOf = (about: unknown): SubjectRef | null => parseSubjectRef(about);
