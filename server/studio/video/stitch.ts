/**
 * stitch.ts — the entry point V7 calls.
 *
 *   probe every input -> plan the graph -> run one ffmpeg -> probe what we wrote
 *
 * One ffmpeg invocation, no intermediate files: conforming and joining happen in a single
 * filter graph, so heterogeneous clips never round-trip through an extra encode.
 *
 * Deliberately NOT here: job rows, leases, reapers, retries, model calls, network fetches.
 * A stitch is a function call. Concurrency belongs to whoever wires the job type.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";
import { createLogger } from "../../logger";
import { assertLocalPath, planStitch } from "./plan";
import { probeHasAudio, probeMedia } from "./probe";
import type { StitchManifest, StitchRequest } from "./types";

const execFileP = promisify(execFile);
const logger = createLogger("studio-video-stitch");

/** Encoding is roughly realtime-ish at veryfast; this is headroom, not a prediction. */
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_OUTPUT_SEC_MS = 15_000;
const MIN_TIMEOUT_MS = 60_000;

export function defaultTimeoutMs(expectedDurationSec: number): number {
  return Math.max(
    MIN_TIMEOUT_MS,
    TIMEOUT_BASE_MS + expectedDurationSec * TIMEOUT_PER_OUTPUT_SEC_MS,
  );
}

async function assertReadable(path: string, label: string): Promise<void> {
  assertLocalPath(path, label);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (size === 0) throw new Error(`${label} is empty: ${path}`);
}

/**
 * Concatenate clips into one file, conforming them first so sources with different
 * encode params join cleanly. Returns the output path and a manifest describing what
 * went in, what came out, and what normalization was applied to get there.
 */
export async function stitch(request: StitchRequest): Promise<StitchManifest> {
  const { clips, audioBed, outputPath, target } = request;

  if (clips.length === 0) throw new Error("stitch needs at least one clip");
  await Promise.all(
    clips.map((c, i) => assertReadable(c.source, `clips[${i}].source`)),
  );
  if (audioBed) await assertReadable(audioBed.source, "audioBed.source");

  const probes = await Promise.all(clips.map((c) => probeMedia(c.source)));

  if (audioBed && !(await probeHasAudio(audioBed.source))) {
    throw new Error(`audioBed.source has no audio stream: ${audioBed.source}`);
  }

  const plan = planStitch({
    clips,
    probes,
    audioBed,
    outputPath,
    target,
    // quality-scrappy piece 6 — only when the finishing pass asked; absent, the plan it always was.
    ...(request.finishing ? { finishing: request.finishing } : {}),
  });
  const timeoutMs =
    request.timeoutMs ?? defaultTimeoutMs(plan.expectedDurationSec);

  logger.info(
    {
      clips: clips.length,
      expectedDurationSec: plan.expectedDurationSec,
      hasAudio: plan.hasAudio,
      normalized: plan.clips.filter((c) =>
        Object.values(c.normalization).some(Boolean),
      ).length,
    },
    "stitch starting",
  );

  const startedAt = Date.now();
  try {
    await execFileP("ffmpeg", plan.args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err: any) {
    const stderr = String(err?.stderr ?? "").trim();
    const killed = err?.killed ? ` (killed after ${timeoutMs}ms)` : "";
    throw new Error(
      `ffmpeg stitch failed${killed}: ${stderr.slice(-800) || String(err?.message ?? err)}`,
    );
  }
  const durationMs = Date.now() - startedAt;

  const output = await probeMedia(outputPath);
  const sizeBytes = (await stat(outputPath)).size;

  logger.info(
    {
      outputPath,
      expectedDurationSec: plan.expectedDurationSec,
      actualDurationSec: output.durationSec,
      sizeBytes,
      durationMs,
    },
    "stitch complete",
  );

  return {
    outputPath,
    clips: plan.clips,
    audioBed: plan.audioBed,
    expectedDurationSec: plan.expectedDurationSec,
    output: { ...output, sizeBytes },
    ffmpeg: { args: plan.args, filterGraph: plan.filterGraph, durationMs },
  };
}
