/**
 * measureDuration — how long a video actually is, asked of whatever can answer here.
 *
 * ─── WHY THIS IS NOT JUST `createVideoPlayer(...).duration` ─────────────────────────────────────
 *
 * ⚠️  ON WEB, `expo-video`'s `VideoPlayer` MEASURES NOTHING ON ITS OWN. It is a controller over a
 * SET OF MOUNTED `<video>` ELEMENTS, not an owner of the asset:
 *
 *   get duration()  →  [...this._mountedVideos][0]?.duration ?? 0      // 0 when none is mounted
 *   status = 'readyToPlay'  is set only inside `video.oncanplay`, and that handler is attached by
 *   `_addListeners(video)`, which runs only from `mountVideoView(video)` — i.e. only when a
 *   `VideoView` actually renders that player.
 *
 * So a player created to be measured and never rendered reports 0 forever and never fires a status
 * event. The native players DO own their asset, which is exactly how this was got wrong: a
 * generalisation from the platform where it happens to work.
 *
 * ─── THE DISCRIMINATOR IS A DOM, NOT A PLATFORM NAME ────────────────────────────────────────────
 *
 * Keying on `Platform.OS === "web"` would be a guess about which runtime has a `document`. Asking
 * for the document is the actual condition, and unlike the platform name it is something a test can
 * drive from both sides.
 */
import { createVideoPlayer, type VideoPlayer } from "expo-video";

/** One measurement in flight. `cancel` settles it as unknown and detaches everything. */
export interface DurationProbe {
  promise: Promise<number | null>;
  cancel: () => void;
}

/**
 * ⚠️  A READING THAT IS NOT FINITE AND POSITIVE IS NOT A DURATION.
 *
 * `HTMLMediaElement.duration` is `NaN` before metadata arrives and `Infinity` for a live stream;
 * `expo-video` reports 0 before `readyToPlay`. All three mean "we have not learned anything", and
 * caching any of them would draw that clip at zero width forever — invisible, and so impossible to
 * select in order to fix.
 */
const asDuration = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

const hasDom = (): boolean =>
  typeof document !== "undefined" &&
  typeof document.createElement === "function";

/** Measure through a bare media element — the web path. */
function measureInDom(uri: string): DurationProbe {
  const el = document.createElement("video");
  let settle: (seconds: number | null) => void = () => {};
  const promise = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  let settled = false;

  const finish = (seconds: number | null) => {
    if (settled) return;
    settled = true;
    el.onloadedmetadata = null;
    el.onerror = null;
    // Let go of the bytes. Removing the src and reloading is what tells the browser to stop.
    try {
      el.removeAttribute("src");
      el.load();
    } catch {
      // A element that will not reset is not worth a crash — it is garbage either way.
    }
    settle(seconds);
  };

  /*
   * METADATA ONLY. A duration is in the container header; pulling the whole file to learn it would
   * make drawing a twelve-clip track cost twelve downloads. Muted and never attached to the
   * document, so it cannot play, be seen, or make a sound.
   */
  el.preload = "metadata";
  el.muted = true;
  el.onloadedmetadata = () => finish(asDuration(el.duration));
  el.onerror = () => finish(null);
  el.src = uri;

  return { promise, cancel: () => finish(null) };
}

/** Measure through the native player, which does own its asset. */
function measureInPlayer(uri: string): DurationProbe {
  let player: VideoPlayer;
  try {
    player = createVideoPlayer({ uri });
  } catch {
    // A url we cannot even open is not worth retrying.
    return { promise: Promise.resolve(null), cancel: () => {} };
  }

  let settle: (seconds: number | null) => void = () => {};
  const promise = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  let settled = false;

  const finish = (seconds: number | null) => {
    if (settled) return;
    settled = true;
    sub?.remove();
    player.release();
    settle(seconds);
  };

  player.muted = true;
  const sub = player.addListener("statusChange", ({ status }) => {
    if (status === "readyToPlay") finish(asDuration(player.duration));
    else if (status === "error") finish(null);
  });
  // Insurance against a player that was ready before we subscribed: `statusChange` would then
  // never fire and this probe would hang.
  if (player.status === "readyToPlay") finish(asDuration(player.duration));

  return { promise, cancel: () => finish(null) };
}

export function measureDuration(uri: string): DurationProbe {
  return hasDom() ? measureInDom(uri) : measureInPlayer(uri);
}
