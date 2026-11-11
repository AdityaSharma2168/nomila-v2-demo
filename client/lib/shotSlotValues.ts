/**
 * shotSlotValues — the shot-slot vocabulary the chips offer, as a PURE module.
 *
 * Carved out of hooks/use-studio.ts by PR 15 for one reason: storyboardLogic (a pure Board module,
 * tested without React Native) needs the VALUES, and the hook file imports react-native. The hook
 * file re-exports both consts unchanged, so every existing import still works; the types
 * (`StudioShotSlot`, `StudioShotSpec`) stay where they were. The server's studio/types.ts is the
 * authority; the route refuses a value it does not know.
 */
export const SHOT_SLOT_VALUES = {
  framing: [
    "wide",
    "medium",
    "close",
    "pov",
    "over-the-shoulder",
    "low-angle",
    "high-angle",
    "overhead",
  ],
  movement: [
    "static",
    "push-in",
    "tracking",
    "orbit",
    "pull-out",
    "dolly",
    "crane",
    "pan",
    "tilt",
    "handheld",
    "whip-pan",
  ],
  lighting: [
    "golden-hour",
    "stadium",
    "overcast",
    "warm-lamp",
    "natural",
    "studio",
    "hard-light",
    "soft-light",
    "rim-light",
    "backlight",
    "neon",
    "low-key",
    "high-key",
  ],
  environment: [
    "stadium",
    "training-ground",
    "gym",
    "locker-room",
    "street",
    "studio",
  ],
  composition: [
    "centered",
    "rule-of-thirds",
    "symmetrical",
    "negative-space",
    "foreground-framing",
    "layered-depth",
    "shallow-depth-of-field",
  ],
  motion: [
    "walking",
    "running",
    "turning",
    "jumping",
    "celebrating",
    "interacting-with-product",
    "slow-motion",
    "speed-ramp",
  ],
} as const;

/**
 * The vocabulary as it was before the composer (PR 15, R-2) — what the chips show with
 * EXPO_PUBLIC_STUDIO_COMPOSER off, so the surface is exactly as before. The full lists above are the
 * type; these are the subset offered (storyboardLogic `shotSlotValues`).
 */
export const LEGACY_SHOT_SLOT_VALUES: {
  [K in keyof typeof SHOT_SLOT_VALUES]: readonly (typeof SHOT_SLOT_VALUES)[K][number][];
} = {
  framing: ["wide", "medium", "close"],
  movement: ["static", "push-in", "tracking", "orbit"],
  lighting: ["golden-hour", "stadium", "overcast", "warm-lamp"],
  environment: SHOT_SLOT_VALUES.environment,
  composition: [],
  motion: [],
};
