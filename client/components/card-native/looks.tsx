/**
 * looks — the theme dispatch hub. `CardView` renders a card in the requested look (shared/deckLooks, owner decision
 * 23 Oct 2026): Nomila (the app's one look, the DEFAULT), Luxe and Broadcast. Nomila draws every card type and is the
 * base: a card type another look has not drawn, and every card of a deck saved with a retired look ("campaign",
 * "immersive") or an unknown one, renders in Nomila. Add a look by dropping its components into a
 * `card-native/<look>/` dir, registering them below and adding it to shared/deckLooks.
 */
import React from "react";
import type { Card } from "./types";
import { DECK_LOOKS, resolveDeckLook, type DeckLook } from "../../../shared/deckLooks";

// Nomila — the complete base set (every card type, the brand creative cards included).
import {
  NomilaCoverCard, NomilaIndexCard, NomilaAudienceCard, NomilaContentCard, NomilaVideoCard, NomilaWhyFitsCard,
  NomilaStoryCard, NomilaValuesCard, NomilaAchievementsCard, NomilaFitCard, NomilaCampaignConceptCard,
  NomilaActivationPlanCard, NomilaSignatureIdeaCard,
} from "./nomila/cards";

// Luxe — the couture look.
import { LuxeCoverCard } from "./luxe/CoverCard";
import { LuxeIndexCard } from "./luxe/IndexCard";
import { LuxeAudienceCard } from "./luxe/AudienceCard";
import { LuxeContentCard } from "./luxe/ContentCard";
import { LuxeVideoCard } from "./luxe/VideoCard";
import { LuxeWhyFitsCard } from "./luxe/WhyFitsCard";
import { LuxeStoryCard } from "./luxe/StoryCard";
import { LuxeValuesCard } from "./luxe/ValuesCard";
import { LuxeAchievementsCard } from "./luxe/AchievementsCard";
import { LuxeFitCard } from "./luxe/FitCard";

// Broadcast — the matchday/scoreboard look.
import { BroadcastCoverCard } from "./broadcast/CoverCard";
import { BroadcastIndexCard } from "./broadcast/IndexCard";
import { BroadcastAudienceCard } from "./broadcast/AudienceCard";
import { BroadcastContentCard } from "./broadcast/ContentCard";
import { BroadcastVideoCard } from "./broadcast/VideoCard";
import { BroadcastWhyFitsCard } from "./broadcast/WhyFitsCard";
import { BroadcastStoryCard } from "./broadcast/StoryCard";
import { BroadcastValuesCard } from "./broadcast/ValuesCard";
import { BroadcastAchievementsCard } from "./broadcast/AchievementsCard";
import { BroadcastFitCard } from "./broadcast/FitCard";

// Per-look components, keyed by card type. `any` here because each card component has its own discriminated prop
// type; the dispatch below hands every component its own card.
type LookSet = Partial<Record<Card["type"], React.ComponentType<any>>>;

const NOMILA: Required<LookSet> = {
  cover: NomilaCoverCard, index: NomilaIndexCard, audience: NomilaAudienceCard, content: NomilaContentCard,
  video: NomilaVideoCard, whyFits: NomilaWhyFitsCard, story: NomilaStoryCard, values: NomilaValuesCard,
  achievements: NomilaAchievementsCard, fit: NomilaFitCard, campaignConcept: NomilaCampaignConceptCard,
  activationPlan: NomilaActivationPlanCard, signatureIdea: NomilaSignatureIdeaCard,
};

const LUXE: LookSet = {
  cover: LuxeCoverCard, index: LuxeIndexCard, audience: LuxeAudienceCard,
  content: LuxeContentCard, video: LuxeVideoCard,
  whyFits: LuxeWhyFitsCard, story: LuxeStoryCard, values: LuxeValuesCard,
  achievements: LuxeAchievementsCard, fit: LuxeFitCard,
};

const BROADCAST: LookSet = {
  cover: BroadcastCoverCard, index: BroadcastIndexCard, audience: BroadcastAudienceCard,
  content: BroadcastContentCard, video: BroadcastVideoCard,
  whyFits: BroadcastWhyFitsCard, story: BroadcastStoryCard, values: BroadcastValuesCard,
  achievements: BroadcastAchievementsCard, fit: BroadcastFitCard,
};

const LOOKS: Record<DeckLook, LookSet> = { nomila: NOMILA, luxe: LUXE, broadcast: BROADCAST };

/** The profile card types every look must draw to be "complete" (the brand creative cards are pitch-only). */
const ALL_TYPES: Card["type"][] = [
  "cover", "index", "audience", "content", "video",
  "whyFits", "story", "values", "achievements", "fit",
];

type LookMeta = { status: "complete" | "wip"; supports: Card["type"][] };
// Capability meta: a look is "complete" when it draws every profile card type, so a shipped deck in it never shows
// a card in another look. The Nomila fallback in CardView covers what a look has not drawn (today: the brand
// creative cards in Luxe and Broadcast, which are pitch-only and behind PITCH_CONCEPT_V1).
export const LOOK_META = Object.fromEntries(
  DECK_LOOKS.map((l) => [l, {
    status: ALL_TYPES.every((t) => !!LOOKS[l][t]) ? "complete" : "wip",
    supports: Object.keys(LOOKS[l]) as Card["type"][],
  }]),
) as Record<DeckLook, LookMeta>;

/** The looks offered in the switchers, in order: Nomila first (the default), then Luxe, then Broadcast. */
export const NATIVE_LOOKS: DeckLook[] = DECK_LOOKS.filter((k) => LOOK_META[k].status === "complete" || __DEV__);

export function CardView({
  card, active = false, theme, firstName = "her", onShare,
}: { card: Card; active?: boolean; theme?: string | null; firstName?: string; onShare?: () => void }) {
  const look = resolveDeckLook(theme);
  const Look = LOOKS[look][card.type] ?? NOMILA[card.type];
  if (!Look) return null;
  return <Look data={card} active={active} firstName={firstName} onShare={onShare} />;
}
