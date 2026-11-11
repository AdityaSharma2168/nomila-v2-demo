/**
 * studioPlanRoute — the plan eval THROUGH THE REAL ROUTE: POST /studio/agent/plan on a running server
 * (this worktree's, started by Adi), n cells per brief, each cell's cast slots recorded with whole
 * asset ids and tabled as camera / i2v / held / b-roll counts (studio/agent/eval/routeCell).
 *
 * Why the route and not derivePlan: the route runs castPlan, and castPlan is where the gates live
 * (A1b, A2, S1, S1b, the camera-first order). A count taken before it is a count of what the gates
 * would have refused — the probe/route divergence of docs/probes/c3-doctrine2.md:9-16. The in-process
 * runner's model path (studioPlanEval.ts --run) is fenced for that reason.
 *
 *   DOTENV_CONFIG_PATH=.env npx tsx --require dotenv/config server/scripts/studioPlanRoute.ts \
 *       --brief acceptance-recap --n 3 --label recap-base            dry: prints what would be sent
 *   … --run --max-calls 3                                              sends
 *   … --prompt "a soccer ad with me in it" --id ad-brief --n 5 --run   an ad-hoc brief (objective
 *                                                                        defaults to grow-following,
 *                                                                        the Agent screen's default)
 *   … --body extra.json                                                merged into every request body
 *
 * Spends one planner call per cell (≈ $0.071–0.075, docs/probes/ingest-flip.md:185-199) and nothing
 * else: no preview rows, no generation. --max-calls is the hard stop (default: n). The bearer token is
 * read from probe-out/<dir>/.token and never printed. Writes probe-out/<dir>/runs/<label>-<date>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  poolRouteCells,
  summarizeRouteCell,
  type RouteCell,
  type RouteItem,
} from "../studio/agent/eval/routeCell";
import { briefById } from "../studio/agent/eval/briefs";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const N = Number(arg("n", "3"));
const MAX_CALLS = Number(arg("max-calls", String(N)));
const LABEL = arg("label", "route");
const DIR = arg("dir", "probe-out/capabilities");
const BASE = arg("base", "http://localhost:8080/api/v1/me");
/** Upper per-call planner cost, for the printed ceiling only (ingest-flip.md:185-199). */
/** 6c: run step 1 (concepts) before each cell's plan, and plan with the one named by --pick (default A). */
const CONCEPTS = flag("concepts");
const PICK = arg("pick", "A");
interface Concept {
  id: string;
  angle: string;
  feeling: string;
  line: string;
}
const STOP = new Set([
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "their",
  "them",
  "they",
  "then",
  "than",
  "what",
  "when",
  "each",
  "just",
  "over",
  "about",
  "before",
  "after",
  "every",
  "while",
  "being",
]);
const words = (t: string) =>
  new Set(
    (t.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !STOP.has(w)),
  );
/** Pairwise word overlap of two lines — |A∩B| / |A∪B|. The pre-registered distinctness bar is < 0.5. */
const jaccard = (a: string, b: string) => {
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return union ? inter / union : 0;
};
/**
 * Words that count a reason as CITING the campaign (6b's pre-registered measure): an item whose `fits`
 * contains any of them, case-insensitive. Empty: not counted.
 */
