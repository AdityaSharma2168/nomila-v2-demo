/**
 * studioSweep2 — sweep #2: the original sweep's prompts through the PRODUCT's native edit path.
 *
 *   npx tsx --require dotenv/config server/scripts/studioSweep2.ts                      # the plan, free
 *   npx tsx --require dotenv/config server/scripts/studioSweep2.ts --run --cap 6        # all of it
 *   npx tsx --require dotenv/config server/scripts/studioSweep2.ts --run --cell 1.5a-r1
 *   npx tsx --require dotenv/config server/scripts/studioSweep2.ts --run --section 4
 *
 * The cells, and why each one is on the list: studioSweep2Plan.ts. The run sheet, the flags and the
 * verdict template: docs/probes/sweep-2-plan.md.
 *
 * ─── THE PLAN IS THE DEFAULT, AND IT TOUCHES NOTHING ────────────────────────────────────────────
 *
 * No database, no storage, no model. It prints every cell, what the classifier makes of it, the size
 * it will be quoted at, and the totals — from the price table, not from a hand-typed figure. Every
 * module that could reach a row or a provider is imported dynamically, inside `--run`.
 *
 * ─── `--run` SPENDS, AND ONLY WHEN EVERY RUN WILL SCORE ITSELF ──────────────────────────────────
 *
 * It refuses to start unless these read true — it checks them, it does not set them:
 *
 *   STUDIO_NATIVE_EDIT      the path under test
 *   STUDIO_CREATIVE_QA      every native output is inspected; sweep #2 is PR Q's calibration event,
 *                           and a run without it produces no verdict records and says nothing
 *   STUDIO_BACKGROUND_MASK  detection only returns a background's subject noun with this on. Without
 *                           it a background request is a whole-frame region with no noun, and the
 *                           unchanged whole-frame gate blocks it — on the native path too
 *
 * ─── WHAT IT RUNS ───────────────────────────────────────────────────────────────────────────────
 *
 * The functions the two routes call, in their order: detection → mapRegions → assembleBrief →
 * withNativeEditIntent → previewGeneration → savePreview → the spend-time re-check →
 * runStudioGeneration. Not the HTTP layer and not auth — server/routes/studio.native.test.ts covers
 * those end to end. A cell that the product would not run native REFUSES here rather than spending
 * on something else: a blocked preview is recorded as the finding it is, and a native cell whose
 * brief carries no frozen intent is never allowed to run masked.
 *
 * ⚠️ WRITES REAL ROWS under this athlete — previews, jobs, assets — and bills the company's GCP
 * account. Every asset id goes to docs/probes/probe-cleanup-list.txt; outputs, source-vs-output
 * sheets and runs.jsonl land in probe-out/sweep2/ (gitignored: photographs of a real person).
 * Detection calls `genai()` directly and never reaches the cost log (the probe memo's standing
 * caveat), so the printed total is router spend plus QA, and detection is on top.
 */
import { appendFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import {
  SWEEP2_BALL,
  SWEEP2_CELLS,
  SWEEP2_SOURCES,
  classifyCell,
  quoteFor,
  sweep2Estimate,
  type Sweep2Cell,
} from "./studioSweep2Plan";

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const CAP_USD = Number(arg("cap", "6"));
const OUT_DIR = arg("out", "probe-out/sweep2")!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const CLEANUP_LIST = "docs/probes/probe-cleanup-list.txt";

const selected = SWEEP2_CELLS.filter(
  (c) =>
    (arg("cell") ? c.id === arg("cell") : true) &&
    (arg("section") ? c.section === arg("section") : true),
);

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────

function printPlan(cells: Sweep2Cell[]): void {
  console.log(`\nSWEEP #2 — ${cells.length} cell(s), athlete ${ATHLETE_ID}\n`);
  for (const c of cells) {
    const src = SWEEP2_SOURCES[c.source];
    const r = classifyCell(c);
    const q = quoteFor(c);
    const route =
      r.initialPath === "ASK"
        ? `ASK (${r.reason})`
        : `${r.initialPath} ${r.steps.map((s) => `${s.op}[${s.targets.join(",")}]`).join(" ")}`;
    console.log(
      `${c.id.padEnd(10)} ${c.kind.padEnd(12)} ${src.prefix} ${`${src.width}x${src.height}`.padEnd(9)} ` +
        `${String(q.size ?? "—").padEnd(7)} $${q.quotedUsd.toFixed(4)}  ${route}`,
    );
    console.log(`${"".padEnd(10)} "${c.sentence}" — ${c.why}`);
  }
  const e = sweep2Estimate(cells);
  console.log(
    `\n${e.spending} spending cell(s): generation quoted $${e.quotedUsd.toFixed(4)} (billed ~$${e.billedUsd.toFixed(4)}, ` +
      `image tokens only) + Creative QA ~$${e.qaUsd.toFixed(2)} ≈ $${(e.quotedUsd + e.qaUsd).toFixed(2)}, ` +
      "plus unlogged detection (cents).",
  );
  console.log(`Cap $${CAP_USD} on generation quotes.`);
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────────

let spentUsd = 0;

function assertBudget(nextUsd: number, cell: string): void {
  if (spentUsd + nextUsd > CAP_USD) {
    throw new Error(
      `BUDGET STOP before ${cell}: $${spentUsd.toFixed(4)} spent, next quotes $${nextUsd.toFixed(4)}, ` +
        `cap is $${CAP_USD}. Raise --cap deliberately or stop here.`,
    );
  }
}

async function assertFlags(): Promise<void> {
  const { nativeEditEnabled, backgroundMaskEnabled } = await import(
    "../studio/config"
  );
  const { creativeQaEnabled } = await import("../studio/qa/record");
  const missing = [
    ["STUDIO_NATIVE_EDIT", nativeEditEnabled()],
    ["STUDIO_CREATIVE_QA", creativeQaEnabled()],
    ["STUDIO_BACKGROUND_MASK", backgroundMaskEnabled()],
  ]
    .filter(([, on]) => !on)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Refusing to spend: ${missing.join(", ")} not on. Sweep #2 measures the native path with every ` +
        "output self-scoring — see the header, and docs/probes/sweep-2-plan.md.",
    );
  }
}

