/**
 * PostKitScreen.test — the idea/why/moment/goal tie-back, the chosen media (falling back to the asset itself when
 * there's no render yet), swap, caption edit, "I posted it" (behind a confirm tap), and the screen's loading / empty
 * (Build it) / error / closed / done states; write failures in plain words, a stale kit re-read, and the caches the
 * writes move (goals, the Studio library). All over the in-memory fixture API (client/lib/agent/fixtureApi.ts).
 */
import React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderAgent } from "../../test/agentHarness";
import { CONFIRM_POSTED_MS, PostKitScreen } from "./PostKitScreen";
import { buildOutcomeLine, POST_KIT_COPY } from "../../components/postKit/copy";
import { PREVIEW_STALL_MS } from "../../components/postKit/preview";
import { SHARE_COPY } from "../../components/postKit/sharePostKit";
import { AGENT_KEYS, PREVIEW_POLL_MS, previewRefetchInterval } from "../../lib/agent/hooks";
import { buildOutcomeOf, type PostKitBuildOutcome } from "../../lib/agent/api";
import type { FixtureApiOptions } from "../../lib/agent/fixtureApi";
import { POST_KIT_CAROUSEL_READY, POST_KIT_FIXTURE, POST_KIT_MUSIC_READY, POST_KIT_PREVIEW_READY, postKitPreviewAs } from "../../lib/agent/fixtures";
import type { PostKitResponse } from "../../../shared/postKit";

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-blur", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("expo-linear-gradient", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { LinearGradient: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("expo-video", () => {
  const React = require("react");
  return {
    useVideoPlayer: () => ({ play: () => {}, pause: () => {}, currentTime: 0, addListener: () => ({ remove: () => {} }), timeUpdateEventInterval: 0 }),
    VideoView: (p: Record<string, unknown>) => React.createElement(require("react-native").View, p),
  };
});
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const setStringAsync = jest.fn(async (_s: string) => {});
jest.mock("expo-clipboard", () => ({ setStringAsync: (s: string) => setStringAsync(s) }));
const saveRemoteAsset = jest.fn(async (..._a: unknown[]) => "saved" as const);
const saveRemoteAssetsToLibrary = jest.fn(async (files: Array<{ url: string }>) => ({ saved: files.length, stop: null as "permission" | "failed" | null }));
jest.mock("../../lib/download-asset", () => ({
  saveRemoteAsset: (...a: unknown[]) => saveRemoteAsset(...a),
  saveRemoteAssetsToLibrary: (f: Array<{ url: string }>) => saveRemoteAssetsToLibrary(f),
  fileNameFor: () => "post.jpg",
  PopupBlockedError: class extends Error {},
}));
const audio = { replace: jest.fn(), play: jest.fn(), pause: jest.fn() };
jest.mock("expo-audio", () => ({ useAudioPlayer: () => audio, useAudioPlayerStatus: () => ({ didJustFinish: false }) }));
const goBack = jest.fn();
let focused = true;
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack }), useIsFocused: () => focused }));

beforeEach(() => { focused = true; goBack.mockClear(); setStringAsync.mockClear(); saveRemoteAsset.mockClear(); saveRemoteAssetsToLibrary.mockClear(); });

const ROUTE = { params: { id: "studio-postkit-1" } };
const render = (postKits: Record<string, PostKitResponse>, more: FixtureApiOptions = {}) => renderAgent(<PostKitScreen route={ROUTE} />, { opts: { postKits, ...more } });
const KITS = { "studio-postkit-1": POST_KIT_FIXTURE };
const DONE: PostKitResponse = { ...POST_KIT_FIXTURE, state: "done" };

test("loading, then the idea, the moment and goal tie-back, and why", async () => {
  render({ "studio-postkit-1": POST_KIT_FIXTURE });
  expect(screen.getByTestId("post-kit-loading")).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId("post-kit-idea")).toBeTruthy());
  expect(screen.getByText(POST_KIT_FIXTURE.kit!.idea.hook)).toBeTruthy();
  expect(screen.getByTestId("post-kit-moment")).toBeTruthy();
  expect(screen.getByText(`${POST_KIT_COPY.timedFor(POST_KIT_FIXTURE.moment!.name)} — ${POST_KIT_FIXTURE.moment!.whyNow}`)).toBeTruthy();
  expect(screen.getByText(POST_KIT_COPY.forGoal(POST_KIT_FIXTURE.goal!.text))).toBeTruthy();
  expect(screen.getByText(POST_KIT_FIXTURE.why)).toBeTruthy();
});

test("nothing built yet: an empty state with Build it, which runs the build and draws the kit", async () => {
  const { api } = render({ "studio-postkit-1": { ...POST_KIT_FIXTURE, state: "to_start", kit: null } });
  await waitFor(() => expect(screen.getByTestId("post-kit-empty")).toBeTruthy());
  fireEvent.press(screen.getByTestId("post-kit-build"));
  await waitFor(() => expect(api.postKitWrite).toHaveBeenCalledWith({ op: "build", id: "studio-postkit-1" }));
  await waitFor(() => expect(screen.getByTestId("post-kit-idea")).toBeTruthy());
});

