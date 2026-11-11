/**
 * studioShotsBackfill — shot boundaries for athletes' existing clips (quality-scrappy piece 3,
 * docs/probes/quality-scrappy.md, ADI-QS-GO), and the measurement the ledger records: how the boundaries compare with
 * the Flash beats, and how often the caster's snap would fire.
 *
 * $0: local ffmpeg on bytes read from the bucket. No model, no network beyond GCS.
 *
 * ─── HOUSE RULES ───────────────────────────────────────────────────────────────────────────────────────
 *
 *   • ATHLETES ONE AT A TIME. `--all`, or a list (`--athlete <uuid>` repeatable, `--athletes a,b`, `--ids-file`; see
 *     ./athleteSelection). Every query carries the athlete being processed — no query spans athletes.
 *   • DRY RUN IS THE DEFAULT. It reads, detects and reports. `--apply` (or the older `--write`) writes
 *     `metadata.shots` (video/shots.ts, jsonb_set, one key per clip) — real rows, so a person runs that after
 *     reviewing the dry run.
 *   • COUNTS AND SHORT IDS ONLY. Nothing of hers is printed: no path, no description, no name.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   1. DRY RUN: npx tsx --env-file=.env server/scripts/studioShotsBackfill.ts --all [--threshold 0.3] [--missing-only]
 *              (or --athlete <uuid> … ; --asset <uuid> needs exactly one --athlete)
 *   2. REVIEW the per-clip lines and the per-athlete counts.
 *   3. APPLY:   the same command plus --apply.
 */
import { and, eq, like, or, sql } from "drizzle-orm";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { readObject } from "../lib/mediaStore";
import {
  SHOT_SCENE_THRESHOLD,
  detectShotsBytes,
  writeShots,
} from "../studio/video/shots";
import { SNAP_WITHIN_SEC, snapWindow } from "../studio/video/shotSnap";
import {
  forEachAthlete,
  parseAthleteSelection,
  resolveAthletes,
  SELECTION_USAGE,
  type AthleteSelection,
} from "./athleteSelection";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ASSET = arg("asset");
const THRESHOLD = Number(arg("threshold") ?? SHOT_SCENE_THRESHOLD);
const WRITE = flag("apply") || flag("write");
const MAX_BYTES = 300 * 1024 * 1024;

type Beat = { start_s?: unknown; end_s?: unknown };

async function main() {
  let selection: AthleteSelection;
  try {
    selection = parseAthleteSelection(argv);
  } catch (e: any) {
    throw new Error(
      `${e.message}\nusage: studioShotsBackfill.ts ${SELECTION_USAGE} [--asset <uuid>] [--threshold 0.3] [--missing-only] [--apply]`,
    );
  }
  if (ASSET && !UUID.test(ASSET)) throw new Error("--asset must be a uuid.");
  if (ASSET && (selection.all || selection.ids.length !== 1))
    throw new Error("--asset needs exactly one --athlete.");
  if (!(THRESHOLD > 0 && THRESHOLD < 1))
    throw new Error("--threshold must be in (0, 1).");

  const ids = await resolveAthletes(db, selection);
  console.log(
    `${ids.length} athlete(s) · threshold ${THRESHOLD} · ${WRITE ? "WRITING metadata.shots" : "dry run (nothing written)"}\n`,
  );
  const outcomes = await forEachAthlete(ids, (id) => backfillAthlete(id));
  const failed = outcomes.filter((o) => !o.ok);
  const sum = (k: "clips" | "written") =>
    outcomes.reduce((n, o) => n + (o.result?.[k] ?? 0), 0);
  console.log(
    `\nsummary: ${outcomes.length - failed.length} athlete(s) ok, ${failed.length} failed · clips scored ${sum("clips")}` +
      (WRITE
        ? ` · written ${sum("written")}`
        : " · dry run: nothing written; re-run with --apply"),
  );
  for (const f of failed)
    console.log(`  FAILED ${f.athlete_id.slice(0, 8)}: ${f.error}`);
  if (failed.length) process.exitCode = 1;
}

/** One athlete's clips; every query carries her id. */
async function backfillAthlete(ATHLETE: string) {
  console.log(`── athlete ${ATHLETE.slice(0, 8)}`);

  const rows = await db
    .select({
      id: mediaAssets.id,
      path: mediaAssets.gcs_path,
      metadata: mediaAssets.metadata,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, ATHLETE),
        or(
          eq(mediaAssets.media_type, "VIDEO"),
          like(mediaAssets.content_type, "video/%"),
        ),
        sql`${mediaAssets.gcs_path} IS NOT NULL`,
        ...(ASSET ? [eq(mediaAssets.id, ASSET)] : []),
        ...(flag("missing-only")
          ? [sql`${mediaAssets.metadata} -> 'shots' IS NULL`]
          : []),
      ),
    );

  console.log(`${rows.length} clip(s)`);
  const t = {
    clips: 0,
    unreadable: 0,
    withCuts: 0,
    boundaries: 0,
    beatEdges: 0,
    wouldSnap: 0,
    written: 0,
  };

  for (const r of rows) {
    const short = r.id.slice(0, 8);
    const got = await readObject(r.path!, MAX_BYTES).catch(() => null);
    if (!got) {
      t.unreadable++;
      console.log(`  ${short}  unreadable`);
      continue;
    }
    let record;
    try {
      record = await detectShotsBytes(got.buf, THRESHOLD);
    } catch {
      t.unreadable++;
      console.log(`  ${short}  ffmpeg could not score it`);
      continue;
    }
    t.clips++;
    t.boundaries += record.boundaries.length;
    if (record.boundaries.length) t.withCuts++;

    const beats = (
      (r.metadata as { vision?: { beats?: Beat[] } } | null)?.vision?.beats ??
      []
    )
      .map((b) => ({ startSec: Number(b.start_s), endSec: Number(b.end_s) }))
      .filter(
        (b) =>
          Number.isFinite(b.startSec) &&
          Number.isFinite(b.endSec) &&
          b.endSec > b.startSec,
      );
    // Every beat EDGE the caster could cut on, and whether the snap would move it.
    let edges = 0;
    let snaps = 0;
    for (const b of beats) {
      const s = snapWindow(b, record.boundaries, {
        durationSec: record.durationSec,
      });
      edges += 2;
      snaps += s.snapped.length;
    }
    t.beatEdges += edges;
    t.wouldSnap += snaps;
    const beatEdgesSec = [
      ...new Set(beats.flatMap((b) => [b.startSec, b.endSec])),
    ]
      .filter((x) => x > 0 && x < record.durationSec)
      .sort((a, b) => a - b);
    console.log(
      `  ${short}  ${record.durationSec.toFixed(1)}s · cuts [${record.boundaries.map((x) => x.toFixed(2)).join(", ")}]` +
        ` · Flash beat edges [${beatEdgesSec.map((x) => x.toFixed(1)).join(", ")}] · snaps ${snaps}/${edges}`,
    );
    if (WRITE && (await writeShots(r.id, ATHLETE, record))) t.written++;
  }

  console.log(
    `\nclips scored ${t.clips} · unreadable ${t.unreadable} · with ≥1 cut ${t.withCuts} · boundaries ${t.boundaries}` +
      ` · beat edges ${t.beatEdges} · edges a ${SNAP_WITHIN_SEC}s snap would move ${t.wouldSnap}` +
      (WRITE ? ` · written ${t.written}` : ""),
  );
  return t;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
