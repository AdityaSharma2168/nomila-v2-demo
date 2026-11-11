// The shell's bottom menu, as data, and where a Mila nav-chip lands in each shell. Pure (no React, no RN), so the
// menu and the route re-pointing unit-test without mounting a navigator (client/navigation/meShell.test.tsx).
//
//   shell    Home · Strategy · Mila · Opportunities · Studio   (the top bar carries Settings and Me; look B icons:
//            home · compass · the Nomila mark · inbox · aperture); with HOME_V3, Home · Business · Mila · Studio · Me.
//
// One layout since stage 1 (owner, 25 Oct 2026): the Classic layout switch and its menu are gone.

import type { MilaContext, MilaNavTarget } from "../hooks/use-mila-chat";
import { OPPS_V2 } from "../lib/flags";

/** The Strategy tab's stack: its one screen, Goals (client/screens/agent/GoalsTabScreen.tsx). */
export type StrategyStackParamList = {
  /** goalId: open the tab at that goal (Home's "Coming up"). */
  StrategyRoot:   { goalId?: string } | undefined;
};

export type MainTabParamList = {
  Home:          undefined;   // the shell: the Home briefing (Me's landing), as a tab
  Strategy:      { screen?: keyof StrategyStackParamList; params?: StrategyStackParamList[keyof StrategyStackParamList] } | undefined;   // the shell: Goals (labelled Strategy with AGENT_V3 off)
  Opportunities: undefined;
  SearchAsk:     undefined;   // centre button — Ask Mila, the tab's own screen (the bottom menu stays under it)
  Studio:        undefined;
  /** HOME_V3 only: Me as a tab (her photo, the M.I.A. card, the six tiles) and its screens. */
  Me:            { screen?: string; params?: object } | undefined;
};

export interface TabConfig {
  name: keyof MainTabParamList;
  icon: string;
  label: string;
  isCenter?: boolean;
}

/** Not a Feather glyph: the TabBar draws the four-arc Nomila mark for this icon (the shell's centre disc, look B). */
export const NOMILA_MARK_ICON = "nomila";

export const SHELL_TABS: TabConfig[] = [
  { name: "Home",          icon: "home",           label: "Home" },
  { name: "Strategy",      icon: "compass",        label: "Strategy" },
  { name: "SearchAsk",     icon: NOMILA_MARK_ICON, label: "Mila", isCenter: true },
  { name: "Opportunities", icon: "inbox",          label: "Opportunities" },
  { name: "Studio",        icon: "aperture",       label: "Studio" },
];

/**
 * AGENT_V3: the second tab is Goals (one screen: goal · game plan · this week's actions) instead of Strategy. Same route
 * name ("Strategy"), so every existing navigate keeps landing; only its label, glyph and root screen change.
 */
export const AGENT_SHELL_TABS: TabConfig[] = SHELL_TABS.map((t) =>
  t.name === "Strategy" ? { ...t, icon: "target", label: "Goals" } : t,
);

export function shellTabsFor(agentV3: boolean): TabConfig[] {
  return agentV3 ? AGENT_SHELL_TABS : SHELL_TABS;
}

/**
 * HOME_V3 (EXPO_PUBLIC_HOME_V3): Home · Business · Mila · Studio · Me (the Opportunities route, labelled Business). Goals leaves the bar (it opens from Me as
 * "Your plan"); its route stays registered, last and unlisted here, so every existing navigate("Strategy") still lands.
 */
export const HOME_V3_TABS: TabConfig[] = [
  { name: "Home",          icon: "home",           label: "Home" },
  { name: "Opportunities", icon: "inbox",          label: "Business" },
  { name: "SearchAsk",     icon: NOMILA_MARK_ICON, label: "Mila", isCenter: true },
  { name: "Studio",        icon: "aperture",       label: "Studio" },
  { name: "Me",            icon: "user",           label: "Me" },
];

/** The shell's bar: v3's five when HOME_V3 is on, else exactly today's (shellTabsFor). */
export function barTabsFor(agentV3: boolean, homeV3: boolean): TabConfig[] {
  return homeV3 ? HOME_V3_TABS : shellTabsFor(agentV3);
}

/**
 * The shell's tab routes in registration order. Off: today's five. HOME_V3: the bar's five, then Strategy — still
 * registered (Goals' routes, Mila's goal chips) but drawn by no bar button.
 */
export function shellRoutesFor(homeV3: boolean): Array<keyof MainTabParamList> {
  return homeV3
    ? ["Home", "Opportunities", "SearchAsk", "Studio", "Me", "Strategy"]
    : ["Home", "Strategy", "SearchAsk", "Opportunities", "Studio"];
}

/** The first tab on launch, absent a chosen door. */
export const INITIAL_TAB: keyof MainTabParamList = "Home";

