// Pure presentation helpers behind Concept 0.4 Slice 2 "My Intelligence" and its Me card. No React, no fetch.
//
// PRESENTATIONAL ONLY. The client consumes `my-intelligence/0.1` as served: pageState, every dimension's State
// conclusion (strength / neutral / gap / unknown), the citation-strength buckets and the O-6 withholding all come from
// the server. Nothing here applies a threshold, re-buckets a citation, infers a state or computes a score. It maps
// server values to copy, labels, glyph names and layout:
//
//   DIMENSIONS / dimensionName / dimensionIcon   O-12 names + Feather icons, canonical order (Momentum = wind)
//   answerFor(dimensions)                        the hero answer, templated from State's strength / gap conclusions (O-1)
//   answerText(assessment)                       the landing line (S3 copy when the server's readState is insufficient)
//   meAnswer(assessment)                         the Me card's one line (strongest + thinnest only)
//   stateLabel(state)                            "A strength" / "A gap" / "Not enough evidence" + glyph; neutral → null (O-2)
//   dimensionScoreText(d)                        "86", or "—" for an unknown dimension (O-3)
//   confidenceWord / confidenceLine              HIGH/MEDIUM/LOW → "Confident" / "Fairly confident" / "Less certain" (O-8)
//   evidenceClassLabel / componentLabel          component chip words (no values, O-4) and the component copy table
//   CITATION_GROUPS / evidenceGroups             the evidence sheet: the server's buckets, in display order (O-5)
//   supportingSourceCount                        the "Sources (N)" count: the server's four support-eligible buckets
//   identityCopy(identity)                       D-3 heading + reason-specific body
//   pageModel(view)                              pageState → which layout, which copy, which quiet lines
//   bridgeModel(view) / goalsFor(view, key)      "What matters next" rows, from the bridge as served (O-7)
//   meCardModel(entry, view?)                    the Me card (O-10): score only when the server's entry carries one
//   readDate(iso) / arcFraction(score)           "29 Sep 2026" and the one hero arc's proportion of 850
//
// 6b (the My Intelligence landing, Oct 2026) — selection only, over the 0.2 view as served:
//   ringBands(assessment) / ringArcs(bands)      the ring's eight bands in capital order (constants/ring.ts), each its stored
//                                                contribution; the arcs as degrees from 12 o'clock with the gaps and the track
//   signalPicks(assessment)                      Biggest strengths / Growth areas: the strongest and weakest NON-IMPUTED
//                                                sub-signals, three each, never a health-sensitive one and never a
//                                                measurement-quality one (config lists)
//   marketableRows(story)                        What makes you marketable: Identity Intelligence's differentiators, up
//                                                to three, each with where it comes from — no M.I.A. number, no quote
//                                                styling, no brand paired with a score
//   helpRows(view, connected)                    Help Nomila understand you better: only what SHE can resolve — her open
//                                                requests whose evidence is hers to give, and imputed signals connecting
//                                                would measure (never when an insights account is already connected);
//                                                never a health matter, never a counterparty's request
//   nextCount(view)                              the "What to do next" row's waiting count (the served reviewCount)

import type { MyIntelligenceEntry, MyIntelligencePageState } from "../hooks/use-me-knowledge";
import type {
  CitationStrength, ComponentEvidenceClass, ConfidenceLevel, FindingDirection, MarketabilityDimension,
  MyIntelligenceAssessment, MyIntelligenceDimension, MyIntelligenceEvidence, MyIntelligenceIdentity, MyIntelligenceView, MyIntelligenceGoal,
  MyIntelligenceSignal, MyIntelligenceWaitingItem, SignalSource,
} from "../hooks/use-me-intelligence";
import type { MeStory, MeStoryBasisRef } from "./meStoryLogic";
import { insightsConnected } from "./strategyLogic";
import { Ring, type RingCapital } from "../constants/ring";

// ── dimensions (O-12) ─────────────────────────────────────────────────────────

/** Feather icon names (kept as plain strings so this module stays React-free). */
export type DimensionIcon = "award" | "users" | "message-circle" | "globe" | "book-open" | "link-2" | "briefcase" | "wind";

export const DIMENSIONS: ReadonlyArray<{ key: MarketabilityDimension; name: string; icon: DimensionIcon }> = [
  { key: "athletic_authority", name: "Athletic authority", icon: "award" },
  { key: "audience_scale",     name: "Audience scale",     icon: "users" },
  { key: "engagement_quality", name: "Engagement quality", icon: "message-circle" },
  { key: "cultural_relevance", name: "Cultural relevance", icon: "globe" },
  { key: "narrative_power",    name: "Narrative power",    icon: "book-open" },
  { key: "brand_fit",          name: "Brand fit",          icon: "link-2" },
  { key: "commercial_proof",   name: "Commercial proof",   icon: "briefcase" },
  // Deliberately not trending-up: an arrow would imply movement, which is not displayable.
  { key: "momentum",           name: "Momentum",           icon: "wind" },
];
const BY_KEY = new Map(DIMENSIONS.map((d) => [d.key, d]));

