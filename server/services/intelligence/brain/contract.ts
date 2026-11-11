/**
 * brain/contract.ts — the EXPERIMENTAL Brain: input envelopes and the three-way decision.
 *
 * NOT A CONTRACT. `brain-context-experiment-1.md` runs a pilot athlete's real governed portfolio through an unmounted evaluator
 * so that the Brain contract (the next step) is written from what the run shows, not settled in advance. Every
 * shape here is versioned `0.1.0-exp` and may be reshaped by that design without a ceremony. What is NOT
 * experimental is the discipline: cited inputs, two gates in the execution path, nothing materialised.
 *
 * THE LIVE-OBJECTIVE BOUNDARY. `liveObjectives()` is the Brain's only door to what it may recommend on. A deferred
 * Objective is rendered in its own block as a standing information condition — history and context — and the Brain
 * may only name and request what would resolve it. Nothing here mutates an Objective, re-surfaces one, or writes
 * `information_available`. A declined Objective is rendered so the Brain does not re-propose it, and nothing may be
 * done with it.
 *
 * THE CONTEXT BLOCK IS AN EXPERIMENTAL EVIDENCE ENVELOPE, not a Context Intelligence contract. Nothing about its
 * kinds or shape is inferred to belong in State or in a permanent schema; the experiment exists to discover that.
 */
import type { AthleteState } from "../contracts/athleteState";
import type { Objective } from "../contracts/objectiveEntity";
import type { OpportunityMap } from "../contracts/opportunity";
import type { ConfidenceLevel } from "../contracts/provenance";
import type { CommercialAttachment } from "./commercialAssessment";
import type { BasisExclusion } from "../objective/currentBasis";
import type { SuccessReview } from "../objective/successReview";

export const BRAIN_EXPERIMENT_VERSION = "brain-eval-spec/0.13.0-exp";
export const EXISTING_WORK_VERSION = "existing-work/0.6.0-exp";
export const CONTEXT_BLOCK_VERSION = "context-block/0.1.0";
export const TARGETED_RESEARCH_VERSION = "targeted-research/0.1.0";

// ── Decision Subject — a typed reference to a thing that already exists (brain-decision-subject-checkpoint.md) ──

/**
 * What a decision is ABOUT. A reference, never an entity: it says what the decision concerns and nothing about the
 * thing's lifecycle. Kinds are drawn only from identities that exist or are designed; none is speculative beyond
 * the eight. Rendered and cited as `<kind>[<id>]`.
 */
/**
 * 0.6.0-exp added `outreach_plan`. The vocabulary itself now lives in contracts/subjects.ts, below both the Brain and the
 * intelligence ledger, so there is exactly ONE taxonomy: re-exported here unchanged for every existing caller.
 */
import { SUBJECT_KINDS, subjectRefString, type SubjectKind, type SubjectRef } from "../contracts/subjects";
export { SUBJECT_KINDS, subjectRefString, type SubjectKind, type SubjectRef };
/**
 * Parse `<kind>[<id>]` or an object. `work[<id>]` is accepted for READ COMPATIBILITY ONLY in 0.6.0-exp (recorded
 * artifacts and older fixtures) and maps to a `deal` — it confers no Existing Work semantics. Removed at 0.7.0.
 */
export function parseSubjectRef(v: unknown): SubjectRef | null {
  if (v && typeof v === "object" && typeof (v as any).kind === "string" && typeof (v as any).id === "string")
    return (SUBJECT_KINDS as readonly string[]).includes((v as any).kind) ? { kind: (v as any).kind, id: (v as any).id } : null;
  if (typeof v !== "string") return null;
  const m = /^([a-z]+)\[(.+)\]$/.exec(v.trim());
  if (!m) return null;
  if (m[1] === "work") return { kind: "deal", id: m[2] };
  return (SUBJECT_KINDS as readonly string[]).includes(m[1]) ? { kind: m[1] as SubjectKind, id: m[2] } : null;
}

/** An item in the DECISION SUBJECTS lens: a subject a request names that no other lens renders. Facts only. */
export interface SubjectItem {
  ref: SubjectRef;
  /** One line: what kind of thing and its recorded status — "commercial opportunity · INIU · status detected · not in motion". */
  label: string;
  statement: string;
  facts: string[];
}

// ── Existing work — assembled from real rows, never hand-edited ──────────────────────────────────

