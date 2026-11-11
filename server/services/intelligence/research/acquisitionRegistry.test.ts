/**
 * acquisitionRegistry.test.ts — the R-c / D13 guard: only REGISTERED entry points may invoke an athlete/world
 * acquisition function, and only the owning client may name an acquisition endpoint. A duplicate acquisition path
 * cannot quietly reappear.
 *
 * Static and deterministic: reads source under server/ and scripts/, parses candidate files with the TypeScript
 * parser, and never loads a module, a DB or a provider.
 *
 * A "use" is any VALUE import of a guarded export: named import, re-export, `export *`, namespace or default import,
 * and `import()` / `require()` (destructured names when visible; otherwise conservatively every export). Type-only
 * imports are not uses: they cannot invoke anything.
 *
 * TEST FILES ARE EXEMPT (*.test.* / *.spec.*). They import guarded modules to unit-test them or to jest.mock them; they
 * are never part of the server bundle or a script entry, so they cannot become an acquisition path, and "tests never
 * reach providers" is enforced by each suite's own mocks. Requiring a registry entry per test would add noise without
 * guarding any runtime path.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import {
  ACQUISITION_REGISTRY, ENDPOINTS, KNOWN_UNREGISTERED, OUT_OF_SCOPE, WEB_SEARCH_TOOL_OWNERS,
  type AcquisitionEntry, type WebSearchPattern,
} from "./acquisitionRegistry";

const REPO = resolve(__dirname, "../../../..");
const SCAN_ROOTS = ["server", "scripts"];
const SOURCE_RE = /\.(?:[cm]?[jt]s|tsx)$/;
const TEST_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/;
const SELF = ["server/services/intelligence/research/acquisitionRegistry.ts"];

const posix = (p: string) => p.split(sep).join("/");
const stripExt = (p: string) => p.replace(/\.(?:[cm]?[jt]s|tsx)$/, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__snapshots__" || name === "server_dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_RE.test(name)) out.push(posix(relative(REPO, p)));
  }
  return out;
}

const ALL_FILES = SCAN_ROOTS.filter((r) => existsSync(join(REPO, r))).flatMap((r) => walk(join(REPO, r)));
const SOURCE_FILES = ALL_FILES.filter((f) => !TEST_RE.test(f) && !SELF.includes(f));
const read = (f: string) => readFileSync(join(REPO, f), "utf8");

/** A value import: the resolved module (repo-relative, no extension) and the names bound, or "*" for all. */
interface Use { module: string; names: Set<string> | "*" }

function namesFromCallSite(call: ts.Node): Set<string> | "*" {
  let node: ts.Node = call;
  while (node.parent && (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent))) node = node.parent;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    const names = new Set<string>();
    for (const el of parent.name.elements) {
      if (el.dotDotDotToken) return "*";
      const key = el.propertyName ?? el.name;
      if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return "*";
      names.add(key.text);
    }
    return names;
  }
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) return new Set([parent.name.text]);
  return "*";
}

