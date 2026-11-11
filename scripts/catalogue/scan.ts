/**
 * catalogue/scan.ts — the source scans behind the catalogue (scripts/catalogue/build.ts): one TypeScript-AST pass over
 * server/ and shared/ for env reads, /api/internal/* routes, in-process crons and long prompt-like strings, plus the
 * deploy files (gcp/cloud-run-*.yaml, eas.json, scripts/provision-schedulers.sh) for the values the flags take.
 *
 * Everything here reads files only; nothing is imported or run. Output is sorted and carries no line numbers in the
 * fields the committed JSON keeps (a line moves with every unrelated edit above it, and the CI staleness check would
 * then fail on edits that change nothing the catalogue is about). Line numbers ride along as `line` for the HTML page.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const short = (digest: string) => digest.slice(0, 12);
/** Text as the catalogue sees it: LF line endings, so a Windows checkout and Linux CI agree byte for byte. */
export const lf = (text: string) => text.replace(/\r\n?/g, "\n");
export const readText = (file: string) => lf(readFileSync(file, "utf8"));
export const rel = (root: string, file: string) => relative(root, file).split(sep).join("/");

const SKIP_DIRS = new Set(["node_modules", "__fixtures__", ".mastra", "server_dist", "dist", "build"]);
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /\/__tests__\//.test(f) || /\/testUtils\//.test(f);

/** Every .ts (and optionally .tsx) file under `dir`, test files excluded, sorted by repo path. */
export function sourceFiles(root: string, dir: string, exts: string[] = [".ts"]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(p); }
      else if (exts.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts") && !isTest(rel(root, p))) out.push(p);
    }
  };
  if (existsSync(join(root, dir))) walk(join(root, dir));
  return out.sort((a, b) => rel(root, a).localeCompare(rel(root, b)));
}

// ─── the AST pass ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface EnvRead { name: string; file: string; how: "direct" | "helper"; defaultOn: boolean; boolean: boolean }
export interface InternalRoute { method: string; path: string; file: string; line: number }
export interface InProcessCron { schedule: string; runs: string[]; gatedBy: string[]; file: string; line: number }
export interface InlinePrompt { file: string; anchor: string; chars: number; digest: string; preview: string; line: number }

export interface ServerScan { env: EnvRead[]; routes: InternalRoute[]; crons: InProcessCron[]; prompts: InlinePrompt[] }

const ENV_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** A config helper that reads a name as an on/off flag (flag("X"), flagOn("X"), envBool("X") …). */
const BOOL_HELPER_RE = /flag|bool|^isOn$|enabled/i;
const PROMPT_MIN_CHARS = 400;
/** Words a model prompt uses and other long strings (SQL, HTML, fixtures) rarely do. Two distinct hits, plus "you"/JSON. */
const PROMPT_WORDS = [/\byou are\b/i, /\byour (task|job|role)\b/i, /\brespond\b/i, /\breturn (only |a |the )?(json|object|array)\b/i, /\boutput\b/i, /\binstructions?\b/i, /\bdo not\b|\bdon't\b/i, /\bnever\b/i, /\bmust\b/i, /\brules?:/i, /\bthe athlete\b/i, /\bschema\b/i];
const NOT_PROMPT = [/^\s*(select|insert|update|delete|create|alter|with)\b/i, /<!doctype|<html|<div|<svg|<table/i];

function looksLikePrompt(text: string): boolean {
  if (NOT_PROMPT.some((r) => r.test(text))) return false;
  if (!/\byou\b|\bjson\b/i.test(text)) return false;
  return PROMPT_WORDS.filter((r) => r.test(text)).length >= 2;
}

/** The literal text of a string-ish node, with `${…}` for each substitution. Null for anything else. */
function literalText(node: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => "${…}" + s.literal.text).join("");
  return null;
}

