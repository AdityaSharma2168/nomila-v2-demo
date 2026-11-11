/**
 * use-studio-publish — the three publish doors, from the client.
 *
 *   usePublishOptions(assetId)   GET  /studio/publish/options?assetId=
 *   useQueuePublish()            POST /studio/publish
 *   usePublishJob(publishId)     GET  /studio/publish/:publishId   — polled while the job is live
 *
 * The poll READS. The server's runner works the queue on its own tick; nothing here can start,
 * advance or repeat a post, which is why polling is safe to leave running.
 *
 * A 404 from /options is an ANSWER, not an error: an older server, or STUDIO_ENABLED off. The pill
 * draws nothing. STUDIO_PUBLISH_MODE=off arrives as { mode: "off" } and draws nothing either.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import {
  pollMs,
  type PublishJobWire,
  type PublishOptionsAnswer,
  type PublishOptionsWire,
} from "../screens/studio/publishLogic";

const optionsKey = (assetId: string | null) =>
  ["studio", "publish", "options", assetId] as const;

export function usePublishOptions(assetId: string | null) {
  return useQuery<PublishOptionsAnswer>({
    queryKey: optionsKey(assetId),
    enabled: !!assetId,
    // Whether she can post changes when she reconnects, not on a tick.
    staleTime: 60_000,
    queryFn: async () => {
      const url = new URL("/api/v1/me/studio/publish/options", getApiUrl());
      if (assetId) url.searchParams.set("assetId", assetId);
      const res = await fetch(url.toString(), {
        headers: await getAuthHeaders(),
      });
      if (res.status === 404) return "unavailable" as const;
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return (await res.json()) as PublishOptionsWire;
    },
  });
}

export interface QueuedPublish {
  publishId: string;
  status: string;
  alreadyLive: boolean;
  dryRun: boolean;
  handle: string | null;
}

/** The server's refusal, carried through rather than replaced — it is written for her. */
export class PublishRefusal extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "PublishRefusal";
  }
}

export function useQueuePublish(assetId: string | null) {
  const client = useQueryClient();
  return useMutation<QueuedPublish, Error, Record<string, unknown>>({
    mutationFn: async (body) => {
      const res = await fetch(
        new URL("/api/v1/me/studio/publish", getApiUrl()).toString(),
        {
          method: "POST",
          headers: {
            ...(await getAuthHeaders()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        throw new PublishRefusal(
          json?.error ?? "Couldn't start that post. Nothing was posted.",
          json?.code ?? null,
        );
      }
      return json as QueuedPublish;
    },
    // Approve-and-post changed the video's clearance, and a refusal may have changed what we know
    // about the account. Either way the options are stale.
    onSettled: () =>
      client.invalidateQueries({ queryKey: optionsKey(assetId) }),
  });
}

export function usePublishJob(publishId: string | null) {
  return useQuery<PublishJobWire | null>({
    queryKey: ["studio", "publish", "job", publishId],
    enabled: !!publishId,
    refetchInterval: (query) => pollMs(query.state.data ?? null),
    queryFn: async () => {
      const res = await fetch(
        new URL(
          `/api/v1/me/studio/publish/${publishId}`,
          getApiUrl(),
        ).toString(),
        { headers: await getAuthHeaders() },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return (await res.json()) as PublishJobWire;
    },
  });
}
