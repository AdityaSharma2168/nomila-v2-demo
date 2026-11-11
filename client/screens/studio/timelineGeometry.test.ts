/**
 * timelineGeometry — the track's arithmetic, pinned without a renderer.
 *
 * Everything the CapCut-style surface does to a gesture's x, or to a playhead's second, goes
 * through this file. What it CANNOT prove: that the track looks right, that a drag feels like a
 * drag, or that a real mp4's duration reads back on a device. Those are Adi's acceptance.
 */
import {
  clampZoom,
  DEFAULT_PX_PER_SEC,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  resolveDuration,
  clampToTrack,
  dropIndexFor,
  resolvePlayhead,
  RULER_MIN_TICK_PX,
  rulerTicks,
  spanOf,
  tickIntervalSec,
  timeAtX,
  trackLayout,
  trackTimeAt,
  UNKNOWN_PLACEHOLDER_SEC,
  xAtTime,
} from "./timelineGeometry";
import { moveItem, timelineTotals, type TimelineItem } from "./stitchLogic";

const item = (over: Partial<TimelineItem> & { key: string }): TimelineItem => ({
  assetId: "a",
  durationSec: null,
  durationPreciseSec: null,
  ...over,
});

describe("how long is this clip, really", () => {
  it("takes the server's PRECISE measurement first — it cost nothing to get", () => {
    // duration_seconds_precise is ffprobe's answer on the stored bytes, and it arrived with the
    // clip. Decoding again would be paying twice for the same number.
    expect(resolveDuration(7.43, 7.4, 7)).toEqual({
      seconds: 7.43,
      source: "precise",
    });
  });

  it("falls to the client's own decode when the server has not probed the row", () => {
    // ⚠️ ABOVE the integer, not below it. Both are exact; the integer is rounded.
    expect(resolveDuration(null, 7.4, 7)).toEqual({
      seconds: 7.4,
      source: "measured",
    });
  });

  it("uses the rounded integer only when neither measurement exists", () => {
    // routes/media.ts stores duration_seconds through Math.round(), so a 7.4s clip arrives as 7 —
    // and trim handles built on 7 cannot reach the last 0.4s.
    expect(resolveDuration(null, null, 7)).toEqual({
      seconds: 7,
      source: "wire",
    });
  });

  it("draws an unknown at a placeholder width rather than at zero", () => {
    // Zero width is an invisible, untappable clip — she could not select it to fix it.
    const d = resolveDuration(null, null, null);
    expect(d.source).toBe("unknown");
    expect(d.seconds).toBe(UNKNOWN_PLACEHOLDER_SEC);
    expect(d.seconds).toBeGreaterThan(0);
  });

  it("treats a zero, negative or non-finite reading as no reading at all, at EVERY rung", () => {
    // The server serves null rather than 0 for an unprobed row, but a null is not the only way a
    // rung can be empty — and a 0 cached anywhere draws that clip at zero width forever.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(resolveDuration(bad, bad, bad).source).toBe("unknown");
      expect(resolveDuration(bad, bad, 5)).toEqual({
        seconds: 5,
        source: "wire",
      });
      expect(resolveDuration(bad, 5, 9)).toEqual({
        seconds: 5,
        source: "measured",
      });
    }
  });
});

describe("the span of the source a position plays", () => {
  it("is the whole clip when there is no trim", () => {
    expect(spanOf({}, 10)).toEqual({ startSec: 0, endSec: 10, seconds: 10 });
  });

  it("is the trimmed window when there is one, in SOURCE seconds", () => {
    expect(spanOf({ trimStartSec: 2, trimEndSec: 6 }, 10)).toEqual({
      startSec: 2,
      endSec: 6,
      seconds: 4,
    });
  });

  it("agrees with the server's effectiveSeconds on a half-open trim", () => {
    // materialize.effectiveSeconds: start = trimStart ?? 0, end = trimEnd ?? whole.
    expect(spanOf({ trimStartSec: 3 }, 10).seconds).toBe(7);
    expect(spanOf({ trimEndSec: 3 }, 10).seconds).toBe(3);
  });
});

