/**
 * replay-frames.ts — Phase A (a) of PR 9.5, $0: one frame at each STORED beat's start and end, per
 * clip, and one contact sheet per clip with the beat index and timestamp burned in. For Adi's eyes
 * against the pre-registered P8 counts (docs/probes/clip-reads.md §3). No model call, no DB write.
 *
 *   npx tsx --require dotenv/config tools/clip-reads/replay-frames.ts <assetId> [<assetId> ...]
 *
 * Reads: media_assets (id, gcs_path, duration, metadata.vision.beats) through DATABASE_URL, the
 * clip's bytes through the media store (GOOGLE_SERVICE_ACCOUNT_JSON). Writes only under
 * probe-out/clip-reads/: <id>.json (the beat list as stored), <id>/beat-NN-{start,end}.jpg, and
 * <id>-sheet.jpg. ffmpeg grabs the frames; sharp draws the labels and tiles the sheet (the Mac
 * ffmpeg has no drawtext — see the V10 captions ledger).
 *
 * ⚠️ ADI RUNS THIS. It needs the .env this session cannot read. It never mutates a row.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../server/db";
import { mediaAssets } from "../../shared/schema";
import { readObject } from "../../server/lib/mediaStore";

const execFileP = promisify(execFile);
const OUT = join(process.cwd(), "probe-out", "clip-reads");
const TILE_W = 320;
const TILE_H = 568; // 9:16 tiles; a landscape frame letterboxes inside
const LABEL_H = 34;

type Beat = { start_s: number; end_s: number; description?: string };

const uuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

async function grab(mp4: string, atSec: number, out: string): Promise<void> {
  await execFileP("ffmpeg", [
    "-y", "-nostdin", "-loglevel", "error",
    "-ss", atSec.toFixed(3), "-i", mp4,
    "-frames:v", "1", "-q:v", "3", out,
  ]);
}

const label = (text: string) =>
  Buffer.from(
    `<svg width="${TILE_W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#0D0B08"/>` +
      `<text x="8" y="23" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700" fill="#fff">${text.replace(/[<>&]/g, "")}</text></svg>`,
  );

async function tile(frame: string, text: string): Promise<Buffer> {
  const pic = await sharp(frame)
    .resize(TILE_W, TILE_H - LABEL_H, { fit: "contain", background: "#111" })
    .toBuffer();
  return sharp({ create: { width: TILE_W, height: TILE_H, channels: 3, background: "#111" } })
    .composite([
      { input: await sharp(label(text)).png().toBuffer(), top: 0, left: 0 },
      { input: pic, top: LABEL_H, left: 0 },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function sheet(tiles: Buffer[], out: string): Promise<void> {
  const cols = Math.min(6, Math.max(1, tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  await sharp({ create: { width: cols * TILE_W, height: rows * TILE_H, channels: 3, background: "#000" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * TILE_W, top: Math.floor(i / cols) * TILE_H })))
    .jpeg({ quality: 88 })
    .toFile(out);
}

async function one(id: string): Promise<void> {
  const [row] = await db
    .select({ path: mediaAssets.gcs_path, metadata: mediaAssets.metadata, precise: mediaAssets.duration_seconds_precise, whole: mediaAssets.duration_seconds })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id))
    .limit(1);
  if (!row?.path) throw new Error(`${id}: no such row, or no gcs_path`);
  const beats = ((row.metadata as { vision?: { beats?: unknown } } | null)?.vision?.beats ?? null) as Beat[] | null;
  if (!Array.isArray(beats)) throw new Error(`${id}: no stored beats — this clip is unread; replay (b) is the route`);
  const short = id.slice(0, 8);
  const dir = join(OUT, short);
  await mkdir(dir, { recursive: true });
  await writeFile(join(OUT, `${short}.json`), JSON.stringify({ assetId: id, durationS: row.precise ?? row.whole, beats }, null, 2));

  const obj = await readObject(row.path, 200 * 1024 * 1024);
  if (!obj) throw new Error(`${id}: could not read ${row.path}`);
  const mp4 = join(dir, "clip.mp4");
  await writeFile(mp4, obj.buf);

  const tiles: Buffer[] = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    for (const [edge, at] of [["start", b.start_s], ["end", Math.max(b.start_s, b.end_s - 0.05)]] as const) {
      const frame = join(dir, `beat-${String(i).padStart(2, "0")}-${edge}.jpg`);
      await grab(mp4, at, frame);
      tiles.push(await tile(frame, `[${i}] ${edge} ${Number(at).toFixed(2)}s`));
    }
  }
  await sheet(tiles, join(OUT, `${short}-sheet.jpg`));
  await unlink(mp4);
  console.log(`${short}: ${beats.length} beats → ${tiles.length} frames, sheet ${join(OUT, `${short}-sheet.jpg`)}`);
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter(uuid);
  if (ids.length === 0) {
    console.error("usage: replay-frames.ts <assetId> [<assetId> ...]  (full uuids)");
    process.exit(2);
  }
  await mkdir(OUT, { recursive: true });
  for (const id of ids) await one(id);
  process.exit(0);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
