/**
 * studio/agent/capabilities — the closed vocabulary a plan item may ask for.
 *
 * Mia's architecture doc, §8 "Creative Capability Library": the agent needs a controlled vocabulary
 * of things it can request, represented as structured objects, not strings. This is that vocabulary
 * for the four axes the C2 brief names — camera (shot), camera movement, lighting, composition —
 * plus motion, which §8 lists beside them. The members are §8's, verbatim, in snake_case.
 * Environment and the commercial styles are §8's too and are deliberately NOT here: outside the
 * brief's four axes, and the doctrine PR's to add if it wants them.
 *
 * ─── A VALUE OUTSIDE THE LISTS IS NULLED, AND EVERY NULL IS LOGGED (Adi, 22 Sep 2026) ────────────
 *
 * An invented KIND refuses the whole plan (studio/agent/plan.ts): the kind decides what money is
 * spent. An adjective does not — it colours a direction — so a value outside its list is dropped to
 * null rather than killing the plan. But never silently: `parseCapabilities` hands back every
 * dropped value with the axis and the string the model wrote, and derivePlan logs each one under
 * the code `capability_outside_vocabulary`. The plan eval needs the rate: a planner that steps
 * outside the lists often is a doctrine finding, and a quiet null would hide it.
 *
 * ─── WHERE A VALUE GOES AFTER THE PARSE ─────────────────────────────────────────────────────────
 *
 * The Board's own closed vocabulary is `ShotSpec` (studio/types.ts: framing · movement · lighting ·
 * environment), compiled to prose by studio/video/prompts.ts, which also decides which slots each
 * source kind may carry. `toShotSpec` maps a capability onto a Board slot ONLY where a member of the
 * same meaning exists there — `wide` → framing `wide`, `push_in` → movement `push-in`,
 * `golden_hour` → lighting `golden-hour`. Everything else — a low angle, a rim light, a rule of
 * thirds — has no slot, so it travels as prose on the item's direction (`capabilityProse`), which
 * is where freeform camera language lived before this existed. No slot is invented here: adding one
 * to `ShotSpec` is a change to the compiler and its refusals, and that is the doctrine PR's.
 *
 * ─── THE BEATS' FREEFORM STAYS FREEFORM ─────────────────────────────────────────────────────────
 *
 * Half A's clip tagger writes `camera` and `motion` on every beat as free text. Closing those in
 * the tagger would mean re-reading every clip ($0.62 on the measured library, and more on every
 * one after). So the beat keeps its words, and `nearestCapability` folds them onto the vocabulary
 * DETERMINISTICALLY at library-assembly time — a token match against the members and a short alias
 * table, or null. No model, no spend, and the same answer every time.
 */
import type { ShotSpec } from "../types";
import { composerEnabled } from "../config";

export const CAPABILITY_LISTS = {
  camera: [
    "wide",
    "medium_wide",
    "medium",
    "close_up",
    "extreme_close_up",
    "macro",
    "pov",
    "over_the_shoulder",
    "low_angle",
    "high_angle",
    "overhead",
  ],
  movement: [
    "static",
    "push_in",
    "pull_out",
    "dolly",
    "tracking",
    "orbit",
    "crane",
    "pan",
    "tilt",
    "handheld",
    "whip_pan",
  ],
  lighting: [
    "natural",
    "golden_hour",
    "studio",
    "hard_light",
    "soft_light",
    "rim_light",
    "backlight",
    "neon",
    "stadium",
    "low_key",
    "high_key",
  ],
  composition: [
    "centered",
    "rule_of_thirds",
    "symmetrical",
    "negative_space",
    "foreground_framing",
    "layered_depth",
    "shallow_depth_of_field",
  ],
  motion: [
    "walking",
    "running",
    "turning",
    "jumping",
    "celebrating",
    "interacting_with_product",
    "slow_motion",
    "speed_ramp",
  ],
} as const;

export type CapabilityAxis = keyof typeof CAPABILITY_LISTS;
export const CAPABILITY_AXES = Object.keys(
  CAPABILITY_LISTS,
) as CapabilityAxis[];

export type Capabilities = {
  [A in CapabilityAxis]?: (typeof CAPABILITY_LISTS)[A][number];
};