export function dimensionName(key: MarketabilityDimension): string {
  return BY_KEY.get(key)?.name ?? humanise(key);
}
export function dimensionIcon(key: MarketabilityDimension): DimensionIcon | "circle" {
  return BY_KEY.get(key)?.icon ?? "circle";
}
/** Position in the canonical order, 1-based ("5 of 8"). */
export function dimensionPosition(key: MarketabilityDimension): number {
  return DIMENSIONS.findIndex((d) => d.key === key) + 1;
}

// ── the answer (O-1) ──────────────────────────────────────────────────────────

/** "a", "a and b", "a, b and c" — names in sentence case inside the sentence. */
export function listNames(keys: MarketabilityDimension[]): string {
  const names = keys.map((k) => dimensionName(k).toLowerCase());
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The server's dimensions, in canonical order (the server already sends them so; this never re-sorts by score). */
function inOrder(dims: ReadonlyArray<Pick<MyIntelligenceDimension, "key" | "state">>, state: FindingDirection): MarketabilityDimension[] {
  const keys = new Set(dims.filter((d) => d.state === state).map((d) => d.key));
  return DIMENSIONS.map((d) => d.key).filter((k) => keys.has(k));
}

export const ANSWER_NOTHING_SHARP = "Nothing stands out sharply in either direction.";
export const ANSWER_INSUFFICIENT = "Nomila doesn't have enough evidence about you yet to say what's driving this.";

export interface Answer {
  /** "Strongest in A, B and C." — only dimensions State concluded `strength`. */
  strongest: string | null;
  /** "Thinnest in D." — only dimensions State concluded `gap`. An `unknown` dimension is never listed here. */
  thinnest: string | null;
  /** "Not enough evidence yet on E." — State's `unknown`, kept apart from thinnest. */
  unknown: string | null;
  /** The whole answer line. */
  text: string;
}

/**
 * The hero answer, templated from State's conclusions as served (O-1). "Thinnest" means State had enough evidence to
 * conclude a gap; an unknown dimension is never "thinnest" — it gets its own sentence. `neutral` is never named.
 */
export function answerFor(dims: ReadonlyArray<Pick<MyIntelligenceDimension, "key" | "state">>): Answer {
  const strong = inOrder(dims, "strength");
  const gaps = inOrder(dims, "gap");
  const unknown = inOrder(dims, "unknown");
  const strongest = strong.length ? `Strongest in ${listNames(strong)}.` : null;
  const thinnest = gaps.length ? `Thinnest in ${listNames(gaps)}.` : null;
  const unk = unknown.length ? `Not enough evidence yet on ${listNames(unknown)}.` : null;
  const lead = [strongest, thinnest].filter(Boolean).join(" ") || ANSWER_NOTHING_SHARP;
  return { strongest, thinnest, unknown: unk, text: [lead, unk].filter(Boolean).join(" ") };
}

/** The landing's answer line. The server's readState says whether the read is insufficient (S3); this never counts. */
export function answerText(a: Pick<MyIntelligenceAssessment, "readState" | "dimensions">): string {
  return a.readState === "insufficient" ? ANSWER_INSUFFICIENT : answerFor(a.dimensions).text;
}

/** The Me card's one line: strongest + thinnest (no unknown sentence); null for an insufficient read. */
export function meAnswer(a: Pick<MyIntelligenceAssessment, "readState" | "dimensions">): string | null {
  if (a.readState === "insufficient") return null;
  const x = answerFor(a.dimensions);
  return [x.strongest, x.thinnest].filter(Boolean).join(" ") || ANSWER_NOTHING_SHARP;
}

// ── labels (O-2 / O-3 / O-4 / O-8) ────────────────────────────────────────────

export type StateGlyph = "strength" | "gap" | "unknown";

/** State's conclusion as words + a glyph shape. `neutral` gets no label (O-2): no middle band is ever shown. */
export function stateLabel(state: FindingDirection): { text: string; glyph: StateGlyph } | null {
  switch (state) {
    case "strength": return { text: "A strength", glyph: "strength" };
    case "gap": return { text: "A gap", glyph: "gap" };
    case "unknown": return { text: "Not enough evidence", glyph: "unknown" };
    default: return null;
  }
}

/** The dimension's number as served, or "—" for an unknown one (O-3). Never on the landing. */
export function dimensionScoreText(d: Pick<MyIntelligenceDimension, "state" | "score">): string {
  return d.state === "unknown" || d.score == null ? "—" : String(Math.round(d.score));
}

/** O-8: a wording of the evaluator's own ordinal; the enum itself is untouched. */
export function confidenceWord(level: ConfidenceLevel | null | undefined): string | null {
  switch (level) {
    case "HIGH": return "Confident";
    case "MEDIUM": return "Fairly confident";
    case "LOW": return "Less certain";
    default: return null;
  }
}
/** The landing's state line for the overall level, or null when the read carries none. */
export function confidenceLine(level: ConfidenceLevel | null | undefined): string | null {
  switch (level) {
    case "HIGH": return "Nomila is confident in this read";
    case "MEDIUM": return "Nomila is fairly confident in this read";
    case "LOW": return "Nomila is less certain about this read";
    default: return null;
  }
}

/** Component status chip (O-4: status + explanation only, never the value). */
export function evidenceClassLabel(c: ComponentEvidenceClass): string {
  switch (c) {
    case "MEASURED": return "Measured";
    case "ASSUMED": return "Assumed — no evidence";
    case "MISSING": return "Looked, not found";
    default: return "Researched";
  }
}

/** One copy table keyed by qualified signal path (O-12). Unlisted keys fall back to the humanised last segment. */
const COMPONENT_LABELS: Record<string, string> = {
  "athletic_authority.competition_level": "Competition level",
  "athletic_authority.performance_results": "Performance and results",
  "athletic_authority.rankings_recognition": "Rankings and recognition",
  "athletic_authority.national_international_status": "National and international standing",
  "athletic_authority.role_importance": "Role on the team",
  "athletic_authority.achievement_recency": "How recent the achievements are",
  "audience_scale.cross_platform_effective_reach": "Reach across platforms",
  "audience_scale.sport_level_audience_percentile": "Audience for your sport and level",
  "audience_scale.audience_growth": "Audience growth",
  "audience_scale.platform_breadth": "Platform breadth",
  "engagement_quality.engagement_percentile": "Engagement rate",
  "engagement_quality.reach_efficiency": "Reach efficiency",
  "engagement_quality.shares_saves_quality": "Shares and saves",
  "engagement_quality.video_retention": "Video retention",
  "engagement_quality.story_efficiency": "Stories reach",
  "engagement_quality.audience_authenticity": "Audience authenticity",
  "cultural_relevance.media_volume_percentile": "Media coverage",
  "cultural_relevance.media_source_quality": "Quality of media sources",
  "cultural_relevance.search_interest": "Search interest",
  "cultural_relevance.social_conversation": "Social conversation",
  "cultural_relevance.crossover_recognition": "Recognition beyond sport",
  "narrative_power.distinctiveness": "Distinctiveness",
  "narrative_power.story_depth": "Story depth",
  "narrative_power.evidence_authenticity": "Evidence authenticity",
  "narrative_power.media_resonance": "Media resonance",
  "narrative_power.commercial_applicability": "Commercial applicability",
  "narrative_power.durability": "Durability",
  "brand_fit.category_breadth": "Category breadth",
  "brand_fit.brand_safety": "Brand safety",
  "brand_fit.audience_attractiveness": "Audience appeal to brands",
  "brand_fit.identity_values_coherence": "Identity and values coherence",
  "brand_fit.content_versatility": "Content versatility",
  "brand_fit.geographic_relevance": "Geographic relevance",
  "commercial_proof.verified_commercial_value": "Verified commercial value",
  "commercial_proof.deal_frequency": "Deal frequency",
  "commercial_proof.brand_quality": "Brand partner quality",
  "commercial_proof.renewals_repeat": "Renewals and repeat partners",
  "commercial_proof.campaign_performance": "Campaign performance",
  "commercial_proof.pricing_power": "Pricing power",
  "momentum.athletic_trajectory": "Athletic trajectory",
  "momentum.audience_growth": "Audience growth",
  "momentum.media_trajectory": "Media trajectory",
  "momentum.search_social_trajectory": "Search and social trajectory",
  "momentum.commercial_acceleration": "Commercial acceleration",
};
function humanise(key: string): string {
  const last = key.split(".").pop() ?? key;
  const s = last.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}
export function componentLabel(key: string): string {
  return COMPONENT_LABELS[key] ?? humanise(key);
}

// ── the evidence sheet (O-5) ──────────────────────────────────────────────────

export type CitationGlyph = "grounded" | "site_only" | "nomila_supplied" | "unrecorded" | "not_support";

export interface CitationGroupCopy {
  strength: CitationStrength;
  title: string;
  note: string;
  glyph: CitationGlyph;
  /** Shown as weaker support (site_only). */
  weaker: boolean;
  /** Rendered collapsed until she opens it, and never as support (not_support). */
  collapsed: boolean;
}

/**
 * The four groups the sheet draws, in display order. Copy only: the bucket each id is in comes from the server. A
 * `not_support` cite (ungrounded, asserted only — some with URLs that never existed) is NEVER shown as a source: not as
 * support, not folded at the bottom, not counted (O-5; visual rules, Oct 2026).
 */
export const CITATION_GROUPS: readonly CitationGroupCopy[] = [
  { strength: "grounded", title: "Checked sources", note: "Nomila's research retrieved this source.", glyph: "grounded", weaker: false, collapsed: false },
  { strength: "site_only", title: "Site found, page not confirmed", note: "Nomila reached this site, but couldn't confirm this exact page.", glyph: "site_only", weaker: true, collapsed: false },
  { strength: "nomila_supplied", title: "From your connected accounts", note: "Data Nomila supplied from your accounts, restated.", glyph: "nomila_supplied", weaker: false, collapsed: false },
  { strength: "unrecorded", title: "Recorded before source checks", note: "This read was saved before Nomila recorded how sources were checked.", glyph: "unrecorded", weaker: false, collapsed: false },
];
export const HIDDEN_CITATION_STRENGTHS: readonly CitationStrength[] = ["not_support"];

export interface EvidenceGroup extends CitationGroupCopy { items: MyIntelligenceEvidence[] }

/**
 * The server's already-bucketed ids for one dimension → display groups, in CITATION_GROUPS order. Each id is looked up
 * in the read's evidence list for its title/claim/domain; an id that isn't there is not rendered. Empty groups are
 * dropped; a hidden strength (not_support) never becomes a group.
 */
export function evidenceGroups(sources: Record<CitationStrength, string[]>, evidence: ReadonlyArray<MyIntelligenceEvidence>): EvidenceGroup[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return CITATION_GROUPS.filter((g) => !HIDDEN_CITATION_STRENGTHS.includes(g.strength)).map((g) => ({
    ...g,
    items: (sources[g.strength] ?? []).map((id) => byId.get(id)).filter((e): e is MyIntelligenceEvidence => !!e && !HIDDEN_CITATION_STRENGTHS.includes(e.strength)),
  })).filter((g) => g.items.length > 0);
}

/** "Sources (N)": the server's four support-eligible buckets. not_support is never counted as a source. */
export function supportingSourceCount(sources: Record<CitationStrength, string[]>): number {
  return (["grounded", "site_only", "nomila_supplied", "unrecorded"] as const).reduce((n, k) => n + (sources[k]?.length ?? 0), 0);
}

// ── copy bound to states ──────────────────────────────────────────────────────

export const COPY = {
  heroTitle: "My Intelligence",
  outOf: "M.I.A. · out of 850",
  earlyRead: "Early read",
  scope: "Built from public research and your connected accounts.",
  identityPendingLine: "Nomila is re-checking it's found the right you. This read may change.",
  updatingLine: "Nomila is checking for a newer read.",
  insufficientBody: "Connecting your accounts is the fastest way to give Nomila more to go on.",
  connect: "Connect an account",
  partialNote: "Nomila couldn't find enough to judge these, so they're not counted as strengths or gaps.",
  unknownDetail: "Nomila couldn't find enough evidence to judge this yet. That says more about what Nomila could see than about you.",
  interpretation: "Nomila's interpretation",
  interpretationNote: "This is Nomila's interpretation, not a fact on your record.",
  reasonsNotSaved: "Nomila's reasons weren't saved with this read. The next read will include them.",
  sourcesNotSaved: "Sources weren't saved with this read.",
  goalEarlier: "Set using an earlier assessment",
  sharpenTitle: "What would sharpen this read",
  sharpenMeta: "Nomila's note on what it couldn't find",
  fullRead: "Nomila's full read",
  howTitle: "How Nomila reads this",
  howUses: "This read uses public research about you and data from your connected accounts. It doesn't yet use facts or deals you've confirmed in Nomila.",
  howMovement: "Nomila doesn't show ups and downs yet. Two reads of the same evidence can differ, and we haven't set the rule for what counts as a real change.",
  loadErrorTitle: "Couldn't load your intelligence",
  loadErrorBody: "Pull to try again.",
} as const;

/** D-3 + the failed copy. Only called for an identity hold. */
export function identityCopy(pageState: "identity_ambiguous" | "identity_failed", identity: MyIntelligenceIdentity | null): { title: string; body: string } {
  if (pageState === "identity_failed") {
    return { title: "We couldn't confirm your public identity", body: "We couldn't confidently match you to a public profile." };
  }
  const title = "Confirming your public identity";
  if (identity?.basis === "athlete_rejected") return { title, body: "The profile we found wasn't you." };
  switch (identity?.reason) {
    case "namesakes_unseparated":
    case "namesakes_uncorroborated":
      return { title, body: "We found more than one person who could be you." };
    case "conflicts_athlete_statement":
      return { title, body: "Some of what we found doesn't match what you've told us." };
    default:   // "uncertain", and any reason this client doesn't know yet
      return { title, body: "We found information that may be about you, but we're not certain yet." };
  }
}

export type MessageIcon = "search" | "user-check" | "loader" | "activity";

export type PageModel =
  | {
      /** No read is shown: one title + body, no number, no ring. No identity action buttons (D-2). */
      mode: "message";
      icon: MessageIcon;
      title: string;
      body: string[];
    }
  | {
      mode: "read";
      /** S3: all eight unknown — the score stays, quieted, with "Early read". */
      early: boolean;
      answer: string;
      /** Quiet lines under the state line, identity first (frozen contract). */
      lines: string[];
      /** S3 body + action. */
      insufficientBody: string | null;
      /** S2/S3 "Not enough evidence yet" group shown. */
      showUnknownGroup: boolean;
      /** S7: an older row with no reasons. */
      reasonsMissing: boolean;
    };

const NO_READ_COPY = {
  no_assessment: { icon: "activity" as const, title: "Your M.I.A. isn't ready yet", body: ["Nomila reads your public profile and your connected accounts to judge how marketable you are, and why. Your first read will appear here."] },
  identity_not_started: { icon: "activity" as const, title: "Your M.I.A. isn't ready yet", body: ["Nomila hasn't started reading your marketability yet."] },
  updating: { icon: "loader" as const, title: "Nomila is assessing your marketability.", body: ["Your M.I.A. will appear here when it's done. You can leave this screen."] },
  identity_pending: { icon: "user-check" as const, title: "Checking we've found the right you", body: ["Nomila checks your identity before assessing your marketability."] },
};

/** pageState (as served) → which layout and which copy. Never infers a state of its own. */
export function pageModel(view: Pick<MyIntelligenceView, "pageState" | "identity" | "inProgress" | "assessment">): PageModel {
  const s = view.pageState;
  if (s === "identity_ambiguous" || s === "identity_failed") {
    const c = identityCopy(s, view.identity);
    return { mode: "message", icon: "search", title: c.title, body: [c.body] };
  }
  const a = view.assessment;
  if (!a) {
    const c = s === "identity_pending" ? NO_READ_COPY.identity_pending
      : s === "identity_not_started" ? NO_READ_COPY.identity_not_started
      : s === "updating" ? NO_READ_COPY.updating
      : NO_READ_COPY.no_assessment;
    return { mode: "message", icon: c.icon, title: c.title, body: c.body };
  }
  const lines: string[] = [];
  if (s === "identity_pending") lines.push(COPY.identityPendingLine);
  if (view.inProgress) lines.push(COPY.updatingLine);
  const early = a.readState === "insufficient";
  return {
    mode: "read",
    early,
    answer: answerText(a),
    lines,
    insufficientBody: early ? COPY.insufficientBody : null,
    showUnknownGroup: a.readState !== "assessed" && a.dimensions.some((d) => d.state === "unknown"),
    reasonsMissing: !a.hasReasons,
  };
}

// ── the bridge ("What matters next") ──────────────────────────────────────────

export type BridgeRow =
  | { kind: "waiting"; title: string }
  | { kind: "goal"; objectiveId: string; title: string; meta: string; earlier: string | null }
  | { kind: "review"; title: string }
  | { kind: "sharpen"; title: string; body: string; meta: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function goalRow(g: MyIntelligenceGoal): BridgeRow {
  const builds = g.buildsOn.map(dimensionName).join(" · ");
  return { kind: "goal", objectiveId: g.objectiveId, title: g.text, meta: builds ? `Your goal · builds on ${builds}` : "Your goal", earlier: g.fromEarlierRead ? COPY.goalEarlier : null };
}

/** The bridge as served. A null slot is a flag that's off: render nothing, never a "nothing to do" card. */
export function bridgeModel(view: Pick<MyIntelligenceView, "bridge" | "assessment">): BridgeRow[] {
  const rows: BridgeRow[] = [];
  const w = view.bridge.waitingOnYou;
  if (w && w.count > 0) rows.push({ kind: "waiting", title: `${plural(w.count, "thing is", "things are")} waiting on you` });
  for (const g of view.bridge.goals ?? []) rows.push(goalRow(g));
  const r = view.bridge.reviewCount;
  if (r != null && r > 0) rows.push({ kind: "review", title: `Nomila has ${plural(r, "idea", "ideas")} for you to review` });
  const missing = view.assessment?.notes.missingEvidence ?? [];
  if (missing.length) rows.push({ kind: "sharpen", title: COPY.sharpenTitle, body: missing.slice(0, 2).join(" · "), meta: COPY.sharpenMeta });
  return rows;
}

/** Goals whose lineage (as served in `buildsOn`) cites this dimension. */
export function goalsFor(view: Pick<MyIntelligenceView, "bridge">, key: MarketabilityDimension): BridgeRow[] {
  return (view.bridge.goals ?? []).filter((g) => g.buildsOn.includes(key)).map(goalRow);
}

// ── the Me card (O-10) ────────────────────────────────────────────────────────

/** The line under a kept read while her public profile is unconfirmed (the latest research could not confirm it). */
export const IDENTITY_UNCONFIRMED_LINE = "Your last read. We couldn't confirm your public profile on the latest check, so this hasn't been updated.";

/** Page states under which the page itself shows a read (and so the number). */
const READ_STATES: ReadonlySet<MyIntelligencePageState> = new Set(["assessed", "assessed_partial", "insufficient", "identity_pending"]);

export interface MeCardModel {
  /** The number, or null — never shown when the entry withholds it. */
  score: string | null;
  early: boolean;
  /** "Read 29 Sep 2026" when there is a score. */
  meta: string | null;
  /** The one-line answer (from the page's view, only when it agrees with the entry), else the state's headline. */
  line: string | null;
}

/**
 * The Me card. Visibility comes from the overview slot (`entry`), built server-side by the same state function as the
 * page, so Me can never show a score the page withholds. The answer line is the page's own answer, and is used only
 * when the page view is loaded and reports the same pageState.
 */
export function meCardModel(entry: MyIntelligenceEntry | null | undefined, view?: MyIntelligenceView | null): MeCardModel {
  if (!entry) return { score: null, early: false, meta: null, line: null };
  const shows = entry.score != null && READ_STATES.has(entry.pageState);
  if (!shows) {
    const headline = entry.pageState === "identity_ambiguous" || entry.pageState === "identity_failed"
      ? identityCopy(entry.pageState, null).title
      : entry.pageState === "updating" ? NO_READ_COPY.updating.title
      : entry.pageState === "identity_pending" ? NO_READ_COPY.identity_pending.title
      : NO_READ_COPY.no_assessment.title;
    return { score: null, early: false, meta: null, line: headline };
  }
  const agrees = !!view && view.pageState === entry.pageState && !!view.assessment;
  return {
    score: String(Math.round(entry.score!)),
    early: entry.pageState === "insufficient",
    meta: entry.evidenceAsOf ? `Read ${readDate(entry.evidenceAsOf)}` : null,
    // Her last read, kept while her public profile is unconfirmed: said plainly, never hidden.
    line: entry.identityUnconfirmed ? IDENTITY_UNCONFIRMED_LINE : agrees ? meAnswer(view!.assessment!) : null,
  };
}

// ── small formatting ──────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "29 Sep 2026" (UTC calendar date of the ISO string). "" when unparseable. */
export function readDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The hero arc as a plain proportion of 850 (no ticks, no tiers), clamped to [0, 1]. */
export function arcFraction(score: number | null | undefined): number {
  if (score == null || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score / 850));
}

// ── 6b: the ring's bands ──────────────────────────────────────────────────────

export interface RingBand { key: MarketabilityDimension; capital: RingCapital; color: string; contribution: number }

/**
 * The ring's bands in the ring's order (constants/ring.ts: Audience → Commercial → Brand → Performance, each capital's
 * two dimensions in its two tones), each the dimension's stored contribution (score × weight, of 100, served in 0.2).
 * Nothing is recomputed: a dimension with no stored contribution has no band; with none at all the ring draws a single
 * arc of the score. The colours are data: the ONE place they are read from is `Ring`.
 */
export function ringBands(a: Pick<MyIntelligenceAssessment, "dimensions"> | null | undefined): RingBand[] {
  const dims = a?.dimensions ?? [];
  const out: RingBand[] = [];
  for (const cap of Ring.capitals) {
    cap.dimensions.forEach((key, i) => {
      const d = dims.find((x) => x.key === key);
      const c = d?.contribution;
      if (typeof c === "number" && Number.isFinite(c) && c > 0) out.push({ key, capital: cap.key, color: cap.tones[i], contribution: c });
    });
  }
  return out;
}

export interface RingArc { key: string; color: string; start: number; end: number }

/**
 * The bands as arcs: degrees clockwise from 12 o'clock, each band's length its contribution's share of 360, a gap of
 * `gapDeg` between neighbours, and the neutral track from the last band to the top. `filled` is the bands' sum (of 100).
 * A band thinner than the gap is kept at zero length (never drawn backwards).
 */
export function ringArcs(bands: ReadonlyArray<Pick<RingBand, "key" | "color" | "contribution">>, gapDeg: number = Ring.gapDeg): { arcs: RingArc[]; track: { start: number; end: number } | null; filled: number } {
  const arcs: RingArc[] = [];
  let acc = 0;
  for (const b of bands) {
    const c = Math.max(0, Math.min(100 - acc, b.contribution));
    const start = (acc / 100) * 360 + gapDeg / 2;
    const end = Math.max(start, ((acc + c) / 100) * 360 - gapDeg / 2);
    arcs.push({ key: b.key, color: b.color, start, end });
    acc += c;
  }
  const filled = Math.min(100, acc);
  const trackStart = (filled / 100) * 360 + gapDeg / 2;
  const trackEnd = 360 - gapDeg / 2;
  return { arcs, track: filled < 100 && trackEnd > trackStart ? { start: trackStart, end: trackEnd } : null, filled };
}

// ── 6b: sub-signals ───────────────────────────────────────────────────────────

/**
 * Sub-signals that reflect her health or an injury: never picked as a strength or a growth area, never offered as a gap
 * to fill. Config, not inference — a key is listed here because of what it measures, whatever its value.
 */
export const HEALTH_SENSITIVE_SIGNALS: readonly string[] = ["momentum.athletic_trajectory"];
/**
 * Sub-signals that grade the EVIDENCE Nomila holds, not her: how authentic the sources behind her story read is says
 * nothing she can build on, so it is never a "biggest strength" or a "growth area". Config, like the list above.
 */
export const MEASUREMENT_QUALITY_SIGNALS: readonly string[] = ["narrative_power.evidence_authenticity"];
export const SIGNAL_PICK_COUNT = 3;

export interface SignalPick {
  key: string;
  label: string;
  /** 0–100, as served. */
  value: number;
  /** "measured" / "researched" / "inferred", or null when the row recorded no source. */
  sourceWord: string | null;
}

/** The source class as one quiet word. Never a value judgement. */
export function signalSourceWord(source: SignalSource | null | undefined): string | null {
  switch (source) {
    case "connected_verified": case "platform_public": return "measured";
    case "web_researched": return "researched";
    case "inferred": return "inferred";
    default: return null;
  }
}

/** Every served sub-signal she can be shown: non-imputed, with a value, not health-sensitive, about her (not about the evidence). Canonical dimension order. */
export function showableSignals(a: Pick<MyIntelligenceAssessment, "dimensions"> | null | undefined): Array<MyIntelligenceSignal & { dimension: MarketabilityDimension }> {
  const out: Array<MyIntelligenceSignal & { dimension: MarketabilityDimension }> = [];
  for (const dim of DIMENSIONS) {
    const d = a?.dimensions.find((x) => x.key === dim.key);
    for (const s of d?.signals ?? []) {
      if (s.imputed || typeof s.value !== "number" || !Number.isFinite(s.value)) continue;
      if (HEALTH_SENSITIVE_SIGNALS.includes(s.key) || MEASUREMENT_QUALITY_SIGNALS.includes(s.key)) continue;
      out.push({ ...s, dimension: dim.key });
    }
  }
  return out;
}

const toPick = (s: MyIntelligenceSignal): SignalPick => ({ key: s.key, label: componentLabel(s.key), value: s.value as number, sourceWord: signalSourceWord(s.source) });

/** Take the first N with distinct labels (two dimensions may hold the same-named signal; one row per label). */
function distinctByLabel(sorted: MyIntelligenceSignal[], n: number, skip: ReadonlySet<string> = new Set()): SignalPick[] {
  const out: SignalPick[] = [];
  const labels = new Set<string>();
  for (const s of sorted) {
    const p = toPick(s);
    if (skip.has(p.key) || labels.has(p.label)) continue;
    labels.add(p.label);
    out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Biggest strengths: the strongest showable sub-signals; Growth areas: the weakest, never one already a strength. Ties
 * keep canonical order. Both empty on a 0.1 server (no signals served) so the card simply does not draw.
 */
export function signalPicks(a: Pick<MyIntelligenceAssessment, "dimensions"> | null | undefined): { strengths: SignalPick[]; growth: SignalPick[] } {
  const all = showableSignals(a);
  const strengths = distinctByLabel([...all].sort((x, y) => (y.value as number) - (x.value as number)), SIGNAL_PICK_COUNT);
  const growth = distinctByLabel([...all].sort((x, y) => (x.value as number) - (y.value as number)), SIGNAL_PICK_COUNT, new Set(strengths.map((p) => p.key)));
  return { strengths, growth };
}

// ── 6b: what makes you marketable ─────────────────────────────────────────────

export type ProvenanceGlyph = "you" | "document" | "search" | "link" | "proof";

export const MARKETABLE_ROW_MAX = 3;

export interface MarketableRow {
  key: string;
  /** The differentiator, as Identity Intelligence holds it — body text, never a quote, never with a number beside it. */
  text: string;
  /** Where it comes from, in fixed words: "From what you told Nomila" when her own words are its basis, else "From your story". */
  sourceLine: string;
  glyph: ProvenanceGlyph;
}

const MARKETABLE_SOURCE = { hers: "From what you told Nomila", story: "From your story" } as const;
/** Basis kinds that are HER words (an assertion, something she said). */
const HER_BASIS: readonly string[] = ["assertion", "said"];
const strengthGlyph = (strength: string | null | undefined): ProvenanceGlyph => (strength === "established" ? "document" : "search");

/** The provenance line + glyph of a story object from its basis and strength — fixed words, never the strength word itself. */
export function storyProvenance(basis: ReadonlyArray<MeStoryBasisRef> | null | undefined, strength: string | null | undefined): { sourceLine: string; glyph: ProvenanceGlyph } {
  const hers = (basis ?? []).some((b) => HER_BASIS.includes(b.kind));
  return hers ? { sourceLine: MARKETABLE_SOURCE.hers, glyph: "you" } : { sourceLine: MARKETABLE_SOURCE.story, glyph: strengthGlyph(strength) };
}

/**
 * What makes you marketable: Identity Intelligence's differentiators (GET /me/story), up to three, in the served order,
 * each with its provenance. No M.I.A. number rides a row, no brand is paired with a score, and nothing is invented: no
 * differentiators ⇒ no rows ⇒ the section is not drawn.
 */
export function marketableRows(story: Pick<MeStory, "differentiators"> | null | undefined): MarketableRow[] {
  const out: MarketableRow[] = [];
  for (const d of story?.differentiators ?? []) {
    const text = typeof d.text === "string" ? d.text.trim() : "";
    if (!text) continue;
    out.push({ key: `differentiator:${out.length}`, text, ...storyProvenance(d.basis, d.strength) });
    if (out.length >= MARKETABLE_ROW_MAX) break;
  }
  return out;
}

// ── 6b: help Nomila understand you better ─────────────────────────────────────

export type HelpKind = "add_contract" | "tell_mila" | "connect";
export interface HelpRow {
  kind: HelpKind;
  title: string;
  meta: string;
  /** The button's word. */
  action: string;
  requestId: string | null;
  /** For Mila: the draft she sees in the composer, never auto-sent. */
  draft: string | null;
}

/** Never a row about an injury or a health matter, whatever the request says (the same words Home's chips refuse). */
export const SENSITIVE_WORDS = /\b(injur|health|medical|concussion|surger|rehab|illness|diagnos|hospital|physio|therapy|disorder)/i;

/**
 * Sub-signals a connected account's private insights would measure: an IMPUTED one of these is a gap she can close by
 * connecting. Config by key; the words shown are the fixed component labels.
 */
export const CONNECT_RESOLVABLE_SIGNALS: readonly string[] = [
  "engagement_quality.video_retention", "engagement_quality.story_efficiency", "engagement_quality.shares_saves_quality",
  "engagement_quality.reach_efficiency", "engagement_quality.audience_authenticity",
  "audience_scale.cross_platform_effective_reach", "audience_scale.audience_growth", "audience_scale.platform_breadth",
  "momentum.audience_growth",
];

export const HELP_COPY = {
  contractTitle: "Share the contract you mentioned",
  contractMeta: "You asked Nomila to remind you",
  documentTitle: "Share your performance data",
  documentMeta: "Nomila asked for the data you have available",
  tellTitle: "Tell Nomila what it asked for",
  tellMeta: "A quick answer to Mila fills this gap",
  connectTitle: "Connect your account insights",
  connectMeta: (labels: string[]) => `${listWords(labels)} ${labels.length === 1 ? "is" : "are"} missing from this read`,
  draftDocument: "I'd like to share performance data with you.",
  draftTell: (asked: string | null) => (asked ? `About what you asked me for: ${asked}` : "You asked me for something — let's go through it."),
} as const;

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Can SHE resolve it? Only when the evidence is hers to give; a counterparty's reply or outside research is not hers to chase. */
export function resolvableByHer(item: MyIntelligenceWaitingItem): boolean {
  if (item.status !== "open" && item.status !== "acquiring") return false;
  if (SENSITIVE_WORDS.test(`${item.nomilaSays ?? ""} ${item.sheAsked ?? ""}`)) return false;
  // A 0.1 server serves no sourceClass: fall back to "has a mounted way in", as Home's chips do.
  return item.sourceClass ? item.sourceClass === "athlete" : !!item.cta;
}

/** Imputed, connect-resolvable sub-signals, as their fixed labels (distinct), in canonical order. */
export function connectGaps(a: Pick<MyIntelligenceAssessment, "dimensions"> | null | undefined): string[] {
  const labels: string[] = [];
  for (const dim of DIMENSIONS) {
    const d = a?.dimensions.find((x) => x.key === dim.key);
    for (const s of d?.signals ?? []) {
      if (!s.imputed || !CONNECT_RESOLVABLE_SIGNALS.includes(s.key) || HEALTH_SENSITIVE_SIGNALS.includes(s.key)) continue;
      const l = componentLabel(s.key);
      if (!labels.includes(l)) labels.push(l);
    }
  }
  return labels;
}

/**
 * The rows, in this order: her contract requests, then connecting (once), then her other requests (a document, or a
 * question for Mila). One row per request; nothing for a request that is not hers to resolve; nothing about health.
 * `connected` is the ids of her active connections: with an insights platform among them, the connect row is not
 * offered — its button would only open Settings on an account that is already there.
 */
export function helpRows(view: Pick<MyIntelligenceView, "assessment" | "bridge"> | null | undefined, connected: ReadonlyArray<string> = []): HelpRow[] {
  const items = (view?.bridge.waitingOnYou?.items ?? []).filter(resolvableByHer);
  const contracts: HelpRow[] = []; const rest: HelpRow[] = [];
  for (const r of items) {
    if (r.cta?.kind === "add_contract") contracts.push({ kind: "add_contract", title: HELP_COPY.contractTitle, meta: HELP_COPY.contractMeta, action: r.cta.label, requestId: r.requestId, draft: null });
    else if (r.cta?.kind === "add_document") rest.push({ kind: "tell_mila", title: HELP_COPY.documentTitle, meta: r.sheAsked ? `You asked: “${r.sheAsked}”` : HELP_COPY.documentMeta, action: "Tell Mila", requestId: r.requestId, draft: HELP_COPY.draftDocument });
    else rest.push({ kind: "tell_mila", title: HELP_COPY.tellTitle, meta: r.sheAsked ? `You asked: “${r.sheAsked}”` : HELP_COPY.tellMeta, action: "Tell Mila", requestId: r.requestId, draft: HELP_COPY.draftTell(r.sheAsked) });
  }
  const gaps = insightsConnected(connected) ? [] : connectGaps(view?.assessment);
  const connect: HelpRow[] = gaps.length ? [{ kind: "connect", title: HELP_COPY.connectTitle, meta: HELP_COPY.connectMeta(gaps.slice(0, 3)), action: "Connect", requestId: null, draft: null }] : [];
  return [...contracts, ...connect, ...rest];
}

/** The "What to do next" row's count: the served review queue size, 0 when the flag is off. */
export function nextCount(view: Pick<MyIntelligenceView, "bridge"> | null | undefined): number {
  const n = view?.bridge.reviewCount;
  return typeof n === "number" && n > 0 ? n : 0;
}
