/**
 * shots.ts — shot boundaries in a clip, found by ffmpeg's scene score and stored beside the Flash beats (quality-scrappy
 * piece 3, docs/probes/quality-scrappy.md, ADI-QS-GO). Behind STUDIO_SHOT_DETECT (under the master). $0: local
 * ffmpeg, no model, no transcript, no new dependency.
 *
 *   the clip ──ffmpeg select='gt(scene,T)',showinfo──▶ the pts of every frame whose scene score beat T ──▶ boundaries
 *
 * ─── WHERE IT RUNS ─────────────────────────────────────────────────────────────────────────────────────
 *
 * At the clip read (enrich/videoEnrichment.ts), on the bytes that read already downloaded, after its vision write
 * succeeded — so a clip that has beats gets its boundaries in the same pass, and nothing is downloaded twice. A read
 * that failed writes no shots. Her existing library is backfilled by server/scripts/studioShotsBackfill.ts (dry run
 * by default; Adi runs the write).
 *
 * ─── WHERE IT IS STORED ────────────────────────────────────────────────────────────────────────────────
 *
 * `media_assets.metadata.shots` — a SIBLING of `vision`, not inside it: the clip read rewrites `vision` whole
 * (videoEnrichment.ts `writeVision`), and a key inside it would be erased by the next read. One key, jsonb_set, tenancy
 * in the predicate, no DDL (the same namespace-by-producer convention qa/record.ts describes).
 *
 * ─── THE THRESHOLD ─────────────────────────────────────────────────────────────────────────────────────
 *
 * `SHOT_SCENE_THRESHOLD`. ffmpeg's scene score is the frame-to-frame change normalized to [0, 1]; the value is chosen
 * against exhibit A (d076a790, owner-verified beats) and recorded in the ledger with how it compares to that clip's
 * Flash beats.
 */
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { createLogger } from "../../logger";
import { assertLocalPath } from "./plan";
import { probeMedia } from "./probe";
import type { ShotRecord } from "./shotSnap";

const execFileP = promisify(execFile);
const logger = createLogger("studio-video-shots");

/** The scene score a frame must beat to open a new shot. See the header and the ledger. */
export const SHOT_SCENE_THRESHOLD = 0.3;

/** Two boundaries closer than this are one cut (a dissolve scores on consecutive frames). */
const MERGE_WITHIN_SEC = 0.25;

const DETECT_TIMEOUT_MS = 180_000;

/** The pts of each frame the scene filter selected, out of showinfo's log. */
export function boundariesFrom(stderr: string): number[] {
  const times = [...stderr.matchAll(/showinfo[^\n]*?\bpts_time:\s*([\d.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of times)
    if (!merged.length || t - merged[merged.length - 1] > MERGE_WITHIN_SEC)
      merged.push(t);
  return merged.map((t) => Math.round(t * 1000) / 1000);
}

/** Detect the boundaries in one local file. Throws on a file ffmpeg cannot read — callers decide what that means. */
export async function detectShots(
  path: string,
  threshold = SHOT_SCENE_THRESHOLD,
): Promise<ShotRecord> {
  assertLocalPath(path, "shot detection source");
  const { durationSec } = await probeMedia(path);
  const { stderr } = await execFileP(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ],
    { timeout: DETECT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  );
  return {
    version: 1,
    method: "ffmpeg-scene",
    threshold,
    boundaries: boundariesFrom(stderr).filter((t) => t < durationSec),
    durationSec: Math.round(durationSec * 1000) / 1000,
    at: new Date().toISOString(),
  };
}

/** The same, on bytes in hand, through a private temp file that is removed whatever happens. */
export async function detectShotsBytes(
  bytes: Buffer,
  threshold = SHOT_SCENE_THRESHOLD,
): Promise<ShotRecord> {
  const path = join(tmpdir(), `studio-shots-${randomUUID()}.mp4`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    return await detectShots(path, threshold);
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/** Write `metadata.shots` — one key, jsonb_set, her row only. Never throws. */
export async function writeShots(
  assetId: string,
  athleteId: string,
  record: ShotRecord,
): Promise<boolean> {
  try {
    const res = await db.execute(sql`
      UPDATE media_assets
         SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{shots}', ${JSON.stringify(record)}::jsonb),
             metadata_updated_at = now()
       WHERE id = ${assetId} AND athlete_id = ${athleteId}
      RETURNING id`);
    const rows =
      (res as unknown as { rows?: unknown[] }).rows ??
      (res as unknown as unknown[]);
    logger.info(
      {
        assetId,
        boundaries: record.boundaries.length,
        threshold: record.threshold,
        written: rows.length > 0,
      },
      "shot boundaries recorded",
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "shot boundaries could not be written",
    );
    return false;
  }
}
