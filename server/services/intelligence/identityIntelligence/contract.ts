/**
 * contract.ts — Identity Intelligence 0.2 (Concept 0.4; contract approved 3 Oct 2026). Types only.
 *
 * NOT identity RESOLUTION. `server/services/intelligence/identity/` and `research/identityResolution.ts` decide WHICH
 * public person an account is. This module says WHO that person is as an athlete and a brand — the core of a brand
 * platform, organised the way an athlete-brand agency builds one.
 *
 * Every field is one of three classes (contract §1):
 *   (a) upstream reuse    used as is (her Objectives, direction, voice, directives)
 *   (b) deterministic     selected and assembled by rules BEFORE the call (identity, proof points, signature moments…)
 *   (c) synthesis         the strategist judgement — the only thing the model writes (15 concepts), each with basis[]
 *                         and a strength computed from the tiers of what it cites
 *
 * Pipeline: envelope (rules: sections A–I) → rank (rules) → synthesis (one constrained model call) → validation
 * (rules; one repair) → composition (rules) → ledger (owner `identity_intelligence`, kind ASSESSMENT, superseded on
 * change). Canonical text is perspective-neutral (contract §2): views adapt it without another reasoning call.
 */

export const IDENTITY_INTELLIGENCE_CONTRACT = "identity-intelligence/0.2" as const;
export const IDENTITY_INTELLIGENCE_CONTRACT_V01 = "identity-intelligence/0.1" as const;
export const IDENTITY_ADMISSIBILITY_POLICY = "identity-admissibility/0.2" as const;
export const IDENTITY_SYNTHESIS_PROMPT = "identity-synthesis-prompt/0.7" as const;
/** What the validator enforces (validate.ts header). 1 = contracts and hard invariants only; no vocabulary rules. */
export const IDENTITY_VALIDATION_POLICY = "identity-validation/1" as const;
export const IDENTITY_LEDGER_OWNER = "identity_intelligence" as const;

/** Where a basis item came from. Every id is the source row's own id. */
export type BasisRef =
  | { kind: "fact"; id: string }                 // athlete_facts.id
  | { kind: "evidence"; id: string }             // research_evidence.id
  | { kind: "assertion"; id: string }            // athlete_asserted.id (the value she gave)
  | { kind: "objective"; id: string }            // objectives.id (desired_state)
  | { kind: "media_asset"; id: string }          // a caption she wrote
  | { kind: "first_look"; snapshotId: string; platform: string }
  | { kind: "social_feature"; key: string }      // e.g. "instagram.followers_latest", "tiktok.profile.bio"
  | { kind: "deal"; id: string }                 // earned commercial record
  | { kind: "state_finding"; key: string }       // salience only, never content
  /** 0.2: her words to Nomila — the `said` of an assertion or an Objective event, or the wording of an Objective she wrote. */
  | { kind: "said"; source: SaidSource; id: string };

export type SaidSource = "assertion" | "objective_event" | "objective";
export type BasisKind = BasisRef["kind"];
export const BASIS_KINDS: readonly BasisKind[] = ["fact", "evidence", "assertion", "objective", "media_asset", "first_look", "social_feature", "deal", "state_finding", "said"];

/** A source's admissibility tier. A source's own tier never changes; a CLAIM's tier is computed from its sources. */
export type Tier = "established" | "reported" | "unconfirmed" | "excluded";
export type AdmissibleTier = "established" | "reported";

/**
 * The envelope section an item is shown in (contract §3). E. HER DIRECTIVES is a text block, never numbered.
 * Alias prefixes: A→E, B→R, C→W, D→D, F→S, G→M, H→H, I→P.
 */
export type EnvelopeSection = "established" | "reported" | "her_words" | "direction" | "self_presentation" | "audience" | "marketability" | "pre_assembled";
export const SECTION_PREFIX: Record<EnvelopeSection, string> = {
  established: "E", reported: "R", her_words: "W", direction: "D", self_presentation: "S", audience: "M", marketability: "H", pre_assembled: "P",
};

/** HER WORDS provenance (acquisition plan §2e, settled 3 Oct). search_grounded material is never an athlete statement. */
export type StatementProvenance = "her_own" | "source_read";

