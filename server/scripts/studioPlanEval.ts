/**
 * studioPlanEval — the plan eval: the fixed brief set through the LIVE planner on the REAL library,
 * recorded, sheeted for blind judging, and revealed against the key (docs/probes/plan-eval.md).
 *
 * $0 of generation. What it spends is planner calls — Gemini Pro, a few cents each — bounded by
 * --max-calls (default 80 ≈ one full pass at n=3 with room), and printed as tokens at the end so
 * per-call drift gets noticed. Two embeddings per brief the first time a library is recorded.
 *
 *   DOTENV_CONFIG_PATH=/path/to/.env npx tsx --require dotenv/config server/scripts/studioPlanEval.ts
 *       dry run (default): records the libraries if needed, builds every prompt, prints sizes and the
 *       call count. Sends nothing to the planner.
 *   … --run --label baseline --n 3
 *       runs. Writes probe-out/plan-eval/runs/<label>-<date>-<fingerprint>.json.
 *   … --run --label doctrine --n 5 --only adidas-ad,hype
 *       the escalation path: just the ambiguous briefs, more repeats.
 *   … --sheet probe-out/plan-eval/runs/A.json probe-out/plan-eval/runs/B.json --name baseline-vs-doctrine
 *       writes probe-out/plan-eval/sheets/<name>/{sheet.html,key.json,scores.csv}. Score, then:
 *   … --reveal probe-out/plan-eval/sheets/<name>
 *       prints the markdown for the ledger and writes reveal.md beside the sheet.
 *
 * Other flags: --athlete <id> (default: Adi's own row), --product <assetId> (the product for briefs
 * that pick one; loaded through the caster's own door), --refresh-library (re-record; the recorded
 * libraries are what make two runs comparable, so this is deliberate), --seed <n> for the shuffle.
 *
 * READ-ONLY on the database: the caster's predicate, searchMedia, the scene ranking and the clip
 * list — the calls the route makes. Nothing is written anywhere but probe-out/.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
/** Every value after --name until the next flag. */
function args(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return [];
  const out: string[] = [];
  for (
    let j = i + 1;
    j < process.argv.length && !process.argv[j].startsWith("--");
    j++
  )
    out.push(process.argv[j]);
  return out;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const SHEET = args("sheet");
const REVEAL = arg("reveal");
const LABEL = arg("label", "baseline")!;
const N = Number(arg("n", "3"));
const MAX_CALLS = Number(arg("max-calls", "80"));
const ONLY =
  arg("only")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? null;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const PRODUCT_ID = arg("product") ?? null;
const REFRESH = flag("refresh-library");
const SEED = Number(arg("seed", "20260922"));
const OUT = arg("out", "probe-out/plan-eval")!;
/**
 * Which recording of the libraries a run uses. Two arms that differ in what the caster OFFERS (the
 * camera-first clip listing) record under different names so the prompt-only arm can run on the
 * baseline's exact lines. Recorded once per set; the run file names the set.
 */
const LIBRARY_SET = arg("library-set", "default")!;
const LIB_DIR = join(OUT, "library", LIBRARY_SET);

const gitSha = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
};

// ─── Libraries: recorded once per brief, reused by every run ────────────────────────────────────

async function recordLibrary(briefId: string, refresh: boolean) {
  const { EVAL_BRIEFS } = await import("../studio/agent/eval/briefs");
  const brief = EVAL_BRIEFS.find((b) => b.id === briefId)!;
  const path = join(LIB_DIR, `${briefId}.json`);
  if (!refresh && existsSync(path)) {
    const rec = JSON.parse(await readFile(path, "utf8"));
    return rec as import("../studio/agent/eval/runs").RecordedLibrary;
  }
  const { assembleLibrary } = await import("../studio/agent/library");
  const { loadCastable } = await import("../studio/agent/cast");
  const productIds =
    brief.product && PRODUCT_ID ? [PRODUCT_ID.toLowerCase()] : [];
  const named = await loadCastable(ATHLETE_ID, productIds);
  if (productIds.some((id) => !named.has(id)))
    throw new Error(
      `--product ${PRODUCT_ID} is not one of this athlete's photographs`,
    );
  if (productIds.some((id) => named.get(id)!.mediaType === "clip"))
    throw new Error(`--product ${PRODUCT_ID} is a clip; a product is a photo`);
  const { library } = await assembleLibrary(ATHLETE_ID, {
    prompt: brief.prompt,
    picked: [],
    productIds,
    named,
  });
  const rec: import("../studio/agent/eval/runs").RecordedLibrary = {
    briefId,
    recordedAt: new Date().toISOString(),
    entries: library,
    products: productIds.map((id, i) => ({
      ref: `p${i + 1}`,
      description: String(named.get(id)!.vision?.description ?? ""),
    })),
    productGiven: !brief.product || productIds.length > 0,
  };
  await mkdir(LIB_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(rec, null, 2));
  return rec;
}

