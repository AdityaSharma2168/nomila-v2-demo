/**
 * StudioForYouScreen.test — the vertical feed over the library's post_kit items: loading, empty, error, one card's
 * inline playback (falling back to the asset when there's no render yet), Post (the kit screen's own Share / Save:
 * caption copied, media saved; plain words when it fails or there is nothing to save), Edit (opens the kit screen),
 * More info (the goal and moment tie-back, in the app's Sheet); a posted kit is not in the feed; nothing plays while
 * the screen is not focused.
 */
import React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderAgent } from "../../test/agentHarness";
import { FOR_YOU_COPY, forYouItems, StudioForYouScreen } from "./StudioForYouScreen";
import { SHARE_COPY } from "../../components/postKit/sharePostKit";
import { POST_KIT_COPY } from "../../components/postKit/copy";
import { AGENT_KEYS, PREVIEW_POLL_MS } from "../../lib/agent/hooks";
import { POST_KIT_CAROUSEL_READY, POST_KIT_FIXTURE, POST_KIT_PREVIEW_READY, postKitPreviewAs, STUDIO_FIXTURE } from "../../lib/agent/fixtures";
import type { StudioItem } from "../../lib/agent/types";
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
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const setStringAsync = jest.fn(async (_s: string) => {});
jest.mock("expo-clipboard", () => ({ setStringAsync: (s: string) => setStringAsync(s) }));
const saveRemoteAsset = jest.fn(async (..._a: unknown[]) => "saved" as const);
jest.mock("../../lib/download-asset", () => ({
  saveRemoteAsset: (...a: unknown[]) => saveRemoteAsset(...a),
  saveRemoteAssetsToLibrary: async (f: unknown[]) => ({ saved: f.length, stop: null }),
  fileNameFor: () => "post.jpg",
  PopupBlockedError: class extends Error {},
}));
const navigate = jest.fn();
let focused = true;
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack: jest.fn() }), useIsFocused: () => focused, useRoute: () => ({ params: undefined }) }));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "ath-1" } }) }));

beforeEach(() => { focused = true; navigate.mockClear(); saveRemoteAsset.mockClear(); setStringAsync.mockClear(); });

const POST_KIT_ONLY: StudioItem[] = STUDIO_FIXTURE.filter((i) => i.kind === "post_kit");

const render = (studio: StudioItem[], postKits: Record<string, PostKitResponse>) =>
  renderAgent(<StudioForYouScreen />, { opts: { studio, postKits } });

