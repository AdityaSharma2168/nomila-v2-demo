// Concept 0.4 Slice 2 read (server/routes/meIntelligence.ts):
//
//   GET /api/v1/me/intelligence → useMeIntelligence()   the `my-intelligence/0.1` view behind My Intelligence
//
// The key sits under ["me", …] like Slice 1's, so anything that invalidates ["me"] refreshes it too. The client consumes
// the view AS SERVED: pageState, dimension states, citation-strength buckets and withholding all come from the server.
// Types mirror server/services/intelligence/views/myIntelligence.ts (frozen contract), as use-me-knowledge mirrors its view.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { MyIntelligencePageState } from "./use-me-knowledge";

export type { MyIntelligencePageState } from "./use-me-knowledge";

export type MarketabilityDimension =
  | "athletic_authority" | "audience_scale" | "engagement_quality" | "cultural_relevance"
  | "narrative_power" | "brand_fit" | "commercial_proof" | "momentum";
/** State's FindingDirection, verbatim. `neutral` is carried; the client shows no label for it (O-2). */
export type FindingDirection = "strength" | "neutral" | "gap" | "unknown";
export type CitationStrength = "grounded" | "site_only" | "nomila_supplied" | "not_support" | "unrecorded";
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";
export type ComponentEvidenceClass = "MEASURED" | "EVALUATED" | "ASSUMED" | "MISSING";
export type ReadState = "assessed" | "assessed_partial" | "insufficient";
export type IdentityValue = "pending" | "resolved" | "ambiguous" | "failed" | null;
export type IdentityBasis = "q1" | "athlete_confirmed" | "athlete_rejected";

export interface MyIntelligenceIdentity {
  value: IdentityValue;
  basis: IdentityBasis | null;
  reason: string | null;
  determinedAt: string | null;
}

export interface MyIntelligenceComponent {
  key: string;
  evidenceClass: ComponentEvidenceClass;
  confidence: ConfidenceLevel | null;
  rationale: string | null;
  sources: string[];
}

/** 0.2: the ledger's source class for a stored sub-signal, verbatim. */
export type SignalSource = "connected_verified" | "platform_public" | "web_researched" | "inferred" | "imputed";
/** 0.2: one stored sub-signal. An imputed one never carries its value (the server withholds it). */
export interface MyIntelligenceSignal { key: string; value: number | null; source: SignalSource | null; imputed: boolean }

export interface MyIntelligenceDimension {
  key: MarketabilityDimension;
  state: FindingDirection;
  score: number | null;
  confidence: ConfidenceLevel | null;
  confidenceReason: string | null;
  rationale: string | null;
  components: MyIntelligenceComponent[];
  sources: Record<CitationStrength, string[]>;
  /** 0.2: the row's stored weight and score × weight (the ring's band); null on an older server or an absent dimension. */
  weight?: number | null;
  contribution?: number | null;
  /** 0.2: the row's stored sub-signals; absent on an older server. */
  signals?: MyIntelligenceSignal[];
}

export interface MyIntelligenceEvidence {
  id: string;
  claim: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  observedAt: string | null;
  strength: CitationStrength;
  domain: string | null;
}

export interface MyIntelligenceAssessment {
  entryId: string;
  evidenceAsOf: string;
  createdAt: string;
  versions: { methodology: string | null; evaluator: string | null; params: string | null };
  score: number;
  readState: ReadState;
  overall: { level: ConfidenceLevel | null; explanation: string | null };
  confidenceBand: null;
  summary: string | null;
  hasReasons: boolean;
  dimensions: MyIntelligenceDimension[];
  evidence: MyIntelligenceEvidence[];
  notes: { strengths: string[]; constraints: string[]; missingEvidence: string[]; evaluationRisks: string[] };
}

export interface MyIntelligenceGoal {
  objectiveId: string;
  domain: string;
  text: string;
  buildsOn: MarketabilityDimension[];
  fromEarlierRead: boolean;
}

/** 0.2: who a waiting request's evidence must come from (the Brain's source class). "athlete" = hers to give. */
export type RequestSourceClass = "athlete" | "connected" | "external";
export interface MyIntelligenceWaitingItem {
  requestId: string;
  status: string;
  nomilaSays: string;
  sheAsked: string | null;
  cta: { kind: "add_contract" | "add_document"; label: string } | null;
  /** Absent on a 0.1 server. */
  sourceClass?: RequestSourceClass;
}

/** What would sharpen a preliminary preview (server: services/miaPreview/previewMeta.ts MiaSharpen). */
export type MiaSharpen =
  | { kind: "connect"; platform: string; service: string; reason: "measured_audience" }
  | { kind: "awaiting_data"; platform: string; service: string; reason: "connected_not_yet_read" }
  | { kind: "evidence"; text: string };

/** The M.I.A. preview's labels for a new-agent athlete; null for everyone else (absent on an older server). */
export interface MyIntelligencePreview {
  preliminary: boolean;
  /** "Preliminary — connect to sharpen" while preliminary; null otherwise. */
  label: string | null;
  inputs: { public: number; measured: number };
  sharpen: MiaSharpen[];
}

export interface MyIntelligenceView {
  contract: "my-intelligence/0.1" | "my-intelligence/0.2";
  athleteId: string;
  asOf: string;
  pageState: MyIntelligencePageState;
  identity: MyIntelligenceIdentity | null;
  inProgress: boolean;
  assessment: MyIntelligenceAssessment | null;
  movement: { displayable: false; reason: "no_governed_stability_threshold" };
  preview?: MyIntelligencePreview | null;
  /** Her identity is unconfirmed on the latest check: the read shown is her LAST one, kept (absent from an older server). */
  identityUnconfirmed?: null | { reason: "disputed_identity_fact"; since: string | null };
  bridge: {
    waitingOnYou: null | {
      count: number;
      items: MyIntelligenceWaitingItem[];
    };
    goals: null | MyIntelligenceGoal[];
    reviewCount: number | null;
  };
}

export function useMeIntelligence(enabled = true) {
  return useQuery<MyIntelligenceView>({
    queryKey: ["me", "intelligence"],
    queryFn: async () => (await apiRequest("GET", "/api/v1/me/intelligence")).json() as Promise<MyIntelligenceView>,
    staleTime: 30_000,
    enabled,
  });
}