/** One value the model wrote that is not in its list. Logged by name; never stored. */
export interface NulledCapability {
  axis: CapabilityAxis;
  /** What the model wrote, capped — the string the eval counts. */
  value: string;
}

/** THE CODE the log line carries for a value outside the vocabulary. One code, greppable. */
export const CAPABILITY_OUTSIDE_VOCABULARY = "capability_outside_vocabulary";

const isMember = <A extends CapabilityAxis>(
  axis: A,
  v: string,
): v is (typeof CAPABILITY_LISTS)[A][number] =>
  (CAPABILITY_LISTS[axis] as readonly string[]).includes(v);

/**
 * A model's `capabilities` object into the closed shape. Missing or non-object → undefined and
 * nothing nulled. Unknown axes are dropped (a model adds keys). A value that is not a member of its
 * axis is nulled and reported; a value that is not a string is nulled and reported as its type.
 */
export function parseCapabilities(raw: unknown): {
  capabilities: Capabilities | undefined;
  nulled: NulledCapability[];
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { capabilities: undefined, nulled: [] };
  }
  const out: Record<string, string> = {};
  const nulled: NulledCapability[] = [];
  for (const axis of CAPABILITY_AXES) {
    const v = (raw as Record<string, unknown>)[axis];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && isMember(axis, v)) {
      out[axis] = v;
    } else {
      nulled.push({
        axis,
        value: (typeof v === "string" ? v : `<${typeof v}>`).slice(0, 80),
      });
    }
  }
  return {
    capabilities: Object.keys(out).length ? (out as Capabilities) : undefined,
    nulled,
  };
}

// ─── Onto the Board's slots ─────────────────────────────────────────────────────────────────────
//
// Two sets of tables. The LEGACY ones are what shipped before the composer (PR 15): a member maps
// only where a slot of the same meaning already existed, and the rest rides as prose. The COMPOSER
// ones are complete — every member of camera, movement and lighting has a slot (studio/types.ts grew
// for it), and composition and motion have slots of their own — so nothing rides as prose. Which set
// applies is STUDIO_COMPOSER's; with it off the legacy tables are the ones read, byte for byte.

type CameraMember = (typeof CAPABILITY_LISTS)["camera"][number];
type MovementMember = (typeof CAPABILITY_LISTS)["movement"][number];
type LightingMember = (typeof CAPABILITY_LISTS)["lighting"][number];
type CompositionMember = (typeof CAPABILITY_LISTS)["composition"][number];
type MotionMember = (typeof CAPABILITY_LISTS)["motion"][number];

const LEGACY_FRAMING_OF: Partial<Record<CameraMember, ShotSpec["framing"]>> = {
  wide: "wide",
  medium_wide: "medium",
  medium: "medium",
  close_up: "close",
  extreme_close_up: "close",
  macro: "close",
};
const LEGACY_MOVEMENT_OF: Partial<
  Record<MovementMember, ShotSpec["movement"]>
> = {
  static: "static",
  push_in: "push-in",
  tracking: "tracking",
  orbit: "orbit",
};
const LEGACY_LIGHTING_OF: Partial<
  Record<LightingMember, ShotSpec["lighting"]>
> = {
  golden_hour: "golden-hour",
  stadium: "stadium",
};

/** Complete — `Record`, not `Partial`: a member left out does not compile. */
const FRAMING_OF: Record<CameraMember, NonNullable<ShotSpec["framing"]>> = {
  ...(LEGACY_FRAMING_OF as Record<
    keyof typeof LEGACY_FRAMING_OF,
    NonNullable<ShotSpec["framing"]>
  >),
  pov: "pov",
  over_the_shoulder: "over-the-shoulder",
  low_angle: "low-angle",
  high_angle: "high-angle",
  overhead: "overhead",
};
const MOVEMENT_OF: Record<MovementMember, NonNullable<ShotSpec["movement"]>> = {
  ...(LEGACY_MOVEMENT_OF as Record<
    keyof typeof LEGACY_MOVEMENT_OF,
    NonNullable<ShotSpec["movement"]>
  >),
  pull_out: "pull-out",
  dolly: "dolly",
  crane: "crane",
  pan: "pan",
  tilt: "tilt",
  handheld: "handheld",
  whip_pan: "whip-pan",
};
const LIGHTING_OF: Record<LightingMember, NonNullable<ShotSpec["lighting"]>> = {
  ...(LEGACY_LIGHTING_OF as Record<
    keyof typeof LEGACY_LIGHTING_OF,
    NonNullable<ShotSpec["lighting"]>
  >),
  natural: "natural",
  studio: "studio",
  hard_light: "hard-light",
  soft_light: "soft-light",
  rim_light: "rim-light",
  backlight: "backlight",
  neon: "neon",
  low_key: "low-key",
  high_key: "high-key",
};
const COMPOSITION_OF: Record<
  CompositionMember,
  NonNullable<ShotSpec["composition"]>
