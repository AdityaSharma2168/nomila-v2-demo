/**
 * boundary.test.ts — the provider-independence rule, enforced in CI (spec §19 / §28.10, LOCKED).
 *
 * Nothing under server/services/intelligence/ may import a provider or integration module.
 * Engines consume canonical, versioned signals and features; a provider response shape must
 * never reach scoring. The rule is checked on the SOURCE, not the runtime, so it catches a
 * type-only import too — a `import type { IgMedia }` couples the engine to a wire format just
 * as surely as a value import does.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname);

/** Import specifiers that mean "a provider". Add to this list; never remove from it. */
const FORBIDDEN = [
  /lib\/integrations\//,        // instagram, tiktok, youtube, gmail, outlook, spotify, discovery
  /lib\/platformDiscovery/,
  /lib\/socialWebResolver/,
  /lib\/trends/,
  /lib\/gdelt/,
  /lib\/kimi/,
  /lib\/models/,                // the Vertex / Gemini client
  /^@google\/genai/,
  /^@anthropic-ai\//,
  /^openai$/,
  /^googleapis/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Every module specifier in a file: static imports, `import type`, re-exports, dynamic imports, requires. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

describe("server/services/intelligence imports no provider module", () => {
  const files = walk(ROOT);

  it("scans at least the modules that exist today", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    it(`${relative(ROOT, file)} stays provider-free`, () => {
      const offenders = specifiersOf(readFileSync(file, "utf8")).filter((s) => FORBIDDEN.some((re) => re.test(s)));
      expect(offenders).toEqual([]);
    });
  }
});
