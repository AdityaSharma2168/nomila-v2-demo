/**
 * StudioMediaPicker.test.tsx — the shared picker, rendered, with its hooks mocked at the module
 * boundary (PublishPill.test.tsx's shape). No network. What the pure suite (mediaPickerLogic.test.ts)
 * cannot see: that the COMPONENT sends a search only on submit, pages on scroll, offers only its
 * mount's chips, hands the parent whole rows, and runs an upload through the rights check and the
 * server's list before anything is picked.
 *
 * REVERT CHECKS, red by name:
 *   RC5a  search as she types, not on submit       → "typing sends nothing — a search is sent once, when she submits"
 *   RC5b  no refresh of the lists after an upload  → "a new upload is selectable at once — the lists are refreshed, then the server's row is picked"
 *   RC5c  the strip draws the first page only      → "a pick from further down shows at the head of the strip, with its number"
 *   MI1   the upload checked against page 1 again  → "an upload is asked for BY ID — a first page it would never make does not refuse it"
 *         (quality-scrappy, Investigation 12)
 */
import React from "react";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StudioMediaPicker } from "./StudioMediaPicker";
import { RightsAckRequired } from "../../hooks/use-media-library";
import type { PickerRow } from "../../screens/studio/mediaPickerLogic";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});

const photo = (id: string): PickerRow => ({
  kind: "photo",
  assetId: id,
  imageUrl: `https://x/${id}.jpg`,
  thumbUrl: `https://x/${id}-t.jpg`,
  origin: "Uploaded",
});

const mockState = {
  pages: [[photo("a"), photo("b")]] as PickerRow[][],
  hasNextPage: false,
  fetchNextPage: jest.fn(),
  search: undefined as unknown,
  listCalls: [] as { origins: readonly string[]; enabled: boolean }[],
  searchCalls: [] as { q: string; enabled: boolean }[],
  fetchPage: jest.fn(),
  fetchRows: jest.fn(),
  mutateAsync: jest.fn(),
  pick: jest.fn(),
};

jest.mock("../../hooks/use-studio-media", () => ({
  STUDIO_MEDIA_KEY: ["studio", "media"],
  useStudioMedia: (p: { origins: readonly string[] }, enabled = true) => {
    mockState.listCalls.push({ origins: p.origins, enabled });
    return {
      data: {
        pages: mockState.pages.map((items) => ({ items, nextCursor: null })),
      },
      isLoading: false,
      isError: false,
      hasNextPage: mockState.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: mockState.fetchNextPage,
    };
  },
  useStudioMediaSearch: (p: { q: string }, enabled = true) => {
    mockState.searchCalls.push({ q: p.q, enabled });
    return { data: enabled ? mockState.search : undefined, isLoading: false };
  },
  fetchStudioMediaPage: (...a: unknown[]) => mockState.fetchPage(...a),
  fetchStudioMediaRows: (...a: unknown[]) => mockState.fetchRows(...a),
}));

// PR 12: the label is flag-gated; every test here runs with it ON (the pure `tileLabel` test covers OFF).
jest.mock("../../lib/flags", () => ({ STUDIO_LIBRARY_FIELDS: true }));

jest.mock("../../hooks/use-media-library", () => {
  class RightsAckRequired extends Error {
    constructor() {
      super("rights_ack_required");
    }
  }
  return {
    RightsAckRequired,
    useUploadMedia: () => ({
      mutateAsync: mockState.mutateAsync,
      isPending: false,
    }),
    pickFromCameraRoll: (...a: unknown[]) => mockState.pick(...a),
  };
});

let qc: QueryClient;
const onPick = jest.fn();

/** A mount's own tile: a Pressable that says which row it is and what mark it carries. */
const renderTile = (
  row: PickerRow,
  t: { mark: string | null; onPress: () => void },
) => (
  <Pressable testID={`tile-${row.assetId}`} onPress={t.onPress}>
    <Text>{`${row.assetId}:${t.mark ?? "-"}`}</Text>
  </Pressable>
);

const mount = (
  over: Partial<React.ComponentProps<typeof StudioMediaPicker>> = {},
) =>
  render(
    <QueryClientProvider client={qc}>
      <StudioMediaPicker
        kind="photos"
        origins={["upload", "generated"]}
        onPick={onPick}
        renderTile={renderTile}
        context="board"
        label="Add this photo to the board"
        upload="photo"
        {...over}
      />
    </QueryClientProvider>,
  );

beforeEach(() => {
  qc = new QueryClient();
  jest.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  onPick.mockReset();
  mockState.pages = [[photo("a"), photo("b")]];
  mockState.hasNextPage = false;
  mockState.fetchNextPage.mockReset();
  mockState.search = undefined;
  mockState.listCalls = [];
  mockState.searchCalls = [];
  mockState.fetchPage.mockReset();
  mockState.fetchRows.mockReset();
  mockState.mutateAsync.mockReset();
  mockState.pick.mockReset();
});

