/**
 * mediaLibraryLogic.test — the shared library's tile label rides the picker's own function (PR 12, lane 3).
 *
 * ⚠️ MUTATION "MediaLibrary tile shows You for a subject=another_person row": in pickerRowOf, map
 * `subject` to "the_athlete" regardless — the second case reds by name.
 */
import type { MediaItem } from "../hooks/use-media-library";
import { libraryTileLabel, tileFactsOf } from "./mediaLibraryLogic";

const item = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: null,
  asset_id: "a-1",
  gcs_path: "p",
  platform: "upload",
  origin: "upload",
  media_type: "IMAGE",
  url: "u",
  thumb_url: "t",
  video_url: null,
  poster_gcs_path: null,
  duration_seconds: null,
  enriched: true,
  brand_safe: true,
  shot_type: "portrait",
  brands_visible: [],
  ...over,
});

it("her, someone else, no one — the picker's words, by the server's subject; a reject says so", () => {
  expect(
    libraryTileLabel(item({ tagged: true, subject: "the_athlete" }), true),
  ).toBe("You · portrait");
  expect(
    libraryTileLabel(item({ tagged: true, subject: "another_person" }), true),
  ).toBe("Someone else · portrait");
  expect(
    libraryTileLabel(
      item({ tagged: true, subject: "nobody", shot_type: "lifestyle" }),
      true,
    ),
  ).toBe("No one · lifestyle");
  expect(
    libraryTileLabel(
      item({ tagged: true, subject: "the_athlete", reject: true }),
      true,
    ),
  ).toBe("You · portrait · not usable");
});

it("not read yet before the tagger has seen it; nothing on an older server's row, or with the flag off", () => {
  expect(
    libraryTileLabel(
      item({ tagged: false, enriched: false, shot_type: null }),
      true,
    ),
  ).toBe("Not read yet");
  expect(libraryTileLabel(item({ shot_type: null }), true)).toBeNull(); // no PR 12 fields at all
  expect(
    libraryTileLabel(item({ tagged: true, subject: "the_athlete" }), false),
  ).toBeNull();
});

/** ⚠️ MUTATION "a video row with subject=another_person shows You": tileFactsOf maps a video's subject to the_athlete — reds. */
it("a video is labelled off its poster tag exactly like a photo — someone else stays someone else (ruling 24 Sep)", () => {
  expect(
    libraryTileLabel(
      item({
        media_type: "VIDEO",
        tagged: true,
        subject: "another_person",
        shot_type: "action",
      }),
      true,
    ),
  ).toBe("Someone else · action");
  expect(
    libraryTileLabel(
      item({ media_type: "REELS", tagged: true, subject: "the_athlete" }),
      true,
    ),
  ).toBe("You · portrait");
  expect(
    libraryTileLabel(
      item({ media_type: "VIDEO", tagged: false, enriched: false }),
      true,
    ),
  ).toBe("Not read yet");
  expect(
    tileFactsOf(
      item({
        media_type: "VIDEO",
        tagged: true,
        subject: "nobody",
        reject: true,
      }),
    ),
  ).toEqual({
    tagged: true,
    subject: "nobody",
    shot: "portrait",
    reject: true,
    madeHereNotHer: false,
  });
});

/** ⚠️ MUTATION "a made-here still with no person reference shows You" (library half): drop `madeHereNotHer` in tileFactsOf — reds. */
it("a made-here row without her says so on the library tile too — the same words as the picker (ruling 24 Sep)", () => {
  expect(
    libraryTileLabel(
      item({
        origin: "generated",
        tagged: true,
        subject: "the_athlete",
        madeHereNotHer: true,
      }),
      true,
    ),
  ).toBe("Made here · not from you");
  expect(
    libraryTileLabel(
      item({
        origin: "generated",
        tagged: true,
        subject: "the_athlete",
        madeHereNotHer: false,
      }),
      true,
    ),
  ).toBe("You · portrait");
  expect(
    tileFactsOf(item({ tagged: true, madeHereNotHer: true })),
  ).toMatchObject({ madeHereNotHer: true });
});
