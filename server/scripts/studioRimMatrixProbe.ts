/**
 * studioRimMatrixProbe — PR-0 Q4. Deconfound the rim.
 *
 * Sweep 1.3 is the only same-prompt pair in the sweep and it varied TWO things at once:
 *
 *   1.3a  src afc78262 1008x1476   maskEdgePx "0+3"   ARTIFACT — "still weird black line"
 *   1.3b  src 5581e882 4000x6000   maskEdgePx "2+6"   CLEAN
 *
 * The doc says so itself: "Source resolution is confounded (1008 vs 4000), so this isn't
 * conclusive." This runs the 2x2 that separates them:
 *
 *       "change the socks to yellow"  x  {1008, 4000}  x  {band 0+3, band 2+6}
 *
 * ─── THIS HALF RUNS THE REAL PIPELINE ───────────────────────────────────────────────────────────
 *
 * Not the direct router. `runStudioGeneration` — real crop planning, real SAM segmentation, real
 * composite, real `maskEdgePx`. The question here is about OUR geometry, so a reconstruction of the
 * pipeline would be measuring the reconstruction.
 *
 * ⚠️ IT WRITES TO THE LIVE DB. A studio_generation_previews row, a generation_jobs row and
 * media_assets rows per run, all under this athlete's own id, plus GCS objects. Every asset id it
 * creates is appended to docs/probes/probe-cleanup-list.txt for the media-tile cleanup.
 *
 * ─── HOW THE BAND IS FORCED, AND WHY IT NEEDS A KNOB ────────────────────────────────────────────
 *
 *   erode  STUDIO_MASK_ERODE_PX   — already shipped (studio/config.ts maskErodePx)
 *   ramp   STUDIO_MASK_RAMP_PX    — TEMPORARY, added to studio/composite.ts for this probe only
 *
 * The ramp needs one because it is DERIVED from the crop's resample ratio
 * (`maskEdgeUncertaintyFor`), which is a function of source resolution — so on the shipped code
 * band and resolution cannot be varied independently. That is the confound, in one sentence.
 *
 * ⚠️ THE RAMP KNOB HAS BEEN REVERTED — studio/composite.ts is back to its shipped form, so THIS
 * SCRIPT WILL NOT REPRODUCE THE MATRIX AS-IS. `STUDIO_MASK_RAMP_PX` is read by nothing today; set
 * it and every cell falls back to the derived ramp, which means band and resolution move together
 * again and the 2x2 collapses into the same confounded diagonal sweep 1.3 ran.
 *
 * To rerun: re-add the override in `maskEdgeFor` (studio/composite.ts, immediately after `wanted`
 * is computed), run, and revert it again. It is deliberately not kept — it is a measurement
 * instrument, not a feature, and a live env var that silently rewrites mask geometry is a footgun
 * pointed at the composite's only-subtracts guarantee.
 *
 * ─── REGIONS ARE DERIVED ONCE PER SOURCE, THEN REUSED ───────────────────────────────────────────
 *
 * Auto-detection is a model call and its boxes move between runs. Sweep 1.5a/1.5b are byte-identical
 * masks with opposite outcomes, so model variance is live on this path and must not be allowed to
 * ride along inside a band comparison. Detect once per source, freeze the boxes, vary only the band.
 *
 *   npx tsx --require dotenv/config server/scripts/studioRimMatrixProbe.ts
 *   npx tsx --require dotenv/config server/scripts/studioRimMatrixProbe.ts --run
 *   npx tsx --require dotenv/config server/scripts/studioRimMatrixProbe.ts --run --repeats 2
 */
import { appendFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { assembleBrief, type SourceAsset } from "../studio/brief";
import { previewGeneration } from "../studio/preview";
import { savePreview } from "../studio/previewStore";
import { runStudioGeneration } from "../studio/generate";
import { detectRegionsMemoized, probeBytesFor } from "../studio/autoMask";
import { mapRegions, type RegionFraction } from "../studio/geometry";
import { probeImageSize } from "../studio/imageSize";
import { signedUrl } from "../lib/mediaStore";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const CAP_USD = Number(arg("cap", "6"));
const REPEATS = Number(arg("repeats", "1"));
const OUT_DIR = arg("out", "probe-out")!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const CLEANUP_LIST = "docs/probes/probe-cleanup-list.txt";

const PROMPT = "change the socks to yellow";

/**
 * ⚠️ ─── THE MASK FLAGS MUST BE ON OR THIS MATRIX MEASURES NOTHING. ──────────────────────────────
 *
 * Learned by burning 8 calls. With `STUDIO_GARMENT_MASK` off, `masksForCrop` offers no mask, the
 * composite falls back to the rectangle, and the log comes back `mask: ["off","off"]` with
 * `maskEdgePx: []` — an empty band. Every run "succeeded", produced a plausible recolored image,
 * and answered the rim question not at all.
 *
 * The sweep states its flag set in its own header (STUDIO_SERVER_ROUTING, STUDIO_ENABLED,
 * STUDIO_GARMENT_MASK, STUDIO_BACKGROUND_MASK on; STUDIO_OBJECT_MASK off) precisely so a rerun can
 * be configured the same way. This reproduces it in-process rather than depending on .env, so the
 * matrix carries its own configuration and cannot silently run in the wrong one.
 */
function forceSweepFlags(): void {
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_SERVER_ROUTING = "true";
  process.env.STUDIO_GARMENT_MASK = "true";
  process.env.STUDIO_BACKGROUND_MASK = "true";
  process.env.STUDIO_OBJECT_MASK = "false"; // off in the sweep; socks route the garment arm
}

const SOURCES = {
  small: { id: "afc78262-f4ce-4637-bc26-658b5f63ca0e", label: "1008x1476" },
  large: { id: "5581e882-fae1-4255-8951-4c037275e29e", label: "4000x6000" },
};

/** The two bands, named the way `maskEdgePx` reports them. */
const BANDS = [
  { name: "0+3", erode: "0", ramp: "3" },
  { name: "2+6", erode: "2", ramp: "6" },
];

let spentUsd = 0;

// ─── Region derivation, once per source ─────────────────────────────────────────────────────────
//
// Mirrors `resolveSource` in routes/studio.ts — the same detectRegionsMemoized → probeImageSize →
// mapRegions sequence, against the same memo. Replicated rather than imported because that function
// is module-private to the route; if it ever gains a step, this goes stale and the memo key is where
// to look first.

async function readOwnedFrame(
  assetId: string,
): Promise<{ id: string; gcsPath: string }> {
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const [row] = await db
    .select({ id: mediaAssets.id, path: mediaAssets.gcs_path })
    .from(mediaAssets)
    // TENANCY in the predicate.
    .where(
      and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, ATHLETE_ID)),
    )
    .limit(1);
  if (!row?.path)
    throw new Error(`No stored pixels for ${assetId} under this athlete`);
  return { id: row.id, gcsPath: row.path };
}

async function sourceFor(
  assetId: string,
): Promise<{ source: SourceAsset; regions: RegionFraction[] }> {
  const row = await readOwnedFrame(assetId);

  const found = await detectRegionsMemoized(
    { athleteId: ATHLETE_ID, sourceAssetId: row.id, instruction: PROMPT },
    async () => {
      const probe = await probeBytesFor(row.gcsPath);
      return probe
        ? {
            frameBytes: probe.bytes,
            mimeType: probe.mimeType,
            instruction: PROMPT,
          }
        : null;
    },
  );
  if (!found.ok)
    throw new Error(`Detection refused for ${assetId}: ${found.message}`);

  const frame = await probeImageSize(row.gcsPath);
  if (!frame) throw new Error(`Could not measure ${assetId}`);

  const mapped = mapRegions(found.regions, frame);
  if ("message" in mapped)
    throw new Error(`mapRegions refused: ${mapped.message}`);

  return {
    regions: found.regions,
    source: {
      mediaAssetId: row.id,
      ref: row.gcsPath,
      width: frame.width,
      height: frame.height,
      orientation: frame.orientation,
      editRegions: mapped.regions,
    },
  };
}

// ─── One cell ───────────────────────────────────────────────────────────────────────────────────

interface CellResult {
  cell: string;
  srcKey: string;
  band: string;
  repeat: number;
  jobId?: string;
  maskEdgePx?: unknown;
  maskVerdicts?: unknown;
  assetIds?: string[];
  costUsd?: number;
  latencyMs?: number;
  outputs?: string[];
  error?: string;
}