test("loading, then the first card: inline media, caption, and the three actions", async () => {
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  expect(screen.getByTestId("for-you-loading")).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId(`for-you-card-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy());
  expect(screen.getByTestId(`for-you-caption-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy();
  expect(screen.getByTestId(`for-you-post-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy();
  expect(screen.getByTestId(`for-you-edit-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy();
  expect(screen.getByTestId(`for-you-more-info-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy();
});

test("a kit with no caption yet says so on the card (never a blank line, never the brief)", async () => {
  const empty = { ...POST_KIT_FIXTURE, kit: { ...POST_KIT_FIXTURE.kit!, caption: { text: "", hashtags: [], edited: false } } };
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: empty });
  await waitFor(() => expect(screen.getByTestId(`for-you-caption-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy());
  expect(screen.getByTestId(`for-you-caption-${POST_KIT_FIXTURE.decisionId}`).props.children).toBe("No caption yet — ask Mila");
});

test("no post kits yet: the empty state, not a blank screen", async () => {
  render([], {});
  await waitFor(() => expect(screen.getByTestId("for-you-empty")).toBeTruthy());
  // Kits come from her plan; the feed never promises one from a chat.
  expect(screen.getByText(FOR_YOU_COPY.emptyLine)).toBeTruthy();
  expect(screen.queryByText(/Ask Mila/)).toBeNull();
});

test("a kit she already marked posted is not in the feed (it stays in the library as published)", async () => {
  const posted: StudioItem = { ...POST_KIT_ONLY[0], id: "posted-1", status: "published" };
  expect(forYouItems([...POST_KIT_ONLY, posted]).map((i) => i.id)).toEqual(POST_KIT_ONLY.map((i) => i.id));
  render([posted], {});
  await waitFor(() => expect(screen.getByTestId("for-you-empty")).toBeTruthy());
});

test("nothing plays while the screen is not focused (another screen on top, or the app in the background)", async () => {
  focused = false;
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId(`for-you-card-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy());
  expect(screen.queryByTestId("post-kit-asset-clip")).toBeNull();
});

test("a read failure shows the error state with Retry", async () => {
  const { api } = renderAgent(<StudioForYouScreen />, { opts: { fail: true } });
  await waitFor(() => expect(screen.getByTestId("for-you-error")).toBeTruthy());
  fireEvent.press(screen.getByTestId("for-you-retry"));
  await waitFor(() => expect(api.listStudioItems).toHaveBeenCalledTimes(2));
});

test("no preview yet: the active card's clip plays inline, never blocked on the render", async () => {
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId("post-kit-asset-clip")).toBeTruthy());
});

test("Edit opens the kit screen for this item", async () => {
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId(`for-you-edit-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy());
  fireEvent.press(screen.getByTestId(`for-you-edit-${POST_KIT_FIXTURE.decisionId}`));
  expect(navigate).toHaveBeenCalledWith("PostKit", { id: POST_KIT_FIXTURE.decisionId });
});

test("More info: the goal and the moment's why_now", async () => {
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  await waitFor(() => expect(screen.getByTestId(`for-you-more-info-${POST_KIT_FIXTURE.decisionId}`)).toBeTruthy());
  fireEvent.press(screen.getByTestId(`for-you-more-info-${POST_KIT_FIXTURE.decisionId}`));
  await waitFor(() => expect(screen.getByTestId("for-you-info-sheet")).toBeTruthy());
  expect(screen.getByText(POST_KIT_FIXTURE.goal!.text)).toBeTruthy();
  expect(screen.getByText(new RegExp(POST_KIT_FIXTURE.moment!.whyNow!))).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Close"));
  await waitFor(() => expect(screen.queryByTestId("for-you-info-sheet")).toBeNull());
});

const postButton = () => screen.getByTestId(`for-you-post-${POST_KIT_FIXTURE.decisionId}`);
const whenKitLoaded = () => waitFor(() => expect(postButton().props.accessibilityState.disabled).toBe(false));

test("Post is the kit screen's Share / Save: copies the caption and saves the chosen media", async () => {
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  await whenKitLoaded();
  fireEvent.press(postButton());
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalled());
  expect(setStringAsync).toHaveBeenCalledWith(POST_KIT_FIXTURE.kit!.caption.text);
  await waitFor(() => expect(screen.getByText(`${SHARE_COPY.saved} ${SHARE_COPY.copied}`)).toBeTruthy());
});

test("Post with nothing to save says so (the caption is still copied)", async () => {
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: { ...POST_KIT_FIXTURE, media: POST_KIT_FIXTURE.media.map((m) => ({ ...m, available: false })) } });
  await whenKitLoaded();
  fireEvent.press(postButton());
  await waitFor(() => expect(screen.getByText(`${SHARE_COPY.noMedia} ${SHARE_COPY.copied}`)).toBeTruthy());
  expect(saveRemoteAsset).not.toHaveBeenCalled();
});

test("Post failing reads in plain words, never the thrown message", async () => {
  saveRemoteAsset.mockImplementationOnce(async () => { throw new Error("403: SignatureDoesNotMatch"); });
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  await whenKitLoaded();
  fireEvent.press(postButton());
  await waitFor(() => expect(screen.getByText(SHARE_COPY.failed)).toBeTruthy());
  expect(screen.queryByText(/SignatureDoesNotMatch/)).toBeNull();
});

test("the actions are named for a screen reader", async () => {
  render(POST_KIT_ONLY, { [POST_KIT_FIXTURE.decisionId]: POST_KIT_FIXTURE });
  await waitFor(() => expect(postButton()).toBeTruthy());
  const title = POST_KIT_ONLY[0].title;
  expect(postButton().props.accessibilityLabel).toBe(FOR_YOU_COPY.postLabel(title));
  expect(screen.getByLabelText(FOR_YOU_COPY.editLabel(title))).toBeTruthy();
  expect(screen.getByLabelText(FOR_YOU_COPY.moreInfoLabel(title))).toBeTruthy();
});

// ─── The preview render ───────────────────────────────────────────────────────────────────────────────────────────

const ID = POST_KIT_FIXTURE.decisionId;

test("preview ready: the card plays the rendered reel full-bleed, not the raw clip; Post saves the rendered file", async () => {
  render(POST_KIT_ONLY, { [ID]: POST_KIT_PREVIEW_READY });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-clip")).toBeTruthy());
  expect(screen.queryByTestId("post-kit-asset-clip")).toBeNull();
  expect(screen.queryByTestId(`for-you-preview-preparing-${ID}`)).toBeNull();
  await whenKitLoaded();
  fireEvent.press(postButton());
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalledTimes(1));
  expect(saveRemoteAsset.mock.calls[0][0]).toBe("https://example.org/media/render-reel-1.mp4");
});

test("preview ready (a carousel): the card shows the first rendered slide", async () => {
  render(POST_KIT_ONLY, { [ID]: POST_KIT_CAROUSEL_READY });
  await waitFor(() => expect(screen.getByTestId("post-kit-preview-still")).toBeTruthy());
});

