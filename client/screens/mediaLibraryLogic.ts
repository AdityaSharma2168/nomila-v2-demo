/**
 * mediaLibraryLogic — the shared Media library's PR 12 rules, as pure functions (lane 3).
 *
 * ONE label function for both screens: the Studio picker's `tileLabel` (screens/studio/
 * mediaPickerLogic.ts) is imported here and fed a MediaItem folded into the picker's own row shape,
 * so the words on a library tile and on a picker tile can never drift apart.
 *
 * ⚠️ MUTATION (mediaLibraryLogic.test "MediaLibrary tile shows You for a subject=another_person
 * row"): map `subject` to "the_athlete" regardless — reds by name.
 */
import type { MediaItem } from "../hooks/use-media-library";
import { tileLabel, type TileFacts } from "./studio/mediaPickerLogic";

/**
 * A library item's four facts as the picker's label function reads them. A VIDEO is labelled off its
 * poster tag exactly like a photo (Adi's ruling, 24 Sep 2026). ⚠️ MUTATION (mediaLibraryLogic.test
 * "a video row with subject=another_person shows You"): return `the_athlete` for a video — reds.
 */
export function tileFactsOf(item: MediaItem): TileFacts {
  // `tagged` absent = a server that sent no PR 12 fields (its flag off, or older): nothing to say,
  // even though today's `shot_type` is on the row — a label is the tagger's whole answer or none.
  if (item.tagged === undefined)
    return { tagged: true, subject: null, shot: null, reject: false };
  return {
    tagged: item.tagged,
    subject: item.subject ?? null,
    shot: item.shot_type ?? null,
    reject: item.reject === true,
    madeHereNotHer: item.madeHereNotHer === true,
  };
}

/** What the library tile says under its picture, or null for nothing. */
export function libraryTileLabel(
  item: MediaItem,
  enabled: boolean,
): string | null {
  return tileLabel(tileFactsOf(item), enabled);
}