async function runCell(
  srcKey: keyof typeof SOURCES,
  source: SourceAsset,
  band: (typeof BANDS)[number],
  repeat: number,
): Promise<CellResult> {
  const cell = `q4-${srcKey}-${band.name.replace("+", "p")}${REPEATS > 1 ? `-r${repeat}` : ""}`;

  // THE KNOB. Set per cell, immediately before the run, so a crash cannot leave a stale band set
  // for the next one.
  process.env.STUDIO_MASK_ERODE_PX = band.erode;
  process.env.STUDIO_MASK_RAMP_PX = band.ramp;

  const brief = await assembleBrief({
    athleteId: ATHLETE_ID,
    origin: "system",
    objective: "grow-following",
    deliverable: "post",
    mode: "edit",
    source,
    direction: PROMPT,
  });

  const preview = previewGeneration(brief);
  if (preview.status === "blocked" || !preview.plan || !preview.cost) {
    return {
      cell,
      srcKey,
      band: band.name,
      repeat,
      error: `preview blocked: ${preview.blockers.map((b) => `${b.field}:${b.note}`).join(" | ")}`,
    };
  }

  console.log(`\n── ${cell}`);
  console.log(`   src      ${SOURCES[srcKey].id}  ${SOURCES[srcKey].label}`);
  console.log(`   prompt   "${PROMPT}"`);
  console.log(
    `   band     forced erode=${band.erode} ramp=${band.ramp}  (target maskEdgePx "${band.name}")`,
  );
  console.log(
    `   regions  ${source.editRegions.length}  ${source.editRegions.map((r) => `${r.width}x${r.height}`).join(", ")}`,
  );
  console.log(`   quote    $${preview.cost.amountUsd.toFixed(4)}`);

  if (!RUN) {
    console.log("   DRY RUN — no call made.");
    return { cell, srcKey, band: band.name, repeat };
  }

  if (spentUsd + preview.cost.amountUsd > CAP_USD) {
    throw new Error(
      `BUDGET STOP before ${cell}: $${spentUsd.toFixed(4)} spent, cap $${CAP_USD}.`,
    );
  }

  const previewId = await savePreview(ATHLETE_ID, preview);
  const started = Date.now();
  const out = await runStudioGeneration({
    athleteId: ATHLETE_ID,
    brief,
    previewId,
    approvedCostUsd: preview.cost.amountUsd,
  });
  const latencyMs = Date.now() - started;
  spentUsd += preview.cost.amountUsd;

  // Pull the outputs down so they can be verdicted next to the direct-arm results.
  const outputs: string[] = [];
  for (const [i, a] of out.assets.entries()) {
    if (!a.gcsPath) continue;
    const res = await fetch(await signedUrl(a.gcsPath));
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    const p = join(
      OUT_DIR,
      `${cell}${out.assets.length > 1 ? `-${i}` : ""}.jpg`,
    );
    await sharp(buf).jpeg({ quality: 95 }).toFile(p);
    outputs.push(p);
  }

  const assetIds = out.assets.map((a) => a.id);
  // The tag, for the cleanup that is coming for this athlete's tiles.
  await appendFile(
    CLEANUP_LIST,
    assetIds
      .map(
        (id) =>
          `${id}  ${cell}  job=${out.jobId}  ${new Date().toISOString()}\n`,
      )
      .join(""),
    "utf8",
  );

  console.log(`   jobId    ${out.jobId}  spent=${out.spent}`);
  console.log(`   assets   ${assetIds.join(", ")}`);
  console.log(`   outputs  ${outputs.join(", ")}`);
  console.log(`   ${latencyMs}ms`);

  return {
    cell,
    srcKey,
    band: band.name,
    repeat,
    jobId: out.jobId,
    assetIds,
    costUsd: preview.cost.amountUsd,
    latencyMs,
    outputs,
    // maskEdgePx is NOT on the returned object — it exists only on the composite's pino line
    // (studio/composite.ts:1825). `--parse` reads it back out of the teed run log.
  };
}

// ─── Reading the band back out of the log ───────────────────────────────────────────────────────
//
// ⚠️ THE ONE NUMBER THIS PROBE EXISTS TO READ IS NOT RETURNED BY ANYTHING. `maskEdgePx` rides the
// composite's log line and never lands on `CompositeResult`'s callers, so the sweep read it off the
// server's stdout and so does this. In dev the logger runs pino-pretty in a worker thread writing
// straight to fd 1, which is why the script cannot capture it in-process and the run has to be teed:
//
//   npx tsx ... studioRimMatrixProbe.ts --run 2>&1 | tee probe-out/q4-run.log
//   npx tsx ... studioRimMatrixProbe.ts --parse probe-out/q4-run.log
//
// Correlation is by ORDER: each cell prints a `── <cell>` header before it runs, and the composite
// line for that cell is the next one to appear.
async function parseLog(path: string): Promise<void> {
  const { readFile } = await import("fs/promises");
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");

  let current: string | null = null;
  const found: Array<{ cell: string; maskEdgePx: string; mask: string }> = [];

  for (const line of lines) {
    const header = line.match(/──\s+(q4-[\w+-]+)/);
    if (header) {
      current = header[1];
      continue;
    }
    const edge = line.match(/maskEdgePx:\s*(\[[^\]]*\]|"[^"]*")/);
    if (edge && current) {
      const verdict = text
        .slice(text.indexOf(line))
        .match(/mask:\s*(\[[^\]]*\])/);
      found.push({
        cell: current,
        maskEdgePx: edge[1],
        mask: verdict?.[1] ?? "—",
      });
      current = null;
    }
  }

  console.log(
    "\ncell                        maskEdgePx (as composited)   mask verdicts",
  );
  for (const f of found) {
    console.log(`${f.cell.padEnd(26)}  ${f.maskEdgePx.padEnd(27)}  ${f.mask}`);
  }
  console.log("");
}

