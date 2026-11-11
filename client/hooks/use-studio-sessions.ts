/**
 * use-studio-sessions — the Create anything thread's data layer (session persistence plan v2 §4): her threads,
 * one thread's pages, the append queue, archive, and the watch on a run in flight.
 *
 * Every decision these hooks act on — what a 404 means, what to retry, when a watch gives up — is a pure function
 * in client/screens/studio/threadLogic.ts, where it is a unit test. That is the one place a hook here imports from
 * screens/: the policy is the thread's, and a second copy of it here would be the one that drifts.
 *
 * ─── ATHLETE-SCOPED BY THE TOKEN, AND NOTHING ELSE ─────────────────────────────────────────────────────
 *
 * No request below carries an athlete id; the server reads it from the authenticated request (use-studio.ts says
 * the same of its own calls). A thread id is minted here, but it names nothing until the server's first append
 * claims it for HER — another athlete's id is answered with a fresh thread of hers, and the queue follows it.
 *
 * ─── THE SURFACE CAN BE OFF ON THE SERVER WHILE IT IS ON HERE ──────────────────────────────────────────
 *
 * EXPO_PUBLIC_STUDIO_SESSIONS is a build-time flag and STUDIO_SESSIONS a runtime one, set independently. A 404 on
 * the list is that case: the thread runs session-only, the queue stays empty, and nothing is said about it. See
 * `listReadFor`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useIsFocused } from "@react-navigation/native";
import * as Crypto from "expo-crypto";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import {
  appendDisposition,
  appendFailureReason,
  listReadFor,
  MAX_APPEND_RETRIES,
  POLL_EVERY_MS,
  jobReadFromStitch,
  pollOutcome,
  pollProgress,
  retryDelayMs,
  threadReadFor,
  type EntryBody,
  type JobRead,
  type ListAnswer,
  type PollOutcome,
  type RunPhase,
  type StitchRead,
  type WatchKind,
  type SessionSummary,
  type ThreadPage,
  type WirePlanEntry,
  type WireSession,
} from "../screens/studio/threadLogic";

const BASE = "/api/v1/me/studio/sessions";

/** A thread's id, or an entry's. Minted here so a retried append is the same entry (the server is idempotent by id). */
export const newId = (): string => Crypto.randomUUID();

const SESSIONS_KEY = ["studio", "sessions"] as const;
const listKey = (archived: boolean) =>
  [...SESSIONS_KEY, "list", archived] as const;
const threadKey = (sessionId: string) =>
  [...SESSIONS_KEY, "thread", sessionId] as const;

async function authed(init: RequestInit = {}): Promise<RequestInit> {
  return {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(await getAuthHeaders()),
    },
  };
}

// ─── Her threads ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Her threads — open ones, or archived ones — newest first, at most 30 (the server's page; no paging in v1).
 *
 * Fresh on every mount (`staleTime: 0`): the door resolves "her latest open thread" from this, and the app's
 * default of Infinity would resume whichever thread was latest when the list was first read this session.
 */
export function useSessionsList(archived: boolean, enabled: boolean) {
  const query = useQuery<{ sessions: SessionSummary[] } | "unavailable">({
    queryKey: listKey(archived),
    enabled,
    staleTime: 0,
    queryFn: async () => {
      const url = new URL(BASE, getApiUrl());
      if (archived) url.searchParams.set("archived", "true");
      const res = await fetch(url.toString(), await authed());
      const read = listReadFor(res.status);
      if (read === "unavailable") return "unavailable";
      if (read === "error")
        throw new Error(`Couldn't load your threads (${res.status})`);
      return (await res.json()) as { sessions: SessionSummary[] };
    },
  });

  const answer = useMemo<ListAnswer>(() => {
    if (query.data === "unavailable") return { kind: "unavailable" };
    if (query.data) return { kind: "ok", sessions: query.data.sessions };
    if (query.isError) return { kind: "error" };
    return { kind: "loading" };
  }, [query.data, query.isError]);

  return { answer, refetch: query.refetch };
}

// ─── One thread ────────────────────────────────────────────────────────────────────────────────────────

export type ThreadState = "loading" | "ok" | "unclaimed" | "error";

/**
 * One thread, a page at a time: the newest 50 entries, then 50 more above them per "Load earlier".
 *
 * `unclaimed` is a thread nobody has appended to (see `threadReadFor`) — empty, and true. `error` is a read that
 * failed, which the screen must never render as empty.
 */
