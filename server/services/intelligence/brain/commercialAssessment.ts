/**
 * brain/commercialAssessment.ts — the EXPERIMENTAL commercial-assessment envelope and its renderers.
 *
 * NOT A CONTRACT. `commercial-intelligence-brain-boundary-checkpoint.md` §4 renders, for one subject (a work item),
 * what specialized Commercial Intelligence would hand the Brain: what the offer is, what it is worth under Nomila's
 * own rule, which basis governs it and where it stands, which terms are established as not stated and which are
 * UNKNOWN to Nomila, what each historical economic reference establishes and whether it is comparable, and what about
 * the athlete's commercial history is observed. Every line is a fact with a source: `code` (a mounted, deterministic
 * Deals function run on the terms) or `hand` (a rate-eval-spec/2.0.0 rule applied by hand, the rule named).
 *
 * This module renders and types only. The values are computed OUTSIDE `services/intelligence/` (the assembler),
 * because the producers live in the Deals system, which imports providers. Nothing here decides, scores or advises.
 *
 * EPISTEMIC DISCIPLINE (the review of #622): NOT EXTRACTED ≠ NOT STATED · NOT OBSERVED ≠ NONE · NO NOMILA RECORD ≠
 * NO REAL-WORLD HISTORY. Absence is stated only for the three terms the extractor reads; usage rights render UNKNOWN.
 *
 * Placement is an experimental ablation (§4.2): `work` renders the lines under the work item, cited `work[<id>].<key>`;
 * `state` renders them as an appended ATHLETE STATE section, cited `commercialPosition.assessment.<key>`. The
 * `state` placement is NOT an implied Athlete State contract.
 */

export const COMMERCIAL_ASSESSMENT_VERSION = "commercial-assessment/0.1.0-exp";
/** The thin-slice projection: the same envelope, assembled from ROWS by the mounted Deals functions (deals-intelligence-brain-leverage-checkpoint.md §9). */
export const DEAL_PROJECTION_VERSION = "deal-assessment-projection/0.1.0-exp";

/** C1 renders the rate card as numbers with no reading; C2a the mounted lines; C2 the mounted lines plus the hand-applied rules. */
export const ASSESSMENT_CONDITIONS = ["C1", "C2a", "C2", "projection"] as const;
export type AssessmentCondition = (typeof ASSESSMENT_CONDITIONS)[number];
export const ASSESSMENT_PLACEMENTS = ["work", "state"] as const;
export type AssessmentPlacement = (typeof ASSESSMENT_PLACEMENTS)[number];

export interface AssessmentLine {
  /** The citable key: `offer`, `value`, `basis`, `range`, `band`, `absent`, `unknown`, `exclusivity`, `contract`, `history_<n>`, `high`, `observed`, `rateCard`. */
  key: string;
  text: string;
  /** `code` — a mounted deterministic function on the terms. `hand` — a 2.0.0 rule applied by hand; `rule` names it. */
  source: "code" | "hand";
  rule?: string;
}

export interface CommercialAssessment {
  version: typeof COMMERCIAL_ASSESSMENT_VERSION | typeof DEAL_PROJECTION_VERSION;
  /** The row id assessed. */
  subject: string;
  /** The subject reference the lines are cited under — `deal[<id>]` (0.6.0-exp). */
  subjectRef: string;
  condition: AssessmentCondition;
  assembledBy: "code" | "code+hand";
  asOf: string;
  lines: AssessmentLine[];
  /** The raw computed values, for the artifact and for state-path resolution under the `state` placement. */
  values: Record<string, unknown>;
  provenance: { functions: string[]; rules: string[]; transcription: string };
}

export interface CommercialAttachment {
  placement: AssessmentPlacement;
  assessment: CommercialAssessment;
}

const HEADER_C2 = "derived by Nomila's deal economics from the terms above, deterministic; lines marked ‡ apply Nomila's rate-intelligence rules by hand";
const HEADER_C1 = "the athlete's rate card as Nomila computes it, per deal type, low / mid / high in USD — numbers only";
const HEADER_PROJECTION = "assembled from Nomila's own records of this thread by its deal economics, deterministic; where a line says model, that is Nomila's summariser or scorer; a unit is stated only where a source establishes it";

function header(a: CommercialAssessment): string {
  return a.condition === "projection" ? HEADER_PROJECTION : a.condition === "C1" ? HEADER_C1 : HEADER_C2;
}

/** Lines under a work item. `pad` is the item's inner indentation. */
export function renderAssessmentUnderWork(a: CommercialAssessment, pad = "        "): string[] {
  const L: string[] = [];
  L.push(`${pad}commercial assessment (${a.version} · ${header(a)}). Cite as ${a.subjectRef}.<key>.`);
  for (const l of a.lines) L.push(`${pad}${l.source === "hand" ? "‡ " : "  "}${a.subjectRef}.${l.key}  ${l.text}`);
  return L;
}

/** An appended ATHLETE STATE section — the experimental `state` placement ablation. */
export function renderAssessmentStateSection(a: CommercialAssessment): string {
  const L: string[] = [];
  L.push("");
  L.push(`COMMERCIAL ASSESSMENT — about ${a.subjectRef} (${a.version} · ${header(a)}).`);
  L.push("  Cite each line by the path at its left.");
  for (const l of a.lines) L.push(`    ${l.source === "hand" ? "‡ " : "  "}commercialPosition.assessment.${l.key}  ${l.text}`);
  return L.join("\n");
}

/** The object attached at `commercialPosition.assessment` so state-path citations resolve under the `state` placement. */
export function assessmentStateObject(a: CommercialAssessment): Record<string, string> {
  return Object.fromEntries(a.lines.map((l) => [l.key, l.text]));
}
