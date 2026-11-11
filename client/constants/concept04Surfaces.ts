// The Concept 0.4 surfaces (Home, Strategy, the Me screens, the shell and the pieces they share), as source paths
// relative to client/. Two source-scan tests read this list: outfitOnly (Outfit only, no ad-hoc sizes) and boldOnly
// (look B only: no pink, no legacy palette, no pills, no shadows). Add a surface here when it is built; a surface that
// is not listed is not checked.

export const CONCEPT04_SURFACES = [
  "components/home/HomeBriefing.tsx",
  // App layout B: Home split from Me (the daily briefing) and the public card slot on Me.
  "screens/home/HomeScreen.tsx", "components/me/PublicCardSection.tsx",
  // App layout B: the Opportunities money strip and sections, and Financials.
  "components/opps/BusinessSections.tsx", "screens/FinancialsScreen.tsx",
  "components/intelligence/ConfidenceLine.tsx", "components/intelligence/EvidenceSheet.tsx", "components/intelligence/Glyphs.tsx", "components/intelligence/IntelligenceRing.tsx",
  "components/me/MeHero.tsx", "components/me/MeAvatarButton.tsx", "components/me/ProvenanceGlyph.tsx", "components/me/EntryInfoSheet.tsx",
  "components/shell/TabBar.tsx", "components/shell/TopBar.tsx",
  "components/story/MyStoryBody.tsx", "components/story/StoryHeroCard.tsx",
  "components/strategy/RecommendationVisual.tsx",
  "components/ui/Bold.tsx", "components/ui/Chip.tsx", "components/ui/IconTile.tsx", "components/ui/LogoMark.tsx",
  // The density pass: the deck, the letter and the collapsed section card.
  "components/ui/Deck.tsx", "components/ui/LetterSheet.tsx", "components/ui/Accordion.tsx",
  "screens/me/IntelligenceAreaScreen.tsx", "screens/me/IntelligenceAreasScreen.tsx", "screens/me/KnowsScreen.tsx", "screens/me/BrandScreen.tsx", "screens/me/MeScreen.tsx",
  "screens/me/MyIntelligenceScreen.tsx", "screens/me/MyStoryScreen.tsx", "screens/me/PlatformsMeasuredScreen.tsx",
  // Her picks (docs/design/shop-her-picks.md): the pick card and Mila's pick card.
  "components/shop/PickCard.tsx", "components/mila/MilaShopWidget.tsx", "components/shop/PickEditSheet.tsx", "screens/me/MyPicksScreen.tsx", "components/shop/FromYourBrands.tsx",
  // Bookings v2, her side: the section in Opportunities, her offers, times, requests and sessions.
  "components/bookings/parts.tsx", "components/bookings/BookingsSetupDoor.tsx", "components/bookings/BookingPayoutsCard.tsx",
  "screens/bookings/BookingsScreen.tsx", "screens/bookings/OfferEditorScreen.tsx", "screens/bookings/OfferTimesScreen.tsx", "screens/bookings/BookingDetailScreen.tsx",
  // … and the session itself (the call and the after-session taps).
  "screens/bookings/BookingSessionScreen.tsx", "screens/bookings/BookingAfterSessionScreen.tsx",
  // Her public card editor (design-public-card-v3 §3 her side): Review, Preview (the visitor's page), Card settings.
  "screens/me/PublicCardReviewScreen.tsx", "screens/me/PublicCardPreviewScreen.tsx", "screens/me/PublicCardSettingsScreen.tsx",
  "components/publicCard/PublishSheet.tsx",
  // The agent Me and the Front Door page (promoted from the PR #900 prototypes): her page (mini and full), the Scouting
  // report, What Nomila knows on the memory, and their parts.
  "components/frontDoor/FrontDoorPage.tsx", "components/frontDoor/Atmosphere.tsx",
  "components/me/PublicPageMini.tsx", "components/me/Scouting.tsx", "components/me/AreaNotesCard.tsx", "components/me/DetailSheet.tsx",
  "screens/me/MeAgentScreen.tsx", "screens/me/PublicPageScreen.tsx", "screens/me/KnowsFactsScreen.tsx",
  // AGENT_V3 + AGENT_PLAN: the Goals tab (the chosen design, draft PR #900) and Home's "Coming up".
  "screens/agent/GoalsTabScreen.tsx", "components/goals/GoalCards.tsx", "components/goals/ComingUpStrip.tsx",
  // AGENT_V3 + AGENT_POST_KITS: the post kit screen and the Studio "For you" feed (design "Moments → post kits" §12).
  "screens/agent/PostKitScreen.tsx", "screens/agent/StudioForYouScreen.tsx", "components/postKit/PostKitAssetView.tsx",
  // The agent onboarding front: sign-in, the sport grid, "Is this you?", Mila's intro and what Mila already has.
  "screens/onboarding/SignInFront.tsx", "screens/onboarding/SportGridScreen.tsx", "screens/onboarding/IsThisYouFront.tsx",
  "screens/onboarding/MilaIntroScreen.tsx", "screens/onboarding/WhatMilaHasScreen.tsx", "screens/onboarding/OnboardingFrontGate.tsx",
  // The sport tiles the grid draws, and the same tiles as Mila's chat chips (not wired into the chat yet).
  "components/onboarding/SportTile.tsx", "components/onboarding/SportChips.tsx",
] as const;

/** The three kit files that carry BOTH looks (the legacy variant for screens not yet migrated, `bold` for look B). */
export const KIT_WITH_LEGACY = new Set<string>(["components/ui/Chip.tsx", "components/ui/IconTile.tsx", "components/ui/LogoMark.tsx"]);
