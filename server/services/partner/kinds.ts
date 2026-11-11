/**
 * partner/kinds.ts — the Partner door's "What kind of request?" chips, mapped onto the EXISTING deal vocabulary.
 *
 * No new category list: a request lands with
 *   - inbox_threads.classification.category from DealCategory (server/skills/dealDetector.ts), where the board reads it;
 *   - deals.deal_type from deals_type_check (social_post | appearance | ambassador | autograph | licensing | other);
 *   - for press, classification.media_kind from MEDIA_KINDS (interview | podcast | feature | op_ed | cover), which the
 *     board turns into the card's Interview / Podcast / Feature chip.
 * EDITORIAL is deliberately NOT used for press: in this codebase it means a product review (dealDetector's prompt), and
 * an interview is MEDIA, exactly as an emailed interview request is classified.
 */
import type { DealCategory, MediaKind } from "../../skills/dealDetector";
import { PARTNER_REQUEST_KINDS, type PartnerRequestKind } from "../../../shared/schema";

export { PARTNER_REQUEST_KINDS, type PartnerRequestKind };

export type DealType = "social_post" | "appearance" | "ambassador" | "autograph" | "licensing" | "other";

export interface KindMapping {
  /** The chip, as the visitor saw it. */
  label: string;
  category: DealCategory;
  dealType: DealType;
  /** press goes to the short press form: no fit card, no Serious offer, no budget. */
  press: boolean;
}

export const KIND_MAP: Record<PartnerRequestKind, KindMapping> = {
  sponsorship: { label: "Sponsorship or ambassador",       category: "PAID",  dealType: "ambassador",  press: false },
  content:     { label: "Social posts or content",         category: "PAID",  dealType: "social_post", press: false },
  endorsement: { label: "Endorsement or product collab",   category: "PAID",  dealType: "licensing",   press: false },
  appearance:  { label: "Appearance or event",             category: "PAID",  dealType: "appearance",  press: false },
  press:       { label: "Interview, podcast or editorial", category: "MEDIA", dealType: "appearance",  press: true },
  other:       { label: "Something else",                  category: "PAID",  dealType: "other",       press: false },
};

/** The press form's format chips → MEDIA_KINDS. */
export const PRESS_FORMATS = ["interview", "podcast", "editorial"] as const;
export type PressFormat = typeof PRESS_FORMATS[number];
export const PRESS_FORMAT_MEDIA_KIND: Record<PressFormat, MediaKind> = { interview: "interview", podcast: "podcast", editorial: "feature" };

/** The brand's goal chips (design §6 step 3). */
export const GOALS = ["launch", "awareness", "event", "product_seeding", "other"] as const;
export type Goal = typeof GOALS[number];

/**
 * Budget range buckets, or "not sure" — a STATED RANGE, never an amount (design §6: Mila never comments on it). The
 * bounds (whole dollars) are only used for her private "budget against your minimum" marker.
 */
export const BUDGETS = {
  under_1k:  { label: "Under $1,000",       min: 0,      max: 1_000 },
  "1k_5k":   { label: "$1,000 – $5,000",    min: 1_000,  max: 5_000 },
  "5k_15k":  { label: "$5,000 – $15,000",   min: 5_000,  max: 15_000 },
  "15k_50k": { label: "$15,000 – $50,000",  min: 15_000, max: 50_000 },
  over_50k:  { label: "Over $50,000",       min: 50_000, max: null },
  not_sure:  { label: "Not sure yet",       min: null,   max: null },
} as const;
export type Budget = keyof typeof BUDGETS;

export function isKind(v: unknown): v is PartnerRequestKind {
  return typeof v === "string" && (PARTNER_REQUEST_KINDS as readonly string[]).includes(v);
}
