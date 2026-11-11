/**
 * use-camera-roll-review.intake.test — the review run and the import with the phone faked (no device, no network):
 *
 *   OFF  photos only, the request bodies exactly as before (no kind, no target)
 *   ON   videos too — a video's preview is one phone-made frame; a build that can't make one skips videos and says
 *        so; screenshots, screen recordings, already-reviewed items and bursts never leave the phone; the target rides
 *        on the review call; the daily cap keeps what was scored and says why the rest wait
 *   IMPORT a kept video is uploaded as a video, with its length; only ticked items are uploaded at full size
 *   DISCARD deletes the previews at once
 *
 * ⚠️ MUTATION: send a video's original as its preview — "a video's preview is one phone-made frame" reds.
 */
const getAssetsAsync = jest.fn();
const getAssetInfoAsync = jest.fn(async (a: { id: string }, _o?: unknown): Promise<{ localUri?: string; isNetworkAsset?: boolean }> => ({ localUri: `file:///roll/${a.id}` }));
jest.mock("expo-media-library/legacy", () => ({
  MediaType: { photo: "photo", video: "video" },
  SortBy: { creationTime: "creationTime" },
  getAssetsAsync: (...a: unknown[]) => getAssetsAsync(...a),
  getAssetInfoAsync: (a: { id: string }, o?: unknown) => getAssetInfoAsync(a, o),
}));
const uploadAsync = jest.fn(async () => ({ status: 200 }));
jest.mock("expo-file-system/legacy", () => ({ uploadAsync: (...a: unknown[]) => uploadAsync(...(a as [])), FileSystemUploadType: { BINARY_CONTENT: 0 } }));
const makeReviewThumbnail = jest.fn(async (uri: string) => ({ uri: `${uri}.thumb.jpg`, resized: true, bytes: 40_000 }));
const makeVideoPreview = jest.fn(async (uri: string) => ({ uri: `${uri}.frame.jpg`, resized: true, bytes: 30_000 }));
let videoOk = true;
jest.mock("../lib/review-thumbnail", () => ({
  makeReviewThumbnail: (u: string) => makeReviewThumbnail(u),
  makeVideoPreview: (u: string) => makeVideoPreview(u),
  canResize: () => true,
  canPreviewVideo: () => videoOk,
}));
const calls: Array<{ method: string; route: string; body: any }> = [];
let reviewAnswer: (body: any) => unknown = () => ({ keep: [], more: [], drop: [], likenessAvailable: true, likenessNote: null });
let reviewError: Error | null = null;
jest.mock("../lib/query-client", () => ({
  apiRequest: jest.fn(async (method: string, route: string, body: any) => {
    calls.push({ method, route, body });
    if (route.endsWith("/review/upload-url")) return { json: async () => ({ gcsPath: `athletes/a/review/${body.sessionId}/${body.itemId}.review.jpg`, uploadUrl: "https://signed/put" }) };
    if (route.endsWith("/media/review")) { if (reviewError) throw reviewError; return { json: async () => reviewAnswer(body) }; }
    if (route.endsWith("/review/import")) return { json: async () => ({ imported: body.items.map((i: any, k: number) => ({ asset_id: `asset-${k}`, media_type: i.contentType.startsWith("video") ? "VIDEO" : "IMAGE" })), failed: [] }) };
    return { json: async () => ({}) };
  }),
}));
const mintAndPutOriginal = jest.fn(async (a: { mimeType: string; fileName: string }, _ack?: boolean) => ({ gcsPath: `athletes/a/uploads/${a.fileName}`, contentType: a.mimeType }));
jest.mock("./use-media-library", () => ({
  mintAndPutOriginal: (a: any, ack?: boolean) => mintAndPutOriginal(a, ack),
  RightsAckRequired: class RightsAckRequired extends Error {},
}));
jest.mock("../lib/flags", () => ({ CAMERA_ROLL_INTAKE: true }));

