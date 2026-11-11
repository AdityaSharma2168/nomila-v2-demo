/**
 * studio/publish/eligibility — "may THIS video go to THIS account?", asked the same way twice.
 *
 * The route asks at the tap, so she is refused in a sentence before anything is queued. The runner
 * asks again at claim time, because a job can wait: the video can be deleted, approval can be
 * withdrawn, the account can be disconnected. ONE implementation, so the two cannot drift into a
 * route that accepts what the runner would post differently.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Both lookups carry `athlete_id = $athleteId` IN THE QUERY. The route passes `req.athleteId`; the
 * runner passes the claimed row's own `athlete_id`. No id from a client or a stored job is ever
 * looked up without it, and "not yours" is the same answer as "does not exist".
 *
 * ─── WHY THERE IS NO "IS IT A PROFESSIONAL ACCOUNT" CHECK ───────────────────────────────────────
 *
 * There is nothing to check it against — `account_type` is not stored. It does not need to be:
 * handleCallback (server/lib/integrations/instagram.ts) refuses a PERSONAL account at connect time,
 * so an `active` Instagram row IS a professional account. If that ever stops being true Meta says
 * so at the first call, and the runner turns that into "reconnect".
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts, mediaAssets } from "../../../shared/schema";
import { openToken } from "../../lib/tokenCrypto";
import {
  REEL_MAX_BYTES,
  REEL_MAX_VIDEO_BITRATE,
  REEL_MIN_SECONDS,
} from "./instagram";
import type { JobErrorCode } from "./jobs";

/** The scope Instagram Login grants for publishing. NOT requested by the app today — see the proposal for Mia. */
export const PUBLISH_SCOPE = "instagram_business_content_publish";

const VIDEO_TYPES = ["VIDEO", "REELS"];

export type Refusal = {
  ok: false;
  /** HTTP status for the route. The runner ignores it. */
  status: 400 | 404 | 409;
  code:
    | JobErrorCode
    | "not_found"
    | "not_a_video"
    | "not_approved"
    | "too_short"
    | "too_big"
    | "too_dense"
    | "not_connected";
  /** A plain sentence. This is what she reads. */
  message: string;
};

export interface PostableAsset {
  id: string;
  gcsPath: string;
  bytes: number | null;
  durationSeconds: number | null;
  approvalStatus: string | null;
}

const mb = (bytes: number) => Math.round(bytes / 1_000_000);

/**
 * Her video, checked against what Instagram will take. `requireApproved` is false only for the
 * route's OPTIONS read, which has to describe a draft in order to offer "Approve and post".
 */
export async function resolvePostableAsset(
  athleteId: string,
  assetId: string,
  opts: { requireApproved: boolean } = { requireApproved: true },
): Promise<{ ok: true; asset: PostableAsset } | Refusal> {
  const [row] = await db
    .select({
      id: mediaAssets.id,
      media_type: mediaAssets.media_type,
      gcs_path: mediaAssets.gcs_path,
      status: mediaAssets.status,
      bytes: mediaAssets.bytes,
      duration_seconds: mediaAssets.duration_seconds,
      duration_seconds_precise: mediaAssets.duration_seconds_precise,
      approval_status: mediaAssets.approval_status,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.id, assetId),
        // THE TENANCY PREDICATE. Never trust an id from a client or a stored job.
        eq(mediaAssets.athlete_id, athleteId),
        isNull(mediaAssets.deleted_at),
      ),
    )
    .limit(1);

  // Deliberately the same answer for "no such video" and "not this athlete's".
  if (!row)
    return {
      ok: false,
      status: 404,
      code: "not_found",
      message: "That video could not be found.",
    };
  if (!VIDEO_TYPES.includes(row.media_type))
    return {
      ok: false,
      status: 400,
      code: "not_a_video",
      message: "Only a video can be posted from here.",
    };
  if (row.status !== "stored" || !row.gcs_path)
    return {
      ok: false,
      status: 400,
      code: "not_found",
      message: "That video isn't available — its file never finished arriving.",
    };

  // approval.ts: `approved` is "cleared for embed and publish". NULL is an ungated ingested asset —
  // already hers and already public — and is not what this door is for; draft and rejected are not
  // cleared. Only `approved` posts.
  if (opts.requireApproved && row.approval_status !== "approved")
    return {
      ok: false,
      status: 409,
      code: "not_approved",
      message: "Approve this video before posting it.",
    };

  const durationSeconds =
    row.duration_seconds_precise ?? row.duration_seconds ?? null;
  // A duration we do not know is not a duration under three seconds. Instagram decides, and its
  // refusal reaches her as a sentence either way.
  if (durationSeconds !== null && durationSeconds < REEL_MIN_SECONDS)
    return {
      ok: false,
      status: 400,
      code: "too_short",
      message: `Instagram needs a video of at least ${REEL_MIN_SECONDS} seconds, and this one is ${durationSeconds.toFixed(1)}.`,
    };
  if (row.bytes !== null && row.bytes > REEL_MAX_BYTES)
    return {
      ok: false,
      status: 400,
      code: "too_big",
      // THE GAP, NAMED: the stitcher will happily make a file Instagram will not take.
      message: `Instagram takes videos up to ${mb(REEL_MAX_BYTES)} MB and this one is ${mb(row.bytes)} MB. We can put together bigger videos than Instagram accepts — make this one shorter, then post it.`,
    };

  // ─── THE LIMIT THE STITCHER DOES NOT KNOW ABOUT ─────────────────────────────────────────────
  //
  // Instagram: "VBR, 25Mbps maximum". The stitch encodes at a fixed QUALITY (libx264 crf 23) with
  // no ceiling on the rate, so the rate is whatever the pictures need. Measured at 1080x1920@30:
  // coherent high-detail motion 6–11 Mbps; a cellular automaton 80; noise 193. Real footage is
  // almost always under 25 — and when it is not, Instagram answers "format not supported", which
  // we would turn into "put it together again"… producing the identical file. A loop, on our word.
  //
  // So it is refused HERE, with the truth. bytes × 8 ÷ seconds is the whole file's average (audio
  // included: 128 kbps, half a percent of the limit), which over-counts slightly — the safe side.
  // The cure is a `-maxrate` in studio/video/plan.ts; that changes every stitch and is its own
  // decision (the ledger, item c).
  if (row.bytes !== null && durationSeconds !== null && durationSeconds > 0) {
    const mbps = (row.bytes * 8) / durationSeconds / 1_000_000;
    if (mbps > REEL_MAX_VIDEO_BITRATE / 1_000_000)
      return {
        ok: false,
        status: 400,
        code: "too_dense",
        message: `Instagram won't take this file: it carries ${mbps.toFixed(0)} Mbps of video and Instagram's limit is ${REEL_MAX_VIDEO_BITRATE / 1_000_000}. Putting it together again won't change that — this one is ours to fix.`,
      };
  }

  return {
    ok: true,
    asset: {
      id: row.id,
      gcsPath: row.gcs_path,
      bytes: row.bytes,
      durationSeconds,
      approvalStatus: row.approval_status,
    },
  };
}

