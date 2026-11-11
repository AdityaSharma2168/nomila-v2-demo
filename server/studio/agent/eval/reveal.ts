/**
 * studio/agent/eval/reveal — the judge's scores joined back to the key, per run and per brief.
 *
 * Pure. Reads the filled scoresheet and the key, and says for each run what each criterion scored
 * (mean, spread) and, when exactly two runs are on the sheet, which brief × criterion cells moved
 * by MORE than the repeat spread — and which did not. A rule whose effect sits inside the spread is
 * AMBIGUOUS, not "no effect": the ledger's escalation path is to re-run just those briefs at n=5–6
 * before flagging the rule (Adi, 22 Sep 2026).
 */
import {
  aggregate,
  aggregateMetrics,
  type Aggregate,
  type MetricField,
  type PlanMetrics,
} from "./metrics";
import { CRITERIA, type Criterion, type Keyed } from "./sheet";

export interface ScoreRow {
  code: string;
  /** Only the criteria the judge filled — a blank cell is absent, never zero. */
  scores: Partial<Record<Criterion, number>>;
  note: string;
}

/** The scoresheet as filled, for any criteria set (PR 16: the concept sheet has its own columns). */
export function parseScoresFor<C extends string>(
  csv: string,
  criteria: readonly C[],
): { code: string; scores: Partial<Record<C, number>>; note: string }[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const expected = ["code", ...criteria, "note"];
  if (header.slice(0, expected.length).join(",") !== expected.join(","))
    throw new Error(
      `scores.csv header must be "${expected.join(",")}", got "${lines[0]}"`,
    );
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const scores: Partial<Record<C, number>> = {};
    criteria.forEach((c, i) => {
      const v = Number(cols[i + 1]?.trim());
      if (cols[i + 1]?.trim() !== "" && Number.isFinite(v)) scores[c] = v;
    });
    return {
      code: cols[0].trim(),
      scores,
      note: cols
        .slice(criteria.length + 1)
        .join(",")
        .trim(),
    };
  });
}

/** The scoresheet as filled. Header must be the template's; a blank or non-numeric cell is unscored. */
export function parseScores(csv: string): ScoreRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const expected = ["code", ...CRITERIA, "note"];
  if (header.slice(0, expected.length).join(",") !== expected.join(","))
    throw new Error(
      `scores.csv header must be "${expected.join(",")}", got "${lines[0]}"`,
    );
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const scores: ScoreRow["scores"] = {};
    CRITERIA.forEach((c, i) => {
      const v = Number(cols[i + 1]?.trim());
      if (cols[i + 1]?.trim() !== "" && Number.isFinite(v)) scores[c] = v;
    });
    return {
      code: cols[0].trim(),
      scores,
      // The note may itself contain commas: everything past the criteria is the note.
      note: cols
        .slice(CRITERIA.length + 1)
        .join(",")
        .trim(),
    };
  });
}

export interface RunReveal {
  run: string;
  cells: number;
  /** Cells the judge left wholly unscored. */
  unscored: number;
  criteria: Record<Criterion, Aggregate>;
  metrics: { nullPlans: number; fields: Record<MetricField, Aggregate> };
  briefs: Record<string, { criteria: Record<Criterion, Aggregate> }>;
}

export interface Reveal {
  runs: RunReveal[];
  /**
   * Present only when exactly two runs are on the sheet: for each brief × criterion, the difference
   * of means (second minus first) and whether it clears the larger repeat spread.
   */
  diff: {
    from: string;
    to: string;
    cells: {
      briefId: string;
      criterion: Criterion;
      from: number;
      to: number;
      delta: number;
      spread: number;
      verdict: "moved" | "ambiguous" | "unscored";
    }[];
  } | null;
}

