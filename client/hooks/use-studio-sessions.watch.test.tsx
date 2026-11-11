/**
 * useRunWatch — THE WIRING, pinned by mounting the real hook.
 *
 * ─── WHY THIS FILE IS `.tsx` AND WHY THAT IS NEW ────────────────────────────────────────────────
 *
 * Every client suite before video V4 was pure logic with no renderer (jest.config.cjs's `node`
 * project), which meant a hook could not be mounted at all. That is precisely where the leak this
 * file exists to pin LIVED: not in the arithmetic `tick` calls — `pollOutcome` was always correct —
 * but in the loop around it, which had no memory of what it had already settled. A pure test of
 * `pollOutcome` is green on a build that notifies its caller every three seconds forever.
 *
 * So the renderer earns its place here by testing the wiring, and nowhere else. The arithmetic
 * stays pinned by pure `.test.ts` beside it (threadLogic.test.ts, videoEntryLogic.test.ts).
 *
 * ─── WHAT IS STUBBED, AND WHAT IS NOT ───────────────────────────────────────────────────────────
 *
 * The hook is real. The timers are Jest's, the focus is true, and `fetch` answers with stubbed job
 * rows in the statuses migrations/0056 defines. Nothing here reaches a server, a database or a
 * provider — video is dark (`STUDIO_VIDEO_ENABLED` off) and $0 is the point.
 */
import { renderHook, act } from "@testing-library/react-native";
import { POLL_EVERY_MS, type JobRead } from "../screens/studio/threadLogic";

jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
jest.mock("../lib/query-client", () => ({
  getApiUrl: () => "https://example.test",
  getAuthHeaders: async () => ({}),
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

import { useRunWatch, type Watch } from "./use-studio-sessions";

const JOB = "11111111-2222-4333-8444-555555555555";

const row = (status: string, assets: JobRead["assets"] = []): JobRead => ({
  status,
  startedAt: null,
  assets,
});

/** The job route's answers, one per read, in order. The last one repeats forever. */
function serveStatuses(statuses: string[], assets: JobRead["assets"] = []) {
  let i = 0;
  const reads: string[] = [];
  global.fetch = jest.fn(async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    reads.push(status);
    return {
      ok: true,
      status: 200,
      json: async () => row(status, status === "succeeded" ? assets : []),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { reads };
}

/** One tick of the hook's interval, with its awaits flushed. */
async function tick() {
  await act(async () => {
    jest.advanceTimersByTime(POLL_EVERY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The mount's first tick, which runs immediately rather than on the interval. */
async function mounted(
  watches: Watch[],
  onSettle: jest.Mock,
  onProgress?: jest.Mock,
) {
  const out = renderHook(
    ({ w }: { w: Watch[] }) => useRunWatch(w, onSettle, onProgress),
    { initialProps: { w: watches } },
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return out;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("RC-REAP-a — a watch whose caller never removes it must self-terminate", () => {
  /**
   * THE LEAK, STATED AS A TEST.
   *
   * `watches` is a constant array: this caller never removes the watch, the way the provisional
   * Video tab does not and the way any caller that keeps its own list does not. The job is
   * terminal from the very first read, so every single tick has a non-`continue` outcome.
   *
   * Before the fix `onSettle` fired on every one of them — 1 settle per 3 s, for the life of the
   * mount. It must fire exactly once.
   */
  it("settles exactly once across many ticks, and stops reading the job", async () => {
    const { reads } = serveStatuses(["succeeded"]);
    const onSettle = jest.fn();
    const watches: Watch[] = [{ key: "card-1", jobId: JOB, kind: "video" }];

    await mounted(watches, onSettle);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith(
      "card-1",
      "made",
      expect.objectContaining({ status: "succeeded" }),
    );

    const readsAtSettle = reads.length;
    for (let i = 0; i < 10; i++) await tick();

    // Once, not eleven times.
    expect(onSettle).toHaveBeenCalledTimes(1);
    // And a settled watch costs nothing: no further request was made for it either.
    expect(reads.length).toBe(readsAtSettle);
  });

  it("settles once for a failure too, not once per tick", async () => {
    serveStatuses(["running", "failed"]);
    const onSettle = jest.fn();
    const watches: Watch[] = [{ key: "card-1", jobId: JOB, kind: "video" }];

    await mounted(watches, onSettle);
    for (let i = 0; i < 6; i++) await tick();

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle.mock.calls[0][1]).toBe("failed");
  });
});

describe("RC-REAP-b — a settled key is pruned, so the same card can be watched again", () => {
  /**
   * The settled set must not outlive the watch that filled it. If it did, a card re-checked later
   * under the same key would be silently never watched — a leak of the opposite sign, and a
   * harder one to see.
   */
  it("watches again after the key leaves and comes back", async () => {
    serveStatuses(["succeeded"]);
    const onSettle = jest.fn();
    const watch: Watch[] = [{ key: "card-1", jobId: JOB, kind: "video" }];

    const { rerender } = await mounted(watch, onSettle);
    expect(onSettle).toHaveBeenCalledTimes(1);

    // The caller drops it — the ordinary case — and then re-checks the same card.
    await act(async () => {
      rerender({ w: [] });
      await Promise.resolve();
    });
    await act(async () => {
      rerender({ w: watch });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSettle).toHaveBeenCalledTimes(2);
  });
});

describe("RC-BACK-a — running → queued is PROGRESS, never an ending", () => {
  /**
   * The back-edge is the server's reaper returning a lapsed job to `queued` while KEEPING
   * `provider_operation_name`, so the next runner resumes polling an operation already paid for
   * (server/studio/videoJobs.ts, reapExpiredLeases step 3). The clip is still being made.
   *
   * Three things must all hold, and a build that breaks any one of them has the leak:
   *   · the watch stays live across the back-edge  (a watch that terminates on it is the leak)
   *   · it settles exactly once, and on `made`     (a false stall is the leak wearing a hat)
   *   · the back-edge is reported as progress      (it is the transition the tab exists to watch)
   */
  it("stays live, reports queued as progress, and settles once on made", async () => {
    serveStatuses(
      ["running", "queued", "running", "succeeded"],
      [
        {
          assetId: "a-1",
          mediaType: "VIDEO",
          url: "https://example.test/clip.mp4",
          approvalStatus: "draft",
        },
      ],
    );
    const onSettle = jest.fn();
    const onProgress = jest.fn();
    const watches: Watch[] = [{ key: "card-1", jobId: JOB, kind: "video" }];

    await mounted(watches, onSettle, onProgress); // read 1 — running
    await tick(); // read 2 — queued   ← the back-edge
    expect(onSettle).not.toHaveBeenCalled(); // it did NOT end here

    await tick(); // read 3 — running again
    expect(onSettle).not.toHaveBeenCalled();

    await tick(); // read 4 — succeeded
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle.mock.calls[0][1]).toBe("made");

    const phases = onProgress.mock.calls.map((c) => c[1]);
    expect(phases).toEqual(["running", "queued", "running"]);

    // Further ticks add nothing — the settle-once rule holds through a back-edge too.
    for (let i = 0; i < 4; i++) await tick();
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("does not restart the clock on the back-edge", async () => {
    // A 10-minute-old video watch is NOT stalled (its limit is 30), and a back-edge must not
    // reset the clock it is measured against either. Both halves are one assertion here: the
    // watch is still running after a back-edge well past an image's limit.
    serveStatuses(["running", "queued"]);
    const onSettle = jest.fn();
    await mounted([{ key: "card-1", jobId: JOB, kind: "video" }], onSettle);

    await act(async () => {
      jest.advanceTimersByTime(11 * 60_000);
      await Promise.resolve();
    });
    await tick();
    expect(onSettle).not.toHaveBeenCalled();
  });
});

describe("the thread's caller is unchanged — no progress callback, image clock", () => {
  it("an image watch with no onProgress behaves exactly as before", async () => {
    serveStatuses(["running", "succeeded"]);
    const onSettle = jest.fn();
    await mounted([{ key: "card-1", jobId: JOB }], onSettle); // no `kind`, no `onProgress`
    await tick();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle.mock.calls[0][1]).toBe("made");
  });
});

// ─── The second pipeline's route (video V7 layer 4) ─────────────────────────────────────────────

describe("a stitch watch", () => {
  /** Every url the hook asked for, with the stitch route's own answer shape. */
  function serveStitch(status: string) {
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stitchId: JOB,
          status,
          error: null,
          startedAt: null,
          completedAt: null,
          asset:
            status === "succeeded"
              ? {
                  assetId: "a1",
                  mediaType: "VIDEO",
                  url: "https://signed.test/out.mp4",
                  approvalStatus: "draft",
                }
              : null,
        }),
      } as any;
    }) as never;
    return urls;
  }

  it("reads the STITCH route, not the job route", async () => {
    // ⚠️ THE REVERT CHECK FOR THE READER TABLE. `WatchKind` used to decide one thing — the clock —
    // and now decides two. Pointing "stitch" back at /studio/jobs/:id reds here, and it would
    // otherwise be invisible: the job route 404s a stitch id, which reads as "missing" and settles
    // the watch as `stalled` rather than as anything obviously wrong.
    const urls = serveStitch("running");
    const watches: Watch[] = [{ key: "k", jobId: JOB, kind: "stitch" }];
    renderHook(() =>
      useRunWatch(
        watches,
        () => {},
        () => {},
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`https://example.test/api/v1/me/studio/stitch/${JOB}`);
    expect(urls[0]).not.toMatch(/studio\/jobs/);
  });

  it("settles on the one file the stitch route answers with", async () => {
    // And the adapter is what makes that possible: `asset` (one) becomes `assets` (a list of one)
    // at the fetch boundary, so the hook's own settle path is untouched.
    const settled: { outcome: string; assets: number }[] = [];
    serveStitch("succeeded");
    const watches: Watch[] = [{ key: "k", jobId: JOB, kind: "stitch" }];
    renderHook(() =>
      useRunWatch(
        watches,
        (_k, outcome, read) =>
          settled.push({
            outcome,
            assets: read && typeof read === "object" ? read.assets.length : -1,
          }),
        () => {},
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(settled).toEqual([{ outcome: "made", assets: 1 }]);
  });

  it("leaves the image and video kinds on the job route", async () => {
    for (const kind of ["image", "video"] as const) {
      const urls = serveStitch("running");
      renderHook(() =>
        useRunWatch(
          [{ key: "k", jobId: JOB, kind }],
          () => {},
          () => {},
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(urls[0]).toBe(`https://example.test/api/v1/me/studio/jobs/${JOB}`);
    }
  });
});
