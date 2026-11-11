/**
 * backfillGeneratedThumbnails — give already-stored generated assets the thumbnail they were
 * written without. ONE-OFF, and it is finished when it reports 0 remaining.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────────────────────────
 *
 * `recordGeneratedAsset` now writes `gcs_thumb_path` at record time (studio/thumbnail.ts). Every
 * generated asset written BEFORE that has none, so `mediaEnrichment` still embeds them from
 * full-res — and the largest studio outputs are 4000x6000 quality-100 JPEGs whose base64 is over
 * Vertex's 27,000,000-character cap. Those rows never get an embedding, so `mediaSearch`'s
 * near-duplicate suppression (`cand.emb && …`) can never see them, on exactly the origin that
 * produces near-duplicates.
 *
 * ─── WHAT IT TOUCHES ───────────────────────────────────────────────────────────────────────────
 *
 *   ONE athlete, passed with --athlete and required. This is deliberate: the lane rule for this
 *   work is one athlete's rows, and a script that defaults to "everybody" is one flag away from
 *   rewriting media belonging to people whose work this is not.
 *
 *   Rows matched: origin = 'generated' AND status = 'stored' AND gcs_thumb_path IS NULL,
 *   media_type = 'IMAGE' AND parent_media_id IS NULL. A VIDEO's thumb is its POSTER and
 *   services/videoPoster.ts owns it.
 *
 *   ⚠️ `parent_media_id IS NULL` MIRRORS THE EMBEDDER ON PURPOSE. Both mediaEnrichment queries
 *   filter on it, so a child row is never enriched and thumbnailing one buys no embedding and no
 *   dedup — the entire justification for this script. Without the clause it matched 134 rows
 *   instead of 116: eighteen derived rows of GCS reads and writes for nothing. If child thumbnails
 *   are ever wanted it will be for the LIBRARY GRID, which is a different reason needing its own.
 *
 *   Columns written: gcs_thumb_path, and metadata.enrichment REMOVED when present. Nothing else.
 *   No embedding is computed here and no model is called — this script costs a GCS read and a GCS
 *   write per row and nothing else. The cron does the enrichment afterwards, off the thumbnail.
 *
 *   Clearing metadata.enrichment is the "the reason changed" case the marker was designed for: a
 *   row set down because it could not embed at full-res deserves another go now that a small copy
 *   exists. It is removed rather than zeroed so the row looks like one that never failed.
 *
 * ─── SAFETY ────────────────────────────────────────────────────────────────────────────────────
 *
 *   DRY BY DEFAULT. Without --apply it reads, thumbnails NOTHING, and prints what it would do.
 *   Re-runnable: a row that already has a thumb is not matched, so a half-finished run resumes.
 *   Never deletes, never touches gcs_path, never widens beyond the one athlete.
 *
 * Usage:
 *   npx tsx --require dotenv/config server/scripts/backfillGeneratedThumbnails.ts --athlete <uuid>
 *   npx tsx --require dotenv/config server/scripts/backfillGeneratedThumbnails.ts --athlete <uuid> --apply
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { mediaAssets } from "../../shared/schema";
import { writeGeneratedThumbnail } from "../studio/thumbnail";

/** Small, because each row is a multi-MB download; this is bandwidth-bound, not CPU-bound. */
const CONC = 4;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const athleteId = arg("athlete");
  const apply = process.argv.includes("--apply");

  if (!athleteId || !/^[0-9a-f-]{36}$/i.test(athleteId)) {
    console.error("refusing to run: --athlete <uuid> is required, and is the only scope this script has");
    process.exit(2);
  }

  const rows = await db
    .select({
      id: mediaAssets.id,
      path: mediaAssets.gcs_path,
      bytes: mediaAssets.bytes,
      metadata: mediaAssets.metadata,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.origin, "generated"),
        eq(mediaAssets.status, "stored"),
        eq(mediaAssets.media_type, "IMAGE"),
        isNull(mediaAssets.parent_media_id),
        isNull(mediaAssets.gcs_thumb_path),
      ),
    );

  const withPath = rows.filter((r) => r.path);
  const overCap = withPath.filter((r) => Math.ceil((Number(r.bytes ?? 0) * 4) / 3) > 27_000_000);

  console.log(`athlete        ${athleteId}`);
  console.log(`mode           ${apply ? "APPLY — will write" : "DRY RUN — writes nothing"}`);
  console.log(`rows matched   ${rows.length} (${withPath.length} with a gcs_path)`);
  console.log(`of those, over the embed cap at full-res: ${overCap.length}`);
  if (!apply) {
    console.log("\nre-run with --apply to write. Nothing was changed.");
    return;
  }

  let done = 0, failed = 0, cleared = 0;
  for (let i = 0; i < withPath.length; i += CONC) {
    await Promise.all(
      withPath.slice(i, i + CONC).map(async (r) => {
        const thumb = await writeGeneratedThumbnail(r.path!);
        if (!thumb) {
          failed++;
          console.log(`  FAILED  ${r.id}  ${r.path}`);
          return;
        }
        const meta = ((r.metadata as Record<string, unknown>) ?? {});
        const patch = { ...meta };
        const hadState = "enrichment" in patch;
        if (hadState) { delete patch.enrichment; cleared++; }

        await db
          .update(mediaAssets)
          .set({
            gcs_thumb_path: thumb,
            ...(hadState ? { metadata: patch as never, metadata_updated_at: new Date() } : {}),
          })
          .where(eq(mediaAssets.id, r.id));
        done++;
      }),
    );
    console.log(`  … ${Math.min(i + CONC, withPath.length)}/${withPath.length}`);
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.origin, "generated"),
        eq(mediaAssets.status, "stored"),
        eq(mediaAssets.media_type, "IMAGE"),
        isNull(mediaAssets.parent_media_id),
        isNull(mediaAssets.gcs_thumb_path),
      ),
    );

  console.log(`\nthumbnailed    ${done}`);
  console.log(`failed         ${failed}`);
  console.log(`give-up marks cleared: ${cleared}`);
  console.log(`still without a thumb: ${n}`);
  console.log("\nEmbeddings are NOT written here — the media-enrich cron picks these up off the new thumb.");
}

main()
  .then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
