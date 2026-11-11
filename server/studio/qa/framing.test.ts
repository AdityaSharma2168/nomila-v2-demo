/**
 * framing.test.ts — the instrument's calibration, and the observation's gate.
 *
 * ─── WHY SYNTHETIC TRUTH AND NOT A STORED RENDER ────────────────────────────────────────────────
 *
 * The question this instrument answers is geometric: by what scale and shift does the output's content
 * sit inside the source's. A synthetic pair has that answer EXACTLY — the fixture builds it — so the
 * test can say "recovered 1.12 from a constructed 1.12" rather than "recovered 1.12 from a render we
 * believe is zoomed". Probe 1's own calibration was run the same way before any paid cell was read
 * (docs/probes/framing-identity-stranger.md, the instrument's table).
 *
 * ⚠️ THE SCENE MUST NOT REPEAT. A periodic fixture (a checkerboard, a stripe grid) gives NCC many
 * near-equal maxima, and the fit then lands on a shifted lattice rather than on the truth: the first
 * draft of this file used a 50px checkerboard and the combined cell reported a 7.5% X shift for a
 * constructed 4.5% Y one. Both are 0.97 correlations; only one is the answer. The scene below is a
 * smooth low-frequency ground plus 45 blocks at random sizes and places, which has one maximum.
 *
 * ─── ⚠️  THE JEST VM RUNS THESE LOOPS ~10x SLOWER THAN NODE, SO THE TEST DROPS THE CANVAS ───────
 *
 * One alignment at the shipped canvas of 288 is ~3.9s under plain node — which is how the server runs
 * it — and roughly two minutes inside jest's vm-modules context, where the tight Float32Array loops
 * never specialize. Eight of them is a 334s suite, which is what the first draft of this file cost.
 *
 * So the tests pass `canvas` explicitly, and what that costs was MEASURED before it was chosen (the
 * table on `observeAddFraming`): at 64 every one of the four constructed transforms is recovered
 * exactly on scale and within 0.003 on shift. The numbers below are therefore the same numbers read on
 * a coarser grid, not a weakened assertion — the one place the grid shows is called out where it does.
 * Production passes no canvas and gets 288.
 */
import sharp from "sharp";

import {
  alignContent,
  observeAddFraming,
  REFRAME_SCALE_THRESHOLD,
  type Align,
} from "./framing";

const W = 600;
const H = 900; // 2:3 — one of the eight ratios the model accepts, so the snap is a no-op here.

/**
 * The grid every cell here is read on: exact on scale for all four constructed transforms and within
 * 0.003 on shift, at a twentieth of the shipped canvas's cost (the table on `observeAddFraming`). The
 * first draft ran at 144 and 96 and cost 334s for five tests — two of which failed on timeouts rather
 * than on numbers, which is a suite measuring the harness.
 */
const CANVAS = 64;
const FAST = { canvas: CANVAS };

beforeAll(() => {
  // ⚠️ THE OBSERVATION'S OWN 45s BOUND IS A PRODUCTION NUMBER, and inside this VM it fires: an
  // alignment that takes 3.9s under node takes ~2 minutes here, so `observeAddFraming` returned
  // `reframed: null` with a timeout reason and the tests asserted the bound instead of the geometry.
  // Raised for the suite only; nothing ships with this value.
  process.env.STUDIO_QA_FRAMING_TIMEOUT_MS = "600000";
});

/** A deterministic, non-repeating scene. See the header for why that matters. */
async function scene(): Promise<Buffer> {
  let seed = 987654321;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const v =
        110 +
        60 * Math.sin(x / 190 + 0.7) * Math.cos(y / 260 - 0.4) +
        25 * Math.sin((x + y) / 95);
      raw[i] = raw[i + 1] = raw[i + 2] = Math.max(0, Math.min(255, v));
    }
  }
  for (let n = 0; n < 45; n++) {
    const bw = 18 + Math.round(rnd() * 90);
    const bh = 18 + Math.round(rnd() * 90);
    const bx = Math.round(rnd() * (W - bw));
    const by = Math.round(rnd() * (H - bh));
    const g = Math.round(rnd() * 255);
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        const i = (y * W + x) * 3;
        raw[i] = raw[i + 1] = raw[i + 2] = g;
      }
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/**
 * The same scene's content rescaled by `k` inside the SAME canvas, then shifted by (fx, fy) as a
 * fraction of the frame. k > 1 crops and enlarges (zoomed in); k <= 1 shrinks and pads, which is the
 * shape probe 1b measured — the canvas stayed pinned at 3:4 every time and the CONTENT moved.
 */