describe("px and seconds are exact inverses", () => {
  it("round-trips at every zoom, which is what scrub, trim and split all lean on", () => {
    for (const pxPerSec of [
      MIN_PX_PER_SEC,
      DEFAULT_PX_PER_SEC,
      73.5,
      MAX_PX_PER_SEC,
    ]) {
      for (const sec of [0, 0.25, 1, 7.4, 180]) {
        expect(timeAtX(xAtTime(sec, pxPerSec), pxPerSec)).toBeCloseTo(sec, 9);
      }
    }
  });

  it("clamps a nonsense zoom instead of producing an infinite or zero-width track", () => {
    expect(clampZoom(0)).toBe(DEFAULT_PX_PER_SEC);
    expect(clampZoom(NaN)).toBe(DEFAULT_PX_PER_SEC);
    expect(clampZoom(-5)).toBe(DEFAULT_PX_PER_SEC);
    expect(clampZoom(10_000)).toBe(MAX_PX_PER_SEC);
    expect(clampZoom(0.5)).toBe(MIN_PX_PER_SEC);
  });
});

describe("laying the track out", () => {
  const measured = new Map([
    ["a", 10],
    ["b", 6],
  ]);

  it("draws each clip proportional to what it actually plays", () => {
    const layout = trackLayout(
      [item({ key: "1" }), item({ key: "2", assetId: "b" })],
      measured,
      10,
    );
    expect(layout.rects.map((r) => r.width)).toEqual([100, 60]);
    expect(layout.rects.map((r) => r.x)).toEqual([0, 100]);
    expect(layout.totalSeconds).toBe(16);
    expect(layout.totalWidth).toBe(160);
  });

  it("draws a TRIMMED clip at its trimmed width, not its source width", () => {
    const layout = trackLayout(
      [item({ key: "1", trimStartSec: 2, trimEndSec: 5 })],
      measured,
      10,
    );
    expect(layout.rects[0].width).toBe(30);
    expect(layout.rects[0].sourceStartSec).toBe(2);
    expect(layout.rects[0].sourceEndSec).toBe(5);
  });

  it("SUBTRACTS the crossfade, so the ruler agrees with the finished video", () => {
    // A 2s crossfade makes the output 2s shorter than the sum of its parts — the accumulator
    // timelineTotals uses and the one plan.ts places xfade offsets with. End-to-end would put the
    // playhead up to 2s per join away from the frame it points at.
    const items = [
      item({ key: "1" }),
      item({ key: "2", assetId: "b", crossfadeSec: 2 }),
    ];
    const layout = trackLayout(items, measured, 10);
    expect(layout.totalSeconds).toBe(14);
    expect(layout.rects[1].startSec).toBe(8);
    // …and it is the same number the totals label shows her.
    expect(layout.totalSeconds).toBe(
      timelineTotals(
        items.map((i) => ({ ...i, durationSec: measured.get(i.assetId)! })),
      ).seconds,
    );
  });

  it("overlaps the rects by exactly the fade, because that is what a crossfade IS", () => {
    const layout = trackLayout(
      [item({ key: "1" }), item({ key: "2", assetId: "b", crossfadeSec: 2 })],
      measured,
      10,
    );
    expect(layout.rects[1].startSec).toBeLessThan(layout.rects[0].endSec);
    expect(layout.rects[0].endSec - layout.rects[1].startSec).toBe(2);
  });

  it("clamps a fade longer than either neighbour rather than drawing a backwards rect", () => {
    const layout = trackLayout(
      [
        item({ key: "1", trimEndSec: 1 }),
        item({ key: "2", assetId: "b", crossfadeSec: 5 }),
      ],
      measured,
      10,
    );
    expect(layout.rects[1].startSec).toBe(0);
    expect(layout.rects[1].width).toBeGreaterThan(0);
    expect(layout.rects[1].endSec).toBeGreaterThan(layout.rects[1].startSec);
  });

  it("never gives position 0 a fade, even if one survived onto it", () => {
    const layout = trackLayout(
      [item({ key: "1", crossfadeSec: 2 })],
      measured,
      10,
    );
    expect(layout.rects[0].startSec).toBe(0);
    expect(layout.rects[0].x).toBe(0);
  });

  it("says out loud when it is drawing a guess", () => {
    const layout = trackLayout(
      [item({ key: "1", assetId: "zzz" }), item({ key: "2", assetId: "a" })],
      measured,
      10,
    );
    expect(layout.rects[0].durationSource).toBe("unknown");
    expect(layout.rects[1].durationSource).toBe("measured");
  });

  it("is empty, not broken, with no clips", () => {
    expect(trackLayout([], measured, 10)).toEqual({
      rects: [],
      totalWidth: 0,
      totalSeconds: 0,
    });
  });
});

