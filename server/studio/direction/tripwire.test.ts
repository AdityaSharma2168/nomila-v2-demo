/**
 * tripwire.test — the hard gate, statically: nothing under studio/direction imports a way to spend.
 *
 * A direction tool returns a brief. The planner, the concept step, the preview quote, a generation
 * and a stitch are all reachable from this codebase by import, so this walk names the modules a
 * tool may not reach for and reads every non-test source in this folder against the list. It is the
 * cheap half of the gate; routes.test is the runtime half (the real router, every spending entry
 * point spied). ⚠️ MUTATION: import deriveConcepts into routes.ts — "no direction module imports the
 * planner, the concept step, a generation, a preview quote or a stitch" reds by name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Modules that reach a spending path, matched against the END of an import specifier (its `.js`
 * stripped) so `agent/plans` — the plan STORE, which a tool may read — is not mistaken for
 * `agent/plan`, the planner. `allow` names the CONSTANTS a module may take from an otherwise
 * forbidden file (a named import of exactly those, nothing else): 6c's grounding rule is prose the
 * tools share, and copying it would let it drift. A namespace, default, dynamic or require import of
 * such a file is still forbidden — it binds the spending function too.
 */
export const FORBIDDEN_IMPORTS: readonly {
  re: RegExp;
  allow?: readonly string[];
}[] = [
  // The planner's prompt and parser. propose_campaign may take its pure renderers — the library line
  // and the fence scrub, and the LIBRARY markers — so her library reads to a tool exactly as it reads
  // to the planner; never the prompt builder, never the transport.
  {
    re: /agent\/plan$/,
    allow: ["libraryLine", "fenced", "LIBRARY_OPEN", "LIBRARY_CLOSE"],
  },
  { re: /agent\/concepts$/, allow: ["CONCEPT_GROUNDING"] }, // the concept step (one model call) — its rule text may be shared
  { re: /agent\/cast$/ }, // casting: searches + rankings against her library
  { re: /\/generate$/ }, // runStudioGeneration
  { re: /\/preview$/ }, // previewGeneration — the quote
  { re: /\/stitchJobs$/ }, // queueStitch
  { re: /\/video\/stitch/ }, // the stitch itself
  { re: /\/jobs$/ }, // generation jobs
  { re: /studio\/router$|^\.\.\/router$/ }, // the provider router: estimate / generate
  // The research lane's nightly ledger (research_budget_days) and its runs: research_moment takes the
  // provider's one-call function and nothing else from that lane (Lane D, "moment writes to research
  // ledger" red by name).
  {
    re: /intelligence\/research\/(ledger|runResearch|researchAthlete|planner)$/,
  },
];

const HERE = __dirname;

const sources = () =>
  readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(join(HERE, f), "utf8") }));

interface Import {
  spec: string;
  /** The named bindings of a static `import { a, b as c } from` — null for any other form. */
  names: string[] | null;
}

