/**
 * preview — what a post kit's rendered preview (design §11 v2, build step 9; PostKitResponse.preview) gives a screen to
 * draw, and which files Share / Save takes. Pure apart from usePreviewState, so it is unit-tested without a server.
 *
 * The read carries the preview twice: `kit.preview` (the stored render: its outputs in order, each with the kit asset it
 * was cut from) and `preview` (the same outputs as fresh signed URLs, in the same order). Zipping the two gives each
 * rendered file its source asset, so a carousel's slide replaces the photo or clip it was made from.
 *
 *   ready      every screen shows the rendered file(s) instead of the raw chosen asset; Share / Save takes them
 *   preparing  queued: the raw asset, and a small "Preparing your preview" line (the read is polled until it lands)
 *   failed     the raw asset, and "Try again" (POST …/post-kit/preview) — also a preview still queued PREVIEW_STALL_MS
 *              after it was asked for: polling stops there, and she can ask again
 *   none       never asked for (the render is off, or a kit from before it): the raw asset, as before
 *
 * A rendered file whose URL is gone (the derived asset was removed) falls back to the raw asset for that one position;
 * a "ready" preview with nothing left to show reads as none.
 */
import { useEffect, useState } from "react";
import { POST_KIT_PREVIEW_STALL_MS, type PostFormat, type PostKitResponse } from "../../../shared/postKit";

export type PreviewState = "none" | "preparing" | "ready" | "failed";

/**
 * A preview still queued this long after it was asked for is treated as failed: polling stops, "Try again" shows — the
 * server's own stall window (shared/postKit.ts), so "Try again" re-asks a stall for real.
 */
export const PREVIEW_STALL_MS = POST_KIT_PREVIEW_STALL_MS;

/**
 * "Try again" answered, but the preview is the same stalled ask (same requestedAt): nothing was re-queued, so the screen
 * says so instead of seeming to ignore the tap.
 */
export function retryChangedNothing(before: PostKitResponse | null | undefined, after: PostKitResponse | null | undefined): boolean {
  const at = previewRequestedAt(after);
  return at !== null && at === previewRequestedAt(before) && previewStalled(after);
}

/** One rendered file as a screen draws it. `posterUrl` is the cover frame, on the output that carries it. */
export interface RenderedFile {
  /** The rendered (derived) asset's id: a stable cache key across re-signed URLs. */
  assetId: string;
  kind: "video" | "image";
  url: string;
  /** The kit asset it was cut from (a reel's: its opening position). */
  sourceAssetId: string;
  posterUrl: string | null;
}

/** A reel or story renders as ONE video; a feed post or carousel as one file per slide. */
export const isVideoFormat = (format: PostFormat): boolean => format === "reel" || format === "story";

/** Every rendered file still there, in order (outputs zipped with their signed URLs). */
export function renderedFiles(kit: PostKitResponse | null | undefined): RenderedFile[] {
  const stored = kit?.kit?.preview;
  const view = kit?.preview;
  if (!stored || !view || view.status !== "ready" || stored.status !== "ready") return [];
  const out: RenderedFile[] = [];
  stored.outputs.forEach((o, i) => {
    const item = view.items[i];
    if (!item?.url || item.kind !== o.kind) return;
    out.push({ assetId: o.assetId, kind: o.kind, url: item.url, sourceAssetId: o.sourceAssetId, posterUrl: o.assetId === stored.coverAssetId ? view.coverUrl : null });
  });
  return out;
}

/** When the preview on screen was asked for (ms since epoch), or null when there is none or it does not say. */
export function previewRequestedAt(kit: PostKitResponse | null | undefined): number | null {
  const at = kit?.kit?.preview?.requestedAt ? Date.parse(kit.kit.preview.requestedAt) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** A queued preview past PREVIEW_STALL_MS since it was asked for. */
export function previewStalled(kit: PostKitResponse | null | undefined, nowMs: number = Date.now()): boolean {
  const at = previewRequestedAt(kit);
  return kit?.preview?.status === "queued" && at !== null && nowMs - at >= PREVIEW_STALL_MS;
}

export function previewStateOf(kit: PostKitResponse | null | undefined, nowMs: number = Date.now()): PreviewState {
  const status = kit?.preview?.status;
  if (status === "queued") return previewStalled(kit, nowMs) ? "failed" : "preparing";
  if (status === "failed") return "failed";
  if (status === "ready") return renderedFiles(kit).length ? "ready" : "none";
  return "none";
}

/**
 * previewStateOf, kept current: a queued preview turns to failed at its stall deadline even when nothing else
 * re-renders the screen (polling has stopped by then).
 */
export function usePreviewState(kit: PostKitResponse | null | undefined): PreviewState {
  const [, tick] = useState(0);
  const at = kit?.preview?.status === "queued" ? previewRequestedAt(kit) : null;
  useEffect(() => {
    if (at === null) return;
    const left = at + PREVIEW_STALL_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [at]);
  return previewStateOf(kit);
}

/** A reel's or story's rendered video, when its preview is ready; null otherwise (and for a feed post or carousel). */
export function renderedReel(kit: PostKitResponse | null | undefined): RenderedFile | null {
  if (!kit?.kit || !isVideoFormat(kit.kit.idea.format)) return null;
  return renderedFiles(kit).find((f) => f.kind === "video") ?? null;
}

/** A feed post's or carousel's rendered slide for one of its assets, when ready; null otherwise. */
export function renderedSlide(kit: PostKitResponse | null | undefined, assetId: string): RenderedFile | null {
  if (!kit?.kit || isVideoFormat(kit.kit.idea.format)) return null;
  return renderedFiles(kit).find((f) => f.sourceAssetId === assetId) ?? null;
}

/** An asset's own file as it is in her library (the clip itself, else its photo), or null when it has gone. */
function sourceFile(kit: PostKitResponse, assetId: string): { uri: string; assetId: string } | null {
  const media = kit.media.find((m) => m.assetId === assetId);
  const uri = media?.available ? media.videoUrl ?? media.thumbUrl : null;
  return uri && media ? { uri, assetId: media.assetId } : null;
}

/**
 * What Share / Save saves, in order:
 *   a reel or story whose preview is ready   the rendered video
 *   a carousel or feed post whose preview is ready   every position in render order — its rendered slide, or, where
 *                                            that one file has gone, the asset it was cut from (an incomplete render
 *                                            never drops a slide she can still post)
 *   otherwise                                the first chosen asset's own file, as before
 * Empty when there is nothing to save.
 */
export function shareFilesOf(kit: PostKitResponse): { uri: string; assetId: string }[] {
  const stored = kit.kit?.preview;
  if (kit.kit && stored?.status === "ready" && kit.preview?.status === "ready") {
    if (isVideoFormat(kit.kit.idea.format)) {
      const reel = renderedReel(kit);
      if (reel) return [{ uri: reel.url, assetId: reel.assetId }];
    } else {
      const files = stored.outputs.flatMap((o, i) => {
        const url = kit.preview!.items[i]?.kind === o.kind ? kit.preview!.items[i]?.url : null;
        const f = url ? { uri: url, assetId: o.assetId } : sourceFile(kit, o.sourceAssetId);
        return f ? [f] : [];
      });
      if (files.length) return files;
    }
  }
  const first = kit.kit?.assets[0];
  const f = first ? sourceFile(kit, first.assetId) : null;
  return f ? [f] : [];
}
