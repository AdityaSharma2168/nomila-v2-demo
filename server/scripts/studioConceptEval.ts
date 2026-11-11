/**
 * studioConceptEval — the CONCEPT eval (PR 16, R-9, spend cell S-1): the 13 fixed briefs through the
 * REAL route on a server Adi started on this worktree, one cell each — the concept stage, then the plan
 * made with concept A — under ONE total cap, then sheeted for Adi's blind judging and revealed.
 *
 *   npx tsx server/scripts/studioConceptEval.ts                         dry: the cells, the calls, the ceiling
 *   … --run --label s1 --quote 1.95                                     sends (26 calls; spendGuard first)
 *   … --sheet probe-out/flow-eval/runs/<file>.json [more …] --name s1  sheet.html + key.json + scores.csv
 *   … --reveal probe-out/flow-eval/sheets/s1                            pooled scores, after Adi scores
 *
 * REFUSE UP FRONT (spendGuard): planned calls > MAX_CALLS, or calls × $0.075 > --quote, and nothing is
 * sent. A cell that fails is recorded as failed; the run is never cut short. The bearer token is read
 * from probe-out/flow-eval/.token and never printed. EVERY concept, picked or not, lives in the run
 * file under probe-out/ (gitignored) — this script writes nothing to any database (M11: it imports
 * none). The route writes one studio_plans row per plan cell under Adi's athlete id (ADI-24SEP R10).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EVAL_BRIEFS } from "../studio/agent/eval/briefs";
import {
  guardRun,
  PER_CALL_CEILING_USD,
  reportRun,
} from "../studio/agent/eval/spendGuard";
import { CONCEPT_CRITERIA, scoresTemplate } from "../studio/agent/eval/sheet";
import {
  assignConceptCodes,
  distinctShare,
  renderConceptSheet,
  revealConcepts,
  type RawConceptCell,
  type SheetConcept,
} from "../studio/agent/eval/conceptSheet";

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
const flag = (n: string) => process.argv.includes(`--${n}`);

const DIR = arg("dir", "probe-out/flow-eval");
const BASE = arg("base", "http://localhost:8080/api/v1/me");
const LABEL = arg("label", "concepts");
const QUOTE = Number(arg("quote", "1.95"));
const ONLY = args("only");
const CALLS_PER_CELL = 2;

export interface ConceptRunCell {
  briefId: string;
  prompt: string;
  objective: string;
  aesthetic?: string;
  concepts: SheetConcept[];
  planned: string | null;
  plan: { kind: string; beat: string; direction: string }[] | null;
  planId: string | null;
  error: string | null;
  ms: number;
}

export interface ConceptRunFile {
  meta: {
    id: string;
    label: string;
    startedAt: string;
    gitSha: string;
    calls: number;
    ceilingUsd: number;
    model: string;
  };
  cells: ConceptRunCell[];
}

const gitSha = () =>
  execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
    encoding: "utf8",
  }).trim();

async function run(): Promise<void> {
  const briefs = EVAL_BRIEFS.filter((b) => !ONLY.length || ONLY.includes(b.id));
  const calls = briefs.length * CALLS_PER_CELL;
  const guard = guardRun({ calls, quotedUsd: QUOTE });
  console.log(
    `${flag("run") ? "LIVE" : "DRY RUN — nothing is sent"} · ${briefs.length} briefs × 1 cell × ${CALLS_PER_CELL} calls = ${calls} calls · ceiling ${calls} × $${PER_CALL_CEILING_USD} = $${(calls * PER_CALL_CEILING_USD).toFixed(2)} · quoted $${QUOTE.toFixed(2)}`,
  );
  if (!guard.ok) throw new Error(`spendGuard: ${guard.reason}`);
  for (const b of briefs)
    console.log(
      `  ${b.id}: "${b.prompt}" (${b.objective}${b.aesthetic ? `, ${b.aesthetic}` : ""})`,
    );
  if (!flag("run")) return;

  const token = readFileSync(join(DIR, ".token"), "utf8").trim();
  const post = async (body: unknown) => {
    const r = await fetch(`${BASE}/studio/agent/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      json: (await r.json().catch(() => null)) as Record<
        string,
        unknown
      > | null,
    };
  };
  const cells: ConceptRunCell[] = [];
  // The run file is written after EVERY cell, so a token that lapses or a crash keeps every cell already
  // paid for (S-1, 24 Sep 2026: a one-hour token against a run of unknown length).
  const startedAt = new Date().toISOString();
  const id = `${LABEL}-${startedAt.slice(0, 10)}-${gitSha()}`;
  mkdirSync(join(DIR, "runs"), { recursive: true });
  const out = join(DIR, "runs", `${id}.json`);
  const save = (partial: string | null) => {
    const file: ConceptRunFile & { partial?: string } = {
      meta: {
        id,
        label: LABEL,
        startedAt,
        gitSha: gitSha(),
        calls,
        ceilingUsd: guard.ceilingUsd,
        model: "the route's planner model",
      },
      cells,
      ...(partial ? { partial } : {}),
    };
    writeFileSync(out, JSON.stringify(file, null, 2));
  };
  for (const b of briefs) {
    const t0 = Date.now();
    const ask = {
      prompt: b.prompt,
      objective: b.objective,
      ...(b.aesthetic ? { aesthetic: b.aesthetic } : {}),
    };
    const base = {
      briefId: b.id,
      prompt: b.prompt,
      objective: b.objective,
      ...(b.aesthetic ? { aesthetic: b.aesthetic } : {}),
    };
    const c = await post({ ...ask, stage: "concepts" });
    if (c.status === 401) {
      save(`stopped at ${b.id}: token rejected`);
      throw new Error(
        `token rejected — stopping; ${cells.length} cells kept in ${out}`,
      );
    }
    const concepts = (c.json?.concepts ?? []) as SheetConcept[];
    if (c.status !== 200 || !concepts.length) {
      cells.push({
        ...base,
        concepts,
        planned: null,
        plan: null,
        planId: null,
        error: `concepts ${c.status}`,
        ms: Date.now() - t0,
      });
      console.log(`  ${b.id}: concepts ${c.status}`);
      continue;
    }
    const pick = concepts.find((x) => x.id === "A") ?? concepts[0];
    const p = await post({ ...ask, concept: pick });
    const items = (p.json?.items ?? null) as
      | { kind: string; beat: string; direction: string }[]
      | null;
    cells.push({
      ...base,
      concepts,
      planned: pick.id,
      plan: items
        ? items.map((i) => ({
            kind: i.kind,
            beat: i.beat,
            direction: i.direction,
          }))
        : null,
      planId: (p.json?.planId as string | null | undefined) ?? null,
      error: p.status === 200 ? null : `plan ${p.status}`,
      ms: Date.now() - t0,
    });
    console.log(
      `  ${b.id}: ${concepts.length} concepts, plan ${p.status}${items ? ` (${items.length} items)` : ""}`,
    );
    save(null);
  }
  save(null);
  const d = distinctShare(cells.map((c) => c.concepts));
  console.log(
    `\nwrote ${out}\n${reportRun({ calls, ceilingUsd: guard.ceilingUsd, billedUsd: null })}\ndistinctness (deterministic half): ${d.under} of ${d.pairs} within-brief pairs under the 0.5 Jaccard bar`,
  );
}

function sheet(files: string[], name: string): void {
  const raw: RawConceptCell[] = files.flatMap((f) => {
    const r = JSON.parse(readFileSync(f, "utf8")) as ConceptRunFile;
    return r.cells.map((c, i) => ({
      briefId: c.briefId,
      prompt: c.prompt,
      objective: c.objective,
      ...(c.aesthetic ? { aesthetic: c.aesthetic } : {}),
      concepts: c.concepts,
      planned: c.planned,
      plan: c.plan,
      source: { run: r.meta.id, repeat: i, model: r.meta.model },
    }));
  });
  const { cells, key } = assignConceptCodes(raw);
  const dir = join(DIR, "sheets", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sheet.html"), renderConceptSheet(cells));
  writeFileSync(join(dir, "key.json"), JSON.stringify(key, null, 2));
  writeFileSync(
    join(dir, "scores.csv"),
    scoresTemplate(
      cells.map((c) => c.code),
      CONCEPT_CRITERIA,
    ),
  );
  console.log(
    `wrote ${dir}/{sheet.html,key.json,scores.csv} — ${cells.length} cells; key.json is not linked from the sheet`,
  );
}

function reveal(dir: string): void {
  if (!existsSync(join(dir, "scores.csv")))
    throw new Error(`no scores.csv in ${dir}`);
  const out = revealConcepts({
    key: JSON.parse(readFileSync(join(dir, "key.json"), "utf8")),
    scoresCsv: readFileSync(join(dir, "scores.csv"), "utf8"),
  });
  const md = out
    .map(
      (r) =>
        `- **${r.run}** (${r.cells} cells): ${CONCEPT_CRITERIA.map((c) => `${c} median ${r.criteria[c].median ?? "—"}`).join(" · ")}`,
    )
    .join("\n");
  writeFileSync(join(dir, "reveal.md"), md + "\n");
  console.log(md);
}

if (require.main === module) {
  const sheets = args("sheet");
  const rev = arg("reveal", "");
  (sheets.length
    ? Promise.resolve(sheet(sheets, arg("name", LABEL)))
    : rev
      ? Promise.resolve(reveal(rev))
      : run()
  ).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
