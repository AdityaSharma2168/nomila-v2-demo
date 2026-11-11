/**
 * studio/qa/framing — did the output keep the SOURCE'S CONTENT BOUNDS, or did it reframe?
 *
 * ─── WHAT THIS IS FOR, AND WHY IT IS ADDS ONLY ──────────────────────────────────────────────────
 *
 * Probe 1 (docs/probes/framing-identity-stranger.md) measured 30 native edits the athlete had already
 * paid for: **0 of 12 backgrounds** moved the frame (max 0.76% scale) and **1 of 19 adds** did. Probe
 * 1b then took that one positive back to a fixed cell and reproduced it **4 of 4** — content 11-13%
 * smaller and pushed 4-5% down (Δscale 0.8651-0.8931) — while the same sentence on a frame with
 * headroom is 0 of 2 at Δscale 1.000. The predictor is whether the place she named has room in the
 * frame she gave, so this observation fires on a **placed add** and nothing else. A framing check on
 * backgrounds is dead by that 0/12, and so is a blanket preservation line; what ships instead is the
 * prompt's own `ADD_FRAMING_LINE` (compile/templates.ts) and this, which says whether it worked.
 *
 * ─── ⚠️  IT OBSERVES. IT DOES NOT CHECK ─────────────────────────────────────────────────────────
 *
 * Not a `CheckResult`, not in `checks`, not in `overall`, not in `unknownChecks` — it hangs off the
 * verdict beside `identityObservation` (qa/verdict.ts) and nothing reads it to decide anything. There
 * is no threshold in this file anyone should treat as an acceptance bar: 1b's n is four cells on one
 * frame for one athlete. `REFRAME_*_THRESHOLD` separates "the frame moved" from "the canvas snapped",
 * which is a question about geometry, not about whether a render is good.
 *
 * ─── IT COSTS CPU AND NOTHING ELSE ──────────────────────────────────────────────────────────────
 *
 * No model call, no network, no row: sharp and arithmetic, ~5s of CPU for one alignment. That makes it
 * the cheapest thing in this stage by an order of magnitude — every other check bills a flash call —
 * and it is why an observation this narrow is worth having at all. The cheap path is one alignment; the
 * two aspect-snap baselines are computed ONLY when the first one looks like a reframe, so the 18-in-19
 * that hold their frame pay once.
 *
 * ─── THE INSTRUMENT IS THE PROBE'S, AND ITS CALIBRATION IS THE PROBE'S ──────────────────────────
 *
 * Ported from the probe's own measure.ts unchanged in its parameters — the canvas, the inset, the
 * search grid and its steps — because the numbers in the findings doc were produced by exactly these.
 * Its calibration, measured there against synthetic truth and reproduced by framing.test.ts:
 *
 *   identity           scale 1.000, shift 0.000/0.000, ncc 1.000
 *   zoom +5/+12/-8%    1.050 / 1.120 / 0.920, shift 0.000
 *   pan +3% x          scale 1.000, dx -0.031
 *   zoom +8% + pan 2%  1.080, -0.019/-0.019
 *
 * Changing a parameter here re-defines every number the probe recorded. Don't, without re-running it.
 */
import sharp from "sharp";

import { createLogger } from "../../logger";
import { withTimeout } from "../../lib/withTimeout";

const logger = createLogger("studio/qa/framing");

/**
 * When the fit stops being the canvas snap and starts being a reframe.
 *
 * 2% of the frame, which is 1b's own threshold: the reframes it measured are 11-13% and the instrument
 * floor is 0.3%, so nothing in that probe sits near this line. The aspect snap's residual does — a
 * 0.6829 frame asked for 2:3 fits at 0.993 with a 0.6% shift, by OUR choice of canvas (compile/aspect.ts)
 * and not by the model — which is what the baselines below exist to subtract.
 */