// ─── Dry run / run ──────────────────────────────────────────────────────────────────────────────

async function runOrDry() {
  const { EVAL_BRIEFS } = await import("../studio/agent/eval/briefs");
  const { agentPrompt, PLAN_TEMPERATURE } = await import(
    "../studio/agent/plan"
  );
  const { agentModel, agentThinking } = await import("../studio/agent/config");
  const { promptFingerprint } = await import("../studio/agent/eval/runs");
  type RunFile = import("../studio/agent/eval/runs").RunFile;
  type PlanAsk = import("../studio/agent/types").PlanAsk;

  const briefs = EVAL_BRIEFS.filter((b) => !ONLY || ONLY.includes(b.id));
  if (ONLY && briefs.length !== ONLY.length)
    throw new Error(
      `--only names a brief that does not exist: ${ONLY.join(",")}`,
    );
  if (!(N >= 1) || !Number.isInteger(N))
    throw new Error("--n must be a positive integer");
  const planned = briefs.length * N;
  const fingerprint = promptFingerprint();
  const model = agentModel();
  console.log(
    `${RUN ? `LIVE — label ${LABEL}, cap ${MAX_CALLS} calls` : "DRY RUN — nothing is sent"}`,
  );
  console.log(
    `model ${model} · temperature ${PLAN_TEMPERATURE} · thinking ${JSON.stringify(agentThinking() ?? null)} · prompt ${fingerprint} · git ${gitSha()}`,
  );
  console.log(
    `${briefs.length} briefs × n=${N} = ${planned} planner calls · library set "${LIBRARY_SET}"\n`,
  );
  if (RUN && planned > MAX_CALLS)
    throw new Error(
      `${planned} calls would exceed --max-calls ${MAX_CALLS}; lower --n, use --only, or raise the cap on purpose`,
    );

  const libraries: RunFile["libraries"] = {};
  const asks = new Map<string, PlanAsk>();
  for (const b of briefs) {
    const rec = await recordLibrary(b.id, REFRESH);
    libraries[b.id] = rec;
    const ask: PlanAsk = {
      prompt: b.prompt,
      objective: b.objective,
      ...(b.aesthetic ? { aesthetic: b.aesthetic } : {}),
      library: rec.entries,
      products: rec.products,
    };
    asks.set(b.id, ask);
    const her = rec.entries.filter(
      (e) => e.mediaType === "photo" && e.athletePresent,
    ).length;
    const scenes = rec.entries.filter(
      (e) => e.mediaType === "photo" && !e.athletePresent,
    ).length;
    const clips = rec.entries.filter((e) => e.mediaType === "clip").length;
    const stitched = rec.entries.filter(
      (e) => e.provenance === "stitched-here",
    ).length;
    const cameraClips = rec.entries.filter(
      (e) => e.mediaType === "clip" && e.provenance === "camera",
    ).length;
    const prompt = agentPrompt(ask);
    console.log(
      `${b.id.padEnd(18)} lib ${String(rec.entries.length).padStart(2)} (her ${her}, scenes ${scenes}, clips ${clips} of which camera ${cameraClips}, stitched ${stitched})` +
        ` · products ${rec.products.length}${b.product && !rec.productGiven ? " ⚠️ brief picks a product, none given (--product)" : ""}` +
        ` · prompt ${prompt.length} chars · recorded ${rec.recordedAt.slice(0, 10)}`,
    );
  }
  if (!RUN) {
    console.log(
      `\nDry run complete. ${planned} calls would be made — through the route, with studioPlanRoute.ts.`,
    );
    return;
  }
  // FENCED (PR 6, docs/probes/capabilities.md): this runner called derivePlan in-process, so its cells
  // never went through castPlan — no A1b, A2, S1, S1b, no camera-first order — and it dropped `sport`
  // from the ask. A cell here counted what the gates would have refused (the probe/route divergence,
  // docs/probes/c3-doctrine2.md:9-16). Model cells go through the real route: server/scripts/studioPlanRoute.ts.
  throw new Error(
    "studioPlanEval --run is fenced: planner cells go through the route (server/scripts/studioPlanRoute.ts). " +
      `Dry run, --sheet and --reveal still work. ${planned} call(s) not sent.`,
  );
}

// ─── Sheet ──────────────────────────────────────────────────────────────────────────────────────

