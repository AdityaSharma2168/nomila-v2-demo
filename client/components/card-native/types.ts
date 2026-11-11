/**
 * card-native — the real card types, mirroring the discriminated `Card` union in
 * server/services/mediaKitService.ts field-for-field. This is the client's copy (the server
 * module pulls in `../db` and can't be imported into the RN bundle), kept in lockstep by hand.
 * If the server union changes, update this file to match.
 */
export type Provenance = "verified" | "self_reported" | "inferred" | "unknown";
export interface Confidence { level: Provenance; score: number }
export type Emphasis = "hero" | "standard" | "quiet";
export type FitBasis = "audience" | "credibility" | "whitespace" | "values";

interface CardBase {
  id: string;
  type: string;
  emphasis: Emphasis;
  confidence: Confidence;
  eyebrow: string;
  bg?: string | null;
}

export type CoverCardData = CardBase & {
  type: "cover";
  image: string | null;
  nameLines: string[];
  meta: string;
  hook: string;
  stats: Array<{ value: string; label: string }>;
};

export type IndexCardData = CardBase & {
  type: "index";
  value: number;
  max: number;
  verdict: string;
};

export type AudienceCardData = CardBase & {
  type: "audience";
  headline: string;
  sub: string;
  share: number | null;
  geo: Array<{ label: string; pct: number | null }>;
  stats: Array<{ n: string; k: string }>;
  /** The audience chart (additive; a card cached before it has none). */
  ages?: Array<{ label: string; pct: number }>;
  genders?: Array<{ label: string; pct: number }>;
  platforms?: Array<{ label: string; n: number; pct: number }>;
};

export type ContentCardData = CardBase & {
  type: "content";
  heroStat: { value: string; label: string };
  tiles: Array<{ image: string | null; stat: string }>;
  note: string;
};

export type VideoCardData = CardBase & {
  type: "video";
  posterUrl: string | null;
  videoUrl: string;
  note: string;
};

export type WhyFitsCardData = CardBase & {
  type: "whyFits";
  brand: { id: number; name: string; category: string; logo?: string | null };
  lead: string;
  reasons: Array<{ head: string; insight: string; basis: FitBasis }>;
};

export type StoryCardData = CardBase & {
  type: "story";
  beats: Array<{ year: string; where: string; line: string; current?: boolean }>;
  close: string;
};

export type ValuesCardData = CardBase & {
  type: "values";
  statement: string;
  planks: Array<{ name: string; line: string; provenance: Provenance }>;
  note: string;
};

export type AchievementsCardData = CardBase & {
  type: "achievements";
  heroEntry: { year: string; name: string; badge: string; detail: string };
  entries: Array<{ year: string; name: string; level: string }>;
  footnote: string;
};

export type FitCardData = CardBase & {
  type: "fit";
  image: string | null;
  lead: string;
  body: string;
  tags: string[];
};

// ── Brand-tailored creative cards (gorjana template, Phase 2) ──
export type CampaignConceptCardData = CardBase & {
  type: "campaignConcept";
  brand: { id: number; name: string; category: string; logo?: string | null };
  title: string;
  line: string;
  lineEmphasis: string;
  facets: string[];
  note: string;
  image: string | null;
  brandImage?: string | null;
};

export type ActivationPlanCardData = CardBase & {
  type: "activationPlan";
  lead: string;
  buckets: Array<{ label: string; audience: string; line: string }>;
  close: string;
  brandImage?: string | null;
};

export type SignatureIdeaCardData = CardBase & {
  type: "signatureIdea";
  title: string;
  line: string;
  lineEmphasis: string;
  facets: string[];
  note: string;
  image: string | null;
};

export type Card =
  | CoverCardData
  | IndexCardData
  | AudienceCardData
  | ContentCardData
  | VideoCardData
  | WhyFitsCardData
  | StoryCardData
  | ValuesCardData
  | AchievementsCardData
  | FitCardData
  | CampaignConceptCardData
  | ActivationPlanCardData
  | SignatureIdeaCardData;

export interface MediaKitData {
  athleteId: string;
  identity: { name: string; sport: string; school: string; hook: string };
  /** theme: the look (shared/deckLooks). lookAdvice: on a brand deck, the recommended look and why. */
  tokens: { theme: string; accent: string; lookAdvice?: import("../../../shared/deckLooks").LookAdvice };
  cards: Card[];
  deck?: string[];
  copyAlternates?: Record<string, { eyebrow?: string[]; tagline?: string[]; extra?: string[] }>;
  imagePool?: Array<{ gcsPath: string; shotType: string; hero: number }>;
  meta: { generatedAt: string; overallConfidence: number };
}

/** Shared props every card view in the deck accepts. */
export interface CardProps<T extends Card> {
  data: T;
  /** True only for the card currently centered in the deck — drives the "rise" stagger replay,
   *  video playback and meter/counter animations. */
  active: boolean;
}