test("preview being made: the raw clip plays, with \"Preparing your preview\"", async () => {
  render(POST_KIT_ONLY, { [ID]: postKitPreviewAs(POST_KIT_FIXTURE, "queued") });
  await waitFor(() => expect(screen.getByTestId(`for-you-preview-preparing-${ID}`)).toBeTruthy());
  expect(screen.getByText(POST_KIT_COPY.previewPreparing)).toBeTruthy();
  expect(screen.getByTestId("post-kit-asset-clip")).toBeTruthy();
});

test("preview failed: the raw clip, and Try again asks for the preview again", async () => {
  const { api } = render(POST_KIT_ONLY, { [ID]: postKitPreviewAs(POST_KIT_FIXTURE, "failed") });
  await waitFor(() => expect(screen.getByTestId(`for-you-preview-failed-${ID}`)).toBeTruthy());
  expect(screen.getByTestId("post-kit-asset-clip")).toBeTruthy();
  fireEvent.press(screen.getByTestId(`for-you-preview-retry-${ID}`));
  await waitFor(() => expect(api.postKitWrite).toHaveBeenCalledWith({ op: "preview", id: ID }));
  await waitFor(() => expect(screen.getByTestId(`for-you-preview-preparing-${ID}`)).toBeTruthy());
});

test("preview failed, and Try again refused: plain words on the card", async () => {
  renderAgent(<StudioForYouScreen />, { opts: { studio: POST_KIT_ONLY, postKits: { [ID]: postKitPreviewAs(POST_KIT_FIXTURE, "failed") }, postKitFailures: { preview: { status: 500, code: "x" } } } });
  fireEvent.press(await screen.findByTestId(`for-you-preview-retry-${ID}`));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.failPreview)).toBeTruthy());
});

test("Try again that answers the same stalled ask says, on the card, that it is still being made", async () => {
  const q = postKitPreviewAs(POST_KIT_FIXTURE, "queued");
  const stalled: PostKitResponse = { ...q, kit: { ...q.kit!, preview: { ...q.kit!.preview!, requestedAt: "2026-01-01T00:00:00.000Z" } } };
  const { api } = render(POST_KIT_ONLY, { [ID]: stalled });
  api.postKitWrite.mockImplementationOnce(async () => ({ read: stalled, outcome: null }));
  fireEvent.press(await screen.findByTestId(`for-you-preview-retry-${ID}`));
  await waitFor(() => expect(screen.getByText(POST_KIT_COPY.previewStillMaking)).toBeTruthy());
});

test("Post reads the kit fresh first, so it saves the URLs signed now", async () => {
  const { api } = render(POST_KIT_ONLY, { [ID]: POST_KIT_FIXTURE });
  await whenKitLoaded();
  const reads = api.readPostKit.mock.calls.length;
  api.readPostKit.mockImplementationOnce(async () => ({ ...POST_KIT_FIXTURE, media: POST_KIT_FIXTURE.media.map((m) => (m.videoUrl ? { ...m, videoUrl: `${m.videoUrl}?sig=fresh` } : m)) }));
  fireEvent.press(postButton());
  await waitFor(() => expect(saveRemoteAsset).toHaveBeenCalledTimes(1));
  expect(api.readPostKit.mock.calls.length).toBe(reads + 1);
  expect(saveRemoteAsset.mock.calls[0][0]).toBe("https://example.org/media/clip-1.mp4?sig=fresh");
});

test("polling: one timer — the card in view polls; its More info sheet on the same kit adds none; nothing polls out of focus", async () => {
  jest.useFakeTimers();
  try {
    const kits = { [ID]: postKitPreviewAs(POST_KIT_FIXTURE, "queued") };
    focused = false;
    const away = render(POST_KIT_ONLY, kits);
    await act(async () => { await jest.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 2 + 100); });
    expect(away.api.readPostKit).not.toHaveBeenCalled(); // not in view: the card's read is not even enabled
    away.unmount();

    focused = true;
    const { api, qc } = render(POST_KIT_ONLY, kits);
    // Opened part-way through the card's interval: a second timer would be out of step and show as extra reads.
    await act(async () => { await jest.advanceTimersByTimeAsync(PREVIEW_POLL_MS / 2); });
    fireEvent.press(screen.getByTestId(`for-you-more-info-${ID}`));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.getByTestId("for-you-info-sheet")).toBeTruthy();
    // Two observers on the kit (the card and the sheet); exactly one of them carries a poll.
    const observers = qc.getQueryCache().find({ queryKey: AGENT_KEYS.postKit(ID) })!.observers;
    expect(observers).toHaveLength(2);
    expect(observers.filter((o) => o.options.refetchInterval !== false)).toHaveLength(1);
    const before = api.readPostKit.mock.calls.length;
    await act(async () => { await jest.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 3 + 100); });
    // One read per interval (one observer polling), not two.
    expect(api.readPostKit.mock.calls.length - before).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});
