/**
 * shared/meScouting.ts — the response contracts for Me on the agent memory: the Scouting report (GET /me/scouting,
 * contract scouting/1) and What Nomila knows (GET /me/facts, contract knows/1), plus the small pure rules both sides
 * share (which M.I.A. group a dimension belongs to, which Knows section a research topic files under).
 *
 * Built from the screens in draft PR #900 (client/screens/prototypes: ScoutingReportScreen, AreaNotesCard) and the
 * "Knows on Memory" design (brief-view/2, knows/1), with the owner's decisions: no "In your words" label (your own
 * input is woven into the analysis), "Working for you" and "Room to grow" (top 2 each) plus a "Not on record yet"
 * count, partners from facts about you only (never a team's or club's sponsors). The contract test
 * (server/routes/meScouting.contract.test.ts) type-checks #900's fixture objects against these types.
 *
 * Types and constants only: no runtime dependencies, so the server and the app import it as is. Nothing here names an
 * athlete, sport, school or brand.
 */
import type { FactSubjectFilter, IdentityField, MiaPreview, SubjectKind } from "./agent";

// ─── M.I.A. dimensions and their ring groups ──────────────────────────────────────────────────────────────────────

/** The eight M.I.A. dimensions a note may be tagged with (the facts-only evaluator's NOTE_DIMENSIONS). */
export const MIA_DIMENSIONS = [
  "athletic_authority", "momentum", "audience_scale", "engagement_quality",
  "commercial_proof", "brand_fit", "narrative_power", "cultural_relevance",
] as const;
export type MiaDimension = (typeof MIA_DIMENSIONS)[number];

export const MIA_GROUP_KEYS = ["performance", "audience", "commercial", "brand"] as const;
export type MiaGroupKey = (typeof MIA_GROUP_KEYS)[number];

/** The ring's own pairing (server/services/miaPreview/preview.ts MIA_GROUPS; a test pins the two equal). */
export const MIA_DIMENSION_GROUP: Record<MiaDimension, MiaGroupKey> = {
  athletic_authority: "performance", momentum: "performance",
  audience_scale: "audience", engagement_quality: "audience",
  commercial_proof: "commercial", brand_fit: "commercial",
  narrative_power: "brand", cultural_relevance: "brand",
};

/** A dimension key as the evaluator wrote it → the typed key, or null when it is not one of the eight. */
export function miaDimensionOf(raw: string | null | undefined): MiaDimension | null {
  const k = (raw ?? "").trim().toLowerCase();
  return (MIA_DIMENSIONS as readonly string[]).includes(k) ? (k as MiaDimension) : null;
}

// ─── Scouting report: GET /api/v1/me/scouting (scouting/1) ────────────────────────────────────────────────────────

export const SCOUTING_CONTRACT = "scouting/1" as const;

/** The career bands the hero subline shows: "<stage label> · <band>". Never a made-up word. */
export const CAREER_BANDS = ["early", "developing", "established", "elite", "retired"] as const;
export type CareerBand = (typeof CAREER_BANDS)[number];

/**
 * One M.I.A. note, tagged with the dimension it is about and the ring group (colour) it takes. Untagged notes
 * (evaluators before facts-eval-spec/0.4.0, or a text the run's raw answer no longer matches) carry null for both:
 * the client shows a grey dot, never a guess.
 */
export interface ScoutNote {
  text: string;
  dimension: MiaDimension | null;
  group: MiaGroupKey | null;
}

/** A partner brand, from facts about you only. */
export interface ScoutBrand {
  name: string;
  /** For the logo (the brand-logo rule: the client turns a domain into a logo). Null when Nomila has none on record. */
  logoDomain: string | null;
  /** A stored logo URL when brand research set one; the client may still prefer the domain. */
  logoUrl: string | null;
  /** The newest date a fact about you and this brand was observed on (ISO day), or null when no fact carries a date. */
  latestConfirmedOn: string | null;
  /**
   * When the partnership started (YYYY or YYYY-MM): the earliest start a fact about you states (Understand's internal
   * read, 1.10.0; never inferred), or null when none does. The client words it "Since <year>".
   */
  startedOn: string | null;
  /** current | past, or unclear when the record disagrees with itself or nothing confirms it any more. */
  status: "current" | "past" | "unclear";
  /** The facts about you it rests on. */
  factIds: string[];
}

