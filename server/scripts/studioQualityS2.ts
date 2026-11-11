/**
 * studioQualityS2 — S-2 of quality-scrappy (docs/probes/quality-scrappy.md, ADI-QS-3 / ADI-QS-5 (5)): eight blind pairs
 * on Gemini 3 Pro Image — four generates, four edits — each rendered once from today's prompt and once from the Gemini
 * image dialect (STUDIO_DIALECTS, compile/geminiDialect.ts), with the SAME inputs within a pair.
 *
 * ─── WHAT IT MEASURES, AND WHAT IT CANNOT ──────────────────────────────────────────────────────────────
 *
 * P7c–P7e: which of a pair Adi picks, blind. n = 8, a first read. THERE IS NO SEED on this target (the manifest has it
 * unverified, and the adapter sends none), so the two images of a pair differ by the model's chance as well as by the
 * prompt — a "same" or a pick can be chance. Nothing here reads a face or scores identity (Mia's decision).
 *
 * ─── HOUSE RULES (S-1's, lifted) ─────────────────────────────────────────────────────────────────────────
 *
 *   • DRY RUN IS THE DEFAULT, and $0: it reads her rows, builds the briefs and prints both arms' prompts and quotes.
 *     `--run` spends and requires `--cap`, checked BEFORE each call, cumulatively, with `maxJobUsd()` on top.
 *     Approved: cap $4.50 (ADI-QS-5 (5)).
 *   • THE MONEY IS COUNTED BEFORE ANYTHING THAT CAN THROW.
 *   • THE PROMPTS ARE THE PRODUCT'S: each arm is the real planner (`plannedInputs`) with STUDIO_DIALECTS off and on,
 *     under the master flag as dev runs it; each run is the product's own `runGeneration` with its own stored-
 *     reference resolver (her photos straightened, a frame oriented) — no job row, no asset row, nothing written to
 *     her library. The dry run asserts the two arms differ and that the dialect arm carries the dialect.
 *   • HER ROWS ONLY, READ ONLY. Every input is read under her athlete id; nothing is written to the database.
 *   • THE KEY IS SEALED AND WRITTEN ONCE (`sealed/key.json`, flag "wx"); its sha256 is printed for the ledger.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   npx tsx --env-file=/Users/adi/nomila-v2/.env server/scripts/studioQualityS2.ts                 # dry run, $0
 *   npx tsx --env-file=/Users/adi/nomila-v2/.env server/scripts/studioQualityS2.ts --run --cap 4.50
 *   … --rerun p4 [--run --cap 0.26]      # fill the one image a pair is missing, its arm kept sealed
 *
 * Output: probe-out/quality-s2/ (gitignored) — sheet.html, pN-A.png / pN-B.png, scores.csv, sealed/key.json,
 * sealed/results.json.
 */
import { createHash, randomInt } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { mediaAssets } from "../../shared/schema";
import { readObject } from "../lib/mediaStore";
import { maxJobUsd } from "../studio/config";
import {
  assembleBrief,
  type CreativeBrief,
  type EditRegion,
  type JobReference,
  type SourceAsset,
} from "../studio/brief";
import {
  plannedInputs,
  previewGeneration,
  runGeneration,
} from "../studio/preview";
import { resolveStoredReference } from "../studio/generate";
import { freezeEditIntent } from "../studio/nativeIntent";
import { resolveStyleReference } from "../studio/reference/styleStore";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const RUN = flag("run");
const CAP_USD = Number(arg("cap", "0"));
const OUT_DIR = arg("out", "probe-out/quality-s2")!;

/** The test athlete's row (docs: athlete-library-is-several-women — the maroon-kit woman's photos are hers). */
const HER = "3811cedd-ec59-44b0-b613-b39d03f9d5ca";
/** Her photos, by id prefix, chosen by eye (ledger, S-2): the maroon-kit pack, a frame, a product, an object, a look. */
const PHOTOS = {
  pack: ["5581e882", "d47dad12", "b2d6edcd"],
  frame: "d47dad12",
  product: "e64e900a", // a soccer ball
  object: "9677d97e", // gold hoop earrings
  style: "2e0593c6", // a warm, grainy film photograph of a pitch at dusk
} as const;
const ADIDAS_BRAND_ID = 52;

