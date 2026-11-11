/**
 * backfillBrandFit.ts — precomputes brand-fit narratives into the temp store.
 *
 *   # what would run, no model calls, no writes
 *   npx tsx --require dotenv/config server/voice/scripts/backfillBrandFit.ts \
 *     --athlete <uuid> --brands "Gorjana,Thinbrand" --dry-run
 *
 *   # the real thing
 *   npx tsx --require dotenv/config server/voice/scripts/backfillBrandFit.ts \
 *     --athlete <uuid> --brands "Gorjana,Thinbrand"
 *
 * ── What it writes, and what it can't ─────────────────────────────────────────
 * It calls `fillBrandFit` — the SAME function the live cold path calls — once per
 * (athlete, brand) pair and stores the result via ./brandFitStore. One
 * implementation, two callers, on purpose: a narrative produced ahead of time and
 * one produced by a cold ask have to be identical, or backfilling would not be
 * testing the thing that serves live traffic.
 *
 * It writes ONLY to the store (a gitignored JSON file today, a table later). It
 * issues no DDL, no DML, and no writes of any kind to Postgres — every database
 * access on this path is a SELECT, and it goes through the cache-only fit tool so
 * it can never trigger brand research.
 *
 * ── Scope guards, because this spends real money ──────────────────────────────
 * One Gemini Pro call per pair, ~13s each. The full cross product is ~22 athletes
 * × ~127 brands ≈ 2,794 calls, so the destructive-by-accident failure here is not
 * data loss, it is spend.
 *
 *   - `--athlete` is REQUIRED unless `--all` is passed.
 *   - `--all` additionally requires `--yes`, and prints the pair count first.
 *   - `--dry-run` resolves and prints every pair without a single model call.
 *   - `--limit` caps the pair count on any mode.
 *
 * Pairs already present in the store are SKIPPED unless `--force` is passed, so a
 * re-run after a partial failure costs only the pairs that are actually missing.
 */

import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db, pool } from "../../db";
import { athletes, inboxBrands } from "../../../shared/schema";
import { fillBrandFit } from "../brandFitFill";
import { getBrandFitReasons } from "../brandFitStore";
import { GEMINI } from "../../lib/models";

/** Two at a time. The narrator is a Pro call; this is politeness, not throughput. */
const CONCURRENCY = 2;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : "";
}

const flag = (name: string) => process.argv.includes(`--${name}`);

interface Pair {
  athleteId: string;
  athleteLabel: string;
  brandId: number;
  brandName: string;
}

async function resolveAthletes(athleteId: string | undefined) {
  const rows = await db
    .select({
      id: athletes.id,
      name: athletes.full_name,
      sport: athletes.sport,
    })
    .from(athletes)
    .where(
      athleteId
        ? eq(athletes.id, athleteId)
        : and(isNotNull(athletes.full_name), isNotNull(athletes.sport)),
    )
    .orderBy(athletes.id);
  return rows;
}

async function resolveBrands(names: string[]) {
  const rows = await db
    .select({
      id: inboxBrands.id,
      name: inboxBrands.name,
      audience: inboxBrands.audience_summary,
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

  if (!names.length) return rows;

  const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const matched = rows.filter((r) => wanted.includes(r.name.toLowerCase()));
  const missing = wanted.filter(
    (w) => !matched.some((m) => m.name.toLowerCase() === w),
  );
  if (missing.length) {
    console.warn(
      `WARNING: not held enriched, skipping: ${missing.join(", ")}\n` +
        "  (a brand we don't hold enriched is a miss on the voice path too — " +
        "this script never researches one.)",
    );
  }
  return matched;
}

async function pooled<T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    }),
  );
}

