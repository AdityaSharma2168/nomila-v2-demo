/**
 * studioFlowCensus — THE LIVING ARTIFACT (PR 16, R-8): runs the flow census suites, then renders the
 * census section of docs/probes/flow-eval.md between its markers — the coverage line per flag state,
 * the delta the six roadmap gates buy, a per-source table, and every DEAD row with its owner.
 *
 *   DATABASE_URL=postgres://x:x@127.0.0.1:1/none npx tsx server/scripts/studioFlowCensus.ts          runs, then renders
 *   … --no-run      renders from the last run's probe-out/flow-eval/census/measured-*.json
 *
 * $0: the census mocks every model call and runs on PGlite. The bogus DATABASE_URL only satisfies
 * server/db's import-time check for the row walker's schema imports; nothing connects. A convenience —
 * the assertions in server/studio/agent/eval/census/ are the instrument.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { censusRows, REPO, SOURCES } from "../studio/agent/eval/census/rows";
import {
  VERDICTS,
  type RowVerdict,
  type Verdict,
} from "../studio/agent/eval/census/verdicts";

const OUT = join(REPO, "probe-out", "flow-eval", "census");
const LEDGER = join(REPO, "docs", "probes", "flow-eval.md");
const BEGIN =
  "<!-- census:begin (rendered by server/scripts/studioFlowCensus.ts — do not edit by hand) -->";
const END = "<!-- census:end -->";

export interface Coverage {
  total: number;
  consumedOrDecides: number;
  consumed: number;
  decides: number;
  display: number;
  deliberateDead: number;
  dead: number;
}

export const verdictIn = (v: RowVerdict, state: "on" | "off"): Verdict =>
  state === "on" ? v.v : (v.off ?? v.v);

/** The coverage line's numbers for one flag state, over the rows the code derives today. */
export function coverage(state: "on" | "off", rows = censusRows()): Coverage {
  const c: Coverage = {
    total: rows.length,
    consumedOrDecides: 0,
    consumed: 0,
    decides: 0,
    display: 0,
    deliberateDead: 0,
    dead: 0,
  };
  for (const r of rows) {
    const v = VERDICTS[r.id];
    if (!v) continue;
    const x = verdictIn(v, state);
    if (x === "CONSUMED") c.consumed++;
    if (x === "DECIDES") c.decides++;
    if (x === "DISPLAY") c.display++;
    if (x === "DELIBERATE-DEAD") c.deliberateDead++;
    if (x === "DEAD") c.dead++;
  }
  c.consumedOrDecides = c.consumed + c.decides;
  return c;
}

/** Rows CONSUMED or DECIDES with every flag on and DEAD with the six gates off — what the roadmap bought. */
export function delta(rows = censusRows()): string[] {
  return rows
    .filter((r) => {
      const v = VERDICTS[r.id];
      if (!v) return false;
      const on = verdictIn(v, "on");
      return (
        (on === "CONSUMED" || on === "DECIDES") &&
        verdictIn(v, "off") === "DEAD"
      );
    })
    .map((r) => r.id);
}

function render(): string {
  const rows = censusRows();
  const on = coverage("on", rows);
  const off = coverage("off", rows);
  const d = delta(rows);
  const line = (s: string, c: Coverage) =>
    `- **Flags ${s}:** ${c.consumedOrDecides} of ${c.total} CONSUMED or DECIDES (${c.consumed} + ${c.decides}), ${c.display} DISPLAY, ${c.deliberateDead} DELIBERATE-DEAD, ${c.dead} DEAD.`;
  const bySource = (Object.keys(SOURCES) as (keyof typeof SOURCES)[]).map(
    (s) => {
      const rs = rows.filter((r) => r.source === s);
      const n = (x: Verdict) =>
        rs.filter(
          (r) => VERDICTS[r.id] && verdictIn(VERDICTS[r.id], "on") === x,
        ).length;
      const held = (k: RowVerdict["check"]) =>
        rs.filter((r) => VERDICTS[r.id]?.check === k).length;
      return `| ${s} | ${rs.length} | ${n("CONSUMED")} | ${n("DECIDES")} | ${n("DISPLAY")} | ${n("DELIBERATE-DEAD")} | ${n("DEAD")} | ${held("flow")} / ${held("unit")} / ${held("static")} / ${held("cite")} |`;
    },
  );
  const dead = rows
    .filter((r) => VERDICTS[r.id] && verdictIn(VERDICTS[r.id], "on") === "DEAD")
    .map(
      (r) =>
        `| \`${r.id}\` | ${VERDICTS[r.id].owner ?? "—"} | ${VERDICTS[r.id].cite.replace(/\|/g, "\\|")} |`,
    );
  return [
    BEGIN,
    "",
    "### The census, as measured",
    "",
    line("on", on),
    line("off (the six roadmap gates off)", off),
    `- **Delta:** ${d.length} rows are CONSUMED or DECIDES with the flags on and DEAD with them off.`,
    "",
    "| Source | Rows | CONSUMED | DECIDES | DISPLAY | DELIBERATE-DEAD | DEAD | held by flow / unit / static / cite |",
    "|---|---|---|---|---|---|---|---|",
    ...bySource,
    "",
    "**The delta, by row:** " +
      (d.length ? d.map((x) => `\`${x}\``).join(", ") : "none") +
      ".",
    "",
    "**Every DEAD row (flags on), with its owner:**",
    "",
    "| Row | Owner | Cite |",
    "|---|---|---|",
    ...dead,
    "",
    END,
  ].join("\n");
}

function main(): void {
  if (!process.argv.includes("--no-run")) {
    const r = spawnSync(
      "npx",
      [
        "jest",
        "server/studio/agent/eval/census",
        "--runInBand",
        "--testTimeout=60000",
      ],
      {
        cwd: REPO,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: "",
          CENSUS_OUT: OUT,
          NODE_OPTIONS: "--experimental-vm-modules --max-old-space-size=8192",
          LOG_LEVEL: "silent",
        },
      },
    );
    // The exit code is not a verdict (CLAUDE.local.md); the suites' own assertions are. Say what it was.
    console.log(`census suites exited ${r.status}`);
  }
  if (!existsSync(join(OUT, "measured-on.json")))
    console.log(
      `no measured run under ${OUT} — the table below is the verdicts alone`,
    );
  const section = render();
  const ledger = readFileSync(LEDGER, "utf8");
  const next = ledger.includes(BEGIN)
    ? ledger.slice(0, ledger.indexOf(BEGIN)) +
      section +
      ledger.slice(ledger.indexOf(END) + END.length)
    : `${ledger.trimEnd()}\n\n${section}\n`;
  writeFileSync(LEDGER, next);
  console.log(section);
}

if (require.main === module) main();