export function reveal(input: {
  key: Keyed["key"];
  scores: readonly ScoreRow[];
  /** Per code: the plan's numbers, or null for a null plan. */
  metrics: Readonly<Record<string, PlanMetrics | null>>;
}): Reveal {
  const byCode = new Map(input.scores.map((s) => [s.code, s]));
  const runs = [...new Set(Object.values(input.key).map((k) => k.run))].sort();
  const out: RunReveal[] = runs.map((run) => {
    const codes = Object.entries(input.key)
      .filter(([, k]) => k.run === run)
      .map(([code, k]) => ({ code, briefId: k.briefId }));
    const scored = (crit: Criterion, subset = codes) =>
      subset
        .map((c) => byCode.get(c.code)?.scores[crit])
        .filter((v): v is number => v !== undefined);
    const criteria = Object.fromEntries(
      CRITERIA.map((c) => [c, aggregate(scored(c))]),
    ) as Record<Criterion, Aggregate>;
    const briefIds = [...new Set(codes.map((c) => c.briefId))].sort();
    const briefs = Object.fromEntries(
      briefIds.map((b) => {
        const subset = codes.filter((c) => c.briefId === b);
        return [
          b,
          {
            criteria: Object.fromEntries(
              CRITERIA.map((c) => [c, aggregate(scored(c, subset))]),
            ) as Record<Criterion, Aggregate>,
          },
        ];
      }),
    );
    return {
      run,
      cells: codes.length,
      unscored: codes.filter(
        (c) => Object.keys(byCode.get(c.code)?.scores ?? {}).length === 0,
      ).length,
      criteria,
      metrics: aggregateMetrics(
        codes.map((c) => input.metrics[c.code] ?? null),
      ),
      briefs,
    };
  });

  let diff: Reveal["diff"] = null;
  if (out.length === 2) {
    const [a, b] = out;
    const briefIds = [
      ...new Set([...Object.keys(a.briefs), ...Object.keys(b.briefs)]),
    ].sort();
    const cells: NonNullable<Reveal["diff"]>["cells"] = [];
    for (const briefId of briefIds)
      for (const criterion of CRITERIA) {
        const x = a.briefs[briefId]?.criteria[criterion];
        const y = b.briefs[briefId]?.criteria[criterion];
        if (!x || !y || x.n === 0 || y.n === 0) {
          cells.push({
            briefId,
            criterion,
            from: x?.mean ?? 0,
            to: y?.mean ?? 0,
            delta: 0,
            spread: 0,
            verdict: "unscored",
          });
          continue;
        }
        const delta = y.mean - x.mean;
        const spread = Math.max(x.sd, y.sd);
        cells.push({
          briefId,
          criterion,
          from: x.mean,
          to: y.mean,
          delta,
          spread,
          verdict: Math.abs(delta) > spread ? "moved" : "ambiguous",
        });
      }
    diff = { from: a.run, to: b.run, cells };
  }
  return { runs: out, diff };
}

const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");

/** The reveal as a markdown block for the ledger. */
export function revealMarkdown(r: Reveal): string {
  const lines: string[] = [];
  for (const run of r.runs) {
    lines.push(
      `### ${run.run} — ${run.cells} cells, ${run.unscored} unscored, ${run.metrics.nullPlans} null plans`,
      "",
    );
    lines.push(
      "| criterion | mean | sd | min | max | n |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const c of CRITERIA) {
      const a = run.criteria[c];
      lines.push(
        `| ${c} | ${f(a.mean)} | ${f(a.sd)} | ${a.min} | ${a.max} | ${a.n} |`,
      );
    }
    lines.push(
      "",
      "| metric | mean | sd | min | max |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const [field, a] of Object.entries(run.metrics.fields))
      lines.push(
        `| ${field} | ${f(a.mean)} | ${f(a.sd)} | ${f(a.min)} | ${f(a.max)} |`,
      );
    lines.push("");
  }
  if (r.diff) {
    lines.push(`### ${r.diff.from} → ${r.diff.to}, per brief`, "");
    lines.push(
      "| brief | criterion | from | to | Δ | spread | verdict |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const c of r.diff.cells)
      lines.push(
        `| ${c.briefId} | ${c.criterion} | ${f(c.from)} | ${f(c.to)} | ${c.delta >= 0 ? "+" : ""}${f(c.delta)} | ${f(c.spread)} | ${c.verdict} |`,
      );
    const ambiguous = [
      ...new Set(
        r.diff.cells
          .filter((c) => c.verdict === "ambiguous")
          .map((c) => c.briefId),
      ),
    ];
    lines.push(
      "",
      ambiguous.length
        ? `Ambiguous briefs (re-run at n=5–6 before flagging a rule): ${ambiguous.join(", ")}`
        : "No ambiguous cells.",
      "",
    );
  }
  return lines.join("\n");
}
