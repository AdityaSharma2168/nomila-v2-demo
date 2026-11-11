/**
 * use-studio-media — the shared Studio picker's lists: GET /studio/media (browse, paged) and
 * GET /studio/media/search (her words, one page). Shaped by client/screens/studio/mediaPickerLogic.ts.
 *
 * ⚠️ STUDIO'S OWN LIST, NOT GET /me/media — which serves 24 a picker never advances, sorts posted_at
 * alone (photos made here sink) and does not drop deleted rows. That route is shared and untouched.
 *
 * Every key starts ["studio", "media"], so one invalidation after an upload refreshes the strip, the
 * modal and any search at once.
 */
import { useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import { ORIGIN_LABEL } from "./use-studio-stitch";
import {
  isStaleCursor,
  mediaQuery,
  rowFromWire,
  type PickerKind,
  type PickerOrigin,
  type PickerRow,
  type WireMediaRow,
} from "../screens/studio/mediaPickerLogic";
import {
  readOfAnswer,
  type ClipRead,
  type ClipReadAnswer,
} from "../screens/studio/clipReadLogic";

export interface StudioMediaParams {
  kind: PickerKind;
  origins: readonly PickerOrigin[];
  still: boolean;
  pageSize: number;
}

export interface StudioMediaPage {
  items: PickerRow[];
  nextCursor: string | null;
}

/** The prefix every picker list's key starts with — invalidate this after an upload. */
export const STUDIO_MEDIA_KEY = ["studio", "media"] as const;

const label = (origin: string) => ORIGIN_LABEL[origin] ?? origin;

const keyOf = (p: StudioMediaParams) => [
  p.kind,
  [...p.origins].sort().join(","),
  p.still ? 1 : 0,
  p.pageSize,
];

async function getJson(path: string): Promise<Response> {
  return fetch(new URL(path, getApiUrl()).toString(), {
    headers: await getAuthHeaders(),
  });
}

/** The list refused the cursor we sent (mediaPickerLogic `isStaleCursor`). The hook resets on it. */
export class StaleCursorError extends Error {
  constructor() {
    super("stale cursor");
    this.name = "StaleCursorError";
  }
}

/** One page of the browse list. Imperative, for the upload check; the hook below wraps it. */
export async function fetchStudioMediaPage(
  p: StudioMediaParams,
  cursor: string | null,
): Promise<StudioMediaPage> {
  const res = await getJson(
    `/api/v1/me/studio/media?${mediaQuery({ kind: p.kind, origins: p.origins, still: p.still, limit: p.pageSize, cursor })}`,
  );
  if (!res.ok) {
    const text = await res.text();
    // PR 12 (ruling 5): the server refused OUR cursor — its order changed under us. Named, so the
    // hook can restart from page 1 rather than strand her on stale pages with an error line.
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not json: an ordinary error below */
    }
    if (isStaleCursor(res.status, body, cursor)) throw new StaleCursorError();
    throw new Error(`${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    items?: WireMediaRow[];
    nextCursor?: string | null;
  };
  return {
    items: (json.items ?? []).map((w) => rowFromWire(w, label)),
    nextCursor: json.nextCursor ?? null,
  };
}

/**
 * These rows, if this mount can use them — the mount's own filters, by id, never paged (quality-scrappy, Investigation
 * 12). The upload check: "can the picker I am in hold the row I just made?". Hers only; a row it cannot hold is absent.
 */
export async function fetchStudioMediaRows(
  p: StudioMediaParams,
  ids: readonly string[],
): Promise<PickerRow[]> {
  const res = await getJson(
    `/api/v1/me/studio/media?${mediaQuery({ kind: p.kind, origins: p.origins, still: p.still, ids })}`,
  );
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { items?: WireMediaRow[] };
  return (json.items ?? []).map((w) => rowFromWire(w, label));
}

/**
 * Her library for one mount, newest first, a page at a time. The compact strip is page 1.
 *
 * Always-stale, like the /stitch/* lists: a clip finished on the Board, or a photo made on another
 * screen, should be here when she comes back rather than after a reload.
 */
export function useStudioMedia(p: StudioMediaParams, enabled = true) {
  // Memoised on its parts, so the reset effect below can depend on it honestly.
  const originsKey = [...p.origins].sort().join(",");
  const queryKey = useMemo(
    () => [
      ...STUDIO_MEDIA_KEY,
      "list",
      p.kind,
      originsKey,
      p.still ? 1 : 0,
      p.pageSize,
    ],
    [p.kind, originsKey, p.still, p.pageSize],
  );
  const client = useQueryClient();
  const query = useInfiniteQuery<
    StudioMediaPage,
    Error,
    InfiniteData<StudioMediaPage, string | null>,
    (string | number)[],
    string | null
  >({
    queryKey,
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    initialPageParam: null,
    queryFn: ({ pageParam }) => fetchStudioMediaPage(p, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A stale cursor is not transient; retrying the same cursor is the same 400.
    retry: (count, err) => !(err instanceof StaleCursorError) && count < 3,
  });
  // PR 12 (ruling 5): a stale cursor restarts the list from page 1 — the pages we hold are in an
  // order the server no longer serves. ⚠️ MUTATION (use-studio-media.test "stale cursor strands the
  // picker"): drop this effect — the hook sits in error with its old pages.
  const stale = query.error instanceof StaleCursorError;
  useEffect(() => {
    if (stale) void client.resetQueries({ queryKey, exact: true });
  }, [stale, client, queryKey]);
  return query;
}

/** A search's answer: rows closest first, or the server's sentence when it could not search. */
export type StudioMediaSearchAnswer =
  | { items: PickerRow[] }
  | { unavailable: string };

/**
 * Her words against one mount's library. ONE request per submitted search — the caller passes the
 * words she SUBMITTED, never the draft she is typing — and the same words are answered from cache.
 */
export function useStudioMediaSearch(
  p: StudioMediaParams & { q: string },
  enabled = true,
) {
  return useQuery<StudioMediaSearchAnswer>({
    queryKey: [...STUDIO_MEDIA_KEY, "search", ...keyOf(p), p.q],
    enabled: enabled && p.q.length >= 2,
    queryFn: async () => {
      const res = await getJson(
        `/api/v1/me/studio/media/search?${mediaQuery({ kind: p.kind, origins: p.origins, still: p.still, q: p.q })}`,
      );
      if (res.status === 503) {
        const json = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        return {
          unavailable: json?.error ?? "Search isn't available right now.",
        };
      }
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { items?: WireMediaRow[] };
      return { items: (json.items ?? []).map((w) => rowFromWire(w, label)) };
    },
  });
}

// ─── One clip, read on demand (PR 9.5, F22 B2) ─────────────────────────────────────────────────

/** POST /studio/media/:id/read — the tap. Never throws on a business answer (at cap, failed…). */
export async function readClip(assetId: string): Promise<ClipReadAnswer> {
  const res = await fetch(
    new URL(`/api/v1/me/studio/media/${assetId}/read`, getApiUrl()).toString(),
    { method: "POST", headers: await getAuthHeaders() },
  );
  const json = (await res.json().catch(() => null)) as
    | (ClipReadAnswer & { error?: string })
    | null;
  if (res.ok && json && "status" in json) return json;
  if (res.status === 409 && json && json.status === "not_video") return json;
  throw new Error(json?.error ?? `Couldn't read that clip (${res.status})`);
}

/** GET /media/:id's `read` — what a poll reads while the kick runs. Null from an older server or a 404. */
export async function fetchClipRead(assetId: string): Promise<ClipRead | null> {
  const res = await getJson(`/api/v1/me/media/${assetId}`);
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    read?: ClipRead | null;
  } | null;
  return json?.read ?? null;
}

/** How often, and for how long at most, a `reading` row is polled: the server's own bound, 2 × 120 s. */
export const CLIP_READ_POLL_MS = 3_000;
export const CLIP_READ_POLL_MAX_MS = 240_000;

/**
 * Start a read and follow it to its end. `onRead` is called with every state the row passes through —
 * the tap's answer at once, then each poll while `reading` — and last with the settled state. Every
 * list keyed under STUDIO_MEDIA_KEY is invalidated when it settles, so the picker's beat counts agree.
 */
export function useClipRead() {
  const qc = useQueryClient();
  return useMutation<
    ClipRead,
    Error,
    { assetId: string; quotedUsd: number; onRead: (r: ClipRead) => void }
  >({
    mutationFn: async ({ assetId, quotedUsd, onRead }) => {
      let read = readOfAnswer(await readClip(assetId), quotedUsd);
      onRead(read);
      const until = Date.now() + CLIP_READ_POLL_MAX_MS;
      while (read.state === "reading" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, CLIP_READ_POLL_MS));
        const next = await fetchClipRead(assetId);
        if (next) {
          read = next;
          onRead(read);
        }
      }
      await qc.invalidateQueries({ queryKey: [...STUDIO_MEDIA_KEY] });
      return read;
    },
  });
}
