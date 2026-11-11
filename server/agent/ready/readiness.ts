/**
 * agent/ready/readiness.ts — the ONE test of whether a post kit is "ready for you" (pure: no database, no imports of the
 * post-kit services), shared by the queue (queue.ts), "Post it" (rights.ts) and the learning loop's auto-mark
 * (learning/job.ts), so the three can never disagree:
 *
 *   ready = a post action (kind action, detail.kind post) still open (response pending), state made, with a built kit
 *           that has media, needs no generated media, PASSED the final guard (kit.guard), and is not resting after
 *           ⋯ Not now (detail.cardTap not_now with `until` still ahead).
 */

export interface ReadinessRow {
  kind?: string | null;
  response: string;
  detail?: Record<string, unknown> | null;
}

/** ⋯ Not now on a made post (milaCards/outcomes.ts, card "content"): rested until `until` (ISO), else null. */
export function restingUntil(detail: Record<string, unknown> | null | undefined): string | null {
  const tap = (detail?.cardTap ?? null) as { state?: unknown; until?: unknown } | null;
  return tap?.state === "not_now" && typeof tap.until === "string" ? tap.until : null;
}

export function isResting(detail: Record<string, unknown> | null | undefined, now: Date): boolean {
  const until = restingUntil(detail);
  return !!until && Date.parse(until) > now.getTime();
}

/** The kit's own readiness, whatever the row's answer: built, with media, no generation needed, guarded. */
export function kitIsReady(detail: Record<string, unknown> | null | undefined): boolean {
  const det = (detail ?? {}) as { kind?: unknown; state?: unknown; prepared?: { postKit?: any } | null };
  if (det.kind !== "post") return false;
  if ((det.state ?? "to_start") !== "made") return false;
  const kit = det.prepared?.postKit;
  if (!kit || !Array.isArray(kit.assets) || !kit.assets.length) return false;
  if (kit.aiGenerationNeeded?.value) return false;
  return !!kit.guard;
}

/** Ready for you: open, a ready kit, not resting. */
export function isReadyRow(d: ReadinessRow, now: Date): boolean {
  return (d.kind ?? "other") === "action" && d.response === "pending" && kitIsReady(d.detail) && !isResting(d.detail, now);
}
