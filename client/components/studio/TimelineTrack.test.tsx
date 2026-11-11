/**
 * TimelineTrack — rendered, because what can go wrong here is not arithmetic.
 *
 * `timelineGeometry.test.ts` already proves the rects. What only a render can show is that those
 * numbers reach the styles, that the scroll content is as wide as the timeline (its absence is
 * silent — the track draws fine and simply will not scroll), that the rects go down in timeline
 * order, and that a tile is a STILL rather than a player.
 *
 * ⚠️ How it LOOKS, whether the overlap reads as a crossfade, and whether twelve posters are
 * affordable on a device are Adi's acceptance. `expo-video` here is a fake that records what it
 * was asked to do.
 */
import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react-native";
import React from "react";
import { View } from "react-native";
import {
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import type { TimelineItem } from "../../screens/studio/stitchLogic";
import {
  DEFAULT_PX_PER_SEC,
  REORDER_HOLD_MS,
  timeAtX,
  trackLayout,
} from "../../screens/studio/timelineGeometry";
import { EDGE_PAD, TimelineTrack, type TrackClipSource } from "./TimelineTrack";

/** Native modules with no linkage in a Jest process — the same stubs VideoEntry.test.tsx uses. */
jest.mock("react-native-reanimated", () =>
  require("react-native-reanimated/mock"),
);
jest.mock("../../lib/haptics", () => ({
  tap: () => {},
  press: () => {},
  select: () => {},
  light: () => {},
  medium: () => {},
  heavy: () => {},
  success: () => {},
  warning: () => {},
  error: () => {},
}));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});

/** Records every player the tree constructs — a track that autoplays would show up here. */
interface BuiltPlayer {
  uri: string;
  muted: boolean;
  loop: boolean;
  currentTime: number;
  played: boolean;
  play(): void;
}
const built: BuiltPlayer[] = [];
jest.mock("expo-video", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    useVideoPlayer: (uri: string, setup?: (p: BuiltPlayer) => void) => {
      const p: BuiltPlayer = {
        uri,
        muted: false,
        loop: false,
        currentTime: 0,
        played: false,
        play() {
          this.played = true;
        },
      };
      setup?.(p);
      built.push(p);
      return p;
    },
    VideoView: (props: Record<string, unknown>) =>
      React.createElement(View, { testID: "video-view", ...props }),
  };
});
jest.mock("expo-image", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Image: (p: object) => React.createElement(View, { testID: "img", ...p }),
  };
});

const item = (over: Partial<TimelineItem> & { key: string }): TimelineItem => ({
  assetId: "a",
  durationSec: null,
  durationPreciseSec: null,
  ...over,
});

const sources = new Map<string, TrackClipSource>([
  ["a", { videoUrl: "https://example.test/a.mp4", posterUrl: null }],
  ["b", { videoUrl: "https://example.test/b.mp4", posterUrl: null }],
]);
const measured = new Map([
  ["a", 10],
  ["b", 6],
]);

/**
 * The layout the CALLER computes and hands down. The track no longer derives it — the scrub has to
 * resolve a second to a clip, and both must be measuring the same track.
 */
const lay = (
  its: TimelineItem[],
  pxPerSec = 10,
  m: Map<string, number> = measured,
) => trackLayout(its, m, pxPerSec);

const flat = (style: unknown): Record<string, number> =>
  Object.assign(
    {},
    ...(Array.isArray(style) ? style.flat(9) : [style]).filter(Boolean),
  );

beforeEach(() => {
  built.length = 0;
});

