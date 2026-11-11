/**
 * SportTile — one sport as an icon tile (design "Sport grid, with icons", approved 23 Oct 2026): the sport's icon above
 * its name (two lines at most), white with a 1px line; the MAIN pick solid raspberry with a white "Main" badge; any
 * other pick a light raspberry tint, raspberry line and ink, with a raspberry check. The onboarding grid
 * (screens/onboarding/SportGridScreen) and Mila's chat chips (SportChips) both draw it.
 *
 * SportIcon draws a sport's icon from the one list (shared/sports.ts): a MaterialCommunityIcons glyph, or one of three
 * glyphs drawn here in the same filled 24-unit style (lacrosse, artistic swimming, pickleball). PickedPill is a pick
 * with no tile (a typed sport, or a chat pick from the full list), removable with its ✕.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import { Bold, BoldType } from "../../constants/theme";
import type { CustomSportIcon, SportIcon as SportIconSpec } from "../../../shared/sports";

type MdiName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

/** The three drawn glyphs, on a 24 × 24 grid like the MaterialCommunityIcons set (filled, ~2-unit strokes). */
function CustomGlyph({ name, size, color }: { name: CustomSportIcon; size: number; color: string }) {
  const body =
    name === "lacrosse" ? (
      <>
        <G transform="rotate(45 16.2 7.8)">
          <Path fillRule="evenodd" d="M16.2 1.6c2.6 0 4.5 2.6 4.5 5.8 0 2.9-1.6 5.3-3.4 6.2l-.3 1.6h-1.6l-.3-1.6c-1.8-.9-3.4-3.3-3.4-6.2 0-3.2 1.9-5.8 4.5-5.8zm0 2c-1.3 0-2.5 1.6-2.5 3.8s1.2 3.8 2.5 3.8 2.5-1.6 2.5-3.8-1.2-3.8-2.5-3.8z" />
          <Rect x={15.6} y={3.4} width={1.2} height={8} />
          <Rect x={13.4} y={6.4} width={5.6} height={1.2} />
        </G>
        <Path d="M11.8 10.8l1.5 1.5-7.9 7.9a1.1 1.1 0 0 1-1.5-1.5z" />
        <Circle cx={18.3} cy={18.4} r={2.6} />
      </>
    ) : name === "artistic_swimming" ? (
      <>
        <Path d="M9.6 14 5.4 3.6c-.2-.6.1-1.2.7-1.4.5-.2 1.1.1 1.3.6l5 11.2z" />
        <Path d="M14.4 14l4.2-10.4c.2-.6-.1-1.2-.7-1.4-.5-.2-1.1.1-1.3.6l-5 11.2z" />
        <Path d="M2 15.6c1.6-.7 3.3-1.1 5-1.1 2 0 3.6 1 5 1s3-1 5-1c1.7 0 3.4.4 5 1.1v2.2c-1.6-.7-3.3-1.1-5-1.1-2 0-3.6 1-5 1s-3-1-5-1c-1.7 0-3.4.4-5 1.1z" />
        <Path d="M2 19.6c1.6-.7 3.3-1.1 5-1.1 2 0 3.6 1 5 1s3-1 5-1c1.7 0 3.4.4 5 1.1v2.2c-1.6-.7-3.3-1.1-5-1.1-2 0-3.6 1-5 1s-3-1-5-1c-1.7 0-3.4.4-5 1.1z" />
      </>
    ) : (
      <>
        <Path d="M13.4 1.9c1.2-1.2 3.2-1.2 4.4 0l4.3 4.3c1.2 1.2 1.2 3.2 0 4.4l-5.6 5.6c-1.2 1.2-3.2 1.2-4.4 0l-.8-.8-4.9 4.9-.3.3a1.6 1.6 0 0 1-2.3-2.3l.3-.3 4.9-4.9-.8-.8c-1.2-1.2-1.2-3.2 0-4.4z" />
        <Path fillRule="evenodd" d="M5.5 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM4.4 3.6a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm2.4.6a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM5 6.1a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
      </>
    );
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" testID={`sport-glyph-${name}`}>
      <G fill={color}>{body}</G>
    </Svg>
  );
}