test("a failed build says so in plain words, never the server's message", async () => {
  render({ "studio-postkit-1": { ...POST_KIT_FIXTURE, state: "to_start", kit: null } }, { postKitFailures: { build: { status: 500, code: "x" } } });
  await waitFor(() => expect(screen.getByTestId("post-kit-build")).toBeTruthy());
  fireEvent.press(screen.getByTestId("post-kit-build"));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failBuild)).toBeTruthy());
});

test("an expired or skipped action (409 closed) reads as no longer open, with no Retry", async () => {
  render(KITS, { postKitFailures: { read: { status: 409, code: "closed" } } });
  await waitFor(() => expect(screen.getByTestId("post-kit-closed")).toBeTruthy());
  expect(screen.getByText(POST_KIT_COPY.closedTitle)).toBeTruthy();
  expect(screen.queryByTestId("post-kit-retry")).toBeNull();
  expect(screen.queryByTestId("post-kit-error")).toBeNull();
});

test("the dark route (post kits off, 404) reads as an error, not a blank screen", async () => {
  render({}); // the fixture's "not present" = 404
  await waitFor(() => expect(screen.getByTestId("post-kit-dark")).toBeTruthy());
});

test("a read failure shows the error state, and Retry tries again", async () => {
  const { api } = renderAgent(<PostKitScreen route={ROUTE} />, { opts: { fail: true } });
  await waitFor(() => expect(screen.getByTestId("post-kit-error")).toBeTruthy());
  fireEvent.press(screen.getByText("Retry"));
  await waitFor(() => expect(api.readPostKit).toHaveBeenCalledTimes(2));
});

test("no preview yet: the chosen clip plays inline within its clip range, not a raw full clip", async () => {
  render({ "studio-postkit-1": POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId("post-kit-asset-clip")).toBeTruthy());
});

test("a gone asset reads plainly, never as someone else's", async () => {
  render({ "studio-postkit-1": { ...POST_KIT_FIXTURE, media: POST_KIT_FIXTURE.media.map((m) => ({ ...m, available: false })) } });
  await waitFor(() => expect(screen.getByTestId("post-kit-asset-missing")).toBeTruthy());
});

test("swap: picking a shortlist option replaces the asset", async () => {
  const { api } = render({ "studio-postkit-1": POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId("post-kit-swap-asset-clip-1")).toBeTruthy());
  fireEvent.press(screen.getByTestId("post-kit-swap-asset-clip-1"));
  await waitFor(() => expect(screen.getByTestId("post-kit-swap-option-asset-photo-1")).toBeTruthy());
  fireEvent.press(screen.getByTestId("post-kit-swap-option-asset-photo-1"));
  await waitFor(() => expect(api.postKitWrite).toHaveBeenCalledWith({ op: "swap", id: "studio-postkit-1", replace: "asset-clip-1", with: "asset-photo-1" }));
  await waitFor(() => expect(screen.queryByTestId("post-kit-swap-sheet")).toBeNull());
});

test("swap: an option that no longer fits says so inside the sheet, which stays open to pick again", async () => {
  render(KITS, { postKitFailures: { swap: { status: 409, code: "unavailable" } } });
  await waitFor(() => expect(screen.getByTestId("post-kit-swap-asset-clip-1")).toBeTruthy());
  fireEvent.press(screen.getByTestId("post-kit-swap-asset-clip-1"));
  fireEvent.press(await screen.findByTestId("post-kit-swap-option-asset-photo-1"));
  await waitFor(() => expect(screen.getByTestId("post-kit-swap-error")).toBeTruthy());
  expect(screen.getByText(POST_KIT_COPY.failSwapOption)).toBeTruthy();
  expect(screen.getByTestId("post-kit-swap-sheet")).toBeTruthy();
});

test("swap: 409 done (posted elsewhere) closes the sheet, says why, and re-reads the kit", async () => {
  const { api } = render(KITS, { postKitFailures: { swap: { status: 409, code: "done" } } });
  await waitFor(() => expect(screen.getByTestId("post-kit-swap-asset-clip-1")).toBeTruthy());
  expect(api.readPostKit).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByTestId("post-kit-swap-asset-clip-1"));
  fireEvent.press(await screen.findByTestId("post-kit-swap-option-asset-photo-1"));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failDone)).toBeTruthy());
  expect(screen.queryByTestId("post-kit-swap-sheet")).toBeNull();
  await waitFor(() => expect(api.readPostKit).toHaveBeenCalledTimes(2));
});

test("caption: a 400 (too long) reads in plain words; the edit stays to fix", async () => {
  render(KITS, { postKitFailures: { caption: { status: 400, code: "too_long" } } });
  await waitFor(() => expect(screen.getByTestId("post-kit-caption-input")).toBeTruthy());
  fireEvent.changeText(screen.getByTestId("post-kit-caption-input"), "Too long, says the server.");
  fireEvent.press(screen.getByTestId("post-kit-caption-save"));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failCaptionLong)).toBeTruthy());
  expect(screen.getByTestId("post-kit-caption-input").props.value).toBe("Too long, says the server.");
});

test("a 409 conflict on a write re-reads the kit and says it changed", async () => {
  const { api } = render(KITS, { postKitFailures: { caption: { status: 409, code: "conflict" } } });
  await waitFor(() => expect(screen.getByTestId("post-kit-caption-input")).toBeTruthy());
  fireEvent.changeText(screen.getByTestId("post-kit-caption-input"), "Mine.");
  fireEvent.press(screen.getByTestId("post-kit-caption-save"));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failConflict)).toBeTruthy());
  await waitFor(() => expect(api.readPostKit).toHaveBeenCalledTimes(2));
});

