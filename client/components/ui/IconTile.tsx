// IconTile — the ONE icon tile (visual rules, Oct 2026). Feather glyphs only.
//
// LEGACY look:
//   <IconTile icon="book-open" />                    36 · corner 10 · glyph 18 — rows and cards
//   <IconTile icon="award" size={44} />              44 · corner 12 · glyph 22 — section headers only
//   <IconTile icon="heart" tint={{ bg, fg }} />      a given bg/fg pair
//
// LOOK B (DESIGN.md, Oct 2026 — the Concept 0.4 surfaces):
//   <IconTile icon="activity" bold="black" />        40 · corner 4 · black square · white Feather 18 — doors, help rows, marks
//   <IconTile icon="heart" bold="grey" />            the grey variant: the ground with ink — a neutral domain tile
//   size 44 keeps the 44 · glyph 22 pairing. Domain tiles carry NO colour: colour on screen always means a part of the score.

import React from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Bold } from "../../constants/theme";

const C = Colors.light;
type IconName = React.ComponentProps<typeof Feather>["name"];

export type IconTileSize = 36 | 40 | 44;
export type IconTileBold = "black" | "grey";
const SPEC: Record<IconTileSize, { radius: number; glyph: number }> = { 36: { radius: 10, glyph: 18 }, 40: { radius: Bold.radius.control, glyph: 18 }, 44: { radius: 12, glyph: 22 } };

export function IconTile({ icon, size, tint, muted, bold, style, testID }: {
  icon: IconName;
  size?: IconTileSize;
  /** A meaning's bg/fg pair (legacy). Absent ⇒ the neutral ground. */
  tint?: { bg: string; fg: string } | null;
  /** A quiet glyph (a door that is not open yet). */
  muted?: boolean;
  /** Look B: the black square (white glyph) or the grey one (ink glyph). */
  bold?: IconTileBold;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const s0 = size ?? (bold ? 40 : 36);
  const s = SPEC[s0];
  if (bold) {
    const black = bold === "black";
    return (
      <View style={[styles.tile, { width: s0, height: s0, borderRadius: Bold.radius.control, backgroundColor: black ? Bold.ink : Bold.ground }, muted && styles.muted, style]} testID={testID ?? `tile-${bold}`}>
        <Feather name={icon} size={s.glyph} color={black ? Bold.onDark : Bold.ink} />
      </View>
    );
  }
  return (
    <View style={[styles.tile, { width: s0, height: s0, borderRadius: s.radius, backgroundColor: tint?.bg ?? C.backgroundDefault }, style]} testID={testID}>
      <Feather name={icon} size={s.glyph} color={tint?.fg ?? (muted ? C.textQuiet : C.text)} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile:  { alignItems: "center", justifyContent: "center" },
  muted: { opacity: 0.5 },
});
