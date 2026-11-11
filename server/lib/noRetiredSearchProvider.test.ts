/**
 * noRetiredSearchProvider.test.ts — the retired third-party search provider never comes back (owner, Nov 2026: all web
 * search goes through OpenAI, the model/provider policy). Fails if its name appears anywhere in server or client code, scripts,
 * the Cloud Run yamls, the deploy workflows or package.json: an import, an API host, an env var, a secret mount or a
 * dependency. This file is the only allowed mention (the name is assembled so even it does not spell it).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(__dirname, "..", "..");
const NAME = ["tav", "ily"].join("");
const PATTERN = new RegExp(NAME, "i");
const SELF = relative(REPO, __filename).replace(/\\/g, "/");

const ROOTS = ["server", "client", "scripts", "gcp", "shared", ".github"];
const FILES = ["package.json", "package-lock.json", "Dockerfile", "cloudbuild.yaml"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const EXT = /\.(ts|tsx|js|cjs|mjs|json|ya?ml|sh|md|toml|env|txt)$/i;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(e)) out.push(p);
  }
}

test("no file in server, client, scripts, shared, gcp, the workflows or package.json names the retired search provider", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(join(REPO, r), files);
  for (const f of FILES) files.push(join(REPO, f));
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(REPO, f).replace(/\\/g, "/");
    if (rel === SELF) continue;
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    if (!PATTERN.test(text)) continue;
    const lines = text.split("\n").map((l, i) => (PATTERN.test(l) ? `${rel}:${i + 1}` : null)).filter(Boolean);
    hits.push(...(lines as string[]));
  }
  expect(hits).toEqual([]);
});
