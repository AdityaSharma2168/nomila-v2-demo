/**
 * TimelinePreview — the player's WIRING, driven through a fake that records what it was told.
 *
 * Both bugs this file is about are silent. Seeking before the new source is ready lands on the
 * outgoing item; a load that finishes late seeks whatever is loaded now. Neither throws, and both
 * look like "sometimes it starts in the wrong place".
 *
 * ⚠️ That a real mp4 decodes and plays, and whether the swap is fast enough to feel like a tap,
 * are Adi's device acceptance. `expo-video` below is a state machine, not a decoder.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { TimelinePreview, type PreviewSpec } from "./TimelinePreview";

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

/**
 * ⚠️ MOCKED TO A MARKER. If the preview ever renders a poster instead of the video — the V7
 * symptom — this shows up in the tree and the test below fails. Asserting on a url cannot do that
 * job: a url check still passes if something draws a poster as WELL.
 */
jest.mock("./ClipPoster", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { ClipPoster: () => React.createElement(Text, { testID: "poster" }) };
});

type Listener = (p: Record<string, unknown>) => void;

class FakePlayer {
  loop = false;
  muted = true;
  /** Every write, in order — the test needs the LAST one, after unmount. */
  intervalSets: number[] = [];
  private _interval = 0;
  status = "idle";
  playing = false;
  /** Every seek, in order — the property is a setter so the test sees them all. */
  seeks: number[] = [];
  replaced: string[] = [];
  pauses = 0;
  private resolvers: (() => void)[] = [];
  private listeners: Record<string, Listener[]> = {};
  private _t = 0;

  get currentTime() {
    return this._t;
  }
  get timeUpdateEventInterval() {
    return this._interval;
  }
  set timeUpdateEventInterval(v: number) {
    this._interval = v;
    this.intervalSets.push(v);
  }
  set currentTime(v: number) {
    this._t = v;
    this.seeks.push(v);
  }
  replaceAsync(source: { uri: string }) {
    this.replaced.push(source.uri);
    return new Promise<void>((resolve) => this.resolvers.push(resolve));
  }
  addListener(name: string, fn: Listener) {
    (this.listeners[name] ??= []).push(fn);
    return { remove: () => {} };
  }
  play() {
    this.playing = true;
  }
  pause() {
    this.playing = false;
    this.pauses += 1;
  }
  /** Let the Nth outstanding replace finish. */
  async settleReplace(index = 0) {
    const r = this.resolvers[index];
    await act(async () => {
      r?.();
      await Promise.resolve();
    });
  }
  emit(name: string, payload: Record<string, unknown>) {
    act(() => {
      for (const fn of [...(this.listeners[name] ?? [])]) fn(payload);
    });
  }
}

let player: FakePlayer;
/**
 * ⚠️ `setup` RUNS ONCE, not per render — the real `useVideoPlayer` constructs the player once and
 * calls it then. A fake that re-ran it on every render would silently re-assert every default
 * (`muted` among them), which makes any persistence property untestable and looks like a
 * production bug when it is a bug in the fake.
 */
const setupRun = new WeakSet<object>();
jest.mock("expo-video", () => ({
  useVideoPlayer: (_src: unknown, setup?: (p: unknown) => void) => {
    if (!setupRun.has(player)) {
      setupRun.add(player);
      setup?.(player);
    }
    return player;
  },
  VideoView: (props: Record<string, unknown>) => {
    const React = require("react");
    const { View } = require("react-native");
    return React.createElement(View, { testID: "video-view", ...props });
  },
}));

const spec = (over: Partial<PreviewSpec> = {}): PreviewSpec => ({
  token: 1,
  uri: "https://example.test/a.mp4",
  startSec: 0,
  endSec: null,
  autoplay: true,
  ...over,
});

beforeEach(() => {
  player = new FakePlayer();
});

