/**
 * Every colour and every typeface in the Studio screens must come from constants/theme.ts.
 *
 * The prototype these screens were ported from carried its own palette and its own fonts. Porting
 * a design means porting the DECISIONS, not the values — a hex pasted across from the prototype
 * looks right on the day and quietly becomes a second palette that nobody maintains.
 *
 * This is a lint with teeth rather than a convention, because a convention only holds while
 * somebody remembers it.
 *
 * It reads theme.ts as TEXT rather than importing it, deliberately: the theme pulls in react-native
 * for Platform.select, which this Jest project does not transform. Reading the source keeps the
 * guard dependency-free and still checks against the one real file.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const DIR = __dirname;
const THEME = readFileSync(
  join(DIR, "..", "..", "constants", "theme.ts"),
  "utf8",
);

/** Token names under Colors.light, taken from the theme's own source. */
const COLOR_TOKENS = (() => {
  const start = THEME.indexOf("export const Colors");
  const light = THEME.slice(
    THEME.indexOf("light:", start),
    THEME.indexOf("dark:", start),
  );
  return new Set([...light.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]));
})();

/** Every font family the theme exports, however it spells them. */
const FONT_VALUES = (() => {
  const start = THEME.indexOf("export const Fonts");
  const block = THEME.slice(
    start,
    THEME.indexOf("export const Shadows", start),
  );
  return new Set(
    [...block.matchAll(/["']([A-Za-z0-9_\- ]+)["']/g)].map((m) => m[1]),
  );
})();

const sources = readdirSync(DIR)
  .filter(
    (f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.endsWith(".test.ts"),
  )
  .map((f) => ({ file: f, text: readFileSync(join(DIR, f), "utf8") }));

/**
 * Overlay alphas are the one legitimate literal: a 42% wash over a photograph is not a palette
 * entry and there is no token for it. They still have to derive from the repo's own near-black
 * (Brand.heroBg #0D0B08 = 13,11,8), not from a warm black carried over from somewhere else.
 */
const ALLOWED_RGBA = /^rgba\((?:13,\s*11,\s*8|255,\s*255,\s*255),\s*[\d.]+\)$/;

/** Reports offenders as file:line so a failure says where, not just that. */
function scan(match: (line: string) => string[] | null): string[] {
  const out: string[] = [];
  for (const { file, text } of sources) {
    text.split("\n").forEach((line, i) => {
      const hits = match(line);
      if (hits?.length) hits.forEach((h) => out.push(`${file}:${i + 1}  ${h}`));
    });
  }
  return out;
}

describe("the Studio screens use the repo's design system", () => {
  it("read the theme it is checking against", () => {
    // Guards against the whole suite passing vacuously because a path or a heading moved.
    expect(COLOR_TOKENS.has("primary")).toBe(true);
    expect(COLOR_TOKENS.has("backgroundRoot")).toBe(true);
    expect(FONT_VALUES.has("Outfit_700Bold")).toBe(true);
    expect(sources.length).toBeGreaterThan(5);
  });

  it("declares no raw hex colours", () => {
    expect(scan((l) => l.match(/["']#[0-9A-Fa-f]{3,8}["']/g))).toEqual([]);
  });

  it("declares no rgba outside the overlay alphas", () => {
    expect(
      scan((l) =>
        (l.match(/rgba\([^)]*\)/g) ?? []).filter((c) => !ALLOWED_RGBA.test(c)),
      ),
    ).toEqual([]);
  });

  it("names only fonts the theme exports", () => {
    expect(
      scan((l) => {
        const m = l.match(/fontFamily:\s*["']([^"']+)["']/);
        return m && !FONT_VALUES.has(m[1]) ? [m[1]] : null;
      }),
    ).toEqual([]);
  });

  it("resolves every colour reference to a token that exists", () => {
    expect(
      scan((l) =>
        [...l.matchAll(/Colors\.light\.(\w+)/g)]
          .filter((m) => !COLOR_TOKENS.has(m[1]))
          .map((m) => `Colors.light.${m[1]}`),
      ),
    ).toEqual([]);
  });

  it("catches a colour that does not exist, so the check is known to bite", () => {
    // The guard above passes on an empty list either way; this proves it can fail.
    expect(COLOR_TOKENS.has("neonPurple")).toBe(false);
  });
});