export interface PublishAccount {
  id: string;
  /** Her @handle, for the confirm step. Never logged. */
  handle: string | null;
  igUserId: string | null;
  /** True when the RECORDED scopes include publishing. Meta has the last word — see the runner. */
  canPublish: boolean;
  accessToken: string | null;
}

const hasPublishScope = (scopes: string | null): boolean =>
  (scopes ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(PUBLISH_SCOPE);

const toAccount = async (row: {
  id: string;
  platform_username: string | null;
  platform_user_id: string | null;
  scopes: string | null;
  access_token: string | null;
}): Promise<PublishAccount> => ({
  id: row.id,
  handle: row.platform_username,
  igUserId: row.platform_user_id,
  canPublish: hasPublishScope(row.scopes),
  accessToken: await openToken(row.access_token),
});

const ACCOUNT_COLUMNS = {
  id: connectedAccounts.id,
  platform_username: connectedAccounts.platform_username,
  platform_user_id: connectedAccounts.platform_user_id,
  scopes: connectedAccounts.scopes,
  access_token: connectedAccounts.access_token,
};

/**
 * THE ROUTE'S LOOKUP: her active Instagram account. An athlete may hold more than one row; the
 * newest active one is the one the app treats as connected, and whichever this returns is PINNED
 * on the job — the runner never calls this, so the account cannot change between confirm and post.
 */
export async function currentInstagramAccount(
  athleteId: string,
): Promise<PublishAccount | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.athlete_id, athleteId),
        eq(connectedAccounts.platform, "instagram"),
        eq(connectedAccounts.status, "active"),
      ),
    )
    .orderBy(desc(connectedAccounts.created_at))
    .limit(1);
  return row ? await toAccount(row) : null;
}

/**
 * THE RUNNER'S LOOKUP: exactly the account pinned on the job, still hers, still active. Never
 * "her current account" — if the pinned one is gone the job fails; it does not quietly post to a
 * different @handle than the one she confirmed.
 */
export async function pinnedInstagramAccount(
  athleteId: string,
  connectedAccountId: string,
): Promise<PublishAccount | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.id, connectedAccountId),
        eq(connectedAccounts.athlete_id, athleteId),
        eq(connectedAccounts.platform, "instagram"),
        eq(connectedAccounts.status, "active"),
      ),
    )
    .limit(1);
  return row ? await toAccount(row) : null;
}

export const RECONNECT: Refusal = {
  ok: false,
  status: 409,
  code: "reconnect",
  message: "Reconnect Instagram to allow posting.",
};

export const NOT_CONNECTED: Refusal = {
  ok: false,
  status: 409,
  code: "not_connected",
  message: "Connect a professional Instagram account to post from here.",
};

/** Is this account usable for posting, as far as OUR records say? */
export function accountRefusal(account: PublishAccount | null): Refusal | null {
  if (!account) return NOT_CONNECTED;
  if (!account.canPublish || !account.accessToken || !account.igUserId)
    return RECONNECT;
  return null;
}