function usesOf(file: string, source: string): Use[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Use[] = [];
  const add = (spec: string, names: Set<string> | "*") => {
    if (!spec.startsWith(".")) return; // guarded modules are all in-repo; packages and aliases cannot name them
    out.push({ module: stripExt(posix(relative(REPO, resolve(REPO, dirname(file), spec)))), names });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) add(node.moduleSpecifier.text, "*");
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) add(node.moduleSpecifier.text, "*");
        if (nb && ts.isNamedImports(nb)) {
          const names = new Set(nb.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text));
          if (names.size) add(node.moduleSpecifier.text, names);
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      const ec = node.exportClause;
      if (!ec || ts.isNamespaceExport(ec)) add(node.moduleSpecifier.text, "*");
      else {
        const names = new Set(ec.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text));
        if (names.size) add(node.moduleSpecifier.text, names);
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      if (ts.isStringLiteral(e)) add(e.text, "*");
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) add(node.arguments[0].text, namesFromCallSite(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every guarded call site in non-test source: file → entry id → guarded names it binds. */
interface Hit { file: string; entry: AcquisitionEntry; names: string[] }

const GUARDED_BASENAMES = [...new Set(ACQUISITION_REGISTRY.flatMap((e) => e.guards.map((g) => g.module.split("/").pop()!)))];

function scanImports(files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const source = read(file);
    if (!GUARDED_BASENAMES.some((b) => source.includes(b))) continue;
    const uses = usesOf(file, source);
    for (const entry of ACQUISITION_REGISTRY) {
      const names = new Set<string>();
      for (const g of entry.guards) {
        for (const u of uses) {
          if (u.module !== g.module) continue;
          for (const ex of g.exports) if (u.names === "*" || u.names.has(ex)) names.add(ex);
        }
      }
      if (names.size) hits.push({ file, entry, names: [...names].sort() });
    }
  }
  return hits;
}

const known = (file: string, finding: string) => KNOWN_UNREGISTERED.some((k) => k.file === file && k.findings.includes(finding));

function howToRegister(): string {
  return [
    "",
    "Only registered entry points may call athlete/world acquisition functions (R-c / D13, research-acquisition-architecture.md).",
    "To add a path, edit server/services/intelligence/research/acquisitionRegistry.ts: add the file to the entry's",
    "allowedImporters with its reason, or add a new entry with owner, purpose, disposition (§11) and exit criteria,",
    "citing the §11 row it falls under. A path §11 does not cover needs an architecture decision first.",
    "If this is a duplicate of an existing path, call the registered entry point instead.",
  ].join("\n");
}

const HITS = scanImports(SOURCE_FILES);

describe("acquisition registry is well-formed", () => {
  test("ids are unique across entries and endpoints", () => {
    const ids = [...ACQUISITION_REGISTRY.map((e) => e.id), ...ENDPOINTS.map((e) => e.id)];
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("every non-KEEP entry has exit criteria; every entry has an owner, purpose and §11 citation", () => {
    for (const e of ACQUISITION_REGISTRY) {
      expect({ id: e.id, owner: !!e.owner, purpose: !!e.purpose, section11: /§11/.test(e.section11) }).toEqual({ id: e.id, owner: true, purpose: true, section11: true });
      if (e.disposition !== "KEEP") expect({ id: e.id, exitCriteria: !!e.exitCriteria?.trim() }).toEqual({ id: e.id, exitCriteria: true });
    }
  });

  test("every guarded module exists and exports the functions it guards", () => {
    const missing: string[] = [];
    for (const e of ACQUISITION_REGISTRY) for (const g of e.guards) {
      const file = [".ts", ".js"].map((x) => g.module + x).find((f) => existsSync(join(REPO, f)));
      if (!file) { missing.push(`${e.id}: ${g.module} does not exist`); continue; }
      const src = read(file);
      for (const ex of g.exports) {
        if (!new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${ex}\\b`).test(src)) missing.push(`${e.id}: ${g.module} no longer exports ${ex}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("no stale allow-list entry: every allowed importer exists and still calls the entry's guarded functions", () => {
    const stale: string[] = [];
    for (const e of ACQUISITION_REGISTRY) for (const a of e.allowedImporters) {
      if (!existsSync(join(REPO, a.file))) stale.push(`${e.id}: ${a.file} does not exist`);
      else if (!HITS.some((h) => h.file === a.file && h.entry.id === e.id)) stale.push(`${e.id}: ${a.file} no longer uses ${e.guards.map((g) => g.module).join(", ")} — remove it from allowedImporters`);
      if (!a.why.trim()) stale.push(`${e.id}: ${a.file} has no reason`);
    }
    expect(stale).toEqual([]);
  });

  test("out-of-scope files exist (the boundary names real code)", () => {
    const missing = OUT_OF_SCOPE.flatMap((o) => o.files.filter((f) => !existsSync(join(REPO, f))).map((f) => `${o.id}: ${f}`));
    expect(missing).toEqual([]);
  });

  test("the scan sees the tree (sanity)", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(HITS.length).toBeGreaterThanOrEqual(ACQUISITION_REGISTRY.reduce((n, e) => n + e.allowedImporters.length, 0));
  });
});

describe("only registered entry points import acquisition functions", () => {
  test("every importer of a guarded function is in that entry's allow-list", () => {
    const offenders = HITS
      .filter((h) => !h.entry.allowedImporters.some((a) => a.file === h.file) && !known(h.file, h.entry.id))
      .map((h) => `  ${h.file} imports ${h.names.join(", ")} — guarded by "${h.entry.id}" (${h.entry.disposition}, owner ${h.entry.owner})`);
    if (offenders.length) throw new Error(`Unregistered acquisition path(s):\n${offenders.join("\n")}\n${howToRegister()}`);
  });
});

describe("external acquisition endpoints appear only in their registered client", () => {
  test("no direct use of a registered endpoint outside its owner", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const src = read(file);
      for (const ep of ENDPOINTS) {
        if (ep.pattern.test(src) && !ep.owners.some((o) => o.file === file) && !known(file, ep.id)) {
          offenders.push(`  ${file} names the ${ep.id} endpoint (${ep.pattern}) — owned by ${ep.owners.map((o) => o.file).join(", ")}`);
        }
      }
    }
    if (offenders.length) throw new Error(`Direct endpoint use outside its registered client:\n${offenders.join("\n")}\n${howToRegister()}`);
  });

  test("every endpoint owner still names its endpoint", () => {
    const stale = ENDPOINTS.flatMap((ep) => ep.owners.filter((o) => !existsSync(join(REPO, o.file)) || !ep.pattern.test(read(o.file))).map((o) => `${ep.id}: ${o.file}`));
    expect(stale).toEqual([]);
  });
});

describe("known unregistered paths only shrink", () => {
  test("each listed violation is still present (delete the entry once the file is fixed or gone)", () => {
    const gone: string[] = [];
    for (const k of KNOWN_UNREGISTERED) {
      if (!existsSync(join(REPO, k.file))) { gone.push(`${k.file} (file deleted)`); continue; }
      const src = read(k.file);
      for (const f of k.findings) {
        const ep = ENDPOINTS.find((e) => e.id === f);
        const present = ep ? ep.pattern.test(src) : HITS.some((h) => h.file === k.file && h.entry.id === f);
        if (!ep && !ACQUISITION_REGISTRY.some((e) => e.id === f)) gone.push(`${k.file}: unknown finding id ${f}`);
        else if (!present) gone.push(`${k.file}: ${f} no longer present`);
      }
    }
    expect(gone).toEqual([]);
  });
});

describe("the scanner itself", () => {
  const uses = (src: string) => usesOf("server/x/a.ts", src);
  test("type-only imports are not uses; value, namespace, dynamic and re-exports are", () => {
    expect(uses(`import type { A } from "./p";`)).toEqual([]);
    expect(uses(`import { type A } from "./p";`)).toEqual([]);
    expect(uses(`import { fetchThing as f, type A } from "./p";`)).toEqual([{ module: "server/x/p", names: new Set(["fetchThing"]) }]);
    expect(uses(`import * as t from "./p.js";`)[0].names).toBe("*");
    expect(uses(`export * from "./p";`)[0].names).toBe("*");
    expect(uses(`export { fetchGdelt } from "./p";`)[0].names).toEqual(new Set(["fetchGdelt"]));
    expect(uses(`async function f() { const { fetchGdelt: g } = await import("./p.js"); }`)[0].names).toEqual(new Set(["fetchGdelt"]));
    expect(uses(`async function f() { return (await import("./p")).fetchGdelt; }`)[0].names).toEqual(new Set(["fetchGdelt"]));
    expect(uses(`const m = require("./p");`)[0].names).toBe("*");
    expect(uses(`import x from "drizzle-orm";`)).toEqual([]);
  });
});

/**
 * WEB-SEARCH TOOL OWNERSHIP. Closes the gap the import guard cannot see: a file that configures a provider's own
 * web-search tool inline (`genai()` + `tools: [{ googleSearch: {} }]`, Claude `web_search_*`, OpenAI `web_search`,
 * Kimi `$web_search`) reaches the web without importing anything guarded.
 *
 * Detection walks the TypeScript AST rather than grepping text, so comments, doc strings and lineage labels (e.g.
 * `tools: "web_search"` recorded as request metadata) do not count, while every literal tool config does. What it
 * cannot see: a tool name assembled at runtime (`{ [k]: {} }`, `"web_" + "search"`) or a tool config loaded from
 * JSON/env with no literal in the file. Accepted: that takes deliberate obfuscation, which review catches; a regex
 * would miss the same cases and add false positives from comments.
 */
const GEMINI_SEARCH_KEYS = new Set(["googleSearch", "googleSearchRetrieval", "google_search", "google_search_retrieval"]);
const TYPE_VALUES: Record<string, WebSearchPattern> = {
  web_search: "openai-web-search",
  web_search_preview: "openai-web-search",
  google_search: "gemini-google-search",
  google_search_retrieval: "gemini-google-search",
};
const PREFILTER = /googleSearch|google_search|web_search/i;

function propName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name) ? name.text : null;
}

function webSearchPatternsOf(file: string, source: string): Set<WebSearchPattern> {
  const found = new Set<WebSearchPattern>();
  if (!PREFILTER.test(source)) return found;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = propName(node.name);
      if (key && GEMINI_SEARCH_KEYS.has(key)) found.add("gemini-google-search");
      if (key === "web_search_options") found.add("openai-web-search");
      if (key === "type" && ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer) && TYPE_VALUES[node.initializer.text]) {
        found.add(TYPE_VALUES[node.initializer.text]);
      }
    }
    if (ts.isStringLiteralLike(node)) {
      if (/^web_search_\d{8}$/.test(node.text)) found.add("anthropic-web-search");
      if (node.text === "$web_search") found.add("kimi-web-search");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const WEB_SEARCH_FINDINGS = new Map(
  SOURCE_FILES.map((f) => [f, webSearchPatternsOf(f, read(f))] as const).filter(([, p]) => p.size > 0),
);

function howToRegisterWebSearch(): string {
  return [
    "",
    "Every non-test file that configures a provider web-search / grounding tool must be listed in WEB_SEARCH_TOOL_OWNERS",
    "(server/services/intelligence/research/acquisitionRegistry.ts), so an inline genai() + googleSearch call cannot",
    "bypass the acquisition import guard (R-c / D13). Either:",
    "  - call a registered provider instead (e.g. runGeminiOnce / geminiDirect) and drop the inline tool; or",
    "  - if this IS athlete/world acquisition: add an ACQUISITION_REGISTRY entry whose guards include this module",
    "    (owner, purpose, §11 disposition, exit criteria), then list the file as { kind: \"registered\", entry }; or",
    "  - if it is NOT (Mila ephemeral grounding, brand, Studio, dev tooling): add it to an OUT_OF_SCOPE group with a",
    "    reason, then list it as { kind: \"out-of-scope\", group }. Never use out-of-scope to hide athlete research.",
  ].join("\n");
}

describe("web-search tool ownership (inline grounding cannot bypass the guard)", () => {
  test("every file that configures a web-search tool is listed, with exactly the patterns it uses", () => {
    const offenders: string[] = [];
    for (const [file, patterns] of WEB_SEARCH_FINDINGS) {
      const owner = WEB_SEARCH_TOOL_OWNERS.find((o) => o.file === file);
      if (!owner) { offenders.push(`  ${file} configures ${[...patterns].sort().join(", ")} but is not in WEB_SEARCH_TOOL_OWNERS`); continue; }
      const extra = [...patterns].filter((p) => !owner.patterns.includes(p));
      if (extra.length) offenders.push(`  ${file} configures ${extra.sort().join(", ")}, not in its WEB_SEARCH_TOOL_OWNERS patterns`);
    }
    if (offenders.length) throw new Error(`Unlisted web-search tool configuration(s):\n${offenders.join("\n")}\n${howToRegisterWebSearch()}`);
  });

  test("no stale owner: every listed file exists and still configures every listed pattern", () => {
    const stale: string[] = [];
    for (const o of WEB_SEARCH_TOOL_OWNERS) {
      if (!existsSync(join(REPO, o.file))) { stale.push(`${o.file} does not exist — remove it from WEB_SEARCH_TOOL_OWNERS`); continue; }
      const found = WEB_SEARCH_FINDINGS.get(o.file) ?? new Set<WebSearchPattern>();
      const gone = o.patterns.filter((p) => !found.has(p));
      if (gone.length) stale.push(`${o.file} no longer configures ${gone.join(", ")} — remove ${found.size ? "the pattern" : "the file"} from WEB_SEARCH_TOOL_OWNERS`);
    }
    expect(stale).toEqual([]);
  });

  test("each owner is classified against a real entry or out-of-scope group, with a reason", () => {
    const bad: string[] = [];
    const files = WEB_SEARCH_TOOL_OWNERS.map((o) => o.file);
    if (files.length !== new Set(files).size) bad.push("duplicate file in WEB_SEARCH_TOOL_OWNERS");
    for (const o of WEB_SEARCH_TOOL_OWNERS) {
      if (!o.why.trim() || !o.patterns.length) bad.push(`${o.file}: needs a reason and at least one pattern`);
      if (o.owner.kind === "registered") {
        const id = o.owner.entry;
        const entry = ACQUISITION_REGISTRY.find((e) => e.id === id);
        // The inline config must live INSIDE the entry's guarded module, so every caller already passes the import guard.
        if (!entry) bad.push(`${o.file}: unknown acquisition entry "${id}"`);
        else if (!entry.guards.some((g) => g.module === stripExt(o.file))) bad.push(`${o.file}: not a guarded module of "${id}", so its callers would bypass the import guard`);
      } else {
        const id = o.owner.group;
        const group = OUT_OF_SCOPE.find((g) => g.id === id);
        if (!group) bad.push(`${o.file}: unknown OUT_OF_SCOPE group "${id}"`);
        else if (!group.files.includes(o.file)) bad.push(`${o.file}: not named in OUT_OF_SCOPE group "${id}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("the scan sees the known configs (sanity)", () => {
    expect(WEB_SEARCH_FINDINGS.size).toBeGreaterThanOrEqual(WEB_SEARCH_TOOL_OWNERS.length);
  });

  test("the detector: real tool configs count; comments, docs and lineage labels do not", () => {
    const p = (src: string) => [...webSearchPatternsOf("server/x/a.ts", src)].sort();
    expect(p(`const r = await genai().models.generateContent({ model, contents, config: { tools: [{ googleSearch: {} }] } });`)).toEqual(["gemini-google-search"]);
    expect(p(`const t = { googleSearchRetrieval: { dynamicRetrievalConfig: {} } };`)).toEqual(["gemini-google-search"]);
    expect(p(`const t = [{ "google_search": {} }];`)).toEqual(["gemini-google-search"]);
    expect(p(`const googleSearch = {}; const t = [{ googleSearch }];`)).toEqual(["gemini-google-search"]);
    expect(p(`const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];`)).toEqual(["anthropic-web-search"]);
    expect(p(`const T = process.env.X ?? "web_search_20250305";`)).toEqual(["anthropic-web-search"]);
    expect(p(`client.responses.create({ tools: [{ type: "web_search_preview" }] });`)).toEqual(["openai-web-search"]);
    expect(p(`client.chat.completions.create({ web_search_options: {} });`)).toEqual(["openai-web-search"]);
    expect(p(`const tools = [{ type: "builtin_function", function: { name: "$web_search" } }];`)).toEqual(["kimi-web-search"]);
    // not configurations
    expect(p(`// tools: [{ googleSearch: {} }] and Kimi $web_search\n/** type: "web_search" */`)).toEqual([]);
    expect(p(`const lineage = { path: "responses.create", params: { tools: "web_search" } };`)).toEqual([]);
    expect(p(`function googleSearch(q: string) { return q; }`)).toEqual([]);
    expect(p(`import { webSearchLimiter } from "../mila/webSearchLimiter";`)).toEqual([]);
  });
});