type Arm = "today" | "dialect";
interface Cell {
  id: string;
  what: string;
  brief: CreativeBrief;
}

async function ownedRow(prefix: string) {
  const [row] = await db
    .select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, HER),
        sql`${mediaAssets.id}::text like ${`${prefix}%`}`,
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.deleted_at),
      ),
    );
  if (!row?.gcs_path)
    throw new Error(`${prefix}: not one of her stored photos`);
  return row as { id: string; gcs_path: string };
}

const ref = async (
  prefix: string,
  role: JobReference["role"],
  label: string,
): Promise<JobReference> => {
  const row = await ownedRow(prefix);
  return { role, ref: row.gcs_path, mediaAssetId: row.id, label };
};

/** The frame as the route's resolveSource measures it: upright pixel dimensions and its EXIF orientation. */
async function sourceOf(prefix: string): Promise<SourceAsset> {
  const row = await ownedRow(prefix);
  const obj = await readObject(row.gcs_path, 80 * 1024 * 1024);
  if (!obj) throw new Error(`${prefix}: unreadable`);
  const m = await sharp(obj.buf).metadata();
  const turned = (m.orientation ?? 1) >= 5;
  return {
    mediaAssetId: row.id,
    ref: row.gcs_path,
    width: (turned ? m.height : m.width) ?? null,
    height: (turned ? m.width : m.height) ?? null,
    editRegions: [],
    ...(m.orientation && m.orientation !== 1
      ? { orientation: m.orientation }
      : {}),
  };
}

const generateBrief = (
  direction: string,
  references: JobReference[],
  brandId: number | null = null,
) =>
  assembleBrief({
    athleteId: HER,
    brandId,
    origin: "system",
    objective: "grow-following",
    deliverable: "post",
    mode: "generate",
    direction,
    references,
  });

/**
 * The jacket in the frame, in its own pixels — standing in for the box the route's DETECTION would derive for a recolour
 * (routes/studio.ts resolveSource, a Flash call this run does not make). A native edit's prompt never reads it: the
 * region only answers the planner's "nothing to bound the edit to" gap, as a derived one does. Placed by eye.
 */
const JACKET: EditRegion = {
  label: "jacket",
  left: 1232,
  top: 2674,
  width: 1841,
  height: 2311,
};

/** An edit, frozen as the preview route's rules freeze it (compile/golden.test.ts `said`) — no model call. */
async function editBrief(
  ask: string,
  references: JobReference[],
  regions: EditRegion[] = [],
) {
  const source = { ...(await sourceOf(PHOTOS.frame)), editRegions: regions };
  const frozen = freezeEditIntent({
    ask,
    origin: "system",
    source,
    references,
  });
  if (!frozen.ok) throw new Error(`"${ask}" did not freeze: ${frozen.reason}`);
  const brief = await assembleBrief({
    athleteId: HER,
    brandId: null,
    origin: "system",
    objective: "grow-following",
    deliverable: "post",
    mode: "edit",
    source,
    direction: ask,
    references,
  });
  return {
    ...brief,
    job: { ...brief.job, editIntent: frozen.intent },
  } as CreativeBrief;
}

async function cells(): Promise<Cell[]> {
  const pack = await Promise.all(
    PHOTOS.pack.map((p) => ref(p, "person", "me")),
  );
  const product = await ref(PHOTOS.product, "product", "soccer ball");
  const hoops = await ref(PHOTOS.object, "object", "gold hoops");
  const styleRow = await ownedRow(PHOTOS.style);
  const style = await resolveStyleReference(HER, styleRow.id, styleRow);
  if (!style.ok) throw new Error(`style reference: ${style.reason}`);
  return [
    {
      id: "p1",
      what: "generate · nothing attached",
      brief: await generateBrief(
        "Mid-stride on an empty pitch at golden hour, the ball at her feet.",
        [],
      ),
    },
    {
      id: "p2",
      what: "generate · her pack (3)",
      brief: await generateBrief(
        "Celebrating a goal, arms wide, stadium floodlights behind her.",
        pack,
      ),
    },
    {
      id: "p3",
      what: "generate · her pack + a product",
      brief: await generateBrief(
        "Juggling the ball on a training pitch at dusk.",
        [...pack, product],
      ),
    },
    {
      id: "p4",
      what: "generate · a brand + one photo",
      brief: await generateBrief(
        "A clean campaign portrait on the touchline.",
        [pack[0]],
        ADIDAS_BRAND_ID,
      ),
    },
    {
      id: "p5",
      what: "edit · recolour, the frame only",
      brief: await editBrief("make my jacket black", [], [JACKET]),
    },
    {
      id: "p6",
      what: "edit · her object photo, added",
      brief: await editBrief("add these gold hoops to my ears", [hoops]),
    },
    {
      id: "p7",
      what: "edit · a headline",
      brief: await editBrief('add the headline "GAME DAY" across the top', []),
    },
    {
      id: "p8",
      what: "edit · match a look",
      brief: await editBrief("match this look", [
        style.reference as JobReference,
      ]),
    },
  ];
}