/** The M.I.A. block: Home's existing shape (the mia-preview/1 fields Home's ScoreBlock and ring read). */
export type ScoutingMia = Pick<MiaPreview, "status" | "score" | "scale" | "groups" | "assessment" | "preliminary" | "label" | "confidence" | "sharpen" | "evidenceAsOf">;

export interface ScoutingPillar {
  key: string;
  /** The pillar's name (My Story's pillar card title). */
  label: string;
  /** Its one line. */
  definition: string;
}

/** The identity fields the line under the hero shows, in order: team · position · level. */
export const IDENTITY_LINE_FIELDS = ["team", "position", "level"] as const satisfies readonly IdentityField[];

/** One identity field about the athlete, from the fact that states it (memory_facts.field / field_value). */
export interface ScoutIdentityPart {
  field: IdentityField;
  value: string;
  factId: string;
}

/**
 * An exclusivity or category conflict (Understand's internal read, 1.9.0), for "Your brands": what it is, what it blocks,
 * and the facts it rests on. Never a score.
 */
export interface ScoutConflict {
  what: string;
  blocks: string[];
  factIds: string[];
}

/** An athlete with no memory facts: the client keeps the old Me screens for them. */
export interface ScoutingEmpty {
  contract: typeof SCOUTING_CONTRACT;
  status: "no_memory";
}

export interface ScoutingReport {
  contract: typeof SCOUTING_CONTRACT;
  /** ready = a current Brief exists; no_brief = memory exists but Understand has not written a Brief yet. */
  status: "ready" | "no_brief";
  /** The Brief version it was read from, and the day it was written; null while there is no Brief. */
  version: number | null;
  updatedOn: string | null;
  hero: {
    /** The one-sentence positioning statement (the Brief's display.positioning.statement). */
    statement: string | null;
    /** "<label> · <band>"; null when the Brief has no stage or its band is unclear. */
    stage: { label: string; band: CareerBand } | null;
    /**
     * The identity line under the hero: team · position · level, from the identity facts about you (one per field: what
     * you told us first, then the newest). `line` is null when none of the three is on record; `parts` holds every
     * identity field on record (class year, school, league and sport too) for the client to use as it needs.
     */
    identity: { line: string | null; parts: ScoutIdentityPart[] };
  };
  /** "What defines you": where you are today, where you're headed, and three pillars. Your input is woven in. */
  defines: { today: string | null; headed: string | null; pillars: ScoutingPillar[] } | null;
  mia: ScoutingMia | null;
  /** The M.I.A. read's notes. Null when there is no read. */
  notes: {
    /** Top 2 strengths. */
    workingForYou: ScoutNote[];
    /** Top 2 constraints. */
    roomToGrow: ScoutNote[];
    /** How many things the read said it is missing. */
    notOnRecordCount: number;
    /**
     * "See the detail": every note — strengths (working for you), growth (room to grow: the read's constraints) and
     * missing (not on record yet). The keys are the prototype's AreaNotesCard groups.
     */
    detail: { strengths: ScoutNote[]; growth: ScoutNote[]; missing: ScoutNote[] };
  } | null;
  brands: { current: ScoutBrand[]; past: ScoutBrand[]; unclear: ScoutBrand[] };
  /** Exclusivity and category conflicts, each with what it blocks ("Your brands"). Empty when none is known. */
  conflicts: ScoutConflict[];
  /** The door to What Nomila knows: facts about you, and how many Nomila couldn't confirm. */
  knows: { facts: number; unconfirmed: number };
  /**
   * The biggest upside and the biggest risk (the Brief's risks_upside section, moved here from the Goals tab): the first
   * thing "Your read in detail" shows. Null when the Brief has no such section. Optional: older servers do not send it.
   */
  riskUpside?: { upside: string; risk: string } | null;
}

export type ScoutingResponse = ScoutingEmpty | ScoutingReport;

// ─── What Nomila knows: GET /api/v1/me/facts (knows/1) ────────────────────────────────────────────────────────────

export const KNOWS_CONTRACT = "knows/1" as const;