test("caption: editing shows Save, which writes the new text", async () => {
  const { api } = render({ "studio-postkit-1": POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId("post-kit-caption-input")).toBeTruthy());
  expect(screen.queryByTestId("post-kit-caption-save")).toBeNull();
  fireEvent.changeText(screen.getByTestId("post-kit-caption-input"), "My own words.");
  expect(screen.getByTestId("post-kit-caption-save")).toBeTruthy();
  fireEvent.press(screen.getByTestId("post-kit-caption-save"));
  await waitFor(() => expect(api.postKitWrite).toHaveBeenCalledWith({ op: "caption", id: "studio-postkit-1", text: "My own words." }));
});

test("\"I posted it\": the first tap only asks; the second records it; then Posted, disabled, read-only", async () => {
  const { api, qc } = render(KITS);
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  await waitFor(() => expect(screen.getByTestId("post-kit-posted")).toBeTruthy());
  fireEvent.press(screen.getByTestId("post-kit-posted"));
  expect(screen.getByText(POST_KIT_COPY.confirmPosted)).toBeTruthy();
  expect(screen.getByTestId("post-kit-confirm-line")).toBeTruthy();
  expect(api.postKitWrite).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId("post-kit-posted"));
  await waitFor(() => expect(api.postKitWrite).toHaveBeenCalledWith({ op: "posted", id: "studio-postkit-1" }));
  await waitFor(() => expect(screen.getByTestId("post-kit-posted").props.accessibilityState.disabled).toBe(true));
  expect(screen.getByText(POST_KIT_COPY.done)).toBeTruthy();
  // The Goals tab and the Studio library read again: the action is answered, the item is published.
  expect(invalidate).toHaveBeenCalledWith({ queryKey: AGENT_KEYS.goals });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agent", "studio"] });
});

test("\"I posted it\": an unconfirmed first tap goes back after a few seconds and records nothing", async () => {
  jest.useFakeTimers();
  try {
    const { api } = render(KITS);
    await waitFor(() => expect(screen.getByTestId("post-kit-posted")).toBeTruthy());
    fireEvent.press(screen.getByTestId("post-kit-posted"));
    expect(screen.getByText(POST_KIT_COPY.confirmPosted)).toBeTruthy();
    act(() => { jest.advanceTimersByTime(CONFIRM_POSTED_MS + 10); });
    expect(screen.getByText(POST_KIT_COPY.posted)).toBeTruthy();
    expect(api.postKitWrite).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test("\"I posted it\" failing reads in plain words and the button can be tried again", async () => {
  render(KITS, { postKitFailures: { posted: { status: 500, code: "x" } } });
  await waitFor(() => expect(screen.getByTestId("post-kit-posted")).toBeTruthy());
  fireEvent.press(screen.getByTestId("post-kit-posted"));
  fireEvent.press(screen.getByTestId("post-kit-posted"));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failPosted)).toBeTruthy());
  expect(screen.getByTestId("post-kit-posted").props.accessibilityState.disabled).toBe(false);
});

test("done: no Swap, the caption is read-only text, no Save", async () => {
  render({ "studio-postkit-1": DONE });
  await waitFor(() => expect(screen.getByTestId("post-kit-done-line")).toBeTruthy());
  expect(screen.queryByTestId("post-kit-swap-asset-clip-1")).toBeNull();
  expect(screen.queryByTestId("post-kit-caption-input")).toBeNull();
  expect(screen.getByTestId("post-kit-caption-text")).toBeTruthy();
  expect(screen.queryByTestId("post-kit-caption-save")).toBeNull();
  expect(screen.getByTestId("post-kit-posted").props.accessibilityState.disabled).toBe(true);
});

test("swap and caption writes also refresh the goals and the Studio library", async () => {
  const { qc } = render(KITS);
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  await waitFor(() => expect(screen.getByTestId("post-kit-caption-input")).toBeTruthy());
  fireEvent.changeText(screen.getByTestId("post-kit-caption-input"), "Mine.");
  fireEvent.press(screen.getByTestId("post-kit-caption-save"));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agent", "studio"] }));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: AGENT_KEYS.goals });
});

test("one clip plays at a time; a photo is not a Play button", async () => {
  const twoClips: PostKitResponse = {
    ...POST_KIT_FIXTURE,
    kit: { ...POST_KIT_FIXTURE.kit!, assets: [...POST_KIT_FIXTURE.kit!.assets, { assetId: "asset-clip-2", mediaType: "clip", clip: { startSec: 0, endSec: 3, from: "opening" }, durationSec: 8, provenance: "camera" }, { assetId: "asset-photo-2", mediaType: "photo", clip: null, durationSec: null, provenance: "camera" }] },
    media: [...POST_KIT_FIXTURE.media, { assetId: "asset-clip-2", mediaType: "clip", thumbUrl: "https://example.org/c2.jpg", videoUrl: "https://example.org/c2.mp4", available: true, inKit: true }, { assetId: "asset-photo-2", mediaType: "photo", thumbUrl: "https://example.org/p2.jpg", videoUrl: null, available: true, inKit: true }],
  };
  render({ "studio-postkit-1": twoClips });
  await waitFor(() => expect(screen.getAllByTestId("post-kit-asset-clip")).toHaveLength(1));
  expect(screen.queryByTestId("post-kit-play-asset-photo-2")).toBeNull();
  expect(screen.queryByLabelText("Play")).toBeNull();
  fireEvent.press(screen.getByTestId("post-kit-play-asset-clip-2"));
  await waitFor(() => expect(screen.getAllByTestId("post-kit-asset-clip")).toHaveLength(1));
  expect(screen.getByTestId("post-kit-play-asset-clip-2").props.accessibilityLabel).toBe(POST_KIT_COPY.playClip);
  expect(screen.getByTestId("post-kit-play-asset-clip-1").props.accessibilityLabel).toBe(POST_KIT_COPY.showClip);
});