async function reframe(
  src: Buffer,
  k: number,
  fx = 0,
  fy = 0,
): Promise<Buffer> {
  if (k > 1) {
    const cw = Math.round(W / k);
    const ch = Math.round(H / k);
    return sharp(src)
      .extract({
        left: Math.round((W - cw) / 2 + fx * W),
        top: Math.round((H - ch) / 2 + fy * H),
        width: cw,
        height: ch,
      })
      .resize(W, H, { fit: "fill", kernel: "lanczos3" })
      .jpeg({ quality: 95 })
      .toBuffer();
  }
  const iw = Math.round(W * k);
  const ih = Math.round(H * k);
  const inner = await sharp(src)
    .resize(iw, ih, { fit: "fill", kernel: "lanczos3" })
    .toBuffer();
  return sharp({
    create: {
      width: W,
      height: H,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .composite([
      {
        input: inner,
        left: Math.round((W - iw) / 2 + fx * W),
        top: Math.round((H - ih) / 2 + fy * H),
      },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
}

let src: Buffer;
beforeAll(async () => {
  src = await scene();
});

describe("the instrument recovers a transform it is given (probe 1's calibration)", () => {
  // ⚠️ TWO REAL ALIGNMENTS, AND THAT IS DELIBERATE. Each one is ~22s inside this VM against ~0.2s
  // under node, and the search grid is fixed, so the cost cannot be tuned away by the canvas (the
  // note on `AlignFn`). Two cells is what the instrument's claim needs: it reads NOTHING when nothing
  // moved, and it reads 1b's own shape when that moved. The zoom-in and pure-pan cells were measured
  // at every canvas while this was built and are recorded there, not re-run on every CI pass.
  it("reads identity as identity, and 1b's own reframe as 1b measured it", async () => {
    // Identity: the same bytes both sides. Anything but 1.000/0.000 here and no other number in this
    // file means anything.
    const same = await alignContent(src, src, { canvas: CANVAS });
    expect(same.scale).toBe(1);
    expect(same.dxFrac).toBe(0);
    expect(same.dyFrac).toBe(0);
    expect(same.ncc).toBeCloseTo(1, 3);

    // 1b'S OWN SHAPE: content 11% smaller and 4.5% down — the four paid cells measured Δscale
    // 0.8651-0.8931 and Δdy +0.0405-+0.0519. A reframe of that size has to be unmistakable, or the
    // observation cannot tell it from the canvas snap's ~1%.
    const reframed = await alignContent(
      src,
      await reframe(src, 0.89, 0, 0.045),
      { canvas: CANVAS },
    );
    expect(reframed.scale).toBeCloseTo(0.89, 2);
    expect(reframed.dyFrac).toBeCloseTo(0.045, 2);
    expect(Math.abs(reframed.dxFrac)).toBeLessThan(0.006);
    expect(1 - reframed.scale).toBeGreaterThan(REFRAME_SCALE_THRESHOLD);
  }, 300_000);
});

describe("the observation decides over the instrument, and is tested without paying for it", () => {
  /** An `Align` with the fields the decision reads; ncc is carried, never consulted. */
  const fit = (scale: number, dxFrac = 0, dyFrac = 0): Align => ({
    scale,
    dxFrac,
    dyFrac,
    ncc: 0.9,
    nccAtIdentity: 0.3,
  });

  /**
   * A stub instrument that answers a queue: the FIT first, then `cover` and `contain` if the decision
   * asks for them. `calls` is the proof of how many alignments the branch paid for — the cheap path's
   * whole claim.
   */
  const stub = (...queue: Align[]) => {
    const calls: number[] = [];
    const align = jest.fn(async () => {
      calls.push(1);
      return queue[calls.length - 1] ?? queue[queue.length - 1];
    });
    return { align, calls };
  };

  it("measures NOTHING when the intent placed no add", async () => {
    // The gate is the compile tier's own `placedAdds` (compile/templates.ts) — the same predicate the
    // prompt's framing line fires on. Empty means the instrument is never reached at all.
    const { align, calls } = stub(fit(1));
    expect(
      await observeAddFraming(
        { sourceBytes: src, outputBytes: src, placedAdds: [] },
        FAST,
        align,
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a held frame costs ONE alignment and renders no baseline", async () => {
    const { align, calls } = stub(fit(1.004, 0.002, -0.003));
    const held = await observeAddFraming(
      { sourceBytes: src, outputBytes: src, placedAdds: ["soccer ball"] },
      FAST,
      align,
    );
    expect(held!.reframed).toBe(false);
    expect(held!.reason).toBeNull();
    expect(held!.placedAdds).toEqual(["soccer ball"]);
    // THE CHEAP PATH: inside the thresholds against the identity transform, no baseline can make it a
    // reframe — `cover` and `contain` both sit BETWEEN the identity and any real reframe — so the two
    // extra alignments are never rendered. 18 of 19 paid adds take this path.
    expect(calls).toHaveLength(1);
    expect(held!.baseline).toBeNull();
    expect(held!.excess).toBeNull();
    expect(held!.output).toEqual({ width: W, height: H });
  });

  it("1b's reframe is judged against the closer aspect-snap baseline, and the excess is what remains", async () => {
    // add.1's real numbers, against the two controls as the probe measured them: `cover` keeps the
    // content's scale and reads ~1.000, `contain` gives up ~0.7% of the height to the snap and reads
    // 0.993 with a 0.6% downward shift. The decision must take `contain` — the one this output sits
    // closer to — and report what is LEFT after it, which is the reframe and not our choice of canvas.
    //
    // ⚠️ THE `cover` VALUE IS NOT FREE TO BE ANY NUMBER, and an earlier draft of this test got it
    // wrong: with cover stubbed at 0.94 the fit sits closer to COVER (4.7% away) than to contain
    // (10.0%), and the selection rule correctly picks cover. A baseline 6% off the identity is not a
    // snap, though — `cover` crops the long side and does not rescale content — so the stub was
    // describing a control that cannot occur, and the assertion it "should" have made was the wrong one.
    const { align, calls } = stub(
      fit(0.8931, 0.0035, 0.0481),
      fit(1, 0, 0),
      fit(0.993, 0, 0.006),
    );
    const moved = await observeAddFraming(
      {
        sourceBytes: src,
        outputBytes: await reframe(src, 0.89, 0, 0.045),
        placedAdds: ["water bottle"],
      },
      FAST,
      align,
    );
    expect(calls).toHaveLength(3);
    expect(moved!.reframed).toBe(true);
    expect(moved!.baseline!.convention).toBe("contain");
    expect(moved!.excess!.scale).toBeCloseTo(0.0999, 4);
    expect(moved!.excess!.shift).toBeCloseTo(0.0421, 4);
  });

  it("a fit the SNAP fully explains is not a reframe — the baseline is what makes that visible", async () => {
    // The same 0.993/0.006 fit, with a baseline that reads exactly the same: nothing is left over, so
    // the answer is "the canvas snapped", not "the model reframed". Without subtracting a control this
    // cell would read as a 0.7% reframe on every edit of a photo whose ratio is not one of the eight.
    const { align } = stub(
      fit(0.993, 0, 0.0221),
      fit(1, 0, 0),
      fit(0.993, 0, 0.0219),
    );
    const snapped = await observeAddFraming(
      {
        sourceBytes: src,
        outputBytes: await reframe(src, 0.99, 0, 0.022),
        placedAdds: ["soccer ball"],
      },
      FAST,
      align,
    );
    expect(snapped!.reframed).toBe(false);
    expect(snapped!.baseline!.convention).toBe("contain");
    expect(snapped!.excess).toEqual({ scale: 0, shift: 0.0002 });
  });

  it("answers `null` — never a held frame — when the instrument throws", async () => {
    // By the time this runs the generation is paid for and the asset is stored. A failure must not
    // throw, and it must not report scale 1.000 either: `fit` is null and `reason` says why.
    const broken = await observeAddFraming(
      { sourceBytes: src, outputBytes: src, placedAdds: ["soccer ball"] },
      FAST,
      async () => {
        throw new Error("libvips said no");
      },
    );
    expect(broken!.reframed).toBeNull();
    expect(broken!.fit).toBeNull();
    expect(broken!.reason).toBe("libvips said no");
  });

  it("answers `null` when the output's canvas will not parse — a baseline needs its dimensions", async () => {
    const { align, calls } = stub(fit(0.86, 0, 0.05));
    const unreadable = await observeAddFraming(
      {
        sourceBytes: src,
        outputBytes: Buffer.from("not an image"),
        placedAdds: ["soccer ball"],
      },
      FAST,
      align,
    );
    // sharp cannot read the output's metadata, so this fails before the instrument is called at all.
    expect(calls).toHaveLength(0);
    expect(unreadable!.reframed).toBeNull();
    expect(unreadable!.reason).toBeTruthy();
  });
});
