/**
 * MilaAvatar.test — the five looping states render as one circular, muted, looping video over her still image (so
 * the circle is never empty); she only plays when motion is allowed, the app is foregrounded and her owner says
 * she's visible; under reduce motion only the still is drawn; a state change cuts to a new player.
 * expo-video is mocked the same way TimelinePreview.test does (a View stand-in + a fake player).
 */
import { act, render, screen } from "@testing-library/react-native";
import React from "react";
import { AccessibilityInfo, AppState, StyleSheet } from "react-native";
import { MilaAvatar } from "./MilaAvatar";

class FakePlayer {
  loop = false;
  muted = false;
  play = jest.fn();
  pause = jest.fn();
  constructor(public source: unknown) {}
}

const players: FakePlayer[] = [];

jest.mock("expo-video", () => {
  const React = require("react");
  return {
    useVideoPlayer: (src: unknown, setup?: (p: unknown) => void) => {
      const ref = React.useRef(null);
      if (!ref.current) {
        ref.current = new FakePlayer(src);
        players.push(ref.current);
        setup?.(ref.current);
      }
      return ref.current;
    },
    VideoView: (props: Record<string, unknown>) => {
      const { View } = require("react-native");
      return React.createElement(View, { testID: "mila-video", ...props });
    },
  };
});

let reduceMotion = false;
let appStateListener: ((s: string) => void) | null = null;

beforeEach(() => {
  players.length = 0;
  reduceMotion = false;
  appStateListener = null;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockImplementation(() => Promise.resolve(reduceMotion));
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never);
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_t: string, cb: (s: string) => void) => {
    appStateListener = cb;
    return { remove: jest.fn() };
  }) as never);
});

afterEach(() => jest.restoreAllMocks());

/** Let the reduce-motion promise resolve and its effect run. */
const settle = () => act(async () => {});

describe("MilaAvatar", () => {
  it("idle: one circular, muted, looping video, labelled for screen readers, playing once motion is known", async () => {
    render(<MilaAvatar state="idle" size={96} />);
    await settle();
    expect(screen.getByLabelText("Mila is idle")).toBeTruthy();
    const video = screen.getByTestId("mila-video");
    expect(StyleSheet.flatten(video.props.style)).toMatchObject({ position: "absolute", width: 96, height: 96, borderRadius: 48 });
    expect(video.props.contentFit).toBe("cover");
    expect(video.props.nativeControls).toBe(false);
    // Mobile web: iOS Safari only autoplays a muted video inline.
    expect(video.props.playsInline).toBe(true);
    expect(players).toHaveLength(1);
    expect(players[0].loop).toBe(true);
    expect(players[0].muted).toBe(true);
    expect(players[0].play).toHaveBeenCalled();
  });

  it("her still image is always underneath, filling the same circle, with the video drawn on top", async () => {
    render(<MilaAvatar state="idle" size={50} />);
    // Before the first frame (motion setting not yet read, video paused): the still is there — never an empty circle.
    const still = screen.getByTestId("mila-avatar-still");
    expect(StyleSheet.flatten(still.props.style)).toMatchObject({ position: "absolute", width: 50, height: 50, borderRadius: 25 });
    expect(still.props.resizeMode).toBe("cover");
    expect(players[0].play).not.toHaveBeenCalled();
    await settle();
    // Once she may move, the still stays (it shows if autoplay is blocked) and the video sits after it, on top.
    expect(screen.getByTestId("mila-avatar-still")).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('"mila-avatar-still"')).toBeGreaterThan(-1);
    expect(tree.indexOf('"mila-avatar-still"')).toBeLessThan(tree.indexOf('"mila-video"'));
  });

  it("reduce motion: her still only — no video view — and the player never plays", async () => {
    reduceMotion = true;
    render(<MilaAvatar state="speaking" />);
    await settle();
    expect(screen.getByTestId("mila-avatar-still")).toBeTruthy();
    expect(screen.queryByTestId("mila-video")).toBeNull();
    expect(players[0].play).not.toHaveBeenCalled();
    expect(players[0].pause).toHaveBeenCalled();
  });

  it("inactive owner and backgrounded app both pause her", async () => {
    const { rerender } = render(<MilaAvatar state="idle" active={false} />);
    await settle();
    expect(players[0].play).not.toHaveBeenCalled();

    rerender(<MilaAvatar state="idle" active />);
    expect(players[0].play).toHaveBeenCalledTimes(1);

    players[0].pause.mockClear();
    act(() => appStateListener?.("background"));
    expect(players[0].pause).toHaveBeenCalled();
  });

  it("a state change cuts to a fresh player on that state's loop, with the new label", async () => {
    const { rerender } = render(<MilaAvatar state="idle" />);
    await settle();
    rerender(<MilaAvatar state="generating" />);
    await settle();
    expect(players).toHaveLength(2);
    expect(players[1].source).not.toBe(players[0].source);
    expect(screen.getByLabelText("Mila is generating a reply")).toBeTruthy();
    expect(players[1].play).toHaveBeenCalled();
  });
});
