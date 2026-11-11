/**
 * clipReadLogic — "Read this clip" (PR 9.5, F22 B2), as pure functions.
 *
 * Two surfaces render the affordance — the Agent tray's video rows (AgentScreen.tsx) and MediaDetail —
 * and both read the SAME server state (`read` on a GET /studio/media clip row and on GET /media/:id,
 * server/studio/enrich/readState.ts). What each state renders, what a tap may do, and what a finished
 * or failed read does to her picked-video tray are decided here, where a test holds them without a
 * renderer.
 *
 * The five states, as the card names them: unread · reading · read (N beats) · failed (reason) ·
 * at-cap (reason). Flag off (`STUDIO_CLIP_READ`): nothing renders — the passive hint stays.
 */
import type { PickedVideo } from "./storyboardLogic";

/** `read` as the server serves it (studio/enrich/readState.ts `ClipReadState`). */
export type ClipRead =
  | { state: "unread"; quotedUsd: number }
  | { state: "reading"; quotedUsd: number; startedAt?: string }
  | { state: "done"; beats: number }
  | { state: "failed"; quotedUsd: number; reason: string }
  | { state: "at_cap"; quotedUsd: number; reason: string };

/** What POST /studio/media/:id/read answers. */
export type ClipReadAnswer =
  | { status: "reading"; quotedUsd: number }
  | { status: "done"; beats: number; quotedUsd: number }
  | { status: "already_read"; beats: number }
  | { status: "at_cap"; reason: string; quotedUsd: number }
  | { status: "failed"; reason: string; quotedUsd: number }
  | { status: "not_ready"; reason: string; quotedUsd: number }
  | { status: "not_video"; reason: string };

/** The quote as the button shows it — never below a cent, never "$0.00" for a real read. */
export const formatQuote = (usd: number): string =>
  `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`;

export interface ReadAffordance {
  state: ClipRead["state"];
  /** The pill's text. */
  label: string;
  /** A second line — the reason, when there is one. */
  sub: string | null;
  /** Whether a tap starts (or restarts) a read. */
  tappable: boolean;
}

/**
 * What the pill renders for one clip row, or null for nothing (flag off, not a clip, or the server did
 * not serve a `read` — an older server). ⚠️ MUTATION (clipReadLogic.test): drop the `on` check —
 * "Read this clip renders with STUDIO_CLIP_READ off" reds by name. Drop the `kind` check — "image asset
 * gets a read affordance" reds by name (client half).
 */
export function readAffordance(
  row: { kind: "photo" | "clip"; read?: ClipRead | null },
  on: boolean,
): ReadAffordance | null {
  if (!on) return null;
  if (row.kind !== "clip") return null;
  const r = row.read;
  if (!r) return null;
  switch (r.state) {
    case "unread":
      return {
        state: r.state,
        label: `Read this clip · ${formatQuote(r.quotedUsd)}`,
        sub: null,
        tappable: true,
      };
    case "reading":
      return { state: r.state, label: "Reading…", sub: null, tappable: false };
    case "done":
      return {
        state: r.state,
        label: `Read · ${r.beats} ${r.beats === 1 ? "beat" : "beats"}`,
        sub: null,
        tappable: false,
      };
    case "failed":
      return {
        state: r.state,
        label: `Read failed · try again · ${formatQuote(r.quotedUsd)}`,
        sub: r.reason,
        tappable: true,
      };
    case "at_cap":
      return {
        state: r.state,
        label: "At today's reading limit",
        sub: r.reason,
        tappable: false,
      };
  }
}

/** The route's answer folded onto the row's `read` — what the pill shows the moment the tap answers. */
export function readOfAnswer(a: ClipReadAnswer, quotedUsd: number): ClipRead {
  switch (a.status) {
    case "reading":
      return { state: "reading", quotedUsd: a.quotedUsd };
    case "done":
    case "already_read":
      return { state: "done", beats: a.beats };
    case "at_cap":
      return { state: "at_cap", quotedUsd: a.quotedUsd, reason: a.reason };
    case "failed":
    case "not_ready":
      return { state: "failed", quotedUsd: a.quotedUsd, reason: a.reason };
    case "not_video":
      return { state: "failed", quotedUsd, reason: a.reason };
  }
}

// ─── Her picked videos on the Agent tray ────────────────────────────────────────────────────────

/**
 * A picked video as the tray holds it: with beats, CUT by default; without, as-is at the end — there
 * is nothing to cut. ⚠️ MUTATION (clipReadLogic.test): make `cut` true regardless — "unread clip cut
 * without a read" reds by name.
 */
export const pickVideo = (r: {
  assetId: string;
  posterUrl: string | null;
  beats: number;
  read?: ClipRead | null;
}): PickedVideo => ({
  assetId: r.assetId,
  posterUrl: r.posterUrl,
  beats: r.beats,
  cut: r.beats > 0,
  read: r.read ?? null,
});

/** Her cut / as-is choice — honoured only on a video WITH beats; a video without stays as-is. */
export const setCutOn = (
  videos: readonly PickedVideo[],
  assetId: string,
  cut: boolean,
): PickedVideo[] =>
  videos.map((v) =>
    v.assetId === assetId ? { ...v, cut: cut && v.beats > 0 } : v,
  );

/**
 * A read finished: the tray's beat count and "Cut it · N beats" update in place, cut by default —
 * no re-plan, no re-pick (B3's client half). A read that found no beats stays as-is.
 */
export const readDone = (
  videos: readonly PickedVideo[],
  assetId: string,
  beats: number,
): PickedVideo[] =>
  videos.map((v) =>
    v.assetId === assetId
      ? { ...v, beats, cut: beats > 0, read: { state: "done", beats } }
      : v,
  );

/**
 * A read did not finish (failed, at cap, not ready): the video STAYS on the tray, as-is at the end,
 * and the plan is not blocked (R-1). ⚠️ MUTATION (clipReadLogic.test): drop the video from the tray
 * here — "read failure blocks the plan" reds by name.
 */
export const readNotDone = (
  videos: readonly PickedVideo[],
  assetId: string,
  read: ClipRead,
): PickedVideo[] =>
  videos.map((v) => (v.assetId === assetId ? { ...v, cut: false, read } : v));

/** The row's `read` while a poll runs — keeps the pill honest between answers. */
export const withRead = (
  videos: readonly PickedVideo[],
  assetId: string,
  read: ClipRead,
): PickedVideo[] =>
  videos.map((v) => (v.assetId === assetId ? { ...v, read } : v));
