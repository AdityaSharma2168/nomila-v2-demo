/**
 * measureDuration — both runtimes, because the one that was broken is the one that is hardest to
 * reach from here.
 *
 * ⚠️ THE BUG THIS FILE EXISTS FOR. `createVideoPlayer(...).duration` measures NOTHING on web:
 * `expo-video`'s web player reads its duration off a mounted `<video>` element and sets
 * `readyToPlay` only from that element's `oncanplay`, so a player created to be measured and never
 * rendered reports 0 forever and never fires a status event. The track drew every clip at the
 * placeholder width because of it.
 *
 * The discriminator under test is "is there a DOM", not a platform name — which is why both halves
 * are reachable here by giving the module a document, or taking it away.
 */
import { measureDuration } from "./measureDuration";

// ─── The native player, faked ───────────────────────────────────────────────────────────────────

type Listener = (p: { status: string }) => void;

class FakePlayer {
  muted = false;
  status = "loading";
  duration = 0;
  released = 0;
  subsRemoved = 0;
  listeners: Listener[] = [];
  addListener(_n: string, fn: Listener) {
    this.listeners.push(fn);
    return {
      remove: () => {
        this.subsRemoved += 1;
      },
    };
  }
  release() {
    this.released += 1;
  }
  emit(status: string) {
    for (const fn of [...this.listeners]) fn({ status });
  }
}

let player: FakePlayer;
let createThrows = false;
jest.mock("expo-video", () => ({
  createVideoPlayer: () => {
    if (createThrows) throw new Error("cannot open");
    return player;
  },
}));

// ─── The DOM, faked ─────────────────────────────────────────────────────────────────────────────

class FakeVideoEl {
  preload = "";
  muted = false;
  duration: number = NaN;
  src = "";
  removed = 0;
  loads = 0;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute(_n: string) {
    this.removed += 1;
  }
  load() {
    this.loads += 1;
  }
}

let el: FakeVideoEl;
function withDom<T>(run: () => T): T {
  el = new FakeVideoEl();
  (globalThis as { document?: unknown }).document = {
    createElement: () => el,
  };
  try {
    return run();
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
}

beforeEach(() => {
  player = new FakePlayer();
  createThrows = false;
  delete (globalThis as { document?: unknown }).document;
});

describe("measuring where there IS a dom — the path that was broken", () => {
  it("reads the duration off the element's metadata", async () => {
    const probe = withDom(() => measureDuration("https://example.test/a.mp4"));
    el.duration = 7.4;
    el.onloadedmetadata!();
    await expect(probe.promise).resolves.toBe(7.4);
  });

  it("asks for METADATA ONLY, and never plays or shows the element", () => {
    withDom(() => measureDuration("https://example.test/a.mp4"));
    // A duration lives in the container header. Pulling whole files to draw a twelve-clip track
    // would cost twelve downloads.
    expect(el.preload).toBe("metadata");
    expect(el.muted).toBe(true);
    expect(el.src).toBe("https://example.test/a.mp4");
  });

  it("lets go of the bytes once it has an answer", async () => {
    const probe = withDom(() => measureDuration("https://example.test/a.mp4"));
    el.duration = 3;
    el.onloadedmetadata!();
    await probe.promise;
    expect(el.removed).toBe(1);
    expect(el.loads).toBe(1);
    expect(el.onloadedmetadata).toBeNull();
    expect(el.onerror).toBeNull();
  });

  it("⚠️ refuses NaN, zero and Infinity — none of those is a duration", async () => {
    // duration is NaN before metadata and Infinity for a live stream. Caching any of them draws
    // that clip at zero width forever: invisible, and so impossible to select in order to fix.
    for (const bad of [NaN, 0, Infinity, -2]) {
      const probe = withDom(() =>
        measureDuration("https://example.test/a.mp4"),
      );
      el.duration = bad;
      el.onloadedmetadata!();
      await expect(probe.promise).resolves.toBeNull();
    }
  });

  it("answers unknown for a file it cannot open", async () => {
    const probe = withDom(() => measureDuration("https://example.test/a.mp4"));
    el.onerror!();
    await expect(probe.promise).resolves.toBeNull();
  });

  it("settles once, whatever arrives afterwards", async () => {
    const probe = withDom(() => measureDuration("https://example.test/a.mp4"));
    el.duration = 5;
    el.onloadedmetadata!();
    probe.cancel();
    await expect(probe.promise).resolves.toBe(5);
  });

  it("a cancel resolves unknown and lets the bytes go", async () => {
    const probe = withDom(() => measureDuration("https://example.test/a.mp4"));
    probe.cancel();
    await expect(probe.promise).resolves.toBeNull();
    expect(el.removed).toBe(1);
  });

  it("does NOT reach for the player when a dom is present", () => {
    withDom(() => measureDuration("https://example.test/a.mp4"));
    // The whole bug: the player cannot answer here, so nothing may depend on it.
    expect(player.listeners).toHaveLength(0);
  });
});

describe("measuring where there is NO dom — the native path", () => {
  it("reads the duration once the player says it is ready", async () => {
    const probe = measureDuration("https://example.test/a.mp4");
    player.duration = 12.5;
    player.status = "readyToPlay";
    player.emit("readyToPlay");
    await expect(probe.promise).resolves.toBe(12.5);
  });

  it("releases the player and its subscription", async () => {
    const probe = measureDuration("https://example.test/a.mp4");
    player.duration = 4;
    player.emit("readyToPlay");
    await probe.promise;
    expect(player.released).toBe(1);
    expect(player.subsRemoved).toBe(1);
  });

  it("takes the answer straight away if the player was already ready", async () => {
    player.status = "readyToPlay";
    player.duration = 9;
    const probe = measureDuration("https://example.test/a.mp4");
    await expect(probe.promise).resolves.toBe(9);
  });

  it("answers unknown on an error, and never makes noise while it measures", async () => {
    const probe = measureDuration("https://example.test/a.mp4");
    expect(player.muted).toBe(true);
    player.emit("error");
    await expect(probe.promise).resolves.toBeNull();
  });

  it("survives a url the player will not even open", async () => {
    createThrows = true;
    await expect(
      measureDuration("https://example.test/a.mp4").promise,
    ).resolves.toBeNull();
  });
});
