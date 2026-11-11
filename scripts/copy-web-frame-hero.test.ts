/**
 * copy-web-frame-hero.test — the web frame's backdrop is the landing's hero, and the web builds ship its photos:
 *   - every slide in heroSlides.ts has both landing files (960 and 1920), in the landing's order and object-position
 *   - both web deploy workflows copy them into dist after `expo export`
 */
import fs from "fs";
import path from "path";
import { HERO_SLIDES, HERO_WIDTHS } from "../client/components/web/heroSlides";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { heroFiles } = require("./copy-web-frame-hero.js");

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("web frame hero photos", () => {
  it("every slide has the landing's 960 and 1920 webp, and the script copies exactly those", () => {
    const files: string[] = heroFiles();
    const want = HERO_SLIDES.flatMap((s) => HERO_WIDTHS.map((w) => `${s.stem}-${w}.webp`)).sort();
    expect(files).toEqual(want);
  });

  it("same photos, order and object-position as the landing's hero", () => {
    const html = read("landing/index.html");
    const landing = [...html.matchAll(/<img class="hero-slide hs(\d)"[^>]*?assets\/v2\/(hero-\d)-1920\.webp[^>]*?object-position: ([^;"]+);/g)]
      .map((m) => ({ stem: m[2], position: m[3].trim() }));
    expect(landing).toEqual(HERO_SLIDES);
  });

  it.each([".github/workflows/deploy-web-dev.yml", ".github/workflows/deploy-prod.yml"])("%s copies them after the web export", (wf) => {
    const y = read(wf);
    const exp = y.indexOf("npx expo export --platform web");
    const copy = y.indexOf("node scripts/copy-web-frame-hero.js");
    expect(exp).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(exp);
  });
});