const CITES = arg("cites", "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);
const cites = (fits: string | undefined) =>
  !!fits && CITES.some((w) => fits.toLowerCase().includes(w));
const PER_CALL_CEILING_USD = 0.075;

interface Brief {
  id: string;
  prompt: string;
  objective: string;
  aesthetic?: string;
}

function resolveBrief(): Brief {
  const evalId = arg("brief", "");
  if (evalId) {
    const b = briefById(evalId);
    if (!b) throw new Error(`no eval brief "${evalId}"`);
    if (b.product)
      throw new Error(
        `"${evalId}" picks a product; this runner does not pick one yet`,
      );
    return {
      id: b.id,
      prompt: b.prompt,
      objective: b.objective,
      ...(b.aesthetic ? { aesthetic: b.aesthetic } : {}),
    };
  }
  const prompt = arg("prompt", "");
  if (!prompt)
    throw new Error("--brief <eval id> or --prompt <sentence> is required");
  return {
    id: arg("id", "adhoc"),
    prompt,
    objective: arg("objective", "grow-following"),
  };
}

function extraBody(): Record<string, unknown> {
  const path = arg("body", "");
  if (!path) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("--body must hold a JSON object");
  return { ...parsed };
}

/** 4 s, preview.ts DEFAULT_CLIP_SECONDS. */
const CLIP_SECONDS = 4;

/**
 * A cell's LIST estimate, the way the ingest-flip ledger priced its cells: a shot of her (i2v, or a
 * product with her in it) on Veo, audio only when the planner said sound; any other generated item on
 * Seedance at 720p portrait; stills, clips and left-out items $0. Not the Board's quote — no preview row.
 */
async function listPrice(items: readonly RouteItem[]): Promise<number | null> {
  const { estimateCost } = await import("../studio/pricing");
  const { MODELS } = await import("../studio/config");
  let total = 0;
  for (const it of items) {
    if (
      it.kind === "image" ||
      it.kind === "clip" ||
      (it.assetId === null && it.uncast !== null)
    )
      continue;
    const her =
      it.kind === "i2v" ||
      (it.kind === "product" && it.athletePresent === true);
    const est = her
      ? estimateCost(
          { prompt: "", durationSeconds: CLIP_SECONDS },
          MODELS.veo,
          { providerParams: { parameters: { generateAudio: it.sound } } },
        )
      : estimateCost(
          {
            prompt: "",
            durationSeconds: CLIP_SECONDS,
            width: 720,
            height: 1280,
          },
          MODELS.seedance,
        );
    if (est.unpriced) return null;
    total += est.amountUsd;
  }
  return Math.round(total * 100) / 100;
}

const short = (id: string | null) => (id ? id.slice(0, 8) : "words");

function line(c: RouteCell): string {
  return c.slotList
    .map(
      (s) =>
        `${s.kind}:${short(s.assetId)}${s.provenance ? `:${s.provenance}` : ""}${s.trim ? `@${s.trim.startSec}-${s.trim.endSec}` : ""}${s.motion ? `(${s.motion})` : ""}${s.demoted ? "[demoted]" : ""}${s.reason ? `{${s.reason.entry}}` : "{no reason}"}`,
    )
    .join(" · ");
}

async function main() {
  const brief = resolveBrief();
  const body = {
    prompt: brief.prompt,
    objective: brief.objective,
    ...(brief.aesthetic ? { aesthetic: brief.aesthetic } : {}),
    ...extraBody(),
  };
  const calls = Math.min(N, MAX_CALLS);
  // A concepts cell makes two calls: the concept step, then the plan.
  const perCell = CONCEPTS ? 2 : 1;
  console.log(
    `${brief.id}: "${brief.prompt}" objective ${brief.objective} — ${calls} cell(s), ${calls * perCell} call(s), ceiling ≈ $${(calls * perCell * PER_CALL_CEILING_USD).toFixed(2)}${CONCEPTS ? ` — concepts first, plan with ${PICK}` : ""}`,
  );
  console.log(`body keys: ${Object.keys(body).join(", ")}`);
  if (!RUN) {
    console.log("dry run — add --run to send");
    return;
  }
  const token = readFileSync(join(DIR, ".token"), "utf8").trim();
  mkdirSync(join(DIR, "runs"), { recursive: true });
  const out = join(
    DIR,
    "runs",
    `${LABEL}-${new Date().toISOString().slice(0, 10)}.json`,
  );
  const cells: {
    repeat: number;
    status: number;
    ms: number;
    error?: string;
    cell?: RouteCell;
    listUsd?: number | null;
    look?: unknown;
    music?: unknown;
    concepts?: Concept[];
    picked?: Concept | null;
    /**
     * The route's answer, item by item, as the Agent screen reads it (PR 16): kind, beat, direction,
     * asset, reason, capability asks — what a blind plan sheet shows a judge. Additive; older run files
     * have none.
     */
    items?: {
      kind: string;
      beat: string;
      direction: string;
      assetId: string | null;
      reason: unknown;
      capabilities: unknown;
      sound: boolean;
    }[];
    planId?: string | null;
  }[] = [];
  const save = () =>
    writeFileSync(
      out,
      JSON.stringify(
        {
          label: LABEL,
          brief,
          body,
          startedAt: new Date().toISOString(),
          cells,
        },
        null,
        2,
      ),
    );

  for (let repeat = 0; repeat < calls; repeat++) {
    // 6c: step 1 first — concepts from the ask, none of the library — then the plan with the pick.
    let concepts: Concept[] | undefined;
    let picked: Concept | null = null;
    if (CONCEPTS) {
      const cr = await fetch(`${BASE}/studio/agent/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...body, stage: "concepts" }),
        signal: AbortSignal.timeout(170_000),
      });
      const cj: unknown = await cr.json().catch(() => null);
      if (
        cr.status !== 200 ||
        !cj ||
        typeof cj !== "object" ||
        !("concepts" in cj) ||
        !Array.isArray(cj.concepts)
      ) {
        console.log(`#${repeat} concepts HTTP ${cr.status}`);
        cells.push({ repeat, status: cr.status, ms: 0, error: "concepts" });
        save();
        if (cr.status === 401) return;
        continue;
      }
      concepts = cj.concepts as Concept[];
      picked = concepts.find((c) => c.id === PICK) ?? null;
      const pairs: string[] = [];
      for (let a = 0; a < concepts.length; a++)
        for (let b2 = a + 1; b2 < concepts.length; b2++)
          pairs.push(
            `${concepts[a].id}${concepts[b2].id} ${jaccard(concepts[a].line, concepts[b2].line).toFixed(2)}`,
          );
      const angles = new Set(concepts.map((c) => c.angle.toLowerCase())).size;
      console.log(
        `#${repeat} concepts: ${concepts.length}, distinct angles ${angles}, line overlap ${pairs.join(" · ")}`,
      );
      for (const c of concepts)
        console.log(`        ${c.id}: ${c.angle} — ${c.feeling} — ${c.line}`);
      if (!picked) {
        console.log(`        no concept ${PICK} — cell skipped`);
        cells.push({
          repeat,
          status: 0,
          ms: 0,
          error: `no concept ${PICK}`,
          concepts,
        });
        save();
        continue;
      }
    }
    const planBody = picked ? { ...body, concept: picked } : body;
    const started = Date.now();
    const res = await fetch(`${BASE}/studio/agent/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(planBody),
      signal: AbortSignal.timeout(170_000),
    });
    const ms = Date.now() - started;
    const json: unknown = await res.json().catch(() => null);
    if (
      res.status !== 200 ||
      !json ||
      typeof json !== "object" ||
      !("items" in json) ||
      !Array.isArray(json.items)
    ) {
      const error =
        json && typeof json === "object" && "error" in json
          ? String(json.error)
          : "no body";
      console.log(
        `#${repeat} HTTP ${res.status} ${error.slice(0, 120)} (${ms} ms)`,
      );
      cells.push({ repeat, status: res.status, ms, error });
      save();
      if (res.status === 401 || res.status === 404) {
        console.log(
          res.status === 401
            ? "token rejected — stopping"
            : "route is off (STUDIO_AGENT) — stopping",
        );
        return;
      }
      continue;
    }
    const items = json.items as RouteItem[];
    const cell = summarizeRouteCell(items);
    const answered = (json.items as Record<string, unknown>[]).map((i) => ({
      kind: String(i.kind ?? ""),
      beat: String(i.beat ?? ""),
      direction: String(i.direction ?? ""),
      assetId: typeof i.assetId === "string" ? i.assetId : null,
      reason: i.reason ?? null,
      capabilities: i.capabilities ?? null,
      sound: i.sound === true,
    }));
    const planId =
      "planId" in json && typeof json.planId === "string" ? json.planId : null;
    const listUsd = await listPrice(items);
    // The plan-level choices (PR 6, 6a2), as the route answered them.
    const plan = json as { look?: unknown; music?: unknown };
    const look = plan.look ?? null;
    const music = plan.music ?? null;
    cells.push({
      repeat,
      status: 200,
      ms,
      cell,
      items: answered,
      planId,
      listUsd,
      look,
      music,
      ...(concepts ? { concepts, picked } : {}),
    });
    if (picked) {
      const cw = new Set([
        ...words(`${picked.angle} ${picked.feeling}`),
        "concept",
      ]);
      const refs = cell.slotList.filter((sl) =>
        [...cw].some((w) => (sl.reason?.fits ?? "").toLowerCase().includes(w)),
      ).length;
      console.log(
        `        reasons reference concept ${picked.id} (${[...cw].join(", ")}): ${refs}/${cell.slotList.length}`,
      );
    }
    save();
    console.log(
      `#${repeat} ${String(ms).padStart(6)} ms  slots ${cell.slots}  camera ${cell.camera}  i2v ${cell.i2v}  held ${cell.held} (demoted ${cell.demoted})  clips ${cell.clips}  b-roll ${cell.brollFromWords}  made-here ${cell.madeHere}  left-out ${cell.leftOut}  reasons ${cell.reasons}/${cell.items}  list $${listUsd ?? "?"}${cell.lookalike ? "  ⚠️ LOOKALIKE" : ""}${cell.allCamera ? "  ALL-CAMERA" : ""}`,
    );
    console.log(`        ${line(cell)}`);
    console.log(
      `        look ${JSON.stringify(look)}  music ${JSON.stringify(music)}`,
    );
    if (CITES.length) {
      const cited = cell.slotList.filter((sl) => cites(sl.reason?.fits)).length;
      const withOver = cell.slotList.filter((sl) => sl.reason?.over).length;
      console.log(
        `        cites the campaign ${cited}/${cell.slotList.length}  over named ${withOver}/${cell.slotList.length}`,
      );
    }
    // The words she reads behind WHY, per slot — so a reason is read, not only counted.
    for (const [n, slot] of cell.slotList.entries())
      console.log(
        `        why[${n}] ${slot.reason ? `${slot.reason.entry}: ${slot.reason.fits}${slot.reason.over ? ` (over ${slot.reason.over})` : ""}` : "—"}`,
      );
  }
  save();
  const ok = cells.flatMap((c) => (c.cell ? [c.cell] : []));
  const p = poolRouteCells(ok);
  console.log(
    `\npooled over ${p.cells} cell(s): slots ${p.slots}  camera ${p.camera} (${p.cameraShare === null ? "—" : `${Math.round(p.cameraShare * 100)}%`})  i2v ${p.i2v} (made-here ${p.i2vMadeHere})  held ${p.held} (demoted ${p.demoted})  clips ${p.clips}  b-roll ${p.brollFromWords}  made-here ${p.madeHere}  lookalike ${p.lookalike}  all-camera ${p.allCameraCells}/${p.cells}  reasons ${p.reasons}/${p.items}`,
  );
  const prices = cells.flatMap((c) =>
    typeof c.listUsd === "number" ? [c.listUsd] : [],
  );
  console.log(
    `mean list $${prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : "?"} over ${prices.length} priced cell(s)`,
  );
  console.log(`run → ${out}`);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
