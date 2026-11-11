/**
 * evals/agent/types.ts — the shapes the agent eval passes around.
 *
 *   EvalCase    one JSON file in evals/agent/cases/ (input, expected facts, must-not list), written and reviewed by people
 *   CaseRecord  what one case's run produced: the runs' traces (from agent_runs), the facts in memory, the Brief, the
 *               onboarding turns and the M.I.A. preview. Graders read ONLY this, so a record saved to disk can be graded
 *               again without a model or a database (the CI test does exactly that with recorded fixtures).
 *   GraderResult  one grader's verdict on one case.
 */

export const EVAL_STAGES = ["research", "understand", "onboarding", "mia", "plan"] as const;
export type EvalStage = (typeof EVAL_STAGES)[number];

/** Alternatives separated by "|"; a list of groups means every group must match inside ONE text (one fact, one line). */
export type MatchSpec = string | string[];

export interface ExpectedFact {
  id: string;
  /** The fact in plain words, for people reading the case and the report. */
  fact: string;
  match: MatchSpec;
  /** A public page that states it. Checked by a person on `checked`. */
  source_url: string;
  checked: string;
}

export type MustNotKind = "contact" | "address" | "family" | "invented_sponsor" | "wrong_person" | "other";

export interface MustNotEntry {
  kind: MustNotKind;
  match: MatchSpec;
  why: string;
  /** "fail" (default) fails the grader; "warn" is reported but does not fail it. */
  severity?: "fail" | "warn";
}

export interface EvalCase {
  id: string;
  /** False until the owner has checked the expected facts and the must-not list. */
  reviewed: boolean;
  description: string;
  tags: Record<string, string>;
  input: {
    name: string;
    sport: string;
    /** What the athlete would tell us beyond name and sport (e.g. team or school), only when the identity test needs it. */
    said?: string[];
  };
  expected: {
    /** resolved = research should know who this is; disputed = it should flag the identity; any = either is fine. */
    identity: "resolved" | "disputed" | "any";
    /** Share of expected facts that must be found (0–1). Null when the case has no expected facts. */
    min_recall: number | null;
    facts: ExpectedFact[];
  };
  must_not: MustNotEntry[];
  /** For an identity-only case: the pages that show the name is shared. */
  identity_sources?: string[];
}

// ─── What a run produced ────────────────────────────────────────────────────────────────────────────────────────────

export interface RunTrace {
  runId: string;
  /** research_a | research_b | merge | understand | turn:<key> | plan */
  role: string;
  skillId: string;
  skillVersion: string;
  model: string;
  effort: string;
  status: string;
  stopReason: string | null;
  error: string | null;
  costMicroUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  /** ended_at − started_at (agent_runs). */
  durationMs: number | null;
  /** Sum of the model steps' durations in the trace. */
  modelMs: number;
  /** The skill's JSON as stored (after code removed never-store facts). */
  json: unknown;
  /** Every source the run's searches consulted. */
  sources: Array<{ url: string; title?: string }>;
  /** Policy steps in the trace (rule, decision, reason). */
  policy: Array<{ rule: string; decision: string; reason: string }>;
}

export interface RecordedFact {
  id: string;
  claim: string;
  type: string;
  status: string;
  subject: { kind: string; name: string };
  sourceUrl: string | null;
  sourceRef: string | null;
  sensitive: boolean;
  runId: string | null;
}

export interface RecordedBriefLine { text: string; kind: "fact" | "inference"; factIds: string[] }
export interface RecordedBrief {
  summary: string;
  sections: Array<{ key: string; title: string; lines: RecordedBriefLine[]; soWhat?: string }>;
  /** understand 1.11.0: the content pillars. Absent on records made before it. */
  contentPillars?: Array<{ key: string; name: string; whyThisAthlete: string; factIds: string[] }>;
  internal: {
    currentSponsors: Array<{ name: string }>;
    pastSponsors: Array<{ name: string }>;
  } | null;
}

export interface RecordedTurn {
  key: string;
  runId: string | null;
  message: string;
  cards: Array<{ kind: string; title?: string; payload: any }>;
  held: string[];
}

export interface RecordedMia {
  status: string;
  score: number | null;
  preliminary: boolean | null;
  computed: string | null;
  costMicroUsd: number;
  latencyMs: number | null;
  error?: string;
}

export interface JudgeCriterion { pass: boolean; reason: string }
export interface JudgeResult {
  provider: string;
  model: string;
  positioning_supported: JudgeCriterion;
  no_unsupported_facts: JudgeCriterion & { statements: string[] };
  costMicroUsd: number;
  latencyMs: number;
  error?: string;
}

export interface CaseRecord {
  caseId: string;
  mode: "live" | "mock";
  /** The stages asked for. */
  stages: EvalStage[];
  /** The stages that finished (a budget or error stop leaves the rest unfinished). Graders grade only these. */
  stagesDone: EvalStage[];
  startedAt: string;
  wallMs: number;
  /** Why the case stopped early, when it did (budget, error). */
  stopped: { reason: "budget" | "error"; detail: string } | null;
  runs: RunTrace[];
  identity: { resolved: boolean; description: string; ambiguity: string } | null;
  facts: RecordedFact[];
  brief: RecordedBrief | null;
  turns: RecordedTurn[];
  mia: RecordedMia | null;
  judge: JudgeResult | null;
  /** The plan step (skill plan), when it ran: what code kept after its checks, and what it held. Absent on old records. */
  plan?: RecordedPlan | null;
}

/** The plan as validated and written (agent/plan): the athlete-facing words, and what the checks held back. */
export interface RecordedPlan {
  /** planned | reused | skipped:<why> */
  status: string;
  stageBand: string | null;
  recommended: Array<{ goal: string; horizon: string; whyNow: string; value: string; valueConfidence: string; factIds: string[] }>;
  gamePlans: string[];
  actions: Array<{ what: string; why: string; kind: string; button: string; dueOn: string | null; eventDate: string | null; deliverableTitle: string; deliverableBody: string; factIds: string[] }>;
  held: Array<{ what: string; reason: string }>;
  missing: string[];
}

// ─── Verdicts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** pass / fail; warn = reported, not failing; skip = not applicable to the stages that ran; info = a measurement. */
export type GraderStatus = "pass" | "fail" | "warn" | "skip" | "info";

export interface GraderResult {
  grader: string;
  status: GraderStatus;
  /** One line a person can read. */
  summary: string;
  /** The number the diff compares, when there is one (recall, cost …). */
  score?: number;
  /** Whether a higher score is better (recall) or worse (cost). */
  higherIsBetter?: boolean;
  details?: unknown;
}
