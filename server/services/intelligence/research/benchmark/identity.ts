/**
 * research/benchmark/identity.ts — identity fidelity of one arm (decision 12 Sep 2026).
 *
 * Five measures, all from the arm's own derived evidence and the evaluation-only gold sheet:
 * correct-person resolution (extractor identity confidence + agreement with confirmed anchor
 * fields), conflicting identity evidence within the arm, conflated facts (evaluation-only
 * negative anchors — never shown to a provider), unsupported claims (lineage), and abstention
 * (reported not_found sections/items and "not found" statements versus invented facts). Pure.
 */

import { norm } from "../lineage";
import type { SearchEnvelope } from "../providers";
import type { SectionId } from "../spec/researchSpecV1";
import type { DerivedArm, GoldIdentity, IdentityFidelity } from "./types";

const FIELD_KEYS: Record<keyof GoldIdentity["confirmed"], string[]> = {
  sport: ["sport"], affiliation: ["affiliation"], hometown: ["hometown"], nationality: ["nationality"], career_status: ["career_status"], national_team_participation: ["national_team_participation"],
};
const SINGLE_IDENTITY_KEYS = ["sport", "hometown", "nationality", "class_year", "career_status", "position", "name", "birth_year"];

const NOT_FOUND_RE = /\b(could not|couldn't|cannot|can't|unable to|was not able to|no (?:reliable |verifiable |public )?(?:information|results?|records?|sources?|evidence)|not (?:found|available|publicly available|verifiable)|(?:do|does) not appear|insufficient (?:information|evidence)|no such athlete|could not be resolved)\b/gi;

function agrees(valueText: string, accepted: string[]): boolean {
  const v = norm(valueText);
  return accepted.some((a) => { const n = norm(a); return n.length > 0 && (v.includes(n) || n.includes(v)); });
}

export function identityFidelity(arm: DerivedArm, gold: GoldIdentity | null, search: SearchEnvelope[]): IdentityFidelity {
  const cited = arm.evidence.filter((e) => e.lineage === "cited" && !e.suspect);
  const details: IdentityFidelity["anchorAgreement"]["details"] = [];
  if (gold) for (const [field, accepted] of Object.entries(gold.confirmed) as Array<[keyof GoldIdentity["confirmed"], string[]]>) {
    if (!accepted?.length) continue;
    for (const e of cited) if (e.claimedFactKey && FIELD_KEYS[field].includes(e.claimedFactKey)) details.push({ field, valueText: e.valueText, agree: agrees(e.valueText, accepted) });
  }
  const agree = details.filter((d) => d.agree).length;
  const conflictingIdentity: IdentityFidelity["conflictingIdentity"] = [];
  for (const key of SINGLE_IDENTITY_KEYS) {
    const values = [...new Set(cited.filter((e) => e.claimedFactKey === key).map((e) => e.valueText))];
    if (values.length > 1) conflictingIdentity.push({ factKey: key, values });
  }
  const conflated: IdentityFidelity["conflated"] = [];
  for (const neg of gold?.negativeAnchors ?? []) {
    const n = norm(neg);
    if (!n) continue;
    for (const e of arm.evidence) if (norm(`${e.valueText} ${JSON.stringify(e.claim)} ${e.quote ?? ""}`).includes(n)) conflated.push({ evidenceId: e.id, matched: neg });
  }
  const unsupported = arm.evidence.filter((e) => e.lineage !== "cited" || e.suspect).length;
  const namesakesReported = arm.evidence.filter((e) => e.kind === "identity_signal" && String(e.claim.topic ?? "").toLowerCase() === "namesake").length;
  const sectionsNotFound = (Object.entries(arm.sectionOutcomes) as Array<[SectionId, { status: string }]>).filter(([, o]) => o.status === "not_found").map(([id]) => id).sort();
  let itemsNotFound = 0, itemsNotApplicable = 0;
  for (const c of arm.coverage) for (const i of c.items) { const o = i.derived === "found_cited" ? "found_cited" : (i.reported ?? i.derived); if (o === "not_found") itemsNotFound++; else if (o === "not_applicable") itemsNotApplicable++; }
  let explicitNotFound = 0;
  for (const e of search) { NOT_FOUND_RE.lastIndex = 0; explicitNotFound += (e.answerText.match(NOT_FOUND_RE) ?? []).length; }
  const claims = arm.evidence.length;
  const aic = arm.aboutIdentityConfidence;
  // A semantic result only: an extraction that failed (infrastructure) never counts as the provider abstaining.
  const abstained = !arm.extractionFailed && (claims === 0 || (aic != null && aic < 0.5 && cited.length === 0));
  return {
    aboutIdentityConfidence: aic,
    anchorAgreement: { checked: details.length, agree, disagree: details.length - agree, details },
    conflictingIdentity, conflated,
    unsupported: { count: unsupported, share: claims ? unsupported / claims : null },
    namesakesReported,
    abstention: { sectionsNotFound, itemsNotFound, itemsNotApplicable, explicitNotFound, claims, abstained },
  };
}
