/**
 * cameraRollPrepared.test — the app-open check (EXPO_PUBLIC_CAMERA_ROLL_INTAKE) with the phone faked:
 *
 *   it never asks for permission — no access, no look
 *   at most once every 6 hours; a few new items or it doesn't spend a preview
 *   a prepared review is kept (on the phone) and offered; a stale one is discarded with its previews
 *   a check that finds nothing worth keeping deletes its previews and doesn't pay for those items again
 *   the pure rules: shouldCheck, preparedFresh, offerLine, askForKit; and where a camera-roll link lands
 *
 * ⚠️ MUTATION: call requestPermissionsAsync in the check — "never asks" reds.
 */
const store = new Map<string, string>();
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: async (k: string) => store.get(k) ?? null,
  setItem: async (k: string, v: string) => { store.set(k, v); },
  removeItem: async (k: string) => { store.delete(k); },
}));
const getPermissionsAsync = jest.fn();
const requestPermissionsAsync = jest.fn();
const getAssetsAsync = jest.fn();
jest.mock("expo-media-library/legacy", () => ({
  MediaType: { photo: "photo", video: "video" },
  SortBy: { creationTime: "creationTime" },
  getPermissionsAsync: () => getPermissionsAsync(),
  requestPermissionsAsync: () => requestPermissionsAsync(),
  getAssetsAsync: (o: unknown) => getAssetsAsync(o),
}));
jest.mock("./flags", () => ({ CAMERA_ROLL_INTAKE: true }));
jest.mock("./reviewed-assets", () => ({ loadReviewedIds: async () => new Set(["old"]) }));
const runCameraRollReview = jest.fn();
const discardReview = jest.fn(async (_id: string) => {});
jest.mock("../hooks/use-camera-roll-review", () => ({
  runCameraRollReview: (...a: unknown[]) => runCameraRollReview(...a),
  discardReview: (id: string) => discardReview(id),
  isScreenshot: (a: { filename: string }) => /^screenshot/i.test(a.filename),
}));

import { Platform } from "react-native";
import { clearPrepared, loadPrepared, prepareOnAppOpen } from "./cameraRollPrepared";
import { subscribeOffer } from "./cameraRollOffer";
import { askForKit, offerLine, PREPARE_EVERY_MS, PREPARED_TTL_MS, preparedFresh, shouldCheck } from "./cameraRollIntakeLogic";
import { parseCameraRollAsk } from "../../shared/cameraRollIntake";
import { chatTargetFor, routeFor } from "./agent/navigate";
import { navTargetRoute } from "../navigation/shellTabs";

const A = "athlete-1";
const T0 = Date.UTC(2026, 9, 12, 8);
const asset = (id: string, filename = `${id}.jpg`) => ({ id, filename, mediaType: "photo", width: 1, height: 1, creationTime: 1 });
const outcome = (keep: string[], drop: string[] = []) => ({
  keep: keep.map((id) => ({ asset: asset(id), entry: { itemId: id, rank: 0.8, reason: "r", tags: {}, kind: id.startsWith("v") ? "video" : "photo" } })),
  more: [], drop: drop.map((id) => ({ asset: asset(id), drop: { itemId: id, reason: "r", code: "quality" } })),
  likenessAvailable: true, likenessNote: null, skipped: { screenshots: 0, alreadyReviewed: 0, tooLarge: 0 }, sessionId: "sess-1",
});

beforeAll(() => { Object.defineProperty(Platform, "OS", { get: () => "ios", configurable: true }); });
beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: "all" });
  getAssetsAsync.mockResolvedValue({ assets: ["a", "b", "c", "d", "e", "f"].map((id) => asset(id)) });
  runCameraRollReview.mockResolvedValue(outcome(["p1", "v1"]));
});