it("the strip draws each row through the mount's own tile, and View more opens the library", () => {
  mount();
  expect(screen.getByText("a:-")).toBeTruthy();
  expect(screen.getByText("b:-")).toBeTruthy();
  expect(screen.queryByTestId("media-picker-grid")).toBeNull();

  fireEvent.press(screen.getByTestId("media-picker-view-more"));

  expect(screen.getByTestId("media-picker-grid")).toBeTruthy();
  expect(screen.getByTestId("media-picker-tile-a")).toBeTruthy();
});

it("a tap on the strip or in the library reaches the parent as the whole row", () => {
  mount();
  fireEvent.press(screen.getByTestId("tile-a"));
  fireEvent.press(screen.getByTestId("media-picker-view-more"));
  fireEvent.press(screen.getByTestId("media-picker-tile-b"));

  expect(onPick.mock.calls).toEqual([[photo("a")], [photo("b")]]);
});

it("a pick from further down shows at the head of the strip, with its number", () => {
  mockState.pages = [[photo("a"), photo("b")], [photo("deep")]];
  mount({ selectedIds: ["b", "deep"], numbered: true });

  const tiles = screen
    .getAllByText(/^[a-z]+:(-|\d+)$/)
    .map((n) => n.props.children);
  expect(tiles).toEqual(["deep:2", "a:-", "b:1"]);
});

it("typing sends nothing — a search is sent once, when she submits", () => {
  mockState.search = { items: [photo("b")] };
  mount();
  fireEvent.press(screen.getByTestId("media-picker-view-more"));
  const box = screen.getByTestId("media-picker-search");

  for (const draft of ["r", "re", "red", "red d", "red dress"])
    fireEvent.changeText(box, draft);
  expect(mockState.searchCalls.filter((c) => c.enabled)).toEqual([]);

  fireEvent(box, "submitEditing");

  const sent = new Set(
    mockState.searchCalls.filter((c) => c.enabled).map((c) => c.q),
  );
  expect([...sent]).toEqual(["red dress"]);
  expect(screen.getByTestId("media-picker-tile-b")).toBeTruthy();
  expect(screen.queryByTestId("media-picker-tile-a")).toBeNull();
});

it("a search the server could not run says so, in its words", () => {
  mockState.search = { unavailable: "Search isn't available right now." };
  mount();
  fireEvent.press(screen.getByTestId("media-picker-view-more"));
  fireEvent.changeText(screen.getByTestId("media-picker-search"), "goal");
  fireEvent(screen.getByTestId("media-picker-search"), "submitEditing");

  expect(screen.getByText("Search isn't available right now.")).toBeTruthy();
});

it("scrolling to the end of the library asks for the next page", () => {
  mockState.hasNextPage = true;
  mount();
  fireEvent.press(screen.getByTestId("media-picker-view-more"));

  fireEvent(screen.getByTestId("media-picker-grid"), "endReached");

  expect(mockState.fetchNextPage).toHaveBeenCalledTimes(1);
});

it("offers only the chips its mount allows, and a chip narrows the list", () => {
  mount();
  fireEvent.press(screen.getByTestId("media-picker-view-more"));
  expect(screen.getByTestId("media-picker-chip-upload")).toBeTruthy();
  expect(screen.getByTestId("media-picker-chip-generated")).toBeTruthy();
  expect(screen.queryByTestId("media-picker-chip-synced")).toBeNull();

  fireEvent.press(screen.getByTestId("media-picker-chip-generated"));

  expect(mockState.listCalls.at(-1)?.origins).toEqual(["generated"]);
});

it("the rights check comes up once, and the upload is retried with ackRights", async () => {
  const asset = { uri: "file://p.jpg", mimeType: "image/jpeg" };
  mockState.pick.mockResolvedValue({ assets: [asset] });
  mockState.mutateAsync
    .mockRejectedValueOnce(new RightsAckRequired())
    .mockResolvedValueOnce({ asset_id: "new" });
  mockState.fetchRows.mockResolvedValue([photo("new")]);
  mount();
  fireEvent.press(screen.getByTestId("media-picker-view-more"));

  await act(async () => {
    fireEvent.press(screen.getByTestId("media-picker-upload"));
  });
  fireEvent.press(screen.getByLabelText("I have the rights to this media"));
  await act(async () => {
    fireEvent.press(screen.getByText("I confirm"));
  });

  expect(mockState.mutateAsync.mock.calls).toEqual([
    [{ asset, ackRights: undefined }],
    [{ asset, ackRights: true }],
  ]);
  expect(onPick).toHaveBeenCalledWith(photo("new"));
});

