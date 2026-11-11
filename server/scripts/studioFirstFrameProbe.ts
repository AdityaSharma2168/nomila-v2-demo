/**
 * studioFirstFrameProbe.ts — does a first frame in the clip's shape hold her better? A/B, PRODUCT PATH.
 *
 * Design and dated predictions: docs/probes/video-first-frame-crop-probe.md. Read that first; this
 * file is only the instrument.
 *
 * ─── WHAT MAKES THIS THE PRODUCT PATH AND NOT A HARNESS PATH ───────────────────────────────────
 *
 * Every cell goes `assembleBrief → previewGeneration → savePreview → runStudioGeneration →
 * videoTick`. That is the route's own chain with the HTTP layer removed — the frozen brief, the
 * approval claim, the job row, the queue, the runner, `personReference`'s rotate + 2048 downscale,
 * and `frameForClip`. The ONLY thing a cell changes is `STUDIO_VIDEO_FRAME_CROP`, which is the
 * switch the runner itself reads. Nothing here builds a request body.
 *
 * ─── SAFETY ────────────────────────────────────────────────────────────────────────────────────
 *
 *   • DRY RUN IS THE DEFAULT and writes NOTHING to the database: it assembles, previews, prints the
 *     quote and the compiled prompt, and writes the frame that WOULD leave to disk.
 *   • `--run` is the only thing that spends, and it requires `--cap`. The cap is checked BEFORE each
 *     cell against the running total of QUOTES — counted before anything that can throw.
 *   • ONE ATHLETE. Every asset is read `WHERE athlete_id = $athlete AND id = $asset`; an id that is
 *     not hers is a refusal, not an empty result.
 *   • THE BYTES THAT LEFT are captured at the wire — `globalThis.fetch` is wrapped and the first
 *     frame is lifted out of the `:predictLongRunning` body Vertex was actually sent. A cell with no
 *     such file is VOID: it means this process did not submit it, whatever the job row says.
 *   • A clip that is not 8s ± 0.5 is VOID (the duration hole, fixed in de8826f — asserted, not
 *     assumed). VOID cells still count their spend, and the run stops.
 *   • `--run` writes real `studio_generation_previews`, `generation_jobs` and `media_assets` rows
 *     under her athlete id, exactly as the app would.
 *   • No name, handle, path or signed url is printed or written. Asset ids only.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   ⚠️ FROM A WORKTREE, POINT DOTENV AT THE MAIN CHECKOUT. `dotenv/config` reads `.env` from the
 *   current directory and a worktree has none, so the first thing to fail is `server/db` refusing
 *   to load. Prefix every line below with:
 *
 *       DOTENV_CONFIG_PATH=/Users/adi/nomila-v2/.env
 *
 *   npx tsx --require dotenv/config server/scripts/studioFirstFrameProbe.ts --dump
 *   npx tsx --require dotenv/config server/scripts/studioFirstFrameProbe.ts --f1 <id> --f2 <id>
 *   npx tsx --require dotenv/config server/scripts/studioFirstFrameProbe.ts --f1 <id> --f2 <id> \
 *       --run --cap 6.50
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { assembleBrief, type JobReference } from "../studio/brief";
import { previewGeneration } from "../studio/preview";
import { savePreview } from "../studio/previewStore";
import {
  resolveStoredReference,
  runStudioGeneration,
} from "../studio/generate";
import { assetsForJob } from "../studio/jobs";
import { videoTick } from "../studio/videoRunner";
import { frameForClip } from "../studio/video/firstFrame";
import { extractStrip } from "../studio/video/frames";
import { readObject } from "../lib/mediaStore";

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : fallback;
};
const flag = (name: string) => argv.includes(`--${name}`);

const RUN = flag("run");
const DUMP = flag("dump");
const CAP_USD = Number(arg("cap", "0"));
const OUT_DIR = arg("out", "probe-out/first-frame-crop")!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const F1 = arg("f1");
const F2 = arg("f2");
const ONLY_CELL = arg("cell");
const SECONDS = 8;
const ASPECT = "9:16";
/** How long one cell may poll before it is called deferred and the run stops. */
const CELL_TIMEOUT_MS = 12 * 60_000;

/**
 * ONE sentence, every cell. A continuation of the pose rather than a state change: a static beat
 * cannot disagree with its frame, which is what voided V2's easy cell.
 */
const DIRECTION =
  "She holds her pose and looks into the camera, breathing, with a small natural shift of weight.";

interface Cell {
  id: string;
  frame: "F1" | "F2";
  assetId: string;
  crop: boolean;
}

const cellsFor = (f1: string, f2: string): Cell[] =>
  [
    { id: "F1-A", frame: "F1" as const, assetId: f1, crop: false },
    { id: "F1-B", frame: "F1" as const, assetId: f1, crop: true },
    { id: "F2-A", frame: "F2" as const, assetId: f2, crop: false },
    { id: "F2-B", frame: "F2" as const, assetId: f2, crop: true },
  ].filter((c) => !ONLY_CELL || c.id === ONLY_CELL);

