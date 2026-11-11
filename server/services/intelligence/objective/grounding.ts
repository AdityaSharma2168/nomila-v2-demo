/**
 * grounding.ts — gate 2 for Objective proposals: does every citation resolve, and do the invariants that can be
 * checked deterministically hold, against the EXACT state and map the evaluator was given?
 *
 * Structural validation (evalSpec.ts) proves a proposal is well-formed. This proves its claims about its own inputs
 * are true: the state paths exist, the opportunity keys exist, the intent it cites is a WANTS, the metric it wants to
 * quantify holds a number, every opportunity in the map is accounted for exactly once, and origin can be derived
 * from what it cites.
 *
 * RESOLUTION IS NOT ENTAILMENT. A resolvable path can be cited in support of a sentence it does not establish, and
 * PR2 proved it. Nothing here claims otherwise. Two heuristics — paraphrase overlap and the execution-verb check —
 * are cheap and high-precision, and are labelled as heuristics.
 */
import type { AthleteState } from "../contracts/athleteState";
import type { OpportunityMap } from "../contracts/opportunity";
import type { ObjectiveOrigin } from "../contracts/objective";
import { resolveStatePath } from "../opportunity/grounding";

export interface ObjectiveGroundingProblem {
  index: number | null;   // null for set-level problems (accounting)
  key: string | null;
  where: string;
  reason: string;
}

/** Normalised-token Jaccard above this is treated as a paraphrase. A heuristic, named so it can be argued with. */
export const PARAPHRASE_JACCARD = 0.6;

/**
 * Personal pronouns are stop words in every person (objective-eval-spec/1.1.0 writes to the athlete as "you"): a stored
 * "Her audience…" and a proposed "Your audience…" are the same wording for the paraphrase check and for reconcile's
 * wording tie-breaker.
 */