describe("an unknown duration answers WIDTH and TOTALS differently, and must", () => {
  // The one place layout and totals deliberately disagree. A placeholder exists so the clip can be
  // seen and fixed; letting it reach the totals would tell her a timeline is longer than anything
  // we know, inflate the refusal, and block a timeline the server would accept.
  const unknown = [item({ key: "1", assetId: "zzz", durationSec: null })];

  it("draws it at the placeholder width", () => {
    const layout = trackLayout(unknown, new Map(), 10);
    expect(layout.rects[0].width).toBe(UNKNOWN_PLACEHOLDER_SEC * 10);
  });

  it("still contributes ZERO to the totals the refusal is computed from", () => {
    expect(timelineTotals(unknown).seconds).toBe(0);
  });
});

describe("where the playhead is pointing", () => {
  const measured = new Map([
    ["a", 10],
    ["b", 6],
  ]);

  it("answers in SOURCE time, offset by the trim — not in track time", () => {
    // The easiest thing here to get wrong, and invisible on an untrimmed clip because trimStart is
    // then 0. Seek a player to track time on a trimmed clip and every frame is wrong.
    const layout = trackLayout(
      [item({ key: "1", trimStartSec: 4, trimEndSec: 9 })],
      measured,
      10,
    );
    // 2s along the TRACK is 4 + 2 = 6s into the SOURCE.
    expect(resolvePlayhead(2, layout)).toEqual({ index: 0, sourceSec: 6 });
  });

  it("picks the LATER clip inside a crossfade, because that is the one she is looking at", () => {
    const layout = trackLayout(
      [item({ key: "1" }), item({ key: "2", assetId: "b", crossfadeSec: 2 })],
      measured,
      10,
    );
    // The overlap is track 8–10s: clip 0 still runs, clip 1 has started and is drawn on top.
    expect(resolvePlayhead(9, layout)!.index).toBe(1);
    // …and it resolves into clip 1's source, 1s in, not 9s into clip 0.
    expect(resolvePlayhead(9, layout)!.sourceSec).toBe(1);
  });

  it("resolves an ordinary interior point to the clip that owns it", () => {
    const layout = trackLayout(
      [item({ key: "1" }), item({ key: "2", assetId: "b" })],
      measured,
      10,
    );
    expect(resolvePlayhead(3, layout)).toEqual({ index: 0, sourceSec: 3 });
    expect(resolvePlayhead(12, layout)).toEqual({ index: 1, sourceSec: 2 });
  });

  it("clamps outside the track instead of refusing to show anything", () => {
    const layout = trackLayout([item({ key: "1" })], measured, 10);
    expect(resolvePlayhead(-5, layout)).toEqual({ index: 0, sourceSec: 0 });
    expect(resolvePlayhead(999, layout)).toEqual({ index: 0, sourceSec: 10 });
  });

  it("never seeks past a trim's out-point, whatever the arithmetic drifts to", () => {
    const layout = trackLayout(
      [item({ key: "1", trimStartSec: 2, trimEndSec: 5 })],
      measured,
      10,
    );
    const at = resolvePlayhead(2.9999999, layout)!;
    expect(at.sourceSec).toBeLessThanOrEqual(5);
    expect(at.sourceSec).toBeGreaterThanOrEqual(2);
  });

  it("is null only when there is no timeline at all", () => {
    expect(resolvePlayhead(0, trackLayout([], measured, 10))).toBeNull();
  });
});

