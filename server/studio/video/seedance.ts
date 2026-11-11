/**
 * seedance.ts — the b-roll prompt in Seedance's own dialect (quality-scrappy piece 1, docs/probes/quality-scrappy.md,
 * ADI-QS-GO). Behind STUDIO_DIALECTS (opt-in), and only for a clip whose target model is written in this dialect
 * (compile/targets/manifest.ts `dialectFor`) — with the flag off every b-roll prompt is today's template, byte for
 * byte (prompts.golden.json holds).
 *
 * ─── ⚠️  THE STRUCTURE IS SECOND-HAND, AND SAID SO HERE AS WELL AS IN THE LEDGER ───────────────────────
 *
 * The official guide is BytePlus ModelArk doc 2222480 ("Dreamina Seedance 2.0 series prompt guide"; Volcengine
 * 82379/2222480). It would not load on 2026-09-28 — three tries, both hosts render client-side and returned nothing
 * readable. What this follows is a SECONDARY reading of that guide (help.apiyi.com, "Seedance 2.0 Official Prompt
 * Guide In-depth Interpretation"), so every step below is second-hand:
 *
 *   1 Subject · 2 Action · 3 Environment · 4 Camera · 5 Style · 6 Constraints
 *   "use only one primary camera instruction" · "60–100 words" · avoid statements belong in the prompt
 *
 * So the emitter is CONSERVATIVE, per the ruling: the six steps in that order, exactly one camera sentence, a closing
 * `Avoid:` clause, and nothing invented beyond the phrases the shared template already uses. Re-read the official page
 * before growing it.
 *
 * ─── WHY AN AVOID CLAUSE, WHEN THE SHARED TEMPLATE LEARNED TO SAY WHAT IT WANTS ────────────────────────
 *
 * The shared b-roll template rewrote its emptiness line as a positive ("the place is deserted") because naming a
 * thing can summon it. Seedance's guide asks for the constraints to be stated, and the model has NO negative-prompt
 * parameter (manifest: `allowed_passthrough_parameters` are watermark and req_key only) — so an avoid list can only
 * travel as prose, and the guide puts it last. Both are kept: the Environment step says the place is empty, and the
 * Constraints step says what to keep out. Which of the two phrasings serves Seedance better is what S-1 measures.
 *
 * ─── WHAT IT DOES NOT TOUCH ────────────────────────────────────────────────────────────────────────────
 *
 * Her sentence stays one opaque block, fenced exactly as the shared template fences it (`direction`, built by
 * prompts.ts) — nothing here reads it, so Subject and Action inside it stay in whatever order she wrote them. What the
 * dialect orders is OUR lines around it. The campaign carrier rides unchanged, as fenced data. `generate_audio`
 * is not this file's: the wire's audio flag is set from the brief (preview.ts `providerParams`, adapters/openrouter.ts
 * `seedanceAudio`), and this only asks for a sound when the brief paid for one.
 *
 * ⚠️ MUTATION (seedance.test.ts): drop the closing Avoid clause — "ends with one Avoid clause" reds by name.
 */

/** The phrases a Seedance b-roll prompt is built from — each one already rendered by video/prompts.ts's tables. */
export interface SeedanceBrollParts {
  /** Her direction, exactly as the shared template renders it: "DIRECTION: …", or the fenced inbound block. */
  direction: string;
  /** The campaign carrier block(s), fenced data, or []. */
  carrier: readonly string[];
  /** The action slot's sentence, or null. */
  motion: string | null;
  /** The setting slot's phrase ("a stadium"), or null. */
  environment: string | null;
  /** The framing slot's sentence, or null. */
  framing: string | null;
  /** The movement slot's sentence, or null — the ONE camera move. */
  movement: string | null;
  /** The lighting slot's phrase ("soft, even overcast daylight"), or null. */
  lighting: string | null;
  /** The composition slot's sentence, or null. */
  composition: string | null;
  /** True when the brief paid for sound (`brief.job.audio`). */
  sound: boolean;
  /** Extra things to keep out, from a corrective re-quote (studio/outputGate.ts) — [] on a first run. */
  avoidExtra?: readonly string[];
}

/** Step 1. The place is the subject; nobody is. */
export const SEEDANCE_SUBJECT =
  "A single continuous live-action shot of a deserted place. The place itself is the subject.";

/** Step 4's default when no movement is set: ONE named move, where the shared template says "a camera move at most". */
export const SEEDANCE_DEFAULT_MOVE = "A slow, steady push-in.";

/**
 * Step 6. What the shared template's BROLL_EMPTINESS and OUTPUT_DISCIPLINE say, as one list: nobody in it, no
 * lettering, and never a screen or an app around the scene.
 */
export const SEEDANCE_AVOID = [
  "people",
  "faces",
  "crowds",
  "readable text",
  "signage",
  "sponsor boards",
  "logos",
  "phone or laptop screens",
  "app interfaces",
  "usernames",
  "captions",
  "cuts",
] as const;

/** When sound was paid for: the scene's own sound, and never a voice or a second music under the bed. */
const SOUND_LINE = "Sound: the natural ambient sound of this place.";
const SOUND_AVOID = ["speech", "music"] as const;

/**
 * The six steps as NAMED pieces — what the literal joins below and what a published template (templates/render.ts,
 * `studio.video.broll-seedance`) arranges. `extraAvoid` is a published template's own `meta.avoid`.
 */
export function seedanceSteps(
  p: SeedanceBrollParts,
  extraAvoid: readonly string[] = [],
): {
  subject: string;
  direction: string;
  carrier: string;
  environment: string;
  camera: string;
  style: string;
  sound: string;
  avoid: string;
} {
  return {
    // 1 · Subject
    subject: SEEDANCE_SUBJECT,
    // 2 · Action — her sentence (opaque, fenced when inbound), then the action chip's sentence if she set one.
    direction: p.motion ? `${p.direction}\n${p.motion}` : p.direction,
    // The campaign rides beside her direction, as the shared template carries it: fenced data, never instruction.
    carrier: p.carrier.join("\n\n"),
    // 3 · Environment
    environment: p.environment
      ? `The setting is ${p.environment}, empty of people from the first frame to the last.`
      : "The setting is empty of people from the first frame to the last.",
    // 4 · Camera — exactly one move, the framing beside it, one take.
    camera: [
      p.framing,
      p.movement ?? SEEDANCE_DEFAULT_MOVE,
      "One continuous take.",
    ]
      .filter((s): s is string => !!s)
      .join(" "),
    // 5 · Style
    style: [
      `Photorealistic live action, ${p.lighting ? `lit by ${p.lighting}` : "natural light"}.`,
      p.composition,
    ]
      .filter((s): s is string => !!s)
      .join(" "),
    sound: p.sound ? SOUND_LINE : "",
    // 6 · Constraints — last, as the guide orders them.
    avoid: `Avoid: ${[
      ...SEEDANCE_AVOID,
      ...(p.sound ? SOUND_AVOID : []),
      ...(p.avoidExtra ?? []),
      ...extraAvoid,
    ].join(", ")}.`,
  };
}

/** The Seedance b-roll prompt: six steps, one camera move, one closing Avoid clause. */
export function seedanceBroll(p: SeedanceBrollParts): string {
  const s = seedanceSteps(p);
  return [
    s.subject,
    s.direction,
    ...(s.carrier ? [s.carrier] : []),
    s.environment,
    s.camera,
    s.style,
    ...(s.sound ? [s.sound] : []),
    s.avoid,
  ].join("\n\n");
}