/**
 * `activation` and `objectiveId` exist for Brain Decision Experiment 1B only: an unambiguous EXPERIMENTAL representation
 * of "this existing work is advancing this Objective". Nomila holds no such rows; whether production work objects carry
 * this kind or a durable relationship to an Objective is a later architectural question, not inferred from here.
 */
/** 0.4.0-exp: EXISTING WORK is a LENS (what is in motion) over subjects, not a namespace; items carry their subject `ref`. The 0.3.0 `inbound` kind is gone — a detected inbound is a `deal` subject rendered in DECISION SUBJECTS. */
export const WORK_KINDS = ["accepted_deal", "negotiating", "under_review", "activation"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export interface WorkItem {
  /** The row id: a deal id, or an objective id for `under_review`. */
  id: string;
  /** The subject this item IS — cited as `<kind>[<id>]` (0.4.0-exp). `work[<id>]` is a read alias only. */
  ref: SubjectRef;
  kind: WorkKind;
  brand: string | null;
  /** One line, facts only, from the row. */
  statement: string;
  amount: { total: number | null; cash: number | null; product: number | null } | null;
  termStart: string | null;
  termEnd: string | null;
  /** How many deliverable rows Nomila holds for it. 0 is a fact the Brain must read as "not known". */
  deliverablesRecorded: number;
  since: string;
  /** EXPERIMENTAL (1B): the Objective this work is understood to serve. Rendered as "toward objective[<id>]". */
  objectiveId?: string;
  /** EXPERIMENTAL (1B): a controlled overlay item. Recorded in the artifact; NEVER rendered — the Brain sees a fact like any other. */
  controlled?: boolean;
  /**
   * 0.5.0-exp (substrate checkpoint §5): what this work is FOR — the governed Recommendation it executes and/or the
   * Objectives it serves. Rendered as "executing recommendation[<id>]" so a later run can see that its earlier
   * judgment is already in execution. Strategic provenance only; execution lineage stays in the executing system.
   */
  for?: { recommendationId?: string | null; objectiveIds?: string[] };
}

export interface ExistingWork {
  version: typeof EXISTING_WORK_VERSION;
  asOf: string;
  items: WorkItem[];
}

// ── Context — the hand-assembled envelope ──────────────────────────────────────────────────────

export const CONTEXT_KINDS = ["schedule", "recent_result", "upcoming_occasion", "sport_wide_hook", "brand_activity", "control"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export interface ContextItem {
  kind: ContextKind;
  /** One observation. Never a verdict, never advice. */
  statement: string;
  source: { title: string; url: string | null; observedAt: string };
  confidence: ConfidenceLevel;
  /** A real, dated, plainly irrelevant item. If the Brain cites it, that is noise measured. */
  control?: boolean;
}

export interface ContextBlock {
  version: typeof CONTEXT_BLOCK_VERSION;
  asOf: string;
  /** Always "hand" in experiment 1. Labelled in every artifact. */
  assembledBy: "hand";
  window: { from: string; to: string };
  /** Cited as `ctx[<index>]`. */
  items: ContextItem[];
}

// ── Targeted research — an answer persisted as evidence-as-seen (stage 2) ─────────────────────

export interface ResearchBlock {
  version: typeof TARGETED_RESEARCH_VERSION;
  proposition: string;
  /**
   * `requestId` (additive, 27 Sep): the Intelligence Request this block was projected from, when it was — the explicit
   * link a resurfacing consumer needs (never matched by proposition text). Not rendered; the prompt is unchanged.
   */
  requestedBy: { run: string; objectiveId: string; requestId?: string };
  sourceClass: "athlete" | "connected" | "external";
  /** The text the Brain will cite, as `research[<index>]`. Kept verbatim with the run. */
  block: string;
  sources: Array<{ title: string; url: string | null; observedAt: string }>;
  asOf: string;
}

// ── A decision requested — EXPERIMENTAL (1B.3): the question stops being silent ──────────────────

/**
 * Who asked, the question verbatim, what it is about. Nothing else — no fact list, no hint of which facts matter.
 * In the architecture a decision can be posed from the portfolio loop, her agent through Mila, the athlete through
 * Mila, or an event; the block names which. Not a contract; the decision-request door is a 1C question.
 */
export interface DecisionRequest {
  /** Cited as `request[<id>]`. */
  id: string;
  askedBy: string;
  question: string;
  /** The Decision Subject — a typed reference; rendered as `<kind>[<id>]`. */
  about: SubjectRef;
}

// ── Brand research — external research about brands she has a relationship with (0.13.0-exp) ──────

/**
 * One brand Nomila has CONFIRMED research on (inbox_brands with `enrichment.identity.status === "confirmed"`, #778), that
 * she has a relationship with: a deal, or a qualified inbound thread. Rendered as BRAND RESEARCH and cited as
 * `brand[<id>]`. External web research about the brand — never evidence about her. Unconfirmed research is never loaded.
 */
export interface BrandResearchItem {
  id: number;
  name: string;
  /** Why it is here: she has a deal with it, or a qualified inbound thread from it. */
  relation: "deal" | "thread";
  domain: string | null;
  category: string | null;
  tier: string | null;
  description: string | null;
  audience: string | null;
  sports: string[];
  partnerships: string[];
  researchedAt: string | null;
}

// ── What a recommendation is ABOUT (0.13.0-exp) — not the decision subject, which is part of the key ──────

/**
 * `about` names the thing a move concerns, for the surfaces (the brand cover first on the card and deck). It is NOT the
 * decision subject (`subject_kind`/`subject_id`, part of the Recommendation's key). Organisations and teams are
 * accepted kinds but carry no imagery yet: they will plug in through an org image lookup returning the same shape.
 */
export const ABOUT_KINDS = ["brand", "organisation", "team", "platform", "none"] as const;
export type AboutKind = (typeof ABOUT_KINDS)[number];
/** The Brain's wire shape: `ref` is a rendered `brand[<id>]` or null. */
export interface AboutWire { kind: AboutKind; name: string | null; ref: string | null }

/** A recommendation title: one short headline, at most this many characters. */
export const BRAIN_TITLE_MAX = 60;

// ── The inputs, exactly as rendered ───────────────────────────────────────────────────────────

export interface BrainInputs {
  athlete: { id: string; name: string };
  /** The Brain's only door. */
  live: Objective[];
  /** Standing information conditions. Rendered separately; never recommended on. */
  deferred: Objective[];
  /** Rendered so nothing is re-proposed. Nothing may be done with them. */
  declined: Objective[];
  state: AthleteState;
  map: OpportunityMap | null;
  work: ExistingWork | null;
  context: ContextBlock | null;
  research: ResearchBlock[];
  /** EXPERIMENTAL (1B.3, generalised for 1C): zero or more decisions posed in this call. */
  requests: DecisionRequest[];
  /** 0.6.0-exp: subjects a request names that no other lens renders (a detected inbound, a brand, the athlete). */
  subjects: SubjectItem[];
  /** 0.13.0-exp: confirmed external research on brands she has a relationship with, capped. Absent on older runs. */
  brands?: BrandResearchItem[];
  /**
   * EXPERIMENTAL (Commercial Intelligence ↔ Brain boundary checkpoint §4): the commercial-assessment block for one work
   * item and where it is rendered. Absent in every other run. Not a contract; the placement is an ablation.
   */
  commercial?: CommercialAttachment;
  /**
   * Slice 3 B: the historical openings withheld from this run's current strategic basis, per Objective, and why.
   * `map` already excludes them, so they can be neither rendered nor cited; this list is STORED with the run and never
   * rendered. Absent when nothing was withheld. (objective/currentBasis.ts)
   */
  excludedOpenings?: BasisExclusion[];
  /**
   * Slice 3 A: live Objectives whose success line is awaiting her after her rewrite — the old line is rendered as
   * awaiting, never as current. Stored with the run. Absent when none. (objective/successReview.ts)
   */
  withheldSuccess?: Array<{ objectiveId: string; reason: SuccessReview["reason"] }>;
}

// ── The decision ───────────────────────────────────────────────────────────────────────────────

export const DECISIONS = ["NO_ACTION", "RECOMMEND", "REQUEST_INTELLIGENCE"] as const;
export type DecisionKind = (typeof DECISIONS)[number];
export const EXECUTION_PATHS = ["direct_action", "specialized_plan", "campaign"] as const;
export const SOURCE_CLASSES = ["athlete", "connected", "external"] as const;
export const WORK_RELATIONS = ["new_work", "advances_existing_work", "no_new_work"] as const;
/**
 * 0.11.0-exp (R17): the authoritative source of a campaign's reason to end. The Brain names the SOURCE by reference; it never
 * emits a date or a condition of its own. Resolved by the execution router against the referenced object (#570 invariant 2).
 */
export const CAMPAIGN_END_SOURCES = ["objective_horizon", "deal_term", "athlete_stated"] as const;
export interface CampaignEnd { source: (typeof CAMPAIGN_END_SOURCES)[number]; ref: string }
/**
 * 0.7.0-exp — the strategic instruction a RECOMMEND hands the commercial execution path, for a `deal` subject. The
 * instruction, never the mechanics or the amount. An EXPERIMENTAL seam vocabulary for the direct-action slice: not a
 * universal Action taxonomy, not derived from what Deals can do, subject to change once exercised on real cases.
 */
export const COMMERCIAL_INTENTS = ["accept", "counter", "ask_terms", "decline", "wait"] as const;
export type CommercialIntent = (typeof COMMERCIAL_INTENTS)[number];
/**
 * 0.8.0-exp — the typed NEED of a REQUEST_INTELLIGENCE: what kind of fact is missing (brain-request-proposition-identity-
 * checkpoint.md §5). Corpus-derived from the 56 recorded propositions; closed; experimental; emitted by the Brain and
 * gated, never inferred from the proposition's prose by code. Identity of an Intelligence Request = decision + need;
 * wording and source_class are restatable attributes. `demonstrated_valuation` is PROVISIONAL: it is in the corpus, and
 * it must never become a way to manufacture a commercial basis from stature (0.6.1 invariant 1); if later evidence shows
 * that is what it represents, it is retired or redefined by a versioned change, not legitimised.
 */
export const NEEDS = ["counterparty_terms", "counterparty_profile", "athlete_commercial_basis", "existing_constraints", "deal_obligations", "deliverable_readiness", "athlete_capability_intent", "demonstrated_valuation"] as const;
export type Need = (typeof NEEDS)[number];
export const PROVISIONAL_NEEDS: readonly Need[] = ["demonstrated_valuation"];
/** What the Brain may say about a deferred information condition. It may never recommend on one. */
export const DEFERRED_DECISIONS = ["REQUEST_INTELLIGENCE", "CONDITION_APPEARS_RESOLVED", "NO_REQUEST"] as const;

export interface Cite { ref: string; how: string }

export interface BrainDecision {
  objectiveId: string;
  decision: DecisionKind;
  why: string;
  cites: Cite[];
  /** RECOMMEND only. */
  what?: string;
  /** RECOMMEND only (0.13.0-exp): the short title she reads, at most BRAIN_TITLE_MAX characters. */
  title?: string;
  /** RECOMMEND only (0.13.0-exp): what the move is about, for the surfaces. */
  about?: AboutWire | null;
  executionPath?: (typeof EXECUTION_PATHS)[number];
  /** Observational in experiment 1 — the Brain's own classification, compared with the reviewer's. Not schema. */
  relationToExistingWork?: (typeof WORK_RELATIONS)[number];
  advances?: string;
  notSeen?: string[];
  /** RECOMMEND with execution_path `campaign` only (0.11.0-exp): the typed reference to what ends the activation. Refused on any other path. */
  ends?: CampaignEnd | null;
  /** RECOMMEND on a `deal` subject only (0.7.0-exp): the strategic instruction. Emitted by the Brain, gated; never derived from `what` by code. */
  intent?: CommercialIntent;
  /** REQUEST_INTELLIGENCE only. */
  proposition?: string;
  whyMaterial?: string;
  sourceClass?: (typeof SOURCE_CLASSES)[number];
  /** REQUEST_INTELLIGENCE only (0.8.0-exp): the kind of fact that is missing. ONE PROPOSITION, ONE NEED. */
  need?: Need;
}

/** The answer to a requested decision: the same three decisions, the same fields, keyed by the request. */
export interface RequestedDecision extends Omit<BrainDecision, "objectiveId"> {
  requestId: string;
}

export interface DeferredDecision {
  objectiveId: string;
  decision: (typeof DEFERRED_DECISIONS)[number];
  why: string;
  cites: Cite[];
  proposition?: string;
  whyMaterial?: string;
  sourceClass?: (typeof SOURCE_CLASSES)[number];
  need?: Need;
}

export interface BrainOutput {
  version: typeof BRAIN_EXPERIMENT_VERSION;
  athleteId: string;
  asOf: string;
  decisions: BrainDecision[];
  deferred: DeferredDecision[];
  /** EXPERIMENTAL (1B.3): one per DECISION REQUESTED. Empty when none was posed. */
  requested: RequestedDecision[];
}
