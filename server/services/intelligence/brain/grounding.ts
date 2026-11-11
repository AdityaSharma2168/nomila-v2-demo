/**
 * brain/grounding.ts — GATE 2. Every citation resolves to something the Brain was actually shown.
 *
 * References: objective[<id>] · deferred[<id>] · opportunity[<key>] · work[<id>] · ctx[<n>] · research[<n>] · a
 * State path (resolved by the Opportunity resolver, so the grammar is one grammar). A block that was not supplied
 * for this variant resolves nothing — that is how the ablation stays honest.
 *
 * Two rules beyond resolution:
 *   - a RECOMMEND must cite at least one reference that is not the Objective itself. A recommendation grounded only
 *     in the Objective's wording is the Objective restated.
 *   - `deferred[<id>]` may be cited only from the deferred[] entries or from a REQUEST_INTELLIGENCE — never as the
 *     ground of a recommendation, because a deferral is not active.
 *
 * Resolution is not entailment. Whether a cited observation actually bears on the decision is judged by reading.
 */
import { resolveStatePath } from "../opportunity/grounding";
import type { BrainInputs } from "./contract";

export interface BrainGroundingProblem { where: string; ref: string; reason: string }

const REF = /^(objective|deferred|opportunity|ctx|research|request|deal|brand|campaign|brief|asset|athlete)\[(.+)\]$/;

/** `<kind>[<id>].<key>` — evidence attached to a subject (the commercial projection). `work[<id>].<key>` is the 0.6 read alias. */
const SUBJECT_SUBPATH = /^((?:deal|brand|campaign|brief|asset|athlete|objective)\[(?:.+?)\])\.([A-Za-z_][A-Za-z0-9_.]*)$/;

/** The subject reference a work item is cited by; `work[<id>]` resolves to the same item for read compatibility only. */
const inWork = (inputs: BrainInputs, ref: string): boolean =>
  !!inputs.work && inputs.work.items.some((w) => `${w.ref.kind}[${w.ref.id}]` === ref);
const inSubjects = (inputs: BrainInputs, ref: string): boolean =>
  (inputs.subjects ?? []).some((s) => `${s.ref.kind}[${s.ref.id}]` === ref);
/** 0.13.0-exp: a brand rendered in BRAND RESEARCH. */
const inBrands = (inputs: BrainInputs, ref: string): boolean =>
  (inputs.brands ?? []).some((b) => `brand[${b.id}]` === ref);
/** Is this reference rendered in the EXISTING WORK lens — the only things `advances` may name. */
export function isInMotion(inputs: BrainInputs, ref: string): boolean { return inWork(inputs, ref.trim()); }

export function resolveRef(inputs: BrainInputs, ref: string): { ok: true } | { ok: false; reason: string } {
  const sub = SUBJECT_SUBPATH.exec(ref.trim());
  if (sub) {
    const c = inputs.commercial;
    if (!c || c.placement !== "work") return { ok: false, reason: "no commercial assessment is attached under this subject" };
    if (c.assessment.subjectRef !== sub[1]) return { ok: false, reason: "the commercial assessment is about a different subject" };
    return c.assessment.lines.some((l) => l.key === sub[2]) ? { ok: true } : { ok: false, reason: `no such assessment line "${sub[2]}"` };
  }
  const m = REF.exec(ref.trim());
  if (!m) {
    const r = resolveStatePath(inputs.state, ref);
    return r.ok ? { ok: true } : { ok: false, reason: `not a block reference and not a state path (${r.reason})` };
  }
  const [, kind, key] = m;
  switch (kind) {
    case "objective": return inputs.live.some((o) => o.id === key) || inSubjects(inputs, `objective[${key}]`) ? { ok: true } : { ok: false, reason: "not a live Objective" };
    case "deferred": return inputs.deferred.some((o) => o.id === key) ? { ok: true } : { ok: false, reason: "not a deferred Objective" };
    case "opportunity": return inputs.map?.opportunities.some((o) => o.key === key) ? { ok: true } : { ok: false, reason: inputs.map ? "no such opportunity key" : "no OPPORTUNITY MAP was supplied" };
    case "deal": case "brand": case "campaign": case "brief": case "asset": case "athlete": {
      const full = `${kind}[${key}]`;
      if (inWork(inputs, full) || inSubjects(inputs, full) || (kind === "brand" && inBrands(inputs, full))) return { ok: true };
      return { ok: false, reason: `${full} is not rendered in EXISTING WORK, DECISION SUBJECTS${kind === "brand" ? " or BRAND RESEARCH" : ""} in this run` };
    }
    case "ctx": { const n = Number(key); return inputs.context && Number.isInteger(n) && n >= 0 && n < inputs.context.items.length ? { ok: true } : { ok: false, reason: inputs.context ? "no such context item" : "no CONTEXT was supplied" }; }
    case "request": return inputs.requests.some((r) => r.id === key) ? { ok: true } : { ok: false, reason: inputs.requests.length ? "no such request" : "no DECISION REQUESTED was supplied" };
    case "research": { const n = Number(key); return Number.isInteger(n) && n >= 0 && n < inputs.research.length ? { ok: true } : { ok: false, reason: inputs.research.length ? "no such research item" : "no RESEARCH was supplied" }; }
    default: return { ok: false, reason: "unknown reference kind" };
  }
}