describe("the ruler", () => {
  it("spaces its ticks by at least the minimum at EVERY zoom", () => {
    // One tick per second is 200pt apart at max zoom and 8pt apart at min — unreadable at one end,
    // useless at the other. The interval has to follow the zoom.
    for (const zoom of [
      MIN_PX_PER_SEC,
      12,
      DEFAULT_PX_PER_SEC,
      90,
      MAX_PX_PER_SEC,
    ]) {
      expect(tickIntervalSec(zoom) * zoom).toBeGreaterThanOrEqual(
        RULER_MIN_TICK_PX,
      );
    }
  });

  it("picks a COARSER interval as it zooms out, not the same one", () => {
    expect(tickIntervalSec(MIN_PX_PER_SEC)).toBeGreaterThan(
      tickIntervalSec(MAX_PX_PER_SEC),
    );
  });

  it("uses whole seconds, so two ticks never print the same label", () => {
    for (const zoom of [MIN_PX_PER_SEC, DEFAULT_PX_PER_SEC, MAX_PX_PER_SEC]) {
      expect(Number.isInteger(tickIntervalSec(zoom))).toBe(true);
    }
  });

  it("starts at zero and never runs past the end of the track", () => {
    // A ruler longer than the track implies footage that is not there.
    const ticks = rulerTicks(17, DEFAULT_PX_PER_SEC);
    expect(ticks[0].sec).toBe(0);
    for (const t of ticks) expect(t.sec).toBeLessThanOrEqual(17);
  });

  it("puts each tick where xAtTime says it goes", () => {
    for (const t of rulerTicks(30, 25)) expect(t.x).toBe(xAtTime(t.sec, 25));
  });

  it("has nothing to draw for an empty or nonsense timeline", () => {
    expect(rulerTicks(0, DEFAULT_PX_PER_SEC)).toEqual([]);
    expect(rulerTicks(-1, DEFAULT_PX_PER_SEC)).toEqual([]);
    expect(rulerTicks(NaN, DEFAULT_PX_PER_SEC)).toEqual([]);
  });
});

describe("the inverse — where on the track a source second is showing", () => {
  const measured = new Map([
    ["a", 10],
    ["b", 6],
  ]);

  it("round-trips with resolvePlayhead for any point inside a clip", () => {
    // If these two disagree the playhead drifts from the frame during playback — by the trim
    // offset and by every crossfade before this position.
    const layout = trackLayout(
      [
        item({ key: "1", trimStartSec: 2, trimEndSec: 8 }),
        item({ key: "2", assetId: "b", crossfadeSec: 1 }),
      ],
      measured,
      10,
    );
    for (const t of [0, 1.5, 3, 5.5, 6, 8, 10]) {
      const at = resolvePlayhead(t, layout)!;
      expect(trackTimeAt(at.index, at.sourceSec, layout)).toBeCloseTo(t, 9);
    }
  });

  it("is null for a position that is no longer on the track", () => {
    // A progress event from a clip she removed mid-playback.
    const layout = trackLayout([item({ key: "1" })], measured, 10);
    expect(trackTimeAt(7, 1, layout)).toBeNull();
  });

  it("never reports a time outside the clip it was asked about", () => {
    const layout = trackLayout(
      [item({ key: "1", trimStartSec: 2, trimEndSec: 5 })],
      measured,
      10,
    );
    expect(trackTimeAt(0, 99, layout)).toBe(3);
    expect(trackTimeAt(0, -99, layout)).toBe(0);
  });
});

