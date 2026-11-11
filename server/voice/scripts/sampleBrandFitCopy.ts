/**
 * sampleBrandFitCopy.ts — READ-ONLY copy sample. Prints, writes nothing.
 *
 *   npx tsx --require dotenv/config server/voice/scripts/sampleBrandFitCopy.ts
 *   npx tsx --require dotenv/config server/voice/scripts/sampleBrandFitCopy.ts --cells 15
 *
 * ── What this is for ──────────────────────────────────────────────────────────
 * The precomputed call path is only worth anything if the copy is worth speaking.
 * This runs the SAME code the backfill and the live fill run — `get_brand_fit`,
 * which calls `narrateWhyFits` — across a spread of athlete×brand pairs and prints
 * the result for a human to read BEFORE anything is written anywhere.
 *
 * The specific failure it exists to catch: angles that anchor on BRAND BOILERPLATE
 * rather than on the athlete. "Gymshark is a leading fitness apparel brand with a
 * young, active audience" is a sentence about Gymshark that would be identical for
 * every athlete on the roster, and it is worthless as a pitch. Every angle has to
 * be unmistakably about THIS athlete. That is why the sample spans several
 * athletes rather than several brands for one athlete — one athlete's cells can't
 * show you whether the copy is actually varying with the athlete.
 *
 * ── Guarantees ────────────────────────────────────────────────────────────────
 *   - WRITES NOTHING. Not to the store, not to the database, not to a file. Every
 *     query below is a SELECT and no result is persisted anywhere. It is safe to
 *     run repeatedly and it cannot corrupt a backfill.
 *   - NEVER RESEARCHES. It goes through the cache-only tool and only ever picks
 *     brands that are already enriched.
 *   - Output is for the terminal only. It contains real athlete names and sports,
 *     so it must not be pasted into a commit, a doc, a fixture, or an issue.
 *
 * ── Spend ─────────────────────────────────────────────────────────────────────
 * One Gemini Pro call per cell. `--cells` defaults to 12 and is capped at 20, so a
 * mistyped flag cannot turn a preview into a backfill.
 */

import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db, pool } from "../../db";
import {
  athletes,
  inboxBrands,
  socialAnalyticsSnapshots,
} from "../../../shared/schema";
import { getBrandFitTool } from "../../mila/tools/getBrandFit";
import { GEMINI } from "../../lib/models";

/** Hard ceiling on cells regardless of what is passed. A preview, not a run. */
const MAX_CELLS = 20;
const DEFAULT_CELLS = 12;

/** How many run at once. Small on purpose — this is a preview, not a throughput job. */
const CONCURRENCY = 3;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

interface Cell {
  athleteId: string;
  athleteName: string;
  sport: string | null;
  brandId: number;
  brandName: string;
  knowledge: "full" | "thin";
}

/**
 * Athletes a narrative can be written for at all: a name and a sport.
 *
 * It deliberately does NOT require a connected analytics snapshot. It used to,
 * on the theory that the audience descriptor comes from one — and that filter
 * reduced the sample to a SINGLE athlete, because exactly one athlete in the
 * database has a connected snapshot. A one-athlete sample cannot show whether
 * the copy varies by athlete, which is the only thing this script is for.
 *
 * The consequence is worth stating rather than hiding, because it is also true
 * of the backfill: for every athlete without a snapshot, `audienceDesc` falls
 * back to the generic "young, highly engaged", so the audience angle is written
 * from name + sport alone. `main` prints how many of the sampled athletes are in
 * that position, so the copy is read with that in view.
 */
async function pickAthletes(limit: number) {
  return db
    .select({
      id: athletes.id,
      name: athletes.full_name,
      sport: athletes.sport,
    })
    .from(athletes)
    .where(and(isNotNull(athletes.full_name), isNotNull(athletes.sport)))
    .orderBy(athletes.id)
    .limit(limit);
}