> = {
  centered: "centered",
  rule_of_thirds: "rule-of-thirds",
  symmetrical: "symmetrical",
  negative_space: "negative-space",
  foreground_framing: "foreground-framing",
  layered_depth: "layered-depth",
  shallow_depth_of_field: "shallow-depth-of-field",
};
const MOTION_OF: Record<MotionMember, NonNullable<ShotSpec["motion"]>> = {
  walking: "walking",
  running: "running",
  turning: "turning",
  jumping: "jumping",
  celebrating: "celebrating",
  interacting_with_product: "interacting-with-product",
  slow_motion: "slow-motion",
  speed_ramp: "speed-ramp",
};

/**
 * The Board slots these capabilities fill. With the composer on, every set value fills one; off,
 * only those with a member of the same meaning in the original vocabulary. The caller (the Board,
 * on seeding) still filters by what the row's source kind may carry (storyboardLogic
 * `slotsAllowed`, mirroring prompts.ts `slotRefusal`): a photo row keeps movement only. Undefined
 * when nothing maps.
 */
export function toShotSpec(
  caps: Capabilities | undefined,
  composer: boolean = composerEnabled(),
): ShotSpec | undefined {
  if (!caps) return undefined;
  const out: ShotSpec = {};
  const framing = caps.camera
    ? (composer ? FRAMING_OF : LEGACY_FRAMING_OF)[caps.camera]
    : undefined;
  const movement = caps.movement
    ? (composer ? MOVEMENT_OF : LEGACY_MOVEMENT_OF)[caps.movement]
    : undefined;
  const lighting = caps.lighting
    ? (composer ? LIGHTING_OF : LEGACY_LIGHTING_OF)[caps.lighting]
    : undefined;
  if (framing) out.framing = framing;
  if (movement) out.movement = movement;
  if (lighting) out.lighting = lighting;
  if (composer && caps.composition)
    out.composition = COMPOSITION_OF[caps.composition];
  if (composer && caps.motion) out.motion = MOTION_OF[caps.motion];
  return Object.keys(out).length ? out : undefined;
}

/** A member as words: `over_the_shoulder` → "over the shoulder". */
export const capabilityWords = (v: string): string => v.replace(/_/g, " ");

const AXIS_LABEL: Record<CapabilityAxis, string> = {
  camera: "Camera",
  movement: "Camera movement",
  lighting: "Light",
  composition: "Composition",
  motion: "Motion",
};

/**
 * The values that have NO Board slot, as one short clause for the direction — or "" when every set
 * value mapped (or none was set). The direction is where freeform camera language lived before the
 * vocabulary existed, so this is the same place, in closed words.
 *
 * ⚠️ WITH THE COMPOSER ON THIS IS ALWAYS "" (PR 15, R-2): every member has a slot, so nothing is left
 * to ride as prose, and a value the row cannot carry is dropped by the Board BY NAME
 * (storyboardLogic `droppedSlots`) rather than smuggled into the prompt past `slotRefusal`. The
 * function stays for the flag-off path only; it is deleted when the flag is. ⚠️ MUTATION
 * (capabilities.test): return the clause with the composer on — "composition capability leaks as
 * prose" reds by name.
 */
export function capabilityProse(
  caps: Capabilities | undefined,
  composer: boolean = composerEnabled(),
): string {
  if (!caps || composer) return "";
  const slotted = toShotSpec(caps, false);
  const parts: string[] = [];
  for (const axis of CAPABILITY_AXES) {
    const v = caps[axis];
    if (!v) continue;
    const mapped =
      (axis === "camera" && slotted?.framing !== undefined) ||
      (axis === "movement" && slotted?.movement !== undefined) ||
      (axis === "lighting" && slotted?.lighting !== undefined);
    if (mapped) continue;
    parts.push(`${AXIS_LABEL[axis]}: ${capabilityWords(v)}.`);
  }
  return parts.join(" ");
}