// ─── her assets, and only hers ──────────────────────────────────────────────────────────────────

async function ownedImage(assetId: string) {
  const [row] = await db
    .select({
      id: mediaAssets.id,
      gcs_path: mediaAssets.gcs_path,
      media_type: mediaAssets.media_type,
    })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.athlete_id, ATHLETE_ID), eq(mediaAssets.id, assetId)),
    );
  if (!row?.gcs_path || row.media_type !== "IMAGE")
    throw new Error(`asset ${assetId} is not an image of this athlete's`);
  return row;
}

const personRef = async (assetId: string): Promise<JobReference> => {
  const row = await ownedImage(assetId);
  return { role: "person", ref: row.gcs_path!, mediaAssetId: row.id };
};

// ─── the wire tap ───────────────────────────────────────────────────────────────────────────────

/** Set by `runCell` around its tick; the tap writes the frame Vertex was sent to this path. */
let tapTarget: string | null = null;
let tapped = 0;

function installWireTap() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      tapTarget &&
      url.includes(":predictLongRunning") &&
      typeof init?.body === "string"
    ) {
      const b64 = JSON.parse(init.body)?.instances?.[0]?.image
        ?.bytesBase64Encoded;
      if (typeof b64 === "string") {
        // Synchronous-enough: awaited before the request leaves, so a crash after this line still
        // leaves the evidence on disk.
        await writeFile(tapTarget, Buffer.from(b64, "base64"));
        tapped++;
      }
    }
    return real(input, init);
  }) as typeof fetch;
}

// ─── one cell ───────────────────────────────────────────────────────────────────────────────────

async function briefFor(cell: Cell) {
  return assembleBrief({
    athleteId: ATHLETE_ID,
    brandId: null,
    origin: "system",
    objective: "grow-following",
    deliverable: "clip",
    mode: "generate",
    direction: DIRECTION,
    references: [await personRef(cell.assetId)],
    durationSeconds: SECONDS,
  });
}

const dims = async (bytes: Buffer) => {
  const m = await sharp(bytes).metadata();
  return `${m.width}x${m.height}`;
};