/** Run `f` with the dialect off or on, under the master flag as dev has it. Sequential only. */
async function asArm<T>(arm: Arm, f: () => T | Promise<T>): Promise<T> {
  const was = { d: process.env.STUDIO_DIALECTS, m: process.env.STUDIO_ALL_ON };
  process.env.STUDIO_ALL_ON = "true";
  if (arm === "dialect") process.env.STUDIO_DIALECTS = "true";
  else delete process.env.STUDIO_DIALECTS;
  try {
    return await f();
  } finally {
    for (const [k, env] of [
      ["d", "STUDIO_DIALECTS"],
      ["m", "STUDIO_ALL_ON"],
    ] as const)
      if (was[k] === undefined) delete process.env[env];
      else process.env[env] = was[k];
  }
}

let spent = 0;
function assertBudget(cell: string, amount: number, unpriced: boolean) {
  if (unpriced)
    throw new Error(
      `${cell}: quotes UNPRICED — refusing to spend an unknown as $0.`,
    );
  if (amount > maxJobUsd())
    throw new Error(
      `${cell}: $${amount.toFixed(4)} is over maxJobUsd $${maxJobUsd().toFixed(2)}.`,
    );
  if (spent + amount > CAP_USD + 1e-9)
    throw new Error(
      `${cell}: $${(spent + amount).toFixed(4)} cumulative is over the --cap $${CAP_USD.toFixed(2)}. Stopping BEFORE the call.`,
    );
}

function sheetHtml(
  list: { id: string; what: string; direction: string }[],
): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
    );
  const rows = list
    .map(
      (c) =>
        `<section><h2>${c.id} <small>${esc(c.what)}</small></h2><p class="dir">${esc(c.direction)}</p><div class="pair">${[
          "A",
          "B",
        ]
          .map(
            (x) =>
              `<figure><img src="${c.id}-${x}.png"><figcaption>${x}</figcaption></figure>`,
          )
          .join("")}</div></section>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>S-2 blind sheet</title>
<style>body{font:15px system-ui;margin:24px;max-width:1000px}.pair{display:flex;gap:16px}figure{margin:0}img{width:420px;background:#000}.dir{color:#444}small{color:#888;font-weight:normal}</style>
<h1>S-2 — which of each pair is the better image for what was asked?</h1>
<p>Same inputs within each pair; no seed on this model, so a pair also differs by chance. Answer A, B or same in scores.csv. Do not open sealed/.</p>
${rows}`;
}

