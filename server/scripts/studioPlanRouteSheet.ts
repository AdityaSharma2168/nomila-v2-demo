/**
 * studioPlanRouteSheet — a BLIND PLAN SHEET from route run files (PR 16, S-2). studioPlanEval's `--sheet`
 * reads the in-process runner's format (a planner plan + the recorded library), which the fenced route
 * runs do not produce; studioPlanRoute records the route's answer item by item (kind, beat, direction,
 * reason, capability asks) since c67112a1. This maps those items onto the same `SheetCell` the plan sheet
 * renders, codes them by the plan eval's own seed, and writes sheet.html + key.json + scores.csv with the
 * plan eval's seven CRITERIA — so the scoring and the reveal are the ones every prior run used.
 *
 *   npx tsx server/scripts/studioPlanRouteSheet.ts --runs probe-out/flow-eval/runs/s2-*.json --name s2-plans
 *
 * LIMITATIONS, stated on the sheet's key and in the ledger: the route does not return the library lines
 * the planner read, so a cell's "library" panel is empty; the planner's gap lines are not in the route's
 * answer either. A cell recorded before items were saved (no `items`) is skipped by name.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  assignCodes,
  renderSheet,
  scoresTemplate,
  KIND_LABEL,
  CRITERIA,
  type RawCell,
} from "../studio/agent/eval/sheet";
import { parseCapabilities } from "../studio/agent/capabilities";
import { parseScores } from "../studio/agent/eval/reveal";
import { aggregate } from "../studio/agent/eval/metrics";
import type { ItemReason, PlanItem, PlanItemKind } from "../studio/agent/types";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};
const args = (name: string): string[] => {
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
};

interface RouteRunFile {
  label: string;
  brief: { id: string; prompt: string; objective: string; aesthetic?: string };
  cells: {
    repeat: number;
    status: number;
    items?: {
      kind: string;
      beat: string;
      direction: string;
      reason: unknown;
      capabilities: unknown;
      sound: boolean;
    }[];
  }[];
}

const isKind = (k: string): k is PlanItemKind =>
  Object.prototype.hasOwnProperty.call(KIND_LABEL, k);

function reasonOf(raw: unknown): ItemReason | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return typeof r.entry === "string" && typeof r.fits === "string"
    ? {
        entry: r.entry,
        fits: r.fits,
        over: typeof r.over === "string" ? r.over : null,
      }
    : null;
}

/**
 * The reveal for a route sheet, after Adi scores it: per criterion, pooled and per brief (compare BRIEF BY
 * BRIEF with prior runs — S-2 is 12 briefs and cannot speak to product_rules; docs/probes/flow-eval.md).
 * studioPlanEval's `--reveal` needs the recorded libraries for its auto metrics, which a route run lacks.
 */
function revealRoute(dir: string): void {
  const key = JSON.parse(readFileSync(join(dir, "key.json"), "utf8")) as {
    key: Record<string, { run: string; briefId: string; repeat: number }>;
  };
  const scores = parseScores(readFileSync(join(dir, "scores.csv"), "utf8"));
  const byCode = new Map(scores.map((r) => [r.code, r]));
  const fmt = (vals: number[]) => {
    const a = aggregate(vals);
    return a.n ? `${a.mean.toFixed(2)} ±${a.sd.toFixed(2)} (n ${a.n})` : "—";
  };
  const of = (codes: string[], c: (typeof CRITERIA)[number]) =>
    codes
      .map((code) => byCode.get(code)?.scores[c])
      .filter((v): v is number => v !== undefined);
  const codes = Object.keys(key.key);
  const briefs = [
    ...new Set(Object.values(key.key).map((k) => k.briefId)),
  ].sort();
  const lines = [
    `| Brief | ${CRITERIA.join(" | ")} |`,
    `|---|${CRITERIA.map(() => "---").join("|")}|`,
    `| **pooled (${briefs.length} briefs)** | ${CRITERIA.map((c) => fmt(of(codes, c))).join(" | ")} |`,
    ...briefs.map((b) => {
      const cs = codes.filter((c) => key.key[c].briefId === b);
      return `| ${b} | ${CRITERIA.map((c) => fmt(of(cs, c))).join(" | ")} |`;
    }),
  ];
  writeFileSync(join(dir, "reveal.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

function main(): void {
  const rev = arg("reveal", "");
  if (rev) return revealRoute(rev);
  const files = args("runs");
  if (!files.length) throw new Error("--runs <route run files…> is required");
  const name = arg("name", "route-plans");
  const out = arg("dir", "probe-out/flow-eval");
  const raw: RawCell[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const run = JSON.parse(readFileSync(f, "utf8")) as RouteRunFile;
    for (const c of run.cells) {
      if (c.status !== 200 || !c.items) {
        skipped.push(
          `${basename(f)}#${c.repeat}${c.items ? "" : " (no items recorded)"}`,
        );
        continue;
      }
      const items: PlanItem[] = c.items
        .filter((i) => isKind(i.kind))
        .map((i) => {
          const caps = parseCapabilities(i.capabilities).capabilities;
          return {
            kind: i.kind as PlanItemKind,
            beat: i.beat,
            direction: i.direction,
            ref: null,
            searchQuery: null,
            sound: i.sound,
            segment: null,
            window: null,
            motion: null,
            reason: reasonOf(i.reason),
            ...(caps ? { capabilities: caps } : {}),
          };
        });
      raw.push({
        briefId: run.brief.id,
        prompt: run.brief.prompt,
        objective: run.brief.objective,
        ...(run.brief.aesthetic ? { aesthetic: run.brief.aesthetic } : {}),
        libraryLines: [],
        productLines: [],
        plan: { items, nulled: [], gaps: [] },
        source: { run: run.label, repeat: c.repeat },
      });
    }
  }
  const { cells, key } = assignCodes(raw);
  const dir = join(out, "sheets", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sheet.html"),
    renderSheet(cells, "Plan eval — blind sheet (route runs)"),
  );
  writeFileSync(
    join(dir, "key.json"),
    JSON.stringify(
      {
        runs: Object.fromEntries(files.map((f) => [basename(f), f])),
        key,
        limitations: [
          "no library lines (the route does not return them)",
          "no gap lines",
        ],
        skipped,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "scores.csv"),
    scoresTemplate(cells.map((c) => c.code)),
  );
  console.log(
    `blind sheet → ${join(dir, "sheet.html")} (${cells.length} cells)`,
  );
  if (skipped.length) console.log(`skipped: ${skipped.join(", ")}`);
}

main();