/**
 * GATE-2 BACKSTOP for A COMMERCIAL BASIS IS ESTABLISHED OR IT IS NOT (0.6.1-exp). Not the semantic definition — the
 * prose is. Structural precondition first: the answer is a RECOMMEND that cites a subject whose attached commercial
 * assessment says `basis` or `band` is NOT_ESTABLISHED. Only then is the rationale read, for a closed list of economic
 * comparison words. A decline for an exclusivity conflict carries none of them and passes; "extremely inadequate for
 * an athlete earning USD 65M" does not. Refuse, never repair. What this cannot see: a comparison phrased without any
 * listed word, or a comparison against a basis that IS established but irrelevant — those are the prose's to govern.
 */
const COMPARISON = /\b(?:inadequate|adequate|undervalu\w*|overvalu\w*|underpric\w*|overpric\w*|lowball\w*|below(?:-| )market|above(?:-| )market|too (?:low|high|little|small|cheap)|(?:far|well|significantly|extremely) (?:below|above|under|over)|not (?:enough|worth)|worth (?:accepting|declining|taking|refusing|far more|much more)|insufficient compensation|inadequate compensation|commands? (?:far|much) (?:more|higher)|(?:fee|offer|compensation|amount|price) (?:is|was|of) (?:too )?(?:low|high|small|weak|strong|poor|generous))\b/i;
export function substitutesBasis(inputs: BrainInputs, entry: any): string | null {
  if (entry?.decision !== "RECOMMEND") return null;
  const c = inputs.commercial;
  if (!c || c.placement !== "work") return null;
  const unestablished = c.assessment.lines.some((l) => (l.key === "basis" || l.key === "band") && /^NOT_ESTABLISHED/.test(l.text));
  if (!unestablished) return null;
  const cites: any[] = Array.isArray(entry?.cites) ? entry.cites : [];
  const aboutSubject = cites.some((x) => typeof x?.ref === "string" && (x.ref.trim() === c.assessment.subjectRef || x.ref.trim().startsWith(`${c.assessment.subjectRef}.`) || x.ref.trim() === `work[${c.assessment.subject}]`));
  if (!aboutSubject) return null;
  const text = `${entry?.what ?? ""} ${entry?.why ?? ""}`;
  const m = COMPARISON.exec(text);
  return m ? m[0] : null;
}