describe("keeping a scrub on the track", () => {
  const measured = new Map([["a", 10]]);

  it("clamps a drag that ran past either end", () => {
    const layout = trackLayout([item({ key: "1" })], measured, 10);
    expect(clampToTrack(-4, layout)).toBe(0);
    expect(clampToTrack(99, layout)).toBe(10);
    expect(clampToTrack(4, layout)).toBe(4);
  });

  it("collapses to zero on an empty track rather than going negative", () => {
    const empty = trackLayout([], measured, 10);
    expect(clampToTrack(5, empty)).toBe(0);
    expect(clampToTrack(NaN, empty)).toBe(0);
  });
});

describe("a rect knows whether it fades in", () => {
  it("carries the crossfade, so a track can be drawn from a layout alone", () => {
    const layout = trackLayout(
      [
        item({ key: "1" }),
        item({ key: "2", assetId: "b", crossfadeSec: 2 }),
        item({ key: "3", assetId: "b" }),
      ],
      new Map([
        ["a", 10],
        ["b", 6],
      ]),
      10,
    );
    expect(layout.rects.map((r) => r.hasCrossfade)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("does not claim a fade that was clamped away to nothing", () => {
    // A fade longer than either neighbour has nothing to fade; it must not be drawn as one.
    const layout = trackLayout(
      [item({ key: "1", trimEndSec: 0 }), item({ key: "2", crossfadeSec: 2 })],
      new Map([["a", 10]]),
      10,
    );
    expect(layout.rects[1].hasCrossfade).toBe(false);
  });
});

describe("where a dragged clip lands", () => {
  // Three clips at 10px/s: a 0–100, b 100–160, c 160–260. Centres 50, 130, 210.
  const three = [
    item({ key: "a", durationPreciseSec: 10 }),
    item({ key: "b", assetId: "b", durationPreciseSec: 6 }),
    item({ key: "c", assetId: "c", durationPreciseSec: 10 }),
  ];
  const layout = trackLayout(three, new Map(), 10);

  it("stays put when it has not really moved", () => {
    // Counting the dragged clip against itself would make it jump the moment it crossed its own
    // centre — so it is skipped, and a drop where it started is a no-op.
    expect(dropIndexFor(50, layout, 0)).toBe(0);
    expect(dropIndexFor(130, layout, 1)).toBe(1);
    expect(dropIndexFor(210, layout, 2)).toBe(2);
  });

  it("⚠️ lands BETWEEN the two clips whose centres it was dropped between", () => {
    // Dragging the first clip past b's centre but not past c's puts it second.
    expect(dropIndexFor(131, layout, 0)).toBe(1);
    // Past c's centre too: last.
    expect(dropIndexFor(211, layout, 0)).toBe(2);
  });

  it("lands first when dragged left of everything", () => {
    expect(dropIndexFor(0, layout, 2)).toBe(0);
    expect(dropIndexFor(-999, layout, 1)).toBe(0);
  });

  it("lands last when dragged right of everything", () => {
    expect(dropIndexFor(999, layout, 0)).toBe(2);
    expect(dropIndexFor(999, layout, 1)).toBe(2);
  });

  it("is the index AFTER removal, which is what moveItem's `to` means", () => {
    // The property that makes a +1 or -1 correction wrong anywhere.
    const to = dropIndexFor(211, layout, 0);
    expect(moveItem(three, 0, to).map((i) => i.key)).toEqual(["b", "c", "a"]);
  });

  it("refuses to guess on a nonsense coordinate", () => {
    expect(dropIndexFor(NaN, layout, 1)).toBe(1);
  });
});