export function useThreadPages(sessionId: string, enabled: boolean) {
  const query = useInfiniteQuery<
    ThreadPage | "unclaimed",
    Error,
    InfiniteData<ThreadPage | "unclaimed", number | undefined>,
    readonly unknown[],
    number | undefined
  >({
    queryKey: threadKey(sessionId),
    enabled,
    staleTime: 0,
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const url = new URL(`${BASE}/${sessionId}`, getApiUrl());
      if (pageParam !== undefined)
        url.searchParams.set("before", String(pageParam));
      const res = await fetch(url.toString(), await authed());
      const read = threadReadFor(res.status);
      if (read === "unclaimed") return "unclaimed";
      if (read === "error")
        throw new Error(`Couldn't load this thread (${res.status})`);
      return (await res.json()) as ThreadPage;
    },
    getNextPageParam: (last) =>
      last === "unclaimed" ? undefined : (last.earlier ?? undefined),
  });

  const pages = useMemo<ThreadPage[]>(
    () =>
      (query.data?.pages ?? []).filter(
        (p): p is ThreadPage => p !== "unclaimed",
      ),
    [query.data],
  );
  const first = query.data?.pages[0];
  const state: ThreadState = !enabled
    ? "unclaimed"
    : first === "unclaimed"
      ? "unclaimed"
      : first
        ? "ok"
        : query.isError
          ? "error"
          : "loading";

  return {
    state,
    pages,
    session: pages[0]?.session ?? null,
    hasEarlier: query.hasNextPage,
    loadEarlier: query.fetchNextPage,
    loadingEarlier: query.isFetchingNextPage,
    earlierFailed: query.isFetchNextPageError,
    refetch: query.refetch,
  };
}

// ─── Saving ────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Sent =
  | { kind: "done"; sessionId: string | null }
  | { kind: "failed"; reason: "full" | "failed" };

/** One entry, tried up to 1 + MAX_APPEND_RETRIES times per `appendDisposition`. Never throws. */
async function sendEntry(sessionId: string, body: EntryBody): Promise<Sent> {
  for (let attempt = 0; attempt <= MAX_APPEND_RETRIES; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs(attempt));
    let status: number | "network" = "network";
    let answer: unknown = null;
    try {
      const res = await fetch(
        new URL(`${BASE}/${sessionId}/entries`, getApiUrl()).toString(),
        await authed({ method: "POST", body: JSON.stringify(body) }),
      );
      status = res.status;
      answer = await res.json().catch(() => null);
    } catch {
      status = "network";
    }
    const disposition = appendDisposition(status);
    const fields: Record<string, unknown> =
      typeof answer === "object" && answer !== null ? { ...answer } : {};
    if (disposition === "done") {
      return {
        kind: "done",
        sessionId:
          typeof fields.sessionId === "string" ? fields.sessionId : null,
      };
    }
    if (disposition === "fail")
      return {
        kind: "failed",
        reason: appendFailureReason(status, fields.field),
      };
  }
  return { kind: "failed", reason: "failed" };
}

/**
 * THE APPEND QUEUE — optimistic, one at a time, and never in the way (plan §4).
 *
 * The thread renders what she did the moment she does it; this saves it behind her. Appends go ONE AT A TIME per
 * thread, in the order she made them, because the server's `seq` is insertion order and that order IS the thread —
 * and because the 1000-entry cap is counted per append rather than locked, which is safe only while one client
 * appends to a thread at a time (the server half's §11). Each entry is retried per `appendDisposition`; one that
 * still fails is marked for a quiet "Not saved" and the queue moves on to the next, which never waits on a send or
 * a spend.
 *
 * It keeps draining after the screen unmounts: she can send and leave, and the entry still lands.
 *
 * `availability` is the list's answer (see `listReadFor`). While it is still `unknown` entries wait in the queue —
 * a send in the first moment of a thread is kept, not dropped — and drain the moment it says `on`. `off` (the
 * server has threads switched off) empties the queue and marks nothing: session-only, and nothing said.
 */
export type Availability = "unknown" | "on" | "off";

export function useAppendQueue(sessionId: string, availability: Availability) {
  const qc = useQueryClient();
  const queue = useRef<EntryBody[]>([]);
  const draining = useRef(false);
  /** The thread the queue writes to — the requested one, until the server says hers is another. */
  const target = useRef(sessionId);
  const mounted = useRef(true);
  const open = useRef(availability === "on");
  const [failed, setFailed] = useState<Record<string, "full" | "failed">>({});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const drain = useCallback(async () => {
    if (draining.current || !open.current) return;
    draining.current = true;
    while (queue.current.length) {
      const body = queue.current[0];
      const sent = await sendEntry(target.current, body);
      queue.current.shift();
      if (sent.kind === "done") {
        if (sent.sessionId) target.current = sent.sessionId;
      } else if (mounted.current) {
        setFailed((f) => ({ ...f, [body.id]: sent.reason }));
      }
    }
    draining.current = false;
    // The list's order and thumbnails moved; the door and Threads read it fresh.
    void qc.invalidateQueries({ queryKey: [...SESSIONS_KEY, "list"] });
  }, [qc]);

  useEffect(() => {
    open.current = availability === "on";
    if (availability === "off") queue.current = [];
    if (availability === "on") void drain();
  }, [availability, drain]);

  const append = useCallback(
    (body: EntryBody) => {
      if (availability === "off") return;
      queue.current.push(body);
      void drain();
    },
    [availability, drain],
  );

  return { append, failed };
}

