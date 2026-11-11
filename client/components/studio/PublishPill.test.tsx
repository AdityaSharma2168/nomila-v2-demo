/**
 * PublishPill.test.tsx — the pill, rendered, with the three hooks mocked at the module boundary.
 * No network. What is asserted here is what the pure tests in publishLogic.test.ts cannot see:
 * that the COMPONENT wires the presses to the state machine and not around it.
 *
 * REVERT CHECKS, red by name:
 *   RC-C1  wire the pill straight to the send      → "NEVER ONE TAP: the pill and Continue send nothing…"
 *   RC-C2  drop the step guard AND the disabled     → "a second press on the confirm button does not send a second request"
 *   RC-C3  render with the switch off               → "renders nothing when the server says off…"
 *   RC-C4  reconnect pill opens the post flow       → "'Reconnect to post' reconnects — it never opens the caption box"
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type {
  PublishJobWire,
  PublishOptionsAnswer,
} from "../../screens/studio/publishLogic";
import { PublishPill } from "./PublishPill";

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
jest.mock("../../lib/haptics", () => {
  const noop = () => {};
  const fns = {
    tap: noop,
    press: noop,
    select: noop,
    success: noop,
    warning: noop,
    error: noop,
  };
  return { ...fns, haptics: fns };
});

const mockState: {
  options: PublishOptionsAnswer | undefined;
  job: PublishJobWire | null;
  mutateAsync: jest.Mock;
  error: Error | null;
  connect: jest.Mock;
  refetch: jest.Mock;
} = {
  options: undefined,
  job: null,
  mutateAsync: jest.fn(),
  error: null,
  connect: jest.fn(async () => {}),
  refetch: jest.fn(),
};

jest.mock("../../hooks/use-studio-publish", () => ({
  usePublishOptions: () => ({
    data: mockState.options,
    refetch: mockState.refetch,
  }),
  useQueuePublish: () => ({
    mutateAsync: mockState.mutateAsync,
    error: mockState.error,
  }),
  usePublishJob: (id: string | null) => ({
    data: id ? mockState.job : undefined,
  }),
}));
jest.mock("../../hooks/use-platform-oauth", () => ({
  usePlatformOAuth: () => ({ connect: mockState.connect, connecting: false }),
}));

const LIVE: PublishOptionsAnswer = {
  mode: "live",
  instagram: { connected: true, handle: "synthetic_handle", canPublish: true },
  limits: { captionMaxChars: 2200, minSeconds: 3, maxBytes: 300_000_000 },
  asset: { postable: true, approvalStatus: "approved", needsApproval: false },
  latest: null,
};

const ASSET = "aaaaaaaa-1111-4111-8111-111111111111";

beforeEach(() => {
  mockState.options = LIVE;
  mockState.job = null;
  mockState.error = null;
  mockState.mutateAsync = jest.fn(async () => ({
    publishId: "p-1",
    status: "queued",
    alreadyLive: false,
    dryRun: false,
    handle: "synthetic_handle",
  }));
  mockState.connect = jest.fn(async () => {});
  mockState.refetch = jest.fn();
});

describe("PublishPill", () => {
  /** RC-C1. */
  it("NEVER ONE TAP: the pill and Continue send nothing — only the confirm button does, after naming the account", async () => {
    render(<PublishPill assetId={ASSET} />);

    fireEvent.press(screen.getByTestId("publish-pill"));
    // The pill is gone; what it opened is a caption box. Nothing has been sent.
    expect(screen.queryByTestId("publish-pill")).toBeNull();
    expect(screen.getByTestId("publish-caption")).toBeTruthy();
    expect(mockState.mutateAsync).not.toHaveBeenCalled();

    fireEvent.changeText(
      screen.getByTestId("publish-caption"),
      "  game day #one  ",
    );
    fireEvent.press(screen.getByTestId("publish-review"));
    expect(mockState.mutateAsync).not.toHaveBeenCalled();

    // The account, named, on screen, before the button that sends.
    expect(screen.getByTestId("publish-sentence").props.children).toBe(
      "This posts to @synthetic_handle now.",
    );
    expect(screen.getByText("game day #one")).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId("publish-confirm"));
    });
    expect(mockState.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mockState.mutateAsync).toHaveBeenCalledWith({
      assetId: ASSET,
      platform: "instagram",
      caption: "game day #one",
    });
  });

  /** RC-C2. */
  it("a second press on the confirm button does not send a second request", async () => {
    let release: (v: unknown) => void = () => {};
    mockState.mutateAsync = jest.fn(
      () => new Promise((resolve) => (release = resolve)),
    );
    render(<PublishPill assetId={ASSET} />);
    fireEvent.press(screen.getByTestId("publish-pill"));
    fireEvent.press(screen.getByTestId("publish-review"));

    await act(async () => {
      fireEvent.press(screen.getByTestId("publish-confirm"));
      fireEvent.press(screen.getByTestId("publish-confirm"));
      fireEvent.press(screen.getByTestId("publish-confirm"));
    });
    expect(mockState.mutateAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({
        publishId: "p-1",
        status: "queued",
        alreadyLive: false,
        dryRun: false,
        handle: null,
      });
    });
  });

  it("a draft is approved BY the confirm, and the button says so", async () => {
    mockState.options = {
      ...(LIVE as object),
      asset: { postable: true, approvalStatus: "draft", needsApproval: true },
    } as PublishOptionsAnswer;
    render(<PublishPill assetId={ASSET} />);
    fireEvent.press(screen.getByTestId("publish-pill"));
    fireEvent.press(screen.getByTestId("publish-review"));
    expect(screen.getByText("Approve and post")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId("publish-confirm"));
    });
    expect(mockState.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ approve: true }),
    );
  });

  it("Back returns to the caption with her words intact, and Cancel closes it — neither sends", () => {
    render(<PublishPill assetId={ASSET} />);
    fireEvent.press(screen.getByTestId("publish-pill"));
    fireEvent.changeText(screen.getByTestId("publish-caption"), "keep me");
    fireEvent.press(screen.getByTestId("publish-review"));
    fireEvent.press(screen.getByTestId("publish-back"));
    expect(screen.getByTestId("publish-caption").props.value).toBe("keep me");
    fireEvent.press(screen.getByTestId("publish-cancel"));
    expect(screen.getByTestId("publish-pill")).toBeTruthy();
    expect(mockState.mutateAsync).not.toHaveBeenCalled();
  });

  it("a caption over the limit cannot continue", () => {
    render(<PublishPill assetId={ASSET} />);
    fireEvent.press(screen.getByTestId("publish-pill"));
    fireEvent.changeText(
      screen.getByTestId("publish-caption"),
      "x".repeat(2201),
    );
    expect(screen.getByText("2,201 of 2,200")).toBeTruthy();
    fireEvent.press(screen.getByTestId("publish-review"));
    expect(screen.queryByTestId("publish-sentence")).toBeNull();
  });

  /** RC-C3. */
  it("renders nothing when the server says off, when the route is missing, and before it has answered", () => {
    for (const options of [
      { mode: "off" } as PublishOptionsAnswer,
      "unavailable" as const,
      undefined,
    ]) {
      mockState.options = options;
      const view = render(<PublishPill assetId={ASSET} />);
      expect(view.toJSON()).toBeNull();
      view.unmount();
    }
  });

  /** RC-C4. */
  it("'Reconnect to post' reconnects — it never opens the caption box", async () => {
    mockState.options = {
      ...(LIVE as object),
      instagram: {
        connected: true,
        handle: "synthetic_handle",
        canPublish: false,
      },
    } as PublishOptionsAnswer;
    render(<PublishPill assetId={ASSET} />);
    expect(screen.getByText("Reconnect to post")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId("publish-pill"));
    });
    expect(mockState.connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("publish-caption")).toBeNull();
    expect(mockState.mutateAsync).not.toHaveBeenCalled();
  });

  it("shows Posting… with no button while the job is live, then the link when it lands", async () => {
    mockState.options = {
      ...(LIVE as object),
      latest: {
        publishId: "p-0",
        assetId: ASSET,
        platform: "instagram",
        status: "running",
        posted: false,
        dryRun: false,
        permalink: null,
        error: null,
        errorCode: null,
      },
    } as PublishOptionsAnswer;
    const view = render(<PublishPill assetId={ASSET} />);
    expect(screen.getByTestId("publish-posting")).toBeTruthy();
    expect(screen.queryByTestId("publish-pill")).toBeNull();
    view.unmount();

    mockState.options = {
      ...(LIVE as object),
      latest: {
        publishId: "p-0",
        assetId: ASSET,
        platform: "instagram",
        status: "succeeded",
        posted: true,
        dryRun: false,
        permalink: "https://example.test/reel/1",
        error: null,
        errorCode: null,
      },
    } as PublishOptionsAnswer;
    render(<PublishPill assetId={ASSET} />);
    expect(screen.getByText("See it on Instagram")).toBeTruthy();
    expect(screen.getByTestId("publish-note").props.children).toBe("Posted.");
  });

  it("shows the server's refusal of the request in its own words", () => {
    mockState.error = new Error("Reconnect Instagram to allow posting.");
    render(<PublishPill assetId={ASSET} />);
    expect(screen.getByTestId("publish-refusal").props.children).toBe(
      "Reconnect Instagram to allow posting.",
    );
  });

  it("warns before a second try when the last one may have posted", () => {
    mockState.options = {
      ...(LIVE as object),
      latest: {
        publishId: "p-0",
        assetId: ASSET,
        platform: "instagram",
        status: "failed",
        posted: false,
        dryRun: false,
        permalink: null,
        error:
          "We asked Instagram to post this and lost the answer, so it may have posted. Check Instagram before posting it again.",
        errorCode: "may_have_posted",
      },
    } as PublishOptionsAnswer;
    render(<PublishPill assetId={ASSET} />);
    expect(screen.getByText("Post to Instagram")).toBeTruthy();
    fireEvent.press(screen.getByTestId("publish-pill"));
    fireEvent.press(screen.getByTestId("publish-review"));
    expect(screen.getByTestId("publish-warning").props.children).toMatch(
      /may already have posted/,
    );
  });
});
