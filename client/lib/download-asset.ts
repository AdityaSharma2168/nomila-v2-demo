/**
 * download-asset — get a copy of a generated asset onto the athlete's own device.
 *
 * ─── WHY THIS IS NOT ONE LINE ──────────────────────────────────────────────────────────────────
 * The obvious version — `<a href={url} download>` on web, some save call on native — does not work
 * for these assets, for two different reasons.
 *
 * WEB. The url is a SIGNED GCS url on storage.googleapis.com, a different origin. The `download`
 * attribute is ignored cross-origin: the browser navigates to the image instead of saving it, which
 * is the browser tab we are trying to get rid of. So the bytes have to come through `fetch` and go
 * out again as a blob. That needs the bucket to answer with CORS headers, which we cannot verify
 * from here and must not assume — so a failed fetch falls back to opening the url, which is exactly
 * what she can do today and no worse.
 *
 * NATIVE. Saving straight to the camera roll means expo-media-library, which on iOS needs
 * NSPhotoLibraryAddUsageDescription in app.json — a NATIVE config change that does nothing until
 * the app is rebuilt, so the button would silently fail in the dev client. `expo-sharing` needs no
 * permission and no rebuild, and the iOS share sheet's own "Save Image" puts it in the camera roll.
 * One tap more, and it works the moment it ships. Both modules are already dependencies.
 * SEVERAL files at once are the exception (saveRemoteAssetsToLibrary): a sheet takes one file, so a
 * set goes into the photo library in one go, under the full-library permission the app already
 * declares (NSPhotoLibraryUsageDescription) — no new native config.
 *
 * ─── THE URL IS A CREDENTIAL ───────────────────────────────────────────────────────────────────
 * A signed url's query string IS the read credential. It is never logged, never put in a filename,
 * and never handed anywhere but the fetch/download that consumes it.
 */
import { Platform } from "react-native";
// SDK 54 moved the classic FileSystem API (downloadAsync) to the `legacy` entry — same import the
// media library's upload path uses.
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library/legacy";
import * as Sharing from "expo-sharing";

/**
 * What actually happened, so the caller can say something true.
 * `saved` — bytes are on disk. `shared` — handed to the OS share sheet, she chose from there.
 * `opened` — we could not read the bytes and fell back to opening the url in a tab.
 */
export type SaveOutcome = "saved" | "shared" | "opened";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime",
};
const EXT_UTI: Record<string, string> = {
  jpg: "public.jpeg", jpeg: "public.jpeg", png: "public.png", webp: "org.webmproject.webp",
  gif: "com.compuserve.gif", mp4: "public.mpeg-4", mov: "com.apple.quicktime-movie",
};

/**
 * The extension off the url's PATH, never its query string — a signed url ends in
 * `?GoogleAccessId=…&Expires=…&Signature=…`, and naive `lastIndexOf(".")` would pull a fragment of
 * the signature out and call it a file type. Anything that does not look like an extension is jpg.
 */
function extensionOf(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const dot = path.lastIndexOf(".");
  const ext = dot > -1 ? path.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9]{2,4}$/.test(ext) ? ext : "jpg";
}

/**
 * What the file is called on her device. The asset id is a uuid, so it is safe in a filename and
 * carries nothing about her — no brand name, no caption, nothing off the signed url.
 */
export function fileNameFor(url: string, assetId: string | null): string {
  const stem = (assetId ?? String(Date.now())).replace(/[^a-zA-Z0-9_-]/g, "");
  return `nomila-${stem || Date.now()}.${extensionOf(url)}`;
}

/** Web: pull the bytes, hand them to the browser as a blob so the `download` name is honoured. */
async function saveOnWeb(url: string, filename: string): Promise<SaveOutcome> {
  let href: string | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking synchronously cancels the download in Safari. A minute is long past any save.
    const doomed = href;
    setTimeout(() => URL.revokeObjectURL(doomed), 60_000);
    return "saved";
  } catch {
    if (href) URL.revokeObjectURL(href);
    // The bucket would not let us read it cross-origin. Opening the url is what she can already do
    // by hand, so this is a floor, not a failure — and the caller says so in words.
    //
    // NOT "noopener" in the features: with it, window.open returns null whether or not the tab
    // opened, and a blocked pop-up would be reported as "opened". Without it the return value tells
    // the two apart, and the opener link is cut by hand (what noopener would have done).
    const tab = window.open(url, "_blank");
    if (!tab) throw new PopupBlockedError();
    tab.opener = null;
    return "opened";
  }
}

/** The web fallback's new tab was blocked: nothing was saved and nothing opened. Its message is written for her. */
export class PopupBlockedError extends Error {
  constructor() {
    super("Your browser blocked the new tab. Allow pop-ups for this site, then try again.");
    this.name = "PopupBlockedError";
  }
}

/** Native: bytes into the app's cache, then the OS share sheet (whose "Save Image" is the goal). */
async function saveOnNative(url: string, filename: string): Promise<SaveOutcome> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error("There is nowhere to put it on this device.");

  const { status, uri: localUri } = await FileSystem.downloadAsync(url, dir + filename);
  // A signed url that has expired answers 403 with an XML body, which would otherwise land on disk
  // as a "photo" that will not open.
  if (status !== 200) throw new Error("Couldn't fetch it — the link may have expired. Close this and open it again.");

  if (!(await Sharing.isAvailableAsync())) throw new Error("Saving isn't available on this device.");

  const ext = extensionOf(url);
  await Sharing.shareAsync(localUri, {
    mimeType: EXT_MIME[ext] ?? "image/jpeg",
    UTI: EXT_UTI[ext] ?? "public.jpeg",
    dialogTitle: "Save this",
  });
  return "shared";
}

/**
 * Put a copy of `url` on her device. Throws with a sentence written for a person — every caller
 * renders the message straight through, so nothing here may say "403" or name the url.
 */
export async function saveRemoteAsset(url: string, filename: string): Promise<SaveOutcome> {
  return Platform.OS === "web" ? saveOnWeb(url, filename) : saveOnNative(url, filename);
}

/**
 * NATIVE, SEVERAL FILES (a carousel's slides): every one into the photo library in one go — one permission ask, no
 * share sheet per file. expo-sharing takes ONE file per sheet, so a sheet per slide would be N sheets in a row; the
 * media library is the one call that takes them all. The permission is the full library one the app already declares
 * (app.json NSPhotoLibraryUsageDescription; the camera-roll review asks for the same), so nothing new ships natively.
 *
 * Answers how many were saved, in order, and stops at the first that fails: `stop` says why ("permission" — she said
 * no; "failed" — a download or a save did not go through), so the caller can say "saved 2 of 3" truthfully.
 */
export async function saveRemoteAssetsToLibrary(
  files: readonly { url: string; filename: string }[],
): Promise<{ saved: number; stop: "permission" | "failed" | null }> {
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (!perm.granted) return { saved: 0, stop: "permission" };
  const dir = FileSystem.cacheDirectory;
  if (!dir) return { saved: 0, stop: "failed" };
  let saved = 0;
  for (const f of files) {
    try {
      const { status, uri } = await FileSystem.downloadAsync(f.url, dir + f.filename);
      if (status !== 200) return { saved, stop: "failed" };
      await MediaLibrary.saveToLibraryAsync(uri);
      saved++;
    } catch {
      return { saved, stop: "failed" };
    }
  }
  return { saved, stop: null };
}
