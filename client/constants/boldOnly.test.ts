/**
 * boldOnly.test — the surfaces read the one look (`Look`, DESIGN.md 22 Oct 2026) or, until restyled, look B; checked
 * at the source:
 *
 *   no pink, no legacy palette      no `Colors.`, no `Tint`, no ring-pink hex, no `primary` token — Bold tokens only
 *                                   (the one action colour is Bold.act, raspberry; the ring pink never paints UI)
 *   pills by token, no shadows      pills come from `Bold.radius.pill` / `Look.radius` (the one look, 22 Oct 2026),
 *                                   never a typed `borderRadius: 999` or the legacy `BorderRadius.`; no `Shadows.`
 *   no legacy type                  no `Type.` (the legacy scale); BoldType only
 *   the kit's legacy variants       the three kit files that carry BOTH looks (Chip, IconTile, LogoMark) are allowed
 *                                   `Colors` / `Tint` / `Type` / `BorderRadius` for the legacy branch, never pink
 *   the ring's colours              live in constants/ring.ts only — no surface writes a ring hex of its own
 */
import fs from "node:fs";
import path from "node:path";
import { CONCEPT04_SURFACES as SURFACES, KIT_WITH_LEGACY } from "./concept04Surfaces";

const ROOT = path.resolve(__dirname, "..");
const PINK = /#E84591|#F05BA0|#FDE0EE|ringPink|primaryLight|C\.primary\b|Colors\.(light|dark)\.primary/i;
/** The dual-look kit files keep the legacy `primary` branch by token; they may never write a pink hex. */
const PINK_HEX = /#E84591|#F05BA0|#FDE0EE/i;
const LEGACY = /\bColors\.(light|dark)\b|\bTint\b|\bTint\.|tint=|\bType\.|BorderRadius\.|Shadows\.|borderRadius:\s*(999|9999)/;
const RING_HEX = /#2D8EFF|#7DB8FF|#2DC87C|#7FDDB0|#F28DBB|#E8A215|#F2C76A/i;

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("no pink on any Concept 0.4 surface or in the shell", () => {
  for (const f of SURFACES) expect({ f, hit: (KIT_WITH_LEGACY.has(f) ? PINK_HEX : PINK).exec(read(f))?.[0] ?? null }).toEqual({ f, hit: null });
});

test("no legacy palette, tints, type scale, pill radius or shadows on the surfaces (the kit's dual-look files excepted)", () => {
  for (const f of SURFACES) {
    if (KIT_WITH_LEGACY.has(f)) continue;
    expect({ f, hit: LEGACY.exec(read(f))?.[0] ?? null }).toEqual({ f, hit: null });
  }
});

test("the ring colours are written once, in constants/ring.ts — no surface carries a ring hex of its own", () => {
  for (const f of SURFACES) expect({ f, hit: RING_HEX.exec(read(f))?.[0] ?? null }).toEqual({ f, hit: null });
  expect(RING_HEX.test(fs.readFileSync(path.join(ROOT, "constants/ring.ts"), "utf8"))).toBe(true);
});

test("every surface reads its tokens from the one look (Look / useLook) or, until restyled, Bold / BoldType", () => {
  for (const f of SURFACES) {
    if (KIT_WITH_LEGACY.has(f) || f.endsWith("Glyphs.tsx")) continue;
    expect({ f, bold: /\bBold(Type)?\b|\bLook\b|\buseLook\b/.test(read(f)) }).toEqual({ f, bold: true });
  }
});