async function main() {
  const athleteId = arg("athlete");
  const all = flag("all");
  const dryRun = flag("dry-run");
  const force = flag("force");
  const limitArg = Number(arg("limit") ?? NaN);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : Infinity;
  const brandNames = (arg("brands") ?? "").split(",").filter((s) => s.trim());

  if (!athleteId && !all) {
    console.error(
      "Refusing to run without a target.\n" +
        "  --athlete <uuid>   backfill one athlete (what you want for a test)\n" +
        "  --all --yes        backfill EVERY athlete (~2,794 Pro calls)\n" +
        "  --dry-run          resolve and print the pairs, spend nothing",
    );
    process.exitCode = 1;
    return;
  }
  if (athleteId && !UUID_RE.test(athleteId)) {
    console.error(`Not a uuid: ${athleteId}`);
    process.exitCode = 1;
    return;
  }
  if (all && !flag("yes") && !dryRun) {
    console.error(
      "--all is the full cross product (~2,794 Gemini Pro calls, ~10+ hours).\n" +
        "Re-run with --yes if that is really what you want, or --dry-run to see the pairs.",
    );
    process.exitCode = 1;
    return;
  }

  const athleteRows = await resolveAthletes(athleteId);
  if (!athleteRows.length) {
    console.error(
      athleteId ? `No athlete with id ${athleteId}` : "No eligible athletes.",
    );
    process.exitCode = 1;
    return;
  }
  const brandRows = await resolveBrands(brandNames);
  if (!brandRows.length) {
    console.error("No enriched brands matched.");
    process.exitCode = 1;
    return;
  }

  let pairs: Pair[] = [];
  for (const a of athleteRows) {
    for (const b of brandRows) {
      pairs.push({
        athleteId: a.id,
        // First name only — this goes to a terminal and sometimes a log.
        athleteLabel: `${(a.name ?? "(unnamed)").split(/\s+/)[0]} · ${a.sport ?? "—"}`,
        brandId: b.id,
        brandName: b.name,
      });
    }
  }

  // Skip what is already stored, so a re-run after a partial failure only pays
  // for the gaps. --force re-narrates everything (what you want after a prompt
  // change, and the only way to overwrite an existing narrative).
  if (!force) {
    const before = pairs.length;
    const keep: Pair[] = [];
    for (const p of pairs) {
      if (!(await getBrandFitReasons(p.athleteId, p.brandId))) keep.push(p);
    }
    if (before !== keep.length) {
      console.log(
        `${before - keep.length} pair(s) already stored — skipping (use --force to redo).`,
      );
    }
    pairs = keep;
  }

  if (pairs.length > limit) {
    console.log(`Capping ${pairs.length} pairs to ${limit} (--limit).`);
    pairs = pairs.slice(0, limit);
  }

  const model = process.env.NARRATOR_GEMINI_MODEL ?? GEMINI.pro;
  console.log(
    `\n${athleteRows.length} athlete(s) × ${brandRows.length} brand(s) = ${pairs.length} pair(s) to fill.`,
  );
  console.log(
    `Model: ${model}. Writes to the brand-fit store only — no database writes.\n`,
  );

  if (dryRun) {
    pairs.forEach((p, i) =>
      console.log(
        `  [${i + 1}] ${p.athleteLabel}  ×  ${p.brandName} (#${p.brandId})`,
      ),
    );
    console.log(`\nDRY RUN — nothing called, nothing written.\n`);
    return;
  }

  if (!pairs.length) {
    console.log("Nothing to do.\n");
    return;
  }

  const started = Date.now();
  let stored = 0;
  let empty = 0;
  await pooled(pairs, CONCURRENCY, async (p) => {
    const t0 = Date.now();
    const reasons = await fillBrandFit(p.athleteId, p.brandId, p.brandName);
    if (reasons) {
      stored += 1;
      console.log(
        `  ✓ ${p.athleteLabel} × ${p.brandName} (${Date.now() - t0}ms)`,
      );
      console.log(`      audience    ${reasons.audience}`);
      console.log(`      credibility ${reasons.credibility}`);
      console.log(`      whitespace  ${reasons.whitespace}`);
    } else {
      empty += 1;
      console.log(
        `  · ${p.athleteLabel} × ${p.brandName} — no narrative, nothing stored`,
      );
    }
  });

  console.log(
    `\n${stored} stored, ${empty} empty, in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`,
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
