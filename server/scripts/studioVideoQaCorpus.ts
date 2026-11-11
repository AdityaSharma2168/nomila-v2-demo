#!/usr/bin/env -S npx tsx
/**
 * studioVideoQaCorpus — validate the video QA instrument against clips we already paid for.
 *
 * THROWAWAY. Nothing in the repo imports it; it is kept because it is cheap to keep and the next
 * video question will want it, exactly as `studioVideoBakeoff.ts` is kept.
 *
 * ─── WHY THIS EXISTS BEFORE ANY NEW GENERATION ─────────────────────────────────────────────────
 *
 * V9's instrument makes two claims that can be checked for nothing against clips already on disk:
 *
 *   V-1  the drift curve, moved out of the bake-off harness into studio/video/frames.ts, still
 *        computes what the harness computed. V2b published 0.035/0.031, 0.087/0.166, 0.199/0.163
 *        for its three Veo cells; if the ported function does not reproduce them, every number the
 *        stage records from now on is on a different scale from the only baseline that exists.
 *   V-2  `selectFrames` lands on the excursion where a fixed first/middle/last does not. The
 *        synthetic fixture in frames.test.ts proves the arithmetic; this proves it on the real
 *        clip the argument was made about.
 *
 * Both are ffmpeg and sharp. NO MODEL CALL, NO NETWORK, NO DATABASE, and the script refuses to
 * make one unless --paid is passed with a cap.
 *
 * ─── ⚠️  THE CORPUS IS REAL FOOTAGE OF A REAL ATHLETE ──────────────────────────────────────────
 *
 * It is read from disk by PATH and never committed. The same arrangement qa/corpus.ts has with
 * `qa-fixtures/` — .gitignore already covers `probe-out/*`. Nothing derived from it goes into the
 * repo: this script prints CELL NAMES and NUMBERS, never an asset id, never a frame, never a
 * description of what is in one. The `frameAsset` uuids in the results files are hers and are not
 * read.
 *
 * ─── V-3 AND V-4 ARE NOT FREE, WHICH THE PLAN GOT WRONG ────────────────────────────────────────
 *
 * The two remaining questions — whether `marks` is usable frame-to-frame, and whether within-clip
 * identity discriminates at all — run the CHECKS, and every check is a model call: qa/marks.ts
 * makes two `askVision` calls, qa/face.ts one, qa/embed.ts an embedding. At the image stage's
 * measured $0.0212 per inspection that is roughly $0.05 a clip. Cheap, and not $0, so they sit
 * behind --paid and a cap and are nobody's to fire but Adi's.
 *
 * Usage:
 *   npx tsx server/scripts/studioVideoQaCorpus.ts --corpus <dir>            # V-1 + V-2, $0
 *   npx tsx server/scripts/studioVideoQaCorpus.ts --corpus <dir> --json out.json
 */
import { readdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

import {
  driftCurve,
  extractStrip,
  selectFrames,
  type FrameStrip,
} from "../studio/video/frames";
import { probeMedia } from "../studio/video/probe";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : fallback;
};
const flag = (name: string) => argv.includes(`--${name}`);

const CORPUS = arg("corpus", process.env.STUDIO_VIDEO_CORPUS_DIR);

/** How close a reproduction has to be to count as one. */
const TOLERANCE = Number(arg("tolerance", "0.001"));

/** One recorded cell from a bake-off results file. */
interface RecordedCell {
  cell: string;
  mp4: string;
  /** The published drift pair, taken at stamps [0, 2, 4]. */
  drift: number[];
  encodedSeconds: number | null;
}

/** Walk the corpus for results files, and pair each recorded cell with its clip. */
async function findCells(root: string): Promise<RecordedCell[]> {
  const out: RecordedCell[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.name.startsWith("results") || !e.name.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(p, "utf8"));
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed) {
        const c = raw as Record<string, unknown>;
        // A cell is usable here only if it RECORDED a drift pair — that is the baseline being
        // reproduced. A cell that was refused at submission, or predates the measurement, has
        // nothing to compare against and is skipped rather than counted as a pass.
        if (typeof c.cell !== "string" || !Array.isArray(c.drift)) continue;
        const drift = c.drift.filter((n): n is number => typeof n === "number");
        if (!drift.length) continue;
        out.push({
          cell: c.cell,
          mp4: join(dirname(p), `${c.cell}.mp4`),
          drift,
          encodedSeconds:
            typeof c.encodedSeconds === "number" ? c.encodedSeconds : null,
        });
      }
    }
  };
  await walk(root);
  // Deduplicated by clip path: the blind/ directory is COPIES of the bake-off clips (its key.json
  // maps clip-NN back to its cell), and scoring the same file twice would inflate every count.
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.mp4) && seen.add(c.mp4));
}