async function dryCell(cell: Cell): Promise<number> {
  const brief = await briefFor(cell);
  const preview = previewGeneration(brief);
  if (preview.status === "blocked" || !preview.plan || !preview.cost)
    throw new Error(
      `${cell.id}: blocked — ${preview.blockers.map((b) => b.note).join(" | ")}`,
    );

  const dir = join(OUT_DIR, cell.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt.txt"), preview.plan.inputs.prompt);

  // The frame that WOULD leave: the same two calls the runner makes, in the same order.
  const resolved = await Promise.all(
    preview.references.map((r) => resolveStoredReference(r, brief)),
  );
  const framed = cell.crop
    ? (await frameForClip(resolved, ASPECT)).references
    : resolved;
  const first = framed[0];
  if (first?.kind === "bytes")
    await writeFile(join(dir, "would-send.jpg"), first.bytes);

  console.log(
    `  ${cell.id}  ${preview.plan.model}  ${preview.plan.inputs.durationSeconds}s  ` +
      `quote $${preview.cost.amountUsd.toFixed(4)}  frame ${first?.kind === "bytes" ? await dims(first.bytes) : "URL (uncropped fallback)"}`,
  );
  return preview.cost.amountUsd;
}

let spent = 0;

async function runCell(cell: Cell) {
  const brief = await briefFor(cell);
  const preview = previewGeneration(brief);
  if (preview.status === "blocked" || !preview.plan || !preview.cost)
    throw new Error(
      `${cell.id}: blocked — ${preview.blockers.map((b) => b.note).join(" | ")}`,
    );
  const quote = preview.cost.amountUsd;
  if (spent + quote > CAP_USD)
    throw new Error(
      `${cell.id}: $${(spent + quote).toFixed(4)} would pass --cap $${CAP_USD.toFixed(2)}. Stopping.`,
    );

  const dir = join(OUT_DIR, cell.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt.txt"), preview.plan.inputs.prompt);

  // The switch the runner reads. Set per cell, and read back below so the record says what was set.
  if (cell.crop) delete process.env.STUDIO_VIDEO_FRAME_CROP;
  else process.env.STUDIO_VIDEO_FRAME_CROP = "false";

  const previewId = await savePreview(ATHLETE_ID, preview);
  // ⚠️ COUNTED BEFORE ANYTHING THAT CAN THROW. From here the approval can be claimed and the
  // provider paid; a failure after this line is a recorded loss, never a silent retry.
  spent += quote;
  const out = await runStudioGeneration(
    {
      athleteId: ATHLETE_ID,
      brief: preview.brief,
      previewId,
      approvedCostUsd: quote,
    },
    {},
  );

  tapTarget = join(dir, "sent.jpg");
  const before = tapped;
  const started = Date.now();
  let done = false;
  while (!done && Date.now() - started < CELL_TIMEOUT_MS) {
    const tick = await videoTick(1);
    done = tick.succeeded + tick.failed > 0;
    if (!done) await new Promise((r) => setTimeout(r, 5000));
  }
  tapTarget = null;

  const record: Record<string, unknown> = {
    cell: cell.id,
    assetId: cell.assetId,
    cropSwitch: process.env.STUDIO_VIDEO_FRAME_CROP ?? "(default on)",
    jobId: out.jobId,
    model: preview.plan.model,
    quoteUsd: quote,
    secondsAsked: preview.plan.inputs.durationSeconds,
  };

  const voidCell = async (why: string): Promise<never> => {
    await writeFile(
      join(dir, "record.json"),
      JSON.stringify({ ...record, void: why }, null, 2),
    );
    throw new Error(
      `${cell.id} is VOID — ${why}. Spend so far $${spent.toFixed(4)}. Stopping.`,
    );
  };

  if (tapped === before)
    await voidCell("this process never sent a first frame for it");
  if (!done)
    await voidCell(
      "still running at the cell timeout (the job is not lost; the row keeps its operation)",
    );

  const [asset] = await assetsForJob(out.jobId, ATHLETE_ID);
  if (!asset?.gcs_path) await voidCell("the job closed with no asset");
  const clip = await readObject(asset.gcs_path!, 200 * 1024 * 1024);
  if (!clip) await voidCell("the clip could not be read back");
  const clipPath = join(dir, "clip.mp4");
  await writeFile(clipPath, clip!.buf);

  const strip = await extractStrip(clipPath, {
    kind: "stamps",
    seconds: [0, 0.25, 0.5, 0.75, 0.98].map((f) => +(f * SECONDS).toFixed(2)),
  });
  try {
    record.durationSec = strip.durationSec;
    record.sentFrame = await dims(
      await sharp(join(dir, "sent.jpg")).toBuffer(),
    );
    for (const [i, f] of strip.frames.entries())
      await sharp(f.path).toFile(join(dir, `frame-${i}.jpg`));
    record.frames = strip.frames.length;
  } finally {
    await strip.dispose();
  }
  if (Math.abs(strip.durationSec - SECONDS) > 0.5)
    await voidCell(
      `the clip is ${strip.durationSec.toFixed(2)}s, not ${SECONDS}s`,
    );

  await writeFile(join(dir, "record.json"), JSON.stringify(record, null, 2));
  console.log(
    `  ${cell.id}  done  job ${out.jobId}  sent ${record.sentFrame}  ${strip.durationSec.toFixed(2)}s`,
  );
}

// ─── --dump: look before choosing ───────────────────────────────────────────────────────────────

async function dump() {
  const rows = await db
    .select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, ATHLETE_ID),
        eq(mediaAssets.media_type, "IMAGE"),
        eq(mediaAssets.origin, "upload"),
      ),
    )
    .orderBy(desc(mediaAssets.created_at))
    .limit(40);
  const dir = join(OUT_DIR, "dump");
  await mkdir(dir, { recursive: true });
  for (const r of rows) {
    if (!r.gcs_path) continue;
    const obj = await readObject(r.gcs_path);
    if (!obj) continue;
    const thumb = await sharp(obj.buf)
      .rotate()
      .resize(540, 960, { fit: "inside" })
      .jpeg({ quality: 80 })
      .toBuffer();
    await writeFile(join(dir, `${r.id}.jpg`), thumb);
  }
  console.log(
    `  ${rows.length} of her uploads written to ${dir} — ids are the filenames. Pick --f1 and --f2 BY EYE.`,
  );
}

async function main() {
  if (DUMP) {
    if (RUN)
      throw new Error(
        "--dump spends nothing and is a different job from --run; drop one.",
      );
    return dump();
  }
  if (!F1 || !F2)
    throw new Error(
      "--f1 <assetId> and --f2 <assetId> are required. Use --dump to choose them.",
    );
  const cells = cellsFor(F1, F2);

  if (!RUN) {
    console.log(
      "DRY RUN — nothing is written to the database and nothing is spent.",
    );
    let total = 0;
    for (const c of cells) total += await dryCell(c);
    console.log(
      `  quoted total $${total.toFixed(4)}   to run:  --run --cap ${(Math.ceil(total * 100) / 100 + 0.1).toFixed(2)}`,
    );
    return;
  }

  if (!(CAP_USD > 0))
    throw new Error(
      "--run requires --cap <usd>. Refusing to spend without a ceiling.",
    );
  if (process.env.STUDIO_VIDEO_ENABLED !== "true")
    throw new Error(
      "STUDIO_VIDEO_ENABLED=true must be set in THIS process's environment for a clip to run.",
    );
  installWireTap();
  for (const c of cells) await runCell(c);
  console.log(`  all cells done. Quoted spend $${spent.toFixed(4)}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