/** "outer.inner" from the named declarations around a node (variables, functions, methods, properties, classes). */
function anchorOf(node: ts.Node): string {
  const names: string[] = [];
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    const named = (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n)
      || ts.isClassDeclaration(n) || ts.isPropertyDeclaration(n)) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name));
    if (named) names.unshift((n as unknown as { name: ts.Identifier | ts.StringLiteral }).name.text);
  }
  return names.join(".") || "(top level)";
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The functions a cron callback runs: names destructured from a dynamic import, then plain calls (helpers skipped). */
const CRON_SKIP = new Set(["import", "then", "catch", "info", "warn", "error", "withAdvisoryLock", "String", "Date", "now", "toISOString", "setTimeout"]);
function cronRuns(body: ts.Node): string[] {
  const out: string[] = [];
  const add = (n: string) => { if (!CRON_SKIP.has(n) && !/^LOCK_/.test(n) && !out.includes(n)) out.push(n); };
  const visit = (n: ts.Node) => {
    if (ts.isObjectBindingPattern(n)) for (const e of n.elements) if (ts.isIdentifier(e.name)) add(e.name.text);
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) add(e.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out.slice(0, 3);
}

export function scanServer(root: string, dirs: string[] = ["server", "shared"]): ServerScan {
  const env: EnvRead[] = [], routes: InternalRoute[] = [], crons: InProcessCron[] = [], prompts: InlinePrompt[] = [];
  for (const file of dirs.flatMap((d) => sourceFiles(root, d))) {
    const path = rel(root, file);
    const text = readText(file);
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    // …or through the spend-cap helpers (server/lib/spendCap.ts readCap / readPrice), which read process.env[name].
    const dynamicEnv = /process\.env\[/.test(text) || /\b(readCap|readPrice|readSpendCap)\(/.test(text);
    // `const env = process.env` / `env: NodeJS.ProcessEnv = process.env`: then env.X is a read too.
    const aliased = /(?:=|\?\?|\|\|)\s*process\.env\s*[;,)\n]/.test(text);

    const visit = (node: ts.Node) => {
      // process.env.X and process.env["X"]
      if (ts.isPropertyAccessExpression(node) && (node.expression.getText(sf) === "process.env"
        || (aliased && node.expression.getText(sf) === "env" && ENV_NAME_RE.test(node.name.text)))) {
        env.push({ name: node.name.text, file: path, how: "direct", ...compareAt(node) });
      } else if (ts.isElementAccessExpression(node) && node.expression.getText(sf) === "process.env" && ts.isStringLiteral(node.argumentExpression)) {
        env.push({ name: node.argumentExpression.text, file: path, how: "direct", ...compareAt(node) });
      }
      // A file that reads process.env[name] through a helper: an ENV_NAME-looking literal handed to a call, picked in a
      // conditional, or bound to a name or property there counts as a read (heuristic; misses names built at run time).
      if (dynamicEnv && ts.isStringLiteral(node) && ENV_NAME_RE.test(node.text) && node.parent
        && (ts.isCallExpression(node.parent) || ts.isConditionalExpression(node.parent) || ts.isVariableDeclaration(node.parent)
          || ts.isPropertyAssignment(node.parent) || ts.isArrayLiteralExpression(node.parent))) {
        const callee = ts.isCallExpression(node.parent) ? node.parent.expression : null;
        const helper = callee ? (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "") : "";
        if (!/^(info|warn|error|debug|log|Error)$/.test(helper)) env.push({ name: node.text, file: path, how: "helper", defaultOn: false, boolean: BOOL_HELPER_RE.test(helper) });
      }
      if (ts.isCallExpression(node)) {
        const first = node.arguments[0];
        // app.post("/api/internal/…", …)
        const callee = node.expression;
        if (first && ts.isPropertyAccessExpression(callee) && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
          && first.text.startsWith("/api/internal/") && /^(get|post|put|patch|delete|all|use)$/.test(callee.name.text)) {
          routes.push({ method: callee.name.text.toUpperCase(), path: first.text, file: path, line: lineOf(node) });
        }
        // cron.schedule("…", fn)
        if (callee.getText(sf) === "cron.schedule" && first && ts.isStringLiteral(first)) {
          const gatedBy: string[] = [];
          for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isIfStatement(p)) gatedBy.unshift(norm(p.expression.getText(sf)));
          crons.push({ schedule: first.text, runs: node.arguments[1] ? cronRuns(node.arguments[1]) : [], gatedBy, file: path, line: lineOf(node) });
        }
      }
      const lit = literalText(node);
      if (lit !== null && lit.length > PROMPT_MIN_CHARS && looksLikePrompt(lit)) {
        prompts.push({ file: path, anchor: anchorOf(node), chars: lit.length, digest: short(sha256(lf(lit))), preview: norm(lit).slice(0, 140), line: lineOf(node) });
        return; // a template's spans are inside it; never count them twice
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const byFile = (a: { file: string; line: number }, b: { file: string; line: number }) => a.file.localeCompare(b.file) || a.line - b.line;
  return { env, routes: routes.sort(byFile), crons: crons.sort(byFile), prompts: prompts.sort(byFile) };
}

/**
 * How a read is compared: against "true"/"false"/"1"/"0" makes it an on/off flag; `!== "false"` (or "0") makes it on
 * unless someone sets it off (defaultOn). Walks up through `.trim()`, `.toLowerCase()`, `?.`, `!` and parentheses.
 */
function compareAt(node: ts.Node): { defaultOn: boolean; boolean: boolean } {
  let n: ts.Node = node;
  while (n.parent && (ts.isPropertyAccessExpression(n.parent) || (ts.isCallExpression(n.parent) && n.parent.expression === n) || ts.isNonNullExpression(n.parent) || ts.isParenthesizedExpression(n.parent))) n = n.parent;
  const p = n.parent;
  if (!p || !ts.isBinaryExpression(p)) return { defaultOn: false, boolean: false };
  const k = p.operatorToken.kind;
  const other = p.left === n ? p.right : p.left;
  if (!ts.isStringLiteral(other) || !/^(true|false|1|0|on|off|yes|no)$/i.test(other.text)) return { defaultOn: false, boolean: false };
  const negated = k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;
  return { boolean: true, defaultOn: negated && /^(false|0|off|no)$/i.test(other.text) };
}

/** EXPO_PUBLIC_* names the client reads (Expo inlines only static process.env.EXPO_PUBLIC_X, so a text scan is exact). */
export function scanClientEnv(root: string): Array<{ name: string; file: string; defaultOn: boolean; boolean: boolean }> {
  const out: Array<{ name: string; file: string; defaultOn: boolean; boolean: boolean }> = [];
  for (const file of sourceFiles(root, "client", [".ts", ".tsx"])) {
    const text = readText(file);
    for (const m of text.matchAll(/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)(?:\??\.\w+\(\))*(\s*(===?|!==?)\s*["'](true|false|1|0)["'])?/g)) {
      out.push({ name: m[1], file: rel(root, file), boolean: !!m[2], defaultOn: !!m[2] && m[3].startsWith("!") && /^(false|0)$/.test(m[4]) });
    }
  }
  return out;
}

// ─── deploy files ──────────────────────────────────────────────────────────────────────────────────────────────────

/** name → value from a Cloud Run service yaml (a Secret Manager reference shows as "secret:<name>"). */
export function cloudRunEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const doc = parseYaml(readText(file)) as any;
  const out: Record<string, string> = {};
  for (const c of doc?.spec?.template?.spec?.containers ?? []) {
    for (const e of c.env ?? []) {
      out[e.name] = e.value !== undefined ? String(e.value) : e.valueFrom?.secretKeyRef ? `secret:${e.valueFrom.secretKeyRef.name}` : "(from)";
    }
  }
  return out;
}

/** profile → { name → value } from eas.json build profiles. */
export function easEnv(file: string): Record<string, Record<string, string>> {
  if (!existsSync(file)) return {};
  const doc = JSON.parse(readText(file));
  const out: Record<string, Record<string, string>> = {};
  for (const [profile, p] of Object.entries<any>(doc.build ?? {})) out[profile] = Object.fromEntries(Object.entries<any>(p.env ?? {}).map(([k, v]) => [k, String(v)]));
  return out;
}

export interface SchedulerJob { name: string; schedule: string; path: string; deadline: string }

/** The JOBS=( "name|schedule|path|deadline[|content-type]" … ) table in scripts/provision-schedulers.sh. */
export function schedulerJobs(file: string): SchedulerJob[] {
  if (!existsSync(file)) return [];
  const m = /^JOBS=\(\n([\s\S]*?)\n\)/m.exec(readText(file));
  if (!m) return [];
  return [...m[1].matchAll(/^\s*"([^"]+)"/gm)].map((x) => {
    const [name, schedule, path, deadline] = x[1].split("|");
    return { name, schedule, path, deadline };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