describe("loading what she tapped", () => {
  it("does NOT seek until the new source is readyToPlay", async () => {
    // Setting currentTime before the replace has landed either no-ops or seeks the OUTGOING item.
    render(<TimelinePreview spec={spec({ startSec: 4 })} ratio={9 / 16} />);
    expect(player.replaced).toEqual(["https://example.test/a.mp4"]);

    player.status = "loading";
    await player.settleReplace();
    expect(player.seeks).toEqual([]);

    player.status = "readyToPlay";
    player.emit("statusChange", { status: "readyToPlay" });
    expect(player.seeks).toEqual([4]);
    expect(player.playing).toBe(true);
  });

  it("seeks straight away when the player was ALREADY ready", async () => {
    // Replacing with a source the player still holds emits no statusChange, so a seek waiting on
    // that event would wait forever.
    render(<TimelinePreview spec={spec({ startSec: 2 })} ratio={9 / 16} />);
    player.status = "readyToPlay";
    await player.settleReplace();
    expect(player.seeks).toEqual([2]);
  });

  it("a load that finishes LATE must not seek the source that replaced it", async () => {
    // Tap A, tap B before A has landed, then let A finish. Without the cancellation B is seeked to
    // A's in-point — and a `uri !== previous` guard cannot help, because it cannot tell which load
    // just finished.
    const view = render(
      <TimelinePreview spec={spec({ token: 1, startSec: 9 })} ratio={9 / 16} />,
    );
    view.rerender(
      <TimelinePreview
        spec={spec({
          token: 2,
          uri: "https://example.test/b.mp4",
          startSec: 1,
        })}
        ratio={9 / 16}
      />,
    );

    player.status = "readyToPlay";
    await player.settleReplace(0); // A, the stale one
    expect(player.seeks).toEqual([]);

    await player.settleReplace(1); // B, the current one
    expect(player.seeks).toEqual([1]);
  });

  it("restarts the SAME clip when she taps it again", async () => {
    // The first thing anyone tries. Keyed on the uri this is a no-op.
    const view = render(
      <TimelinePreview spec={spec({ token: 1, startSec: 3 })} ratio={9 / 16} />,
    );
    player.status = "readyToPlay";
    await player.settleReplace(0);
    expect(player.seeks).toEqual([3]);

    view.rerender(
      <TimelinePreview spec={spec({ token: 2, startSec: 3 })} ratio={9 / 16} />,
    );
    expect(player.seeks).toEqual([3, 3]);
    // …and it does NOT re-open the file to do it. Checkpoint 2 asserted a second load here;
    // checkpoint 3's same-source path makes a re-tap as cheap as a scrub, which is what lets a
    // drag inside one clip stay a drag.
    expect(player.replaced).toHaveLength(1);
  });
});

describe("how the preview plays, versus how a card plays", () => {
  it("does NOT loop", () => {
    // ClipPlayer loops, which is right for a few-second card playing unattended. Here it would
    // hide the out-point and fight the playhead.
    render(<TimelinePreview spec={spec()} ratio={9 / 16} />);
    expect(player.loop).toBe(false);
  });

  it("starts MUTED", () => {
    /*
     * ⚠️ A DELIBERATE REVERSAL of how this shipped at checkpoint 2, which asserted the opposite
     * ("a review surface nobody can hear is one nobody reviews"). Two reasons it flipped: building
     * a timeline means tapping and scrubbing constantly, and Chrome will not autoplay an UNMUTED
     * video without a qualifying user gesture — ours comes from a replaceAsync continuation, so
     * unmuted-by-default did not reliably play at all.
     */
    render(<TimelinePreview spec={spec()} ratio={9 / 16} />);
    expect(player.muted).toBe(true);
  });

  it("stops at the out-point of a trimmed position", async () => {
    // expo-video has no in/out points, so the trim is enforced here or the clip runs on into
    // footage she cut.
    render(
      <TimelinePreview
        spec={spec({ startSec: 2, endSec: 5 })}
        ratio={9 / 16}
      />,
    );
    player.status = "readyToPlay";
    await player.settleReplace();

    player.emit("timeUpdate", { currentTime: 4.5 });
    expect(player.pauses).toBe(0);

    player.emit("timeUpdate", { currentTime: 5.01 });
    expect(player.pauses).toBe(1);
    expect(player.seeks[player.seeks.length - 1]).toBe(5);
  });

  it("plays on to the end when the position has no out-point", async () => {
    render(<TimelinePreview spec={spec({ endSec: null })} ratio={9 / 16} />);
    player.status = "readyToPlay";
    await player.settleReplace();
    player.emit("timeUpdate", { currentTime: 999 });
    expect(player.pauses).toBe(0);
  });
});

