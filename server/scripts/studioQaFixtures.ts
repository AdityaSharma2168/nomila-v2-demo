/**
 * studioQaFixtures — assemble PR Q's labeled calibration corpus onto disk. READ-ONLY.
 *
 *   npx tsx --require dotenv/config server/scripts/studioQaFixtures.ts           # plan, no network
 *   npx tsx --require dotenv/config server/scripts/studioQaFixtures.ts --fetch   # download
 *
 * ─── ⚠️  WHAT THIS SCRIPT DOES AND DOES NOT DO ─────────────────────────────────────────────────
 *
 * Every other file in `server/scripts/` should be assumed to mutate real rows or spend real money.
 * This one does neither, and the claim is worth being able to check by reading it:
 *
 *   IT ISSUES  SELECTs against media_assets and generation_jobs, and GETs on GCS objects.
 *   IT NEVER   INSERTs, UPDATEs, DELETEs, runs DDL, calls a model, or writes to GCS. There is no
 *              drizzle mutation helper imported anywhere in this file, deliberately — grep it.
 *
 * Spend: **$0.00.** No provider is contacted. The only cost is egress on ~35 objects.
 *
 * ─── TENANCY, AND WHY IT IS IN THE PREDICATE ───────────────────────────────────────────────────
 *
 * Every lookup is `id LIKE prefix% AND athlete_id = <one athlete>`, with the athlete in the WHERE
 * clause rather than asserted afterwards — the same shape `studioModelNativeProbe.resolveRef` uses.
 * The ids in `labeledSet.ts` are 8-char PREFIXES as the sweep printed them, so a prefix that
 * matched two rows would silently pick one. It refuses instead: 0 matches and >1 match are both
 * hard errors, never a "best" row.
 *
 * ─── ⚠️  THE FIXTURES ARE PHOTOGRAPHS OF A REAL PERSON ─────────────────────────────────────────
 *
 * They are gitignored (`qa-fixtures/*`, mirroring `probe-out/*`) and they must stay that way. Do
 * not commit them, do not paste them into a test fixture, do not attach them to a PR. The MANIFEST
 * is committable — it holds asset ids, dimensions, byte counts and digests, and no pixels.
 *
 * Bytes are stored EXACTLY as GCS returns them, un-normalized. Orientation is resolved at
 * comparison time, not at cache time: `sharp().rotate()` on ingest would bake an EXIF decision into
 * the corpus and the checks would then be measured against a preprocessing step instead of against
 * what the pipeline actually holds. Two of these sources carry orientation 8.
 */
import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

import {
  IDENTITY_REFERENCES,
  LABELED_SET,
  SOURCE_IDS,
  type LabeledOutput,
} from "../studio/qa/labeledSet";

/**
 * The user's own athlete — the one every sweep and probe row was produced under. Every query is
 * scoped to it, in the predicate; nothing here reads another athlete's lane.
 */
const ATHLETE =
  process.env.STUDIO_QA_ATHLETE_ID ?? "3811cedd-ec59-44b0-b613-b39d03f9d5ca";

/** Where the corpus lands. Gitignored, like probe-out/. */
const ROOT = process.env.STUDIO_QA_FIXTURE_DIR ?? "qa-fixtures";

const FETCH = process.argv.includes("--fetch");

interface FetchedAsset {
  /** The 8-char prefix as the source documents print it. */
  shortId: string;
  /** Resolved, and proven unique under this athlete. */
  assetId: string;
  gcsPath: string;
  localPath: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  /** Which id space the document's 8-char prefix turned out to name. See resolveShortId. */
  via: IdKind;
}

