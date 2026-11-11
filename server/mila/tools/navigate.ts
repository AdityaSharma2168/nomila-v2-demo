/**
 * navigate.ts — Mila tool: take the athlete to an app screen.
 *
 * The model calls this when the athlete asks to go somewhere; the result flows
 * through the EXISTING nav-chip pipeline (navChips.ts `buildNavChip` → the `actions`
 * array on `done` → the pill render → MainTabNavigator.handleNavigate). It renders a
 * tap-through chip; it does NOT read or return any screen data — so it reads nothing
 * about the athlete and has no tenancy surface.
 *
 * Every destination the model may name maps to one of the WIRED screen-level targets
 * (NavScreen). Deeper/detail requests degrade to the nearest wired screen — a
 * specific deal → the deals list (get_deal opens the actual thread); a pitch or media
 * detail → its list. An unmappable destination yields no chip, never a broken target.
 */

import { z } from "zod";
import type { MilaTool, NavScreen } from "../types";

// Model vocabulary → wired screen. Keys ARE the enum the model chooses from.
const DESTINATION_TO_SCREEN: Record<string, NavScreen> = {
  deals: "deals",
  opportunities: "deals",
  inbox: "deals",
  deal: "deals", // a generic "a deal" → the list; a SPECIFIC deal is get_deal's job
  score: "score",
  brand: "score",
  home: "score",
  signals: "signals",
  profile: "profile",
  settings: "profile",
  account: "profile",
  rates: "rates", // Brand › Rates — her own floor (the computed rate card is retired)
  rate_card: "rates",
  floor: "rates",
  deck: "deck", // Brand › Deck (the Nomi Card full screen, share, who opened it)
  card: "deck",
  nomi_card: "deck",
  facts: "facts", // Brand › Facts (the athlete record)
  record: "facts",
  about: "facts",
  story: "story", // Brand › Story (the brand layer)
  narrative: "story",
  studio: "studio",
  pitches: "pitches",
  pitch: "pitches", // PitchDetail (by-id) not wired yet → its list
  media: "media",
  media_library: "media",
  media_kit: "media", // MediaDetail (by-id) not wired yet → its list
};

const navigateArgs = z.object({
  destination: z
    .enum(Object.keys(DESTINATION_TO_SCREEN) as [string, ...string[]])
    .describe(
      "Where to take the athlete (screen-level only): deals/opportunities, " +
        "score/brand, signals, profile/settings, studio, pitches, media (library), " +
        "deck/card (their Nomi Card), rates/floor, facts/record (what we hold about them), story. " +
        "For ONE specific deal call get_deal instead — it opens that deal's thread. " +
        "You can navigate to studio/pitches/media/signals but cannot read what's on them.",
    ),
});

export const navigateTool: MilaTool<typeof navigateArgs> = {
  name: "navigate",
  description:
    "Take the athlete to a screen in the app when they ask to go somewhere (their " +
    "deals, score, profile, Studio, pitches, media library, signals, deck, rates, " +
    "facts, or story). Renders a " +
    "tap-through chip to that screen — it does NOT read or return the screen's data, " +
    "so use a read tool (get_score, list_deals, …) if they want to KNOW something. " +
    "For a specific deal, use get_deal (it opens that exact deal).",
  argsSchema: navigateArgs,
  async execute(_athleteId, args) {
    // Pure screen mapping — no athlete data is read. Unmappable → no chip.
    const screen = DESTINATION_TO_SCREEN[args.destination] ?? null;
    return screen ? { navigated: true, screen } : { navigated: false };
  },
};
