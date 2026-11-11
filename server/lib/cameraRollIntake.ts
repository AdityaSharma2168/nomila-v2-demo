/**
 * cameraRollIntake — the switch and the knobs for the camera-roll intake (design "Media Intake Plan", 12 Oct 2026,
 * option c; shared/cameraRollIntake.ts has the contract). One flag, CAMERA_ROLL_INTAKE, default OFF: unset, or anything
 * but exactly "true", and "Review my camera roll" behaves exactly as it did (photos only, no carry-over, no cap).
 *
 * On:
 *   • the review takes videos (one phone-made frame each) as well as photos, and every scored item carries a short
 *     description (shot type, setting, what she is doing, quality)
 *   • a targeted review (what a post needs, or words she gave) biases the ranking toward it
 *   • each scored preview is recorded (media_review_items, 0131), so Import carries a ticked photo's tags and embedding
 *     over instead of paying for them twice, and the day's previews are capped
 *   • an imported clip gets its full read (what happens and when, a transcript, quality signals) even where the Studio
 *     clip lane is off
 *   • a clip she picks for a post kit that needed one goes straight into that kit
 *
 * Read per call, never frozen at import.
 */

/** The master switch. Exactly "true" is on. */
export const cameraRollIntakeEnabled = (): boolean => process.env.CAMERA_ROLL_INTAKE === "true";

const num = (raw: string | undefined, fallback: number, lo: number, hi: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
};

export interface IntakeConfig {
  /** Previews one athlete may have scored per UTC day (every scored preview counts, kept or not). */
  dailyPreviews: number;
  /** How much a targeted review's fit moves the rank: rank = (1 − w)·rank + w·fit. */
  fitWeight: number;
  /** Scored-preview rows are deleted this many hours after they are made. */
  purgeAfterHours: number;
  /**
   * The day's clip-read spend for an athlete when the read runs ONLY for intake imports and no
   * STUDIO_ENRICH_DAILY_CAP_USD is set — so the intake can never run the clip read uncapped.
   */
  clipReadDailyUsd: number;
}

export function intakeConfig(): IntakeConfig {
  return {
    dailyPreviews:    Math.round(num(process.env.CAMERA_ROLL_INTAKE_DAILY_PREVIEWS, 600, 1, 10_000)),
    fitWeight:        num(process.env.CAMERA_ROLL_INTAKE_FIT_WEIGHT, 0.4, 0, 1),
    purgeAfterHours:  num(process.env.CAMERA_ROLL_INTAKE_PURGE_HOURS, 48, 1, 24 * 14),
    clipReadDailyUsd: num(process.env.CAMERA_ROLL_INTAKE_CLIP_DAILY_USD, 2, 0, 100),
  };
}

/** Whether a media row came in through a camera-roll review (registerUploadedAsset writes `metadata.review`). */
export const isIntakeRow = (metadata: unknown): boolean =>
  !!metadata && typeof metadata === "object" && !!(metadata as { review?: unknown }).review;
