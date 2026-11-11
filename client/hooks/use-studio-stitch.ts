/**
 * use-studio-stitch — the wire for Pipeline 1 (upload → stitch → music).
 *
 * Three calls, and ONE of them is new server surface:
 *
 *   GET  /studio/stitch/options   what a timeline may be, and which beds exist. Static, $0.
 *   GET  /media?type=videos       her clips. ⚠️ THE EXISTING ROUTE, deliberately — see below.
 *   POST /studio/stitch           queue one. Answers 202 with an id to watch.
 *
 * ─── WHY THE PICKER READS /media AND NOT /studio/content ────────────────────────────────────────
 *
 * Because Pipeline 1 starts from her UPLOADS, and `studio/content.ts` filters `origin = 'generated'`
 * — the Made shelf is Studio's own output, by design. Widening that query would put raw uploads on
 * the Made shelf, which is a behaviour change to a surface this build does not own.
 *
 * `GET /media?type=videos` already answers exactly the question: athlete-scoped, `status='stored'`,
 * with `asset_id`, `video_url`, `duration_seconds` and an `origin` badge. So this pipeline adds no
 * route for the picker, and the temptation to add one is the thing to resist.
 *
 * ─── NOTHING HERE SPENDS ────────────────────────────────────────────────────────────────────────
 *
 * A stitch is one ffmpeg call: no provider, no model, no cost row, and therefore no preview and no
 * approval. There is no `previewId` in the POST body and there must never be one.
 */
import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import type {
  ClipChoice,
  StillChoice,
  StitchLimits,
  TimelineCaption,
} from "../screens/studio/stitchLogic";

export interface BedChoice {
  name: string;
  label: string;
  note: string;
  /** Credited in the picker. A CC0 author is owed nothing, and naming them is still right. */
  artist: string | null;
  /** Seconds, measured server-side. Bounds how far in she can start it. Absent on an older server. */
  durationSec?: number | null;
  /**
   * Where its beats fall, measured server-side once per track (studio/video/beatGrid.ts) — what a
   * stills edit on the Board is cut to. Null for a track nobody measured; absent on an older server.
   */
  beat?: { bpm: number; firstBeatSec: number } | null;
}

/** A name and what to call it. How loud each one IS stays on the server. */
export interface NamedChoice {
  name: string;
  label: string;
}

/**
 * The caption vocabulary, as the server declares it (server/studio/video/captions.ts).
 *
 * Nothing about captions is hardcoded on this side — not the positions, not the styles, not the
 * length, not the sentence shown when text is refused. Two copies of a closed set is two sets.
 */
export interface CaptionOptions {
  maxChars: number;
  maxLines: number;
  /** The server's own sentence for what a caption may contain. Shown as written. */
  rule: string;
  positions: (NamedChoice & { centreY: number })[];
  styles: (NamedChoice & {
    weight: number;
    color: string;
    uppercase: boolean;
    plate: string | null;
  })[];
  /** Optional: a server from before colours does not send them, and the editor shows no row. */
  colors?: (NamedChoice & { hex: string })[];
  geometry: {
    fontOverShortEdge: number;
    bandOverFont: number;
    sideMargin: number;
    lineHeight: number;
  };
  /** Optional: a server from before fonts (PR 8) does not send them, and the editor shows no row. */
  fonts?: (NamedChoice & { vibes: string[] })[];
  defaults: { position: string; style: string; color?: string; font?: string };
}

export interface StitchOptions {
  limits: StitchLimits;
  /** False until the bed objects are installed in the bucket. The picker says so rather than hiding. */
  ready: boolean;
  beds: BedChoice[];
  /**
   * Optional ON PURPOSE: an older server does not send these, and the tab must keep working against
   * one — no caption editor, no level pills, everything else as before.
   */
  levels?: NamedChoice[];
  defaultLevel?: string;
  captions?: CaptionOptions;
}

/** A 404 means the surface is not released on this server — the same reading useStudioContent takes. */
export type OptionsAnswer = StitchOptions | "unavailable";