describe("the preview plays the video, never a still", () => {
  it("mounts a player once something is selected", async () => {
    render(<TimelinePreview spec={spec()} ratio={9 / 16} />);
    expect(screen.getByTestId("preview-player")).toBeTruthy();
    expect(screen.queryByTestId("poster")).toBeNull();
  });

  it("says nothing is chosen rather than showing a still", () => {
    // An empty state is a DIFFERENT claim from a poster: "nothing chosen", not "here is your clip".
    render(<TimelinePreview spec={null} ratio={9 / 16} />);
    expect(screen.getByTestId("preview-empty")).toBeTruthy();
    expect(screen.queryByTestId("poster")).toBeNull();
    expect(screen.queryByTestId("video-view")).toBeNull();
  });
});

describe("the mute toggle", () => {
  it("unmutes on a tap, and says so to assistive tech", async () => {
    render(<TimelinePreview spec={spec()} ratio={9 / 16} />);
    fireEvent.press(screen.getByTestId("preview-mute"));
    expect(player.muted).toBe(false);
    expect(
      screen.getByTestId("preview-mute").props.accessibilityState.checked,
    ).toBe(true);
  });

  it("⚠️ stays unmuted across a SOURCE SWAP — the scrub-across-a-boundary case", async () => {
    // The bug this exists to stop: she unmutes, scrubs over a clip boundary, and the load path
    // silently re-asserts the default. Unmuting is a decision about the session, not about
    // whichever clip happens to be loaded.
    const view = render(
      <TimelinePreview spec={spec({ token: 1 })} ratio={9 / 16} />,
    );
    player.status = "readyToPlay";
    await player.settleReplace(0);
    fireEvent.press(screen.getByTestId("preview-mute"));
    expect(player.muted).toBe(false);

    view.rerender(
      <TimelinePreview
        spec={spec({ token: 2, uri: "https://example.test/b.mp4" })}
        ratio={9 / 16}
      />,
    );
    await player.settleReplace(1);
    expect(player.muted).toBe(false);
  });
});

describe("scrubbing versus playing", () => {
  it("a scrub SEEKS and PAUSES — it must not start playback", async () => {
    // A clip running on under a dragging finger is the same failure as not seeking at all: the
    // frame she is pointing at is gone by the time she looks at it.
    render(
      <TimelinePreview
        spec={spec({ startSec: 3, autoplay: false })}
        ratio={9 / 16}
      />,
    );
    player.status = "readyToPlay";
    await player.settleReplace();
    expect(player.seeks).toEqual([3]);
    expect(player.playing).toBe(false);
    expect(player.pauses).toBe(1);
  });

  it("⚠️ a scrub INSIDE one clip is a seek, never a reload", async () => {
    // A pan emits an update per frame. If each one replaced the source, dragging inside a single
    // clip would re-open that file dozens of times a second — a slideshow, not a scrub.
    const view = render(
      <TimelinePreview
        spec={spec({ token: 1, startSec: 1, autoplay: false })}
        ratio={9 / 16}
      />,
    );
    player.status = "readyToPlay";
    await player.settleReplace(0);
    expect(player.replaced).toHaveLength(1);

    for (const [i, at] of [2, 3, 4, 5].entries()) {
      view.rerender(
        <TimelinePreview
          spec={spec({ token: 2 + i, startSec: at, autoplay: false })}
          ratio={9 / 16}
        />,
      );
    }
    // Four more scrub positions, still ONE load.
    expect(player.replaced).toHaveLength(1);
    expect(player.seeks).toEqual([1, 2, 3, 4, 5]);
  });

  it("crossing into a DIFFERENT clip does pay for a load", async () => {
    const view = render(
      <TimelinePreview
        spec={spec({ token: 1, autoplay: false })}
        ratio={9 / 16}
      />,
    );
    player.status = "readyToPlay";
    await player.settleReplace(0);
    view.rerender(
      <TimelinePreview
        spec={spec({
          token: 2,
          uri: "https://example.test/b.mp4",
          startSec: 0,
          autoplay: false,
        })}
        ratio={9 / 16}
      />,
    );
    await player.settleReplace(1);
    expect(player.replaced).toEqual([
      "https://example.test/a.mp4",
      "https://example.test/b.mp4",
    ]);
  });
});

