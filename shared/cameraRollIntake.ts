/**
 * shared/cameraRollIntake.ts — the camera-roll intake's contract between the phone and the server (design "Media Intake
 * Plan", 12 Oct 2026, option c), behind CAMERA_ROLL_INTAKE (server) / EXPO_PUBLIC_CAMERA_ROLL_INTAKE (app).
 *
 * The deal with the athlete: the phone makes small previews of what is new on her camera roll (screenshots and items
 * she has already been shown are skipped on the phone), uploads ONLY those previews, and the server scores them while
 * she waits — a content check, an "is it her" check, a short description and a relevance score with a one-line reason.
 * Her best ones come back pre-ticked (a mix of shot types, up to 60). Only what she leaves ticked is uploaded at full
 * size when she taps Import, and the previews are deleted.
 *
 * Types and constants only, no runtime dependencies. Nothing here names an athlete, sport, school or brand.
 */

/** What one preview stands for on her phone. A video's preview is one frame of it, made on the phone. */
export const REVIEW_ITEM_KINDS = ["photo", "video"] as const;
export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];

/** Which items a review looks at. */
export const CAMERA_ROLL_KINDS = ["photos", "videos", "all"] as const;
export type CameraRollKind = (typeof CAMERA_ROLL_KINDS)[number];

/** How far back a review looks: everything new since her last review, or a fixed window. */
export const CAMERA_ROLL_SINCE = ["last_review", "7d", "30d"] as const;
export type CameraRollSince = (typeof CAMERA_ROLL_SINCE)[number];

/** The longest "what I'm looking for" a review takes (it is embedded, never put into a prompt). */
export const LOOKING_FOR_MAX_CHARS = 200;

/** How the preview's picture quality reads, in words (from the tagger's aesthetic_quality). */
export const REVIEW_QUALITIES = ["great", "good", "fair", "poor"] as const;
export type ReviewQuality = (typeof REVIEW_QUALITIES)[number];

/** The short description each scored preview carries: shot type, setting, what she is doing, quality. */
export interface ReviewSummary {
  shotType: string;
  setting: string;
  doing: string;
  quality: ReviewQuality;
}

/**
 * A targeted review: what to look at and what to look for. `forPost` is a post action's id — the server reads what that
 * post needs from the post itself, and the clip she picks can then go straight into that post's kit.
 */
export interface CameraRollAsk {
  kind: CameraRollKind;
  since: CameraRollSince;
  forPost: string | null;
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** An ask as one link id (`videos.7d` or `videos.7d.<post id>`) — what a chat card's link carries. */
export function encodeCameraRollAsk(a: CameraRollAsk): string {
  return [a.kind, a.since, ...(a.forPost && ID_RE.test(a.forPost) ? [a.forPost] : [])].join(".");
}

/** The ask back out of a link id; null for anything that is not one. Never throws. */
export function parseCameraRollAsk(id: string | null | undefined): CameraRollAsk | null {
  const parts = String(id ?? "").split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const [kind, since, forPost] = parts;
  if (!(CAMERA_ROLL_KINDS as readonly string[]).includes(kind)) return null;
  if (!(CAMERA_ROLL_SINCE as readonly string[]).includes(since)) return null;
  if (forPost !== undefined && !ID_RE.test(forPost)) return null;
  return { kind: kind as CameraRollKind, since: since as CameraRollSince, forPost: forPost ?? null };
}

/** The screen name an agent link uses for the review (client/lib/agent/navigate.ts maps it). */
export const CAMERA_ROLL_SCREEN = "camera-roll" as const;