/**
 * Every clip under the corpus, for V-2.
 *
 * V-1 can only run where a baseline was RECORDED — three cells, because only the V2b harness wrote
 * a drift pair. V-2 needs no baseline at all, just a clip, so it runs over everything. That matters:
 * "the sampler beats a grid" on n=3 is an anecdote, and the corpus has four times that many clips
 * sitting there for nothing.
 *
 * `blind/` is skipped by name. Its twelve files are COPIES of the bake-off cells (its own key.json
 * maps clip-NN back to the cell it came from), and counting a clip twice would inflate every ratio
 * in the summary while looking like more evidence.
 */
async function findClips(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === "blind") continue;
        await walk(join(dir, e.name));
      } else if (e.name.endsWith(".mp4")) {
        out.push(join(dir, e.name));
      }
    }
  };
  await walk(root);
  return out.sort();
}

const fmt = (n: number) => n.toFixed(3);

/** V-1 — does the ported curve reproduce what the harness recorded? */
async function v1(cell: RecordedCell) {
  // The STAMPS plan, not the dense one: the harness took one `-ss` seek per timestamp, and a dense
  // pass picks the nearest decoded frame instead, which is close and not the same. A reproduction
  // has to use the same method or it is measuring two things at once.
  let strip: FrameStrip | null = null;
  try {
    strip = await extractStrip(cell.mp4, {
      kind: "stamps",
      seconds: [0, 2, 4],
    });
    const curve = await driftCurve(strip);
    // The harness returned n-1 values, skipping the base; frames.ts returns n with curve[0] = 0.
    const got = curve.slice(1);
    const want = cell.drift;
    const deltas = want.map((w, i) => Math.abs((got[i] ?? NaN) - w));
    const ok =
      got.length === want.length && deltas.every((d) => d <= TOLERANCE);
    return { cell: cell.cell, want, got, maxDelta: Math.max(...deltas), ok };
  } finally {
    await strip?.dispose();
  }
}

/** V-2 — does the sampler land on the excursion where a fixed grid does not? */
async function v2(mp4: string) {
  const name = mp4
    .split("/")
    .pop()!
    .replace(/\.mp4$/, "");
  let strip: FrameStrip | null = null;
  try {
    const probed = await probeMedia(mp4);
    strip = await extractStrip(mp4, { kind: "fps", fps: 4 });
    const curve = await driftCurve(strip);
    const sample = selectFrames(strip, curve, probed.fps);
    const peak = sample.frames.find((f) => f.role === "peak") ?? null;

    // THE GRID ARM — first / middle / last, the obvious thing, read off the SAME curve so the
    // comparison is about where each one looks and nothing else.
    const nearest = (t: number) => {
      let best = 0;
      for (let i = 0; i < strip!.frames.length; i++) {
        if (
          Math.abs(strip!.frames[i].timeSec - t) <
          Math.abs(strip!.frames[best].timeSec - t)
        )
          best = i;
      }
      return { timeSec: strip!.frames[best].timeSec, drift: curve[best] };
    };
    const grid = [
      nearest(0),
      nearest(strip.durationSec / 2),
      nearest(strip.durationSec),
    ];
    const gridBest = Math.max(...grid.map((g) => g.drift));

    return {
      cell: name,
      scanned: sample.coverage.scanned,
      total: sample.coverage.total,
      motionless: sample.motionless,
      peakTime: peak?.timeSec ?? null,
      peakDrift: peak?.drift ?? null,
      gridTimes: grid.map((g) => g.timeSec),
      gridBest,
      /** How much the adaptive pick beats the best thing a grid would have found. */
      advantage: peak ? Number((peak.drift - gridBest).toFixed(3)) : null,
    };
  } finally {
    await strip?.dispose();
  }
}

