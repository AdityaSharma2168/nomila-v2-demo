/**
 * sports.test — the ONE sport list: ids are unique and stable in shape, pickleball and skiing are in it, and the landing
 * page's generated module (landing/sports.js) is exactly what shared/sports.ts writes, so the web grid, the app grid and
 * the photo library never drift. The landing page itself imports the generated module and keeps no list of its own.
 */
import fs from "node:fs";
import path from "node:path";
import { OTHER_SPORT, SPORTS, landingSportsModule, sportIdOf, sportIds } from "../shared/sports";

const ROOT = path.resolve(__dirname, "..");

test("ids are unique, lower snake case, and labels are unique", () => {
  const ids = SPORTS.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
  expect(new Set(SPORTS.map((s) => s.label.toLowerCase())).size).toBe(SPORTS.length);
  expect(ids).not.toContain(OTHER_SPORT);
});

test("pickleball and skiing are in the list", () => {
  expect(sportIdOf("Pickleball")).toBe("pickleball");
  expect(sportIdOf("skiing")).toBe("skiing");
});

test("sportIdOf reads a label or an id, ignoring case and spacing; a sport outside the list is null", () => {
  expect(sportIdOf("  Track and  field ")).toBe("track_field");
  expect(sportIdOf("swimming_diving")).toBe("swimming_diving");
  expect(sportIdOf("Underwater rugby")).toBeNull();
  expect(sportIds().has(OTHER_SPORT)).toBe(true);
});

test("landing/sports.js is the generated module (run scripts/build-landing-sports.ts after changing the list)", () => {
  expect(fs.readFileSync(path.join(ROOT, "landing", "sports.js"), "utf8").replace(/\r\n/g, "\n")).toBe(landingSportsModule());
});

test("the landing page imports the list and keeps no sport list of its own", () => {
  const html = fs.readFileSync(path.join(ROOT, "landing", "index.html"), "utf8");
  expect(html).toContain("import { SPORTS } from './sports.js';");
  expect(/const\s+SPORTS\s*=\s*\[/.test(html)).toBe(false);
});

test("every sport has an icon: a MaterialCommunityIcons name the app's icon font has, or one of the three drawn glyphs", () => {
  const glyphs = JSON.parse(fs.readFileSync(require.resolve("@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json"), "utf8")) as Record<string, number>;
  for (const s of SPORTS) {
    if ("mdi" in s.icon) expect({ id: s.id, known: s.icon.mdi in glyphs }).toEqual({ id: s.id, known: true });
    else expect(s.icon.custom).toBe(s.id);
  }
  expect(SPORTS.filter((s) => "custom" in s.icon).map((s) => s.id).sort()).toEqual(["artistic_swimming", "lacrosse", "pickleball"]);
});

test("every sport has an icon in landing/sport-icons.js (run scripts/build-landing-sport-icons.py after changing the list)", () => {
  const src = fs.readFileSync(path.join(ROOT, "landing", "sport-icons.js"), "utf8");
  const icons = new Map([...src.matchAll(/^ {2}([a-z0-9_]+): \{ viewBox: "0 0 24 24", d: "([^"]+)" \},/gm)].map((m) => [m[1], m[2]]));
  expect(SPORTS.map((s) => s.id).filter((id) => !icons.has(id))).toEqual([]);
  for (const [id, d] of icons) expect({ id, path: /^M[\d.\s\-MLHVCQSZAhvlcqsza]+$/i.test(d) }).toEqual({ id, path: true });
});

test("the generator's drawn glyphs are still the app's (each path in it appears in SportTile.tsx)", () => {
  const gen = fs.readFileSync(path.join(ROOT, "scripts", "build-landing-sport-icons.py"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "client", "components", "onboarding", "SportTile.tsx"), "utf8");
  const paths = [...gen.matchAll(/\("(M[^"]+)",/g)].map((m) => m[1]);
  expect(paths.length).toBe(8);   // lacrosse 2 (+ its rects and circle), artistic swimming 4, pickleball 2
  for (const d of paths) expect({ d, inApp: app.includes(`d="${d}"`) }).toEqual({ d, inApp: true });
});

test("the landing page draws each tile's icon from the generated module", () => {
  const html = fs.readFileSync(path.join(ROOT, "landing", "index.html"), "utf8");
  expect(html).toContain("import { SPORT_ICONS } from './sport-icons.js';");
});