test("Share / Save: saves the chosen media and copies the caption", async () => {
  render({ "studio-postkit-1": POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId("post-kit-share")).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByTestId("post-kit-share")); });
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalled());
  expect(setStringAsync).toHaveBeenCalledWith(POST_KIT_FIXTURE.kit!.caption.text);
  await waitFor(() => expect(screen.getByTestId("post-kit-notice")).toBeTruthy());
});

test("Share / Save failing reads in plain words, never the thrown message", async () => {
  saveRemoteAsset.mockImplementationOnce(async () => { throw new Error("403 SignatureDoesNotMatch <xml>"); });
  render(KITS);
  await waitFor(() => expect(screen.getByTestId("post-kit-share")).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByTestId("post-kit-share")); });
  await waitFor(() => expect(screen.getByText(SHARE_COPY.failed)).toBeTruthy());
  expect(screen.queryByText(/SignatureDoesNotMatch/)).toBeNull();
});

test("Share / Save with nothing to save still copies the caption and says so", async () => {
  render({ "studio-postkit-1": { ...POST_KIT_FIXTURE, media: POST_KIT_FIXTURE.media.map((m) => ({ ...m, available: false })) } });
  await waitFor(() => expect(screen.getByTestId("post-kit-share")).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByTestId("post-kit-share")); });
  await waitFor(() => expect(screen.getByText(`${SHARE_COPY.noMedia} ${SHARE_COPY.copied}`)).toBeTruthy());
  expect(saveRemoteAsset).not.toHaveBeenCalled();
  expect(setStringAsync).toHaveBeenCalled();
});

// ─── "Build it" made nothing: why, in plain words ─────────────────────────────────────────────────────────────────

const UNBUILT = { "studio-postkit-1": { ...POST_KIT_FIXTURE, state: "to_start" as const, kit: null } };

test.each([
  [{ status: "held", reason: "never_content" }, POST_KIT_COPY.buildHeld],
  [{ status: "held", reason: "final_guard", block: "never_content" }, POST_KIT_COPY.buildHeld],
  [{ status: "held", reason: "final_guard", block: "care_text" }, POST_KIT_COPY.buildHeld],
  [{ status: "held", reason: "final_guard", block: "number_is_the_point" }, POST_KIT_COPY.buildHeldNumber],
  [{ status: "held", reason: "final_guard", block: "on_card" }, POST_KIT_COPY.buildHeldOnCard],
  [{ status: "held", reason: "final_guard", block: "nothing_left" }, POST_KIT_COPY.buildHeldNothingLeft],
  [{ status: "skipped", reason: "day_cap" }, POST_KIT_COPY.buildDayCap],
  [{ status: "skipped", reason: "week_cap" }, POST_KIT_COPY.buildWeekCap],
  [{ status: "skipped", reason: "week_count" }, POST_KIT_COPY.buildWeekCount],
  [{ status: "conflict" }, POST_KIT_COPY.buildChanged],
] as Array<[PostKitBuildOutcome, string]>)("a build answered %j says why under Build it, and nothing is drawn as built", async (outcome, line) => {
  render(UNBUILT, { postKitBuildOutcome: outcome });
  fireEvent.press(await screen.findByTestId("post-kit-build"));
  await waitFor(() => expect(screen.getByText(line)).toBeTruthy());
  expect(screen.getByTestId("post-kit-empty")).toBeTruthy();
  expect(screen.getByTestId("post-kit-build")).toBeTruthy();
});

test("buildOutcomeLine: an unknown or missing outcome is the plain \"couldn't build\"", () => {
  expect(buildOutcomeLine(null)).toBe(POST_KIT_COPY.failBuild);
  expect(buildOutcomeLine({ status: "built" })).toBe(POST_KIT_COPY.failBuild);
});

test("buildOutcomeOf reads the route's outcome defensively", () => {
  expect(buildOutcomeOf({ status: "held", reason: "never_content", decisionId: "d" })).toEqual({ status: "held", reason: "never_content" });
  expect(buildOutcomeOf({ status: "skipped", reason: "something_new" })).toEqual({ status: "skipped" });
  // The final guard's hold is read, with its block; an unknown block is dropped.
  expect(buildOutcomeOf({ status: "held", reason: "final_guard", block: "number_is_the_point" })).toEqual({ status: "held", reason: "final_guard", block: "number_is_the_point" });
  expect(buildOutcomeOf({ status: "held", reason: "final_guard", block: "made_up" })).toEqual({ status: "held", reason: "final_guard" });
  expect(buildOutcomeOf({ status: "exploded" })).toBeNull();
  expect(buildOutcomeOf(undefined)).toBeNull();
  expect(buildOutcomeOf("held")).toBeNull();
});

