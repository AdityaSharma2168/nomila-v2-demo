/**
 * beatLogic.test.ts — a stills edit on the beat: every cut within half a frame of one, however long.
 */
import { snapToBeat, type BeatPlan } from "./beatLogic";
import type { TimelineItem } from "./stitchLogic";

const FPS = 30;
/** walking-away's measured grid is 81.5 BPM; 85 is three of the beds'. */
const plan = (bpm: number, firstBeatSec = 0.004): BeatPlan => ({
  grid: { bpm, firstBeatSec },
  fps: FPS,
  minStillSec: 1,
  maxStillSec: 8,
});

const still = (
  key: string,
  stillSec: number,
  crossfadeSec?: number,
): TimelineItem => ({
  key: `${key}:still`,
  assetId: `photo-${key}`,
  durationSec: null,
  durationPreciseSec: null,
  stillSec,
  ...(crossfadeSec === undefined ? {} : { crossfadeSec }),
});

/** Seconds from `t` to the nearest beat of the plan's grid. */
const offBeat = (t: number, p: BeatPlan) => {
  const P = 60 / p.grid.bpm;
  const d = (((t - p.grid.firstBeatSec) % P) + P) % P;
  return Math.min(d, P - d);
};

describe("snapToBeat — each still ends on a beat", () => {
  /**
   * ⚠️ MUTATION "grid ignored": snapToBeat hands the positions back unchanged — this reds by name
   * (2 s holds at 85 BPM end 0.12 s, 0.24 s … off the beat).
   */
  it("six photos held about 2 s at 85 BPM: every cut within half a frame of a beat, every hold whole frames", () => {
    const p = plan(85);
    const items = Array.from({ length: 6 }, (_, i) =>
      still(`s${i}`, 2, i > 0 ? 0.5 : undefined),
    );
    const out = snapToBeat(items, p);
    let t = 0;
    for (const s of out) {
      expect(s.startSec).not.toBeNull();
      expect(Math.abs((s.startSec as number) - t)).toBeLessThan(1e-6);
      expect(offBeat(s.startSec as number, p)).toBeLessThanOrEqual(
        0.5 / FPS + 1e-9,
      );
      expect(s.onBeat).toBe(true);
      const hold = s.item.stillSec as number;
      expect(Math.abs(hold * FPS - Math.round(hold * FPS))).toBeLessThan(1e-3);
      // Three beats of 0.706 s is the nearest to 2 s.
      expect(s.beats).toBe(3);
      // Joins beside a still are cuts on the beat.
      expect(s.item.crossfadeSec).toBeUndefined();
      t += hold;
    }
    expect(offBeat(t, p)).toBeLessThanOrEqual(0.5 / FPS + 1e-9);
  });

  it("does not drift: the twentieth cut is as close to its beat as the first", () => {
    const p = plan(81.5, 0.012);
    const out = snapToBeat(
      Array.from({ length: 20 }, (_, i) => still(`s${i}`, 1.7)),
      p,
    );
    const last = out[19];
    const end = (last.startSec as number) + (last.item.stillSec as number);
    expect(offBeat(end, p)).toBeLessThanOrEqual(0.5 / FPS + 1e-9);
    // Naive whole-beat holds, rounded to frames each time, would be this far off by now.
    const beat = 60 / 81.5;
    const naive = (20 * Math.round(2 * beat * FPS)) / FPS;
    expect(offBeat(naive, p)).toBeGreaterThan(0.5 / FPS);
  });

  it("a snapped hold stays inside the server's bounds: 1 s at 63 BPM is two beats, not one of 0.95 s", () => {
    const out = snapToBeat([still("a", 1), still("b", 8)], plan(63, 0));
    expect(out[0].item.stillSec).toBeGreaterThanOrEqual(1);
    expect(out[0].beats).toBe(2);
    expect(out[1].item.stillSec).toBeLessThanOrEqual(8);
  });

  it("tokyo-sunset (63 BPM): every hold at least 1.5 s, whole frames, ending on a beat", () => {
    const p = plan(63, 0.951);
    const out = snapToBeat(
      [still("a", 1), still("b", 1.2), still("c", 2), still("d", 1)],
      p,
    );
    for (const s of out) {
      const hold = s.item.stillSec as number;
      expect(hold).toBeGreaterThanOrEqual(1.5);
      expect(Math.abs(hold * FPS - Math.round(hold * FPS))).toBeLessThan(1e-3);
      const end = (s.startSec as number) + hold;
      expect(offBeat(end, p)).toBeLessThanOrEqual(0.5 / FPS + 1e-9);
    }
  });

  /**
   * ⚠️ MUTATION "min-hold ignored": the slow-track floor is dropped (back to the server's 1 s) —
   * this reds by name: at 60 BPM one beat IS 1 s. (The tokyo-sunset test above holds either way:
   * at 63 BPM the server's own 1 s already forces two beats.)
   */
  it("on a slow track a photo is held for the fewest beats that make 1.5 s — at 60 BPM, two, not one", () => {
    const out = snapToBeat([still("a", 1), still("b", 1.1)], plan(60, 0));
    expect(out.map((s) => s.beats)).toEqual([2, 2]);
    expect(out.map((s) => s.item.stillSec)).toEqual([2, 2]);
    const fast = snapToBeat([still("a", 1)], plan(85, 0));
    expect(fast[0].beats).toBe(2);
    expect(fast[0].item.stillSec).toBeLessThan(1.5);
  });

  it("a shot whose length is the model's leaves everything after it unknown — held as she chose, never called on the beat", () => {
    const made: TimelineItem = {
      key: "g:clip",
      assetId: "made-1",
      durationSec: null,
      durationPreciseSec: null,
    };
    const out = snapToBeat(
      [still("a", 2), made, still("b", 2.5, 0.5)],
      plan(85),
    );
    expect(out[1].onBeat).toBe(true); // it starts where the still ended
    expect(out[2].startSec).toBeNull();
    expect(out[2].onBeat).toBe(false);
    expect(out[2].item.stillSec).toBe(2.5);
    expect(out[2].beats).toBeNull();
    // Still a cut: a join beside a still is a cut on the beat whether or not its time is known.
    expect(out[2].item.crossfadeSec).toBeUndefined();
  });

  it("her clip cut to a window keeps the fade into another clip, and the still after it re-locks to the grid", () => {
    const p = plan(85);
    const clip = (
      key: string,
      start: number,
      end: number,
      fade?: number,
    ): TimelineItem => ({
      key: `${key}:own`,
      assetId: `clip-${key}`,
      durationSec: 20,
      durationPreciseSec: null,
      trimStartSec: start,
      trimEndSec: end,
      ...(fade === undefined ? {} : { crossfadeSec: fade }),
    });
    const out = snapToBeat(
      [clip("c1", 3, 5.1), clip("c2", 0, 2.3, 0.5), still("s", 2, 0.5)],
      p,
    );
    expect(out[1].item.crossfadeSec).toBe(0.5);
    // 2.1 − 0.5 = 1.6 s in: the second clip starts off the beat, and is not called on it.
    expect(out[1].startSec).toBeCloseTo(1.6, 6);
    expect(out[1].onBeat).toBe(false);
    // The still starts off the beat too — but ENDS on one.
    const s = out[2];
    expect(s.item.crossfadeSec).toBeUndefined();
    const end = (s.startSec as number) + (s.item.stillSec as number);
    expect(offBeat(end, p)).toBeLessThanOrEqual(0.5 / FPS + 1e-9);
  });
});
