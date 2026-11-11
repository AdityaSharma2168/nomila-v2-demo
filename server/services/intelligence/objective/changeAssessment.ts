/**
 * objective/changeAssessment.ts — `objective-change-assessment/0.2.0-exp`: the PURE half of the minimum viable
 * assessment (slice3-assessment-minimal.md). Contract, the conservative mechanical bypass, the verifier and the
 * advisory consequences. The provider call lives outside `intelligence/` (services/objectiveChangeAssessment.ts).
 *
 * THE CURRENT OBJECTIVE IS AUTHORITATIVE. OPENINGS SUPPORT IT; THEY DO NOT DEFINE IT. PARTIAL SUPPORT IS VALID SUPPORT
 * BUT NEVER AUTHORITY OVER THE WHOLE. A PART OF THE OBJECTIVE WITH NO SUPPORTING OPENING REMAINS PART OF THE OBJECTIVE.
 *
 * After an athlete edits an Objective, two questions only, both against her CURRENT wording:
 *   success  — does the existing success condition still fit?  fits | needs_review
 *   openings — does each historical opening support all, part or none of it? (part names WHICH part, in her words)
 * Every judgment is grounded in exact quotes that code verifies. Code never judges meaning; the fixtures do.
 *
 * ADVISORY ONLY: nothing here mutates, supersedes, alters lifecycle, rewrites success or removes her direction. Any
 * failure is `unassessed` — never "no change".
 *
 * 0.2.0-exp replaces 0.1.x's change taxonomy, horizon verdict, absence machinery and quantified rule: no downstream
 * behaviour needed them (slice3-assessment-minimal.md §3).
 */

export const OBJECTIVE_CHANGE_ASSESSMENT_VERSION = "objective-change-assessment/0.2.0-exp";

export const SUCCESS_VERDICTS = ["fits", "needs_review"] as const;
export const OPENING_SUPPORT = ["all", "part", "none"] as const;
export type SuccessVerdict = (typeof SUCCESS_VERDICTS)[number];
export type OpeningSupport = (typeof OPENING_SUPPORT)[number];

/**
 * What the assessment works from. `previousDesired` is used ONLY by the mechanical bypass (code); the model is given
 * her current wording, the success condition and the openings — never the old wording.
 */
export interface ChangeInput {
  previousDesired: string;
  currentDesired: string;
  success: string;
  openings: Array<{ key: string; domain: string; statement: string }>;
}

export interface Assessment {
  success: { verdict: SuccessVerdict; reason: string; objectiveQuote: string; successQuote: string };
  openings: Array<{ key: string; supports: OpeningSupport; part?: string; openingQuote: string; reason: string }>;
}

export type AssessmentResult =
  | { status: "assessed"; version: typeof OBJECTIVE_CHANGE_ASSESSMENT_VERSION; by: "model"; assessment: Assessment; model: string; promptSha256: string }
  /** A mechanical edit: the meaning did not change, so the previous result carries forward. No call was made. */
  | { status: "assessed"; version: typeof OBJECTIVE_CHANGE_ASSESSMENT_VERSION; by: "rule"; carriesForward: true; because: string }
  | { status: "unassessed"; version: typeof OBJECTIVE_CHANGE_ASSESSMENT_VERSION; reason: string };

// ── the conservative mechanical bypass (unchanged since 0.1.0) ──────────────────────────────────

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "her", "his", "their", "its", "into", "as", "by", "at", "from", "that", "this", "is", "are", "be", "my", "i", "me", "she", "has", "have", "been", "will", "so", "it", "any", "no"]);

