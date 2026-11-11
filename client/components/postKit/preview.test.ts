/**
 * preview.test — what a post kit's preview render gives the screens: its state, the reel or the slide for a position,
 * and what Share / Save takes (the rendered files when ready, the source asset otherwise).
 */
import {
  isVideoFormat, PREVIEW_STALL_MS, previewRequestedAt, previewStalled, previewStateOf, renderedFiles, renderedReel, renderedSlide, shareFilesOf,
} from "./preview";
import { POST_KIT_CAROUSEL_READY, POST_KIT_FIXTURE, POST_KIT_PREVIEW_READY, postKitPreviewAs } from "../../lib/agent/fixtures";
import type { PostKitResponse } from "../../../shared/postKit";

test("the state: none before it is asked for, preparing while queued, failed, ready", () => {
  expect(previewStateOf(POST_KIT_FIXTURE)).toBe("none");
  expect(previewStateOf(postKitPreviewAs(POST_KIT_FIXTURE, "queued"))).toBe("preparing");
  expect(previewStateOf(postKitPreviewAs(POST_KIT_FIXTURE, "failed"))).toBe("failed");
  expect(previewStateOf(POST_KIT_PREVIEW_READY)).toBe("ready");
  expect(previewStateOf(null)).toBe("none");
});

test("a ready preview whose files have all gone reads as none (the raw asset shows)", () => {
  const gone: PostKitResponse = { ...POST_KIT_PREVIEW_READY, preview: { ...POST_KIT_PREVIEW_READY.preview!, previewUrl: null, items: [{ kind: "video", url: null }] } };
  expect(renderedFiles(gone)).toEqual([]);
  expect(previewStateOf(gone)).toBe("none");
  expect(renderedReel(gone)).toBeNull();
});

test("a reel's preview: one rendered video with its cover frame as the poster; no per-slide renders", () => {
  expect(isVideoFormat("reel")).toBe(true);
  expect(isVideoFormat("carousel")).toBe(false);
  const reel = renderedReel(POST_KIT_PREVIEW_READY);
  expect(reel).toEqual({
    assetId: "render-reel-1", kind: "video", url: "https://example.org/media/render-reel-1.mp4", sourceAssetId: "asset-clip-1",
    posterUrl: "https://example.org/media/render-reel-1-cover.jpg",
  });
  expect(renderedSlide(POST_KIT_PREVIEW_READY, "asset-clip-1")).toBeNull();
});

test("a carousel's preview: each slide replaces the asset it was cut from; one gone slide falls back alone", () => {
  expect(renderedReel(POST_KIT_CAROUSEL_READY)).toBeNull();
  expect(renderedSlide(POST_KIT_CAROUSEL_READY, "asset-photo-1")).toMatchObject({ kind: "image", url: "https://example.org/media/render-slide-1.jpg" });
  expect(renderedSlide(POST_KIT_CAROUSEL_READY, "asset-clip-1")).toMatchObject({ kind: "video", url: "https://example.org/media/render-slide-2.mp4", posterUrl: null });
  const oneGone: PostKitResponse = { ...POST_KIT_CAROUSEL_READY, preview: { ...POST_KIT_CAROUSEL_READY.preview!, items: [POST_KIT_CAROUSEL_READY.preview!.items[0], { kind: "video", url: null }] } };
  expect(renderedSlide(oneGone, "asset-clip-1")).toBeNull();
  expect(renderedSlide(oneGone, "asset-photo-1")).not.toBeNull();
});

test("a stored render and a view that disagree (a stale read) never pair the wrong file", () => {
  const mismatch: PostKitResponse = { ...POST_KIT_CAROUSEL_READY, preview: { ...POST_KIT_CAROUSEL_READY.preview!, items: [{ kind: "video", url: "https://example.org/x.mp4" }] } };
  expect(renderedSlide(mismatch, "asset-photo-1")).toBeNull();
});