async function main() {
  // Dev runs under the master (gcp/cloud-run-dev.yaml STUDIO_ALL_ON), so the briefs are frozen under it too — the
  // image ops that route "match this look", the headline, the style spec. Only STUDIO_DIALECTS (opt-in) differs by arm.
  process.env.STUDIO_ALL_ON = "true";
  const list = await cells();
  const compiled: {
    cell: Cell;
    arm: Arm;
    prompt: string;
    quote: number;
    unpriced: boolean;
  }[] = [];
  for (const cell of list)
    for (const arm of ["today", "dialect"] as Arm[]) {
      const { prompt, quote, unpriced, blockers } = await asArm(arm, () => {
        const p = previewGeneration(cell.brief, {});
        return {
          prompt: plannedInputs(cell.brief, {}).inputs.prompt,
          quote: p.cost?.amountUsd ?? 0,
          unpriced: p.unpriced || !p.cost,
          blockers: p.blockers.map((b) => `${b.field}: ${b.note}`),
        };
      });
      if (blockers.length)
        throw new Error(
          `${cell.id}/${arm} is blocked — ${blockers.join(" | ")}`,
        );
      compiled.push({ cell, arm, prompt, quote, unpriced });
    }

  // The two arms must differ, and the dialect arm must carry the dialect's canvas sentence.
  for (const cell of list) {
    const [a, b] = compiled.filter((c) => c.cell.id === cell.id);
    if (a.prompt === b.prompt)
      throw new Error(`${cell.id}: both arms compiled the same prompt`);
    if (
      !/ (image|shape)\./.test(b.prompt) ||
      !/\d+:\d+ (portrait|landscape|square)/.test(b.prompt)
    )
      throw new Error(`${cell.id}: the dialect arm does not state its canvas`);
  }

  const rerun = arg("rerun");
  if (rerun) return rerunOne(rerun, compiled);

  let quoted = 0;
  console.log(`S-2 — ${compiled.length} generations\n`);
  for (const c of compiled) {
    quoted += c.quote;
    console.log(
      `── ${c.cell.id}/${c.arm} · ${c.cell.what} · $${c.quote.toFixed(4)}${c.unpriced ? " UNPRICED" : ""}`,
    );
    console.log(c.prompt.replace(/^/gm, "   ") + "\n");
  }
  console.log(`quoted total $${quoted.toFixed(4)}`);
  if (!RUN) {
    console.log(`\nDRY RUN — nothing spent. To run: --run --cap 4.50`);
    return;
  }
  if (!(CAP_USD > 0))
    throw new Error(
      "--run requires --cap <usd>. Refusing to spend without a ceiling.",
    );
  if (CAP_USD + 1e-9 < quoted)
    throw new Error(
      `--cap $${CAP_USD.toFixed(2)} is under the quoted $${quoted.toFixed(4)}.`,
    );

  const sealedDir = join(OUT_DIR, "sealed");
  const keyPath = join(sealedDir, "key.json");
  if (existsSync(keyPath))
    throw new Error(
      `${keyPath} already exists — refusing to overwrite a sealed key.`,
    );
  await mkdir(sealedDir, { recursive: true });
  const key: Record<string, { A: Arm; B: Arm }> = {};
  for (const c of list)
    key[c.id] =
      randomInt(2) === 0
        ? { A: "today", B: "dialect" }
        : { A: "dialect", B: "today" };
  const keyJson = JSON.stringify(key, null, 2);
  await writeFile(keyPath, keyJson, { flag: "wx" });
  console.log(
    `\nsealed key written — sha256 ${createHash("sha256").update(keyJson).digest("hex")}`,
  );

  const results: Record<string, unknown>[] = [];
  for (const c of compiled) {
    const cellId = `${c.cell.id}/${c.arm}`;
    assertBudget(cellId, c.quote, c.unpriced);
    spent += c.quote; // COUNTED FIRST: past this line a charge may have happened.
    const letter = key[c.cell.id].A === c.arm ? "A" : "B";
    const started = Date.now();
    try {
      const out = await asArm(c.arm, async () => {
        // The prompt that runs must be the one printed: the planner is re-run inside runGeneration.
        if (plannedInputs(c.cell.brief, {}).inputs.prompt !== c.prompt)
          throw new Error(
            "the compiled prompt drifted between the dry run and the call",
          );
        return runGeneration(c.cell.brief, {
          resolveReference: (r) => resolveStoredReference(r, c.cell.brief),
        });
      });
      const asset = out.assets[0];
      if (asset?.bytes)
        await writeFile(
          join(OUT_DIR, `${c.cell.id}-${letter}.png`),
          Buffer.from(asset.bytes),
        );
      results.push({
        cell: cellId,
        letter,
        quotedUsd: c.quote,
        costUsd: out.cost.amountUsd,
        costBasis: out.cost.basis,
        stored: !!asset?.bytes,
        ms: Date.now() - started,
      });
      console.log(
        `   ${c.cell.id} done: $${out.cost.amountUsd.toFixed(4)} (${out.cost.basis})${asset?.bytes ? "" : " — BILLED, NOT STORED"}`,
      );
    } catch (err) {
      results.push({
        cell: cellId,
        letter,
        quotedUsd: c.quote,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(
        `   ${c.cell.id}: FAILED — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await writeFile(
    join(sealedDir, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await writeFile(
    join(OUT_DIR, "sheet.html"),
    sheetHtml(
      list.map((c) => ({
        id: c.id,
        what: c.what,
        direction: c.brief.job.direction.statement,
      })),
    ),
  );
  await writeFile(
    join(OUT_DIR, "scores.csv"),
    "pair,pick (A|B|same),note\n" +
      list.map((c) => `${c.id},,`).join("\n") +
      "\n",
  );
  console.log(
    `\nspent (counted at quote) $${spent.toFixed(4)} · sheet ${join(OUT_DIR, "sheet.html")}`,
  );
}

/**
 * RE-RUN ONE IMAGE THE RUN COULD NOT FILL (Adi's approval: p4, cap $0.26). The letter is the one with no image; its
 * arm is read from the sealed key and NEVER printed, so the pair stays blind for his separate score. The prompt is
 * re-compiled exactly as the run compiled it and written beside the key, to be checked against the run's own before
 * anyone reads it as the same cell. One call, capped before it is made; a refusal is reported, never retried.
 */
async function rerunOne(
  pair: string,
  compiled: {
    cell: Cell;
    arm: Arm;
    prompt: string;
    quote: number;
    unpriced: boolean;
  }[],
) {
  const sealedDir = join(OUT_DIR, "sealed");
  const keyPath = join(sealedDir, "key.json");
  if (!existsSync(keyPath))
    throw new Error("--rerun needs the run's sealed key.");
  const key = JSON.parse(await readFile(keyPath, "utf8")) as Record<
    string,
    { A: Arm; B: Arm }
  >;
  if (!key[pair]) throw new Error(`${pair}: not a pair of this run`);
  const missing = (["A", "B"] as const).filter(
    (l) => !existsSync(join(OUT_DIR, `${pair}-${l}.png`)),
  );
  if (missing.length !== 1)
    throw new Error(
      `${pair}: ${missing.length} images missing — a re-run fills exactly one`,
    );
  const letter = missing[0];
  const c = compiled.find(
    (x) => x.cell.id === pair && x.arm === key[pair][letter],
  )!;
  await writeFile(join(sealedDir, `${pair}-rerun-prompt.txt`), c.prompt);
  console.log(
    `${pair}-${letter}: $${c.quote.toFixed(4)} quoted${c.unpriced ? " UNPRICED" : ""}`,
  );
  if (!RUN) {
    console.log(
      "DRY RUN — nothing spent. The prompt is written beside the sealed key.",
    );
    return;
  }
  if (!(CAP_USD > 0)) throw new Error("--run requires --cap <usd>.");
  assertBudget(`${pair}-${letter}`, c.quote, c.unpriced);
  spent += c.quote; // COUNTED FIRST
  const started = Date.now();
  const resultsPath = join(sealedDir, "results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8")) as Record<
    string,
    unknown
  >[];
  try {
    const out = await asArm(c.arm, () =>
      runGeneration(c.cell.brief, {
        resolveReference: (r) => resolveStoredReference(r, c.cell.brief),
      }),
    );
    const asset = out.assets[0];
    if (asset?.bytes)
      await writeFile(
        join(OUT_DIR, `${pair}-${letter}.png`),
        Buffer.from(asset.bytes),
      );
    results.push({
      cell: `${pair}/${c.arm}`,
      letter,
      rerun: true,
      quotedUsd: c.quote,
      costUsd: out.cost.amountUsd,
      costBasis: out.cost.basis,
      stored: !!asset?.bytes,
      ms: Date.now() - started,
    });
    console.log(
      `${pair}-${letter}: done $${out.cost.amountUsd.toFixed(4)} (${out.cost.basis})${asset?.bytes ? "" : " — BILLED, NOT STORED"}`,
    );
  } catch (err) {
    results.push({
      cell: `${pair}/${c.arm}`,
      letter,
      rerun: true,
      quotedUsd: c.quote,
      error: err instanceof Error ? err.message : String(err),
    });
    console.log(
      `${pair}-${letter}: FAILED — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await writeFile(resultsPath, JSON.stringify(results, null, 2));
  console.log(`spent (counted at quote) $${spent.toFixed(4)}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
