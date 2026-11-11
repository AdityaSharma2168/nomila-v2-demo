/**
 * studioQualityS1 — S-1 of quality-scrappy (docs/probes/quality-scrappy.md, ADI-QS-GO): three b-roll directions,
 * each rendered twice on Seedance 2.0-fast — once from today's shared template, once from the Seedance dialect —
 * 4 s, 720x1280, the SAME seed within a pair. Six clips, a blind sheet, a sealed key.
 *
 * ─── WHAT IT MEASURES, AND WHAT IT CANNOT ──────────────────────────────────────────────────────────────
 *
 * P1: Adi picks the dialect as more "shot-like" on ≥ 2 of 3 blind pairs. One pair per direction, one seed per pair —
 * n = 3, a first read, not a result. The seed holds the model's randomness still within a pair, so the prompt is the
 * variable; it does not make a pair's two clips comparable on anything the prompt does not move. Nothing here reads a
 * face (there is none: b-roll is empty by construction) and nothing here is an identity measurement.
 *
 * ─── HOUSE RULES, EACH ONE A SCAR (the Kling probe's, lifted) ────────────────────────────────────────────
 *
 *   • DRY RUN IS THE DEFAULT. `--run` spends; it requires `--cap`, which refuses BEFORE each call, cumulatively, with
 *     `maxJobUsd()` on top. Approved: 6 × $0.3667, cap $2.40 (ADI-QS-GO).
 *   • THE MONEY IS COUNTED BEFORE ANYTHING THAT CAN THROW.
 *   • THE BALANCE IS READ BEFORE THE FIRST CALL (`--skip-balance` to assert it by eye).
 *   • THE PROMPTS ARE THE PRODUCT'S: each arm is compiled by the real planner (`plannedInputs`) with STUDIO_DIALECTS
 *     off and on — never restated here — and the dry run prints both, so what is paid for is what was read.
 *   • THE KEY IS SEALED AND WRITTEN ONCE. The sheet names clips A and B; which arm is which lives only in
 *     `sealed/key.json`, whose sha256 is printed for the ledger before anyone looks. Re-running into a directory that
 *     already holds a key REFUSES — an overwritten key is a lost blind.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   npx tsx server/scripts/studioQualityS1.ts                                  # dry run, $0
 *   npx tsx --env-file=/Users/adi/nomila-v2/.env server/scripts/studioQualityS1.ts --run --cap 2.40
 *
 * Output: probe-out/quality-s1/ (gitignored) — sheet.html, pN-A.mp4 / pN-B.mp4, scores.csv, sealed/key.json,
 * results.json. The API key is read from the environment and never printed or written.
 */
import { createHash, randomInt } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { generate, estimate } from "../studio/router";
import { maxJobUsd } from "../studio/config";
import { plannedInputs } from "../studio/preview";
import type { CreativeBrief } from "../studio/brief";
import type { GenerationInputs, ProviderOpts } from "../studio/types";
import { clipBrief } from "../studio/video/seedance.cells";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const RUN = flag("run");
const CAP_USD = Number(arg("cap", "0"));
const OUT_DIR = arg("out", "probe-out/quality-s1")!;
const SECONDS = 4;

/** Three synthetic b-roll directions — no athlete, brand or handle — each with the chips a real brief would carry. */
const PAIRS: {
  id: string;
  seed: number;
  direction: string;
  shot?: Record<string, string>;
}[] = [
  {
    id: "p1",
    seed: 7101,
    direction: "An empty football stadium at dusk, floodlights on.",
  },
  {
    id: "p2",
    seed: 7102,
    direction: "A running track at dawn, dew on the lanes.",
    shot: { movement: "tracking", lighting: "golden-hour" },
  },
  {
    id: "p3",
    seed: 7103,
    direction: "A quiet locker room, a pair of boots on the bench.",
    shot: { framing: "close", movement: "push-in" },
  },
];

