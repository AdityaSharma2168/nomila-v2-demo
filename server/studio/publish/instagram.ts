/**
 * studio/publish/instagram — the four calls that put a video on her Instagram, and nothing else.
 *
 *   createContainer   POST /<IG_ID>/media            { media_type: REELS, video_url, caption }  → container id
 *   checkStatus       GET  /<CONTAINER_ID>           ?fields=status_code,status                 → where it is
 *   publish           POST /<IG_ID>/media_publish    { creation_id }                            → media id
 *   fetchPermalink    GET  /<MEDIA_ID>               ?fields=permalink                          → the link
 *   checkPublishingLimit  GET /<IG_ID>/content_publishing_limit                                 → may she post at all
 *
 * Shapes are Meta's, read from the docs on 2026-09-20 and not from memory:
 *   developers.facebook.com/docs/instagram-platform/content-publishing
 *   …/instagram-graph-api/reference/ig-container · …/reference/ig-user/media · …/reference/error-codes
 *
 * ─── THIS FILE DECIDES NOTHING ──────────────────────────────────────────────────────────────────
 *
 * It does not know about jobs, modes, leases, or whether a call is allowed to be made. It never
 * reads the database and never reads an environment flag that gates sending. Every rule about WHEN
 * one of these may be called — above all "publish at most once per row" — lives in the runner, where
 * it can be tested against a fake of this file. A guard in here would be a second place for the
 * rule to live, and the day the two disagree is the day she is posted twice.
 *
 * ─── WHAT A THROW FROM `publish` MEANS: NOT "NO" — "UNKNOWN" ────────────────────────────────────
 *
 * server/lib/withTimeout does not cancel the request it gives up on — its own header says so. We
 * also abort the socket here, which is better, and still proves nothing: a request can be accepted
 * by Instagram and lose its response on the way back. So a timeout, a network error or a 5xx from
 * `publish` means THE POST MAY EXIST. `InstagramPublishError.outcomeUnknown` says which errors are
 * of that kind, and the runner treats every one of them as the orphan window: read the container,
 * and never call `publish` again. Only an explicit refusal WE RECOGNISE — a 4xx, an error envelope,
 * and a classification that is about the request — is a "no". Meta's own "try again" codes arrive as
 * HTTP 400, so neither the status nor the envelope alone is enough.
 *
 * ─── THE TOKEN IS NEVER IN A URL ────────────────────────────────────────────────────────────────
 *
 * Meta's publishing examples send `Authorization: Bearer`, so that is what all four calls do. The
 * shared integration (server/lib/integrations/instagram.ts) puts `access_token` in the query
 * string; a URL is the thing that ends up in an error message, a proxy log or a stack trace, and
 * this path logs more than most because dry-run exists to print what it would send. No URL built
 * here contains a secret, and `redactUrl` exists for the one that arrives with secrets already in
 * it — the signed video URL.
 *
 * ─── TESTS NEVER CALL META ──────────────────────────────────────────────────────────────────────
 *
 * Every function takes its `fetch`. There is no default that reaches the network from a test by
 * accident: `liveDeps()` is the only place the real one is named, and only the runner calls it.
 */
import { withTimeout } from "../../lib/withTimeout";

/**
 * Pinned to what the shared integration already speaks (its `GV` is not exported, so this is a copy
 * — see the proposal for Mia). Bumping it is a decision about two files, not one.
 */
export const IG_GRAPH_VERSION = "v22.0";
const GRAPH = `https://graph.instagram.com/${IG_GRAPH_VERSION}`;

export const publishHttpTimeoutMs = () =>
  Number(process.env.STUDIO_PUBLISH_HTTP_TIMEOUT_MS ?? 30_000);

// ─── What Meta will take. Read from the Reels spec, not chosen ─────────────────────────────────

/** "2200 characters, 30 hashtags, and 20 @ tags". */
export const CAPTION_MAX_CHARS = 2200;
export const CAPTION_MAX_HASHTAGS = 30;
export const CAPTION_MAX_MENTIONS = 20;
/** "15 mins maximum, 3 seconds minimum". Our own stitch cap is far under the maximum. */
export const REEL_MIN_SECONDS = 3;
export const REEL_MAX_SECONDS = 15 * 60;
/** "300MB maximum". Decimal, the smaller reading — a file we refuse wrongly can be re-stitched; one Meta refuses wastes her wait. */
export const REEL_MAX_BYTES = 300 * 1000 * 1000;
/** "VBR, 25Mbps maximum". */
export const REEL_MAX_VIDEO_BITRATE = 25_000_000;