export const REFRAME_SCALE_THRESHOLD = 0.02;
export const REFRAME_SHIFT_THRESHOLD = 0.02;

/**
 * Its own bound, well inside the stage's 90s. A slow alignment must never cost the record a verdict.
 *
 * Measured under plain node, which is how the server runs it: ~3.9s for one alignment and ~12s for the
 * three the reframe path renders. 45s is the bound the identity observation takes too, and it is
 * headroom for a slower CPU rather than a budget anything is expected to use.
 *
 * ⚠️ READ AT CALL TIME, not at import. framing.test.ts has to raise it: the same loops are ~30x slower
 * inside jest's vm-modules context, so a suite that measures anything real would otherwise trip this
 * bound and record `reframed: null` — a test asserting a timeout instead of a measurement. Same idiom
 * as studio/config.ts's flag readers, for the same reason.
 */
const framingTimeoutMs = () =>
  Number(process.env.STUDIO_QA_FRAMING_TIMEOUT_MS ?? 45_000);

interface Gray {
  data: Float32Array;
  w: number;
  h: number;
}

/** EXIF-applied, grayscale, forced onto an exact canvas, as a float plane. */
async function gray(bytes: Buffer, w: number, h: number): Promise<Gray> {
  const { data } = await sharp(bytes)
    // `.rotate()` with no argument applies the EXIF orientation. Without it a sideways-tagged frame
    // is compared to an upright render and every number is meaningless — the same defect that voided
    // the reference packs' identity results (studio/personReference.ts).
    .rotate()
    .resize(w, h, { fit: "fill", kernel: "lanczos3" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i];
  return { data: out, w, h };
}

/**
 * Sobel gradient magnitude — the features the correlation locks onto.
 *
 * Edges rather than pixels so that the things a native edit is SUPPOSED to change move the numbers as
 * little as possible: a recolour, a new background or an added object all repaint large areas, and the
 * geometry still registers on what is left.
 */
function edges(g: Gray): Gray {
  const { data, w, h } = g;
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -data[i - w - 1] -
        2 * data[i - 1] -
        data[i + w - 1] +
        data[i - w + 1] +
        2 * data[i + 1] +
        data[i + w + 1];
      const gy =
        -data[i - w - 1] -
        2 * data[i - w] -
        data[i - w + 1] +
        data[i + w - 1] +
        2 * data[i + w] +
        data[i + w + 1];
      out[i] = Math.hypot(gx, gy);
    }
  }
  return { data: out, w, h };
}

/** Bilinear sample of `g` at a point given in ITS OWN pixel space; NaN outside it. */
function sample(g: Gray, x: number, y: number): number {
  if (x < 0 || y < 0 || x > g.w - 1 || y > g.h - 1) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, g.w - 1);
  const y1 = Math.min(y0 + 1, g.h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = g.data[y0 * g.w + x0];
  const b = g.data[y0 * g.w + x1];
  const c = g.data[y1 * g.w + x0];
  const d = g.data[y1 * g.w + x1];
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

/**
 * NCC between the source's central window and the output sampled under (scale, dx, dy).
 *
 * The model: a source point (xs, ys), measured from the frame's centre, appears in the output at
 * (xs * scale + dx, ys * scale + dy). scale > 1 ⇒ the output shows the same content BIGGER.
 */
function ncc(
  src: Gray,
  out: Gray,
  scale: number,
  dx: number,
  dy: number,
  inset: number,
): number {
  const cx = (src.w - 1) / 2;
  const cy = (src.h - 1) / 2;
  const x0 = Math.round(src.w * inset);
  const x1 = src.w - x0;
  const y0 = Math.round(src.h * inset);
  const y1 = src.h - y0;
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const a = src.data[y * src.w + x];
      const b = sample(
        out,
        (x - cx) * scale + cx + dx,
        (y - cy) * scale + cy + dy,
      );
      if (!Number.isFinite(b)) continue;
      n++;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
  }
  if (n < 100) return -1;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 0 || vb <= 0) return -1;
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

