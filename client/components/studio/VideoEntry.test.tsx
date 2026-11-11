/**
 * VideoEntry — rendered, through the real component.
 *
 * ─── WHAT THIS PINS THAT A PURE TEST CANNOT ─────────────────────────────────────────────────────
 *
 * That an UPLOADED clip and a GENERATED clip reach the same player through the same component.
 * `videoEntryLogic.test.ts` proves the two view models are equal; this proves the renderer does
 * not then branch on origin somewhere below that — which is the failure the two coming pipelines
 * (upload → stitch → music, generate-from-keyframes) would actually hit.
 *
 * `expo-video` is mocked to a plain view: whether a real Veo mp4 decodes is device acceptance and
 * is verifiable only after the flag-flip. What is tested here is the wiring — that the component
 * hands the player a uri at all, and which one.
 */
import { render, screen } from "@testing-library/react-native";
import type { OutputView } from "../../screens/studio/threadLogic";
import {
  readyVideoEntry,
  videoEntry,
  videoEntryFromJob,
} from "../../screens/studio/videoEntryLogic";
import { VideoEntry } from "./VideoEntry";

/**
 * ─── THE NATIVE EDGES, STUBBED ──────────────────────────────────────────────────────────────────
 *
 * Icons, haptics, animation and the video decoder are native modules with no linkage in a Jest
 * process (`expo-modules-core` throws on import without one). None of them is what this file is
 * about, and this repo has no `jest-expo` preset — adding one would be a third dependency for four
 * stubs. They are mocked here, in the one suite that needs them, rather than globally.
 */
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});
jest.mock("react-native-reanimated", () =>
  require("react-native-reanimated/mock"),
);
jest.mock("../../lib/haptics", () => ({
  light: () => {},
  medium: () => {},
  heavy: () => {},
  selection: () => {},
  success: () => {},
  warning: () => {},
  error: () => {},
}));

/**
 * ⚠️  MOCKED TO A MARKER, AND THE MARKER MUST NEVER APPEAR IN A RESULT.
 *
 * V7 shipped a stitched result that drew a placeholder instead of the video. `ClipPoster` is for
 * TILES — a strip, a track, a grid — where a still is honest and a decoder per tile is the cost to
 * avoid. A RESULT showing a still is indistinguishable from a broken player.
 *
 * Asserting that the player was handed an `.mp4` cannot catch this on its own: that assertion
 * still passes if something renders a poster as WELL. So the check is structural — if `VideoEntry`
 * ever reaches for `ClipPoster`, this mock activates and the marker shows up in the tree.
 */
jest.mock("./ClipPoster", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { ClipPoster: () => React.createElement(Text, { testID: "poster" }) };
});

/** The player, reduced to "what uri were you given" — the only thing this file can assert. */
jest.mock("expo-video", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    useVideoPlayer: (uri: string) => ({ uri, loop: false, muted: false }),
    VideoView: ({ player }: { player: { uri: string } }) =>
      React.createElement(Text, { testID: "player" }, player.uri),
  };
});

const clip = (assetId: string, uri: string | null): OutputView => ({
  assetId,
  mediaType: "VIDEO",
  uri,
  removed: uri === null,
  editable: false,
  rejected: false,
});

describe("a video is a video, whatever made it", () => {
  it("plays an UPLOADED clip", () => {
    render(
      <VideoEntry view={readyVideoEntry([clip("u-1", "file:///hers.mp4")])} />,
    );
    expect(screen.getByTestId("player")).toHaveTextContent("file:///hers.mp4");
  });

  it("plays a GENERATED clip, through the same component and the same player", () => {
    const view = videoEntryFromJob(
      {
        status: "succeeded",
        startedAt: null,
        assets: [
          {
            assetId: "g-1",
            mediaType: "VIDEO",
            url: "https://example.test/veo.mp4",
            approvalStatus: "draft",
          },
        ],
      },
      "made",
    );
    render(<VideoEntry view={view} />);
    expect(screen.getByTestId("player")).toHaveTextContent(
      "https://example.test/veo.mp4",
    );
  });

  it("renders from the mp4 url, never a thumbnail — a fresh clip has no poster yet", () => {
    // services/videoPoster.ts is a CRON worker and studio/videoRunner.ts sets no thumb, so
    // `gcs_thumb_path` is NULL when a clip lands. Anything built on a poster is an empty tile.
    render(
      <VideoEntry
        view={readyVideoEntry([clip("u-1", "https://example.test/clip.mp4")])}
      />,
    );
    expect(screen.getByTestId("player")).toHaveTextContent(/\.mp4$/);
  });

  it("⚠️ a READY result plays the real mp4 and renders NO poster anywhere — the V7 regression", () => {
    // The insurance. A stitched result that draws a still instead of the video is what V7 shipped,
    // and it is indistinguishable from a broken player. Posters are tiles-only.
    const view = videoEntryFromJob(
      {
        status: "succeeded",
        startedAt: null,
        assets: [
          {
            assetId: "s-1",
            mediaType: "VIDEO",
            url: "https://example.test/stitched.mp4",
            approvalStatus: "draft",
          },
        ],
      },
      "made",
    );
    render(<VideoEntry view={view} muted={false} ratio={9 / 16} />);

    expect(screen.getByTestId("player")).toHaveTextContent(
      "https://example.test/stitched.mp4",
    );
    // Structural, not a url check: a poster rendered ALONGSIDE the player would satisfy the line
    // above and still be the bug.
    expect(screen.queryByTestId("poster")).toBeNull();
  });
});

describe("the phases she can actually see", () => {
  it("queued and working say different things, and neither shows a player", () => {
    const { unmount } = render(<VideoEntry view={videoEntry("queued")} />);
    const queued = screen.getByLabelText(/./);
    expect(queued.props.accessibilityRole).toBe("progressbar");
    expect(screen.queryByTestId("player")).toBeNull();
    const queuedLabel = queued.props.accessibilityLabel;
    unmount();

    render(<VideoEntry view={videoEntry("working")} />);
    const working = screen.getByLabelText(/./);
    expect(screen.queryByTestId("player")).toBeNull();
    // The distinction the provisional tab exists to show: one pulse cannot say both of these.
    expect(working.props.accessibilityLabel).not.toBe(queuedLabel);
  });

  it("an ended entry is not announced as in progress", () => {
    render(<VideoEntry view={videoEntry("failed")} />);
    expect(screen.getByLabelText(/./).props.accessibilityRole).toBe("text");
  });

  it("a clip whose object is gone is a tombstone, never a broken player", () => {
    render(<VideoEntry view={readyVideoEntry([clip("u-1", null)])} />);
    expect(screen.queryByTestId("player")).toBeNull();
    expect(screen.getByLabelText("Clip unavailable")).toBeTruthy();
  });

  it("shows the caption it is given, and calls it nothing more than that", () => {
    render(<VideoEntry view={videoEntry("queued")} caption="her-clip.mov" />);
    expect(screen.getByText("her-clip.mov")).toBeTruthy();
  });
});