export function validateBrainGrounding(inputs: BrainInputs, body: unknown): BrainGroundingProblem[] {
  const P: BrainGroundingProblem[] = [];
  if (!body || typeof body !== "object") return P;
  const x = body as any;
  const check = (where: string, entry: any, allowDeferredRef: boolean, mustCiteBeyondObjective: boolean) => {
    const cites: any[] = Array.isArray(entry?.cites) ? entry.cites : [];
    let beyond = false;
    for (const [i, c] of cites.entries()) {
      const ref = typeof c?.ref === "string" ? c.ref : "";
      const r = resolveRef(inputs, ref);
      if (!r.ok) { P.push({ where: `${where}.cites[${i}]`, ref, reason: r.reason }); continue; }
      if (ref.startsWith("deferred[") && !allowDeferredRef) P.push({ where: `${where}.cites[${i}]`, ref, reason: "a deferral is not active and cannot ground a decision on a live Objective" });
      if (!ref.startsWith("objective[") && !ref.startsWith("request[")) beyond = true;
    }
    if (mustCiteBeyondObjective && cites.length > 0 && !beyond) P.push({ where, ref: "objective[…]", reason: "a RECOMMEND grounded only in the Objective's own wording (or the question's) is the Objective restated" });
    { const s = substitutesBasis(inputs, entry); if (s) P.push({ where, ref: inputs.commercial!.assessment.subjectRef, reason: `an economic comparison ("${s}") on a subject whose commercial basis is NOT_ESTABLISHED — request the basis or decide on reasoning that does not depend on one` }); }
    const ends = entry?.ends as { source?: string; ref?: string } | null | undefined;
    if (ends && typeof ends === "object" && typeof ends.ref === "string" && ends.ref) {
      const r = resolveRef(inputs, ends.ref);
      if (!r.ok) P.push({ where: `${where}.ends.ref`, ref: ends.ref, reason: r.reason });
      else if (ends.source === "objective_horizon" && !/^objective\[/.test(ends.ref)) P.push({ where: `${where}.ends.ref`, ref: ends.ref, reason: "ends.source objective_horizon must reference an objective[…]" });
      else if (ends.source === "deal_term" && !/^deal\[/.test(ends.ref)) P.push({ where: `${where}.ends.ref`, ref: ends.ref, reason: "ends.source deal_term must reference a deal[…] rendered in EXISTING WORK" });
      else if (ends.source === "athlete_stated" && /^(objective|deal|ctx|research)\[/.test(ends.ref)) P.push({ where: `${where}.ends.ref`, ref: ends.ref, reason: "ends.source athlete_stated must reference her own stated finish (a state path), not an Objective, deal or evidence item" });
    }
    // 0.13.0-exp: `about.ref` names a brand the Brain was shown, or nothing.
    const aboutRef = entry?.about && typeof entry.about === "object" && typeof entry.about.ref === "string" ? entry.about.ref.trim() : "";
    if (aboutRef) {
      const r = resolveRef(inputs, aboutRef);
      if (!r.ok) P.push({ where: `${where}.about.ref`, ref: aboutRef, reason: r.reason });
    }
    if (typeof entry?.advances === "string" && entry.advances) {
      const r = resolveRef(inputs, entry.advances);
      if (!r.ok) P.push({ where: `${where}.advances`, ref: entry.advances, reason: r.reason });
      else if (!isInMotion(inputs, entry.advances)) P.push({ where: `${where}.advances`, ref: entry.advances, reason: "advances must name an item rendered in EXISTING WORK — a subject that is not in motion cannot be advanced" });
    }
  };
  (Array.isArray(x.decisions) ? x.decisions : []).forEach((d: any, i: number) => check(`decisions[${i}]`, d, d?.decision === "REQUEST_INTELLIGENCE", d?.decision === "RECOMMEND"));
  (Array.isArray(x.deferred) ? x.deferred : []).forEach((d: any, i: number) => {
    check(`deferred[${i}]`, d, true, false);
    const r = resolutionProblem(inputs, d);
    if (r) P.push({ where: `deferred[${i}]`, ref: r.ref, reason: r.reason });
  });
  (Array.isArray(x.requested) ? x.requested : []).forEach((d: any, i: number) => check(`requested[${i}]`, d, d?.decision === "REQUEST_INTELLIGENCE", d?.decision === "RECOMMEND"));
  return P;
}

/**
 * GATE-2 BACKSTOP for deferred information conditions (0.8.1-exp). Refuse, never repair. Not the semantic definition —
 * the prose is. A CONDITION_APPEARS_RESOLVED entry is admissible only when:
 *   · the deferral's kind is `information` (rows without a deferral are read as information — the conservative default),
 *     and the entry cites at least one `research[<n>]` whose block was REQUESTED FOR THAT OBJECTIVE — i.e. responsive,
 *     attributable evidence (a targeted-research answer, or an evidenced Intelligence Request projected into the RESEARCH
 *     block by evidencedRequestAsResearchBlock); or
 *   · the deferral's kind is `time` — the passage of time is the system's to observe and the entry is left to the prose.
 * It is refused when the kind is `athlete` (only her `revisit` brings it back), and when the only cites are the deferral
 * itself, State signals (`commercialPosition.inbound[…]` and the like), openings, work or context — "new evidence about
 * the same subject" is never "responsive evidence". Which evidence ESTABLISHES the proposition remains the reconsidering
 * Brain's judgment; this rule checks attribution, not truth.
 */
export function resolutionProblem(inputs: BrainInputs, entry: any): { ref: string; reason: string } | null {
  if (entry?.decision !== "CONDITION_APPEARS_RESOLVED") return null;
  const id = String(entry.objective_id ?? "");
  const o = inputs.deferred.find((x) => x.id === id);
  if (!o) return null; // the structural gate already refuses an unknown deferred id
  const kind = (o as any).deferral?.kind ?? "information";
  if (kind === "athlete") return { ref: `deferred[${id}]`, reason: "she deferred this to revisit herself — only her revisit brings it back; the Brain may not call it resolved" };
  if (kind !== "information") return null;
  const cites: string[] = Array.isArray(entry.cites) ? entry.cites.map((c: any) => String(c?.ref ?? "").trim()) : [];
  const responsive = cites.filter((ref) => {
    const m = /^research\[(\d+)\]$/.exec(ref);
    if (!m) return false;
    const blk = inputs.research[Number(m[1])];
    return !!blk && blk.requestedBy?.objectiveId === id;
  });
  if (responsive.length) return null;
  return { ref: `deferred[${id}]`, reason: `CONDITION_APPEARS_RESOLVED on an information deferral without responsive evidence — it cites ${cites.length ? cites.join(", ") : "nothing"}; resolution requires research[<n>] requested for this Objective (attributable evidence), not new evidence about the same subject` };
}

export function formatBrainGroundingProblems(ps: BrainGroundingProblem[]): string[] {
  return ps.map((p) => `${p.where} → ${p.ref}: ${p.reason}`);
}