const PRONOUNS = ["her", "hers", "herself", "she", "his", "him", "himself", "he", "their", "theirs", "them", "themselves", "they", "your", "yours", "yourself", "you", "my", "mine", "myself", "me", "i"];
const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "its", "into", "as", "by", "at", "from", "that", "this", "is", "are", "be", ...PRONOUNS]);
export function tokens(s: string): Set<string> {
  return new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t)));
}
export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** A number the evaluator may quantify against, or null. Accepts a MEASURED envelope or a bare number. */
export function numericAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const v = (value as any).value;
    if ((value as any).evidenceClass === "MEASURED" && typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Origin as the citations imply it. Compared against nothing here — the evaluator emits no origin — but used at normalisation. */
export function deriveOrigin(opps: number, intent: number): ObjectiveOrigin | null {
  if (opps > 0 && intent > 0) return "joint";
  if (opps > 0) return "nomila";
  if (intent > 0) return "athlete";
  return null;
}

export function validateObjectiveGrounding(state: AthleteState, map: OpportunityMap, body: unknown): ObjectiveGroundingProblem[] {
  const out: ObjectiveGroundingProblem[] = [];
  const proposals: any[] = Array.isArray((body as any)?.proposals) ? (body as any).proposals : [];
  const notes: any[] = Array.isArray((body as any)?.notes) ? (body as any).notes : [];
  const mapKeys = new Map(map.opportunities.map((o) => [o.key, o]));
  const proposalKeys = new Set(proposals.map((p) => p?.key).filter((k) => typeof k === "string"));

  const seenDesired = new Map<string, number>();
  const usedOpps = new Map<string, number[]>(); // opportunity key → proposal indices citing it

  proposals.forEach((p: any, index: number) => {
    const key = typeof p?.key === "string" ? p.key : null;
    const push = (where: string, reason: string) => out.push({ index, key, where, reason });

    // ── state citations resolve ─────────────────────────────────────────────
    for (const [field, list] of [["current_state_evidence", p?.current_state_evidence], ["from_athlete_intent", p?.from_athlete_intent]] as const) {
      for (const c of Array.isArray(list) ? list : []) {
        const path = typeof c?.state_path === "string" ? c.state_path : "";
        if (!path) continue; // structural owns this
        const r = resolveStatePath(state, path);
        if (!r.ok) { push(`${field}[${path}]`, r.reason); continue; }
        // Intent must be a WANTS. A refusal cannot create an objective; it bears on one.
        if (field === "from_athlete_intent") {
          const stance = (r.value as any)?.stance;
          if (!path.startsWith("preferences[") || stance !== "wants") {
            push(`${field}[${path}]`, `athlete intent must cite a preference with stance "wants" (resolved to ${path.startsWith("preferences[") ? `stance "${stance}"` : "something that is not a preference"})`);
          }
        }
      }
    }

    // ── opportunity citations resolve, and are tallied for accounting ───────
    for (const c of Array.isArray(p?.from_opportunities) ? p.from_opportunities : []) {
      const k = typeof c?.opportunity_key === "string" ? c.opportunity_key : "";
      if (!k) continue;
      if (!mapKeys.has(k)) { push(`from_opportunities[${k}]`, `"${k}" is not in the opportunity map (present: ${[...mapKeys.keys()].slice(0, 8).join(", ")})`); continue; }
      usedOpps.set(k, [...(usedOpps.get(k) ?? []), index]);
      // Paraphrase heuristic against the cited opportunity's own statement.
      const opp = mapKeys.get(k)!;
      const j = jaccard(String(p?.desired_state ?? ""), opp.statement.value);
      if (j >= PARAPHRASE_JACCARD) push("desired_state", `near-restatement of opportunity "${k}" (token overlap ${(j * 100).toFixed(0)}%) — an outcome, not the opening renamed`);
    }

    // ── outcome differs from current ────────────────────────────────────────
    const ds = String(p?.desired_state ?? "").trim().toLowerCase();
    const cs = String(p?.current_state ?? "").trim().toLowerCase();
    if (ds && ds === cs) push("desired_state", "identical to current_state — an objective must name a changed state");
    if (ds) {
      const prev = seenDesired.get(ds);
      if (prev !== undefined) push("desired_state", `duplicates proposals[${prev}] — two objectives may not share a desired state`);
      else seenDesired.set(ds, index);
    }

    // ── quantification is evidence-bound ────────────────────────────────────
    const q = p?.success?.quantified;
    if (q && typeof q === "object" && typeof q.state_path === "string" && q.state_path) {
      const r = resolveStatePath(state, q.state_path);
      if (!r.ok) push(`success.quantified[${q.state_path}]`, r.reason);
      else if (numericAt(r.value) === null) push(`success.quantified[${q.state_path}]`, "path resolves but holds no number — a baseline cannot be read, so this cannot be quantified");
    }
  });

  // ── portfolio accounting: every opportunity exactly once ──────────────────
  const noted = new Map<string, number[]>();
  notes.forEach((n: any, i: number) => {
    const k = typeof n?.opportunity_key === "string" ? n.opportunity_key : "";
    if (!k) return;
    if (!mapKeys.has(k)) out.push({ index: null, key: null, where: `notes[${i}]`, reason: `"${k}" is not in the opportunity map` });
    noted.set(k, [...(noted.get(k) ?? []), i]);
    if (n?.outcome === "consolidated" && typeof n?.into === "string" && !proposalKeys.has(n.into)) {
      out.push({ index: null, key: null, where: `notes[${i}]`, reason: `consolidated into "${n.into}", which is not a proposal in this set` });
    }
  });
  for (const k of mapKeys.keys()) {
    const inProposals = usedOpps.get(k) ?? [];
    const inNotes = noted.get(k) ?? [];
    if (inProposals.length === 0 && inNotes.length === 0) out.push({ index: null, key: null, where: "accounting", reason: `opportunity "${k}" is neither carried by a proposal nor accounted for in notes — a silent drop` });
    if (inProposals.length > 0 && inNotes.length > 0) out.push({ index: null, key: null, where: "accounting", reason: `opportunity "${k}" appears both in a proposal's provenance and in notes — it must be exactly one` });
    if (inNotes.length > 1) out.push({ index: null, key: null, where: "accounting", reason: `opportunity "${k}" is noted ${inNotes.length} times` });
  }

  // ── set-level consistency ───────────────────────────────────────────────
  if (map.stateAsOf !== state.asOf) out.push({ index: null, key: null, where: "inputs", reason: `the opportunity map was judged from a state as of ${map.stateAsOf}, but the supplied state is as of ${state.asOf}` });

  return out;
}

export function formatObjectiveGroundingProblems(ps: ObjectiveGroundingProblem[]): string[] {
  return ps.map((p) => `${p.index === null ? "set" : `proposals[${p.index}]`}${p.key ? ` (${p.key})` : ""} · ${p.where}: ${p.reason}`);
}