type Arm = "shared" | "dialect";

function briefFor(pair: (typeof PAIRS)[number]): CreativeBrief {
  return clipBrief({
    durationSeconds: SECONDS,
    direction: {
      set: "chosen",
      statement: pair.direction,
      untrusted: false,
      featuredPieces: [],
    },
    ...(pair.shot ? { shot: pair.shot } : {}),
  } as Partial<CreativeBrief["job"]>);
}

/** The product's own compile of one arm: the real planner, the dialect flag off or on, the default b-roll route. */
function compile(pair: (typeof PAIRS)[number], arm: Arm) {
  const was = process.env.STUDIO_DIALECTS;
  if (arm === "dialect") process.env.STUDIO_DIALECTS = "true";
  else delete process.env.STUDIO_DIALECTS;
  try {
    const planned = plannedInputs(briefFor(pair), {});
    if (planned.shotType !== "broll" || !planned.videoRoute)
      throw new Error(
        `${pair.id}/${arm}: not a b-roll clip (${planned.shotType})`,
      );
    const inputs: GenerationInputs = { ...planned.inputs, seed: pair.seed };
    const opts: ProviderOpts = {
      provider: planned.videoRoute.provider,
      model: planned.videoRoute.model,
      providerParams: planned.providerParams,
    };
    return { inputs, opts, model: planned.videoRoute.model };
  } finally {
    if (was === undefined) delete process.env.STUDIO_DIALECTS;
    else process.env.STUDIO_DIALECTS = was;
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

async function assertFunded(quoted: number) {
  if (flag("skip-balance")) {
    console.log("⚠️  --skip-balance: the balance was NOT read.\n");
    return;
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Balance read failed (${res.status}).`);
  const data = (
    JSON.parse(body) as {
      data?: { total_credits?: unknown; total_usage?: unknown };
    }
  ).data;
  if (
    typeof data?.total_credits !== "number" ||
    typeof data?.total_usage !== "number"
  )
    throw new Error(
      "Balance read did not carry numeric total_credits/total_usage — read it by eye, then --skip-balance.",
    );
  const remaining = data.total_credits - data.total_usage;
  console.log(
    `   balance remaining $${remaining.toFixed(4)} · this run quotes $${quoted.toFixed(4)}`,
  );
  if (remaining < quoted)
    throw new Error("The balance does not cover the quote.");
}

function sheetHtml(
  pairs: { id: string; direction: string; shot?: Record<string, string> }[],
): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
    );
  const rows = pairs
    .map(
      (p) =>
        `<section><h2>${p.id}</h2><p class="dir">${esc(p.direction)}${
          p.shot
            ? ` <span class="chips">${esc(
                Object.entries(p.shot)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · "),
              )}</span>`
            : ""
        }</p><div class="pair">${["A", "B"]
          .map(
            (x) =>
              `<figure><video src="${p.id}-${x}.mp4" controls loop muted playsinline></video><figcaption>${x}</figcaption></figure>`,
          )
          .join("")}</div></section>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>S-1 blind sheet</title>
<style>body{font:15px system-ui;margin:24px;max-width:900px}.pair{display:flex;gap:16px}figure{margin:0}video{width:270px;height:480px;background:#000}.dir{color:#444}.chips{color:#888}</style>
<h1>S-1 — which of each pair reads more like a SHOT?</h1>
<p>Same direction, same seed, same model, same length within each pair. Answer A, B or same in scores.csv. Do not open sealed/.</p>
${rows}`;
}

async function main() {
  const cells = PAIRS.flatMap((pair) =>
    (["shared", "dialect"] as Arm[]).map((arm) => ({
      pair,
      arm,
      ...compile(pair, arm),
    })),
  );

  // The two arms must differ, and the shared arm must be what the product sends with the flag off.
  for (const pair of PAIRS) {
    const [a, b] = cells.filter((c) => c.pair.id === pair.id);
    if (a.inputs.prompt === b.inputs.prompt)
      throw new Error(`${pair.id}: both arms compiled the same prompt`);
    if (!b.inputs.prompt.includes("Avoid: "))
      throw new Error(`${pair.id}: the dialect arm is not the dialect`);
  }

  let quoted = 0;
  console.log(`S-1 — ${cells.length} cells\n`);
  for (const c of cells) {
    const plan = estimate("video.generate", c.inputs, c.opts);
    quoted += plan.cost.amountUsd;
    console.log(
      `── ${c.pair.id}/${c.arm} · ${c.model} · ${c.inputs.width}x${c.inputs.height} · ${c.inputs.durationSeconds}s · seed ${c.inputs.seed} · ` +
        `$${plan.cost.amountUsd.toFixed(4)}${plan.cost.unpriced ? " UNPRICED" : ""} · ${c.inputs.prompt.split(/\s+/).filter(Boolean).length} words`,
    );
    console.log(c.inputs.prompt.replace(/^/gm, "   ") + "\n");
  }
  console.log(`quoted total $${quoted.toFixed(4)}`);

  if (!RUN) {
    console.log(
      `\nDRY RUN — nothing spent. To run: --run --cap ${Math.max(quoted, 0).toFixed(2)} (approved cap 2.40)`,
    );
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

  // The blind: which arm is A, per pair, drawn now and written ONCE before anything is generated.
  const key: Record<string, { A: Arm; B: Arm }> = {};
  for (const p of PAIRS)
    key[p.id] =
      randomInt(2) === 0
        ? { A: "shared", B: "dialect" }
        : { A: "dialect", B: "shared" };
  const keyJson = JSON.stringify(key, null, 2);
  await writeFile(keyPath, keyJson, { flag: "wx" });
  console.log(
    `\nsealed key written — sha256 ${createHash("sha256").update(keyJson).digest("hex")}`,
  );

  await assertFunded(quoted);

  const results: Record<string, unknown>[] = [];
  for (const c of cells) {
    const cellId = `${c.pair.id}/${c.arm}`;
    const plan = estimate("video.generate", c.inputs, c.opts);
    assertBudget(cellId, plan.cost.amountUsd, !!plan.cost.unpriced);
    spent += plan.cost.amountUsd; // COUNTED FIRST: past this line a charge may have happened.
    const letter = key[c.pair.id].A === c.arm ? "A" : "B";
    const started = Date.now();
    try {
      const out = await generate("video.generate", c.inputs, c.opts);
      const asset = out.assets[0];
      const file = join(OUT_DIR, `${c.pair.id}-${letter}.mp4`);
      if (asset?.bytes) await writeFile(file, asset.bytes);
      results.push({
        cell: cellId,
        letter,
        quotedUsd: plan.cost.amountUsd,
        costUsd: out.cost.amountUsd,
        costBasis: out.cost.basis,
        stored: !!asset?.bytes,
        outputRef: asset?.url?.split("?")[0] ?? null,
        ms: Date.now() - started,
      });
      console.log(
        `   ${cellId} → ${letter}: $${out.cost.amountUsd.toFixed(4)} (${out.cost.basis})${asset?.bytes ? "" : " — BILLED, NOT STORED"}`,
      );
    } catch (err) {
      results.push({
        cell: cellId,
        letter,
        quotedUsd: plan.cost.amountUsd,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(
        `   ${cellId} → ${letter}: FAILED — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await writeFile(
    join(sealedDir, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await writeFile(join(OUT_DIR, "sheet.html"), sheetHtml(PAIRS));
  await writeFile(
    join(OUT_DIR, "scores.csv"),
    "pair,pick (A|B|same),note\n" +
      PAIRS.map((p) => `${p.id},,`).join("\n") +
      "\n",
  );
  console.log(
    `\nspent (counted at quote) $${spent.toFixed(4)} · sheet ${join(OUT_DIR, "sheet.html")}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