import { discardReview, importReviewedPhotos, itemIdFor, runCameraRollReview } from "./use-camera-roll-review";

const photo = (id: string, t: number, over: Record<string, unknown> = {}) => ({ id, filename: `${id}.HEIC`, uri: `ph://${id}`, mediaType: "photo", width: 3000, height: 4000, creationTime: t, duration: 0, ...over });
const video = (id: string, t: number, over: Record<string, unknown> = {}) => ({ id, filename: `${id}.MOV`, uri: `ph://${id}`, mediaType: "video", width: 1080, height: 1920, creationTime: t, duration: 12.4, ...over });

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  videoOk = true;
  reviewError = null;
  reviewAnswer = (body) => ({ keep: body.items.map((i: any) => ({ itemId: i.itemId, rank: 0.8, reason: "Looks great.", tags: { shot_type: "action", brand_safe: true, brands_visible: [], disposition: "as_is" }, kind: i.kind })), more: [], drop: [], likenessAvailable: true, likenessNote: null });
});

const reviewBodies = () => calls.filter((c) => c.route.endsWith("/media/review")).map((c) => c.body);

describe("OFF: photos only, as before", () => {
  it("asks the roll for photos and sends no kind and no target", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [photo("p1", 5000)] });
    await runCameraRollReview({ reviewedIds: new Set(), kind: "videos", target: { forPost: "x" } }, () => false, false);
    expect(getAssetsAsync.mock.calls[0][0]).toMatchObject({ mediaType: ["photo"] });
    expect(getAssetsAsync.mock.calls[0][0].createdAfter).toBeUndefined();
    expect(reviewBodies()[0]).toEqual({ sessionId: expect.any(String), items: [{ itemId: itemIdFor(photo("p1", 0) as any), gcsPath: expect.any(String), width: 3000, height: 4000, createdAt: expect.any(String) }] });
  });
});