/** One piece of candidate material, as the envelope gathered it. */
export interface BasisItem {
  /** Stable key, `refKey(ref)`. */
  key: string;
  ref: BasisRef;
  /** What the item says, as plain text (capped). */
  text: string;
  /** The source's own tier under the policy. `salience` marks a State finding: ranking only, never content. */
  sourceTier: Tier | "salience";
  /** The tier its claim carries after grouping and corroboration (equal to sourceTier for ungrouped items). */
  tier: Tier | "salience";
  /** Group key for structured items (fact key + normalised value) or normalised free text; null when ungrouped. */
  claimKey: string | null;
  source?: { type?: string | null; domain?: string | null; lineage?: string | null; url?: string | null; status?: string | null };
  /** Athlete authority: her assertion, her Objective, her proof. */
  athleteAuthority: boolean;
  /** Says who she is as an athlete (sport, team, level) — the sufficiency anchor. */
  athleticIdentity: boolean;
  /** When the underlying evidence was observed/dated, ISO. */
  asOf: string | null;
  /** Rank step (rules), 0–1. Not part of inputVersion. */
  salience: number;
  /** 0.2: the section it is shown in (assigned by the envelope); absent = established/reported by tier. */
  section?: EnvelopeSection;
  /** 0.2: her intent (an Objective, her direction, or her words stating a goal) — never something achieved. */
  intent?: boolean;
  /** 0.2: HER WORDS detail. */
  statement?: { provenance: StatementProvenance; medium: string; topics: string[]; outlet?: string | null; platform?: string | null; timestampSeconds?: number | null; partner?: boolean };
}

/** Confidence judged per claim, with its sources underneath. */
export interface ClaimAssessment {
  proposition: string;
  tier: Tier;
  basis: BasisRef[];
  corroboration: { independentDomains: number; athleteConfirmed: boolean };
  confidenceReason: string;
}

/** IdentityDirection — her governance, read from athlete_asserted. */
export interface IdentityDirectives {
  preferredEmphasis: string[];
  deEmphasize: string[];
  preferredLanguage: string[];
  /** identity.avoid_language plus brand_voice.avoid. */
  avoidLanguage: string[];
}

/**
 * Her approved words. The stored targets are 0.1's names and stay so (no data migration): 0.2 maps
 * identityStatement → essence and positioningStatement → positioning.current (APPROVED_TARGET_FIELD).
 */
export interface ApprovedStatement {
  target: "identityStatement" | "positioningStatement";
  text: string;
  basis: BasisRef[];
  basisDigest: string;
}
export type ApprovedField = "essence" | "positioningCurrent";
export const APPROVED_TARGET_FIELD: Record<ApprovedStatement["target"], ApprovedField> = {
  identityStatement: "essence", positioningStatement: "positioningCurrent",
};

export interface DisputeValue { entryRef: BasisRef | string; said?: string }
export interface ClaimConfirmationValue { ref: BasisRef; answer: "yes" | "no"; said?: string }

// ── (c) synthesised parts ─────────────────────────────────────────────────────

export type Strength = AdmissibleTier | "athlete_approved";

/** One synthesised text, its basis and the strength computed from the tiers it cites. */
export interface Synth { text: string; basis: BasisRef[]; strength: AdmissibleTier }
/** A synthesised text with a short and a long form (essence, positioning.current, standsFor, throughline). */
export interface SynthForm { short: string; long: string; basis: BasisRef[]; strength: Strength; pinned?: boolean }

export interface Pillar {
  key: string;
  label: string;
  definition: string;
  /** Proof point / signature moment keys (ProofPoint.key) the model chose for this pillar. It never writes proof text. */
  proof: string[];
  basis: BasisRef[];
  strength: AdmissibleTier;
  salience: number;
}

export interface Chapters {
  origin: Synth | null;
  rise: Synth | null;
  defining: Synth | null;
  now: Synth | null;
  /** (b) from her direction, verbatim, framed as intent — never achieved. */
  next: { text: string; framing: "intent"; basis: BasisRef[] } | null;
}

// ── (a) / (b) rules parts ─────────────────────────────────────────────────────

export interface Sourced { value: string; basis: BasisRef[] }
/** One assembled entry, with the tier of what it rests on. `athlete` = her own record (an assertion or Objective). */
export interface AssembledItem { text: string; basis: BasisRef[]; strength: AdmissibleTier }

export interface AthleticIdentity {
  sport: Sourced | null;
  position: Sourced | null;
  level: Sourced | null;
  team: Sourced | null;
  role: Sourced | null;
  careerStage: Sourced | null;
}

