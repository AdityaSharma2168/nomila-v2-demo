/**
 * objective/currentBasis.ts — Slice 3 B: which historical openings may stand as CURRENT strategic basis for the Brain
 * (slice3-b-design.md). Pure; derived each time Brain inputs are built; never persisted as its own state.
 *
 * A HISTORICAL OPENING MAY REMAIN FACTUALLY RELEVANT WITHOUT REMAINING SAFE AS CURRENT PRESCRIPTIVE BRAIN CONTEXT.
 * (Arm E: an opening labelled as partial support still anchored the recommendation. Arm C: without it, the Brain
 * followed her Objective.) Nothing here deletes, rewrites or invalidates an opening: history — the persisted map, the
 * Objective's lineage, the assessment — is untouched. `part` is not "false"; it is "not safe as the current basis".
 *
 * THE DOMAIN RULE IS PER OBJECTIVE (`basisFor`). For a live Objective:
 *   wording never modified            → its lineage openings are basis (unchanged behaviour)
 *   wording modified                  → only an opening the saved assessment of her CURRENT wording found to support ALL
 *                                       of it, judged against the very statement the current map carries. Anything
 *                                       else — part, none, unassessed, no assessment, a reworded statement — is not.
 *   a typo edit (assessed by rule)    → the basis of her previous wording carries forward
 * Text inequality is never evidence of applicability. The only other relationship that makes an opening basis is the
 * lineage of an Objective created through the normal reconciliation path — which is simply an unmodified Objective here.
 * Reconciliation's continuity findings (reaffirmed_by_run, spans_live, may_relate) are NOT read: they infer continuity;
 * they do not establish that an opening supports her current wording.
 */
import type { AssessmentResult } from "./changeAssessment";
import type { Objective, ObjectiveEvent } from "../contracts/objectiveEntity";
import type { OpportunityMap } from "../contracts/opportunity";

/** What a `change_assessed` event carries in `delta.changeAssessment`. Written by services/objectiveChangeAssessment.ts. */
export interface ChangeAssessmentRecord {
  version: string;
  modifyEventId: string | null;
  /** Her wording that was assessed (currentDesired), and the wording it replaced. */
  wording: string;
  previousWording: string;
  /** True when the replaced wording was the Objective's original (it had never been modified). A rule result then
   *  carries forward the unmodified basis. */
  previousWasOriginal: boolean;
  /** The opening statements the assessment was judged against, exactly. */
  openings: Array<{ key: string; statement: string }>;
  result: AssessmentResult;
}

export type ExclusionReason =
  | "not_assessed"         // modified, and no assessment of her current wording exists (legacy edits land here)
  | "unassessed"           // the assessment ran and failed — fail closed
  | "part" | "none"        // the assessment's own verdict for this opening
  | "missing_from_result"  // the assessment did not cover this opening
  | "statement_changed"    // the current map words this key differently from what was assessed — not evidence
  | "shared_map";          // v1 LIMITATION: basis for THIS Objective, withheld because another Objective excludes it

export interface BasisExclusion { key: string; objectiveId: string; because: ExclusionReason }

/** The saved assessments, per Objective, oldest first — read from its `change_assessed` events. */
export function changeAssessmentsFrom(events: ObjectiveEvent[]): ChangeAssessmentRecord[] {
  return events
    .filter((e) => e.action === "change_assessed" && e.delta?.changeAssessment)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => e.delta!.changeAssessment as unknown as ChangeAssessmentRecord);
}

const statementIn = (map: OpportunityMap | null, key: string) => map?.opportunities.find((o) => o.key === key)?.statement.value;

/**
 * THE DOMAIN RULE: which of ONE Objective's lineage openings are its current basis, and why each other one is not.
 * `assessments` are that Objective's saved assessments, oldest first. `map` is the map the Brain will be given.
 */
export function basisFor(o: Objective, assessments: ChangeAssessmentRecord[], map: OpportunityMap | null): { kept: string[]; excluded: BasisExclusion[] } {
  const keys = o.lineage?.opportunityKeys ?? [];
  if (!o.modifiedFrom) return { kept: [...keys], excluded: [] };
  const exclude = (because: ExclusionReason, only?: string[]) => ({ kept: [] as string[], excluded: (only ?? keys).map((key) => ({ key, objectiveId: o.id, because })) });

  let wording = o.desiredState.value;
  for (let hops = 0; hops <= assessments.length; hops++) {
    const a = [...assessments].reverse().find((x) => x.wording === wording);
    if (!a) return exclude("not_assessed");
    const r = a.result;
    if (r.status === "unassessed") return exclude("unassessed");
    if (r.by === "rule") {
      if (a.previousWasOriginal) return { kept: [...keys], excluded: [] };
      wording = a.previousWording; // a typo edit: the basis of the wording it corrected carries forward
      continue;
    }
    const kept: string[] = []; const excluded: BasisExclusion[] = [];
    for (const key of keys) {
      const verdict = r.assessment.openings.find((x) => x.key === key);
      const assessed = a.openings.find((x) => x.key === key)?.statement;
      const because: ExclusionReason | null = !verdict ? "missing_from_result"
        : verdict.supports !== "all" ? verdict.supports
        : assessed === undefined || assessed !== statementIn(map, key) ? "statement_changed"
        : null;
      if (because) excluded.push({ key, objectiveId: o.id, because }); else kept.push(key);
    }
    return { kept, excluded };
  }
  return exclude("not_assessed"); // a cycle of rule results with no original — fail closed
}

/**
 * v1 LIMITATION — NOT THE DOMAIN RULE. Applicability is per Objective (`basisFor`), but today's Brain input has ONE
 * OpportunityMap and ONE citation namespace for the whole run: it cannot show an opening "for Objective P only", and
 * Arm E showed an opening present anywhere anchors the Brain. So a key any live Objective excludes is withheld from the
 * shared map, and every Objective that DID keep it records `shared_map` — the per-Objective truth stays on the record.
 * Lifting this (per-Objective maps, scoped citations) is a Brain input-contract change, out of scope for Slice 3.
 */
export function sharedMapExclusions(perObjective: Array<{ kept: string[]; excluded: BasisExclusion[]; objectiveId: string }>): BasisExclusion[] {
  const withheld = new Set(perObjective.flatMap((b) => b.excluded.map((x) => x.key)));
  return [
    ...perObjective.flatMap((b) => b.excluded),
    ...perObjective.flatMap((b) => b.kept.filter((k) => withheld.has(k)).map((key) => ({ key, objectiveId: b.objectiveId, because: "shared_map" as const }))),
  ];
}

/**
 * What the Brain is given: a COPY of the map without the withheld openings (so they can be neither rendered nor
 * cited — grounding resolves `opportunity[<key>]` against this map), and the exclusions to store with the run.
 * The persisted map is never touched. Openings in no live Objective's lineage are untouched.
 */
export function currentBrainBasis(map: OpportunityMap | null, live: Objective[], assessmentsByObjective: ReadonlyMap<string, ChangeAssessmentRecord[]>): { map: OpportunityMap | null; excludedOpenings: BasisExclusion[] } {
  const per = live.map((o) => ({ objectiveId: o.id, ...basisFor(o, assessmentsByObjective.get(o.id) ?? [], map) }));
  const excludedOpenings = sharedMapExclusions(per);
  if (!excludedOpenings.length || !map) return { map, excludedOpenings };
  const withheld = new Set(excludedOpenings.map((x) => x.key));
  return { map: { ...map, opportunities: map.opportunities.filter((o) => !withheld.has(o.key)) }, excludedOpenings };
}