// Which tab the chat was launched from → the context that seeds Mila's openers (and a "where you are" hint
// server-side). Tab-level only; the centre SearchAsk tab never seeds context. Home shows her identity and brand, so it
// reads as "brand"; Strategy has no server-known context yet and opens with the default openers.
export function contextForTabName(name: string | undefined): MilaContext | undefined {
  switch (name) {
    case "Home":
      return { type: "brand" };
    case "Opportunities":
      return { type: "deals-list" };
    case "Studio":
      return { type: "studio" };
    case "Me":
      return { type: "profile" };
    default:
      return undefined;
  }
}

// Routes that own the whole screen, tab bar included. The nested stack's own state hangs off the focused tab route,
// so the focused CHILD name is what is tested — the tab is still "Opportunities" while Deal Detail is on top of it.
// Me's screens and Settings (Home › …) are NOT here: the bottom menu stays under them. The brand book IS: it is read
// full-screen, one page per screen, like a story (swipe down or ✕ to leave).
const FULL_SCREEN_ROUTES = new Set(["DealDetail", "OpportunityDetail", "BrandBook"]);

export function isFullScreenRoute(state: { index: number; routes: Array<{ name: string; state?: any }> }): boolean {
  const active = state.routes[state.index];
  const nested = active?.state;
  if (!nested || typeof nested.index !== "number") return false;
  const child = nested.routes?.[nested.index]?.name;
  return typeof child === "string" && FULL_SCREEN_ROUTES.has(child);
}

/**
 * Where a nav-chip lands. Targets are semantic (Mila never knows RN route names).
 *
 *   tab   a screen inside a tab's stack: navigate("<tab>", { screen, params }) on the tab navigator. In the shell Me's
 *         screens and Settings are Home › … (the bottom menu stays under them).
 *   root  a screen on the ROOT stack, above the tabs: Brand (the Brand stack)
 *
 * What was the Brand tab is re-pointed: score → My Intelligence, facts → What Nomila Knows, story → My Story (the
 * matching Me destinations, inside Home); rates opens Home › Your rates; deck · signals open the Brand stack above the
 * tabs; profile → Home › Settings.
 */
export type NavRoute =
  | { kind: "tab";  tab: keyof MainTabParamList; screen?: string; params?: object }
  | { kind: "root"; screen: "Brand"; nested?: { screen: string; params?: object } }
  | { kind: "none" };

export function navTargetRoute(target: MilaNavTarget): NavRoute {
  const brand = (screen: string, params?: object): NavRoute => ({ kind: "root", screen: "Brand", nested: { screen, params } });
  const home = (screen: string): NavRoute => ({ kind: "tab", tab: "Home", screen });
  switch (target.screen) {
    case "deal":
      return { kind: "tab", tab: "Opportunities", screen: "Thread", params: { threadId: target.threadId, brandName: target.brandName } };
    case "deals":
      return { kind: "tab", tab: "Opportunities", screen: "OpportunitiesList" };
    // Mila's deal cards: the deal's ONE detail (a closed one opens read-only); her past deals open on the board until
    // All deals lands as its own screen; a booking opens its detail (Opportunities › BookingDetail).
    case "opportunity":
      return { kind: "tab", tab: "Opportunities", screen: "OpportunityDetail", params: { opportunityId: target.opportunityId } };
    case "deals_closed":
      return { kind: "tab", tab: "Opportunities", screen: "OpportunitiesList", params: { view: "closed" } };
    case "booking":
      return { kind: "tab", tab: "Opportunities", screen: "BookingDetail", params: { bookingId: target.bookingId } };
    case "deal_detail":
      return { kind: "tab", tab: "Opportunities", screen: "DealDetail", params: { dealId: target.dealId } };
    case "score":
      return home("Intelligence");
    case "facts":
      return home("Knows");
    case "story":
      return home("Story");
    case "deck":
      return brand("Deck");
    case "rates":
      // OPPS_V2: Your rates (the floor lives in it); off: Brand › Rates ("Your floor"), as on main.
      if (!OPPS_V2) return brand("Rates");
      return home("YourRates");
    case "signals":
      return brand("Signals");
    case "profile":
      return home("Settings");
    case "studio":
      return { kind: "tab", tab: "Studio", screen: "StudioHome" };
    case "pitches":
      return { kind: "tab", tab: "Studio", screen: "PitchesList" };
    case "media":
      return { kind: "tab", tab: "Studio", screen: "MediaLibrary" };
    case "camera_roll":
      return { kind: "tab", tab: "Studio", screen: "CameraRollReview", params: { ...(target.ask ? { ask: target.ask } : {}), ...(target.prepared ? { prepared: true } : {}) } };
    // AGENT_V3 open_screen targets.
    case "home":
      return { kind: "tab", tab: "Home", screen: "Landing" };
    case "goals":
      return { kind: "tab", tab: "Strategy", screen: "StrategyRoot", params: target.goalId ? { goalId: target.goalId } : undefined };
    case "me":
      return { kind: "tab", tab: "Home", screen: "Me", params: target.section ? { section: target.section } : undefined };
    default:
      // Unknown/future target from the server (or one the overlay handles in place) → do nothing rather than risk a
      // broken route. The navigate tool only ever emits the wired screens above.
      return { kind: "none" };
  }
}