/** The similarity transform that best maps the source's content onto the output's. */
export interface Align {
  /** >1: the output's content is LARGER than the source's, i.e. zoomed in. */
  scale: number;
  /** The translation, as a fraction of the frame. */
  dxFrac: number;
  dyFrac: number;
  /** The correlation at the best fit, and at the identity transform, for context. */
  ncc: number;
  nccAtIdentity: number;
}

/**
 * The aligner, as a type — so the DECISION below can be tested without paying for the INSTRUMENT.
 *
 * ⚠️ ONE SEARCH GRID, WHATEVER THE CANVAS: 22,491 coarse evaluations and 4,913 fine ones per alignment,
 * fixed. That is why dropping the canvas barely helps inside jest (measured: 334s at 144/96 and 180s at
 * 64 for the same eight alignments) and why the observation's branching — cheap path vs baseline path,
 * held vs reframed, unanswered — is tested with a stub instead. Threaded as a defaulted parameter, the
 * same way studio/autoMask.ts threads its flags, and pinned the same way.
 */
export type AlignFn = (
  srcBytes: Buffer,
  outBytes: Buffer,
  opts?: { canvas?: number; inset?: number },
) => Promise<Align>;

/**
 * Coarse-to-fine search for that transform. `inset` keeps the window away from the frame's own edges,
 * so a shift does not have to invent pixels outside the output.
 *
 * ⚠️ RATIO IS NOT THE QUESTION HERE and never was: compile/aspect.ts pins the canvas, and the
 * 2026-09-09 probe settled it. A same-ratio zoom or pan has to be detectable, which is what this is.
 */
export async function alignContent(
  srcBytes: Buffer,
  outBytes: Buffer,
  opts: { canvas?: number; inset?: number } = {},
): Promise<Align> {
  const inset = opts.inset ?? 0.18;
  const meta = await sharp(srcBytes).rotate().metadata();
  const ratio = (meta.width ?? 1) / (meta.height ?? 1);
  const run = async (W: number) => {
    const H = Math.max(8, Math.round(W / ratio));
    return {
      src: edges(await gray(srcBytes, W, H)),
      out: edges(await gray(outBytes, W, H)),
      W,
      H,
    };
  };

  // ── stage 1: coarse, on a third of the canvas
  const c = await run(Math.round((opts.canvas ?? 288) / 3));
  let best = { scale: 1, dx: 0, dy: 0, v: -2 };
  for (let s = 0.78; s <= 1.28; s += 0.01) {
    for (let dx = -10; dx <= 10; dx += 1) {
      for (let dy = -10; dy <= 10; dy += 1) {
        const v = ncc(c.src, c.out, s, dx, dy, inset);
        if (v > best.v) best = { scale: s, dx, dy, v };
      }
    }
  }
  // ── stage 2: refine on the full canvas, in its own pixel units
  const f = await run(opts.canvas ?? 288);
  const k = f.W / c.W;
  let fine = { scale: best.scale, dx: best.dx * k, dy: best.dy * k, v: -2 };
  for (let s = best.scale - 0.02; s <= best.scale + 0.02 + 1e-9; s += 0.0025) {
    for (let dx = fine.dx - 4; dx <= fine.dx + 4 + 1e-9; dx += 0.5) {
      for (let dy = fine.dy - 4; dy <= fine.dy + 4 + 1e-9; dy += 0.5) {
        const v = ncc(f.src, f.out, s, dx, dy, inset);
        if (v > fine.v) fine = { scale: s, dx, dy, v };
      }
    }
  }
  return {
    scale: Number(fine.scale.toFixed(4)),
    dxFrac: Number((fine.dx / f.W).toFixed(4)),
    dyFrac: Number((fine.dy / f.H).toFixed(4)),
    ncc: Number(fine.v.toFixed(4)),
    nccAtIdentity: Number(ncc(f.src, f.out, 1, 0, 0, inset).toFixed(4)),
  };
}