export type ProofKind = "honour" | "national_team" | "captaincy" | "education" | "partnership" | "audience" | "signature";
/** A pre-assembled proof point or signature moment. `key` is what pillars[].proof cite. */
export interface ProofPoint { key: string; kind: ProofKind; text: string; basis: BasisRef[]; strength: AdmissibleTier; asOf: string | null }

export interface AmbitionItem { text: string; source: "objective" | "direction" | "statement"; basis: BasisRef[] }
export interface DesiredPositioning { value: string; source: "objective" | "direction"; basis: BasisRef[] }

export interface Voice {
  /** (a) brand_voice, as she set it. */
  hers: { tone: string | null; phrases: string[]; avoid: string[]; basis: BasisRef[] } | null;
  /** (a) First Look tone. */
  observed: { tone: string[]; platforms: string[]; basis: BasisRef[] };
  contentThemes: string[];
  /** Recurring phrases (First Look) and nicknames (facts / her assertion). */
  signatureCues: string[];
}

export interface AudiencePlatform {
  platform: string;
  followers: number | null;
  engagementPerFollower: number | null;
  topGeographies: Array<{ bucket: string; pct: number | null }>;
  age: Array<{ bucket: string; pct: number | null }>;
  gender: Array<{ bucket: string; pct: number | null }>;
  basis: BasisRef[];
}
export interface AudienceMeasured { platforms: AudiencePlatform[] }

export interface DirectionItem { value: string; objectiveId?: string; domain?: string; athleteAuthored: boolean; basis: BasisRef[] }
export interface HowToBeUnderstood { value: string; said: string | null; basis: BasisRef[] }

export type GuardrailKind = "never_post" | "avoid_language" | "exclusivity" | "denied";
export interface Guardrail { kind: GuardrailKind; text: string; basis: BasisRef[] }

export interface UnresolvedItem {
  subject: string;
  question: string;
  reason: "unconfirmed" | "disputed" | "conflict";
  evidence: BasisRef[];
}

export interface Sufficiency { met: boolean; reasons: string[] }

/** Every rules part, recomputable from the live envelope (view.ts does so at read time). */
export interface IdentityRulesParts {
  athleticIdentity: AthleticIdentity;
  valuesEvidence: AssembledItem[];
  causes: AssembledItem[];
  interests: AssembledItem[];
  ambitions: AmbitionItem[];
  positioningDesired: DesiredPositioning | null;
  chaptersNext: Chapters["next"];
  signatureMoments: ProofPoint[];
  proofPoints: ProofPoint[];
  voice: Voice;
  audience: AudienceMeasured;
  associations: AssembledItem[];
  direction: DirectionItem[];
  howToBeUnderstood: HowToBeUnderstood | null;
  directives: IdentityDirectives;
  guardrails: Guardrail[];
  unresolved: UnresolvedItem[];
}

/** The athlete brand platform — the ledger row's `value` (without the audit trail). Field names follow contract §1. */
export interface AthleteIdentityIntelligence {
  contract: typeof IDENTITY_INTELLIGENCE_CONTRACT;
  // Athlete foundation
  athletic: { identity: AthleticIdentity; style: Synth | null };
  origin: Synth | null;
  values: Synth[];
  valuesEvidence: AssembledItem[];
  causes: AssembledItem[];
  interests: AssembledItem[];
  personality: Synth[];
  motivation: Synth | null;
  ambitions: AmbitionItem[];
  // Brand identity
  essence: SynthForm | null;
  positioning: { current: SynthForm | null; desired: DesiredPositioning | null };
  standsFor: SynthForm | null;
  pillars: Pillar[];
  differentiators: Synth[];
  // Narrative
  throughline: SynthForm | null;
  chapters: Chapters;
  signatureMoments: ProofPoint[];
  // Credibility
  proofPoints: ProofPoint[];
  // Expression
  voice: Voice;
  // Relationships
  audience: { measured: AudienceMeasured };
  communities: Synth[];
  // External brand image
  associations: AssembledItem[];
  mediaFraming: Synth | null;
  imageGap: Synth | null;
  // Athlete governance
  direction: DirectionItem[];
  howToBeUnderstood: HowToBeUnderstood | null;
  directives: IdentityDirectives;
  /** Approved (pinned) statements in force: field → the assertion id. */
  approved: Partial<Record<ApprovedField, string>>;
  guardrails: Guardrail[];
  unresolved: UnresolvedItem[];
  // Run
  overallConfidence: "HIGH" | "MEDIUM" | "LOW";
  sufficiency: Sufficiency;
  generatedAt: string;
  inputVersion: string;
  specVersion: typeof IDENTITY_SYNTHESIS_PROMPT;
  /** Absent on rows written before identity-validation/1. */
  validationVersion?: typeof IDENTITY_VALIDATION_POLICY;
  policyVersion: typeof IDENTITY_ADMISSIBILITY_POLICY;
  model: string;
}

