/**
 * agent/onboarding/catalog.ts — what onboarding can offer: the connectors (the existing connection flows), the
 * capabilities (entry points), and the two pieces of FIXED text Mila never writes herself: the consent terms and the
 * age-band question. Everything else in the conversation is the onboarding skill's words.
 *
 * Generic within Nomila's world: no athlete, sport, school or brand appears here.
 */
import type { AgeBandCardPayload, CapabilityEntry, ConsentCardPayload } from "../../../shared/agent";
import { agentV3Enabled } from "../config";
import { agentPostKitsEnabled } from "../postKit/config";
import { availableNow, capability as registryEntry } from "../welcome/registry";
import { openToAthlete } from "../welcome/turnOn";

export interface ConnectorEntry {
  /** The platform key of the existing flow: POST /api/v1/me/connect/:platform (server/routes/connections.ts). */
  id: string;
  service: string;
  kind: "social" | "inbox" | "calendar";
  /** The smallest access, in plain words. */
  access: string[];
}

/** The connections onboarding may offer — each one is an existing OAuth flow (server/lib/integrations/registry.ts). */
export const CONNECTORS: readonly ConnectorEntry[] = [
  { id: "instagram", service: "Instagram", kind: "social", access: ["Read your profile, posts and audience insights", "Read your DMs to find brand requests"] },
  { id: "tiktok", service: "TikTok", kind: "social", access: ["Read your profile and video stats"] },
  { id: "youtube", service: "YouTube", kind: "social", access: ["Read your channel and video stats"] },
  { id: "gmail", service: "Gmail", kind: "inbox", access: ["Read emails to find and manage deals", "Draft replies you approve before anything is sent"] },
  { id: "outlook", service: "Outlook", kind: "inbox", access: ["Read emails to find and manage deals", "Draft replies you approve before anything is sent"] },
];

/**
 * What Nomila can do. Each is an entry point (screen today; a skill or workflow as those land). `available` here is the
 * static default; capabilitiesFor() decides it at call time (the Welcome registry for the tiles in REGISTRY_TILES).
 */
export const CAPABILITIES: readonly CapabilityEntry[] = [
  { id: "deals", label: "Find and manage your deals", skillId: null, workflow: null, screen: "opportunities", available: true },
  { id: "bookings", label: "Take bookings (appearances, lessons, calls)", skillId: null, workflow: null, screen: "bookings", available: false },
  { id: "shop", label: "Your shop: products you recommend", skillId: null, workflow: null, screen: "shop", available: false },
  { id: "public_card", label: "Your public card", skillId: null, workflow: null, screen: "public-card", available: false },
  { id: "pitch_deck", label: "Pitch decks for brands", skillId: null, workflow: null, screen: null, available: true },
  { id: "content", label: "Content ideas and post kits", skillId: null, workflow: null, screen: null, available: false },
];

/**
 * The tiles that stand for a Welcome registry capability (agent/welcome/registry.ts): such a tile is available exactly
 * when the registry says the capability is available now (status not planned, its flag on) AND open to this athlete
 * (welcome/turnOn.ts openToAthlete: bookings is for pilot athletes only). One source of truth, so a tile never offers
 * what Me and Mila cannot (catalog.test.ts holds the two together).
 */
export const REGISTRY_TILES: Readonly<Record<string, string>> = {
  bookings: "bookings", shop: "shop", public_card: "public_page", pitch_deck: "pitch_deck",
};

/** The capabilities onboarding introduces, for this athlete. No door is closed by age (owner decision, 9 Oct). */
export function capabilitiesFor(athleteId?: string | null): CapabilityEntry[] {
  // "Content ideas and post kits" (Track E, design "Moments → post kits" §13/§16 step 5) is read at call time, behind
  // BOTH AGENT_POST_KITS and AGENT_V3 (each off unless exactly "true"): its door is the Studio library, whose route is
  // dark without AGENT_V3, so with only post kits on the entry would open onto a library that cannot list them. The
  // catalog never needs a deploy to turn it on.
  const content = agentPostKitsEnabled() && agentV3Enabled();
  return CAPABILITIES.map((c) => {
    if (c.id === "content") return content ? { ...c, available: true, screen: "studio" } : c;
    const key = REGISTRY_TILES[c.id];
    if (!key) return c;
    const entry = registryEntry(key);
    // No athlete in hand: a capability open only to some athletes is not offered (fails closed).
    const open = !!entry && availableNow(entry) && openToAthlete(key, athleteId ?? "");
    return open === c.available ? c : { ...c, available: open };
  });
}

export const CONSENT_ID = "how_mila_works/1";

/** Fixed consent terms (Nomila's words, versioned in the id). Mila only chooses the moment. */
export function consentCard(): ConsentCardPayload {
  return {
    consentId: CONSENT_ID,
    title: "How Mila works for you",
    points: [
      "Mila researches, drafts and suggests. Nothing is sent, posted, published or paid without your tap.",
      "Every suggestion shows how Mila got it, with its sources.",
      "You can correct or remove anything Mila holds about you, and disconnect any account at any time.",
    ],
    buttons: ["agree", "not_now"],
  };
}

/** Optional: the answer is a "said" fact that gates nothing. */
export const AGE_BAND_CARD: AgeBandCardPayload = {
  question: "Are you under 18?",
  options: [{ value: "under_18", label: "Under 18" }, { value: "18_plus", label: "18 or older" }],
};

/** Re-offer caps for connections and consent: never nag. */
export const OFFER_CAPS = {
  /** A connection the athlete declined is offered again at most this many more times. */
  connectReoffersAfterDecline: 1,
  /** At most this many offers of one connection in total. */
  connectMaxOffers: 3,
  /** Turns to wait before offering the same connection again. */
  connectTurnGap: 2,
  consentMaxOffers: 3,
  /** The optional age-band question is asked at most this many times. */
  ageBandMaxAsks: 2,
} as const;