/**
 * THE ASPECT-SNAP BASELINE — what a render that reframed NOTHING measures as.
 *
 * compile/aspect.ts snaps the frame's real ratio to the closest one the model accepts, so a 0.6829
 * frame is asked for 2:3 and comes back at 0.6709. The same scene on a different ratio CANNOT map onto
 * the source by one scale and a shift: something is cropped or letterboxed, and the fit shows a
 * ~0.5-1% residual that is the product's own choice of canvas, not the model reframing. ~1% of that
 * frame's height is given up to the snap on every edit of a photo whose ratio is not one of the eight.
 *
 * So the output gets its own control: the source re-rendered at the output's exact dimensions under
 * each of the two no-reframe conventions, measured by the same instrument. `cover` keeps the content's
 * scale and crops the long side; `contain` keeps all the content and pads the short side. The verdict
 * is read off the DIFFERENCE from whichever the output sits closer to.
 */
async function snapBaselines(
  srcBytes: Buffer,
  outW: number,
  outH: number,
  opts: { canvas?: number } = {},
  align: AlignFn = alignContent,
): Promise<{ cover: Align; contain: Align }> {
  const mk = async (fit: "cover" | "contain") =>
    await sharp(srcBytes)
      .rotate()
      .resize(outW, outH, {
        fit,
        position: "centre",
        background: { r: 0, g: 0, b: 0 },
      })
      .jpeg({ quality: 95 })
      .toBuffer();
  const [cover, contain] = await Promise.all([mk("cover"), mk("contain")]);
  const [coverAlign, containAlign] = await Promise.all([
    align(srcBytes, cover, opts),
    align(srcBytes, contain, opts),
  ]);
  return { cover: coverAlign, contain: containAlign };
}

/** How far an alignment sits from a baseline's, on the two quantities the verdict is read off. */
function excessOver(fit: Align, base: Align) {
  return {
    scale: Number(Math.abs(fit.scale - base.scale).toFixed(4)),
    shift: Number(
      Math.max(
        Math.abs(fit.dxFrac - base.dxFrac),
        Math.abs(fit.dyFrac - base.dyFrac),
      ).toFixed(4),
    ),
  };
}

/**
 * What the record holds about one placed add's framing. OBSERVATION ONLY — see the header.
 */
export interface FramingObservation {
  /** The things the frozen intent added at a place: why this observation ran at all. */
  placedAdds: string[];
  /**
   * The fit of the output's content onto the source's. Null when the alignment itself could not run —
   * an identity transform is NOT what a failure looks like, and writing one here would put "the frame
   * held" on the record for a measurement that never happened.
   */
  fit: Align | null;
  /**
   * The aspect-snap control it was judged against, and which convention that was. Null when the raw
   * fit was already inside the thresholds — there was nothing for a baseline to explain away, and the
   * two extra alignments are not worth their CPU.
   */
  baseline: { convention: "cover" | "contain"; align: Align } | null;
  /** |Δscale| and max|Δshift| IN EXCESS of the baseline's own residual. Null when no baseline ran. */
  excess: { scale: number; shift: number } | null;
  /**
   * Whether the content bounds moved by more than the canvas snap explains. Null means the observation
   * could not answer, and `reason` says why — never read a null as a frame that held.
   */
  reframed: boolean | null;
  reason: string | null;
  /** The output's own canvas, for reading the numbers beside the tier. */
  output: { width: number | null; height: number | null };
  latencyMs: number;
}

/**
 * Observe one placed add's framing: the output's content bounds against the chain root's.
 *
 * Returns null — having measured nothing — when the intent placed no add. Returns an observation with
 * `reframed: null` and a `reason` when it could not measure, and NEVER THROWS: by the time this runs
 * the generation is paid for and the asset is stored, so an exception escaping here would destroy
 * something valuable to report something worthless (qa/inspect.ts's rule, applied to its newest part).
 */
