// Getting to Me, its screens, Settings and the Brand stack from anywhere (see MainTabNavigator.tsx).
//
//   Me, My Story, What Nomila Knows, My Intelligence and Settings live INSIDE the Home tab (HomeStack) — and, with
//   HOME_V3, Me is its own tab — so the bottom menu stays under them; the Brand stack is pushed above the tabs on the
//   root stack. One layout since stage 1 (owner, 25 Oct 2026): the Classic layout switch (root-level MeStack, Brand and
//   Settings as tabs) is gone.
//
//   openMe(nav)                        the avatar → Me (the Me tab with HOME_V3, else Home › Me)
//   openIntelligence(nav)              the score chip / Score door → My Intelligence (Home › Intelligence)
//   openPicks(nav)                     Opportunities › Shop → My Picks (Home › Picks)
//   openSettings(nav)                  the gear, a "connect your inbox" row → Settings (Home › Settings)
//   openCardChats(nav)                 Me's public card area → "Chats on your card" (Home › CardChats)
//   toBrand(nav, screen, p)            a Brand-stack screen (Deck, Rates, Signals)
//   leaveMeTo(nav, tab, screen?, p?)   a Me door that lives in a tab (My Media, My Strategy): a plain navigate bubbles up
//                                      to the tabs.

import type { MainTabParamList } from "./shellTabs";
import { HOME_V3, OPPS_V2 } from "../lib/flags";

type Nav = { navigate: (...args: any[]) => void; getParent?: (...args: any[]) => any; getState?: () => any };

function rootOf(navigation: Nav): Nav {
  let n: any = navigation;
  for (let p = n.getParent?.(); p; p = n.getParent?.()) n = p;
  return n;
}

export function openMe(navigation: Nav): void {
  // HOME_V3: Me is its own tab (the bar's fifth button).
  if (HOME_V3) { navigation.navigate("Me", { screen: "MeHome" }); return; }
  navigation.navigate("Home", { screen: "Me" });
}

/** The M.I.A. score lives on My Intelligence (legacy retirement, phase 1): every Brand score entry point lands there. */
export function openIntelligence(navigation: Nav): void {
  navigation.navigate("Home", { screen: "Intelligence" });
}

/** My Picks (Me's own screen) from anywhere — Opportunities › Shop opens it (Home › Picks). */
export function openPicks(navigation: Nav): void {
  navigation.navigate("Home", { screen: "Picks" });
}

/** "Chats on your card" (public Mila mode): what visitors asked Mila on her public card. */
export function openCardChats(navigation: Nav): void {
  navigation.navigate("Home", { screen: "CardChats" });
}

/** "Your rates" (Me): Mila's suggested ranges, her private minimums, her public booking prices (OPPS_V2). */
export function openRates(navigation: Nav): void {
  // OPPS_V2 off: Brand › Rates, "Your floor".
  if (!OPPS_V2) { toBrand(navigation, "Rates"); return; }
  navigation.navigate("Home", { screen: "YourRates" });
}

/** Her public page on Me, in edit — where the "Book" door is switched on and her offers are set up (Bookings empty state). */
export function openBookDoor(navigation: Nav): void {
  navigation.navigate("Home", { screen: "PublicPage", params: { edit: true } });
}

/** Her public page on Me (Studio's Create › Page): Me's own tab with HOME_V3, else Home › PublicPage. */
export function openPublicPage(navigation: Nav): void {
  if (HOME_V3) { navigation.navigate("Me", { screen: "PublicPage" }); return; }
  navigation.navigate("Home", { screen: "PublicPage" });
}

export function openSettings(navigation: Nav): void {
  navigation.navigate("Home", { screen: "Settings" });
}

export function toBrand(navigation: Nav, screen: string, params?: object): void {
  rootOf(navigation).navigate("Brand", { screen, params });
}

export function leaveMeTo(navigation: Nav, tab: Exclude<keyof MainTabParamList, "SearchAsk">, screen?: string, params?: object): void {
  // Me is inside the tabs: the navigate bubbles up to the tab navigator.
  navigation.navigate(tab, screen ? { screen, params } : undefined);
}