describe("ON", () => {
  it("videos too: a video's preview is one phone-made frame, sent with its kind and length", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [video("v1", 9000), photo("p1", 5000)] });
    const out = await runCameraRollReview({ reviewedIds: new Set(), kind: "all", since: "7d" }, () => false, true);
    expect(getAssetsAsync.mock.calls[0][0]).toMatchObject({ mediaType: ["photo", "video"], createdAfter: expect.any(Number) });
    expect(makeVideoPreview).toHaveBeenCalledWith("file:///roll/v1");
    expect(makeReviewThumbnail).toHaveBeenCalledWith("file:///roll/p1");
    expect(uploadAsync.mock.calls.map((c: any[]) => c[1])).toEqual(["file:///roll/v1.frame.jpg", "file:///roll/p1.thumb.jpg"]);
    expect(reviewBodies()[0].items).toEqual([
      expect.objectContaining({ kind: "video", durationSec: 12.4 }),
      expect.objectContaining({ kind: "photo" }),
    ]);
    expect(out.keep.map((k) => k.asset.id)).toEqual(["v1", "p1"]);
  });

  it("a quiet check (onDeviceOnly) never downloads from iCloud: an offloaded item is skipped, not fetched", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [photo("p1", 9000), video("v1", 5000)] });
    getAssetInfoAsync.mockImplementation(async (a: { id: string }) => (a.id === "v1" ? { isNetworkAsset: true } : { localUri: `file:///roll/${a.id}`, isNetworkAsset: false }));
    await runCameraRollReview({ reviewedIds: new Set(), kind: "all", onDeviceOnly: true }, () => false, true);
    expect(getAssetInfoAsync.mock.calls.map((c) => c[1])).toEqual([{ shouldDownloadFromNetwork: false }, { shouldDownloadFromNetwork: false }]);
    expect(makeVideoPreview).not.toHaveBeenCalled();
    expect(reviewBodies()[0].items).toEqual([expect.objectContaining({ kind: "photo" })]);
    getAssetInfoAsync.mockImplementation(async (a: { id: string }) => ({ localUri: `file:///roll/${a.id}` }));
  });

  it("a build that can't make video previews skips videos and counts them", async () => {
    videoOk = false;
    getAssetsAsync.mockResolvedValue({ assets: [video("v1", 9000), photo("p1", 5000)] });
    const out = await runCameraRollReview({ reviewedIds: new Set(), kind: "all" }, () => false, true);
    expect(out.skipped.videosUnsupported).toBe(1);
    expect(reviewBodies()[0].items).toHaveLength(1);
  });

  it("screenshots, screen recordings, items already shown and bursts never leave the phone", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [
      photo("shot", 9000, { filename: "Screenshot_2026.png" }),
      video("rec", 8800, { filename: "ScreenRecording_01.MP4" }),
      photo("seen", 8000),
      photo("b1", 7000), photo("b2", 6500), photo("b3", 6100),
    ] });
    const out = await runCameraRollReview({ reviewedIds: new Set(["seen"]), kind: "all" }, () => false, true);
    expect(out.skipped).toMatchObject({ screenshots: 2, alreadyReviewed: 1, bursts: 2 });
    expect(reviewBodies()[0].items.map((i: any) => i.itemId)).toEqual([itemIdFor(photo("b1", 0) as any)]);
  });

  it("the target rides on the review call", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [video("v1", 9000)] });
    reviewAnswer = (body) => ({ keep: [], more: [], drop: [], likenessAvailable: true, likenessNote: null, lookingFor: "a short clip of the warm-up", _sent: body });
    const out = await runCameraRollReview({ reviewedIds: new Set(), kind: "videos", target: { forPost: "post-1" } }, () => false, true);
    expect(reviewBodies()[0].target).toEqual({ forPost: "post-1" });
    expect(out.lookingFor).toBe("a short clip of the warm-up");
  });

  it("the daily cap: keeps what was scored and says why the rest wait — never a crash", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [photo("p1", 9000)] });
    reviewError = new Error(`429: ${JSON.stringify({ error: "That's the most for today. The rest can be reviewed tomorrow.", code: "daily_limit", limit: 600, used: 600 })}`);
    const out = await runCameraRollReview({ reviewedIds: new Set() }, () => false, true);
    expect(out.limitNote).toMatch(/tomorrow/);
    expect(out.keep).toEqual([]);
  });

  it("any other failure is still a failure", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [photo("p1", 9000)] });
    reviewError = new Error("500: boom");
    await expect(runCameraRollReview({ reviewedIds: new Set() }, () => false, true)).rejects.toThrow("500: boom");
  });
});

describe("IMPORT", () => {
  it("only the ticked items are uploaded at full size; a video as a video, with its length", async () => {
    const v = video("v1", 9000) as any;
    const p = photo("p1", 5000) as any;
    const res = await importReviewedPhotos({ sessionId: "s1", photos: [{ asset: v, entry: { itemId: itemIdFor(v), rank: 0.9, reason: "r", tags: {} as any } }, { asset: p }] });
    expect(mintAndPutOriginal.mock.calls.map((c: any[]) => [c[0].type, c[0].mimeType])).toEqual([["video", "video/quicktime"], ["image", "image/heic"]]);
    const imported = calls.find((c) => c.route.endsWith("/review/import"))!.body.items;
    expect(imported[0]).toMatchObject({ contentType: "video/quicktime", durationSeconds: 12.4, rank: 0.9 });
    expect(imported[1]).toMatchObject({ contentType: "image/heic" });
    expect(imported[1].durationSeconds).toBeUndefined();
    expect(res.imported.map((i) => i.asset_id)).toEqual(["asset-0", "asset-1"]);
  });
});

describe("DISCARD", () => {
  it("asks the server to delete the session's previews now", async () => {
    await discardReview("s9");
    expect(calls).toEqual([{ method: "POST", route: "/api/v1/me/media/review/discard", body: { sessionId: "s9" } }]);
  });
});
