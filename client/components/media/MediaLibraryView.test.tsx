/**
 * MediaLibraryView.test — the shared library's grid tile carries the PR 12 label (lane 3), and only that.
 *
 * ⚠️ MUTATION "MediaLibrary tile shows You for a subject=another_person row" (component half): draw
 * SUBJECT_WORDS.the_athlete for every tagged row — the second tile reds by name.
 */
import React from "react";
import { render, screen } from "@testing-library/react-native";
import type { MediaItem } from "../../hooks/use-media-library";

jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) => <Text>{`icon:${name}`}</Text>,
  };
});
jest.mock("expo-image-picker", () => ({}));
jest.mock("../../lib/flags", () => ({ STUDIO_LIBRARY_FIELDS: true }));
jest.mock("../../hooks/use-camera-roll-review", () => ({
  cameraRollReviewAvailable: () => false,
}));

let items: MediaItem[] = [];
jest.mock("../../hooks/use-media-library", () => ({
  useMyMedia: () => ({
    data: {
      pages: [
        {
          items,
          summary: {
            total: items.length,
            by_type: { photos: items.length, videos: 0 },
            by_platform: {},
            rights_ack: true,
          },
        },
      ],
    },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
  }),
  useUploadMediaBatch: () => ({ mutateAsync: jest.fn(), isPending: false }),
  pickFromCameraRoll: jest.fn(),
  RightsAckRequired: class extends Error {},
}));

import { MediaLibraryView } from "./MediaLibraryView";

const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id: null,
  asset_id: id,
  gcs_path: `p/${id}`,
  platform: "upload",
  origin: "upload",
  media_type: "IMAGE",
  url: `https://x/${id}.jpg`,
  thumb_url: `https://x/${id}-t.jpg`,
  video_url: null,
  poster_gcs_path: null,
  duration_seconds: null,
  enriched: true,
  brand_safe: true,
  shot_type: "portrait",
  brands_visible: [],
  ...over,
});

it("labels each photo tile with the picker's words — You, Someone else, Not read yet — and nothing on a row the server sent bare", () => {
  items = [
    item("a", { tagged: true, subject: "the_athlete" }),
    item("b", { tagged: true, subject: "another_person", shot_type: "action" }),
    item("c", { tagged: false, enriched: false, shot_type: null }),
    item("d"),
  ];
  render(<MediaLibraryView onOpenDetail={() => {}} />);
  expect(screen.getByTestId("media-tile-label-a")).toHaveTextContent(
    "You · portrait",
  );
  expect(screen.getByTestId("media-tile-label-b")).toHaveTextContent(
    "Someone else · action",
  );
  expect(screen.getByTestId("media-tile-label-c")).toHaveTextContent(
    "Not read yet",
  );
  expect(screen.queryByTestId("media-tile-label-d")).toBeNull();
});
