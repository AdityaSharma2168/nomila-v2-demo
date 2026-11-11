/**
 * ReferencePicker.test — the PR 12 lane 3 fields on GET /media rows change nothing here.
 *
 * ⚠️ MUTATION "ReferencePicker renders differently with the new fields present": read `subject` /
 * `tagged` in the library tile — the two trees stop matching and this reds by name.
 */
import React from "react";
import { render } from "@testing-library/react-native";
import type { MediaItem } from "../../hooks/use-media-library";

jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) => <Text>{`icon:${name}`}</Text>,
  };
});
jest.mock("expo-image-picker", () => ({}));

let items: MediaItem[] = [];
jest.mock("../../hooks/use-media-library", () => ({
  useMyMedia: () => ({ data: { pages: [{ items }] }, isLoading: false }),
  useUploadMediaBatch: () => ({ mutateAsync: jest.fn(), isPending: false }),
  pickFromCameraRoll: jest.fn(),
  RightsAckRequired: class extends Error {},
}));

import { ReferencePicker } from "./ReferencePicker";

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

it("renders the same tree with and without the PR 12 fields on its library rows", () => {
  items = [item("a"), item("b")];
  const before = render(
    <ReferencePicker references={[]} onChange={() => {}} />,
  ).toJSON();
  items = [
    item("a", {
      tagged: true,
      subject: "another_person",
      hero: 0.9,
      reject: false,
      face: "clear",
    }),
    item("b", {
      tagged: false,
      subject: null,
      hero: null,
      reject: true,
      face: null,
    }),
  ];
  const after = render(
    <ReferencePicker references={[]} onChange={() => {}} />,
  ).toJSON();
  // Function props (onClick…) are fresh per render, so the trees are compared as their serialised form.
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
});
