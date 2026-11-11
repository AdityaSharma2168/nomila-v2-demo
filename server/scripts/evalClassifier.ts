/**
 * evalClassifier.ts — Offline precision/recall harness for the inbox deal classifier.
 *
 * WHY: the classifier's "is this a deal?" decision (CLASSIFY_SYSTEM + the 0.6 gate)
 * currently produces too many false positives. You cannot fix a classifier you cannot
 * measure — this harness turns "the new prompt feels better" into a number:
 * precision / recall on a labeled set, a NOISE→deal leak rate, and the concrete
 * false-positive / false-negative lists so you can see WHAT is still wrong.
 *
 * It re-uses the production classifier verbatim (classifyMessage from dealDetector)
 * and replays the exact surfacing decision (category != NOISE, confidence >= threshold,
 * category is scoreable) so the metric reflects what the app would actually pop up.
 *
 * See docs/plans/deal-classifier-precision.md — this is milestone M2.
 *
 * FIXTURE FORMAT — JSONL, one object per line (blank lines and `//` lines ignored):
 *   {"id":"opt", "from":"Name <e@x.com>", "subject":"…", "body":"…",
 *    "label": {"category":"PAID", "is_deal": true}}
 *   - label.category: the TRUE category (one of the 7 DEAL_CATEGORIES).
 *   - label.media_kind: OPTIONAL. interview|podcast|feature|op_ed|cover for a MEDIA request, or null.
 *                     Checked only when the key is present.
 *   - label.advertiser_domain: OPTIONAL. The advertiser's own domain the classifier must extract (string),
 *                     or null when it must extract none. Checked only when the key is present.
 *   - label.is_deal:  OPTIONAL. Whether this should surface as a scoreable deal card.
 *                     Defaults to `SCOREABLE_CATEGORIES.has(label.category)` when omitted
 *                     (FAN and NOISE are not deals). Set it explicitly only for edge cases.
 *
 * Run (needs .env for DATABASE_URL — dealDetector imports ../db — and Vertex creds):
 *   npx tsx --require dotenv/config server/scripts/evalClassifier.ts
 *   npx tsx --require dotenv/config server/scripts/evalClassifier.ts --fixture path.jsonl
 *   npx tsx --require dotenv/config server/scripts/evalClassifier.ts --refresh   # ignore cache reads
 *   npx tsx --require dotenv/config server/scripts/evalClassifier.ts --no-cache  # no read or write
 *
 * Targets (override via env): EVAL_MIN_PRECISION (0.90), EVAL_MIN_RECALL (0.85).
 * Exits non-zero when below target so it can gate CI once the dataset (M1) is real.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  classifyMessage,
  CONFIDENCE_THRESHOLD,
  SCOREABLE_CATEGORIES,
  DEAL_CATEGORIES,
  CLASSIFY_SYSTEM,
  type Classification,
  type DealCategory,
} from "../skills/dealDetector";

// ─── Config ─────────────────────────────────────────────────────────────────
const ROOT          = path.resolve(__dirname, "../..");
const DEFAULT_FIX   = path.join(ROOT, "server/skills/__fixtures__/classifier-eval.dev.jsonl");
const CACHE_ROOT    = path.join(ROOT, "server/scripts/.cache/classifier-eval");
const RESULTS_MD    = path.join(ROOT, "docs/plans/classifier-eval-results.md");
const CONCURRENCY   = Number(process.env.EVAL_CONCURRENCY ?? 5);
const MIN_PRECISION = Number(process.env.EVAL_MIN_PRECISION ?? 0.9);
const MIN_RECALL    = Number(process.env.EVAL_MIN_RECALL ?? 0.85);

const CATEGORIES = [...DEAL_CATEGORIES] as DealCategory[];

// ─── CLI args ───────────────────────────────────────────────────────────────
const argv        = process.argv.slice(2);
const fixtureArg  = argFor("--fixture");
const FIXTURE     = fixtureArg ? path.resolve(fixtureArg) : DEFAULT_FIX;
const NO_CACHE    = argv.includes("--no-cache");
const REFRESH     = argv.includes("--refresh");

function argFor(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// ─── Types ──────────────────────────────────────────────────────────────────
interface FixtureRow {
  id?:    string;
  from:   string;
  subject: string;
  body:   string;
  label:  { category: DealCategory; is_deal?: boolean; advertiser_domain?: string | null; media_kind?: string | null };
}

interface Evaluated {
  row:           FixtureRow;
  cls:           Classification;
  predCategory:  DealCategory;
  predSurface:   boolean;   // would the app pop this up as a deal card?
  trueCategory:  DealCategory;
  trueSurface:   boolean;
}

// ─── Fixture loading ──────────────────────────────────────────────────────────
function loadFixtures(file: string): FixtureRow[] {
  if (!fs.existsSync(file)) return [];
  const rows: FixtureRow[] = [];
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("//")) return;   // allow comments + blank lines
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`${file}:${i + 1} — invalid JSON: ${line.slice(0, 80)}`);
    }
    if (!obj.label?.category || !DEAL_CATEGORIES.has(obj.label.category)) {
      throw new Error(`${file}:${i + 1} — label.category must be one of ${CATEGORIES.join("/")}`);
    }
    rows.push({
      id:      obj.id,
      from:    String(obj.from ?? ""),
      subject: String(obj.subject ?? ""),
      body:    String(obj.body ?? ""),
      label:   {
        category: obj.label.category, is_deal: obj.label.is_deal,
        ...("advertiser_domain" in obj.label ? { advertiser_domain: obj.label.advertiser_domain ?? null } : {}),
        ...("media_kind" in obj.label ? { media_kind: obj.label.media_kind ?? null } : {}),
      },
    });
  });
  return rows;
}

// ─── Response cache ───────────────────────────────────────────────────────────
// Keyed by (prompt hash, input hash). Editing CLASSIFY_SYSTEM changes the prompt
// hash → a fresh cache namespace, so an old cached result never masks a prompt edit.
const PROMPT_HASH = crypto.createHash("sha1").update(CLASSIFY_SYSTEM).digest("hex").slice(0, 12);
const cacheDir    = path.join(CACHE_ROOT, PROMPT_HASH);

function cachePath(row: FixtureRow): string {
  const key = crypto.createHash("sha1")
    .update(`${row.from}\n${row.subject}\n${row.body}`)
    .digest("hex").slice(0, 16);
  return path.join(cacheDir, `${key}.json`);
}

async function classifyCached(row: FixtureRow): Promise<Classification> {
  const p = cachePath(row);
  if (!NO_CACHE && !REFRESH && fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf-8")) as Classification; } catch { /* fall through */ }
  }
  const cls = await classifyMessage(row.from, row.subject, row.body);
  if (!NO_CACHE) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cls, null, 2));
  }
  return cls;
}