it("a new upload is selectable at once — the lists are refreshed, then the server's row is picked", async () => {
  mockState.pick.mockResolvedValue({ assets: [{ uri: "file://p.jpg" }] });
  mockState.mutateAsync.mockResolvedValue({ asset_id: "new" });
  mockState.fetchRows.mockResolvedValue([photo("new"), photo("a")]);
  mount();
  fireEvent.press(screen.getByTestId("media-picker-view-more"));

  await act(async () => {
    fireEvent.press(screen.getByTestId("media-picker-upload"));
  });

  expect(qc.invalidateQueries).toHaveBeenCalledWith({
    queryKey: ["studio", "media"],
  });
  expect(qc.invalidateQueries).toHaveBeenCalledWith({
    queryKey: ["studio", "stitch"],
  });
  expect(onPick).toHaveBeenCalledWith(photo("new"));
});

// quality-scrappy (Investigation 12): the first page is RANKED and a fresh upload is unread, so it ranks last — asked
// "is it on page 1?", every in-picker upload was refused "it can't be used here". It is asked for by id instead.
it("an upload is asked for BY ID — a first page it would never make does not refuse it", async () => {
  mockState.pick.mockResolvedValue({ assets: [{ uri: "file://p.jpg" }] });
  mockState.mutateAsync.mockResolvedValue({ asset_id: "new" });
  mockState.fetchPage.mockResolvedValue({
    items: [photo("a"), photo("b")],
    nextCursor: "more",
  });
  mockState.fetchRows.mockResolvedValue([photo("new")]);
  mount();
  fireEvent.press(screen.getByTestId("media-picker-view-more"));

  await act(async () => {
    fireEvent.press(screen.getByTestId("media-picker-upload"));
  });

  expect(mockState.fetchRows).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "photos" }),
    ["new"],
  );
  expect(onPick).toHaveBeenCalledWith(photo("new"));
  expect(
    screen.queryByText("It's in your library, but it can't be used here."),
  ).toBeNull();
});

it("an upload the Video tab cannot hold is refused in words, never picked", async () => {
  mockState.pick.mockResolvedValue({
    assets: [{ uri: "file://p.heic", mimeType: "image/heic" }],
  });
  mockState.mutateAsync.mockResolvedValue({ asset_id: "heic" });
  mockState.fetchRows.mockResolvedValue([photo("a")]);
  mount({ forStill: true, context: "video-still" });
  fireEvent.press(screen.getByTestId("media-picker-view-more"));

  await act(async () => {
    fireEvent.press(screen.getByTestId("media-picker-upload"));
  });

  expect(onPick).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      "It's in your library, but it's in a format we can't put in a video yet (HEIC) — save it as a JPEG and add it again.",
    ),
  ).toBeTruthy();
});

/**
 * PR 12 — the label is drawn by the picker, under the mount's own tile and in its own cell: one place,
 * every mount. ⚠️ MUTATION "the picker labels an untagged row with a subject" (component half): draw
 * `row.subject` regardless of `tagged` — the unread tile reds.
 */
it("labels each tile with who and the shot, says 'Not read yet' before the tagger has seen it, and 'not usable' on a reject — on the strip and in the library", () => {
  const tagged = (id: string, over: Record<string, unknown>) =>
    ({ ...photo(id), ...over }) as PickerRow;
  mockState.pages = [
    [
      tagged("a", {
        tagged: true,
        subject: "the_athlete",
        shot: "portrait",
        reject: false,
      }),
      tagged("b", { tagged: false, subject: null, shot: null, reject: false }),
      tagged("c", {
        tagged: true,
        subject: "nobody",
        shot: "lifestyle",
        reject: true,
      }),
      photo("d"), // an older server's row: nothing to say
    ],
  ];
  mount();
  expect(screen.getByTestId("media-picker-label-a")).toHaveTextContent(
    "You · portrait",
  );
  expect(screen.getByTestId("media-picker-label-b")).toHaveTextContent(
    "Not read yet",
  );
  expect(screen.getByTestId("media-picker-label-c")).toHaveTextContent(
    "No one · lifestyle · not usable",
  );
  expect(screen.queryByTestId("media-picker-label-d")).toBeNull();
  // The mount's own tile is untouched around it.
  expect(screen.getByTestId("tile-a")).toBeTruthy();

  fireEvent.press(screen.getByTestId("media-picker-view-more"));
  expect(screen.getAllByTestId("media-picker-label-a")).toHaveLength(2);
  expect(screen.getAllByTestId("media-picker-label-b")[1]).toHaveTextContent(
    "Not read yet",
  );
});