/** Lowercase, punctuation → space EXCEPT inside numbers, whitespace collapsed. "$5,000" stays "5,000". */
export function normalize(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(\d)[.,](?=\d)/g, "$1\u0000")
    .replace(/[^a-z0-9\u0000\s]/g, " ")
    .replace(/\u0000/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

const contentTerms = (s: string): string[] => [...new Set(normalize(s).split(" ").filter((t) => t && !STOP.has(t)))];
const digitGroups = (s: string): string[] => String(s ?? "").match(/\d[\d.,]*/g) ?? [];

/** Damerau–Levenshtein restricted to distance ≤ 1. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/**
 * Only what code can establish as mechanically equivalent skips the model: (a) identical after normalizing case,
 * whitespace and punctuation, with every number unchanged; (b) a one-edit spelling correction of exactly one lowercase,
 * letters-only word of ≥ 5 letters, where the corrected word already appears in the success condition. Anything else —
 * names, brands, numbers, platforms, negation, two words — runs the assessment.
 */
export function mechanicalBypass(input: Pick<ChangeInput, "previousDesired" | "currentDesired" | "success">): { bypass: boolean; because: string } {
  const { previousDesired: o, currentDesired: n } = input;
  if (JSON.stringify(digitGroups(o)) !== JSON.stringify(digitGroups(n))) return { bypass: false, because: "a number changed" };
  if (normalize(o) === normalize(n)) return { bypass: true, because: "identical after normalizing case, whitespace and punctuation" };
  const ow = String(o).trim().split(/\s+/), nw = String(n).trim().split(/\s+/);
  if (ow.length !== nw.length) return { bypass: false, because: "the word count changed" };
  const diffs = ow.map((w, i) => [w, nw[i]] as const).filter(([a, b]) => normalize(a) !== normalize(b));
  if (diffs.length !== 1) return { bypass: false, because: `${diffs.length} words changed` };
  const [rawOld, rawNew] = diffs[0];
  const a = normalize(rawOld), b = normalize(rawNew);
  if (/[A-Z]/.test(rawOld) || /[A-Z]/.test(rawNew)) return { bypass: false, because: "the changed word is capitalized (it may be a name)" };
  if (!/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return { bypass: false, because: "the changed word is not letters only" };
  if (a.length < 5 || b.length < 5) return { bypass: false, because: "the changed word is shorter than 5 letters" };
  if (!withinOneEdit(a, b)) return { bypass: false, because: "the change is more than one edit" };
  if (!contentTerms(input.success).includes(b)) return { bypass: false, because: `the corrected word "${b}" is not already used by the success condition — spelling not verifiable` };
  return { bypass: true, because: `spelling correction "${a}" → "${b}", a word the Objective already uses` };
}

// ── the verifier: shape and real quotes only ────────────────────────────────────────────────────

const occursIn = (hay: string, span: unknown) => { const s = normalize(String(span ?? "")); return s.length > 0 && ` ${normalize(hay)} `.includes(` ${s} `); };
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/**
 * CODE DECIDES ONLY WHAT CODE CAN KNOW: the shape, and that every quote is real. Any failure makes the whole result a
 * failure (`unassessed`); nothing is repaired.
 *   1. valid verdicts; every opening assessed exactly once, by its bare key; no extra keys
 *   2. `objectiveQuote` occurs in her current wording; `successQuote` occurs in the success condition
 *   3. each `openingQuote` occurs in that opening
 *   4. `part` is present iff `supports = "part"`, and occurs in her current wording
 *   5. reasons are non-empty
 */
export function verifyAssessment(input: ChangeInput, raw: unknown): { ok: true; assessment: Assessment } | { ok: false; problems: string[] } {
  const p: string[] = [];
  const x = raw as any;
  if (!x || typeof x !== "object") return { ok: false, problems: ["reply is not an object"] };
  if (!(SUCCESS_VERDICTS as readonly string[]).includes(x.success?.verdict)) p.push(`success.verdict "${x.success?.verdict}" is not one of ${SUCCESS_VERDICTS.join(", ")}`);
  const openings: any[] = Array.isArray(x.openings) ? x.openings : [];
  if (!Array.isArray(x.openings)) p.push("openings is not an array");
  const keys = input.openings.map((o) => o.key);
  for (const k of keys) { const n = openings.filter((o) => o?.key === k).length; if (n !== 1) p.push(`opening ${k} assessed ${n} times — exactly once`); }
  for (const o of openings) if (!keys.includes(o?.key)) p.push(`opening "${o?.key}" is not one of the Objective's openings`);
  if (!occursIn(input.currentDesired, x.success?.objectiveQuote)) p.push(`success.objectiveQuote "${String(x.success?.objectiveQuote).slice(0, 60)}" does not occur in her current wording`);
  if (!occursIn(input.success, x.success?.successQuote)) p.push(`success.successQuote "${String(x.success?.successQuote).slice(0, 60)}" does not occur in the success condition`);
  if (!nonEmpty(x.success?.reason)) p.push("success.reason is missing");
  for (const [i, o] of openings.entries()) {
    if (!(OPENING_SUPPORT as readonly string[]).includes(o?.supports)) p.push(`openings[${i}].supports "${o?.supports}" is not one of ${OPENING_SUPPORT.join(", ")}`);
    const statement = input.openings.find((y) => y.key === o?.key)?.statement;
    if (statement !== undefined && !occursIn(statement, o?.openingQuote)) p.push(`openings[${i}].openingQuote "${String(o?.openingQuote).slice(0, 60)}" does not occur in opening ${o?.key}`);
    const hasPart = o?.part !== undefined && o?.part !== null && String(o.part).trim() !== "";
    if (o?.supports === "part" && !hasPart) p.push(`openings[${i}]: "part" names no part of her current wording`);
    if (o?.supports !== "part" && hasPart) p.push(`openings[${i}]: a part is given but supports is "${o?.supports}"`);
    if (o?.supports === "part" && hasPart && !occursIn(input.currentDesired, o.part)) p.push(`openings[${i}].part "${String(o.part).slice(0, 60)}" does not occur in her current wording`);
    if (!nonEmpty(o?.reason)) p.push(`openings[${i}].reason is missing`);
  }
  return p.length ? { ok: false, problems: p } : { ok: true, assessment: x as Assessment };
}

// ── advisory consequences ───────────────────────────────────────────────────────────────────────

export type OpeningBasis = { supports: "all" } | { supports: "part"; part: string } | "not_current" | "unconfirmed" | "carried_forward";

/**
 * What the assessment lets Nomila do — and nothing more. No lifecycle, supersede or rewrite field exists here: the
 * edit sheet asks her about success when it needs review; B renders support per opening. An unassessed result asks the
 * success question and leaves every opening unconfirmed.
 */
export function consequencesOf(input: ChangeInput, r: AssessmentResult): { askSuccess: boolean; basis: Record<string, OpeningBasis> } {
  if (r.status === "unassessed") return { askSuccess: true, basis: Object.fromEntries(input.openings.map((o) => [o.key, "unconfirmed" as const])) };
  if (r.by === "rule") return { askSuccess: false, basis: Object.fromEntries(input.openings.map((o) => [o.key, "carried_forward" as const])) };
  return {
    askSuccess: r.assessment.success.verdict === "needs_review",
    basis: Object.fromEntries(r.assessment.openings.map((o) => [o.key, o.supports === "all" ? { supports: "all" as const } : o.supports === "part" ? { supports: "part" as const, part: o.part! } : ("not_current" as const)])),
  };
}