/**
 * ONE PLAN ENTRY, AS THE SERVER NOW DERIVES IT — how a run lost to a dropped connection is found again
 * (`recoverLost`). The newest page is enough: the entry was appended when its preview landed, moments ago. Read
 * directly rather than through the thread's query, so the answer is this read's and not whichever the cache holds.
 */
export async function readPlanEntry(
  sessionId: string,
  entryId: string,
): Promise<WirePlanEntry | null | "error"> {
  try {
    const res = await fetch(
      new URL(`${BASE}/${sessionId}`, getApiUrl()).toString(),
      await authed(),
    );
    const read = threadReadFor(res.status);
    if (read === "unclaimed") return null;
    if (read === "error") return "error";
    const page = (await res.json()) as ThreadPage;
    const entry = page.entries.find((e) => e.id === entryId);
    return entry && entry.kind === "plan" ? entry : null;
  } catch {
    return "error";
  }
}

// ─── Archive ───────────────────────────────────────────────────────────────────────────────────────────

/** Archive or restore (D8: archive only — nothing is deleted). The lists re-read. */
export function useSetArchived() {
  const qc = useQueryClient();
  return useMutation<
    { session: WireSession },
    Error,
    { sessionId: string; archived: boolean }
  >({
    mutationFn: async ({ sessionId, archived }) => {
      const res = await fetch(
        new URL(`${BASE}/${sessionId}`, getApiUrl()).toString(),
        await authed({ method: "PATCH", body: JSON.stringify({ archived }) }),
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof detail?.error === "string"
            ? detail.error
            : `Couldn't update this thread (${res.status})`,
        );
      }
      return (await res.json()) as { session: WireSession };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...SESSIONS_KEY, "list"] });
    },
  });
}

// ─── Watching a run ────────────────────────────────────────────────────────────────────────────────────

/**
 * Ask one route about one run, and answer in ONE shape whatever was asked.
 *
 * Both routes are "reconnect and refresh only" — polling either never starts, resumes or advances
 * work, which is what keeps a paid provider call (and, for a stitch, this instance's memory) from
 * sitting behind a client retry loop.
 *
 * `map` is where the two shapes are reconciled, and it is the whole of the difference: the stitch
 * route answers `asset` (one file) where the job route answers `assets` (many), so
 * `jobReadFromStitch` turns one into a list of one. Nothing downstream learns that a clip can
 * arrive two ways.
 */
const READERS: Record<
  WatchKind,
  { path: (id: string) => string; map: (json: any) => JobRead }
> = {
  image: {
    path: (id) => `/api/v1/me/studio/jobs/${id}`,
    map: (json) => json as JobRead,
  },
  video: {
    path: (id) => `/api/v1/me/studio/jobs/${id}`,
    map: (json) => json as JobRead,
  },
  stitch: {
    path: (id) => `/api/v1/me/studio/stitch/${id}`,
    map: (json) => jobReadFromStitch(json as StitchRead),
  },
};

/**
 * A KIND SELECTS A READER, rather than readJob growing an `if`.
 *
 * `WatchKind` used to decide one thing — how long a watch may live — and now decides two. A branch
 * inside the fetch would have hidden the second one inside a function named for the first; a table
 * keyed by the kind puts both in view, and a third pipeline adds a row rather than an arm.
 */
async function readRun(
  id: string,
  kind: WatchKind = "image",
): Promise<JobRead | "missing" | "error"> {
  const reader = READERS[kind] ?? READERS.image;
  try {
    const res = await fetch(
      new URL(reader.path(id), getApiUrl()).toString(),
      await authed(),
    );
    if (res.status === 404) return "missing";
    if (!res.ok) return "error";
    return reader.map(await res.json());
  } catch {
    return "error";
  }
}

