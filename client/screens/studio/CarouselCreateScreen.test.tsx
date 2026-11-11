/**
 * CarouselCreateScreen.test — the flag-off leak (PR 10, R-1 / AUDIT2 F10), rendered.
 *
 * With STUDIO_IMAGE_EDIT off the edit routes answer 404, so the Set-it-up Carousel chip must go to Make it
 * (toPlan) and the Create screen must mount none of its hooks: the recommend pass fires on mount, before any
 * tap, and would 404 before she read a word.
 *
 * REVERT CHECKS, red by name:
 *   "Create screen fires a request with the flag off"      → render CarouselCreateOpen whatever the flag
 *   "Carousel chip renders with STUDIO_IMAGE_EDIT off"      → drop the guard in SetupScreen's toCarousel
 *
 * The flag module is mocked as a mutable object: ts-jest's CJS output reads `flags_1.STUDIO_IMAGE_EDIT`
 * at use time, so flipping it between tests re-decides the render without a second module registry.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { CarouselCreateScreen } from "./CarouselCreateScreen";
import { SetupScreen } from "./SetupScreen";

// Every factory builds its own fns (ts-jest hoists jest.mock above the imports, so a file-level const
// would be in its dead zone when the screen first requires the mock); tests reach them via requireMock.
jest.mock("../../lib/flags", () => ({ STUDIO_IMAGE_EDIT: false }));
jest.mock("@react-navigation/native", () => {
  const navigate = jest.fn();
  const goBack = jest.fn();
  return {
    useNavigation: () => ({ navigate, goBack }),
    useRoute: () => ({
      params: {
        brand: "Solstice",
        briefLines: ["A 4:5 image for Solstice."],
        refs: ["11111111-0000-4000-8000-000000000001"],
      },
    }),
  };
});
jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return { SafeAreaView: View };
});
jest.mock("../../lib/haptics", () => {
  const noop = () => {};
  const fns = {
    tap: noop,
    press: noop,
    select: noop,
    light: noop,
    medium: noop,
    heavy: noop,
    success: noop,
    warning: noop,
    error: noop,
  };
  return { ...fns, haptics: fns };
});
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});
jest.mock("../../lib/query-client", () => ({
  getApiUrl: () => "http://api.test",
  getAuthHeaders: async () => ({}),
}));
// The Create screen's heavy children — none of them is what this test is about.
jest.mock("../../components/studio/StudioMediaPicker", () => ({
  StudioMediaPicker: () => null,
}));
jest.mock("../../components/studio/AssetViewer", () => ({
  AssetViewer: () => null,
}));
jest.mock("../../components/media/MediaLibraryView", () => ({
  MediaLibraryView: () => null,
}));
jest.mock("../../hooks/use-media-library", () => ({
  pickFromCameraRoll: jest.fn(),
  useUploadMedia: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("../../lib/download-asset", () => ({
  fileNameFor: () => "x",
  saveRemoteAsset: jest.fn(),
}));
// The edit hooks, observed: the recommend pass is the one that runs on mount.
jest.mock("../../hooks/use-studio-edits", () => {
  const inert = () => ({ mutateAsync: jest.fn(), isPending: false });
  return {
    useRecommendEdits: jest.fn(() => ({ data: undefined })),
    useBatch: () => ({ data: undefined }),
    useBatchQuote: inert,
    useBatchRun: inert,
    useBatchReroll: inert,
    useBatchAcceptAll: inert,
    useEditAccept: inert,
    useEditDiscard: inert,
  };
});

const flags = jest.requireMock("../../lib/flags") as {
  STUDIO_IMAGE_EDIT: boolean;
};
const { navigate, goBack } = (
  jest.requireMock("@react-navigation/native") as {
    useNavigation: () => { navigate: jest.Mock; goBack: jest.Mock };
  }
).useNavigation();
const { useRecommendEdits } = jest.requireMock(
  "../../hooks/use-studio-edits",
) as { useRecommendEdits: jest.Mock };

const fetchSpy = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
}));

beforeEach(() => {
  flags.STUDIO_IMAGE_EDIT = false;
  navigate.mockClear();
  useRecommendEdits.mockClear();
  fetchSpy.mockClear();
  (global as unknown as { fetch: unknown }).fetch = fetchSpy;
});

describe("the flag-off leak (PR 10, R-1)", () => {
  /** ⚠️ MUTATION "Create screen fires a request with the flag off": render CarouselCreateOpen whatever the flag. */
  it("with the flag off the Create screen is a closed door: no hook mounts, no request, the way back works", () => {
    render(<CarouselCreateScreen />);
    expect(screen.getByTestId("carousel-closed")).toBeTruthy();
    expect(screen.queryByTestId("carousel-quote-cta")).toBeNull();
    expect(useRecommendEdits).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText("Back"));
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it("control — with the flag on the same route mounts the open screen and its recommend pass", () => {
    flags.STUDIO_IMAGE_EDIT = true;
    render(<CarouselCreateScreen />);
    expect(screen.queryByTestId("carousel-closed")).toBeNull();
    expect(useRecommendEdits).toHaveBeenCalled();
    // The carried ref lands through an effect: the first call sees no ref, a later one sees hers.
    expect(
      useRecommendEdits.mock.calls.some(
        (c) => c[0] === "11111111-0000-4000-8000-000000000001",
      ),
    ).toBe(true);
  });

  /** ⚠️ MUTATION "Carousel chip renders with STUDIO_IMAGE_EDIT off": drop the guard in SetupScreen's toCarousel. */
  it("with STUDIO_IMAGE_EDIT off, neither screen makes a network call on mount, and the Set-it-up Carousel chip's handler is toPlan — StudioMakeIt, never the Create screen", () => {
    render(<CarouselCreateScreen />);
    expect(fetchSpy).not.toHaveBeenCalled();
    render(
      <SetupScreen
        title="Solstice"
        subtitle="A brand post"
        brandName="Solstice"
        brandId={7}
        concept={{
          title: "Fast is built slowly",
          line: "Everyone sees the speed.",
        }}
        onBack={() => {}}
      />,
    );
    // On mount, before any interaction: nothing asked of the network.
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText("Carousel"));
    expect(screen.getByLabelText("Build the plan")).toBeTruthy();
    expect(screen.queryByLabelText("Make the ads")).toBeNull();
    fireEvent.press(screen.getByLabelText("Build the plan"));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toBe("StudioMakeIt");
    expect(navigate.mock.calls[0][1]).toMatchObject({
      format: "carousel",
      brandName: "Solstice",
      brandId: 7,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("control — with the flag on the same chip reads Make the ads and opens the Create screen", () => {
    flags.STUDIO_IMAGE_EDIT = true;
    render(
      <SetupScreen
        title="Solstice"
        subtitle="A brand post"
        brandName="Solstice"
        brandId={7}
        concept={{
          title: "Fast is built slowly",
          line: "Everyone sees the speed.",
        }}
        onBack={() => {}}
      />,
    );
    fireEvent.press(screen.getByLabelText("Carousel"));
    fireEvent.press(screen.getByLabelText("Make the ads"));
    expect(navigate.mock.calls[0][0]).toBe("StudioCarouselCreate");
  });
});
