/**
 * capabilities.ts — Mila's static, factual capabilities catalog for get_help.
 *
 * The single source for "what can you do" / "how do I …" answers. Everything here
 * is a BUILT feature — never list something Mila can't actually do.
 *
 * CRUCIAL honesty rule: navigating to a screen is NOT the same as reading it. Mila
 * can route the athlete to Studio, Pitches, Media library, and Signals, but she has
 * NO tool that reads their contents — so those are marked `milaCanRead: false` and
 * must be framed as "I can take you there," never "I can tell you what's on it."
 */

import type { NavScreen } from "./types";
import { shopEnabled } from "../services/shop/config";

export interface CatalogCapability {
  /** What Mila can do, in the athlete's terms. */
  title: string;
  /** One factual line — no overclaiming. */
  detail: string;
}

export interface CatalogScreen {
  screen: NavScreen;
  /** The screen's name in the app. */
  name: string;
  /** What the screen is. */
  whatItIs: string;
  /** How the athlete reaches it. */
  reach: string;
  /**
   * Whether Mila can ANSWER questions about this screen's contents (a read tool
   * exists), vs only navigate to it. false → she offers to take them there and
   * never implies she knows what's on it.
   */
  milaCanRead: boolean;
}

// What Mila can actually DO — one entry per built capability. No unbuilt features.
export const MILA_CAPABILITIES: CatalogCapability[] = [
  {
    title: "Explain your M.I.A. score",
    detail:
      "Your M.I.A. score out of 850, what it's made of — your strengths and room to grow — " +
      "and follower counts per platform.",
  },
  {
    title: "Go through your deals",
    detail:
      "List and filter the brand deals detected in your inbox, and dig into any " +
      "one deal — the offer, status, and my read on whether it's worth it.",
  },
  {
    title: "Tell you what needs attention",
    detail: "Surface the deals and threads waiting on you right now.",
  },
  {
    title: "Talk rates",
    detail:
      "Nomila's rate estimates are being rebuilt, so I won't quote a rate — but I'll " +
      "work from the floor you've set and help you read any offer.",
  },
  {
    title: "Report your social analytics",
    detail:
      "Follower counts and recent growth across your connected platforms (shown " +
      "right here in chat).",
  },
  {
    title: "Look at your profile",
    detail: "Your profile details, your floor, and your connected accounts.",
  },
  {
    title: "Draft a reply to a brand",
    detail:
      "Write a reply for a specific deal — accept, negotiate, ask for terms, or " +
      "pass. You review it and send with a tap; I never send on my own.",
  },
  {
    title: "Take you anywhere in the app",
    detail:
      "Jump you straight to your deals, score, profile, Studio, pitches, media " +
      "library, or signals — see the screens below.",
  },
  {
    title: "Explain how the app works",
    detail: "Answer how-do-I and what-can-you-do questions, like this one.",
  },
];

/** Her picks (SHOP_V1 only — listed only while the tools are declared). */
export const SHOP_CAPABILITY: CatalogCapability = {
  title: "Get a product ready for your picks",
  detail:
    "Give me your own link (your Amazon tag, LTK, ShopMy, a brand code or any shop link) and I'll read the product, " +
    "check it against your signed deals and show you a card to add it as a draft. You publish it on My Picks; I " +
    "never publish, and Nomila never changes your link or takes a cut. I can also tell you how your picks are doing " +
    "(clicks only).",
};

// Every screen Mila can navigate to. `milaCanRead` marks whether she can also
// answer questions about what's on it — navigate-only screens (Studio, Pitches,
// Media, Signals) have no read tool, so she takes you there, she doesn't report on them.
export const NAVIGABLE_SCREENS: CatalogScreen[] = [
  {
    screen: "deals",
    name: "Deals (Opportunities)",
    whatItIs: "the brand deals detected in your inbox, and what needs your attention",
    reach: 'ask me "show me my deals", or tap Opportunities in the tab bar',
    milaCanRead: true,
  },
  {
    screen: "score",
    name: "Brand home",
    whatItIs: "your M.I.A. score and what it's made of",
    reach: 'ask me "how\'s my score", or tap Brand in the tab bar',
    milaCanRead: true,
  },
  {
    screen: "signals",
    name: "Signals",
    whatItIs: "who has opened and engaged with the brand card you've shared",
    reach: 'ask me to "take me to my signals" (it lives on the Brand tab)',
    milaCanRead: false,
  },
  {
    screen: "profile",
    name: "Profile & settings",
    whatItIs: "your profile, your floor, and your connected accounts",
    reach: 'ask me to "open my profile", or tap Settings in the tab bar',
    milaCanRead: true,
  },
  {
    screen: "studio",
    name: "Studio",
    whatItIs: "your creator workspace — pitches, media, and your public profile",
    reach: 'ask me to "open Studio", or tap Studio in the tab bar',
    milaCanRead: false,
  },
  {
    screen: "pitches",
    name: "Pitches",
    whatItIs: "your list of brand pitches",
    reach: 'ask me to "open my pitches" (it lives in Studio)',
    milaCanRead: false,
  },
  {
    screen: "media",
    name: "Media library",
    whatItIs: "your uploaded media assets",
    reach: 'ask me to "open my media library" (it lives in Studio)',
    milaCanRead: false,
  },
];

/**
 * The bounded static catalog get_help returns. `note` is guidance for the model:
 * the navigate-only screens must be offered as a destination, never as something
 * Mila can describe.
 */
export function helpCatalog(): {
  capabilities: CatalogCapability[];
  screens: CatalogScreen[];
  note: string;
} {
  return {
    capabilities: shopEnabled() ? [...MILA_CAPABILITIES, SHOP_CAPABILITY] : MILA_CAPABILITIES,
    screens: NAVIGABLE_SCREENS,
    note:
      "For any screen with milaCanRead=false (Studio, Pitches, Media library, " +
      "Signals) you can NAVIGATE the athlete there but you have NO tool to read " +
      "its contents — offer to take them there, and never imply you know what's " +
      "on it. Answer only from this catalog; do not invent features.",
  };
}
