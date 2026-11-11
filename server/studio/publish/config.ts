/**
 * studio/publish/config — the one switch, and the few numbers around it.
 *
 * ─── STUDIO_PUBLISH_MODE = off | dry | live. ONE VARIABLE, DEFAULT off ──────────────────────────
 *
 * One variable with three values, not an enable flag beside a dry-run flag: two flags can disagree
 * ("enabled, and dry-run unset") and the disagreement resolves to a real post. One variable has no
 * state that means two things.
 *
 *   off    the route refuses, the client shows no pill, and the runner posts NOTHING — a job that
 *          was queued before the switch went off is failed, not drained. Unlike a paid video clip
 *          there is nothing here she has already been charged for; the safe state of an unposted
 *          video is unposted.
 *   dry    everything runs — approval, the queue, the lease, the signed URL — except the two Meta
 *          POSTs. The runner logs the exact payloads it would have sent (URL secrets redacted).
 *   live   posts.
 *
 * ANYTHING ELSE IS off. A typo must never be a post, so there is no case-folding and no "truthy":
 * `Live`, `1`, `true`, `on` all read as off. Whitespace is trimmed and nothing else — a trailing
 * newline is how a secret gets stored, not a statement of intent (scripts/provision-schedulers.sh
 * documents one that cost two jobs months of 401s).
 *
 * A LIVE SEND NEEDS TWO KEYS: this process must say live AND the job row must say live (0059's
 * `mode`, frozen at the tap). See `maySendLive`.
 *
 * NOT tied to STUDIO_VIDEO_ENABLED. Publishing goes live by its own decision.
 */
import { publishHttpTimeoutMs } from "./instagram";

export const PUBLISH_MODES = ["off", "dry", "live"] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];
/** What a job row may carry. `off` never queues, so it is not a row's mode. */
export type JobMode = Exclude<PublishMode, "off">;

export function publishMode(): PublishMode {
  const v = (process.env.STUDIO_PUBLISH_MODE ?? "").trim();
  return v === "dry" || v === "live" ? v : "off";
}

/** THE TWO KEYS. The only function allowed to answer "may this job make a real Meta POST?". */
export const maySendLive = (rowMode: string | null | undefined): boolean =>
  publishMode() === "live" && rowMode === "live";

/** The closed list the route accepts. 0059 has no CHECK on `platform`, so this IS the vocabulary. */
export const PUBLISH_PLATFORMS = ["instagram"] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];
export const isPublishPlatform = (v: unknown): v is PublishPlatform =>
  typeof v === "string" && (PUBLISH_PLATFORMS as readonly string[]).includes(v);

/**
 * How long a claim is good for. One claim's work is a handful of short HTTP calls — refresh the
 * token, sign a URL, then at most create + status + publish + permalink — so the lease is that many
 * timeouts plus a margin, and never less than three minutes.
 */
export const leaseMs = () =>
  Math.max(180_000, 6 * publishHttpTimeoutMs() + 60_000);

/** How many times one job may be claimed and LAPSE before it is given up on. */
export const maxAttempts = () =>
  Number(process.env.STUDIO_PUBLISH_MAX_ATTEMPTS ?? 3);

/**
 * How many times a container may be found still IN_PROGRESS before we stop asking. Meta's guidance
 * is "once per minute, for no more than 5 minutes"; the tick is once a minute, and the slack is for
 * a file near the 300 MB cap. Each poll is one read and one tick — never a loop inside a request.
 */
export const maxPolls = () => Number(process.env.STUDIO_PUBLISH_MAX_POLLS ?? 8);

/** How long the video URL handed to Meta stays readable. Meta fetches it once, soon after create. */
export const videoUrlTtlMs = () =>
  Number(process.env.STUDIO_PUBLISH_URL_TTL_MS ?? 60 * 60_000);
