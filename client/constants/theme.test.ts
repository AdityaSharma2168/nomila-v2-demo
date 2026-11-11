/**
 * theme.test.ts — the kit's token contract.
 *
 * Pinned: the four additions the kit relies on exist in BOTH palettes (a screen that reads
 * Colors.dark.textQuiet must not get undefined), Shadows.card matches the deal card's shadow,
 * and every Tint pair is a bg/fg of six-digit hex.
 */

jest.mock("react-native", () => ({ Platform: { select: (o: any) => o.default ?? o.web, OS: "ios" } }));

import { Bold, BoldType, Colors, Ring, Shadows, Tint, Type, Typography } from "./theme";
import { Ring as RingConstant } from "./ring";

test("Bold + colour (owner, 22–23 Oct 2026): black-and-white base, links in the text colour, ONE raspberry action colour; pills, 16 cards, square photos; 48-high buttons", () => {
  expect(Bold).toMatchObject({ ink: "#0E0E0E", paper: "#FFFFFF", ground: "#F3F3F1", line: "#E4E4E2", mute: "#6B6B6B", blue: "#0E0E0E", act: "#C8325A" });
  expect(Bold.radius).toEqual({ none: 0, chip: 999, control: 16, card: 16, pill: 999, photo: 0 });
  expect(Bold.button).toBe(48);
  expect(Bold.chip).toBe(24);
  expect(Bold.gutter).toBe(16);
  // No pink anywhere in the Bold tokens: the only colours are greys, the blue and the scrims.
  for (const v of Object.values(Bold)) if (typeof v === "string") expect(v.toUpperCase()).not.toMatch(/E84591|F05BA0|FDE0EE/);
});

test("BoldType: Outfit only, 400–900 paired with the family; display, section, chip, button and label uppercase; her words 16/600; label 11/800 .12em", () => {
  const FAMILY: Record<string, string> = { "400": "Outfit_400Regular", "500": "Outfit_500Medium", "600": "Outfit_600SemiBold", "700": "Outfit_700Bold", "800": "Outfit_800ExtraBold", "900": "Outfit_900Black" };
  for (const role of Object.values(BoldType)) {
    expect(role.fontFamily).toBe(FAMILY[role.fontWeight]);
    expect(role.fontFamily).not.toMatch(/Instrument|serif/i);
    expect(Number.isInteger(role.fontSize)).toBe(true);
  }
  expect(BoldType.display).toMatchObject({ fontWeight: "900", textTransform: "uppercase" });
  expect(BoldType.section).toMatchObject({ fontSize: 17, fontWeight: "900", textTransform: "uppercase" });
  expect(BoldType.cardTitle).toMatchObject({ fontSize: 18, fontWeight: "800", textTransform: "uppercase" });
  expect(BoldType.label).toMatchObject({ fontSize: 11, fontWeight: "800", letterSpacing: 1.32, textTransform: "uppercase" });
  expect(BoldType.chip).toMatchObject({ fontSize: 10, fontWeight: "900", textTransform: "uppercase" });
  expect(BoldType.button).toMatchObject({ fontSize: 13, fontWeight: "800", textTransform: "uppercase" });
  expect(BoldType.herWords).toMatchObject({ fontSize: 16, fontWeight: "600" });
  expect(BoldType.body).toMatchObject({ fontSize: 15, fontWeight: "400" });
  expect(BoldType.caption).toMatchObject({ fontSize: 12, fontWeight: "500" });
});