/**
 * One short id → one asset row, or an error.
 *
 * ─── ⚠️  THE DOCUMENTS PRINT THREE DIFFERENT KINDS OF ID AND LABEL NONE OF THEM ────────────────
 *
 * Measured against the live table, 2026-09-09. All three appear in the sweep and the probe memo as
 * bare 8-char hex, and nothing in either document distinguishes them:
 *
 *   `job`    The sweep's OUTPUT column is a `generation_jobs.id`, NOT an asset id. Every one of the
 *            nineteen resolves as a job and as nothing else — `media_assets` has no row with any of
 *            those prefixes, table-wide. So "2.4a 684531fd" names the job; the picture Adi looked at
 *            is asset 884d6456, which that job produced. Verified by cross-checking each job's
 *            `source_asset_id` and its asset's dimensions against what the sweep printed beside it
 *            (684531fd → src 517ed082, 1056x1408 — exactly as documented).
 *   `asset`  The sweep's `src` column IS a `media_assets.id`. Different column, different id space,
 *            same eight characters of hex on the same line.
 *   `object` The probe's frames are named by their GCS OBJECT (`uploads/f757678b-….png`), which is
 *            not a row id at all. `f757678b` matches nothing in either table.
 *
 * A job is required to have produced EXACTLY ONE asset here. Zero means the job failed or its output
 * was deleted; more than one means the cell is a multi-asset job and "the output" is ambiguous —
 * both are refused rather than resolved, because picking the first would silently calibrate a
 * threshold against a picture nobody verdicted.
 *
 * Ambiguity is refused at every step. An 8-char prefix collision is ~1-in-4-billion per pair, but
 * "the sweep and I disagree about which image this is" is not a failure anyone would notice
 * downstream, and a wrong fixture recalibrates a threshold against the wrong picture in silence.
 */
type IdKind = "asset" | "job" | "object";

async function resolveShortId(shortId: string): Promise<{
  assetId: string;
  gcsPath: string;
  width: number | null;
  height: number | null;
  via: IdKind;
}> {
  const { db } = await import("../db");
  const { generationJobs, mediaAssets } = await import("../../shared/schema");
  const { and, eq, sql } = await import("drizzle-orm");

  const cols = {
    id: mediaAssets.id,
    path: mediaAssets.gcs_path,
    width: mediaAssets.width,
    height: mediaAssets.height,
  };
  const mine = eq(mediaAssets.athlete_id, ATHLETE);

  const done = (
    rows: {
      id: string;
      path: string | null;
      width: number | null;
      height: number | null;
    }[],
    via: IdKind,
  ) => {
    if (rows.length > 1)
      throw new Error(
        `${shortId}: ${rows.length} assets match as ${via} — ambiguous, refusing to guess`,
      );
    if (!rows[0].path)
      throw new Error(
        `${shortId}: ${via} row has no stored pixels (gcs_path is null)`,
      );
    return {
      assetId: rows[0].id,
      gcsPath: rows[0].path,
      width: rows[0].width,
      height: rows[0].height,
      via,
    };
  };

  // 1. An asset id — what the `src` column holds.
  const asAsset = await db
    .select(cols)
    .from(mediaAssets)
    .where(and(sql`${mediaAssets.id}::text LIKE ${shortId + "%"}`, mine))
    .limit(5);
  if (asAsset.length) return done(asAsset, "asset");

  // 2. A job id — what the sweep's output column holds. Its assets are the pictures.
  const jobs = await db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        sql`${generationJobs.id}::text LIKE ${shortId + "%"}`,
        eq(generationJobs.athlete_id, ATHLETE),
      ),
    )
    .limit(5);
  if (jobs.length > 1)
    throw new Error(
      `${shortId}: ${jobs.length} jobs match this prefix — ambiguous, refusing to guess`,
    );
  if (jobs.length === 1) {
    const produced = await db
      .select(cols)
      .from(mediaAssets)
      .where(and(eq(mediaAssets.generation_job_id, jobs[0].id), mine))
      .limit(5);
    if (produced.length === 0)
      throw new Error(
        `${shortId}: job exists but produced no asset (failed, or its output was deleted)`,
      );
    return done(produced, "job");
  }

  // 3. A GCS object name — what the probe's frame references hold.
  const asObject = await db
    .select(cols)
    .from(mediaAssets)
    .where(and(sql`${mediaAssets.gcs_path} LIKE ${"%" + shortId + "%"}`, mine))
    .limit(5);
  if (asObject.length) return done(asObject, "object");

  throw new Error(
    `${shortId}: matches no asset id, job id or object path under this athlete`,
  );
}

/**
 * Download one object to the corpus. Bytes verbatim — see the header on why nothing is normalized.
 *
 * IDEMPOTENT: a file already at the destination is adopted, not re-downloaded. Three of the sources
 * arrive by hand from `probe-out/sources/` and two of them are 4000x6000 (~25MB), so a re-run that
 * re-pulled everything would move a few hundred MB to prove something it already knows. The digest
 * is still computed from the local bytes, so an adopted file is recorded on the same terms as a
 * fetched one and a corrupted cache is still visible in the manifest.
 */
