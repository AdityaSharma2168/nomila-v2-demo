/**
 * sharePostKit — the ONE Share / Save flow, used by the post kit screen's "Share / Save" and the For you feed's
 * "Post": copy the kit's caption, then save its media to her device. Nothing is posted anywhere — she posts it herself,
 * then taps "I posted it".
 *
 * What is saved (preview.ts shareFilesOf): the rendered reel, or a carousel's every slide in render order (a slide whose
 * render has gone falls back to its own photo or clip), once the preview is ready; otherwise the first chosen photo or
 * clip as it is in her library. The caller passes a FRESH read (signed URLs expire within the hour), and the caption
 * copied is the SAVED one: a screen with an unsaved edit saves it first.
 *
 * How it lands:
 *   one file, native   the OS share sheet (its "Save" puts it in her photos) — download-asset.ts saveRemoteAsset
 *   one file, web      a download; when the bucket refuses a cross-origin read, a new tab to save from — and when the
 *                      browser blocks that tab, she is told so (never "opened")
 *   several, native    all into her photo library in one go (one permission ask, no sheet per slide)
 *   several, web       one download each, in order
 * When one in the middle fails, she is told how many were saved.
 *
 * Answers one plain-words line for the screen: `note` when it worked (what happened), `fail` when it did not. A raw
 * error message never reaches her.
 */
import { Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { fileNameFor, PopupBlockedError, saveRemoteAsset, saveRemoteAssetsToLibrary, type SaveOutcome } from "../../lib/download-asset";
import type { PostKitResponse } from "../../../shared/postKit";
import { shareFilesOf } from "./preview";

export const SHARE_COPY = {
  saved: "Saved to your downloads.",
  savedMany: (n: number) => `Saved ${n} files to your downloads.`,
  savedPhotos: (n: number) => `Saved ${n} files to your photos.`,
  opened: "Opened in a new tab — save it from there.",
  openedMany: "Opened in new tabs — save them from there.",
  copied: "Caption copied.",
  /** A kit with no caption yet (plan 1.7.0: an empty caption is never filled with the brief): nothing is copied. */
  noCaption: "No caption yet — ask Mila to write one.",
  noMedia: "There's no photo or clip to save for this one yet.",
  failed: "Couldn't save that. Check your connection and try again.",
  partial: (saved: number, of: number) => `Saved ${saved} of ${of}. Couldn't save the rest — check your connection and try again.`,
  blocked: "Your browser blocked the new tab. Allow pop-ups for this site, then try again.",
  partialBlocked: (saved: number, of: number) => `Saved ${saved} of ${of}. Your browser blocked the rest — allow pop-ups for this site, then try again.`,
  needPhotos: "Allow Nomila to add to your photos, then try again.",
} as const;

type ShareResult = { note: string } | { fail: string };

/** A failure after `saved` of `of`: how many landed, and why the rest did not — a blocked pop-up says so, either way. */
function failAfter(saved: number, of: number, err?: unknown): ShareResult {
  const blocked = err instanceof PopupBlockedError;
  if (saved > 0) return { fail: blocked ? SHARE_COPY.partialBlocked(saved, of) : SHARE_COPY.partial(saved, of) };
  return { fail: blocked ? SHARE_COPY.blocked : SHARE_COPY.failed };
}

/** Several files on the web: one download each, in order; a failure part-way says how many landed. */
async function saveEachOnWeb(files: readonly { uri: string; assetId: string }[]): Promise<ShareResult> {
  const outcomes: SaveOutcome[] = [];
  for (const f of files) {
    try {
      outcomes.push(await saveRemoteAsset(f.uri, fileNameFor(f.uri, f.assetId)));
    } catch (err) {
      return failAfter(outcomes.length, files.length, err);
    }
  }
  return { note: outcomes.every((o) => o === "saved") ? SHARE_COPY.savedMany(files.length) : SHARE_COPY.openedMany };
}

export async function sharePostKit(kit: PostKitResponse): Promise<ShareResult> {
  try {
    // An empty caption is never copied (it would clear the clipboard) and never reported as copied.
    if (kit.kit?.caption.text.trim()) await Clipboard.setStringAsync(kit.kit.caption.text);
  } catch {
    return { fail: SHARE_COPY.failed };
  }
  const copied = !kit.kit ? "" : kit.kit.caption.text.trim() ? ` ${SHARE_COPY.copied}` : ` ${SHARE_COPY.noCaption}`;
  const files = shareFilesOf(kit);
  if (!files.length) return { note: `${SHARE_COPY.noMedia}${copied}` };

  let r: ShareResult;
  if (files.length === 1) {
    const f = files[0];
    try {
      const outcome = await saveRemoteAsset(f.uri, fileNameFor(f.uri, f.assetId));
      r = { note: outcome === "saved" ? SHARE_COPY.saved : outcome === "opened" ? SHARE_COPY.opened : "" };
    } catch (err) {
      r = failAfter(0, 1, err);
    }
  } else if (Platform.OS === "web") {
    r = await saveEachOnWeb(files);
  } else {
    let out: Awaited<ReturnType<typeof saveRemoteAssetsToLibrary>>;
    try {
      out = await saveRemoteAssetsToLibrary(files.map((f) => ({ url: f.uri, filename: fileNameFor(f.uri, f.assetId) })));
    } catch {
      out = { saved: 0, stop: "failed" };
    }
    r = out.stop === "permission" ? { fail: SHARE_COPY.needPhotos } : out.stop ? failAfter(out.saved, files.length) : { note: SHARE_COPY.savedPhotos(out.saved) };
  }
  return "note" in r ? { note: `${r.note}${copied}`.trim() } : r;
}