export function useStitchOptions(enabled: boolean) {
  return useQuery<OptionsAnswer>({
    queryKey: ["studio", "stitch", "options"],
    enabled,
    // The caps and the bed list change on a deploy, not on a tick.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch(
        new URL("/api/v1/me/studio/stitch/options", getApiUrl()).toString(),
        { headers: await getAuthHeaders() },
      );
      if (res.status === 404) return "unavailable" as const;
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return (await res.json()) as StitchOptions;
    },
  });
}

/** One row of GET /studio/stitch/clips — already a clip, already signed, already in order. */
interface WireClip {
  assetId: string;
  videoUrl: string;
  posterUrl: string | null;
  durationSec: number | null;
  /**
   * ffprobe's measurement of the stored bytes, or null when nothing has measured this row.
   *
   * ⚠️ NULL IS LOAD-BEARING. The server serves null rather than falling back to the integer, on
   * purpose — so "measured 5.0" stays distinguishable from "asserted 5, never measured". Do not
   * collapse the two here either.
   */
  durationPreciseSec: number | null;
  origin: string | null;
}

/**
 * Where a clip came from, in her words rather than the column's. Exported so a surface that filters
 * on it (the Agent screen offers only her UPLOADED videos) reads the same words, not a second copy.
 */
export const ORIGIN_LABEL: Record<string, string> = {
  upload: "Uploaded",
  connected: "Instagram",
  generated: "Made here",
  discovery: "Discovery",
};

/**
 * The clips she can put on a timeline.
 *
 * ⚠️ STUDIO'S OWN LIST, NOT GET /media. That route sorts by `posted_at` and serves 24, and a clip
 * made here has no `posted_at` — so every generated clip sorted after every dated video, among
 * themselves by a random uuid, and on one measured library 9 of 31 were never offered. The server
 * now orders each row by its own date and has already dropped anything a stitch would refuse.
 *
 * ⚠️ REFETCHED ON EVERY MOUNT. The app's default `staleTime` is Infinity, and this list changes
 * whenever a clip finishes — on the Board, on another screen, on the runner's own tick. Cached for
 * the session, a clip made after she first opened this tab was not there until a reload. This
 * query alone is marked always-stale; the default stands for everything else.
 */
export function useStitchClips(enabled: boolean) {
  return useQuery<ClipChoice[]>({
    queryKey: ["studio", "stitch", "clips"],
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await fetch(
        new URL("/api/v1/me/studio/stitch/clips", getApiUrl()).toString(),
        { headers: await getAuthHeaders() },
      );
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { clips?: WireClip[] };
      return (json.clips ?? []).map((c) => ({
        assetId: c.assetId,
        videoUrl: c.videoUrl,
        posterUrl: c.posterUrl,
        durationSec: c.durationSec,
        durationPreciseSec: c.durationPreciseSec ?? null,
        origin: c.origin ? (ORIGIN_LABEL[c.origin] ?? c.origin) : null,
      }));
    },
  });
}

/** GET /studio/stitch/stills' row, as it arrives. */
interface WireStill {
  assetId: string;
  imageUrl: string;
  thumbUrl: string;
  origin: string | null;
}

/**
 * The photos she can hold on a timeline as stills.
 *
 * ⚠️ STUDIO'S OWN LIST, NOT GET /media — for the clips' reasons and one more: that route's page of 24
 * is never advanced (card 3), photos made here sort after every dated one, and it offers HEIC, which
 * a stitch refuses. The server has already dropped anything a still cannot be made from.
 *
 * Always-stale, like the clips: a photo made on another screen should be here when she comes back.
 */
export function useStitchStills(enabled: boolean) {
  return useQuery<StillChoice[]>({
    queryKey: ["studio", "stitch", "stills"],
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await fetch(
        new URL("/api/v1/me/studio/stitch/stills", getApiUrl()).toString(),
        { headers: await getAuthHeaders() },
      );
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { stills?: WireStill[] };
      return (json.stills ?? []).map((p) => ({
        assetId: p.assetId,
        imageUrl: p.imageUrl,
        thumbUrl: p.thumbUrl,
        origin: p.origin ? (ORIGIN_LABEL[p.origin] ?? p.origin) : null,
      }));
    },
  });
}