describe("the check", () => {
  it("never asks for permission: no access, no look", async () => {
    getPermissionsAsync.mockResolvedValue({ granted: false, accessPrivileges: "none" });
    expect(await prepareOnAppOpen(A, T0)).toBe("no_permission");
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(getAssetsAsync).not.toHaveBeenCalled();
  });

  it("\"selected photos only\": no quiet look (iOS would pop its select-more sheet on every open)", async () => {
    getPermissionsAsync.mockResolvedValue({ granted: true, accessPrivileges: "limited" });
    expect(await prepareOnAppOpen(A, T0)).toBe("no_permission");
    expect(getAssetsAsync).not.toHaveBeenCalled();
  });

  it("the quiet check only reads items already on the phone", async () => {
    await prepareOnAppOpen(A, T0);
    expect(runCameraRollReview).toHaveBeenCalledWith(expect.objectContaining({ onDeviceOnly: true }), expect.any(Function), true);
  });

  it("prepares a review from a few new items, keeps it on the phone, and tells the offer", async () => {
    const seen: unknown[] = [];
    const off = subscribeOffer((p) => seen.push([A, p?.outcome.sessionId ?? null]));
    expect(await prepareOnAppOpen(A, T0)).toBe("ready");
    off();
    expect(runCameraRollReview).toHaveBeenCalledWith(expect.objectContaining({ kind: "all", since: "last_review", scanLimit: 60 }), expect.any(Function), true);
    expect(seen).toEqual([[A, "sess-1"]]);
    expect((await loadPrepared(A, T0 + 1000))?.outcome.sessionId).toBe("sess-1");
  });

  it("a prepared review is offered again without another look, until it is used", async () => {
    await prepareOnAppOpen(A, T0);
    runCameraRollReview.mockClear();
    expect(await prepareOnAppOpen(A, T0 + 60_000)).toBe("ready");
    expect(runCameraRollReview).not.toHaveBeenCalled();
    await clearPrepared(A);
    expect(await loadPrepared(A, T0 + 60_000)).toBeNull();
  });

  it("at most once every 6 hours", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [asset("a")] });
    expect(await prepareOnAppOpen(A, T0)).toBe("nothing_new");
    expect(await prepareOnAppOpen(A, T0 + PREPARE_EVERY_MS - 1)).toBe("too_soon");
    expect(await prepareOnAppOpen(A, T0 + PREPARE_EVERY_MS)).toBe("nothing_new");
  });

  it("too few new items (screenshots and reviewed ones don't count): no preview is made", async () => {
    getAssetsAsync.mockResolvedValue({ assets: [asset("old"), asset("s1", "Screenshot_1.png"), asset("s2", "Screenshot_2.png"), asset("a"), asset("b"), asset("c"), asset("d")] });
    expect(await prepareOnAppOpen(A, T0)).toBe("nothing_new");
    expect(runCameraRollReview).not.toHaveBeenCalled();
  });

  it("nothing worth keeping: its previews are deleted and those items aren't paid for again", async () => {
    runCameraRollReview.mockResolvedValue(outcome([], ["x1", "x2"]));
    expect(await prepareOnAppOpen(A, T0)).toBe("nothing_worth");
    expect(discardReview).toHaveBeenCalledWith("sess-1");
    runCameraRollReview.mockResolvedValue(outcome(["p1"]));
    await prepareOnAppOpen(A, T0 + PREPARE_EVERY_MS);
    const seen = (runCameraRollReview.mock.calls[1][0] as { reviewedIds: Set<string> }).reviewedIds;
    expect([...seen].sort()).toEqual(["old", "x1", "x2"]);
  });

  it("a stale prepared review is discarded with its previews", async () => {
    await prepareOnAppOpen(A, T0);
    expect(await loadPrepared(A, T0 + PREPARED_TTL_MS + 1)).toBeNull();
    expect(discardReview).toHaveBeenCalledWith("sess-1");
  });

  it("no athlete: nothing", async () => {
    expect(await prepareOnAppOpen(null, T0)).toBe("off");
  });
});

describe("the pure rules", () => {
  it("another athlete signing in on this phone never sees the last one's offer", async () => {
    expect(await prepareOnAppOpen(A, T0)).toBe("ready");
    const seen: unknown[] = [];
    const off = subscribeOffer((p) => seen.push(p?.outcome.sessionId ?? null));
    getPermissionsAsync.mockResolvedValue({ granted: false, accessPrivileges: "none" });
    expect(await prepareOnAppOpen("athlete-2", T0)).toBe("no_permission");
    off();
    expect(seen).toEqual([null]);
  });

  it("shouldCheck / preparedFresh", () => {
    expect(shouldCheck(T0, null, false)).toBe(true);
    expect(shouldCheck(T0, T0 - PREPARE_EVERY_MS + 1, false)).toBe(false);
    expect(shouldCheck(T0, null, true)).toBe(false);
    expect([preparedFresh(T0, T0 + 1), preparedFresh(T0, T0 + PREPARED_TTL_MS), preparedFresh(T0 + 5, T0)]).toEqual([true, false, false]);
  });
  it("Mila's offer says what is waiting, never that she looked", () => {
    expect(offerLine(3, 1)).toBe("3 new photos and 1 video from your camera roll look worth adding. Review them?");
    expect(offerLine(0, 2)).toBe("2 new videos from your camera roll look worth adding. Review them?");
    expect(offerLine(1, 0)).not.toMatch(/\bI\b/);
  });
  it("a kit's ask: recent clips for a reel, both for a feed post, for that post", () => {
    expect(parseCameraRollAsk(askForKit("post-1", "reel"))).toEqual({ kind: "videos", since: "30d", forPost: "post-1" });
    expect(parseCameraRollAsk(askForKit("post-1", "feed"))).toEqual({ kind: "all", since: "30d", forPost: "post-1" });
  });
});

describe("where a camera-roll link lands", () => {
  it("an agent link, a chat card link and Mila's offer all open the review in Studio", () => {
    expect(routeFor({ screen: "camera-roll", id: "videos.7d" })).toEqual({ tab: "Studio", screen: "CameraRollReview", params: { ask: "videos.7d" } });
    expect(chatTargetFor({ screen: "camera-roll", id: "videos.7d" })).toEqual({ screen: "camera_roll", ask: "videos.7d" });
    expect(navTargetRoute({ screen: "camera_roll", ask: "videos.7d" })).toEqual({ kind: "tab", tab: "Studio", screen: "CameraRollReview", params: { ask: "videos.7d" } });
    expect(navTargetRoute({ screen: "camera_roll", prepared: true })).toEqual({ kind: "tab", tab: "Studio", screen: "CameraRollReview", params: { prepared: true } });
  });
});
