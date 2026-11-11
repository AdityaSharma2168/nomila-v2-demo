/**
 * MediaDetailScreen — the library's play button, pinned through a render.
 *
 * ⚠️ WHY THIS SUITE EXISTS AT ALL. The play glyph here was a `<View>` with no `onPress` for months
 * and nobody noticed, because a decorative button and a wired one render IDENTICALLY. Asserting on
 * markup cannot tell them apart; only pressing it and seeing what happens can.
 *
 * `playerBox.test.ts` pins the decision (`libraryPreview`); this pins that the screen actually asks
 * it, and that a poster and a player are never both on screen.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { MediaDetailScreen } from "./MediaDetailScreen";

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {}, navigate: () => {} }),
  useRoute: () => ({ params: { assetId: "a-1" } }),
}));

jest.mock("../lib/haptics", () => ({
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

/** ⚠️ A marker, so "the poster stood in for playback" is a visible failure rather than a guess. */
jest.mock("../components/studio/ClipPoster", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { ClipPoster: () => React.createElement(Text, { testID: "poster" }) };
});

jest.mock("expo-video", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    useVideoPlayer: (uri: string, setup?: (p: object) => void) => {
      const p = { uri, muted: false, loop: false };
      setup?.(p);
      return p;
    },
    VideoView: ({ player }: { player: { uri: string; muted: boolean } }) =>
      React.createElement(
        Text,
        { testID: "player", accessibilityLabel: String(player.muted) },
        player.uri,
      ),
  };
});

const detail = (over: Record<string, unknown> = {}) => ({
  id: null,
  asset_id: "a-1",
  gcs_path: "p",
  platform: "upload",
  origin: "upload",
  media_type: "VIDEO",
  url: "https://example.test/still.jpg",
  thumb_url: "https://example.test/still.jpg",
  video_url: "https://example.test/clip.mp4",
  poster_gcs_path: null,
  duration_seconds: 12,
  enriched: true,
  brand_safe: true,
  shot_type: null,
  brands_visible: [],
  vision: null,
  embedded: false,
  ...over,
});

let current: ReturnType<typeof detail> | null = detail();
jest.mock("../hooks/use-media-library", () => ({
  useMediaDetail: () => ({ detail: current, isLoading: false }),
}));
// The read hook (PR 9.5) reaches the query client and AsyncStorage; the screen under test never taps it here.
const mutate = jest.fn();
jest.mock("../hooks/use-studio-media", () => ({
  useClipRead: () => ({ mutate, isPending: false }),
}));

beforeEach(() => {
  current = detail();
});

describe("playing a video from the library", () => {
  it("shows the still and no player until play is pressed", () => {
    render(<MediaDetailScreen />);
    expect(screen.getByTestId("poster")).toBeTruthy();
    expect(screen.queryByTestId("player")).toBeNull();
    expect(screen.getByTestId("library-play")).toBeTruthy();
  });

  it("⚠️ pressing play starts a REAL player — the button was decorative for months", () => {
    render(<MediaDetailScreen />);
    fireEvent.press(screen.getByTestId("library-play"));
    expect(screen.getByTestId("library-player")).toBeTruthy();
    expect(screen.getByTestId("player")).toBeTruthy();
  });

  it("⚠️ plays the MP4, and the poster is gone rather than sitting behind it", () => {
    // A still standing in for playback is indistinguishable from a broken player — the V7 symptom.
    // Asserting the url alone would pass with a poster drawn as well.
    render(<MediaDetailScreen />);
    fireEvent.press(screen.getByTestId("library-play"));
    expect(screen.getByTestId("player")).toHaveTextContent(
      "https://example.test/clip.mp4",
    );
    expect(screen.queryByTestId("poster")).toBeNull();
  });

  it("⚠️ starts MUTED, the same as the Studio preview", () => {
    render(<MediaDetailScreen />);
    fireEvent.press(screen.getByTestId("library-play"));
    expect(screen.getByTestId("player").props.accessibilityLabel).toBe("true");
    expect(screen.getByTestId("library-mute")).toBeTruthy();
  });

  it("unmutes on the toggle, and says so to assistive tech", () => {
    render(<MediaDetailScreen />);
    fireEvent.press(screen.getByTestId("library-play"));
    fireEvent.press(screen.getByTestId("library-mute"));
    expect(
      screen.getByTestId("library-mute").props.accessibilityState.checked,
    ).toBe(true);
  });
});

describe("what never becomes a player", () => {
  it("offers no play button for a photo", () => {
    current = detail({ media_type: "IMAGE", video_url: null });
    render(<MediaDetailScreen />);
    expect(screen.queryByTestId("library-play")).toBeNull();
    expect(screen.getByTestId("poster")).toBeTruthy();
  });

  it("⚠️ offers none for a video we hold no bytes for", () => {
    // An Instagram row that was never rehosted: a poster and no mp4. A play button there would be
    // the same lie this checkpoint exists to remove.
    current = detail({ video_url: null });
    render(<MediaDetailScreen />);
    expect(screen.queryByTestId("library-play")).toBeNull();
  });
});

describe("Analyzed means read, for a video (PR 9.5, B4)", () => {
  const poster = {
    athlete_present: true,
    description: "from the poster",
    disposition: "as_is",
  };
  it("a poster-tagged video — vision, no beats — is 'Not read yet', not 'Analyzed'", () => {
    current = detail({
      vision: poster,
      read: { state: "unread", quotedUsd: 0.0115 },
    });
    render(<MediaDetailScreen />);
    expect(screen.getByText("Not read yet")).toBeTruthy();
    expect(screen.queryByText("Analyzed")).toBeNull();
  });
  it("a video read as a clip is 'Analyzed'", () => {
    current = detail({
      vision: { ...poster, beats: [] },
      read: { state: "done", beats: 0 },
    });
    render(<MediaDetailScreen />);
    expect(screen.getByText("Analyzed")).toBeTruthy();
  });
  it("an image with vision is 'Analyzed', unchanged", () => {
    current = detail({
      media_type: "IMAGE",
      video_url: null,
      vision: poster,
      read: null,
    });
    render(<MediaDetailScreen />);
    expect(screen.getByText("Analyzed")).toBeTruthy();
  });
  it("with EXPO_PUBLIC_STUDIO_CLIP_READ off (this test env) no read pill renders, whatever the server says", () => {
    current = detail({
      vision: poster,
      read: { state: "unread", quotedUsd: 0.0115 },
    });
    render(<MediaDetailScreen />);
    expect(screen.queryByTestId("read-clip")).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });
});

/**
 * PR 12 lane 3 — the detail route now carries tagged/subject/hero/reject/face on the shaped row with the
 * flag on; this screen reads `vision` and never those. ⚠️ MUTATION "MediaDetail renders differently
 * with the new fields present": render `detail.subject` anywhere — the trees stop matching, reds by name.
 */
it("renders the same tree with and without the PR 12 lane 3 fields on the row", () => {
  current = detail({
    media_type: "IMAGE",
    video_url: null,
    duration_seconds: null,
  });
  const before = render(<MediaDetailScreen />).toJSON();
  current = detail({
    media_type: "IMAGE",
    video_url: null,
    duration_seconds: null,
    tagged: true,
    subject: "another_person",
    hero: 0.9,
    reject: true,
    face: "none",
  });
  const after = render(<MediaDetailScreen />).toJSON();
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
});
