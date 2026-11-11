/**
 * scripts/media/enrichCarouselFrames — tag + embed the single photo frames inside athletes' carousel posts
 * (services/mediaEnrichment enrichCarouselFrames), so per-page photo casting (curator castBriefs) can find them.
 *
 * Dry run by default (a quote per athlete). APPLY=1 enriches, stopping at CAP_USD (default 2).
 *   npx tsx server/scripts/media/enrichCarouselFrames.ts <envfile>
 *   APPLY=1 CAP_USD=2 npx tsx server/scripts/media/enrichCarouselFrames.ts <envfile>
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: process.argv[2] });

const BATCH = 25;

(async () => {
  const { db, pool } = await import("../../db");
  const { athletes } = await import("../../../shared/schema");
  const { enrichCarouselFrames, ENRICH_USD_PER_PHOTO } = await import("../../services/mediaEnrichment");
  const apply = process.env.APPLY === "1";
  const capUsd = Number(process.env.CAP_USD ?? 2);
  const all = await db.select({ id: athletes.id }).from(athletes);
  let total = 0, spent = 0;
  for (const a of all) {
    const q = await enrichCarouselFrames(a.id, { limit: 10_000, apply: false });
    if (!q.candidates) continue;
    total += q.candidates;
    if (!apply) { console.log(JSON.stringify({ athlete: a.id, frames: q.candidates, usd: q.usd })); continue; }
    let left = q.candidates;
    while (left > 0) {
      const room = Math.floor((capUsd - spent) / ENRICH_USD_PER_PHOTO);
      if (room < 1) { console.log(JSON.stringify({ stopped: "cap", spent })); await pool.end(); return; }
      const r = await enrichCarouselFrames(a.id, { limit: Math.min(BATCH, room, left), apply: true });
      spent += r.candidates * ENRICH_USD_PER_PHOTO;
      left -= r.candidates;
      console.log(JSON.stringify({ athlete: a.id, ...r.result, spent: Number(spent.toFixed(4)) }));
      if (!r.candidates || !r.result || (r.result.tagged + r.result.embedded) === 0) break;
    }
  }
  console.log(JSON.stringify({ apply, frames: total, estUsd: Number((total * ENRICH_USD_PER_PHOTO).toFixed(4)), spent: Number(spent.toFixed(4)) }));
  await pool.end();
})().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