// ─── Concurrency-limited map ──────────────────────────────────────────────────
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      if (++done % 10 === 0 || done === items.length) process.stdout.write(`\r  classified ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  process.stdout.write("\n");
  return out;
}

// ─── Surfacing decision — must mirror detectDeal exactly ──────────────────────
// detectDeal skips when category==NOISE OR confidence<threshold (dealDetector.ts:245),
// and only SCOREABLE categories get a deal row + status="deal_detected" (:439).
// FAN passes the gate but is "fan_stored", never surfaced as a deal — so it is NOT a surface.
function surfaces(cls: Classification): boolean {
  if (cls.is_deal === false) return false;                    // v2 explicit gate
  if (cls.category === "NOISE") return false;
  if (cls.confidence < CONFIDENCE_THRESHOLD) return false;
  return SCOREABLE_CATEGORIES.has(cls.category);
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
function report(evals: Evaluated[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const e of evals) {
    if (e.predSurface && e.trueSurface)   tp++;
    else if (e.predSurface && !e.trueSurface)  fp++;
    else if (!e.predSurface && e.trueSurface)  fn++;
    else tn++;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall    = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1        = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy  = (tp + tn) / evals.length;

  // NOISE/FAN → surfaced-deal leak: the exact complaint, measured directly.
  const junk       = evals.filter((e) => e.trueCategory === "NOISE" || e.trueCategory === "FAN");
  const leaked     = junk.filter((e) => e.predSurface);
  const leakRate   = junk.length === 0 ? 0 : leaked.length / junk.length;

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log(`\n══ Deal-surfacing decision (positive = would pop up as a deal card) ══`);
  console.log(`  n=${evals.length}   TP=${tp}  FP=${fp}  FN=${fn}  TN=${tn}`);
  console.log(`  precision  ${pct(precision)}   (of surfaced deals, how many are real)   target ≥ ${pct(MIN_PRECISION)}`);
  console.log(`  recall     ${pct(recall)}   (of real deals, how many we surface)      target ≥ ${pct(MIN_RECALL)}`);
  console.log(`  F1         ${pct(f1)}     accuracy ${pct(accuracy)}`);
  console.log(`  NOISE/FAN → deal leak   ${pct(leakRate)}  (${leaked.length}/${junk.length})`);

  // 7×7 confusion matrix (true rows × predicted cols).
  console.log(`\n══ Category confusion (rows = true, cols = predicted) ══`);
  const w = 10;
  console.log(" ".repeat(w) + CATEGORIES.map((c) => c.slice(0, 8).padStart(w)).join(""));
  for (const t of CATEGORIES) {
    const cells = CATEGORIES.map((p) =>
      String(evals.filter((e) => e.trueCategory === t && e.predCategory === p).length).padStart(w));
    console.log(t.padEnd(w) + cells.join(""));
  }

  // The lists that actually drive prompt iteration.
  const fps = evals.filter((e) => e.predSurface && !e.trueSurface);
  const fns = evals.filter((e) => !e.predSurface && e.trueSurface);

  if (fps.length) {
    console.log(`\n══ FALSE POSITIVES — surfaced but not a deal (${fps.length}) — fix these ══`);
    for (const e of fps) {
      console.log(`  • [${e.trueCategory}→${e.predCategory} @${e.cls.confidence.toFixed(2)}] ${trim(e.row.subject, 60)}`);
      console.log(`      from: ${trim(e.row.from, 60)}`);
    }
  }
  if (fns.length) {
    console.log(`\n══ FALSE NEGATIVES — real deal we dropped (${fns.length}) — recall risk ══`);
    for (const e of fns) {
      console.log(`  • [${e.trueCategory}→${e.predCategory} @${e.cls.confidence.toFixed(2)}] ${trim(e.row.subject, 60)}`);
      console.log(`      from: ${trim(e.row.from, 60)}`);
    }
  }

  return { precision, recall, f1, leakRate, tp, fp, fn, tn };
}

function trim(s: string, n: number): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

// ─── Results log ──────────────────────────────────────────────────────────────
// Timestamp is passed in (Date is fine in a plain tsx script) so every run leaves a
// row in docs/plans/classifier-eval-results.md — a durable record of prompt progress.
function appendResults(m: ReturnType<typeof report>, n: number, when: string) {
  const header = `# Classifier eval results\n\n` +
    `Appended by \`server/scripts/evalClassifier.ts\`. Each row = one harness run.\n\n` +
    `| when (UTC) | prompt | fixture | n | precision | recall | F1 | leak |\n` +
    `|---|---|---|---|---|---|---|---|\n`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const row = `| ${when} | \`${PROMPT_HASH}\` | ${path.basename(FIXTURE)} | ${n} | ` +
    `${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${pct(m.leakRate)} |\n`;
  fs.mkdirSync(path.dirname(RESULTS_MD), { recursive: true });
  if (!fs.existsSync(RESULTS_MD)) fs.writeFileSync(RESULTS_MD, header);
  fs.appendFileSync(RESULTS_MD, row);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rows = loadFixtures(FIXTURE);
  console.log(`Fixture: ${path.relative(ROOT, FIXTURE)}`);
  console.log(`Prompt hash: ${PROMPT_HASH}   cache: ${NO_CACHE ? "off" : REFRESH ? "refresh" : "on"}   concurrency: ${CONCURRENCY}`);

  if (rows.length === 0) {
    console.log(
      `\n⚠  No labeled rows found.\n` +
      `   The harness is ready — it needs the M1 dataset. Populate:\n` +
      `     ${path.relative(ROOT, FIXTURE)}\n` +
      `   with the hybrid set (real production false-positives + synthesized hard negatives),\n` +
      `   one JSON object per line. See the header of this file for the format.\n`,
    );
    process.exit(0);
  }

  const evals = await mapPool(rows, CONCURRENCY, async (row): Promise<Evaluated> => {
    const cls = await classifyCached(row);
    const trueSurface = row.label.is_deal ?? SCOREABLE_CATEGORIES.has(row.label.category);
    return {
      row,
      cls,
      predCategory: cls.category,
      predSurface:  surfaces(cls),
      trueCategory: row.label.category,
      trueSurface,
    };
  });

  const m = report(evals);

  // advertiser_domain — identity evidence for brand research (BRAND_IDENTITY_GATE). Exact match required.
  const domainRows = evals.filter((e) => "advertiser_domain" in e.row.label);
  if (domainRows.length) {
    const wrong = domainRows.filter((e) => (e.cls.advertiser_domain ?? null) !== (e.row.label.advertiser_domain ?? null));
    console.log(`\n══ advertiser_domain ══\n  ${domainRows.length - wrong.length}/${domainRows.length} correct`);
    for (const e of wrong) console.log(`  ✗ ${e.row.id}: expected ${e.row.label.advertiser_domain ?? "null"}, got ${e.cls.advertiser_domain ?? "null"}`);
    if (wrong.length) process.exitCode = 1;
  }

  // media_kind — the card label for a request of her (Interview · Podcast · Feature · Op-ed · Cover/spread).
  const kindRows = evals.filter((e) => "media_kind" in e.row.label);
  if (kindRows.length) {
    const wrong = kindRows.filter((e) => (e.cls.media_kind ?? null) !== (e.row.label.media_kind ?? null));
    console.log(`\n══ media_kind ══\n  ${kindRows.length - wrong.length}/${kindRows.length} correct`);
    for (const e of wrong) console.log(`  ✗ ${e.row.id}: expected ${e.row.label.media_kind ?? "null"}, got ${e.cls.media_kind ?? "null"} (${e.cls.category})`);
    if (wrong.length) process.exitCode = 1;
  }
  appendResults(m, evals.length, new Date().toISOString().replace("T", " ").slice(0, 16));

  const pass = m.precision >= MIN_PRECISION && m.recall >= MIN_RECALL;
  console.log(
    `\n${pass ? "✅ PASS" : "❌ BELOW TARGET"} — ` +
    `precision ${(m.precision * 100).toFixed(1)}% (≥${(MIN_PRECISION * 100).toFixed(0)}%), ` +
    `recall ${(m.recall * 100).toFixed(1)}% (≥${(MIN_RECALL * 100).toFixed(0)}%)\n`,
  );
  process.exit(pass && !process.exitCode ? 0 : 1);
}

main().catch((err) => {
  console.error("evalClassifier failed:", err);
  process.exit(2);
});
