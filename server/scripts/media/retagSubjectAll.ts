/**
 * scripts/media/retagSubjectAll — the `subject` re-tag (studio/enrich/retag.ts, cell "subject") for every athlete.
 *
 * Why: casting a photo AS the athlete now needs the profile-aware tagger's `subject: "the_athlete"`
 * (lib/visionTag `isTheAthlete`). Rows tagged before `subject` existed carry the blind `athlete_present`
 * and are treated as unsure until this re-reads them. Same tagger, same prompt; only the two keys are written.
 *
 * Dry run by default (a quote per athlete). APPLY=1 runs the batches, stopping at CAP_USD (default 5).
 *   npx tsx server/scripts/media/retagSubjectAll.ts <envfile>            # quote
 *   APPLY=1 CAP_USD=5 npx tsx server/scripts/media/retagSubjectAll.ts <envfile>
 * CELL=frame runs the 21 Oct 2026 frame keys (face_box + text_in_image) instead of `subject`.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: process.argv[2] });

const BATCH = 50;

(async () => {
  const { db, pool } = await import("../../db");
  const { athletes } = await import("../../../shared/schema");
  const { quoteRetag, retag, RETAG_USD_PER_ROW } = await import("../../studio/enrich/retag");
  const apply = process.env.APPLY === "1";
  const capUsd = Number(process.env.CAP_USD ?? 5);
  const cell = (process.env.CELL === "frame" ? "frame" : "subject") as "frame" | "subject";
  const all = await db.select({ id: athletes.id }).from(athletes);
  let totalRows = 0, spent = 0;
  for (const a of all) {
    const q = await quoteRetag(a.id, cell, 10_000);
    if (!q.rows) continue;
    totalRows += q.rows;
    if (!apply) { console.log(JSON.stringify({ athlete: a.id, rows: q.rows, usd: q.usd })); continue; }
    let left = q.rows;
    while (left > 0) {
      const room = Math.floor((capUsd - spent) / RETAG_USD_PER_ROW);
      if (room < 1) { console.log(JSON.stringify({ stopped: "cap", spent })); await pool.end(); return; }
      const r = await retag(a.id, cell, Math.min(BATCH, room, left));
      spent += r.attempted * RETAG_USD_PER_ROW;
      left -= r.attempted;
      console.log(JSON.stringify({ athlete: a.id, ...r, spent: Number(spent.toFixed(4)) }));
      if (r.attempted === 0 || r.written === 0) break;
    }
  }
  console.log(JSON.stringify({ apply, totalRows, estUsd: Number((totalRows * RETAG_USD_PER_ROW).toFixed(4)), spent: Number(spent.toFixed(4)) }));
  await pool.end();
})().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
