import { Bold, Colors } from "../../constants/theme";
import type { Pitch, PitchStatus } from "../../hooks/use-pitches";

// The status vocabulary — one shade, one meaning, everywhere pitches appear. One look (owner, 23 Oct 2026): greys to
// ink as a pitch moves out into the world, never a ring colour (those mean the M.I.A. score).
export const PITCH_STATUS: Record<PitchStatus, { color: string; label: string }> = {
  tailoring: { color: Bold.quiet,         label: "Tailoring" },   // light grey — building
  ready:     { color: "#C5BFB8",          label: "Ready" },       // stone — your move
  sent:      { color: Bold.mute,          label: "Sent" },        // grey — in the world
  opened:    { color: Bold.ink,           label: "Opened" },      // ink — they're looking
  failed:    { color: Colors.light.error, label: "Failed" },      // red — build failed
};

/** Amber "needs refresh" is surfaced for a stale pitch that's already ready/sent (not while tailoring). */
export function isNeedsRefresh(p: Pick<Pitch, "status" | "stale">): boolean {
  return p.stale && (p.status === "ready" || p.status === "sent" || p.status === "opened");
}

/** The one-line status copy shown under a brand name (mirrors the Fable prototype). */
export function pitchStatusLabel(p: Pick<Pitch, "status" | "opensCount" | "stale">): string {
  if (p.status === "opened") return p.opensCount > 1 ? `Opened · ${p.opensCount} opens` : "Opened";
  if (isNeedsRefresh(p)) return "Needs refresh";
  return PITCH_STATUS[p.status].label;
}
