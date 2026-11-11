/**
 * videoEntryLogic — THE ARITHMETIC. Pure, hermetic, $0, and deliberately NOT the wiring.
 *
 * The companion to client/hooks/use-studio-sessions.watch.test.tsx: that file mounts the real hook
 * and pins the loop around these functions; this one pins the functions. A build can pass either
 * alone and be broken, which is why both exist.
 */
import {
  pollOutcome,
  pollProgress,
  STALL_AFTER_MS,
  VIDEO_STALL_AFTER_MS,
  watchLimitMs,
  type JobRead,
} from "./threadLogic";
import {
  readyVideoEntry,
  videoEntry,
  videoEntryFromJob,
} from "./videoEntryLogic";

const row = (status: string, assets: JobRead["assets"] = []): JobRead => ({
  status,
  startedAt: null,
  assets,
});

const CLIP: JobRead["assets"][number] = {
  assetId: "a-1",
  mediaType: "VIDEO",
  url: "https://example.test/clip.mp4",
  approvalStatus: "draft",
};

describe("RC-Q-a — `queued` is progress, never a settlement", () => {
  it("pollOutcome keeps watching a queued job", () => {
    expect(pollOutcome(row("queued"), 0, 1_000, "video")).toBe("continue");
  });

  it("pollProgress tells queued apart from running — the transition the tab exists to watch", () => {
    expect(pollProgress(row("queued"))).toBe("queued");
    expect(pollProgress(row("running"))).toBe("running");
    // `pending` is the row's state before the request queues it. It has not been handed to a
    // runner, but it is in flight from her side, so it reads as running rather than inventing a
    // fourth word for a state she cannot act on.
    expect(pollProgress(row("pending"))).toBe("running");
  });

  it("a terminal status is not progress — that is pollOutcome's answer to give", () => {
    expect(pollProgress(row("succeeded"))).toBeNull();
    expect(pollProgress(row("failed"))).toBeNull();
    expect(pollProgress(row("canceled"))).toBeNull();
  });

  it("a read that FAILED is not progress — a tick that could not ask learned nothing", () => {
    expect(pollProgress("error")).toBeNull();
    expect(pollProgress("missing")).toBeNull();
  });
});

describe("RC-Q-b — every pre-video verdict is unchanged", () => {
  /**
   * `kind` defaults to `image`, so a caller that predates video (the thread) gets byte-identical
   * answers. If any row here moves, the thread's behaviour moved with it.
   */
  it.each([
    ["succeeded", "made"],
    ["failed", "failed"],
    ["canceled", "failed"],
    ["running", "continue"],
    ["pending", "continue"],
    ["queued", "continue"],
  ])("%s → %s, with no kind passed", (status, expected) => {
    expect(pollOutcome(row(status), 0, 1_000)).toBe(expected);
  });

  it("missing is stalled, and an unreadable job stays stalled", () => {
    expect(pollOutcome("missing", 0, 0)).toBe("stalled");
  });

  it("an image still stalls at exactly STALL_AFTER_MS", () => {
    expect(pollOutcome("error", 0, STALL_AFTER_MS - 1)).toBe("continue");
    expect(pollOutcome("error", 0, STALL_AFTER_MS)).toBe("stalled");
  });
});

describe("the watch clock is kind-derived, and finite for both", () => {
  it("an image keeps the clock it always had", () => {
    expect(watchLimitMs()).toBe(STALL_AFTER_MS);
    expect(watchLimitMs("image")).toBe(STALL_AFTER_MS);
  });

  it("a video gets a longer one, because the server's own budget is the image clock exactly", () => {
    // videoPoll().maxMs defaults to 600_000 — the same number as STALL_AFTER_MS. A clip needing a
    // second tick outlived the old clock while it was still running.
    expect(watchLimitMs("video")).toBe(VIDEO_STALL_AFTER_MS);
    expect(VIDEO_STALL_AFTER_MS).toBeGreaterThan(STALL_AFTER_MS);
  });

  it("finite — a watch that cannot end is the leak", () => {
    expect(Number.isFinite(watchLimitMs("video"))).toBe(true);
    expect(pollOutcome("error", 0, VIDEO_STALL_AFTER_MS, "video")).toBe(
      "stalled",
    );
  });

  it("a video is NOT stalled at an image's limit", () => {
    expect(pollOutcome(row("running"), 0, STALL_AFTER_MS + 1, "video")).toBe(
      "continue",
    );
    expect(pollOutcome(row("running"), 0, STALL_AFTER_MS + 1)).toBe("stalled");
  });
});

