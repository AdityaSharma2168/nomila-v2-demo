/**
 * evals/agent/loadCases.ts — read and sanity-check every case file. A malformed case fails loudly, before anything is
 * spent. The CI test runs this over the real case directory.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "./types";

export const CASES_DIR = join(process.cwd(), "evals", "agent", "cases");

/** Problems with one case (empty = fine). `file` is its file name. */
export function caseProblems(c: EvalCase, file: string): string[] {
  const p: string[] = [];
  if (`${c.id}.json` !== file) p.push(`id "${c.id}" does not match the file name`);
  if (typeof c.reviewed !== "boolean") p.push("reviewed must be true or false");
  if (!c.input?.name?.trim() || !c.input?.sport?.trim()) p.push("input needs name and sport");
  if (!["resolved", "disputed", "any"].includes(c.expected?.identity)) p.push("expected.identity must be resolved | disputed | any");
  const facts = c.expected?.facts ?? [];
  if (facts.length && c.expected.min_recall == null) p.push("a case with expected facts needs min_recall");
  if (c.expected?.min_recall != null && !(c.expected.min_recall > 0 && c.expected.min_recall <= 1)) p.push("min_recall must be in (0, 1]");
  for (const e of facts) {
    if (!e.id || !e.fact || !e.match || !e.checked) p.push(`expected fact ${e.id ?? "?"} needs id, fact, match and checked`);
    if (!/^https?:\/\//.test(e.source_url ?? "")) p.push(`expected fact ${e.id ?? "?"} needs an http(s) source_url`);
  }
  if (new Set(facts.map((e) => e.id)).size !== facts.length) p.push("expected fact ids must be unique");
  if (!Array.isArray(c.must_not)) p.push("must_not must be a list");
  for (const m of c.must_not ?? []) if (!m.kind || !m.match || !m.why) p.push("each must_not entry needs kind, match and why");
  return p;
}

export function loadCases(dir = CASES_DIR): EvalCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const cases = files.map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalCase;
    const problems = caseProblems(c, f);
    if (problems.length) throw new Error(`${join(dir, f)}: ${problems.join("; ")}`);
    return c;
  });
  return cases;
}