// ─── Share / Save with an unsaved caption ─────────────────────────────────────────────────────────────────────────

test("Share / Save with an unsaved caption saves it first, then copies the words on screen", async () => {
  const { api } = render(KITS);
  fireEvent.changeText(await screen.findByTestId("post-kit-caption-input"), "My own words, not saved yet.");
  await act(async () => { fireEvent.press(screen.getByTestId("post-kit-share")); });
  await waitFor(() => expect(setStringAsync).toHaveBeenCalledWith("My own words, not saved yet."));
  expect(api.postKitWrite).toHaveBeenCalledWith({ op: "caption", id: "studio-postkit-1", text: "My own words, not saved yet." });
  // Saved before it was copied, and nothing is left unsaved.
  expect(api.postKitWrite.mock.invocationCallOrder[0]).toBeLessThan(setStringAsync.mock.invocationCallOrder[0]);
  await waitFor(() => expect(screen.queryByTestId("post-kit-caption-save")).toBeNull());
  expect(saveRemoteAsset).toHaveBeenCalled();
});

test("Share / Save when the caption can't be saved shares nothing and says why; the edit stays", async () => {
  render(KITS, { postKitFailures: { caption: { status: 500, code: "x" } } });
  fireEvent.changeText(await screen.findByTestId("post-kit-caption-input"), "Unsaved words.");
  await act(async () => { fireEvent.press(screen.getByTestId("post-kit-share")); });
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failCaption)).toBeTruthy());
  expect(setStringAsync).not.toHaveBeenCalled();
  expect(saveRemoteAsset).not.toHaveBeenCalled();
  expect(screen.getByTestId("post-kit-caption-input").props.value).toBe("Unsaved words.");
});

test("Share / Save with no edit writes nothing first", async () => {
  const { api } = render(KITS);
  const share = await screen.findByTestId("post-kit-share");
  await act(async () => { fireEvent.press(share); });
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalled());
  expect(api.postKitWrite).not.toHaveBeenCalled();
});

// ─── The preview render ───────────────────────────────────────────────────────────────────────────────────────────

test("preview ready (a reel): the rendered video plays instead of the raw clip; its parts keep Swap", async () => {
  const { api } = render({ "studio-postkit-1": POST_KIT_PREVIEW_READY });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-clip")).toBeTruthy());
  expect(screen.queryByTestId("post-kit-asset-clip")).toBeNull();
  expect(screen.queryByTestId("post-kit-preview-preparing")).toBeNull();
  expect(screen.queryByTestId("post-kit-preview-failed")).toBeNull();
  expect(screen.getByTestId("post-kit-play-preview").props.accessibilityLabel).toBe(POST_KIT_COPY.playClip);
  expect(screen.getByTestId("post-kit-parts")).toBeTruthy();
  fireEvent.press(screen.getByTestId("post-kit-swap-asset-clip-1"));
  fireEvent.press(await screen.findByTestId("post-kit-swap-option-asset-photo-1"));
  await waitFor(() => expect(api.postKitWrite).toHaveBeenCalledWith({ op: "swap", id: "studio-postkit-1", replace: "asset-clip-1", with: "asset-photo-1" }));
  // The swap changes the cut: the old preview goes and the new one is being made, over the raw media.
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-preparing")).toBeTruthy());
  expect(screen.queryByTestId("post-kit-preview-clip")).toBeNull();
});

test("preview ready (a reel): Share / Save saves the rendered reel, not the source clip", async () => {
  render({ "studio-postkit-1": POST_KIT_PREVIEW_READY });
  const share = await screen.findByTestId("post-kit-share");
  await act(async () => { fireEvent.press(share); });
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalledTimes(1));
  expect(saveRemoteAsset.mock.calls[0][0]).toBe("https://example.org/media/render-reel-1.mp4");
});

test("preview ready (a carousel): each slide shows its render, one video plays; Share / Save saves every slide in order, in one go", async () => {
  render({ "studio-postkit-1": POST_KIT_CAROUSEL_READY });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-still")).toBeTruthy());
  expect(screen.getAllByTestId("post-kit-preview-clip")).toHaveLength(1);
  expect(screen.queryByTestId("post-kit-asset-photo")).toBeNull();
  expect(screen.queryByTestId("post-kit-play-asset-photo-1")).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId("post-kit-share")); });
  // Native (the test platform): all slides into the photo library in one call, no share sheet per slide.
  await waitFor(() => expect(saveRemoteAssetsToLibrary).toHaveBeenCalledTimes(1));
  expect(saveRemoteAsset).not.toHaveBeenCalled();
  expect(saveRemoteAssetsToLibrary.mock.calls[0][0].map((f) => f.url)).toEqual(["https://example.org/media/render-slide-1.jpg", "https://example.org/media/render-slide-2.mp4"]);
  await waitFor(() => expect(screen.getByText(`${SHARE_COPY.savedPhotos(2)} ${SHARE_COPY.copied}`)).toBeTruthy());
});