export async function observeAddFraming(
  input: {
    sourceBytes: Buffer;
    outputBytes: Buffer;
    placedAdds: readonly string[];
  },
  /**
   * The alignment canvas. Production passes nothing and gets the probe's 288; only framing.test.ts
   * lowers it, to keep a CPU-bound suite inside a sane runtime. What that costs, measured on this
   * machine over four synthetic cells (the table in the header, plus a pure pan):
   *
   *   canvas 288   every cell exact                                      ~3.9s per alignment
   *   canvas 144   exact on scale, shift within 0.001                     ~1.0s
   *   canvas  96   exact on scale, one pan cell reads 0.9975 for 1.0000   ~0.4s
   *   canvas  64   exact on scale, shift within 0.003                     ~0.2s   ← the test's
   *
   * So the verdict is the same at all four and the precision is not — which is why the default is the
   * one the findings doc's numbers were produced at.
   */
  opts: { canvas?: number } = {},
  /** The instrument. Production gets `alignContent`; framing.test.ts stubs it to test the decision. */
  align: AlignFn = alignContent,
): Promise<FramingObservation | null> {
  if (input.placedAdds.length === 0) return null;
  const started = Date.now();
  const base = {
    placedAdds: [...input.placedAdds],
    output: { width: null, height: null },
    baseline: null,
    excess: null,
    reframed: null,
  };
  try {
    return await withTimeout(
      (async (): Promise<FramingObservation> => {
        const meta = await sharp(input.outputBytes).rotate().metadata();
        const outW = meta.width ?? null;
        const outH = meta.height ?? null;
        const fit = await align(input.sourceBytes, input.outputBytes, opts);

        const held =
          Math.abs(fit.scale - 1) <= REFRAME_SCALE_THRESHOLD &&
          Math.max(Math.abs(fit.dxFrac), Math.abs(fit.dyFrac)) <=
            REFRAME_SHIFT_THRESHOLD;
        if (held || !outW || !outH) {
          // Inside the thresholds against the identity transform, so no baseline can make it a
          // reframe: `contain` and `cover` sit BETWEEN the identity and any real reframe. Or the
          // output's canvas is unreadable, and a baseline cannot be rendered at dimensions we do not
          // have — reported as unanswered rather than as a frame that held.
          return {
            ...base,
            fit,
            output: { width: outW, height: outH },
            reframed: held ? false : null,
            reason: held ? null : "the output's canvas did not parse",
            latencyMs: Date.now() - started,
          };
        }

        const baselines = await snapBaselines(
          input.sourceBytes,
          outW,
          outH,
          opts,
          align,
        );
        const candidates = (["cover", "contain"] as const).map(
          (convention) => ({
            convention,
            align: baselines[convention],
            excess: excessOver(fit, baselines[convention]),
          }),
        );
        // Whichever control the output sits closer to, on the same quantity the verdict is read off.
        const closest = candidates.reduce((a, b) =>
          Math.max(b.excess.scale, b.excess.shift) <
          Math.max(a.excess.scale, a.excess.shift)
            ? b
            : a,
        );
        return {
          ...base,
          fit,
          output: { width: outW, height: outH },
          baseline: { convention: closest.convention, align: closest.align },
          excess: closest.excess,
          reframed:
            closest.excess.scale > REFRAME_SCALE_THRESHOLD ||
            closest.excess.shift > REFRAME_SHIFT_THRESHOLD,
          reason: null,
          latencyMs: Date.now() - started,
        };
      })(),
      framingTimeoutMs(),
      "framing observation",
    );
  } catch (err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(
      0,
      160,
    );
    logger.warn({ error: message }, "framing observation did not complete");
    return {
      ...base,
      fit: null,
      reason: message,
      latencyMs: Date.now() - started,
    };
  }
}