/** you = you told us (said) · found = found with a public URL · accounts = measured, or from your inbox or deals. */
export type Provenance = "you" | "found" | "accounts";

/** The sections, in screen order. "glance" holds identity facts (At a glance). */
export const KNOWS_SECTIONS = ["glance", "career", "honours", "academics", "brands", "media", "interests", "details"] as const;
export type KnowsSectionKey = (typeof KNOWS_SECTIONS)[number];

/** Research topic → section (the design's mapping). Anything unlisted, and a fact with no topic, files under details. */
const TOPIC_SECTION: Record<string, KnowsSectionKey> = {
  identity: "glance",
  career: "career", team: "career", competition: "career", status: "career",
  achievement: "honours",
  education: "academics",
  sponsor: "brands", business: "brands", commerce: "brands",
  media: "media", social: "media", audience_growth: "media", engagement: "media", demographics: "media", search_trend: "media", conversation: "media",
  cause: "interests",
};

/** Which section a fact files under. Measured facts are your accounts' numbers, so they sit under media. */
export function knowsSectionOf(f: { topic: string | null; type: string }): KnowsSectionKey {
  if (f.type === "measured") return "media";
  return (f.topic && TOPIC_SECTION[f.topic]) || "details";
}

export interface KnowsFact {
  id: string;
  claim: string;
  topic: string | null;
  provenance: Provenance;
  /** Disputed, low confidence (< 0.5), or another fact disputes it: "couldn't confirm". */
  unconfirmed: boolean;
  confirmedByYou: boolean;
  date: string | null;
  /**
   * How precise `date` is (memory_facts.date_precision): "day", "month" or "year"; null when the fact never said (older
   * merges stored a year as its 1 January). Optional on the wire: a server from before this field sends none.
   */
  datePrecision?: "day" | "month" | "year" | null;
  confidence: number;
  status: "active" | "disputed";
  sources: Array<{ label: string; url?: string }>;
  /** How many other sources say the same thing. */
  alsoSeen: number;
  subject: { kind: SubjectKind; name: string };
  about: "athlete" | "others";
  /** False for a measured fact: fix it at the source (the connected account), not here. */
  editable: boolean;
}

export interface KnowsView {
  contract: typeof KNOWS_CONTRACT;
  status: "ready";
  asOf: string;
  subject: FactSubjectFilter;
  counts: { total: number; you: number; found: number; accounts: number; unconfirmed: number; hidden: number; private: number };
  /** Every section in KNOWS_SECTIONS order, empty ones included (the client folds them). */
  sections: Array<{ key: KnowsSectionKey; facts: KnowsFact[] }>;
  /** Care facts (sensitive): only you see these; never in anything shared. */
  private: KnowsFact[];
  /** Facts you hid, with Restore. */
  hidden: Array<{ id: string; claim: string }>;
}

export interface KnowsEmpty {
  contract: typeof KNOWS_CONTRACT;
  status: "no_memory";
}

export type KnowsResponse = KnowsView | KnowsEmpty;

/** One fact's sheet: GET /me/facts/:id. History = the supersede chain (oldest first) and every review of it. */
export interface KnowsFactDetail {
  fact: KnowsFact & { status: "active" | "disputed" | "superseded" | "removed" };
  history: Array<
    | { kind: "version"; id: string; claim: string; provenance: Provenance; status: string; at: string }
    | { kind: "review"; action: string; correction: string | null; at: string }
  >;
  /** Where it is used: the current Brief cites it; the last M.I.A. read included it. */
  usedIn: { scouting: boolean; mia: boolean };
}

/** What an edit queued: Nomila re-runs only what used the fact, after a 30-minute quiet window. */
export interface RerunNotice {
  /** The memory_changed run the edit joined or started; null when nothing needed to re-run (a confirm). */
  runId: string | null;
  /** The quiet window's end: nothing re-runs before it (ISO). */
  after: string | null;
}

/** "This isn't right": the fact is disputed, and Mila asks you what's true. */
export interface DisputeSeed {
  factId: string;
  claim: string;
  /** Other facts about the same subject and topic, as possible answers. */
  alternatives: Array<{ id: string; claim: string }>;
}