test("a carousel save that stops part-way says how many were saved", async () => {
  saveRemoteAssetsToLibrary.mockImplementationOnce(async () => ({ saved: 1, stop: "failed" }));
  render({ "studio-postkit-1": POST_KIT_CAROUSEL_READY });
  await act(async () => { fireEvent.press(await screen.findByTestId("post-kit-share")); });
  await waitFor(() => expect(screen.getByText(SHARE_COPY.partial(1, 2))).toBeTruthy());
});

test("a carousel save she does not allow into her photos asks for the permission, in plain words", async () => {
  saveRemoteAssetsToLibrary.mockImplementationOnce(async () => ({ saved: 0, stop: "permission" }));
  render({ "studio-postkit-1": POST_KIT_CAROUSEL_READY });
  await act(async () => { fireEvent.press(await screen.findByTestId("post-kit-share")); });
  await waitFor(() => expect(screen.getByText(SHARE_COPY.needPhotos)).toBeTruthy());
});

test("Share / Save reads the kit fresh first, so it saves the URLs signed now", async () => {
  const { api } = render({ "studio-postkit-1": POST_KIT_FIXTURE });
  const share = await screen.findByTestId("post-kit-share");
  expect(api.readPostKit).toHaveBeenCalledTimes(1);
  // The server re-signs: the next read answers a new URL for the same clip.
  const resigned = { ...POST_KIT_FIXTURE, media: POST_KIT_FIXTURE.media.map((m) => (m.videoUrl ? { ...m, videoUrl: `${m.videoUrl}?sig=fresh` } : m)) };
  api.readPostKit.mockImplementationOnce(async () => resigned);
  await act(async () => { fireEvent.press(share); });
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalledTimes(1));
  expect(api.readPostKit).toHaveBeenCalledTimes(2);
  expect(saveRemoteAsset.mock.calls[0][0]).toBe("https://example.org/media/clip-1.mp4?sig=fresh");
});

test("Share / Save when the fresh read fails shares nothing and says so", async () => {
  const { api } = render({ "studio-postkit-1": POST_KIT_FIXTURE });
  const share = await screen.findByTestId("post-kit-share");
  api.readPostKit.mockImplementationOnce(async () => { throw new Error("503: down"); });
  await act(async () => { fireEvent.press(share); });
  await waitFor(() => expect(screen.getByText(SHARE_COPY.failed)).toBeTruthy());
  expect(saveRemoteAsset).not.toHaveBeenCalled();
  // The kit stays on screen: a failed refresh for a save is not a failed screen.
  expect(screen.getByTestId("post-kit-idea")).toBeTruthy();
});

test("a write cancels a read of the kit in flight, so an older read can never land over the write's answer", async () => {
  const { qc } = render(KITS);
  const cancel = jest.spyOn(qc, "cancelQueries");
  fireEvent.changeText(await screen.findByTestId("post-kit-caption-input"), "Mine.");
  fireEvent.press(screen.getByTestId("post-kit-caption-save"));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith({ queryKey: AGENT_KEYS.postKit("studio-postkit-1") }));
});

test("the preview lands while a raw clip was chosen: the clip lets go and the reel plays", async () => {
  const { qc } = render({ "studio-postkit-1": postKitPreviewAs(POST_KIT_FIXTURE, "queued") });
  fireEvent.press(await screen.findByTestId("post-kit-play-asset-clip-1"));
  expect(screen.getByTestId("post-kit-asset-clip")).toBeTruthy();
  act(() => { qc.setQueryData(AGENT_KEYS.postKit("studio-postkit-1"), POST_KIT_PREVIEW_READY); });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-clip")).toBeTruthy());
  expect(screen.queryByTestId("post-kit-asset-clip")).toBeNull();
});

test("a preview still queued past PREVIEW_STALL_MS reads as failed, with Try again — and is no longer polled", async () => {
  const stalled = postKitPreviewAs(POST_KIT_FIXTURE, "queued");
  const old = new Date(Date.now() - PREVIEW_STALL_MS - 1000).toISOString();
  const kit: PostKitResponse = { ...stalled, kit: { ...stalled.kit!, preview: { ...stalled.kit!.preview!, requestedAt: old } } };
  expect(previewRefetchInterval(kit)).toBe(false);
  render({ "studio-postkit-1": kit });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-failed")).toBeTruthy());
  expect(screen.getByTestId("post-kit-preview-retry")).toBeTruthy();
  expect(screen.queryByTestId("post-kit-preview-preparing")).toBeNull();
});

/** POST_KIT_FIXTURE with its preview queued `ageMs` ago. */
const queuedFor = (ageMs: number): PostKitResponse => {
  const q = postKitPreviewAs(POST_KIT_FIXTURE, "queued");
  return { ...q, kit: { ...q.kit!, preview: { ...q.kit!.preview!, requestedAt: new Date(Date.now() - ageMs).toISOString() } } };
};

test("Try again on a stalled preview re-queues it, and polling starts again", async () => {
  jest.useFakeTimers();
  try {
    const { api } = render({ "studio-postkit-1": queuedFor(PREVIEW_STALL_MS + 1000) });
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.getByTestId("post-kit-preview-failed")).toBeTruthy();
    // Stalled: nothing polls.
    await act(async () => { await jest.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 2); });
    expect(api.readPostKit).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId("post-kit-preview-retry"));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(api.postKitWrite).toHaveBeenCalledWith({ op: "preview", id: "studio-postkit-1" });
    expect(screen.getByTestId("post-kit-preview-preparing")).toBeTruthy();
    expect(screen.queryByTestId("post-kit-preview-still-making")).toBeNull();
    // The re-ask came back with a new requestedAt: the read is polled again.
    await act(async () => { await jest.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 2 + 100); });
    expect(api.readPostKit.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally {
    jest.useRealTimers();
  }
});

