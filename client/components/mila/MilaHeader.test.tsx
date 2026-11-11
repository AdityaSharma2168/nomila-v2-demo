/**
 * MilaHeader.test — the floating header shows her avatar and a frosted label: "Mila" alone when
 * she's free, "Mila" over the status while she works; nothing in it is outlined; it takes no
 * touches; and useHeldActivity keeps each shown state up for >= 1.2s.
 * expo-video is mocked as in MilaAvatar.test (a View stand-in + a fake player); expo-blur's
 * BlurView is a plain View.
 */
import { act, render, renderHook, screen } from "@testing-library/react-native";
import React from "react";
import { AccessibilityInfo } from "react-native";
import { MilaHeader } from "./MilaHeader";
import { ACTIVITY_LABEL, MIN_STATE_MS, useHeldActivity, type MilaActivity } from "./milaActivity";

jest.mock("expo-video", () => {
  const React = require("react");
  return {
    useVideoPlayer: (src: unknown) => {
      const ref = React.useRef(null);
      if (!ref.current) ref.current = { source: src, loop: false, muted: false, play: jest.fn(), pause: jest.fn() };
      return ref.current;
    },
    VideoView: (props: Record<string, unknown>) => {
      const { View } = require("react-native");
      return React.createElement(View, { testID: "mila-video", ...props });
    },
  };
});

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

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(() => ({ remove: jest.fn() }) as never);
});
afterEach(() => jest.restoreAllMocks());

const settle = () => act(async () => {});

describe("MilaHeader", () => {
  const cases: MilaActivity[] = ["idle", "thinking", "looking", "writing", "listening", "speaking"];

  it.each(cases)("label and accessible label read the %s status", async (activity) => {
    render(<MilaHeader activity={activity} compact={false} active />);
    await settle();
    expect(screen.getByTestId("mila-name")).toHaveTextContent("Mila");
    if (activity === "idle") expect(screen.queryByTestId("mila-status")).toBeNull();
    else expect(screen.getByTestId("mila-status")).toHaveTextContent(ACTIVITY_LABEL[activity]);
    // One accessible element whose label is the status (the avatar inside is grouped under it).
    const group = screen.getByTestId("mila-header-status");
    expect(group.props.accessible).toBe(true);
    expect(group.props.accessibilityLabel).toBe(activity === "idle" ? "Mila" : `Mila: ${ACTIVITY_LABEL[activity]}`);
  });

  it("the status is a polite live region, and the header takes no touches", async () => {
    render(<MilaHeader activity="thinking" compact active />);
    await settle();
    expect(screen.getByTestId("mila-header-status").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByTestId("mila-header").props.pointerEvents).toBe("none");
  });

  it("iOS: says the label once when she starts working; announce={false} (chat v2, which speaks its own status line) says nothing", async () => {
    const say = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
    say.mockClear();
    const a = render(<MilaHeader activity="idle" compact active />);
    a.rerender(<MilaHeader activity="looking" compact active />);
    await settle();
    expect(say.mock.calls).toEqual([[ACTIVITY_LABEL.looking]]);
    a.unmount();
    say.mockClear();
    const b = render(<MilaHeader activity="idle" compact active announce={false} />);
    b.rerender(<MilaHeader activity="looking" compact active announce={false} />);
    await settle();
    expect(say).not.toHaveBeenCalled();
  });

  it("is soft: a frosted label and no ink outline on the label or around her", async () => {
    render(<MilaHeader activity="thinking" compact={false} active />);
    await settle();
    expect(screen.getAllByTestId("frost-blur").length).toBeGreaterThan(0);
    const flat = (n: { props: { style?: unknown } }) =>
      ([] as unknown[]).concat(n.props.style ?? []).flat(4).reduce<Record<string, unknown>>(
        (a, s) => (s && typeof s === "object" ? { ...a, ...(s as Record<string, unknown>) } : a), {});
    expect(flat(screen.getByTestId("mila-label")).borderWidth ?? 0).toBe(0);
    expect(flat(screen.getByTestId("mila-label")).borderColor).toBeUndefined();
  });

  it("plays the avatar loop that matches the activity", async () => {
    render(<MilaHeader activity="looking" compact active />);
    await settle();
    // The avatar's own label names the loop: "searching" for a tool round.
    expect(screen.getByLabelText("Mila is searching")).toBeTruthy();
  });

  it("reports its height so the transcript can pad under it", async () => {
    const onHeight = jest.fn();
    render(<MilaHeader activity="idle" compact={false} active onHeight={onHeight} />);
    await settle();
    const inner = screen.getByTestId("mila-header-status");
    act(() => inner.props.onLayout({ nativeEvent: { layout: { height: 140.4 } } }));
    expect(onHeight).toHaveBeenCalledWith(140);
  });
});

describe("useHeldActivity", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("holds each shown state for the minimum, then shows only the latest target", () => {
    const { result, rerender } = renderHook(({ t }: { t: MilaActivity }) => useHeldActivity(t), {
      initialProps: { t: "idle" as MilaActivity },
    });
    // Mounted long enough ago: the first change goes straight through.
    act(() => jest.advanceTimersByTime(MIN_STATE_MS));
    rerender({ t: "thinking" });
    act(() => jest.advanceTimersByTime(0));
    expect(result.current).toBe("thinking");

    // A tool round and the first token arrive quickly: "thinking" stays up for its 1.2s…
    rerender({ t: "looking" });
    act(() => jest.advanceTimersByTime(300));
    rerender({ t: "writing" });
    act(() => jest.advanceTimersByTime(500));
    expect(result.current).toBe("thinking");
    // …then the latest target shows; the brief "looking" is skipped rather than flashed.
    act(() => jest.advanceTimersByTime(MIN_STATE_MS));
    expect(result.current).toBe("writing");
  });

  it("a change that reverts inside the window never shows", () => {
    const { result, rerender } = renderHook(({ t }: { t: MilaActivity }) => useHeldActivity(t), {
      initialProps: { t: "writing" as MilaActivity },
    });
    rerender({ t: "idle" });
    act(() => jest.advanceTimersByTime(200));
    rerender({ t: "writing" });
    act(() => jest.advanceTimersByTime(MIN_STATE_MS * 2));
    expect(result.current).toBe("writing");
  });
});