// ─── Freeform → nearest member, deterministically ───────────────────────────────────────────────

/** Phrases the clip tagger tends to write, folded onto a member. Exact tokens beat these. */
const ALIASES: Record<CapabilityAxis, Record<string, string>> = {
  camera: {
    "close up": "close_up",
    closeup: "close_up",
    "extreme close up": "extreme_close_up",
    "medium wide": "medium_wide",
    "mid shot": "medium",
    "medium shot": "medium",
    "wide shot": "wide",
    "point of view": "pov",
    "over the shoulder": "over_the_shoulder",
    "low angle": "low_angle",
    "high angle": "high_angle",
    "top down": "overhead",
    "bird's eye": "overhead",
    "birds eye": "overhead",
  },
  movement: {
    "push in": "push_in",
    "pushes in": "push_in",
    "slow push": "push_in",
    "pull out": "pull_out",
    "pulls out": "pull_out",
    "pull back": "pull_out",
    tracks: "tracking",
    "tracking shot": "tracking",
    follows: "tracking",
    orbits: "orbit",
    arc: "orbit",
    pans: "pan",
    tilts: "tilt",
    "hand held": "handheld",
    "whip pan": "whip_pan",
    locked: "static",
    "locked off": "static",
    still: "static",
    steady: "static",
  },
  lighting: {
    "golden hour": "golden_hour",
    sunset: "golden_hour",
    sunrise: "golden_hour",
    daylight: "natural",
    sunlight: "natural",
    "hard light": "hard_light",
    harsh: "hard_light",
    "soft light": "soft_light",
    diffused: "soft_light",
    "rim light": "rim_light",
    backlit: "backlight",
    floodlights: "stadium",
    floodlit: "stadium",
    "low key": "low_key",
    "high key": "high_key",
    moody: "low_key",
  },
  composition: {
    centred: "centered",
    "rule of thirds": "rule_of_thirds",
    thirds: "rule_of_thirds",
    symmetric: "symmetrical",
    "negative space": "negative_space",
    "foreground framing": "foreground_framing",
    "layered depth": "layered_depth",
    "shallow depth of field": "shallow_depth_of_field",
    "shallow focus": "shallow_depth_of_field",
    bokeh: "shallow_depth_of_field",
  },
  motion: {
    walks: "walking",
    walk: "walking",
    runs: "running",
    run: "running",
    sprints: "running",
    sprint: "running",
    sprinting: "running",
    jogging: "running",
    jogs: "running",
    turns: "turning",
    turn: "turning",
    jumps: "jumping",
    jump: "jumping",
    leaps: "jumping",
    celebrates: "celebrating",
    celebration: "celebrating",
    "with the product": "interacting_with_product",
    "holds the product": "interacting_with_product",
    "slow motion": "slow_motion",
    "slow mo": "slow_motion",
    slomo: "slow_motion",
    "speed ramp": "speed_ramp",
  },
};

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The member a freeform phrase means, or null. Deterministic: a member spelled as words wins
 * first (`"push in"`), then an alias, longest alias first so "extreme close up" beats "close up".
 * No model. A phrase that names nothing in the list is null, never guessed.
 */
export function nearestCapability<A extends CapabilityAxis>(
  axis: A,
  freeform: string | null | undefined,
): (typeof CAPABILITY_LISTS)[A][number] | null {
  if (!freeform) return null;
  const text = ` ${normalise(freeform)} `;
  if (!text.trim()) return null;
  const members = CAPABILITY_LISTS[axis] as readonly string[];
  // Longest member first, so "extreme close up" is not read as "close up".
  const byLength = [...members].sort((a, b) => b.length - a.length);
  for (const m of byLength) {
    if (text.includes(` ${capabilityWords(m)} `))
      return m as (typeof CAPABILITY_LISTS)[A][number];
  }
  const aliases = Object.entries(ALIASES[axis]).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [phrase, member] of aliases) {
    if (text.includes(` ${phrase} `))
      return member as (typeof CAPABILITY_LISTS)[A][number];
  }
  return null;
}
