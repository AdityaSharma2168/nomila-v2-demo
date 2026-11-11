/**
 * publishLogic — what the "Post to Instagram" pill says and does, as pure functions.
 *
 * The component (components/studio/PublishPill.tsx) holds a step and a draft caption and renders
 * whatever this file tells it to. Nothing here touches React, the network or the clock.
 *
 * ─── NEVER ONE TAP ──────────────────────────────────────────────────────────────────────────────
 *
 * A post is public the moment it exists, on her real account. So the pill does not post. It opens
 * a caption box; the caption box leads to a CONFIRM step that names the account — "This posts to
 * @handle now" — and only the button on that step sends anything. `nextStep` is the whole state
 * machine, and the only transition into "sending" is `confirm` FROM "confirming":
 *
 *     idle ──open──▶ composing ──review──▶ confirming ──confirm──▶ sending
 *                        ▲                     │
 *                        └────────back─────────┘         (cancel from anywhere ──▶ idle)
 *
 * Every other (step, action) pair returns the step unchanged. A double-tap on the pill, a stray
 * `confirm` fired while composing, an Enter key in the caption box: none of them can reach sending.
 *
 * ─── THE SERVER DECIDES WHAT IS POSSIBLE; THIS DECIDES WHAT TO SAY ──────────────────────────────
 *
 * GET /studio/publish/options carries the mode, three facts about the account, and whether THIS
 * video can be posted. With the mode off there is no pill at all. Every sentence that explains a
 * refusal is the server's own, shown as written.
 */

// ─── Wire shapes (server/studio/publish/routes.ts) ─────────────────────────────────────────────

export type PublishMode = "off" | "dry" | "live";

export interface PublishJobWire {
  publishId: string;
  assetId: string | null;
  platform: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  /** True only for a real post. A dry run that "succeeded" posted nothing. */
  posted: boolean;
  dryRun: boolean;
  permalink: string | null;
  error: string | null;
  errorCode: string | null;
}

export interface PublishOptionsWire {
  mode: PublishMode;
  instagram?: {
    connected: boolean;
    handle: string | null;
    canPublish: boolean;
  };
  limits?: { captionMaxChars: number; minSeconds: number; maxBytes: number };
  asset?:
    | { postable: true; approvalStatus: string | null; needsApproval: boolean }
    | { postable: false; refusal: { code: string; message: string } };
  latest?: PublishJobWire | null;
}

/** "unavailable" = the route 404'd: an older server, or the Studio flag off. Draw nothing. */
export type PublishOptionsAnswer = PublishOptionsWire | "unavailable";

// ─── The state machine ─────────────────────────────────────────────────────────────────────────

export type PublishStep = "idle" | "composing" | "confirming" | "sending";
export type PublishAction =
  | "open"
  | "review"
  | "back"
  | "confirm"
  | "cancel"
  | "sent";

export function nextStep(
  step: PublishStep,
  action: PublishAction,
): PublishStep {
  if (action === "cancel") return step === "sending" ? step : "idle";
  switch (step) {
    case "idle":
      return action === "open" ? "composing" : step;
    case "composing":
      return action === "review" ? "confirming" : step;
    case "confirming":
      if (action === "back") return "composing";
      // ⚠️  THE ONLY EDGE INTO "sending" IN THIS FILE.
      return action === "confirm" ? "sending" : step;
    case "sending":
      // The request has answered (either way). What happens next is the job's to say.
      return action === "sent" ? "idle" : step;
  }
}

// ─── The caption ───────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CAPTION_MAX = 2200;

export interface CaptionState {
  /** UTF-16 units — the way the server counts, so the two never disagree about "too long". */
  count: number;
  max: number;
  over: boolean;
  counter: string;
}

export function captionState(
  draft: string,
  max = DEFAULT_CAPTION_MAX,
): CaptionState {
  const count = draft.trim().length;
  return {
    count,
    max,
    over: count > max,
    counter: `${count.toLocaleString("en-US")} of ${max.toLocaleString("en-US")}`,
  };
}

// ─── What the pill is ──────────────────────────────────────────────────────────────────────────

export type PillKind =
  /** Draw nothing: switch off, route missing, still loading, or no finished video. */
  | "hidden"
  /** The ordinary pill. Opens the caption box. */
  | "post"
  /** Connected, but the token cannot post. Sends her to reconnect; never opens the flow. */
  | "reconnect"
  /** No Instagram account at all. */
  | "connect"
  /** This video cannot be posted, and the server said why. No button — a sentence. */
  | "refused"
  /** A job is queued or running. */
  | "posting"
  /** The last job ended. */
  | "done";

export interface PillView {
  kind: PillKind;
  /** The pill's own words. Null when there is no pill to press. */
  label: string | null;
  /** A sentence under it, shown as written. */
  note: string | null;
  /** Set when there is a post to open. */
  permalink: string | null;
  /** True when pressing the pill may open the caption box. */
  canOpen: boolean;
}