/** What is persisted: the intelligence plus the claim list and the basis refs it was built from (no new table). */
export interface IdentityIntelligenceRecord extends AthleteIdentityIntelligence {
  claims: ClaimAssessment[];
  envelope: Array<{ ref: BasisRef; tier: Tier | "salience"; section?: EnvelopeSection }>;
}

/** A 0.1 row, as far as 0.2 still reads it (view.ts maps it until the next recompute supersedes it). */
export interface IdentityIntelligenceRecordV01 {
  contract: typeof IDENTITY_INTELLIGENCE_CONTRACT_V01;
  identityStatement: { value: string; basis: BasisRef[]; strength: AdmissibleTier } | null;
  positioningStatement: { value: string; basis: BasisRef[] } | null;
  differentiators?: Array<{ value: string; basis: BasisRef[] }>;
  overallConfidence?: "HIGH" | "MEDIUM" | "LOW";
  generatedAt?: string;
  inputVersion?: string;
}

export type IdentityPageState = "ready" | "learning" | "updating" | "unavailable";

/**
 * GET /me/story (identity-intelligence/0.2). The record's fields minus the audit trail, plus the page state and
 * `athleteStatements`: HER WORDS as a presentation projection (statementsView.ts) — verbatim, with the source and the
 * story objects whose basis cites each one, so a screen can show her quote under the object it rests on. Empty when
 * the page is unavailable. Never stored; never an input to synthesis.
 */
export type IdentityIntelligenceView =
  Omit<AthleteIdentityIntelligence, "contract" | "overallConfidence" | "sufficiency" | "generatedAt" | "inputVersion" | "specVersion" | "validationVersion" | "policyVersion" | "model">
  & {
    contract: typeof IDENTITY_INTELLIGENCE_CONTRACT;
    pageState: IdentityPageState;
    generatedAt: string | null;
    overallConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
    sufficiency: Sufficiency | null;
    athleteStatements: import("./statementsView").AthleteStatementView[];
    /**
     * (Oct 2026) Something My Story reads changed since this version was written: the live input hash differs from the
     * stored one. The truthful definition of "not yet up to date" — not "a job exists". The story still shows (the last
     * valid version); a screen may say her latest changes are being worked in. False when nothing is stored.
     */
    changesPending?: boolean;
    /** (Oct 2026) The latest inputs were already tried and did not pass validation, so they will not be retried
     *  automatically; the last valid version stays. Only meaningful with `changesPending`. */
    refreshFailed?: boolean;
  };

export function refKey(r: BasisRef): string {
  switch (r.kind) {
    case "first_look": return `first_look:${r.snapshotId}:${r.platform}`;
    case "social_feature":
    case "state_finding": return `${r.kind}:${r.key}`;
    case "said": return `said:${r.source}:${r.id}`;
    default: return `${r.kind}:${r.id}`;
  }
}

const UUIDISH = /^[0-9a-z][0-9a-z._:-]{0,199}$/i;
const SAID_SOURCES: readonly SaidSource[] = ["assertion", "objective_event", "objective"];

/** A BasisRef from untrusted JSON, or null. */
export function parseBasisRef(raw: unknown): BasisRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && UUIDISH.test(v) ? v : null);
  switch (r.kind) {
    case "fact": case "evidence": case "assertion": case "objective": case "media_asset": case "deal": {
      const id = s(r.id); return id ? { kind: r.kind, id } : null;
    }
    case "first_look": {
      const snapshotId = s(r.snapshotId); const platform = s(r.platform);
      return snapshotId && platform ? { kind: "first_look", snapshotId, platform } : null;
    }
    case "social_feature": case "state_finding": {
      const key = s(r.key); return key ? { kind: r.kind, key } : null;
    }
    case "said": {
      const id = s(r.id); const source = SAID_SOURCES.find((x) => x === r.source);
      return id && source ? { kind: "said", source, id } : null;
    }
    default: return null;
  }
}