test("Ring: the ONE constant — four capitals in the logo's order, two tones each, eight dimensions once, 2.6° gaps, stroke 9%; theme re-exports constants/ring", () => {
  expect(Ring).toBe(RingConstant);
  expect(Ring.capitals.map((c) => c.key)).toEqual(["audience", "commercial", "brand", "performance"]);
  expect(Ring.capitals.map((c) => c.dimensions)).toEqual([["audience_scale", "engagement_quality"], ["commercial_proof", "brand_fit"], ["narrative_power", "cultural_relevance"], ["athletic_authority", "momentum"]]);
  const dims = Ring.capitals.flatMap((c) => [...c.dimensions]);
  expect(new Set(dims).size).toBe(8);
  for (const c of Ring.capitals) {
    expect(c.tones).toHaveLength(2);
    for (const t of c.tones) expect(t).toMatch(/^#[0-9A-F]{6}$/i);
  }
  expect(Ring.gapDeg).toBe(2.6);
  expect(Ring.strokeRatio).toBe(0.09);
});

test("Type is DESIGN.md's scale (3b): Typography's sizes with the matching Outfit family on every role, Outfit only", () => {
  expect(Object.keys(Type).sort()).toEqual(["action", "body", "bodyMedium", "caption", "chip", "display", "h1", "h2", "h3", "h4", "label", "small"]);
  const FAMILY: Record<string, string> = { "400": "Outfit_400Regular", "500": "Outfit_500Medium", "600": "Outfit_600SemiBold", "700": "Outfit_700Bold", "800": "Outfit_800ExtraBold" };
  for (const role of Object.values(Type)) {
    expect(role.fontFamily).toBe(FAMILY[role.fontWeight]);              // DESIGN.md 3c: weight paired with its family
    expect(role.fontFamily).not.toMatch(/Instrument|serif/i);
    expect(Number.isInteger(role.fontSize)).toBe(true);
  }
  expect(Type.display).toMatchObject({ fontSize: 32, lineHeight: 40, fontWeight: "800", letterSpacing: -0.5 });
  expect(Type.h1).toMatchObject({ fontSize: 26, lineHeight: 32, fontWeight: "700", letterSpacing: -0.3 });
  expect(Type.h2).toMatchObject({ fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.2 });
  expect(Type.h3).toMatchObject({ fontSize: 18, lineHeight: 24, fontWeight: "600" });
  expect(Type.h4).toMatchObject({ fontSize: 16, lineHeight: 22, fontWeight: "600" });
  expect(Type.body).toMatchObject({ fontSize: 16, lineHeight: 24, fontWeight: "400" });
  expect(Type.bodyMedium).toMatchObject({ fontSize: 16, lineHeight: 24, fontWeight: "500" });
  expect(Type.small).toMatchObject({ fontSize: 14, lineHeight: 20, fontWeight: "400" });
  expect(Type.caption).toMatchObject({ fontSize: 12, lineHeight: 16, fontWeight: "500", letterSpacing: 0.2 });
  expect(Type.label).toMatchObject({ fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" });
  // Component text (DESIGN.md Chip: 12 SemiBold); small text actions.
  expect(Type.chip).toMatchObject({ fontSize: 12, lineHeight: 16, fontFamily: "Outfit_600SemiBold" });
  expect(Type.action).toMatchObject({ fontSize: 14, lineHeight: 20, fontFamily: "Outfit_600SemiBold" });
  // The scale IS Typography: the two never drift.
  for (const k of ["display", "h1", "h2", "h3", "h4", "body", "bodyMedium", "small", "caption", "label"] as const) {
    expect(Type[k]).toMatchObject(Typography[k]);
  }
});

test("the legacy palette is pointed at the one look (23 Oct 2026): white grounds, Bold greys, raspberry primary, no cream, no ring colour", () => {
  expect(Colors.light).toMatchObject({ backgroundRoot: "#FFFFFF", card: "#FFFFFF", cardElevated: "#FFFFFF", primary: "#C8325A", primaryLight: "#FCEEF2", border: Bold.line, text: Bold.ink });
  const CREAM = /FAF8F5|F5F0EB|EDE8E2|E5DFD8|E8E2DB|F0EBE5|FFFCF9|F3EEE4/;
  const RING = /E84591|F05BA0|FDE0EE|2D8EFF/;
  for (const v of Object.values(Colors.light)) { expect(v.toUpperCase()).not.toMatch(CREAM); expect(v.toUpperCase()).not.toMatch(RING); }
  expect(Tint.stage).toEqual({ bg: "#FCEEF2", fg: "#C8325A" });
});

test("textQuiet and onHero exist in both palettes", () => {
  expect(Colors.light.textQuiet).toBe(Bold.quiet);
  expect(Colors.light.onHero).toBe("#FFFFFF");
  expect(Colors.dark.textQuiet).toMatch(/^#[0-9A-F]{6}$/i);
  expect(Colors.dark.onHero).toMatch(/^#[0-9A-F]{6}$/i);
});

test("Shadows.card is the deal card's shadow: offset 2, radius 8, 7%", () => {
  expect(Shadows.card).toMatchObject({ shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.07 });
});

test("every Tint is a bg/fg pair of hex colours, and the kit's eight meanings are present", () => {
  expect(Object.keys(Tint).sort()).toEqual(["estimated", "found", "made", "none", "proof", "said", "stage", "verified"]);
  for (const t of Object.values(Tint)) {
    expect(t.bg).toMatch(/^#[0-9A-F]{6}$/i);
    expect(t.fg).toMatch(/^#[0-9A-F]{6}$/i);
  }
});