test("Try again that answers the same stalled ask says it is still being made", async () => {
  const stalled = queuedFor(PREVIEW_STALL_MS + 1000);
  const { api } = render({ "studio-postkit-1": stalled });
  api.postKitWrite.mockImplementationOnce(async () => ({ read: stalled, outcome: null }));
  fireEvent.press(await screen.findByTestId("post-kit-preview-retry"));
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-still-making")).toBeTruthy());
  expect(screen.getByText(POST_KIT_COPY.previewStillMaking)).toBeTruthy();
  expect(screen.getByTestId("post-kit-preview-failed")).toBeTruthy();
});

test("a queued preview turns to failed at its stall deadline without another read", async () => {
  jest.useFakeTimers();
  try {
    const queued = postKitPreviewAs(POST_KIT_FIXTURE, "queued");
    const kit: PostKitResponse = { ...queued, kit: { ...queued.kit!, preview: { ...queued.kit!.preview!, requestedAt: new Date(Date.now() - PREVIEW_STALL_MS + 5000).toISOString() } } };
    focused = false; // no polling: only the deadline timer can move it
    const { api } = render({ "studio-postkit-1": kit });
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.getByTestId("post-kit-preview-preparing")).toBeTruthy();
    await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
    expect(screen.getByTestId("post-kit-preview-failed")).toBeTruthy();
    expect(api.readPostKit).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test("polling: only while the screen is in view", async () => {
  jest.useFakeTimers();
  try {
    const queued = { "studio-postkit-1": postKitPreviewAs(POST_KIT_FIXTURE, "queued") };
    focused = false;
    const away = render(queued);
    await act(async () => { await jest.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 2 + 100); });
    expect(away.api.readPostKit).toHaveBeenCalledTimes(1);
    away.unmount();
    focused = true;
    const inView = render(queued);
    await act(async () => { await jest.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 2 + 100); });
    expect(inView.api.readPostKit.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally {
    jest.useRealTimers();
  }
});

test("preview being made: the raw clip plays, with \"Preparing your preview\"; Share / Save takes the source", async () => {
  render({ "studio-postkit-1": postKitPreviewAs(POST_KIT_FIXTURE, "queued") });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-preparing")).toBeTruthy());
  expect(screen.getByText(POST_KIT_COPY.previewPreparing)).toBeTruthy();
  expect(screen.getByTestId("post-kit-asset-clip")).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId("post-kit-share")); });
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalledTimes(1));
  expect(saveRemoteAsset.mock.calls[0][0]).toBe("https://example.org/media/clip-1.mp4");
});

test("the kit is read again while its preview is being made, and not otherwise", () => {
  expect(previewRefetchInterval(postKitPreviewAs(POST_KIT_FIXTURE, "queued"))).toBe(PREVIEW_POLL_MS);
  expect(previewRefetchInterval(POST_KIT_PREVIEW_READY)).toBe(false);
  expect(previewRefetchInterval(postKitPreviewAs(POST_KIT_FIXTURE, "failed"))).toBe(false);
  expect(previewRefetchInterval(POST_KIT_FIXTURE)).toBe(false);
  expect(previewRefetchInterval(null)).toBe(false);
});

test("preview failed: the raw clip, the plain line, and Try again asks for it again", async () => {
  const { api } = render({ "studio-postkit-1": postKitPreviewAs(POST_KIT_FIXTURE, "failed") });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-failed")).toBeTruthy());
  expect(screen.getByText(POST_KIT_COPY.previewFailed)).toBeTruthy();
  expect(screen.getByTestId("post-kit-asset-clip")).toBeTruthy();
  // The server's own error sentence is not what she reads.
  expect(screen.queryByText("The preview couldn't be made.")).toBeNull();
  fireEvent.press(screen.getByTestId("post-kit-preview-retry"));
  await waitFor(() => expect(api.postKitWrite).toHaveBeenCalledWith({ op: "preview", id: "studio-postkit-1" }));
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-preparing")).toBeTruthy());
});

test("preview failed, and Try again refused: plain words, never the server's", async () => {
  render({ "studio-postkit-1": postKitPreviewAs(POST_KIT_FIXTURE, "failed") }, { postKitFailures: { preview: { status: 409, code: "nothing_to_render" } } });
  fireEvent.press(await screen.findByTestId("post-kit-preview-retry"));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failPreviewGone)).toBeTruthy());
});

test("preview failed on a kit already posted: the line, but no Try again", async () => {
  render({ "studio-postkit-1": { ...postKitPreviewAs(POST_KIT_FIXTURE, "failed"), state: "done" } });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-failed")).toBeTruthy());
  expect(screen.queryByTestId("post-kit-preview-retry")).toBeNull();
});