/**
 * A short-lived link to LISTEN to one bed — asked for when she taps play, never up front.
 *
 * Not in `useStitchOptions`: that answer is cached for the session and a signed URL expires in
 * minutes, so a link fetched with the list would be dead by the time she got round to the fourth
 * track. Null for a 404 — the name is not on the server's list, or no music is installed yet —
 * which the picker treats as "cannot play", not as a crash.
 */
export async function fetchBedPreviewUrl(name: string): Promise<string | null> {
  const res = await fetch(
    new URL(
      `/api/v1/me/studio/stitch/beds/${encodeURIComponent(name)}/preview`,
      getApiUrl(),
    ).toString(),
    { headers: await getAuthHeaders() },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return ((await res.json()) as { url: string }).url;
}

/**
 * The same, for the sound of one of HER videos. Athlete-scoped on the server: another athlete's
 * video and one that does not exist are both a 404, which is null here — "cannot play".
 */
export async function fetchSoundPreviewUrl(
  assetId: string,
): Promise<string | null> {
  const res = await fetch(
    new URL(
      `/api/v1/me/studio/stitch/sound/${encodeURIComponent(assetId)}/preview`,
      getApiUrl(),
    ).toString(),
    { headers: await getAuthHeaders() },
  );
  if (res.status === 404 || res.status === 409) return null;
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return ((await res.json()) as { url: string }).url;
}

/** The caption as the server drew it, placed as fractions of the player's box. */
export interface CaptionBand {
  uri: string;
  top: number;
  height: number;
}

/** A band to draw, or the server's own sentence for why it will not draw one. */
export type CaptionPreview =
  | { band: CaptionBand; refusal: null }
  | { band: null; refusal: string };

/** How long she has to stop typing before the caption is redrawn. */
const CAPTION_PREVIEW_DEBOUNCE_MS = 250;

/**
 * The caption, DRAWN BY THE SERVER, for laying over the preview player.
 *
 * ─── WHY THIS IS A REQUEST AND NOT A <Text> ─────────────────────────────────────────────────────
 *
 * The band that is burned into the video is drawn by server/studio/video/captionRender.ts, which
 * breaks long words and shrinks the text, by measuring, until it is two lines. A <Text> here cannot
 * know which size that lands on, so it would be most wrong exactly where it matters. This asks for
 * the SAME band from the same function — what she sees over the player is what ffmpeg is handed.
 * (The player itself still scales the clip differently from the final encode; it is the caption
 * that is exact, not the frame under it.)
 *
 * A 400 is not an error here, it is the ANSWER: her text has a character the font cannot draw, and
 * the server's sentence says what a caption can be. She sees it while typing instead of finding out
 * when she puts the timeline together.
 *
 * Spends nothing and stores nothing, and the same caption always draws the same band — so the
 * result never goes stale and is cached for the session.
 */
export function useCaptionPreview(
  caption: TimelineCaption | null,
  target: string,
) {
  // Debounced on the VALUE, so a burst of keystrokes is one request for the words she stopped on.
  const [settled, setSettled] = useState(caption);
  const text = caption?.text ?? null;
  const position = caption?.position ?? null;
  const style = caption?.style ?? null;
  const color = caption?.color;
  const font = caption?.font;
  useEffect(() => {
    const t = setTimeout(
      () =>
        setSettled(
          text === null
            ? null
            : {
                text,
                position: position!,
                style: style!,
                ...(color ? { color } : {}),
                ...(font ? { font } : {}),
              },
        ),
      CAPTION_PREVIEW_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [text, position, style, color, font]);

  return useQuery<CaptionPreview>({
    queryKey: [
      "studio",
      "stitch",
      "caption-preview",
      target,
      settled?.text,
      settled?.position,
      settled?.style,
      settled?.color,
      settled?.font,
    ],
    enabled: settled !== null,
    staleTime: Infinity,
    // The last band stays up while the next is drawn, so the caption does not blink on every word.
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => {
      const res = await fetch(
        new URL(
          "/api/v1/me/studio/stitch/caption-preview",
          getApiUrl(),
        ).toString(),
        {
          method: "POST",
          headers: {
            ...(await getAuthHeaders()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ caption: settled, target }),
        },
      );
      if (res.status === 400) {
        const json = (await res.json()) as { error?: string };
        return {
          band: null,
          refusal: json.error ?? "That caption can't be drawn",
        };
      }
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return { band: (await res.json()) as CaptionBand, refusal: null };
    },
  });
}

/**
 * A caption to start from, by rule (server/studio/video/captionSuggest.ts; PR 15, R-5): the Board's
 * row sentences in, the first sentence's leading clause out, or null. $0, nothing stored, and the same
 * words always give the same answer. Only asked with the composer on and the Board's words in hand —
 * with neither, no request and no chip.
 */
export function useCaptionSuggestion(
  feel: readonly string[],
  objective: string,
  enabled: boolean,
) {
  const key = JSON.stringify(feel);
  return useQuery<string | null>({
    queryKey: ["studio", "stitch", "caption-suggest", objective, key],
    enabled: enabled && key !== "[]",
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const res = await fetch(
        new URL(
          "/api/v1/me/studio/stitch/caption/suggest",
          getApiUrl(),
        ).toString(),
        {
          method: "POST",
          headers: {
            ...(await getAuthHeaders()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ feel, objective }),
        },
      );
      // An older server, or the flag off there: no suggestion, no chip, no error shown.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { suggestion?: string | null };
      return typeof json.suggestion === "string" ? json.suggestion : null;
    },
  });
}

/** The Board's "Suggested" track (server/studio/music/suggest.ts). */
export interface SuggestedTrack {
  name: string;
  label: string;
  /** Shown to her as written. */
  reason: string;
}

/** Her words settle before they are sent — one request for the sentence she stopped on. */
const MUSIC_SUGGEST_DEBOUNCE_MS = 600;

/**
 * The recommender's top pick for the words on her board, or null when they name no feel.
 *
 * Her row sentences are the feel (PR 8). Spends nothing and stores nothing; the same words always
 * give the same pick, so an answer is cached for the session. The objective travels so the server
 * can decide brand work itself, fail-closed — the client never filters the list.
 */
export function useMusicSuggestion(
  feel: string[],
  objective: string,
  enabled: boolean,
  /** The stored plan this board came from (PR 10, R-2): the server reads brand-ness off its brief and deal. */
  planId: string | null = null,
) {
  const key = JSON.stringify(feel);
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), MUSIC_SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key]);

  return useQuery<SuggestedTrack | null>({
    queryKey: ["studio", "stitch", "music-suggest", objective, planId, settled],
    enabled: enabled && settled !== "[]",
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => {
      const res = await fetch(
        new URL(
          "/api/v1/me/studio/stitch/music/suggest",
          getApiUrl(),
        ).toString(),
        {
          method: "POST",
          headers: {
            ...(await getAuthHeaders()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
          feel: JSON.parse(settled),
          objective,
          ...(planId ? { planId } : {}),
        }),
        },
      );
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return ((await res.json()) as { top: SuggestedTrack | null }).top;
    },
  });
}

export interface QueuedStitch {
  stitchId: string;
  status: string;
  limits: StitchLimits;
}

/** The server's refusal, carried through rather than replaced — it names the cap and the field. */
export class StitchRefusal extends Error {
  constructor(
    message: string,
    readonly field: string | null,
  ) {
    super(message);
    this.name = "StitchRefusal";
  }
}

export function useQueueStitch() {
  return useMutation<QueuedStitch, Error, Record<string, unknown>>({
    mutationFn: async (body) => {
      const res = await fetch(
        new URL("/api/v1/me/studio/stitch", getApiUrl()).toString(),
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
        // 400 / 404 / 409 all arrive with a sentence written for her; 500 does not.
        throw new StitchRefusal(
          json?.error ?? "Couldn't start that",
          json?.field ?? null,
        );
      }
      return json as QueuedStitch;
    },
  });
}
