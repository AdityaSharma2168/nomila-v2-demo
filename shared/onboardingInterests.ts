/**
 * shared/onboardingInterests.ts — the tiles of Mila's intro ("What are you most interested in?"), in order: Your brand
 * full width on top, then Your page · Create · Deals · Bookings · Picks (Soon) · Money. The athlete's picks are saved as
 * "said" facts through the onboarding turn's existing `capability` action (server/agent/onboarding/turn.ts), so the
 * plan reads where they want to start.
 *
 * `capabilityId` is the onboarding catalog entry (server/agent/onboarding/catalog.ts) a tile stands for, when there is
 * one; a tile with none is accepted by its own key. The client adds each tile's glyph and line.
 * Generic: nothing here names an athlete, sport, school or brand.
 */
export interface OnboardingInterest {
  key: string;
  label: string;
  capabilityId: string | null;
  /** Shown as a chip ("Soon") while the capability behind it is not live. */
  soon: boolean;
}

export const ONBOARDING_INTERESTS: readonly OnboardingInterest[] = [
  { key: "brand", label: "Your brand", capabilityId: null, soon: false },
  { key: "page", label: "Your page", capabilityId: "public_card", soon: false },
  { key: "create", label: "Create", capabilityId: "content", soon: false },
  { key: "deals", label: "Deals", capabilityId: "deals", soon: false },
  { key: "bookings", label: "Bookings", capabilityId: "bookings", soon: false },
  { key: "picks", label: "Picks", capabilityId: "shop", soon: true },
  { key: "money", label: "Money", capabilityId: null, soon: false },
];

/** The id a tile is sent as on the `capability` action: its catalog entry's id, else its own key. */
export function interestActionId(i: Pick<OnboardingInterest, "key" | "capabilityId">): string {
  return i.capabilityId ?? i.key;
}

/** The tile an action id stands for (a catalog id or a tile key), or null. */
export function interestByActionId(id: string): OnboardingInterest | null {
  return ONBOARDING_INTERESTS.find((i) => interestActionId(i) === id || i.key === id) ?? null;
}
