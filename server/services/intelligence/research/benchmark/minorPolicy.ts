/**
 * research/benchmark/minorPolicy.ts — `minor-evidence-policy/2` (corrected 13 Sep 2026).
 *
 * Minor status triggers DATA MINIMIZATION, not a reduced research model: the same ResearchSpec runs
 * (S9 included, narrowly framed), and publicly sourced athletic identity, affiliations, sport/position/
 * level, performance, national-team participation, trajectory, media, public narrative, commercial
 * relationships, public social presence and materially relevant reputation evidence are all kept.
 * What is removed is only what the policy prohibits: home/street addresses, personal phone numbers and
 * e-mails, an exact date of birth when a year suffices, private family/contact detail, and unsourced
 * (uncited) reputation material. Redaction is deterministic (closed field names and regexes), applied
 * to the STORED artifact after metrics are computed. Pure.
 *
 * Activation: the cohort flag, or reliable cited evidence that deterministically establishes the athlete
 * is under 18 at the as-of date (a cited birth-year claim where asOfYear − birthYear ≤ 17). Never from
 * "high school", youth leagues or other contextual clues.
 */

import type { ArmRun, DerivedArm, EvidenceRecord } from "./types";

export const MINOR_POLICY_VERSION = "minor-evidence-policy/2";

/** Value/claim fields never retained for a minor (exact field names, closed). */
const PROHIBITED_FIELDS = ["address", "homeAddress", "home_address", "streetAddress", "street_address", "street", "phone", "phoneNumber", "phone_number", "mobile", "email", "emailAddress", "email_address", "dateOfBirth", "date_of_birth", "dob", "birthDate", "birth_date", "birthday", "parents", "parent", "mother", "father", "guardian", "siblings", "familyIncome", "homeSchool"];
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?\d{1,2}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const STREET_RE = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Court|Ct\.?|Way|Place|Pl\.?)\b/g;
/** A full date of birth in text; the year is kept. */
const DOB_RE = /\b(?:born|birth(?:date| date)?|dob)[^.\n]{0,20}?((?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(\d{4})|(\d{4})-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/(\d{4}))/gi;

export function minimizeText(text: string): { text: string; redactions: number } {
  let n = 0;
  let out = text.replace(EMAIL_RE, () => { n++; return "[email redacted]"; });
  out = out.replace(PHONE_RE, () => { n++; return "[phone redacted]"; });
  out = out.replace(STREET_RE, () => { n++; return "[street address redacted]"; });
  out = out.replace(DOB_RE, (m, _d, y1, y2, y3) => { const y = y1 ?? y2 ?? y3; n++; return `born ${y}`; });
  return { text: out, redactions: n };
}

function minimizeValue(v: unknown, applied: string[]): unknown {
  if (typeof v === "string") { const r = minimizeText(v); if (r.redactions) applied.push(`text:${r.redactions}`); return r.text; }
  if (Array.isArray(v)) return v.map((x) => minimizeValue(x, applied));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (PROHIBITED_FIELDS.includes(k)) { applied.push(`drop:${k}`); continue; }
      out[k] = minimizeValue(x, applied);
    }
    return out;
  }
  return v;
}

/** Deterministic under-18 check from a cited, non-suspect birth_year claim. Ambiguous years (could be 18 this year) do NOT trigger. */
export function establishesMinor(evidence: EvidenceRecord[], asOf: string): { minor: boolean; birthYear: number | null; evidenceId: string | null } {
  const asOfYear = Number(asOf.slice(0, 4));
  for (const e of evidence) {
    if (e.claimedFactKey !== "birth_year" || e.lineage !== "cited" || e.suspect) continue;
    const y = Number((e.claim.value as any)?.year ?? (e.claim.value as any));
    if (Number.isInteger(y) && y > 1900 && asOfYear - y <= 17) return { minor: true, birthYear: y, evidenceId: e.id };
  }
  return { minor: false, birthYear: null, evidenceId: null };
}

export interface MinimizationReport { version: string; textRedactions: number; fieldsDropped: string[]; claimsDropped: Array<{ id: string; reason: string }> }

/** Apply minimization to the stored arm: provider text, chunk/support text and quotes keep everything except PII patterns; claims lose prohibited fields; uncited reputation claims are dropped. */
export function minimizeArmForMinor(arm: ArmRun, derived: DerivedArm): { arm: ArmRun; derived: DerivedArm; report: MinimizationReport } {
  const applied: string[] = [];
  let textRedactions = 0;
  const txt = (s: string) => { const r = minimizeText(s); textRedactions += r.redactions; return r.text; };
  const uncitedReputation = new Set(derived.evidence.filter((e) => e.kind === "reputation_event" && (e.lineage !== "cited" || e.suspect)).map((e) => e.id));
  const claimsDropped: MinimizationReport["claimsDropped"] = [...uncitedReputation].map((id) => ({ id, reason: "reputation_event without a cited source (unsourced allegation)" }));
  const armOut: ArmRun = {
    ...arm,
    minorRedacted: true,
    search: arm.search.map((e) => ({ ...e, answerText: txt(e.answerText), raw: null, chunks: e.chunks.map((c) => ({ ...c, text: txt(c.text) })), supports: e.supports.map((s) => ({ ...s, text: txt(s.text) })) })),
    extraction: arm.extraction ? {
      ...arm.extraction, raw: null,
      claims: arm.extraction.claims.filter((c, i) => !uncitedReputation.has(`${arm.provider}:e${i}`)).map((c) => ({ ...c, claim: minimizeValue(c.claim, applied) as Record<string, unknown>, citation: c.citation ? { chunkIds: c.citation.chunkIds, quote: txt(c.citation.quote) } : null })),
    } : null,
  };
  const derivedOut: DerivedArm = {
    ...derived,
    evidence: derived.evidence.filter((e) => !uncitedReputation.has(e.id)).map((e) => ({ ...e, claim: minimizeValue(e.claim, applied) as Record<string, unknown>, quote: e.quote ? txt(e.quote) : null })),
    followerMentions: derived.followerMentions.map((m) => ({ ...m, quote: txt(m.quote) })),
  };
  return { arm: armOut, derived: derivedOut, report: { version: MINOR_POLICY_VERSION, textRedactions, fieldsDropped: [...new Set(applied)], claimsDropped } };
}
