/**
 * studio/interpret/eligibility — WHICH asks the interpreter may take, when it may run at all, and which
 * menu kinds are open (the interpreter, I.4; plan v1 A4, re-confirmed against main 7bbe608).
 *
 * ─── EVERY CODE `route()` CAN ASK WITH, DECIDED — AND A NEW ONE IS A COMPILE ERROR ────────────────────
 *
 * `ASK_DECISIONS` is a Record over every code: the fall-through's (classify.ts, `DeclineReason`), the
 * guards' (`validate`), and `route`'s own. A code added to the classifier without a decision here does
 * not build — the golden coverage pin's lesson, applied at the type level.
 *
 *   interpret   the rules could not READ her sentence, and a paraphrase into their grammar might:
 *               fast_path_declined, compound_partial, conditional, brand_change, brand_removal,
 *               add_unclear — v1's six — and, since PR M3, worn_add_unclear: a worn add she described
 *               with a word the rule does not read ("small gold hoops"), which M3's PR body defers to the
 *               interpreter.
 *   never       the rules read her sentence and REFUSED it, or she already said it their way:
 *               person_target, person_mentioned (her body — no rephrasing changes that);
 *               object_photo_missing (she pointed at a photo that is not there — a model cannot attach
 *               it); too_many_changes, compound_conflict (what she asked cannot all happen at once);
 *               generate_not_permitted, no_steps (the two low_confidence codes were deleted with K8); and, since
 *               PR T, headline_bounds — she typed rule ⅛'s exact shape and her WORDS broke its bounds; the
 *               only fix is different words, which would replace hers. And, since the style vocabulary,
 *               look_unknown — she named a look we do not have ("a dreamy vibe"). A look is hers only
 *               when her own words name it (M6), and hers is not on the menu, so a reply could only
 *               decline; the ask she already gets is the honest one. And, since the preservation fixes,
 *               keep_conflict — she kept a thing her change would alter ("make it warmer but keep the
 *               background the same"); a paraphrase has no way yet to carry a keep of a thing (D7, ledger F-L7).
 *
 * Not codes at all, and so not here: `add_onto_body` (gone since PR M3 — nothing produces it) and
 * `text_off_native` (a FREEZE refusal on a box she drew or the flag-off arm — the interpreter never runs on
 * either, below).
 *
 * ─── WHEN IT RUNS AT ALL ─────────────────────────────────────────────────────────────────────────────
 *
 * STUDIO_INTERPRETER on (I.5), STUDIO_NATIVE_EDIT on (C only means anything as a native intent), an edit
 * with a frame, no box she drew (explicit spatial intent routes masked, permanently), her own typed words
 * (never an inbound brand ask), and a sentence within detection's own bound. Then `route(S)` must ask with
 * an `interpret` code.
 */
import { MAX_INSTRUCTION_CHARS } from "../autoMask";
import type { DeclineReason, Routed } from "../classify";
import { displayTextEnabled } from "../config";
import type { MenuSwitches } from "./core";

/** Every code a route can ask with: the fall-through's, the guards', and route's own. */
export type AskCode =
  | DeclineReason
  | "person_target"
  | "generate_not_permitted"
  | "no_steps"
  | "object_photo_missing"
  | "keep_conflict"
  // PR 19 (B): she pointed at a picture's look and no Style reference is attached.
  | "style_reference_missing";

/** THE DECISION FOR EVERY CODE — see the module header. A Record, so a new code does not build without one. */
export const ASK_DECISIONS: Readonly<Record<AskCode, "interpret" | "never">> = {
  fast_path_declined: "interpret",
  compound_partial: "interpret",
  conditional: "interpret",
  brand_change: "interpret",
  brand_removal: "interpret",
  add_unclear: "interpret",
  worn_add_unclear: "interpret",
  person_target: "never",
  person_mentioned: "never",
  object_photo_missing: "never",
  too_many_changes: "never",
  compound_conflict: "never",
  generate_not_permitted: "never",
  no_steps: "never",
  headline_bounds: "never",
  look_unknown: "never",
  keep_conflict: "never",
  // PR 19 (R-6): the ask IS the answer — its op chips name what "better" could mean; no model call ($0).
  vague: "never",
  // PR 19 (B): a model cannot attach the picture she pointed at.
  style_reference_missing: "never",
  // W-5: "change the angle" — its chips are the answer; no model call.
  angle_unclear: "never",
};

/** Is this a code the interpreter may take? An unknown code is not. */
export function interpretableAsk(reason: string | undefined): boolean {
  return (
    !!reason &&
    Object.hasOwn(ASK_DECISIONS, reason) &&
    ASK_DECISIONS[reason as AskCode] === "interpret"
  );
}

/** Everything the decision reads — the request's facts, the flags, and what `route(S)` answered. */
export interface EligibilityInput {
  /** STUDIO_INTERPRETER. */
  enabled: boolean;
  /** STUDIO_NATIVE_EDIT. */
  nativeEdit: boolean;
  /** An edit, with a frame to edit. */
  hasFrame: boolean;
  /** She drew the regions herself. */
  drawn: boolean;
  /** Her typed words ("system") — never a brand's inbound ask. */
  origin: "system" | "inbound";
  sentence: string;
  /** `route(S, true, attached)`. */
  routed: Routed;
}

/**
 * May the interpreter take this request? Deterministic, free, and the same answer on every door that
 * asks: the preview route runs it, and `/studio/classify` reports it as `interpretable` (where no box can
 * have been drawn yet, and the origin is always hers).
 */
export function interpretable(e: EligibilityInput): boolean {
  return (
    e.enabled &&
    e.nativeEdit &&
    e.hasFrame &&
    !e.drawn &&
    e.origin === "system" &&
    !!e.sentence.trim() &&
    e.sentence.trim().length <= MAX_INSTRUCTION_CHARS &&
    e.routed.initialPath === "ASK" &&
    interpretableAsk(e.routed.reason)
  );
}

/**
 * THE EXCLUSION IS CLEARED (M4's engineering gate): R2, n=2 on the Q1 frame — no Nike mark left anywhere,
 * the socks and the cleats included, the swaps landed (docs/probes/sweep-4-ledger.md, F-E; Adi's verdicts,
 * 2026-09-14). Had R2 failed this would be false, and every exclusion clause would ask until it was fixed.
 * A code constant, not a flag: it records a measurement, and a flag defaulting either way would not.
 */
export const EXCLUSION_CLEARED = true;

/**
 * The menu kinds open for a call, read at call time: a headline only behind STUDIO_DISPLAY_TEXT — the
 * same switch route() reads, so the menu and the classifier can never disagree (R1's first run did, in a
 * script) — and the exclusion as R2 left it.
 */
export function interpreterMenu(): MenuSwitches {
  return { text: displayTextEnabled(), exclusion: EXCLUSION_CLEARED };
}