async function fetchAsset(
  shortId: string,
  kind: "output" | "source",
): Promise<FetchedAsset & { adopted: boolean }> {
  const { signedUrl } = await import("../lib/mediaStore");
  const { assetId, gcsPath, width, height, via } =
    await resolveShortId(shortId);

  const ext = gcsPath.split(".").pop()?.toLowerCase() ?? "jpg";
  const localPath = join(
    ROOT,
    kind === "source" ? "sources" : "outputs",
    `${shortId}.${ext}`,
  );

  let buf: Buffer;
  let adopted = false;
  try {
    buf = await readFile(localPath);
    adopted = true;
  } catch {
    const res = await fetch(await signedUrl(gcsPath));
    if (!res.ok) throw new Error(`${shortId}: fetch failed ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, buf);
  }

  return {
    shortId,
    assetId,
    gcsPath,
    localPath,
    bytes: buf.length,
    width,
    height,
    sha256: createHash("sha256").update(buf).digest("hex").slice(0, 16),
    via,
    adopted,
  };
}

/** Every id the corpus needs, deduped, tagged by role. Sources and outputs land in separate dirs. */
function wanted(): { shortId: string; kind: "output" | "source" }[] {
  const seen = new Map<string, "output" | "source">();
  for (const o of LABELED_SET) {
    if (o.outputId && !seen.has(o.outputId)) seen.set(o.outputId, "output");
  }
  for (const s of SOURCE_IDS) if (!seen.has(s)) seen.set(s, "source");
  // The tier-2 boundary photos. Several are already sources; the Map dedupes them.
  for (const r of IDENTITY_REFERENCES)
    if (!seen.has(r.assetId)) seen.set(r.assetId, "source");
  return [...seen].map(([shortId, kind]) => ({ shortId, kind }));
}

/** What the corpus already has on disk and needs no network for. */
function onDisk(): LabeledOutput[] {
  return LABELED_SET.filter((o) => o.outputFile);
}

async function main() {
  const todo = wanted();
  const local = onDisk();

  console.log(`\ncreative-QA corpus — ${LABELED_SET.length} labeled outputs`);
  console.log(
    `  ${local.length} already on disk (probe-out/ and the rescued q5 cells)`,
  );
  console.log(
    `  ${todo.length} objects to fetch (${todo.filter((t) => t.kind === "output").length} outputs, ${todo.filter((t) => t.kind === "source").length} sources)`,
  );
  console.log(`  athlete ${ATHLETE.slice(0, 8)}…  →  ${ROOT}/`);

  if (!FETCH) {
    console.log(`\n  ids: ${todo.map((t) => t.shortId).join(" ")}`);
    console.log(
      `\n  DRY RUN — no network, no writes. Re-run with --fetch to download.\n`,
    );
    return;
  }

  const got: (FetchedAsset & { adopted: boolean })[] = [];
  const failed: { shortId: string; error: string }[] = [];

  for (const { shortId, kind } of todo) {
    try {
      const a = await fetchAsset(shortId, kind);
      got.push(a);
      console.log(
        `  ${a.adopted ? "·" : "✓"} ${shortId}  ${String(a.width ?? "?").padStart(4)}x${String(a.height ?? "?").padEnd(4)}  ${(a.bytes / 1e6).toFixed(1).padStart(5)}MB  ${a.via.padEnd(6)} ${a.adopted ? "already on disk" : "fetched"}`,
      );
    } catch (e: any) {
      failed.push({ shortId, error: e?.message ?? String(e) });
      console.log(`  ✗ ${shortId}  ${e?.message ?? e}`);
    }
  }

  // The labels are NOT copied in here. They live in studio/qa/labeledSet.ts and would drift the
  // moment one is corrected; this file records only what the code cannot re-derive — which document
  // id resolved to which asset, through which id space, and the bytes that came back.
  const manifest = {
    generatedAt: new Date().toISOString(),
    athleteId: ATHLETE,
    note: "Images are gitignored — photographs of a real person. This manifest holds no pixels. Labels live in server/studio/qa/labeledSet.ts.",
    labeledOutputs: LABELED_SET.length,
    resolved: got,
    failed,
  };
  await mkdir(ROOT, { recursive: true });
  await writeFile(
    join(ROOT, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  const pulled = got.filter((g) => !g.adopted).length;
  console.log(
    `\n  ${pulled} fetched, ${got.length - pulled} adopted, ${failed.length} failed  →  ${ROOT}/manifest.json\n`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
