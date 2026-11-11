/**
 * evals/agent/moments/loadMomentsCases.ts — load and check the moments cases (evals/agent/moments/cases/*.json): the
 * file name is the id; every case is a made-up athlete with a stage; the counts sit inside the scan's 1–5; every key
 * the expectations and the mock script name exists in the fixture; every date is "+N", "-N", YYYY-MM-DD or YYYY-MM.
 * Throws on the first broken file, naming it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MomentsCase } from "./types";

export const MOMENTS_CASES_DIR = join(__dirname, "cases");
const DATE = /^([+-]\d+|\d{4}-\d{2}(-\d{2})?)$/;

export function loadMomentsCases(dir: string = MOMENTS_CASES_DIR): MomentsCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as MomentsCase;
    const where = `moments case ${f}`;
    if (`${c.id}.json` !== f) throw new Error(`${where}: id "${c.id}" must equal the file name`);
    if (typeof c.reviewed !== "boolean") throw new Error(`${where}: reviewed must be true or false`);
    if (!c.athlete?.name || !c.athlete?.sport || !c.stage?.label || !c.stage?.band) throw new Error(`${where}: the athlete needs a name, a sport and a stage`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.mock_today ?? "")) throw new Error(`${where}: mock_today must be YYYY-MM-DD`);
    const e = c.expect;
    if (!(e.min_moments >= 1 && e.max_moments <= 12 && e.min_moments <= e.max_moments)) throw new Error(`${where}: min_moments / max_moments must sit inside 1–12`);
    if (!(e.min_recall >= 0 && e.min_recall <= 1)) throw new Error(`${where}: min_recall must be 0–1`);
    const keys = { F: new Set(c.fixture.facts.map((x) => x.key)), M: new Set(c.fixture.moments.map((x) => x.key)), D: new Set(c.fixture.deals.map((x) => x.key)) };
    for (const k of [...e.retired, ...e.kept]) if (!keys.M.has(k)) throw new Error(`${where}: expect names moment ${k}, which the fixture does not have`);
    for (const ref of JSON.stringify(c.mock).match(/\$[FMD]:\w+/g) ?? []) {
      const [kind, key] = ref.slice(1).split(":") as ["F" | "M" | "D", string];
      if (!keys[kind].has(key)) throw new Error(`${where}: the mock refers to ${ref}, which the fixture does not have`);
    }
    const dates = [
      ...c.fixture.facts.map((x) => x.date).filter((d): d is string => !!d), ...c.fixture.moments.map((x) => x.date),
      ...c.fixture.deals.flatMap((x) => [x.term_start, x.term_end]).filter((d): d is string => !!d),
      ...c.mock.moments.map((m) => String(m.date ?? "")),
    ];
    for (const d of dates) if (!DATE.test(d) && !/^\d{4}$/.test(d)) throw new Error(`${where}: "${d}" is not a case date`);
    return c;
  });
}