async function main() {
  if (!CORPUS) {
    console.error(
      "Point me at the clips: --corpus <dir> (or STUDIO_VIDEO_CORPUS_DIR).\n" +
        "They are real footage and live outside the repo — probe-out/ in a video worktree.",
    );
    process.exit(2);
  }
  if (flag("paid")) {
    // V-3 and V-4 are model calls. They are not implemented here yet and will not be fired by
    // accident: the flag exists so that passing it is an error today rather than a spend tomorrow.
    console.error(
      "--paid is not wired. V-3 (marks specificity) and V-4 (the within-clip identity control) are\n" +
        "model calls at roughly $0.05 a clip, and they need Adi's explicit go and a cap. This script\n" +
        "runs V-1 and V-2 only, and both are $0.",
    );
    process.exit(2);
  }

  const cells = await findCells(CORPUS);

  console.log(`\nCorpus: ${CORPUS}`);
  console.log(`Cells with a recorded drift baseline: ${cells.length}`);
  // No baseline is NOT an error, and it is the common case: only the V2b harness ever wrote a drift
  // pair, so every other corpus has clips to sample and nothing to reproduce. V-2 still runs.
  if (!cells.length)
    console.log("  (no baseline here — V-1 is skipped, V-2 runs on the clips)");
  console.log("");

  if (cells.length)
    console.log(
      "── V-1 · does the ported curve reproduce the harness's numbers? ──",
    );
  const v1Rows = [];
  for (const c of cells) {
    try {
      const r = await v1(c);
      v1Rows.push(r);
      console.log(
        `  ${r.ok ? "✓" : "✗"} ${c.cell.padEnd(18)} recorded [${r.want.map(fmt).join(", ")}]` +
          `  got [${r.got.map(fmt).join(", ")}]  maxΔ ${fmt(r.maxDelta)}`,
      );
    } catch (err) {
      console.log(
        `  ! ${c.cell.padEnd(18)} ${(err as Error).message.slice(0, 90)}`,
      );
    }
  }
  if (v1Rows.length)
    console.log(
      `  → ${v1Rows.filter((r) => r.ok).length}/${v1Rows.length} reproduced within ${TOLERANCE}\n`,
    );

  const clips = await findClips(CORPUS);
  console.log(
    `── V-2 · does the sampler beat a fixed first/middle/last? (${clips.length} clips) ──`,
  );
  const v2Rows = [];
  for (const mp4 of clips) {
    try {
      const r = await v2(mp4);
      v2Rows.push(r);
      console.log(
        `  ${r.cell.padEnd(24)} scanned ${String(r.scanned).padStart(3)}/${String(r.total).padStart(4)}` +
          `  peak ${r.peakTime === null ? "  none " : `${r.peakTime.toFixed(2)}s`} @ ${r.peakDrift === null ? "  -  " : fmt(r.peakDrift)}` +
          `  grid ${fmt(r.gridBest)}  advantage ${r.advantage === null ? "  -  " : fmt(r.advantage)}`,
      );
    } catch (err) {
      console.log(
        `  ! ${mp4.split("/").pop()!.padEnd(24)} ${(err as Error).message.slice(0, 80)}`,
      );
    }
  }
  const beat = v2Rows.filter((r) => (r.advantage ?? 0) > 0).length;
  const tied = v2Rows.filter((r) => (r.advantage ?? 0) === 0).length;
  const lost = v2Rows.filter((r) => (r.advantage ?? 0) < 0).length;
  console.log(
    `  → beat the grid ${beat}/${v2Rows.length} · tied ${tied} · LOST ${lost}\n` +
      `    (a tie means the grid's own last stamp happened to land on the excursion; a LOSS is\n` +
      `     impossible by construction — the grid's frames are in the curve the argmax searches.)\n`,
  );

  const out = arg("json");
  if (out) {
    // Cell names and numbers only. No asset id, no frame, no description of what is in one.
    await writeFile(out, JSON.stringify({ v1: v1Rows, v2: v2Rows }, null, 2));
    console.log(`Written: ${out}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