test("Share / Save takes the rendered reel when ready, every slide in order for a carousel, else the source asset", () => {
  expect(shareFilesOf(POST_KIT_PREVIEW_READY)).toEqual([{ uri: "https://example.org/media/render-reel-1.mp4", assetId: "render-reel-1" }]);
  expect(shareFilesOf(POST_KIT_CAROUSEL_READY)).toEqual([
    { uri: "https://example.org/media/render-slide-1.jpg", assetId: "render-slide-1" },
    { uri: "https://example.org/media/render-slide-2.mp4", assetId: "render-slide-2" },
  ]);
  expect(shareFilesOf(postKitPreviewAs(POST_KIT_FIXTURE, "queued"))).toEqual([{ uri: "https://example.org/media/clip-1.mp4", assetId: "asset-clip-1" }]);
  expect(shareFilesOf(postKitPreviewAs(POST_KIT_FIXTURE, "failed"))).toEqual([{ uri: "https://example.org/media/clip-1.mp4", assetId: "asset-clip-1" }]);
  expect(shareFilesOf({ ...POST_KIT_FIXTURE, media: POST_KIT_FIXTURE.media.map((m) => ({ ...m, available: false })) })).toEqual([]);
});

test("Share / Save on an incomplete carousel render: each gone slide falls back to its own source file, in render order", () => {
  const items = POST_KIT_CAROUSEL_READY.preview!.items;
  const firstGone: PostKitResponse = { ...POST_KIT_CAROUSEL_READY, preview: { ...POST_KIT_CAROUSEL_READY.preview!, items: [{ kind: "image", url: null }, items[1]] } };
  expect(shareFilesOf(firstGone)).toEqual([
    { uri: "https://example.org/media/photo-1.jpg", assetId: "asset-photo-1" },          // its source photo, in its place
    { uri: "https://example.org/media/render-slide-2.mp4", assetId: "render-slide-2" },
  ]);
  const allGone: PostKitResponse = { ...POST_KIT_CAROUSEL_READY, preview: { ...POST_KIT_CAROUSEL_READY.preview!, items: [{ kind: "image", url: null }, { kind: "video", url: null }] } };
  expect(shareFilesOf(allGone).map((f) => f.assetId)).toEqual(["asset-photo-1", "asset-clip-1"]);
  // A slide whose render AND source are both gone is the only one left out.
  const sourceGone: PostKitResponse = { ...firstGone, media: firstGone.media.map((m) => (m.assetId === "asset-photo-1" ? { ...m, available: false } : m)) };
  expect(shareFilesOf(sourceGone).map((f) => f.assetId)).toEqual(["render-slide-2"]);
  // A reel whose render has gone: the first chosen asset, as before.
  const reelGone: PostKitResponse = { ...POST_KIT_PREVIEW_READY, preview: { ...POST_KIT_PREVIEW_READY.preview!, items: [{ kind: "video", url: null }] } };
  expect(shareFilesOf(reelGone)).toEqual([{ uri: "https://example.org/media/clip-1.mp4", assetId: "asset-clip-1" }]);
});

test("a queued preview stalls at PREVIEW_STALL_MS after it was asked for, and then reads as failed", () => {
  const queued = postKitPreviewAs(POST_KIT_FIXTURE, "queued");
  const at = previewRequestedAt(queued)!;
  expect(previewStalled(queued, at + PREVIEW_STALL_MS - 1)).toBe(false);
  expect(previewStateOf(queued, at + PREVIEW_STALL_MS - 1)).toBe("preparing");
  expect(previewStalled(queued, at + PREVIEW_STALL_MS)).toBe(true);
  expect(previewStateOf(queued, at + PREVIEW_STALL_MS)).toBe("failed");
  // Only a queued one stalls; a ready one never does.
  expect(previewStalled(POST_KIT_PREVIEW_READY, Date.now() + 365 * 86_400_000)).toBe(false);
});