/** Which of the sampled athletes actually have a connected audience breakdown. */
async function athletesWithAudience(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ id: socialAnalyticsSnapshots.athlete_id })
    .from(socialAnalyticsSnapshots)
    .where(
      and(
        eq(socialAnalyticsSnapshots.source, "connected"),
        isNotNull(socialAnalyticsSnapshots.top_audience_gender),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * Enriched, non-agency brands, SPREAD across the whole set rather than ranked.
 *
 * Ordering by longest audience_summary (the first attempt) surfaced universities
 * and a photo-editing app — real `inbox_brands` rows, but a lopsided view of what
 * the backfill will actually cover. Walking the id range at a stride samples the
 * table the way the backfill will meet it, which is what a preview should show.
 *
 * `--brands "Gorjana,Alo Yoga"` overrides this entirely and pins the sample to
 * named brands, which is how to eyeball a specific pair before backfilling it.
 */
async function pickBrands(limit: number, names: string[]) {
  const rows = await db
    .select({
      id: inboxBrands.id,
      name: inboxBrands.name,
      audience: inboxBrands.audience_summary,
      category: inboxBrands.category,
    })
    .from(inboxBrands)
    .where(
      and(
        isNotNull(inboxBrands.enriched_at),
        ne(inboxBrands.is_agency, true),
        isNotNull(inboxBrands.name),
      ),
    )
    .orderBy(inboxBrands.id);

  if (names.length) {
    const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
    const matched = rows.filter((r) => wanted.includes(r.name.toLowerCase()));
    const missing = wanted.filter(
      (w) => !matched.some((m) => m.name.toLowerCase() === w),
    );
    if (missing.length) {
      console.warn(`  (not held enriched, skipped: ${missing.join(", ")})`);
    }
    return matched;
  }

  if (rows.length <= limit) return rows;
  const stride = Math.floor(rows.length / limit);
  return Array.from({ length: limit }, (_, i) => rows[i * stride]);
}

/** Runs `tasks` at most `n` at a time, preserving order. */
async function pooled<T, R>(
  items: T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function main() {
  const requested = Number(arg("cells") ?? DEFAULT_CELLS);
  const cells = Math.max(
    1,
    Math.min(MAX_CELLS, Number.isFinite(requested) ? requested : DEFAULT_CELLS),
  );

  const model = process.env.NARRATOR_GEMINI_MODEL ?? GEMINI.pro;
  console.log(`\nBrand-fit copy sample — ${cells} cells, model: ${model}`);
  console.log(
    "READ-ONLY: nothing is written to the store, the database, or disk.\n",
  );

  const brandNames = (arg("brands") ?? "").split(",").filter((s) => s.trim());
  const athleteRows = await pickAthletes(cells);
  const brandRows = await pickBrands(cells, brandNames);

  if (!athleteRows.length || !brandRows.length) {
    console.error(
      `Not enough data to sample: ${athleteRows.length} eligible athletes, ${brandRows.length} enriched brands.`,
    );
    return;
  }

  const withAudience = await athletesWithAudience();

  // One cell per athlete, each against a different brand — a diagonal through the
  // cross product. Both lists are walked at stride 1 from independent offsets, so
  // a cell repeats an athlete only once every athleteRows.length cells and a
  // brand only once every brandRows.length. The earlier version multiplied the
  // brand index by a constant, which aliased onto four brands and made the sample
  // look far narrower than the data.
  const pairs: Cell[] = Array.from({ length: cells }, (_, i) => {
    const a = athleteRows[i % athleteRows.length];
    const b = brandRows[i % brandRows.length];
    return {
      athleteId: a.id,
      athleteName: a.name ?? "(unnamed)",
      sport: a.sport,
      brandId: b.id,
      brandName: b.name,
      knowledge: b.audience?.trim() ? "full" : "thin",
    };
  });

  const distinctAthletes = new Set(pairs.map((p) => p.athleteId)).size;
  const distinctBrands = new Set(pairs.map((p) => p.brandId)).size;
  const sampledWithAudience = pairs.filter((p) =>
    withAudience.has(p.athleteId),
  ).length;
  console.log(
    `${distinctAthletes} distinct athletes × ${distinctBrands} distinct brands.\n` +
      `${sampledWithAudience}/${pairs.length} cells have a real audience breakdown; ` +
      `the rest fall back to the generic "young, highly engaged" descriptor.\n`,
  );

  const started = Date.now();
  const results = await pooled(pairs, CONCURRENCY, async (cell) => {
    const t0 = Date.now();
    try {
      const fit: any = await getBrandFitTool.execute(cell.athleteId, {
        brand_name: cell.brandName,
      });
      return {
        cell,
        reasons: fit?.reasons ?? null,
        ms: Date.now() - t0,
        error: null as string | null,
      };
    } catch (err: any) {
      return {
        cell,
        reasons: null,
        ms: Date.now() - t0,
        error: err?.message ?? "unknown",
      };
    }
  });

  let ok = 0;
  results.forEach(({ cell, reasons, ms, error }, i) => {
    // First name only in the header — the narrative body says whatever the model
    // wrote, but the index line does not need to add to that.
    const first = cell.athleteName.split(/\s+/)[0];
    console.log(
      `\n${"─".repeat(78)}\n[${i + 1}/${results.length}] ${first} · ${cell.sport ?? "—"}  ×  ${cell.brandName} (${cell.knowledge})  ${ms}ms`,
    );
    if (error) {
      console.log(`  ERROR: ${error}`);
      return;
    }
    if (!reasons) {
      console.log("  (no narrative — narrator returned null)");
      return;
    }
    ok += 1;
    console.log(`  audience    ${reasons.audience}`);
    console.log(`  credibility ${reasons.credibility}`);
    console.log(`  whitespace  ${reasons.whitespace}`);
  });

  console.log(
    `\n${"─".repeat(78)}\n${ok}/${results.length} produced a full narrative in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
  );
  console.log(
    "Nothing was written. Review the copy before running any backfill.\n",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