const importsOf = (text: string): Import[] => {
  const out: Import[] = [];
  // Static named imports first (multi-line allowed), remembering where each one ENDS …
  const named = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  const namedEnds = new Set<number>();
  for (const m of text.matchAll(named)) {
    namedEnds.add((m.index ?? 0) + m[0].length);
    const names = m[1]
      .split(",")
      .map((s) =>
        s
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    out.push({ spec: m[2], names });
  }
  // … then every other form — default, namespace, dynamic, require, re-export, and the BARE
  // side-effect `import "…"` (Lane C's mutation C-M1 walked straight past a list without it); a
  // `from "…"` that ends exactly where a named import ended is that import.
  const other =
    /(?:import\s+[^{'"]*?from\s*|import\s*\(\s*|import\s+|require\s*\(\s*|from\s+)["']([^"']+)["']/g;
  for (const m of text.matchAll(other)) {
    if (namedEnds.has((m.index ?? 0) + m[0].length)) continue;
    out.push({ spec: m[1], names: null });
  }
  return out;
};

/** Whether one import reaches a spending path — the rule the walk applies. */
export const forbidden = (imp: Import): { re: RegExp } | undefined =>
  FORBIDDEN_IMPORTS.find((f) => {
    if (!f.re.test(imp.spec.replace(/\.js$/, ""))) return false;
    if (f.allow && imp.names && imp.names.every((n) => f.allow!.includes(n)))
      return false;
    return true;
  });

describe("the direction folder's imports", () => {
  it("has sources to check", () => {
    expect(sources().map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "envelope.ts",
        "echo.ts",
        "routes.ts",
        "summarize.ts",
        "transport.ts",
      ]),
    );
  });

  it("no direction module imports the planner, the concept step, a generation, a preview quote or a stitch", () => {
    const hits: string[] = [];
    for (const { file, text } of sources()) {
      for (const imp of importsOf(text)) {
        const bad = forbidden(imp);
        if (bad) hits.push(`${file}: "${imp.spec}" (${bad.re})`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the list itself catches what it is for — and lets the plan STORE and a shared rule's constant through", () => {
    // A deleted or emptied list would pass the walk trivially; hold what it must catch.
    const caught = (spec: string, names: string[] | null = null) =>
      !!forbidden({ spec, names });
    for (const spec of [
      "../agent/plan",
      "../agent/plan.js",
      "../agent/concepts",
      "../agent/cast",
      "../generate",
      "../preview",
      "../stitchJobs",
      "../video/stitch",
      "../jobs",
      "../router",
      "../../services/intelligence/research/ledger",
      "../../services/intelligence/research/ledger.js",
    ])
      expect({ spec, caught: caught(spec) }).toEqual({ spec, caught: true });
    for (const spec of [
      "../agent/plans",
      "../agent/plans.js",
      "../agent/library",
      "../campaign/brief",
      "../../lib/research/providers/geminiGrounded",
      "express",
    ])
      expect({ spec, caught: caught(spec) }).toEqual({ spec, caught: false });
    // The one allowance: the grounding rule's text, by name, and nothing beside it.
    expect(caught("../agent/concepts", ["CONCEPT_GROUNDING"])).toBe(false);
    expect(
      caught("../agent/concepts", ["CONCEPT_GROUNDING", "deriveConcepts"]),
    ).toBe(true);
    expect(caught("../agent/concepts", null)).toBe(true); // namespace / dynamic / require
    expect(
      importsOf('import { deriveConcepts } from "../agent/concepts";'),
    ).toEqual([{ spec: "../agent/concepts", names: ["deriveConcepts"] }]);
    expect(
      importsOf(
        'import {\n  CONCEPT_GROUNDING,\n  type PlanConcept as PC,\n} from "../agent/concepts";',
      ),
    ).toEqual([
      {
        spec: "../agent/concepts",
        names: ["CONCEPT_GROUNDING", "PlanConcept"],
      },
    ]);
    expect(
      importsOf('const { agentPrompt } = await import("../agent/plan.js");'),
    ).toEqual([{ spec: "../agent/plan.js", names: null }]);
    expect(importsOf('import * as c from "../agent/concepts";')).toEqual([
      { spec: "../agent/concepts", names: null },
    ]);
    // A bare side-effect import names nothing and still loads the module — it is an import.
    expect(importsOf('import "../generate";')).toEqual([
      { spec: "../generate", names: null },
    ]);
  });
});

describe("the direction folder's fetches", () => {
  // A link she gave is attacker-chosen text: safeFetch (Lane F) is the only door to the network.
  // ⚠️ MUTATION: `fetch(url)` in decompose.ts's URL door — this reds by name.
  it("no direction module calls fetch outside safeFetch", () => {
    const hits: string[] = [];
    for (const { file, text } of sources())
      for (const m of text.matchAll(/(?<![A-Za-z0-9_.$])fetch\s*\(/g))
        hits.push(`${file}@${m.index}`);
    expect(hits).toEqual([]);
  });
});