export function SportIcon({ icon, size = 20, color = Bold.ink2 }: { icon: SportIconSpec; size?: number; color?: string }) {
  return "mdi" in icon
    ? <MaterialCommunityIcons name={icon.mdi as MdiName} size={size} color={color} />
    : <CustomGlyph name={icon.custom} size={size} color={color} />;
}

/** The tile's corner (the approved design's 9: a small tile reads boxy at the card radius of 16). */
export const SPORT_TILE_RADIUS = 9;

export function SportTile({ label, icon, mark, onPress, mainLabel, height = 56, style, testID }: {
  label: string;
  /** The sport's icon (shared/sports.ts); a typed sport outside the list has none. */
  icon?: SportIconSpec;
  mark: "main" | "check" | null;
  onPress: () => void;
  /** The badge's word ("Main"). */
  mainLabel: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const ink = mark === "main" ? Bold.onAct : mark === "check" ? Bold.act : Bold.ink2;
  const a11y = mark === "main" ? `${label}, ${mainLabel.toLowerCase()} sport, selected` : mark === "check" ? `${label}, selected` : label;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: mark !== null, checked: mark !== null }}
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.tile, { height }, mark === "main" ? styles.main : mark === "check" ? styles.on : null, pressed && styles.pressed, style]}
      testID={testID}
    >
      {icon ? <SportIcon icon={icon} size={20} color={ink} /> : null}
      <Text style={[styles.label, { color: mark === "main" ? Bold.onAct : mark === "check" ? Bold.act : Bold.ink }]} numberOfLines={2}>{label}</Text>
      {mark === "main" ? (
        <View style={styles.badge} testID="sport-main-badge"><Text style={styles.badgeText}>{mainLabel}</Text></View>
      ) : mark === "check" ? (
        <View style={styles.check} testID={`sport-check-${label}`}><MaterialCommunityIcons name="check-bold" size={13} color={Bold.act} /></View>
      ) : null}
    </Pressable>
  );
}

/** A pick with no tile: raspberry when it is the main one ("Main · …"), the tint otherwise; ✕ removes it. */
export function PickedPill({ label, main, mainLabel, onRemove, removeLabel, testID }: {
  label: string; main: boolean; mainLabel: string; onRemove: () => void; removeLabel: string; testID?: string;
}) {
  return (
    <Pressable
      onPress={onRemove}
      accessibilityRole="button"
      accessibilityLabel={main ? `${label}, ${mainLabel.toLowerCase()} sport, selected. ${removeLabel}` : `${label}, selected. ${removeLabel}`}
      style={[styles.pill, main ? styles.main : styles.on]}
      testID={testID}
    >
      <Text style={[styles.pillText, { color: main ? Bold.onAct : Bold.act }]} numberOfLines={1}>{main ? `${mainLabel} · ${label}` : label}</Text>
      <Feather name="x" size={14} color={main ? Bold.onAct : Bold.act} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile:      { borderRadius: SPORT_TILE_RADIUS, borderWidth: 1, borderColor: Bold.line, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: 3, paddingTop: 2 },
  main:      { backgroundColor: Bold.act, borderColor: Bold.act },
  on:        { backgroundColor: Bold.actSoft, borderColor: Bold.act },
  pressed:   { transform: [{ scale: Bold.pressScale }] },
  // The design's 8.5–9px label is below the type scale: the scale's smallest, the tab label (10/700), wraps to two lines.
  label:     { ...BoldType.tab, letterSpacing: 0, textAlign: "center" },
  badge:     { position: "absolute", top: 3, right: 3, paddingHorizontal: 3, borderRadius: 3, backgroundColor: Bold.onAct },
  // The design's 6.5–7.5px badge is below the scale too: the chip role (10/900 caps), tracked tighter to fit the corner.
  badgeText: { ...BoldType.chip, letterSpacing: 0.2, color: Bold.act },
  check:     { position: "absolute", top: 3, right: 3 },
  pill:      { flexDirection: "row", alignItems: "center", gap: 6, height: 30, paddingLeft: 12, paddingRight: 10, borderRadius: Bold.radius.pill, borderWidth: 1 },
  pillText:  { ...BoldType.chipLine, maxWidth: 220 },
});
