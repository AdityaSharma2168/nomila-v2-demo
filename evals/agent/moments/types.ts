/**
 * evals/agent/moments/types.ts — the shapes of the moments stage (`npm run eval:agent -- --stage moments`).
 *
 *   MomentsCase    one JSON file in evals/agent/moments/cases/: a MADE-UP athlete (never a real person), the facts,
 *                  the moments already on file and the deals the scan reads, what must hold after the scan, the
 *                  "should have found this" golden list, and the scripted answer --mock uses. Dates are written
 *                  relative to the run's day ("+6" = six days from today, "-8" = eight days ago) so a case never ages.
 *   MomentsRecord  what one scan produced: its run trace, the moment facts and candidate posts after it, what it held.
 *                  Graders read ONLY this, so a saved record can be graded again without a model.
 */
import type { RunTrace } from "../types";

/** A date in a case: "+N" / "-N" days from the run's day, or a fixed YYYY-MM-DD / YYYY-MM. */
export type CaseDate = string;

export interface MomentsCaseFact {
  key: string;
  subject_kind: "athlete" | "organization" | "event" | "person" | "other";
  subject_name: string;
  claim: string;
  type: "said" | "found";
  date: CaseDate | null;
  topic?: string;
  /** An identity field the fact states (team, school, league …) and its value. */
  field?: string;
  field_value?: string;
  care?: boolean;
}

export interface MomentsCaseMoment {
  key: string;
  name: string;
  claim: string;
  date: CaseDate;
  date_precision?: "day" | "month";
  /** "moment" or "upcoming" (owned by the scan), or another research topic (an event fact research filed elsewhere). */
  topic: string;
  /** The candidate post on file, when a previous scan wrote one. */
  idea?: { hook: string; format: string; platform: string };
}

export interface MomentsCaseDeal {
  key: string;
  brand: string;
  category: string | null;
  status: string;
  term_start: CaseDate | null;
  term_end: CaseDate | null;
  signed: boolean;
}

export interface MomentsCase {
  id: string;
  /** False until the owner has checked the golden list. */
  reviewed: boolean;
  description: string;
  /** The day --mock runs on (fixed, so a mock record is the same every time); a live run uses the real day. */
  mock_today: string;
  athlete: { name: string; sport: string };
  stage: { label: string; band: string };
  fixture: {
    facts: MomentsCaseFact[]; moments: MomentsCaseMoment[]; deals: MomentsCaseDeal[];
    /** Her "avoid" preferences, as she wrote them ("Never use: …" lists never-use names). */
    preferences?: string[];
    /** The Brief's exclusivity and category conflicts (internal read). */
    conflicts?: Array<{ what: string; blocks: string[] }>;
  };
  expect: {
    min_moments: number;
    max_moments: number;
    /** Moments on file that must be superseded after the scan (passed, or no longer fit). */
    retired: string[];
    /** Moments on file that must still be active after the scan (refreshed or untouched). */
    kept: string[];
    /** "Should have found this": each matched against the kept moments' names and descriptions. */
    golden: Array<{ id: string; match: string | string[]; why: string }>;
    /** Share of the golden list that must be found (0–1). */
    min_recall: number;
    must_not: Array<{ match: string | string[]; why: string }>;
  };
  /** The scripted model answer for --mock: keys written "$F:<fact key>", "$M:<moment key>", "$D:<deal key>". */
  mock: { sources: string[]; moments: Array<Record<string, unknown>>; retire: Array<{ key: string; why: string; reason: string }> };
}

// ─── What a scan produced ──────────────────────────────────────────────────────────────────────────────────────────

export interface RecordedMoment {
  id: string;
  /** The case's key for a moment that was on file before the scan; null for one the scan wrote. */
  caseKey: string | null;
  name: string;
  claim: string;
  date: string | null;
  datePrecision: string | null;
  status: string;
  topic: string | null;
  sourceUrl: string | null;
  sourceRef: string | null;
  /** The run that last wrote it (null: never written by a scan). */
  runId: string | null;
}

export interface RecordedCandidate {
  id: string;
  factId: string;
  response: string;
  rank: number;
  name: string;
  category: string;
  whyNow: string;
  /** moments 1.2.0: the hook and one angle. A row from before (a case's on-file moment) keeps its old fields. */
  idea: { hook: string; angle: string; format: string; platform: string; timing: string };
  brief: { show: string; captionAngle: string; avoid: string };
  mediaNeeds: string;
}

export interface MomentsRecord {
  caseId: string;
  mode: "live" | "mock";
  today: string;
  horizonEnd: string;
  /** The scan's outcome (scanned / skipped:<why> / reused), or the error that stopped it. */
  status: string;
  error?: string;
  run: RunTrace | null;
  /** Every event fact after the scan (moments on file, written, refreshed, linked, retired). */
  moments: RecordedMoment[];
  candidates: RecordedCandidate[];
  applied: { written: string[]; refreshed: string[]; linked: string[]; retired: string[]; passed: string[] } | null;
  held: Array<{ what: string; reason: string }>;
  /** The deals and facts the case gave, by the ids the scan saw (what a source ref may point at). */
  internalRefs: string[];
}
