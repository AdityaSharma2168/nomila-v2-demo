/**
 * importGuard.test — the chat library stays in ONE folder (approved design, "One module on the phone").
 *
 *   1. Only client/components/mila/thread/ may import @assistant-ui/*, @ai-sdk/*, assistant-stream, assistant-cloud or
 *      `ai` — anywhere in the app's code (client/ and shared/, which the app bundles). A library upgrade then touches
 *      one folder, and everything else stays on our own components.
 *   2. The card views (client/components/mila/cards/) know nothing about the library — not even through the thread
 *      module.
 *   3. The thread module hands no library export out (no `export … from "ai"`), so nothing outside can reach the
 *      library THROUGH it.
 *   4. The thread module's iOS/Android files use no browser-only API (document, window, navigator, visualViewport,
 *      localStorage): those live in its *.web.ts files only.
 * The server is out of scope (it runs the Mastra engine on @ai-sdk/* by design).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const THREAD_DIR = ["client", "components", "mila", "thread"].join("/") + "/";
const CARDS_DIR = ["client", "components", "mila", "cards"].join("/") + "/";

const LIBRARY = /^(?:@assistant-ui\/|@ai-sdk\/|assistant-stream(?:\/|$)|assistant-cloud(?:\/|$)|ai(?:\/|$))/;
// Static imports and re-exports (`from "x"`), side-effect imports, dynamic import() and require() — with any quote,
// backticks included (a template literal with no substitution is still a static specifier).
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`$]+)["'`]/gm;
/** `export … from "x"` / `export * from "x"`: a re-export (multi-line export lists included). */
const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["'`]([^"'`]+)["'`]/g;

export function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) out.push(m[1]);
  return out;
}

export function reexports(source: string): string[] {
  return [...source.matchAll(REEXPORT)].map((m) => m[1]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:tsx?|jsx?|cjs|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const appFiles = [...walk(join(ROOT, "client")), ...walk(join(ROOT, "shared"))];

describe("the chat library is imported only inside client/components/mila/thread/", () => {
  it("the matcher catches every form an import can take (and leaves look-alikes alone)", () => {
    const sample = [
      'import { useChat } from "@ai-sdk/react";',
      "import type { UIMessage } from 'ai';",
      'const x = require("@assistant-ui/react-native");',
      'const y = await import("assistant-stream/utils");',
      'import "ai/internal";',
      "const z = await import(`@ai-sdk/provider-utils`);",
      'export * from "@assistant-ui/core";',
      'export {\n  useChat,\n} from "@ai-sdk/react";',
      'import { aiThing } from "./ai";',
      'import { z } from "aim";',
    ].join("\n");
    expect(specifiers(sample).filter((s) => LIBRARY.test(s))).toEqual([
      "@ai-sdk/react", "ai", "@assistant-ui/react-native", "assistant-stream/utils", "ai/internal",
      "@ai-sdk/provider-utils", "@assistant-ui/core", "@ai-sdk/react",
    ]);
    expect(reexports('export * from "ai";\nexport { a as b } from "@assistant-ui/x";\nexport type { T } from "./wire";'))
      .toEqual(["ai", "@assistant-ui/x", "./wire"]);
  });

  it("the thread module re-exports nothing from the library (so the library cannot leak out through it)", () => {
    const offenders = appFiles.filter((f) => rel(f).startsWith(THREAD_DIR) && !/\.test\.tsx?$/.test(f))
      .flatMap((f) => reexports(readFileSync(f, "utf8")).filter((s) => LIBRARY.test(s)).map((s) => `${rel(f)} → ${s}`));
    expect(offenders).toEqual([]);
  });

  it("no file outside the thread module imports @assistant-ui/*, @ai-sdk/*, assistant-stream, assistant-cloud or ai", () => {
    const offenders = appFiles
      .filter((f) => !rel(f).startsWith(THREAD_DIR))
      .flatMap((f) => specifiers(readFileSync(f, "utf8")).filter((s) => LIBRARY.test(s)).map((s) => `${rel(f)} → ${s}`));
    expect(offenders).toEqual([]);
  });

  it("the thread module does import them (the guard is guarding something real)", () => {
    const inside = appFiles.filter((f) => rel(f).startsWith(THREAD_DIR))
      .flatMap((f) => specifiers(readFileSync(f, "utf8")).filter((s) => LIBRARY.test(s)));
    expect(inside).toEqual(expect.arrayContaining(["@assistant-ui/react-native", "@assistant-ui/ai-sdk", "@ai-sdk/react", "ai"]));
  });

  it("the card views know nothing about the library, not even through the thread module", () => {
    const cards = appFiles.filter((f) => rel(f).startsWith(CARDS_DIR));
    expect(cards.length).toBeGreaterThan(0);
    const offenders = cards.flatMap((f) =>
      specifiers(readFileSync(f, "utf8")).filter((s) => LIBRARY.test(s) || /(?:^|\/)thread(?:\/|$)/.test(s)).map((s) => `${rel(f)} → ${s}`));
    expect(offenders).toEqual([]);
  });

  it("the thread module's iOS/Android files reach for no browser-only API (only its *.web.ts files may)", () => {
    const native = appFiles.filter((f) => rel(f).startsWith(THREAD_DIR) && !/\.web\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(native.length).toBeGreaterThan(3);
    // `document.x`, `document?.x`, `window["x"]`, and the globalThis forms (`globalThis.document`).
    const DOM = /\b(?:document|window|navigator|visualViewport|localStorage|sessionStorage)\s*(?:\?\.|\.|\[)|\bglobalThis\s*(?:\?\.|\.)\s*(?:document|window|navigator|visualViewport|localStorage|sessionStorage)\b/;
    const offenders = native.flatMap((f) =>
      readFileSync(f, "utf8").split("\n")
        .map((line, i) => ({ line: line.replace(/\/\/.*$|^\s*\*.*$/, ""), i }))
        .filter(({ line }) => DOM.test(line))
        .map(({ i }) => `${rel(f)}:${i + 1}`));
    expect(offenders).toEqual([]);
  });
});