/** The container's `status_code`, exactly as the IG Container reference lists it. */
export const CONTAINER_STATUS = [
  "EXPIRED",
  "ERROR",
  "FINISHED",
  "IN_PROGRESS",
  "PUBLISHED",
] as const;
export type ContainerStatus = (typeof CONTAINER_STATUS)[number];

// ─── The seam ──────────────────────────────────────────────────────────────────────────────────

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface InstagramDeps {
  fetch: FetchLike;
  /** Per-call ceiling. Defaults to STUDIO_PUBLISH_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The only place the real network is named. Called by the runner; never by a test. */
export const liveDeps = (): InstagramDeps => ({
  fetch: (url, init) => fetch(url, init),
});

// ─── Errors: a closed code, a sentence for her, and whether the call may have landed ───────────

/**
 * What went wrong, as the client needs to know it — i.e. by WHAT SHE CAN DO NEXT, not by Meta's
 * numbering.
 *
 *   reconnect     the token or its permissions. "Reconnect Instagram to allow posting." This is also
 *                 the ONLY defence against a connected_accounts row that claims a scope it was never
 *                 granted (handleCallback stores the requested list when Meta returns none).
 *   restitch      Meta would not take the file. An older stitch carries edit lists; a new one does not.
 *   fetch_failed  Meta could not download the video from the URL we gave it.
 *   rate_limited  100 API posts per rolling 24 hours, or Meta's spam restriction.
 *   expired       the container is gone (24h, or Meta lost it). A new container is a new job.
 *   not_ready     publish was called on a container that is not FINISHED. A runner bug, not hers.
 *   transient     Meta says try again. Safe to retry for every call EXCEPT publish.
 *   unknown       none of the above.
 */
export type PublishErrorCode =
  | "reconnect"
  | "restitch"
  | "fetch_failed"
  | "rate_limited"
  | "expired"
  | "not_ready"
  | "transient"
  | "unknown";

const SENTENCES: Record<PublishErrorCode, string> = {
  reconnect: "Reconnect Instagram to allow posting.",
  restitch:
    "Instagram couldn't read this video file. Put it together again, then post the new one.",
  fetch_failed:
    "Instagram couldn't download the video from us. That's on our side — try again in a minute.",
  rate_limited:
    "Instagram has stopped taking posts from this account for now. Try again later today.",
  expired:
    "This upload sat too long and Instagram let it go. Post it again to start a fresh one.",
  not_ready: "Instagram wasn't finished preparing the video. Post it again.",
  transient: "Instagram had a problem on its side. Try again in a minute.",
  unknown:
    "Instagram refused this post and didn't say why in a way we understand.",
};

export type InstagramOp =
  | "createContainer"
  | "checkStatus"
  | "publish"
  | "fetchPermalink"
  | "checkPublishingLimit";

export class InstagramPublishError extends Error {
  constructor(
    readonly op: InstagramOp,
    readonly code: PublishErrorCode,
    /**
     * TRUE when we cannot tell whether Instagram acted on the request: a timeout, a network
     * failure, a 5xx, a body that was not JSON. For `publish` this means THE POST MAY EXIST.
     * FALSE only for an explicit refusal — a 4xx carrying Meta's error envelope.
     */
    readonly outcomeUnknown: boolean,
    /** Meta's own words and numbers, for the log. Never shown to her, never contains a URL. */
    readonly detail: {
      httpStatus?: number;
      metaCode?: number;
      metaSubcode?: number;
      metaType?: string;
      metaMessage?: string;
      fbtraceId?: string;
    } = {},
  ) {
    super(SENTENCES[code]);
    this.name = "InstagramPublishError";
  }
  /** The sentence she reads. Ours, never Meta's — a raw code is not an instruction. */
  get userMessage(): string {
    return SENTENCES[this.code];
  }
}

export const sentenceFor = (code: PublishErrorCode): string => SENTENCES[code];

interface MetaErrorEnvelope {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
}

/**
 * Meta's (code, subcode) → what she can do. SUBCODE FIRST: it is the specific one, and codes are
 * reused (-1 and -2 each cover several unrelated failures). Rows are the error-codes reference's;
 * 190 (invalid or expired token) and 10 (permission denied) are the Graph API's general codes.
 */
export function classifyMetaError(e: MetaErrorEnvelope): PublishErrorCode {
  switch (e.error_subcode) {
    case 2207026:
      return "restitch"; // "The video format is not supported."
    case 2207052:
      return "fetch_failed"; // "The media could not be fetched from this uri."
    case 2207003:
      return "fetch_failed"; // "It takes too long to download the media."
    case 2207042:
      return "rate_limited"; // "You reached maximum number of posts allowed by API."
    case 2207051:
      return "rate_limited"; // "We restrict certain activity to protect our community."
    case 2207020:
      return "expired"; // "The media you are trying to access has expired."
    case 2207008:
      return "expired"; // "The media builder with creation id does not exist."
    case 2207027:
      return "not_ready"; // "The media is not ready for publishing."
    case 2207006:
      return "reconnect"; // "…cannot be found" — documented cause: permission or expired token
    case 2207001:
      return "transient"; // Instagram server error; retry.
    case 2207032:
      return "transient"; // "Create media fail, please try to re-create media"
  }
  switch (e.code) {
    case 190:
      return "reconnect";
    case 10:
      return "reconnect";
    case 200:
      return "reconnect";
  }
  // Meta names its permission failure by type as well as by number.
  if (/PERMISSION/i.test(e.type ?? "")) return "reconnect";
  if (e.is_transient) return "transient";
  return "unknown";
}

// ─── The one request function ──────────────────────────────────────────────────────────────────

async function call<T>(
  op: InstagramOp,
  deps: InstagramDeps,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, string>,
): Promise<T> {
  const ms = deps.timeoutMs ?? publishHttpTimeoutMs();
  const abort = new AbortController();

  let res: FetchResponseLike;
  let json: unknown;
  try {
    // Both bounds, because they fail differently: the abort frees the socket, and withTimeout
    // returns control even from a fetch that ignores its signal (every fake does, some proxies do).
    res = await withTimeout(
      deps.fetch(`${GRAPH}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: abort.signal,
      }),
      ms,
      `instagram ${op}`,
    );
    json = await withTimeout(res.json(), ms, `instagram ${op} body`);
  } catch {
    abort.abort();
    // DELIBERATELY NOT CHAINED. A fetch error's message can carry the URL it failed on, and the
    // cause of an error is a thing loggers serialise. The op is all a reader needs.
    throw new InstagramPublishError(op, "transient", true);
  }

  const err = (json as { error?: MetaErrorEnvelope } | null)?.error;
  if (!res.ok || err) {
    const detail = {
      httpStatus: res.status,
      metaCode: err?.code,
      metaSubcode: err?.error_subcode,
      metaType: err?.type,
      metaMessage: err?.message,
      fbtraceId: err?.fbtrace_id,
    };
    const code = err ? classifyMetaError(err) : "transient";
    // A "no" is only a no when Meta REFUSED in words we recognise: a 4xx, an envelope, and a
    // classification that is about the request. A 5xx, a bare failure, "try again" and "unknown"
    // are all outcomes we did not see — Meta's own retry codes arrive as HTTP 400, so the status
    // alone cannot be trusted to mean nothing happened.
    const refused =
      !!err &&
      res.status >= 400 &&
      res.status < 500 &&
      code !== "transient" &&
      code !== "unknown";
    throw new InstagramPublishError(op, code, !refused, detail);
  }
  return json as T;
}

const idOf = (op: InstagramOp, json: { id?: unknown }): string => {
  // A 200 with no id is not a success we can act on, and for `publish` it is the worst case:
  // something happened and we hold no handle. Unknown outcome, never a guess.
  if (typeof json?.id !== "string" || !json.id) {
    throw new InstagramPublishError(op, "unknown", true);
  }
  return json.id;
};

// ─── The four calls ────────────────────────────────────────────────────────────────────────────

export interface CreateContainerInput {
  igUserId: string;
  token: string;
  /** Must be fetchable by Meta with no credentials: "We cURL media used in publishing attempts". */
  videoUrl: string;
  caption: string;
}

/** The exact JSON body `createContainer` sends. Exported so dry-run prints THIS, not a description of it. */
export const containerBody = (
  input: Pick<CreateContainerInput, "videoUrl" | "caption">,
): Record<string, string> => ({
  media_type: "REELS",
  video_url: input.videoUrl,
  caption: input.caption,
});

/** The exact JSON body `publish` sends. */
export const publishBody = (containerId: string): Record<string, string> => ({
  creation_id: containerId,
});

/** Safe to repeat: an unpublished container is invisible and expires by itself in 24 hours. */
export async function createContainer(
  input: CreateContainerInput,
  deps: InstagramDeps,
): Promise<{ containerId: string }> {
  const json = await call<{ id?: unknown }>(
    "createContainer",
    deps,
    input.token,
    "POST",
    `/${encodeURIComponent(input.igUserId)}/media`,
    containerBody(input),
  );
  return { containerId: idOf("createContainer", json) };
}

export interface ContainerState {
  statusCode: ContainerStatus;
  /** "If status_code is ERROR, this value will be an error subcode." Free text otherwise; for the log. */
  status: string | null;
}

/** A read. Safe to repeat, and the ONLY way to learn whether a publish landed — no field returns the media id. */
export async function checkStatus(
  input: { containerId: string; token: string },
  deps: InstagramDeps,
): Promise<ContainerState> {
  const json = await call<{ status_code?: unknown; status?: unknown }>(
    "checkStatus",
    deps,
    input.token,
    "GET",
    `/${encodeURIComponent(input.containerId)}?fields=status_code,status`,
  );
  const statusCode = json?.status_code;
  if (!CONTAINER_STATUS.includes(statusCode as ContainerStatus)) {
    // A status we do not know is not FINISHED and is not PUBLISHED. The runner must not act on it.
    throw new InstagramPublishError("checkStatus", "unknown", true);
  }
  return {
    statusCode: statusCode as ContainerStatus,
    status: typeof json.status === "string" ? json.status : null,
  };
}

/**
 * ⚠️  THE ONE CALL THAT IS NOT SAFE TO REPEAT. It makes a public post on a real person's account.
 * This function does not protect itself — see the header. The runner calls it at most once per job
 * row, after writing `publish_attempted_at`, and treats any throw with `outcomeUnknown` as "it may
 * have posted".
 */
export async function publish(
  input: { igUserId: string; containerId: string; token: string },
  deps: InstagramDeps,
): Promise<{ mediaId: string }> {
  const json = await call<{ id?: unknown }>(
    "publish",
    deps,
    input.token,
    "POST",
    `/${encodeURIComponent(input.igUserId)}/media_publish`,
    publishBody(input.containerId),
  );
  return { mediaId: idOf("publish", json) };
}

/** A read, after the fact. NULL rather than a throw when Meta answers without one: the post exists either way. */
export async function fetchPermalink(
  input: { mediaId: string; token: string },
  deps: InstagramDeps,
): Promise<string | null> {
  const json = await call<{ permalink?: unknown }>(
    "fetchPermalink",
    deps,
    input.token,
    "GET",
    `/${encodeURIComponent(input.mediaId)}?fields=permalink`,
  );
  return typeof json?.permalink === "string" && json.permalink
    ? json.permalink
    : null;
}

export interface PublishingLimit {
  /** Posts made through the API in the rolling window. NULL when Meta answered in a shape we do not know. */
  used: number | null;
  /** Meta's ceiling for the window. NULL likewise — never a guess at 100. */
  total: number | null;
}

/**
 * A READ, and the cheapest honest question there is: it needs the publish permission, so a token
 * that cannot post is refused HERE — with Meta's permission error, which `classifyMetaError` turns
 * into "reconnect" — before any container exists. That makes it the one call dry-run can make to
 * learn whether the recorded scopes are true (connected_accounts.scopes may claim a scope Meta never
 * granted), and the one the live path makes first so "you've hit today's limit" is said before she
 * waits for an upload.
 *
 * An unfamiliar body is NOT an error: nulls, and the caller carries on. A read must not be able to
 * block a post by being reshaped.
 */
export async function checkPublishingLimit(
  input: { igUserId: string; token: string },
  deps: InstagramDeps,
): Promise<PublishingLimit> {
  const json = await call<{
    data?: { quota_usage?: unknown; config?: { quota_total?: unknown } }[];
  }>(
    "checkPublishingLimit",
    deps,
    input.token,
    "GET",
    `/${encodeURIComponent(input.igUserId)}/content_publishing_limit?fields=quota_usage,config`,
  );
  const row = Array.isArray(json?.data) ? json.data[0] : undefined;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return { used: num(row?.quota_usage), total: num(row?.config?.quota_total) };
}

// ─── Saying what would be sent without saying the secret ───────────────────────────────────────

/**
 * A signed GCS URL is a bearer credential for her video: anyone holding the query string can read
 * the file until it expires. Dry-run logs the payload it would send, so the URL goes through here
 * first — origin and path kept (they say WHICH object), every query VALUE dropped, the parameter
 * NAMES kept so a reader can still see it was a V4 signature and not a public link.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const names = [...new Set([...u.searchParams.keys()])];
    return names.length
      ? `${u.origin}${u.pathname}?<redacted: ${names.join(",")}>`
      : `${u.origin}${u.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}
