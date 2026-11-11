/**
 * bookLook.test — the brand book is drawn in the app's one look (owner, 23 Oct 2026; it was the Luxe document look).
 * Checked at the source, so the Luxe styling cannot come back unnoticed:
 *
 *   no Luxe              no `LX` fonts (Bodoni / Jost), no `BOOK_TOKENS`, no gold, cream or warm-ink hexes
 *   one look tokens      every file reads `Bold` (and `BoldType` / `outfitFamily` for type)
 *   one action colour    raspberry by token (`Bold.act`), never the old hot pink
 *   ring colours         only through constants/ring.ts (`Ring`, the ring component), never a hex of their own
 *   the Nomila mark      the cover's cardmark, every page's footer and the white pages' watermark are drawn
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const FILES = ["components/book/BookPages.tsx", "components/book/mark.tsx", "screens/me/BrandBookScreen.tsx"];
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const LUXE = /\bLX\b|luxe\/theme|BOOK_TOKENS|Bodoni|Jost|didone|#D3B07A|#8E6C2F|#15110D|#F3EDE3|#F4EEE2|#1B1712|#B4473F|rgba\(244,\s*238,\s*226|rgba\(27,\s*23,\s*18|rgba\(21,\s*17,\s*13/i;
const OLD_PINK = /#E84591|Accent\.pink/i;
const RING_HEX = /#2D8EFF|#7DB8FF|#2DC87C|#7FDDB0|#F28DBB|#E8A215|#F2C76A/i;

test("no Luxe fonts, tokens or warm palette left in the brand book", () => {
  for (const f of FILES) expect({ f, hit: LUXE.exec(read(f))?.[0] ?? null }).toEqual({ f, hit: null });
});

test("the one look's tokens: Bold everywhere, raspberry by token, ring colours never written here", () => {
  for (const f of FILES) {
    const src = read(f);
    expect({ f, bold: /\bBold\b/.test(src) }).toEqual({ f, bold: true });
    expect({ f, hit: OLD_PINK.exec(src)?.[0] ?? null }).toEqual({ f, hit: null });
    expect({ f, hit: RING_HEX.exec(src)?.[0] ?? null }).toEqual({ f, hit: null });
  }
  expect(read("components/book/BookPages.tsx")).toMatch(/Bold\.act/);
});

test("the Nomila mark is on the book: the cover's cardmark, a footer on every page, the watermark on white pages", () => {
  const pages = read("components/book/BookPages.tsx");
  expect(pages).toMatch(/<BookCardmark/);
  expect(pages).toMatch(/<BookFooter/);
  expect(pages).toMatch(/<RingsWatermark/);
});