describe("reporting progress back", () => {
  it("tells the caller where playback has got to, in SOURCE seconds", async () => {
    const onProgress = jest.fn();
    render(
      <TimelinePreview
        spec={spec({ startSec: 2 })}
        ratio={9 / 16}
        onProgress={onProgress}
      />,
    );
    player.status = "readyToPlay";
    await player.settleReplace();
    player.emit("timeUpdate", { currentTime: 3.4 });
    expect(onProgress).toHaveBeenCalledWith(3.4);
  });

  it("⚠️ a progress tick moves NOTHING — no reload, no seek", async () => {
    // Progress is a report, not a request. If it produced a seek, every tick would re-seek the
    // player and playback would stutter or stall outright.
    render(
      <TimelinePreview spec={spec()} ratio={9 / 16} onProgress={() => {}} />,
    );
    player.status = "readyToPlay";
    await player.settleReplace();
    const seeks = player.seeks.length;
    const loads = player.replaced.length;

    player.emit("timeUpdate", { currentTime: 1 });
    player.emit("timeUpdate", { currentTime: 2 });

    expect(player.seeks).toHaveLength(seeks);
    expect(player.replaced).toHaveLength(loads);
  });
});

describe("what it stops when it goes away", () => {
  it("⚠️ stops the progress loop on unmount, or it runs for the life of the page", () => {
    /*
     * `timeUpdateEventInterval` is backed on web by a plain setInterval that is NOT tied to
     * playback — it fires whether or not anything is playing — and VideoPlayerWeb extends
     * SharedObject without defining release(), so releasing the player does not stop it. The
     * setter's own clearInterval is the only path that does. Every mount otherwise leaks one loop
     * for the life of the page, each retaining its player and media elements.
     */
    const view = render(<TimelinePreview spec={spec()} ratio={9 / 16} />);
    expect(player.timeUpdateEventInterval).toBeGreaterThan(0);

    view.unmount();
    expect(player.timeUpdateEventInterval).toBe(0);
    expect(player.intervalSets[player.intervalSets.length - 1]).toBe(0);
  });
});

describe("a held photo", () => {
  const photo = spec({
    token: 2,
    uri: "https://example.test/p.jpg",
    autoplay: false,
    still: true,
  });

  it("is shown as the picture, and never loaded into the video player", () => {
    render(<TimelinePreview spec={photo} ratio={9 / 16} />);
    expect(screen.getByTestId("preview-still-photo").props.source).toEqual({
      uri: "https://example.test/p.jpg",
    });
    expect(player.replaced).toEqual([]);
    expect(screen.queryByTestId("video-view")).toBeNull();
  });

  it("pauses the clip that was playing, and the next clip she taps loads as before", async () => {
    const view = render(<TimelinePreview spec={spec()} ratio={9 / 16} />);
    player.status = "readyToPlay";
    await player.settleReplace();
    expect(player.playing).toBe(true);

    view.rerender(<TimelinePreview spec={photo} ratio={9 / 16} />);
    expect(player.playing).toBe(false);
    expect(player.replaced).toEqual(["https://example.test/a.mp4"]);

    view.rerender(
      <TimelinePreview
        spec={spec({ token: 3, uri: "https://example.test/b.mp4" })}
        ratio={9 / 16}
      />,
    );
    expect(player.replaced).toEqual([
      "https://example.test/a.mp4",
      "https://example.test/b.mp4",
    ]);
  });
});