async function sheet() {
  const { assignCodes, renderSheet, scoresTemplate } = await import(
    "../studio/agent/eval/sheet"
  );
  const { libraryLine, productLine } = await import("../studio/agent/plan");
  type RunFile = import("../studio/agent/eval/runs").RunFile;
  type RawCell = import("../studio/agent/eval/sheet").RawCell;
  const name = arg("name");
  if (!name) throw new Error("--sheet needs --name <dir name>");
  /** Only these briefs from each run — so a targeted re-run is scored against the same briefs of a full one. */
  const only =
    arg("briefs")
      ?.split(",")
      .map((b) => b.trim())
      .filter(Boolean) ?? null;
  const raw: RawCell[] = [];
  const runs: Record<string, string> = {};
  for (const p of SHEET) {
    const run = JSON.parse(await readFile(p, "utf8")) as RunFile;
    runs[run.meta.id] = p;
    for (const c of run.cells) {
      if (only && !only.includes(c.briefId)) continue;
      const lib = run.libraries[c.briefId];
      raw.push({
        briefId: c.briefId,
        prompt: await briefPrompt(c.briefId),
        objective: await briefObjective(c.briefId),
        aesthetic: await briefAesthetic(c.briefId),
        libraryLines: lib.entries.map(libraryLine),
        productLines: lib.products.map(productLine),
        // A run recorded before the gap line existed has plans without `gaps`; read them as none.
        plan: c.plan ? { ...c.plan, gaps: c.plan.gaps ?? [] } : null,
        source: { run: run.meta.id, repeat: c.repeat },
      });
    }
  }
  const { cells, key } = assignCodes(raw, SEED);
  const dir = join(OUT, "sheets", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sheet.html"), renderSheet(cells));
  await writeFile(
    join(dir, "key.json"),
    JSON.stringify({ runs, key }, null, 2),
  );
  const scoresPath = join(dir, "scores.csv");
  if (existsSync(scoresPath))
    console.log(
      `scores.csv already exists — left alone (delete it to start over)`,
    );
  else await writeFile(scoresPath, scoresTemplate(cells.map((c) => c.code)));
  console.log(
    `blind sheet → ${join(dir, "sheet.html")}  (${cells.length} cells from ${Object.keys(runs).length} run(s))`,
  );
  console.log(`scores     → ${scoresPath}`);
  console.log(`key (do not open until scored) → ${join(dir, "key.json")}`);
}
const briefField = async (id: string) =>
  (await import("../studio/agent/eval/briefs")).briefById(id);
const briefPrompt = async (id: string) => (await briefField(id))?.prompt ?? id;
const briefObjective = async (id: string) =>
  (await briefField(id))?.objective ?? "?";
const briefAesthetic = async (id: string) => (await briefField(id))?.aesthetic;

// ─── Reveal ─────────────────────────────────────────────────────────────────────────────────────

async function revealSheet(dir: string) {
  const { parseScores, reveal, revealMarkdown } = await import(
    "../studio/agent/eval/reveal"
  );
  const { planMetrics } = await import("../studio/agent/eval/metrics");
  type RunFile = import("../studio/agent/eval/runs").RunFile;
  const { runs, key } = JSON.parse(
    await readFile(join(dir, "key.json"), "utf8"),
  ) as {
    runs: Record<string, string>;
    key: Record<string, { run: string; briefId: string; repeat: number }>;
  };
  const scores = parseScores(await readFile(join(dir, "scores.csv"), "utf8"));
  const loaded = new Map<string, RunFile>();
  for (const [id, p] of Object.entries(runs))
    loaded.set(id, JSON.parse(await readFile(p, "utf8")));
  const metrics: Record<string, ReturnType<typeof planMetrics>> = {};
  for (const [code, k] of Object.entries(key)) {
    const run = loaded.get(k.run)!;
    const cell = run.cells.find(
      (c) => c.briefId === k.briefId && c.repeat === k.repeat,
    )!;
    metrics[code] = planMetrics(
      cell.plan ? { ...cell.plan, gaps: cell.plan.gaps ?? [] } : null,
      run.libraries[k.briefId].entries,
    );
  }
  const r = reveal({ key, scores, metrics });
  const md = [
    `## Reveal — ${basename(dir)}`,
    "",
    ...[...loaded.values()].map(
      (f) =>
        `- \`${f.meta.id}\`: git ${f.meta.gitSha}, prompt ${f.meta.promptFingerprint}, ${f.meta.model} @ ${f.meta.temperature}, n=${f.meta.n}, ${f.meta.calls} calls, tokens ${f.meta.inputTokens}/${f.meta.outputTokens}`,
    ),
    "",
    revealMarkdown(r),
  ].join("\n");
  await writeFile(join(dir, "reveal.md"), md);
  console.log(md);
  console.log(`\nreveal → ${join(dir, "reveal.md")}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────────────────────

(async () => {
  if (REVEAL) return revealSheet(REVEAL);
  if (SHEET.length) return sheet();
  return runOrDry();
})().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
