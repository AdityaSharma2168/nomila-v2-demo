/**
 * clipReadLogic.test.ts — "Read this clip" (PR 9.5): what the pill renders per state, what a tap
 * may do, and what a finished or failed read does to the Agent tray. Mutations, red-by-name
 * (ledger docs/probes/clip-reads.md §4):
 *   "Read this clip renders with STUDIO_CLIP_READ off" — readAffordance drops the `on` check
 *   "image asset gets a read affordance" (client half)  — readAffordance drops the `kind` check
 *   "unread clip cut without a read"                      — pickVideo / setCutOn drop the beats guard
 *   "read failure blocks the plan"                        — readNotDone drops the video from the tray
 */
import { cutVideos, asIsVideos } from "./storyboardLogic";
import {
  formatQuote,
  pickVideo,
  readAffordance,
  readDone,
  readNotDone,
  readOfAnswer,
  setCutOn,
  withRead,
  type ClipRead,
} from "./clipReadLogic";

const unread: ClipRead = { state: "unread", quotedUsd: 0.0069 };
const row = (read: ClipRead | null = unread, beats = 0) => ({
  assetId: "c1",
  posterUrl: null,
  beats,
  read,
});

describe("the pill — five states, flag-gated, clips only", () => {
  it("renders NOTHING with the flag off — 'Read this clip renders with STUDIO_CLIP_READ off' reds here", () => {
    expect(readAffordance({ kind: "clip", read: unread }, false)).toBeNull();
  });
  it("renders nothing for a photo — 'image asset gets a read affordance' reds here", () => {
    expect(readAffordance({ kind: "photo", read: unread }, true)).toBeNull();
  });
  it("renders nothing when the server served no read (an older server)", () => {
    expect(readAffordance({ kind: "clip", read: null }, true)).toBeNull();
    expect(readAffordance({ kind: "clip" }, true)).toBeNull();
  });
  it("unread: the quote on the button, tappable — never below a cent", () => {
    expect(readAffordance({ kind: "clip", read: unread }, true)).toEqual({
      state: "unread",
      label: "Read this clip · $0.01",
      sub: null,
      tappable: true,
    });
    expect(formatQuote(0.0334)).toBe("$0.04");
    expect(formatQuote(0.0381)).toBe("$0.04");
    expect(formatQuote(0.01)).toBe("$0.01");
  });
  it("reading: not tappable; read (N beats): not tappable; failed: reason + try again; at-cap: reason, not tappable", () => {
    expect(
      readAffordance(
        { kind: "clip", read: { state: "reading", quotedUsd: 0.01 } },
        true,
      ),
    ).toMatchObject({ label: "Reading…", tappable: false });
    expect(
      readAffordance({ kind: "clip", read: { state: "done", beats: 6 } }, true),
    ).toMatchObject({ label: "Read · 6 beats", tappable: false });
    expect(
      readAffordance({ kind: "clip", read: { state: "done", beats: 1 } }, true),
    ).toMatchObject({ label: "Read · 1 beat" });
    expect(
      readAffordance(
        {
          kind: "clip",
          read: {
            state: "failed",
            quotedUsd: 0.01,
            reason: "read didn't finish",
          },
        },
        true,
      ),
    ).toEqual({
      state: "failed",
      label: "Read failed · try again · $0.01",
      sub: "read didn't finish",
      tappable: true,
    });
    expect(
      readAffordance(
        {
          kind: "clip",
          read: {
            state: "at_cap",
            quotedUsd: 0.01,
            reason:
              "video enrichment daily cap — the rest of her clips wait for tomorrow",
          },
        },
        true,
      ),
    ).toEqual({
      state: "at_cap",
      label: "At today's reading limit",
      sub: "video enrichment daily cap — the rest of her clips wait for tomorrow",
      tappable: false,
    });
  });
  it("folds the route's answer onto the row's read", () => {
    expect(readOfAnswer({ status: "reading", quotedUsd: 0.02 }, 0.02)).toEqual({
      state: "reading",
      quotedUsd: 0.02,
    });
    expect(
      readOfAnswer({ status: "done", beats: 3, quotedUsd: 0.02 }, 0.02),
    ).toEqual({ state: "done", beats: 3 });
    expect(readOfAnswer({ status: "already_read", beats: 3 }, 0.02)).toEqual({
      state: "done",
      beats: 3,
    });
    expect(
      readOfAnswer({ status: "at_cap", reason: "cap", quotedUsd: 0.02 }, 0.02),
    ).toEqual({ state: "at_cap", quotedUsd: 0.02, reason: "cap" });
    expect(
      readOfAnswer(
        { status: "not_ready", reason: "wait", quotedUsd: 0.02 },
        0.02,
      ),
    ).toEqual({ state: "failed", quotedUsd: 0.02, reason: "wait" });
    expect(readOfAnswer({ status: "not_video", reason: "no" }, 0.02)).toEqual({
      state: "failed",
      quotedUsd: 0.02,
      reason: "no",
    });
  });
});