describe("the track draws the timeline in time", () => {
  it("gives each clip the width its duration earns", () => {
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" }), item({ key: "2", assetId: "b" })], 10)}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    expect(flat(screen.getByTestId("timeline-clip-1").props.style).width).toBe(
      100,
    );
    expect(flat(screen.getByTestId("timeline-clip-2").props.style).width).toBe(
      60,
    );
  });

  it("⚠️ widths are PROPORTIONAL to the measured duration, never a constant", () => {
    /*
     * The bug this pins: on web `createVideoPlayer` measures nothing, so every clip fell to the
     * unknown placeholder and the track drew them all the same width — two clips of very different
     * lengths, identical on screen, both labelled "—".
     */
    render(
      <TimelineTrack
        layout={lay(
          [item({ key: "1" }), item({ key: "2", assetId: "b" })],
          10,
          new Map([
            ["a", 12],
            ["b", 3],
          ]),
        )}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    const a = flat(screen.getByTestId("timeline-clip-1").props.style).width;
    const b = flat(screen.getByTestId("timeline-clip-2").props.style).width;
    expect(a).not.toBe(b);
    // A 12s clip is exactly four times a 3s clip, at any zoom.
    expect(a / b).toBeCloseTo(4, 9);
  });

  it("makes the scroll content as wide as the whole timeline", () => {
    // Silent when wrong: absolutely-positioned children contribute nothing to a ScrollView's
    // extent, so without this the track renders correctly and refuses to scroll.
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" }), item({ key: "2", assetId: "b" })], 10)}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    const width = flat(
      screen.getByTestId("timeline-track-content").props.style,
    ).width;
    expect(width).toBeGreaterThanOrEqual(160);
  });

  it("lays the clips down in TIMELINE order, which is what puts the later one on top", () => {
    render(
      <TimelineTrack
        layout={lay(
          [
            item({ key: "first" }),
            item({ key: "second", assetId: "b", crossfadeSec: 2 }),
          ],
          10,
        )}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    // Anchored so it cannot also match the inner pressable's `timeline-clip-tap-*`.
    const ids = screen
      .getAllByTestId(/^timeline-clip-(?!tap-)/)
      .map((n) => n.props.testID);
    expect(ids).toEqual(["timeline-clip-first", "timeline-clip-second"]);
  });

  it("overlaps a crossfaded clip back over the one before it", () => {
    render(
      <TimelineTrack
        layout={lay(
          [
            item({ key: "1" }),
            item({ key: "2", assetId: "b", crossfadeSec: 2 }),
          ],
          10,
        )}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    const a = flat(screen.getByTestId("timeline-clip-1").props.style);
    const b = flat(screen.getByTestId("timeline-clip-2").props.style);
    expect(b.left).toBeLessThan(a.left + a.width);
  });

  it("has nothing to draw for an empty timeline", () => {
    render(<TimelineTrack layout={lay([])} clipsById={sources} />);
    expect(screen.queryByTestId("timeline-track-content")).toBeNull();
  });
});

describe("what the track says about a clip", () => {
  it("labels a known clip with how long it plays", () => {
    render(
      <TimelineTrack
        layout={lay([item({ key: "1", trimStartSec: 2, trimEndSec: 8 })], 10)}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    // ⚠️ Scoped to the CLIP, not to the tree. The ruler prints clock() strings too, so a bare
    // getByText can be satisfied by a tick that happens to read the same — which would let a wrong
    // clip label pass.
    expect(
      within(screen.getByTestId("timeline-clip-1")).getByText("0:06"),
    ).toBeTruthy();
  });

  it("labels an UNKNOWN clip '—', never the placeholder it is drawn at", () => {
    // The tile is 3s wide so she can see and fix it; printing "0:03" would be that invented
    // number escaping into something she could believe.
    render(
      <TimelineTrack
        layout={lay([item({ key: "1", assetId: "zzz" })], 10, new Map())}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    const tile = within(screen.getByTestId("timeline-clip-1"));
    expect(tile.getByText("—")).toBeTruthy();
    expect(tile.queryByText("0:03")).toBeNull();
  });
});

describe("a tile is a still and must never become a player", () => {
  it("never plays anything on the track", () => {
    // ClipPoster and ClipPlayer are deliberately separate components — "the flag is how a strip of
    // ten tiles ends up all playing at once", and a track of twelve is exactly that.
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" }), item({ key: "2", assetId: "b" })], 10)}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    expect(built.length).toBeGreaterThan(0);
    for (const p of built) {
      expect(p.played).toBe(false);
      expect(p.muted).toBe(true);
      expect(p.loop).toBe(false);
    }
  });
});

describe("the ruler", () => {
  it("marks the track at the interval the zoom calls for", () => {
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" })], DEFAULT_PX_PER_SEC)}
        clipsById={sources}
        pxPerSec={DEFAULT_PX_PER_SEC}
      />,
    );
    // 40 px/s -> a 2s interval, so a 10s clip is marked 0,2,4,6,8,10.
    expect(screen.getByTestId("timeline-tick-0")).toBeTruthy();
    expect(screen.getByTestId("timeline-tick-10")).toBeTruthy();
    expect(screen.queryByTestId("timeline-tick-12")).toBeNull();
  });

  it("thins its marks out as the track zooms out", () => {
    const view = render(
      <TimelineTrack
        layout={lay([item({ key: "1" })], DEFAULT_PX_PER_SEC)}
        clipsById={sources}
        pxPerSec={DEFAULT_PX_PER_SEC}
      />,
    );
    const dense = screen.getAllByTestId(/^timeline-tick-/).length;
    view.rerender(
      <TimelineTrack
        layout={lay([item({ key: "1" })], 8)}
        clipsById={sources}
        pxPerSec={8}
      />,
    );
    expect(screen.getAllByTestId(/^timeline-tick-/).length).toBeLessThan(dense);
  });
});

describe("tapping a clip", () => {
  it("tells the caller WHICH clip, by its stable key", () => {
    const onSelect = jest.fn();
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" }), item({ key: "2", assetId: "b" })], 10)}
        clipsById={sources}
        pxPerSec={10}
        onSelect={onSelect}
      />,
    );
    // The PRESSABLE, which is now inside the positioned wrapper — the wrapper carries the drag
    // transform and cannot itself be a Pressable without losing the animated style.
    fireEvent.press(screen.getByTestId("timeline-clip-tap-2"));
    // The KEY, never the index and never the asset id — the same clip can hold two positions.
    expect(onSelect).toHaveBeenCalledWith("2");
  });

  it("marks the selected clip for assistive tech, not only with a colour", () => {
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" }), item({ key: "2", assetId: "b" })], 10)}
        clipsById={sources}
        pxPerSec={10}
        onSelect={() => {}}
        selectedKey="2"
      />,
    );
    expect(
      screen.getByTestId("timeline-clip-tap-2").props.accessibilityState
        .selected,
    ).toBe(true);
    expect(
      screen.getByTestId("timeline-clip-tap-1").props.accessibilityState
        .selected,
    ).toBe(false);
  });

  it("stays inert when no handler is given", () => {
    const onSelect = jest.fn();
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" })], 10)}
        clipsById={sources}
        pxPerSec={10}
      />,
    );
    fireEvent.press(screen.getByTestId("timeline-clip-tap-1"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("the playhead", () => {
  it("sits where xAtTime says the second is", () => {
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" })], 10)}
        clipsById={sources}
        pxPerSec={10}
        playheadSec={4}
      />,
    );
    // EDGE_PAD + 4s * 10px/s, less half the knob so the LINE is what sits on the second.
    expect(flat(screen.getByTestId("timeline-playhead").props.style).left).toBe(
      EDGE_PAD + 40,
    );
  });

  it("never swallows a tap meant for a clip underneath it", () => {
    // It is drawn over both rows; if it took touches, the clip at the playhead would be
    // unselectable — which is exactly the clip she is working on.
    render(
      <TimelineTrack
        layout={lay([item({ key: "1" })], 10)}
        clipsById={sources}
        pxPerSec={10}
        playheadSec={4}
      />,
    );
    expect(screen.getByTestId("timeline-playhead").props.pointerEvents).toBe(
      "none",
    );
  });
});

describe("scrubbing the ruler", () => {
  const two = [item({ key: "1" }), item({ key: "2", assetId: "b" })];

  it("turns a drag into a TIME, through the real gesture", () => {
    const onScrub = jest.fn();
    render(
      <TimelineTrack
        layout={lay(two, 10)}
        clipsById={sources}
        pxPerSec={10}
        onScrub={onScrub}
      />,
    );
    fireGestureHandler(getByGestureTestId("timeline-scrub"), [
      { x: EDGE_PAD + 0 },
      { x: EDGE_PAD + 55 },
      { x: EDGE_PAD + 120 },
    ]);
    expect(onScrub).toHaveBeenCalled();
    expect(onScrub.mock.calls[onScrub.mock.calls.length - 1][0]).toBeCloseTo(
      timeAtX(120, 10),
      9,
    );
  });

  it("clamps a drag that ran off either end of the track", () => {
    const onScrub = jest.fn();
    render(
      <TimelineTrack
        layout={lay(two, 10)}
        clipsById={sources}
        pxPerSec={10}
        onScrub={onScrub}
      />,
    );
    fireGestureHandler(getByGestureTestId("timeline-scrub"), [
      { x: -500 },
      { x: 99999 },
    ]);
    for (const [sec] of onScrub.mock.calls) {
      expect(sec).toBeGreaterThanOrEqual(0);
      // Two clips at 10s and 6s, no crossfade.
      expect(sec).toBeLessThanOrEqual(16);
    }
  });

  it("is inert when the track is not scrubbable", () => {
    render(
      <TimelineTrack layout={lay(two, 10)} clipsById={sources} pxPerSec={10} />,
    );
    // No handler: the gesture still exists, but driving it must not throw.
    expect(() =>
      fireGestureHandler(getByGestureTestId("timeline-scrub"), [{ x: 40 }]),
    ).not.toThrow();
  });
});

describe("trim handles", () => {
  const known = [item({ key: "1", durationPreciseSec: 10 })];

  it("appear on the SELECTED clip and nowhere else", () => {
    const two = [
      item({ key: "1", durationPreciseSec: 10 }),
      item({ key: "2", assetId: "b", durationPreciseSec: 6 }),
    ];
    render(
      <TimelineTrack
        layout={lay(two, 10)}
        clipsById={sources}
        pxPerSec={10}
        selectedKey="2"
        onTrim={() => {}}
      />,
    );
    expect(screen.queryByTestId("trim-handle-start-1")).toBeNull();
    expect(screen.getByTestId("trim-handle-start-2")).toBeTruthy();
    expect(screen.getByTestId("trim-handle-end-2")).toBeTruthy();
  });

  it("⚠️ NEVER appear on a clip of unknown length", () => {
    // The placeholder is a plausible three seconds against a clip that might be sixty. A handle
    // there would let her throw away most of the footage without ever seeing it.
    render(
      <TimelineTrack
        layout={lay([item({ key: "1", assetId: "zzz" })], 10, new Map())}
        clipsById={sources}
        pxPerSec={10}
        selectedKey="1"
        onTrim={() => {}}
      />,
    );
    expect(screen.queryByTestId("trim-handle-start-1")).toBeNull();
    expect(screen.queryByTestId("trim-handle-end-1")).toBeNull();
  });

  it("turn a drag on the start edge into an IN-POINT, through the real gesture", () => {
    const onTrim = jest.fn();
    render(
      <TimelineTrack
        layout={lay(known, 10)}
        clipsById={sources}
        pxPerSec={10}
        selectedKey="1"
        onTrim={onTrim}
      />,
    );
    // The clip starts at source 0; dragging the handle 25px right at 10px/s is +2.5s.
    fireGestureHandler(getByGestureTestId("trim-start-1"), [
      { translationX: 0 },
      { translationX: 25 },
    ]);
    expect(onTrim).toHaveBeenLastCalledWith("1", "start", 2.5);
  });

  it("turns a drag on the end edge into an OUT-POINT", () => {
    const onTrim = jest.fn();
    render(
      <TimelineTrack
        layout={lay(known, 10)}
        clipsById={sources}
        pxPerSec={10}
        selectedKey="1"
        onTrim={onTrim}
      />,
    );
    // The clip ends at source 10; dragging 30px left at 10px/s is -3s.
    fireGestureHandler(getByGestureTestId("trim-end-1"), [
      { translationX: 0 },
      { translationX: -30 },
    ]);
    expect(onTrim).toHaveBeenLastCalledWith("1", "end", 7);
  });

  it("⚠️ measures each drag from where the edge WAS when the finger went down", () => {
    // Applying a trim moves the rect, which moves the edge. Reading the live position would feed
    // the trim back into itself and the handle would run away from the finger.
    const onTrim = jest.fn();
    render(
      <TimelineTrack
        layout={lay(
          [item({ key: "1", durationPreciseSec: 10, trimStartSec: 4 })],
          10,
        )}
        clipsById={sources}
        pxPerSec={10}
        selectedKey="1"
        onTrim={onTrim}
      />,
    );
    fireGestureHandler(getByGestureTestId("trim-start-1"), [
      { translationX: 0 },
      { translationX: 10 },
    ]);
    // Already trimmed to 4s in; +1s of drag is 5s, not 1s.
    expect(onTrim).toHaveBeenLastCalledWith("1", "start", 5);
  });

  it("is inert when the track is not trimmable", () => {
    render(
      <TimelineTrack
        layout={lay(known, 10)}
        clipsById={sources}
        pxPerSec={10}
        selectedKey="1"
      />,
    );
    expect(screen.queryByTestId("trim-handle-start-1")).toBeNull();
  });
});

describe("dragging a clip to reorder it", () => {
  // a 0–100, b 100–160, c 160–260 at 10px/s. Centres 50, 130, 210.
  const three = [
    item({ key: "a", durationPreciseSec: 10 }),
    item({ key: "b", assetId: "b", durationPreciseSec: 6 }),
    item({ key: "c", assetId: "b", durationPreciseSec: 10 }),
  ];

  const track = (onReorder?: (key: string, to: number) => void) =>
    render(
      <TimelineTrack
        layout={lay(three, 10)}
        clipsById={sources}
        pxPerSec={10}
        onReorder={onReorder}
      />,
    );

  it("⚠️ commits the index its centre was dropped at, through the REAL gesture", () => {
    const onReorder = jest.fn();
    track(onReorder);
    // 'a' is centred at 50; +170 puts it at 220, right of both other centres (130, 210).
    fireGestureHandler(getByGestureTestId("reorder-a"), [
      { translationX: 0 },
      { translationX: 170 },
    ]);
    expect(onReorder).toHaveBeenCalledWith("a", 2);
  });

  it("drops BETWEEN two clips at the index between them", () => {
    const onReorder = jest.fn();
    track(onReorder);
    // 50 + 90 = 140: past b's centre (130), short of c's (210).
    fireGestureHandler(getByGestureTestId("reorder-a"), [
      { translationX: 0 },
      { translationX: 90 },
    ]);
    expect(onReorder).toHaveBeenCalledWith("a", 1);
  });

  it("says nothing when the clip was put back where it came from", () => {
    // A drag that ends where it started is not a reorder, and reporting one would churn the array
    // and the keys for no reason.
    const onReorder = jest.fn();
    track(onReorder);
    fireGestureHandler(getByGestureTestId("reorder-a"), [
      { translationX: 0 },
      { translationX: 5 },
    ]);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("⚠️ the clip's artwork takes NO pointer events, or the browser drags it instead", () => {
    /*
     * The bug this pins, seen on device: an <img> is natively draggable in a browser, and
     * expo-image's Image (unlike React Native Web's own) does not set draggable={false}. Pressing
     * and dragging a clip started CHROME'S drag-and-drop, which painted a translucent ghost of the
     * tile and swallowed the pointer stream — so the reorder gesture never activated and what she
     * saw was a floating picture.
     */
    track(() => {});
    const artwork = screen
      .UNSAFE_getAllByType(View)
      .filter((n) => n.props.pointerEvents === "none");
    expect(artwork.length).toBeGreaterThanOrEqual(three.length);
  });

  it("⚠️ needs a HOLD before it will drag, so it cannot fight the track's scroll", () => {
    // The gesture the track hands out must be long-press-activated. Without it, a plain pan on a
    // clip either gets swallowed by the horizontal ScrollView or steals from it — and it would
    // also start stealing drags from the trim handles.
    track(() => {});
    const gesture = getByGestureTestId("reorder-a") as unknown as {
      config: { activateAfterLongPress?: number };
    };
    expect(gesture.config.activateAfterLongPress).toBe(REORDER_HOLD_MS);
  });

  it("is disabled outright when the track cannot be reordered", () => {
    track(undefined);
    const gesture = getByGestureTestId("reorder-a") as unknown as {
      config: { enabled?: boolean };
    };
    expect(gesture.config.enabled).toBe(false);
  });
});

describe("a held photo on the track", () => {
  const withPhoto = new Map<string, TrackClipSource>([
    ...sources,
    ["p", { videoUrl: null, posterUrl: "https://example.test/p.jpg" }],
  ]);
  const held = [item({ key: "1", assetId: "p", stillSec: 3 })];

  it("gets no trim handles, even when it is the selected position", () => {
    // Its length is its hold, set by the chips under the track — there is no footage to trim.
    render(
      <TimelineTrack
        layout={lay(held, 10)}
        clipsById={withPhoto}
        pxPerSec={10}
        selectedKey="1"
        onTrim={() => {}}
      />,
    );
    expect(screen.queryByTestId("trim-handle-start-1")).toBeNull();
    expect(screen.queryByTestId("trim-handle-end-1")).toBeNull();
  });

  it("is drawn from its picture at its hold, and says it is a photo", () => {
    render(
      <TimelineTrack
        layout={lay(held, 10)}
        clipsById={withPhoto}
        pxPerSec={10}
        onSelect={() => {}}
      />,
    );
    const tile = screen.getByTestId("timeline-clip-1");
    expect(flat(tile.props.style).width).toBe(30);
    expect(within(tile).getByText(/0:03/)).toBeTruthy();
    expect(screen.getByLabelText("Photo at 0:00, 0:03 long")).toBeTruthy();
    // A picture, never a player: nothing on the track was built to play it.
    expect(built.map((p) => p.uri)).not.toContain("https://example.test/p.jpg");
  });
});
