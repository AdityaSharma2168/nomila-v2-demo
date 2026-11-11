/**
 * download-asset.test — what the save helpers report, with the device and network faked (nothing is fetched):
 *   web     a cross-origin refusal opens a tab ("opened"), and a BLOCKED tab throws PopupBlockedError — never "opened"
 *   native  several files go into the photo library in one go: one permission ask, saved in order, stopping (and
 *           saying how many) at the first that fails
 */
import { Platform } from "react-native";
import { PopupBlockedError, saveRemoteAsset, saveRemoteAssetsToLibrary } from "./download-asset";

const downloadAsync = jest.fn();
jest.mock("expo-file-system/legacy", () => ({ cacheDirectory: "file:///cache/", downloadAsync: (...a: unknown[]) => downloadAsync(...a) }));
jest.mock("expo-sharing", () => ({ isAvailableAsync: async () => true, shareAsync: async () => {} }));
const requestPermissionsAsync = jest.fn();
const saveToLibraryAsync = jest.fn();
jest.mock("expo-media-library/legacy", () => ({
  requestPermissionsAsync: (...a: unknown[]) => requestPermissionsAsync(...a),
  saveToLibraryAsync: (...a: unknown[]) => saveToLibraryAsync(...a),
}));

let os = "web";
beforeAll(() => { Object.defineProperty(Platform, "OS", { get: () => os, configurable: true }); });
beforeEach(() => { downloadAsync.mockReset(); requestPermissionsAsync.mockReset(); saveToLibraryAsync.mockReset(); });

describe("web", () => {
  const g = globalThis as unknown as { fetch: unknown; window: { open: jest.Mock } };
  let saved: { fetch: unknown; window: unknown };
  beforeEach(() => {
    os = "web";
    saved = { fetch: g.fetch, window: g.window };
    g.fetch = jest.fn(async () => { throw new TypeError("cors"); });
  });
  afterEach(() => { g.fetch = saved.fetch; g.window = saved.window as typeof g.window; });

  test("a refused read opens a new tab, its opener cut", async () => {
    const tab = { opener: {} as unknown };
    g.window = { open: jest.fn(() => tab) };
    expect(await saveRemoteAsset("https://example.org/a.jpg?sig=x", "a.jpg")).toBe("opened");
    expect(g.window.open).toHaveBeenCalledWith("https://example.org/a.jpg?sig=x", "_blank");
    expect(tab.opener).toBeNull();
  });

  test("a blocked tab throws PopupBlockedError — never reported as opened", async () => {
    g.window = { open: jest.fn(() => null) };
    await expect(saveRemoteAsset("https://example.org/a.jpg", "a.jpg")).rejects.toBeInstanceOf(PopupBlockedError);
  });
});

describe("native, several files", () => {
  beforeEach(() => { os = "ios"; });
  const files = [{ url: "https://example.org/1.jpg", filename: "1.jpg" }, { url: "https://example.org/2.mp4", filename: "2.mp4" }, { url: "https://example.org/3.jpg", filename: "3.jpg" }];

  test("one permission ask, every file into the library in order", async () => {
    requestPermissionsAsync.mockResolvedValue({ granted: true });
    downloadAsync.mockImplementation(async (_u: string, to: string) => ({ status: 200, uri: to }));
    expect(await saveRemoteAssetsToLibrary(files)).toEqual({ saved: 3, stop: null });
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(saveToLibraryAsync.mock.calls.map((c) => c[0])).toEqual(["file:///cache/1.jpg", "file:///cache/2.mp4", "file:///cache/3.jpg"]);
  });

  test("permission refused: nothing downloaded", async () => {
    requestPermissionsAsync.mockResolvedValue({ granted: false });
    expect(await saveRemoteAssetsToLibrary(files)).toEqual({ saved: 0, stop: "permission" });
    expect(downloadAsync).not.toHaveBeenCalled();
  });

  test("a failure part-way stops there and says how many were saved", async () => {
    requestPermissionsAsync.mockResolvedValue({ granted: true });
    downloadAsync.mockResolvedValueOnce({ status: 200, uri: "file:///cache/1.jpg" }).mockResolvedValueOnce({ status: 403, uri: "file:///cache/2.mp4" });
    expect(await saveRemoteAssetsToLibrary(files)).toEqual({ saved: 1, stop: "failed" });
    expect(saveToLibraryAsync).toHaveBeenCalledTimes(1);
  });
});