// ─── Main ───────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parse = arg("parse");
  if (parse) {
    await parseLog(parse);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir("docs/probes", { recursive: true });

  const cells = Object.keys(SOURCES).length * BANDS.length * REPEATS;
  console.log(
    `\nQ4 RIM MATRIX — ${cells} cell(s). ${RUN ? "LIVE — writes rows and spends." : "DRY RUN."}`,
  );
  console.log(
    `Cap $${CAP_USD}.  Band knob: STUDIO_MASK_ERODE_PX + STUDIO_MASK_RAMP_PX (temporary).`,
  );

  forceSweepFlags();
  const { garmentMaskEnabled } = await import("../studio/config");
  // Read back through the real accessor rather than trusting the assignment — the gate is
  // `=== "true"` on a string, and a truthy-looking value that is not that string reads as OFF.
  if (!garmentMaskEnabled()) {
    throw new Error(
      "STUDIO_GARMENT_MASK is not enabled. Without it the composite falls back to the rectangle, " +
        'reports mask "off" and an EMPTY maskEdgePx, and the whole matrix measures nothing. Refusing to spend.',
    );
  }
  console.log(
    "Flags: garment mask ON (sweep parity) — masks will be offered.\n",
  );

  // ⚠️ REGION DERIVATION IS ITSELF A MODEL CALL. `detectRegionsMemoized` spends (~$0.03/source),
  // so a dry run must not reach it — otherwise "DRY RUN" silently bills, which is the one thing the
  // default is for. The plan below is printed from the matrix definition alone.
  if (!RUN) {
    for (const srcKey of Object.keys(SOURCES) as Array<keyof typeof SOURCES>) {
      for (const band of BANDS) {
        for (let r = 1; r <= REPEATS; r++) {
          const cell = `q4-${srcKey}-${band.name.replace("+", "p")}${REPEATS > 1 ? `-r${r}` : ""}`;
          console.log(
            `  ${cell.padEnd(24)} src ${SOURCES[srcKey].label.padEnd(11)} ` +
              `force erode=${band.erode} ramp=${band.ramp} → maskEdgePx "${band.name}"`,
          );
        }
      }
    }
    console.log(`\n  prompt: "${PROMPT}"`);
    console.log(
      "  Regions are derived once per source at --run time and frozen across both bands.",
    );
    console.log(
      "  DRY RUN — no detection, no segmentation, no generation, no rows written.\n",
    );
    return;
  }

  const results: CellResult[] = [];

  for (const srcKey of Object.keys(SOURCES) as Array<keyof typeof SOURCES>) {
    // ONE detection per source, reused across both bands — the band is the only variable.
    const { source } = await sourceFor(SOURCES[srcKey].id);
    console.log(
      `\n${srcKey}: ${source.width}x${source.height}, ${source.editRegions.length} region(s) derived once and frozen`,
    );

    for (const band of BANDS) {
      for (let r = 1; r <= REPEATS; r++) {
        try {
          results.push(await runCell(srcKey, source, band, r));
        } catch (err: any) {
          if (/BUDGET STOP/.test(err?.message ?? "")) throw err;
          console.error(`   FAILED  ${err?.message ?? err}`);
          results.push({
            cell: `q4-${srcKey}-${band.name}`,
            srcKey,
            band: band.name,
            repeat: r,
            error: String(err?.message ?? err),
          });
        }
      }
    }
  }

  delete process.env.STUDIO_MASK_ERODE_PX;
  delete process.env.STUDIO_MASK_RAMP_PX;

  await writeFile(
    join(OUT_DIR, "q4-matrix.json"),
    JSON.stringify(results, null, 2),
  );

  console.log("\n─── MATRIX ────────────────────────────────────────────");
  console.log("cell                        band    maskEdgePx        output");
  for (const r of results) {
    console.log(
      `${r.cell.padEnd(26)}  ${r.band.padEnd(6)}  ${String(JSON.stringify(r.maskEdgePx ?? "—")).padEnd(16)}  ${r.outputs?.[0] ?? r.error ?? "—"}`,
    );
  }
  console.log(`\nTotal spent this invocation: $${spentUsd.toFixed(4)}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  },
);