describe("the entry is a VIDEO, not a generation result", () => {
  /**
   * ⚠️ THE DECOUPLING, PINNED. Two product pipelines are coming — upload → stitch → music, and
   * generate-from-keyframes — and both produce entries that must render and play identically to a
   * generated one. If a future change makes the view model reachable only through a job, this is
   * what breaks.
   */
  it("a video that simply exists is an entry, with no job anywhere in sight", () => {
    const uploaded = readyVideoEntry([
      {
        assetId: "u-1",
        mediaType: "VIDEO",
        uri: "file:///her-clip.mp4",
        removed: false,
        editable: false,
        rejected: false,
      },
    ]);
    expect(uploaded.phase).toBe("ready");
    expect(uploaded.working).toBe(false);
    expect(uploaded.clips[0].uri).toBe("file:///her-clip.mp4");
  });

  it("an uploaded clip and a generated one are the SAME view — nothing distinguishes them", () => {
    const clip = {
      assetId: "x",
      mediaType: "VIDEO",
      uri: "https://example.test/clip.mp4",
      removed: false,
      editable: false,
      rejected: false,
    };
    const generated = videoEntryFromJob(row("succeeded", [CLIP]), "made");
    const uploaded = readyVideoEntry([{ ...clip, assetId: CLIP.assetId }]);
    expect(uploaded).toEqual(generated);
  });

  it("the core takes a phase and clips, and knows nothing about a route", () => {
    expect(videoEntry("queued").phase).toBe("queued");
    expect(videoEntry("working").working).toBe(true);
    // A phase that is still going shows no clips, whatever it is handed — an entry cannot be both
    // in flight and playable.
    expect(
      videoEntry("working", [
        {
          assetId: "a",
          mediaType: "VIDEO",
          uri: "u",
          removed: false,
          editable: false,
          rejected: false,
        },
      ]).clips,
    ).toEqual([]);
  });
});

describe("videoEntryFromJob — what a generation run shows", () => {
  it("queued and running are both still working, and are distinguishable", () => {
    const q = videoEntryFromJob(row("queued"), "continue");
    const r = videoEntryFromJob(row("running"), "continue");
    expect(q.phase).toBe("queued");
    expect(r.phase).toBe("working");
    expect(q.working).toBe(true);
    expect(r.working).toBe(true);
    expect(q.label).not.toBe(r.label);
  });

  it("the back-edge renders as still working — not as an ending of any kind", () => {
    const back = videoEntryFromJob(row("queued"), "continue");
    expect(back.working).toBe(true);
    expect(back.phase).toBe("queued");
    expect(back.clips).toEqual([]);
  });

  it("made carries the clips, from the mp4 url", () => {
    const v = videoEntryFromJob(row("succeeded", [CLIP]), "made");
    expect(v.phase).toBe("ready");
    expect(v.working).toBe(false);
    expect(v.clips).toHaveLength(1);
    expect(v.clips[0].uri).toBe("https://example.test/clip.mp4");
    expect(v.clips[0].mediaType).toBe("VIDEO");
    // A clip is not editable — edits are stills-only (threadLogic isEditable).
    expect(v.clips[0].editable).toBe(false);
  });

  it("a clip whose object is gone is a tombstone, never a broken player", () => {
    const v = videoEntryFromJob(
      row("succeeded", [{ ...CLIP, url: null }]),
      "made",
    );
    expect(v.clips[0].removed).toBe(true);
    expect(v.clips[0].uri).toBeNull();
  });

  it("failed and stalled end, and show no clips", () => {
    for (const outcome of ["failed", "stalled"] as const) {
      const v = videoEntryFromJob(row("failed"), outcome);
      expect(v.working).toBe(false);
      expect(v.clips).toEqual([]);
    }
  });

  it("a read that failed does not repaint the entry — it keeps running", () => {
    expect(videoEntryFromJob("error", "continue").phase).toBe("working");
  });
});
