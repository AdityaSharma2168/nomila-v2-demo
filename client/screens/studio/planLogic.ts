/**
 * planLogic — what the Make it screen is actually telling her.
 *
 * ─── INVENTION AND COST ARE THE SAME QUESTION ──────────────────────────────────────────────────
 * A frame only costs something when a model touches its pixels. So "how much is this" and "is this
 * still me" have the same answer, and the screen says it once rather than twice — a coloured
 * banner about invention floating separately from a number in the footer made them look like two
 * unrelated facts.
 *
 * ─── THREE TIERS, AND ONLY ONE OF THEM IS A WALL ───────────────────────────────────────────────
 *   untouched  her photograph, cropped to fit. Free, and nothing is claimed about it.
 *   fixed      her photograph with something taken out or placed in — a rival mark removed, a
 *              product composited. Still her frame.
 *   invented   pixels that did not exist. This is the one she has to agree to, and the only one
 *              the screen leads with.
 *
 * The distinction is not decoration: a whole-frame relight priced and labelled as an edit is how a
 * generated image ends up presented as a photograph.
 */

import type { FrameTier, PlanFrame } from "../../lib/studio-contract";

export type { FrameTier, PlanFrame };

export function planTotal(frames: PlanFrame[]): number {
  // Fixed to the cent on the way out: summing floats and rendering the raw result is how a plan
  // shows $0.30000000000000004.
  return Math.round(frames.reduce((n, f) => n + f.costUsd, 0) * 100) / 100;
}

export function countTier(frames: PlanFrame[], tier: FrameTier): number {
  return frames.filter((f) => f.tier === tier).length;
}

export interface InventionLine {
  /** How many frames are invented. Zero is the case worth saying out loud. */
  invented: number;
  headline: string;
  detail: string;
}

/**
 * The one row that carries the whole verdict.
 *
 * Nothing invented is not a small result — it is the strongest thing this product can say, so it
 * gets its own sentence rather than being expressed as an absence.
 */
export function inventionLine(
  frames: PlanFrame[],
  opts: { refused?: boolean } = {},
): InventionLine {
  const n = frames.length;
  const invented = countTier(frames, "invented");
  const fixed = countTier(frames, "fixed");
  const total = planTotal(frames);

  // PR 19 (W-6; ADI-R19-W): a plan that cannot run names no price — a figure beside a refusal reads as a charge.
  // ⚠️ MUTATION M-noPrice: drop this branch — "a refused plan names no price" reds by name.
  if (opts.refused && n > 0) {
    return {
      invented,
      headline:
        invented > 0 ? `${invented} of ${n} frames invented` : "Nothing invented",
      detail: "Nothing is priced until this can run.",
    };
  }
  if (n === 0) {
    return { invented: 0, headline: "Nothing to make yet", detail: "Add a frame and the plan fills in." };
  }
  if (invented === 0 && fixed === 0) {
    return {
      invented: 0,
      headline: "Nothing invented · free",
      detail: "Your frames, cut and graded. Tap to see the work.",
    };
  }
  if (invented === 0) {
    return {
      invented: 0,
      headline: `Nothing invented · ${money(total)}`,
      detail: `${fixed} of ${n} ${fixed === 1 ? "frame has" : "frames have"} a fix applied. Still yours.`,
    };
  }
  return {
    invented,
    headline: `${invented} of ${n} frames invented · ${money(total)}`,
    detail: "Tap to see which, and what each one costs.",
  };
}

/**
 * A plan she cannot run: Mila asked instead of pricing, or the check blocked it (PR 19, W-6). A plan still being
 * checked is not refused — nothing on it is true yet.
 */
export function isRefused(plan: {
  canGenerate: boolean;
  askReason?: string | null;
  blockers: readonly string[];
}): boolean {
  return !plan.canGenerate && (!!plan.askReason || plan.blockers.length > 0);
}

/** Make it's one button: what it says, what it does, and whether it can be tapped. */
export interface MakeItCta {
  label: string;
  note: string;
  action: "make" | "back";
  disabled: boolean;
}

/** Said on a refused plan's button (PR 19). ⚠️ PLACEHOLDER WORDING, for the copy-review pile (Mia). */
export const REFUSED_CTA = {
  label: "Back to the thread",
  note: "Nothing to make here — Mila's answer is in the thread.",
} as const;

/**
 * THE BUTTON (PR 19, ADI-R19-W2: "no path can leave her on a disabled Make it"). A refused plan — an ask, or blocked
 * — can never become makeable on this screen, so its button is an enabled way back, never a disabled "Make it" over
 * "Working out what this needs" (which only a plan still being priced may say). Not refused: today's button, exactly.
 * ⚠️ MUTATION M-noDeadEnd: drop the refused branch — "a refused plan's button is never a disabled Make it" reds.
 */
export function makeItCta(
  plan: {
    jobCostUsd: number | null;
    canGenerate: boolean;
    frames: PlanFrame[];
  },
  opts: { refused: boolean; busy: boolean },
): MakeItCta {
  if (opts.refused)
    return { ...REFUSED_CTA, action: "back", disabled: opts.busy };
  const cost = plan.jobCostUsd;
  // No answer yet, or none possible. Claim nothing either way — the button is disabled anyway.
  const text =
    cost === null
      ? { label: "Make it", note: "Working out what this needs." }
      : cost > 0
        ? {
            label: "Approve and make it",
            note: "This is the only button that spends anything.",
          }
        : makeButton(plan.frames);
  return { ...text, action: "make", disabled: !plan.canGenerate || opts.busy };
}

/** Costs are shown to the cent because the ratios are what shape the choice. */
export function money(usd: number): string {
  return usd === 0 ? "free" : `$${usd.toFixed(2)}`;
}

/**
 * What the button says.
 *
 * A free plan must not say "Approve and make it": approving is what you do to a spend, and asking
 * for approval when nothing is being spent teaches her to tap past the one screen that matters.
 */
export function makeButton(frames: PlanFrame[]): { label: string; note: string } {
  return planTotal(frames) > 0
    ? { label: "Approve and make it", note: "This is the only button that spends anything." }
    : { label: "Make it — free", note: "No model touches a pixel, so there is nothing to approve." };
}

/** Timecodes for a cut list, at a fixed clip length. Video bills per second, so this is not cosmetic. */
export function timecodes(count: number, seconds = 8): { at: number; dur: number }[] {
  if (count <= 0) return [];
  const each = seconds / count;
  return Array.from({ length: count }, (_, i) => ({
    at: Math.round(i * each * 10) / 10,
    dur: Math.round(each * 10) / 10,
  }));
}