const HIDDEN: PillView = {
  kind: "hidden",
  label: null,
  note: null,
  permalink: null,
  canOpen: false,
};

// A plain boolean, NOT a type predicate: `job is PublishJobWire` would narrow a FINISHED job to
// `never` in the false branch, and everything below reads finished jobs.
const isLive = (job: PublishJobWire | null | undefined): boolean =>
  !!job && (job.status === "queued" || job.status === "running");

/**
 * `job` is the job this screen is watching (if she just posted) and otherwise the last one the
 * server remembers for this video — so the card is right when she comes back to it.
 */
export function pillView(
  options: PublishOptionsAnswer | undefined,
  job: PublishJobWire | null | undefined,
): PillView {
  if (!options || options === "unavailable" || options.mode === "off")
    return HIDDEN;
  const ig = options.instagram;
  if (!ig) return HIDDEN;

  if (isLive(job))
    return {
      kind: "posting",
      label: "Posting…",
      note: null,
      permalink: null,
      canOpen: false,
    };

  if (job?.status === "succeeded") {
    if (job.dryRun)
      return {
        kind: "done",
        label: "Post to Instagram",
        note: "Dry run finished — nothing was posted.",
        permalink: null,
        canOpen: ig.canPublish,
      };
    return {
      kind: "done",
      label: job.permalink ? "See it on Instagram" : null,
      note: job.permalink ? "Posted." : "Posted. Open Instagram to see it.",
      permalink: job.permalink,
      canOpen: false,
    };
  }

  // A refusal that means "your connection can't post" turns the PILL into the fix.
  if (job?.status === "failed" && job.errorCode === "reconnect")
    return {
      kind: "reconnect",
      label: "Reconnect to post",
      note: job.error,
      permalink: null,
      canOpen: false,
    };

  if (!ig.connected)
    return {
      kind: "connect",
      label: "Connect Instagram to post",
      note: "Posting needs a professional Instagram account.",
      permalink: null,
      canOpen: false,
    };
  if (!ig.canPublish)
    return {
      kind: "reconnect",
      label: "Reconnect to post",
      note: "Instagram needs your permission to post. Reconnect to allow it.",
      permalink: null,
      canOpen: false,
    };

  if (options.asset && !options.asset.postable)
    return {
      kind: "refused",
      label: null,
      note: options.asset.refusal.message,
      permalink: null,
      canOpen: false,
    };

  if (job?.status === "failed")
    return {
      kind: "post",
      // "It may have posted" is not an invitation to try again, so it does not say "Try again".
      label:
        job.errorCode === "may_have_posted" ? "Post to Instagram" : "Try again",
      note: job.error,
      permalink: null,
      canOpen: true,
    };

  return {
    kind: "post",
    label: "Post to Instagram",
    note: null,
    permalink: null,
    canOpen: true,
  };
}

// ─── The confirm step ──────────────────────────────────────────────────────────────────────────

export interface ConfirmView {
  /** "This posts to @handle now." — the account, named, before anything is sent. */
  sentence: string;
  /** What the one sending button says. */
  button: string;
  /** Sent as `approve` — true only when the video is a draft and she is clearing it by this act. */
  approve: boolean;
  /** Shown above the button when the last attempt's outcome is unknown. */
  warning: string | null;
  dryRun: boolean;
}

export function confirmView(
  options: PublishOptionsWire,
  lastJob: PublishJobWire | null | undefined,
): ConfirmView {
  const handle = options.instagram?.handle;
  const who = handle ? `@${handle}` : "your Instagram account";
  const dryRun = options.mode === "dry";
  const needsApproval =
    !!options.asset && options.asset.postable && options.asset.needsApproval;
  return {
    sentence: dryRun
      ? `Dry run: this goes through every step for ${who} and posts nothing.`
      : `This posts to ${who} now.`,
    button: dryRun
      ? "Run the dry run"
      : needsApproval
        ? "Approve and post"
        : "Post now",
    approve: needsApproval,
    warning:
      lastJob?.status === "failed" && lastJob.errorCode === "may_have_posted"
        ? "Your last try may already have posted. Check Instagram first — posting again could put it up twice."
        : null,
    dryRun,
  };
}

/** The body of POST /studio/publish. No account, no handle, no athlete: the server resolves those. */
export function toPublishBody(
  assetId: string,
  draft: string,
  approve: boolean,
) {
  return {
    assetId,
    platform: "instagram" as const,
    caption: draft.trim(),
    ...(approve ? { approve: true } : {}),
  };
}

/** How often to look at a job. Null = stop. A poll reads; it never drives the post. */
export function pollMs(job: PublishJobWire | null | undefined): number | false {
  return isLive(job) ? 3000 : false;
}