describe("the tray — a video without beats is never cut", () => {
  it("picking an unread clip adds it as-is; picking a read clip adds it CUT — 'unread clip cut without a read' reds here", () => {
    const u = pickVideo(row(unread, 0));
    expect(u).toMatchObject({
      assetId: "c1",
      beats: 0,
      cut: false,
      read: unread,
    });
    expect(cutVideos([u])).toEqual([]);
    expect(asIsVideos([u])).toEqual([{ assetId: "c1", posterUrl: null }]);
    const r = pickVideo(row({ state: "done", beats: 4 }, 4));
    expect(r).toMatchObject({ beats: 4, cut: true });
    expect(cutVideos([r])).toHaveLength(1);
  });
  it("setCut cannot switch an unread clip to CUT, and can switch a read clip either way", () => {
    const u = pickVideo(row(unread, 0));
    expect(setCutOn([u], "c1", true)[0].cut).toBe(false);
    const r = pickVideo(row({ state: "done", beats: 4 }, 4));
    expect(setCutOn([r], "c1", false)[0].cut).toBe(false);
    expect(setCutOn(setCutOn([r], "c1", false), "c1", true)[0].cut).toBe(true);
  });
  it("a finished read updates the tray in place — beat count, CUT by default, read state — no re-pick, no re-plan (P9's client half)", () => {
    const tray = [
      pickVideo(row(unread, 0)),
      pickVideo({ assetId: "c2", posterUrl: null, beats: 0, read: unread }),
    ];
    const after = readDone(tray, "c1", 6);
    expect(after[0]).toMatchObject({
      assetId: "c1",
      beats: 6,
      cut: true,
      read: { state: "done", beats: 6 },
    });
    expect(after[1]).toEqual(tray[1]);
    expect(cutVideos(after).map((v) => v.assetId)).toEqual(["c1"]);
    // A read that found no beats: done, still as-is.
    expect(readDone(tray, "c1", 0)[0]).toMatchObject({
      beats: 0,
      cut: false,
      read: { state: "done", beats: 0 },
    });
  });
  it("a read that did not finish KEEPS the video on the tray, as-is — the plan is not blocked — 'read failure blocks the plan' reds here (P5)", () => {
    const tray = [pickVideo(row(unread, 0))];
    const failed: ClipRead = {
      state: "failed",
      quotedUsd: 0.0069,
      reason: "couldn't read this clip",
    };
    const after = readNotDone(tray, "c1", failed);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      assetId: "c1",
      beats: 0,
      cut: false,
      read: failed,
    });
    expect(asIsVideos(after)).toEqual([{ assetId: "c1", posterUrl: null }]);
    const capped: ClipRead = {
      state: "at_cap",
      quotedUsd: 0.0069,
      reason: "cap",
    };
    expect(asIsVideos(readNotDone(tray, "c1", capped))).toHaveLength(1);
  });
  it("a poll's intermediate state rides on the row without touching cut or beats", () => {
    const tray = [pickVideo(row(unread, 0))];
    const reading: ClipRead = { state: "reading", quotedUsd: 0.0069 };
    expect(withRead(tray, "c1", reading)[0]).toMatchObject({
      beats: 0,
      cut: false,
      read: reading,
    });
  });
});
