/**
 * sharePostKit.test — the Share / Save flow on each platform, over the download helpers (mocked: nothing is fetched):
 *   web, one file      a blocked new tab is said plainly, never "opened"
 *   web, several       one download each, in order; a failure part-way says how many landed
 *   native, several    the photo library in one go (no sheet per slide)
 */
import { Platform } from "react-native";
import { SHARE_COPY, sharePostKit } from "./sharePostKit";
import { POST_KIT_CAROUSEL_READY, POST_KIT_FIXTURE } from "../../lib/agent/fixtures";

jest.mock("expo-clipboard", () => ({ setStringAsync: async () => {} }));
class Blocked extends Error {}
const saveRemoteAsset = jest.fn();
const saveRemoteAssetsToLibrary = jest.fn();
jest.mock("../../lib/download-asset", () => ({
  saveRemoteAsset: (...a: unknown[]) => saveRemoteAsset(...a),
  saveRemoteAssetsToLibrary: (...a: unknown[]) => saveRemoteAssetsToLibrary(...a),
  fileNameFor: (_u: string, id: string) => `nomila-${id}`,
  get PopupBlockedError() { return Blocked; },
}));

let os: string = "ios";
beforeAll(() => { Object.defineProperty(Platform, "OS", { get: () => os, configurable: true }); });
beforeEach(() => { os = "ios"; saveRemoteAsset.mockReset(); saveRemoteAssetsToLibrary.mockReset(); });

const copied = ` ${SHARE_COPY.copied}`;

test("web, one file: a blocked pop-up is said plainly — never reported as opened", async () => {
  os = "web";
  saveRemoteAsset.mockRejectedValueOnce(new Blocked("blocked"));
  expect(await sharePostKit(POST_KIT_FIXTURE)).toEqual({ fail: SHARE_COPY.blocked });
  saveRemoteAsset.mockResolvedValueOnce("opened");
  expect(await sharePostKit(POST_KIT_FIXTURE)).toEqual({ note: `${SHARE_COPY.opened}${copied}` });
});

test("web, several files: one download each, in order", async () => {
  os = "web";
  saveRemoteAsset.mockResolvedValue("saved");
  expect(await sharePostKit(POST_KIT_CAROUSEL_READY)).toEqual({ note: `${SHARE_COPY.savedMany(2)}${copied}` });
  expect(saveRemoteAsset.mock.calls.map((c) => c[0])).toEqual(["https://example.org/media/render-slide-1.jpg", "https://example.org/media/render-slide-2.mp4"]);
  expect(saveRemoteAssetsToLibrary).not.toHaveBeenCalled();
});

test("web, several files: a failure part-way says how many were saved; a blocked first one says it was blocked", async () => {
  os = "web";
  saveRemoteAsset.mockResolvedValueOnce("saved").mockRejectedValueOnce(new Error("network"));
  expect(await sharePostKit(POST_KIT_CAROUSEL_READY)).toEqual({ fail: SHARE_COPY.partial(1, 2) });
  saveRemoteAsset.mockRejectedValueOnce(new Blocked("blocked"));
  expect(await sharePostKit(POST_KIT_CAROUSEL_READY)).toEqual({ fail: SHARE_COPY.blocked });
  // Blocked after one landed: the count, and still why.
  saveRemoteAsset.mockResolvedValueOnce("saved").mockRejectedValueOnce(new Blocked("blocked"));
  expect(await sharePostKit(POST_KIT_CAROUSEL_READY)).toEqual({ fail: SHARE_COPY.partialBlocked(1, 2) });
});

test("native, several files: into the photo library in one call", async () => {
  saveRemoteAssetsToLibrary.mockResolvedValueOnce({ saved: 2, stop: null });
  expect(await sharePostKit(POST_KIT_CAROUSEL_READY)).toEqual({ note: `${SHARE_COPY.savedPhotos(2)}${copied}` });
  expect(saveRemoteAssetsToLibrary).toHaveBeenCalledTimes(1);
  expect(saveRemoteAsset).not.toHaveBeenCalled();
});

test("native, one file: the share sheet, as before", async () => {
  saveRemoteAsset.mockResolvedValueOnce("shared");
  expect(await sharePostKit(POST_KIT_FIXTURE)).toEqual({ note: SHARE_COPY.copied });
  expect(saveRemoteAssetsToLibrary).not.toHaveBeenCalled();
});

test("a kit with no caption yet: nothing is copied, and the note says so instead of \"Caption copied.\"", async () => {
  const clipboard = jest.requireMock("expo-clipboard") as { setStringAsync: (t: string) => Promise<void> };
  const spy = jest.spyOn(clipboard, "setStringAsync");
  saveRemoteAsset.mockResolvedValueOnce("shared");
  const empty = { ...POST_KIT_FIXTURE, kit: { ...POST_KIT_FIXTURE.kit!, caption: { text: "", hashtags: [], edited: false } } };
  expect(await sharePostKit(empty)).toEqual({ note: SHARE_COPY.noCaption });
  expect(spy).not.toHaveBeenCalled();
});