describe("music: three suggested tracks", () => {
  beforeEach(() => { audio.replace.mockClear(); audio.play.mockClear(); audio.pause.mockClear(); });

  it("shows no music card on a kit without suggestions", async () => {
    render({ "studio-postkit-1": POST_KIT_PREVIEW_READY });
    await screen.findByTestId("post-kit-idea");
    expect(screen.queryByTestId("post-kit-music")).toBeNull();
  });

  it("lists the three, marks the one in use, and plays one with the preview without choosing it", async () => {
    render({ "studio-postkit-1": POST_KIT_MUSIC_READY });
    await screen.findByTestId("post-kit-music");
    expect(screen.getByTestId("post-kit-music-in-use-track-a")).toBeTruthy();
    expect(screen.getByText("warm · mid energy · 100 BPM · 4:00, loops")).toBeTruthy();
    fireEvent.press(screen.getByTestId("post-kit-music-play-track-b"));
    expect(audio.replace).toHaveBeenCalledWith({ uri: "https://example.org/media/track-b.m4a" });
    expect(audio.play).toHaveBeenCalled();
    // Listening never chooses.
    expect(screen.getByTestId("post-kit-music-in-use-track-a")).toBeTruthy();
    // A second tap stops it.
    fireEvent.press(screen.getByTestId("post-kit-music-play-track-b"));
    expect(audio.pause).toHaveBeenCalled();
  });

  it("a track with no listening link cannot be played", async () => {
    render({ "studio-postkit-1": POST_KIT_MUSIC_READY });
    await screen.findByTestId("post-kit-music");
    fireEvent.press(screen.getByTestId("post-kit-music-play-track-c"));
    expect(audio.replace).not.toHaveBeenCalled();
  });

  it("Use this puts the track in the post; one that owes a credit says it is in the caption", async () => {
    render({ "studio-postkit-1": POST_KIT_MUSIC_READY });
    await screen.findByTestId("post-kit-music");
    expect(screen.queryByTestId("post-kit-music-credit")).toBeNull();
    fireEvent.press(screen.getByTestId("post-kit-music-use-track-b"));
    await screen.findByTestId("post-kit-music-in-use-track-b");
    expect(screen.getByTestId("post-kit-music-credit")).toBeTruthy();
  });

  it("a refused switch says so in plain words", async () => {
    render({ "studio-postkit-1": POST_KIT_MUSIC_READY }, { postKitFailures: { music: { status: 409, code: "not_brand_safe" } } });
    await screen.findByTestId("post-kit-music");
    fireEvent.press(screen.getByTestId("post-kit-music-use-track-b"));
    expect(await screen.findByText(POST_KIT_COPY.failMusicOption)).toBeTruthy();
  });

  it("is read-only once posted", async () => {
    render({ "studio-postkit-1": { ...POST_KIT_MUSIC_READY, state: "done" } });
    await screen.findByTestId("post-kit-music");
    expect(screen.queryByTestId("post-kit-music-use-track-b")).toBeNull();
    expect(screen.queryByTestId("post-kit-music-none")).toBeNull();
  });

  it("a pick on a Content ID-registered recording says a YouTube claim is possible and how to clear it", async () => {
    render({ "studio-postkit-1": POST_KIT_MUSIC_READY });
    await screen.findByTestId("post-kit-music");
    expect(screen.queryByTestId("post-kit-music-content-id")).toBeNull();
    fireEvent.press(screen.getByTestId("post-kit-music-use-track-b"));
    await screen.findByTestId("post-kit-music-in-use-track-b");
    expect(screen.getByText(POST_KIT_COPY.musicContentId)).toBeTruthy();
  });

  it("a choice no longer allowed (the post became brand work) says why and cannot be used", async () => {
    const stale: PostKitResponse = { ...POST_KIT_MUSIC_READY, music: { choices: POST_KIT_MUSIC_READY.music!.choices.map((c) => (c.trackId === "track-b" ? { ...c, allowed: false } : c)) } };
    render({ "studio-postkit-1": stale });
    await screen.findByTestId("post-kit-music");
    expect(screen.getByTestId("post-kit-music-not-allowed-track-b")).toBeTruthy();
    expect(screen.queryByTestId("post-kit-music-use-track-b")).toBeNull();
  });

  it("losing focus stops the music", async () => {
    render({ "studio-postkit-1": POST_KIT_MUSIC_READY });
    await screen.findByTestId("post-kit-music");
    fireEvent.press(screen.getByTestId("post-kit-music-play-track-b"));
    expect(audio.play).toHaveBeenCalled();
    audio.pause.mockClear();
    focused = false;
    // Any re-render reads the new focus.
    fireEvent.changeText(screen.getByTestId("post-kit-caption-input"), "new words");
    await waitFor(() => expect(audio.pause).toHaveBeenCalled());
    // While out of focus, play does nothing.
    audio.replace.mockClear();
    fireEvent.press(screen.getByTestId("post-kit-music-play-track-a"));
    expect(audio.replace).not.toHaveBeenCalled();
  });

  it("a switch with no room for the credit says so in plain words", async () => {
    render({ "studio-postkit-1": POST_KIT_MUSIC_READY }, { postKitFailures: { music: { status: 400, code: "no_room_for_credit" } } });
    await screen.findByTestId("post-kit-music");
    fireEvent.press(screen.getByTestId("post-kit-music-use-track-b"));
    expect(await screen.findByText(POST_KIT_COPY.failMusicNoRoom)).toBeTruthy();
  });
});
