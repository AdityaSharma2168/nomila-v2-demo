// use-recommendations — the Recommendation view's types, kept for the pure helpers and visuals that still take them
// (lib/strategyLogic, components/strategy/RecommendationVisual). No reads: GET /me/recommendations was retired with the
// Objective routes (12 Oct 2026), and its last readers, the Strategy plan screens and Home's recommendation row, were
// removed on 3 Nov 2026. Types mirror server/services/intelligence/brain/recommendationView.ts.
import type { ObjectiveHorizon } from "./use-objectives";

export type ResponseState = "none" | "accepted" | "modified" | "declined" | "deferred";
export type ResponseAction = "accept" | "defer" | "decline";
export type VisualHint =
  | { kind: "platform"; platform: string; domain: string | null }
  | { kind: "her_photo"; domain: string | null }
  | { kind: "goal_tile"; domain: string | null }
  /**
   * A move about a brand whose research is CONFIRMED and holds an image (server recommendationView, Brain 0.13.0-exp):
   * the cover first on the card and the deck, her photo second in the deck. `brandImages` are the brand's further images.
   */
  | { kind: "brand"; brandImageUrl: string; domain: string | null; brandImages?: string[] }
  /**
   * A brand, organisation or team card without a confirmed cover: its logo alone on the blank ground (an org's from its
   * official domain only); `logoUrl` null ⇒ the category default. NEVER her photo (owner rule, 7 Oct 2026).
   */
  | { kind: "logo"; logoUrl: string | null; name: string | null; site: string | null; domain: string | null };
/** What a move is about (not the decision subject). Organisations and teams carry no imagery yet. */
export interface AboutView { kind: "brand" | "organisation" | "team" | "platform" | "none"; name: string | null; brandId: number | null; logoUrl: string | null; derived: boolean }
export type EvidenceKind = "goal" | "read" | "opportunity" | "platform" | "research" | "context" | "request" | "other";

export interface EvidenceRow { ref: string; kind: EvidenceKind; label: string; how: string; url: string | null }

export interface ObjectiveJoin {
  id: string;
  domain: string;
  text: string;
  owner: string;
  sourceMethod: string | null;
  /** Her wording: draw quotation marks. Nomila's wording: never. */
  quoted: boolean;
  horizon: ObjectiveHorizon;
  lifecycle: string;
  disposition: string;
}

export interface RecommendationView {
  version: string;
  id: string;
  title: string;
  titleStored: boolean;
  /** Absent from servers before recommendation-view/0.2. */
  about?: AboutView | null;
  what: string;
  why: string;
  notSeen: string[];
  sourceCount: number;
  evidence: EvidenceRow[];
  executionPath: string;
  relationToExistingWork: string;
  source: string;
  createdAt: string;
  objectiveIds: string[];
  objective: ObjectiveJoin | null;
  response: { state: ResponseState; at: string | null; actor: string | null; said?: string };
  authorization: { state: "none" | "prepare_authorized" | "revoked"; at: string | null; actor: string | null };
  execution: { state: "none" | "proposed" | "executed" | "failed"; refs: Array<{ kind: string; id: string; at: string }> };
  outcome: null | { at: string; followed: boolean | null; result: unknown };
  closed: boolean;
  readiness: { state: "available" | "unavailable"; capability: string | null; reason: string | null; domain: string | null; words: string };
  mayPrepare: boolean;
  visual: VisualHint;
}

export interface RecommendationsResponse { items: RecommendationView[]; waiting: number }