async function logRun(entry: Record<string, unknown>): Promise<void> {
  await appendFile(
    join(OUT_DIR, "runs.jsonl"),
    `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

/** A `media_assets` id prefix → her row. Tenancy in the predicate; ambiguity refused, never guessed. */
async function resolvePrefix(
  prefix: string,
): Promise<{ id: string; path: string }> {
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  const rows = await db
    .select({ id: mediaAssets.id, path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(
        sql`${mediaAssets.id}::text LIKE ${`${prefix}%`}`,
        eq(mediaAssets.athlete_id, ATHLETE_ID),
      ),
    );
  if (rows.length !== 1 || !rows[0].path) {
    throw new Error(
      `${prefix}: ${rows.length} stored assets match under this athlete — refusing to guess`,
    );
  }
  return { id: rows[0].id, path: rows[0].path };
}

/** The output, saved, plus a source-vs-output sheet at one height for the verdict. */
async function saveOutputs(
  cell: Sweep2Cell,
  sourcePath: string,
  outputPath: string,
): Promise<{ file: string; width: number; height: number }> {
  const { signedUrl } = await import("../lib/mediaStore");
  const read = async (p: string) =>
    Buffer.from(await (await fetch(await signedUrl(p))).arrayBuffer());
  const [src, out] = await Promise.all([read(sourcePath), read(outputPath)]);
  const meta = await sharp(out).metadata();
  const file = join(
    OUT_DIR,
    `${cell.id}.${meta.format === "jpeg" ? "jpg" : (meta.format ?? "png")}`,
  );
  await writeFile(file, out);

  const H = 900;
  const [a, b] = await Promise.all([
    sharp(src).rotate().resize({ height: H }).jpeg({ quality: 88 }).toBuffer(),
    sharp(out).resize({ height: H }).jpeg({ quality: 88 }).toBuffer(),
  ]);
  const [wa, wb] = await Promise.all(
    [a, b].map(async (x) => (await sharp(x).metadata()).width ?? 0),
  );
  await sharp({
    create: {
      width: wa + 12 + wb,
      height: H,
      channels: 3,
      background: "#000000",
    },
  })
    .composite([
      { input: a, left: 0, top: 0 },
      { input: b, left: wa + 12, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(join(OUT_DIR, `${cell.id}-sbs.jpg`));
  return { file, width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function runCell(cell: Sweep2Cell): Promise<void> {
  const { assembleBrief } = await import("../studio/brief");
  const { withNativeEditIntent } = await import("../studio/nativeIntent");
  const { readNativeIntent, intentsAgree } = await import(
    "../studio/nativeEdit"
  );
  const { route } = await import("../studio/classify");
  const { previewGeneration } = await import("../studio/preview");
  const { savePreview } = await import("../studio/previewStore");
  const { runStudioGeneration } = await import("../studio/generate");
  const { detectRegionsMemoized, probeBytesFor } = await import(
    "../studio/autoMask"
  );
  const { mapRegions } = await import("../studio/geometry");
  const { probeImageSize } = await import("../studio/imageSize");
  const { readVerdict } = await import("../studio/qa/record");
  const { summarize } = await import("../studio/qa/verdict");

  console.log(`\n── ${cell.id} (${cell.kind}) "${cell.sentence}"`);
  const src = await resolvePrefix(SWEEP2_SOURCES[cell.source].prefix);

  // ─── Build the brief exactly as the preview route would ───────────────────────────────────
  let brief;
  if (cell.kind === "generate") {
    const ball = await resolvePrefix(SWEEP2_BALL.prefix);
    // Her photo as her likeness, the ball through the Object tile. A generate freezes nothing.
    brief = await assembleBrief({
      athleteId: ATHLETE_ID,
      brandId: null,
      origin: "system",
      objective: "grow-following",
      deliverable: "post",
      mode: "generate",
      direction: cell.sentence,
      references: [
        { role: "person", ref: src.path, mediaAssetId: src.id },
        {
          role: "object",
          ref: ball.path,
          mediaAssetId: ball.id,
          label: SWEEP2_BALL.label,
        },
      ],
    });
  } else {
    // Detection BILLS (unlogged) — it is the route's own first spend, and it runs before any quote.
    const found = await detectRegionsMemoized(
      {
        athleteId: ATHLETE_ID,
        sourceAssetId: src.id,
        instruction: cell.sentence,
      },
      async () => {
        const probe = await probeBytesFor(src.path);
        return probe
          ? {
              frameBytes: probe.bytes,
              mimeType: probe.mimeType,
              instruction: cell.sentence,
            }
          : null;
      },
    );
    if (!found.ok) {
      console.log(`   detection refused: ${found.reason} — "${found.message}"`);
      await logRun({
        cell: cell.id,
        outcome: "detection-refused",
        reason: found.reason,
      });
      return;
    }
    const frame = await probeImageSize(src.path);
    if (!frame) throw new Error(`could not measure ${src.id}`);
    const mapped = mapRegions(found.regions, frame);
    if ("message" in mapped)
      throw new Error(`mapRegions refused: ${mapped.message}`);
    const input = {
      athleteId: ATHLETE_ID,
      brandId: null,
      origin: "system" as const,
      objective: "grow-following" as const,
      deliverable: "post" as const,
      mode: "edit" as const,
      source: {
        mediaAssetId: src.id,
        ref: src.path,
        width: frame.width,
        height: frame.height,
        orientation: frame.orientation,
        editRegions: mapped.regions,
      },
      direction: cell.sentence,
    };
    brief = withNativeEditIntent(await assembleBrief(input), input, {
      regions: "derived",
    });
    console.log(
      `   labels   ${mapped.regions.map((r) => JSON.stringify(r.label)).join(", ")}`,
    );
  }

  const preview = previewGeneration(brief);

  // ─── The gate cell: a block is the pass, and nothing may spend ────────────────────────────
  if (cell.kind === "expect-block") {
    const blocked = preview.status === "blocked";
    console.log(
      blocked
        ? `   PASS — blocked at the preview: ${preview.blockers[0]?.note}`
        : "   GATE FAILED — the preview is READY. Not spending; this is a finding, not a cell.",
    );
    await logRun({
      cell: cell.id,
      outcome: blocked ? "blocked-as-expected" : "gate-failed",
    });
    return;
  }
  if (preview.status === "blocked" || !preview.plan || !preview.cost) {
    const why = preview.blockers
      .map((b) => `${b.field}: ${b.note}`)
      .join(" | ");
    console.log(`   BLOCKED at the preview — ${why}`);
    await logRun({
      cell: cell.id,
      outcome: "blocked",
      blockers: preview.blockers,
    });
    return;
  }

  // ─── A native cell must run native, and on the intent it was quoted ───────────────────────
  if (cell.kind === "native") {
    const native = readNativeIntent(brief);
    if (native.kind !== "native") {
      console.log(
        "   REFUSING — no frozen intent on a native cell; this would run masked.",
      );
      await logRun({ cell: cell.id, outcome: "refused-no-intent" });
      return;
    }
    if (
      !intentsAgree(native.intent, route(brief.job.direction.statement, true))
    ) {
      console.log(
        "   REFUSING — the spend-time re-check disagrees with the frozen intent.",
      );
      await logRun({ cell: cell.id, outcome: "refused-recheck" });
      return;
    }
    console.log(
      `   size     ${native.intent.imageSize}   quote $${preview.cost.amountUsd.toFixed(4)}`,
    );
  }
  console.log(`   prompt   ${JSON.stringify(preview.plan.inputs.prompt)}`);

  assertBudget(preview.cost.amountUsd, cell.id);
  const previewId = await savePreview(ATHLETE_ID, preview);
  const started = Date.now();
  const out = await runStudioGeneration({
    athleteId: ATHLETE_ID,
    brief: preview.brief,
    previewId,
    approvedCostUsd: preview.cost.amountUsd,
  });
  spentUsd += preview.cost.amountUsd;

  const asset = out.assets[0];
  if (!asset?.gcsPath) throw new Error("generation returned no stored asset");
  await appendFile(
    CLEANUP_LIST,
    `${asset.id}  sweep2-${cell.id}  job=${out.jobId}  ${new Date().toISOString()}\n`,
    "utf8",
  );
  const saved = await saveOutputs(cell, src.path, asset.gcsPath);
  const verdict = await readVerdict(asset.id, ATHLETE_ID);

  console.log(
    `   job      ${out.jobId}   asset ${asset.id}   ${Date.now() - started}ms`,
  );
  console.log(`   output   ${saved.file}  ${saved.width}x${saved.height}`);
  console.log(
    `   QA       ${verdict ? summarize(verdict) : "no verdict (a generate is never inspected)"}`,
  );
  await logRun({
    cell: cell.id,
    section: cell.section,
    sweep1: cell.sweep1 ?? null,
    source: SWEEP2_SOURCES[cell.source].prefix,
    sentence: cell.sentence,
    kind: cell.kind,
    outcome: "generated",
    jobId: out.jobId,
    assetId: asset.id,
    quotedUsd: preview.cost.amountUsd,
    output: { file: saved.file, width: saved.width, height: saved.height },
    prompt: preview.plan.inputs.prompt,
    qa: verdict ? summarize(verdict) : null,
    verdict: null,
  });
}

async function main(): Promise<void> {
  printPlan(selected);
  if (!RUN) {
    console.log(
      "\nDRY RUN — nothing was read, written or spent. Add --run to spend.\n",
    );
    return;
  }
  await assertFlags();
  await mkdir(OUT_DIR, { recursive: true });
  console.log("\nLIVE — flags on, spending.");
  for (const cell of selected) {
    try {
      await runCell(cell);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/BUDGET STOP/.test(message)) throw err;
      console.error(`   FAILED  ${cell.id}: ${message}`);
      await logRun({ cell: cell.id, outcome: "error", error: message });
    }
  }
  console.log(
    `\nGeneration quoted this invocation: $${spentUsd.toFixed(4)} (QA and detection on top).\n`,
  );
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
