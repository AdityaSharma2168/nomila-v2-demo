/**
 * outfitOnly.test — the Concept 0.4 surfaces (Home, Strategy, the Me screens, the shell and the pieces they share) are
 * Outfit ONLY (DESIGN.md §3) and type nothing of their own: no Instrument Serif, no `Fonts.serif`, no ad-hoc `fontSize`
 * — every text style spreads a Type / BoldType role. Checked at the source, so a stray fontFamily cannot come back
 * unnoticed.
 */
import fs from "node:fs";
import path from "node:path";
import { CONCEPT04_SURFACES } from "./concept04Surfaces";

const ROOT = path.resolve(__dirname, "..");
const SURFACES = CONCEPT04_SURFACES;
/** The places a size is derived from a graphic, not typed: the ring scales its number, the mark its initials, the category default its word. */
const SCALED = new Set(["components/intelligence/IntelligenceRing.tsx", "components/ui/LogoMark.tsx", "components/strategy/RecommendationVisual.tsx"]);

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("no serif anywhere on the Concept 0.4 surfaces", () => {
  for (const f of SURFACES) {
    const src = read(f);
    expect({ f, hit: /InstrumentSerif|Fonts\.editorial|Fonts\.serif/.exec(src)?.[0] ?? null }).toEqual({ f, hit: null });
  }
});

test("no ad-hoc fontSize or fontFamily: every text style spreads a Type / BoldType role", () => {
  for (const f of SURFACES) {
    const src = read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const sizes = (src.match(/fontSize:\s*[\d.]+/g) ?? []).length;
    const families = (src.match(/fontFamily:\s*["']/g) ?? []).length;
    expect({ f, sizes: SCALED.has(f) ? 0 : sizes, families }).toEqual({ f, sizes: 0, families: 0 });
    expect(/Fonts\.(display|displayBold|heading|headingSemiBold|body|bodyMedium|bodySemiBold|bodyBold|sans|rounded|mono)\b/.test(src)).toBe(false);
  }
});