export interface Watch {
  /** The card it lands on. */
  key: string;
  jobId: string;
  /**
   * Defaulted to `image` when absent, so every caller that predates video keeps its exact clock,
   * its exact route and its exact behaviour. It decides two things: how long this watch may live
   * (`watchLimitMs`), and which route is read (`READERS`). For `stitch`, `jobId` is a stitch id.
   */
  kind?: WatchKind;
}

/**
 * THE RE-ATTACH (plan §4): every run the thread is waiting on, asked about every 3 s — only while the thread is on
 * screen — until `pollOutcome` says it has settled or ten minutes of watching have passed.
 *
 * A plain interval rather than a query: each answer is a decision (`onSettle`), not data to cache, and a query per
 * job would outlive the card it was for. A tick never overlaps the last one, and the ten-minute clock starts at a
 * watch's first tick and survives the thread losing focus, so leaving and coming back does not restart it.
 */
export function useRunWatch(
  watches: Watch[],
  onSettle: (
    key: string,
    outcome: Exclude<PollOutcome, "continue">,
    read: JobRead | null,
  ) => void,
  /**
   * WHERE A RUN HAS GOT TO, on every tick that learns something and settles nothing — `queued` or
   * `running`. Optional, and a caller that omits it gets precisely the hook that existed before
   * video: the thread does omit it, and is unchanged.
   *
   * It is not a second settlement and must never be treated as one. It fires repeatedly by design
   * — that is what watching a transition means — which is exactly why `onSettle` may not.
   */
  onProgress?: (key: string, phase: RunPhase, read: JobRead) => void,
) {
  const focused = useIsFocused();
  const startedAt = useRef(new Map<string, number>());
  /**
   * THE KEYS THIS MOUNT HAS ALREADY SETTLED — the fix for a leak that was real.
   *
   * `tick` had no per-key memory: it re-read every watch it was given and called `onSettle` on
   * EVERY tick whose outcome was not `continue`. That was survivable only because
   * CreateAnythingScreen's callback always changes state in a way that drops the watch out of the
   * `watches` memo — so the watch ended by a round trip through React rather than by any
   * termination condition of its own. A caller that does not complete that round trip is
   * re-notified every 3 seconds for the life of the mount, forever.
   *
   * The provisional Video tab is exactly such a caller, and a clip is watched for minutes rather
   * than the seconds an inline image takes, so the leak stops being theoretical. A settled key is
   * remembered here and skipped thereafter: `onSettle` fires ONCE per key, whatever the caller
   * then does or fails to do.
   */
  const settled = useRef(new Set<string>());
  const settle = useRef(onSettle);
  const progress = useRef(onProgress);
  const current = useRef(watches);
  useEffect(() => {
    settle.current = onSettle;
    progress.current = onProgress;
    current.current = watches;
  });
  const signature = watches.map((w) => `${w.key}:${w.jobId}`).join("|");

  /**
   * PRUNE WHAT IS NO LONGER WATCHED. Both maps are keyed by a card that does not outlive the
   * thread, and neither was ever cleaned — `startedAt` grew for the life of the mount. Dropping a
   * key here also means a watch legitimately re-opened later (a re-check of the same card) starts
   * a fresh clock rather than inheriting a dead one's.
   */
  useEffect(() => {
    // From the ref, like the tick below, so this effect's only dependency is the signature that
    // already describes exactly which watches exist.
    const live = new Set(current.current.map((w) => w.key));
    for (const key of startedAt.current.keys())
      if (!live.has(key)) startedAt.current.delete(key);
    for (const key of settled.current)
      if (!live.has(key)) settled.current.delete(key);
  }, [signature]);

  useEffect(() => {
    if (!focused || !signature) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      for (const w of current.current) {
        // Already ended. Not re-read, so a settled watch costs nothing at all — no request, no
        // callback — until its caller removes it.
        if (settled.current.has(w.key)) continue;
        if (!startedAt.current.has(w.key))
          startedAt.current.set(w.key, Date.now());
        const read = await readRun(w.jobId, w.kind);
        if (cancelled) break;
        const outcome = pollOutcome(
          read,
          startedAt.current.get(w.key) ?? Date.now(),
          Date.now(),
          w.kind,
        );
        if (outcome !== "continue") {
          settled.current.add(w.key);
          settle.current(
            w.key,
            outcome,
            typeof read === "object" ? read : null,
          );
          continue;
        }
        // Still going. `queued` after `running` lands here — the server's reaper handing the job
        // to another runner with the operation handle intact — and it is progress, not an ending:
        // no settle, no clock restart, nothing removed. A video going backwards is healthy.
        const phase = pollProgress(read);
        if (phase && typeof read === "object")
          progress.current?.(w.key, phase, read);
      }
      busy = false;
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [focused, signature]);
}
