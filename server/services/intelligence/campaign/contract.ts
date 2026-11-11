/**
 * campaign/contract.ts — #570 C1 as amended, as types. Campaign = the durable activation; CampaignSpec = immutable
 * versioned scope; CampaignDeliverable = a tracked obligation whose identity spans spec versions. Pure types.
 */
import type { CampaignOriginProposal } from "../brain/executionRouter";

export const CAMPAIGN_VERSION = "campaign/0.1.0";
/** Amendment 3: `idea` removed (the Recommendation is the governed pre-campaign object); `active` is a derived reading, not a stored status. */
export const CAMPAIGN_STATUSES = ["planning", "approved", "ended"] as const;
/** What closes an obligation (Amendment 3). Declared at introduction; never defaulted, never inferred from category or door. */
export const COMPLETION_CRITERIA = ["cleared", "published", "externally_confirmed"] as const;
export type CompletionCriterion = (typeof COMPLETION_CRITERIA)[number];
export const allowedCriteria = (category: DeliverableIntent["category"]): readonly CompletionCriterion[] =>
  category === "content" || category === "ugc" ? COMPLETION_CRITERIA : ["externally_confirmed"];
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const DELIVERABLE_CATEGORIES = ["content", "ugc", "access", "partnership", "licence", "other"] as const;
export const CONTENT_FORMATS = ["post", "story", "reel", "carousel", "ad", "clip"] as const;

export type CampaignPeriod = CampaignOriginProposal["period"];

/** #570 §4.1 DeliverableIntent. */
export interface DeliverableIntent {
  category: (typeof DELIVERABLE_CATEGORIES)[number];
  contentFormat?: (typeof CONTENT_FORMATS)[number];
  sourceQuote: string | null;
  quantity: number;
  dueOn: string | null;
  optional: boolean;
  brandId?: number | null;
  dealDeliverableId?: string | null;
  /** Amendment 3: what closes this obligation. Required. */
  completesWhen: CompletionCriterion;
}

export interface Campaign {
  id: string; athleteId: string; version: typeof CAMPAIGN_VERSION;
  originDoor: "recommendation" | "deal" | "athlete" | "observed";
  purpose: string;
  recommendationIds: string[]; objectiveIds: string[]; dealIds: string[]; brandIds: number[]; participantAthleteIds: string[];
  period: CampaignPeriod;
  evidence: Array<{ ref: string; how: string }>;
  status: CampaignStatus; endedBecause: "fulfilled" | "expired" | "cancelled" | null;
  currentSpecVersion: number;
  createdAt: string; startedAt: string | null; endedAt: string | null;
}

export interface CampaignSpec {
  id: string; campaignId: string; athleteId: string; version: number;
  purpose: string;
  /** In scope for this version, by deliverable id. */
  deliverableIds: string[];
  period: CampaignPeriod;
  constraints: Array<{ text: string; source: "contract" | "athlete" | "recommendation" }>;
  approval: "draft" | "athlete" | "brand" | "contractual";
  provenance: { origin: { door: Campaign["originDoor"]; recommendationId?: string }; supersedes: number | null; createdBy: "deal_door" | "recommendation_door" | "athlete"; createdAt: string };
  supersedes: number | null;
  createdAt: string; approvedAt: string | null; approvedBy: string | null;
}

export interface CampaignDeliverable {
  id: string; campaignId: string; athleteId: string;
  introducedVersion: number; supersededVersion: number | null;
  seq: number; intent: DeliverableIntent;
  /** `fulfilled` only by the declared criterion: derived for cleared/published, written by the confirming party for externally_confirmed. */
  status: "open" | "fulfilled" | "waived" | "cancelled";
  dealDeliverableId: string | null;
  /** 0075: the provenance of an external confirmation — an outcome observation needs it to be one. */
  confirmedBy: string | null; confirmedAt: string | null; confirmationRef: string | null;
  createdAt: string; supersededAt: string | null;
}
/** The campaign as read: its stored status, and `active` when approved work has begun (derived; Amendment 3). */
export type CampaignPhase = CampaignStatus | "active";

/** The reference a campaign is cited by on a Recommendation's execution refs and in Existing Work. */
export const campaignRef = (c: Pick<Campaign, "id">) => ({ kind: "campaign" as const, id: c.id });
