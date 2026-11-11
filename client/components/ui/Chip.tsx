// Chip · Pill · Button — a chip states, a pill acts.
//
// LEGACY look (screens not yet on look B):
//   <Chip tint="said">You said</Chip>            28 high · corner xs · 12 · 600 · sentence case · a Tint pair · never tappable
//   <Chip tone={{ bg, fg }}>Impact</Chip>         the same chip in a given bg/fg pair
//   <Pill selected onPress>Campaign</Pill>        32 high · 12 · 500 · 1px border; selected = ink fill
//   <Button onPress>Draft a reply</Button>        44 high · 14 · 600 · raspberry fill (pill)
//   <Button ghost>Back</Button>                   1px border
//   <Button primary>Share</Button>                the ONE pink action on a screen
//   <Button onHero>Share</Button>                 on the dark hero ground
//   <IconButton onPress><Feather …/></IconButton> 44 circle · ghost
//
// LOOK B (DESIGN.md, Oct 2026 — the Concept 0.4 surfaces and the shell pass `bold`; no pills, no tints, no pink):
//   <Chip bold="light">Impact</Chip>              24 high · corner 3 · 10/900 uppercase · white on a photo
//   <Chip bold="dark">Partner</Chip>              black on white
//   <Chip bold="blue">Waiting for you</Chip>      blue ONLY for "needs you" / Active
//   <Chip bold="line">Deferred</Chip>             outlined, 12/700 sentence case, corner 4 — status words, Mila's chips
//   <Button bold="primary">Accept</Button>        48 high · pill · raspberry fill (Bold.act) · 13/800 uppercase
//   <Button bold="secondary">Share</Button>       48 high · pill · black fill
//   <Button bold="small">Add</Button>             34 high · 1.5px line · 11/800
//   <Button bold="smallAct">Review</Button>       34 high · raspberry fill · 11/800 — a card's ONE main action at small size
//   <Button bold="onHero">Retry</Button>          white fill on a photo
//   <Button bold="link">See all 3</Button>        the blue text link (ui/Bold LinkText draws the same with its arrow)

import React from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, type StyleProp, type ViewStyle } from "react-native";
import { BorderRadius, Colors, Tint, Type, Bold, BoldType, type TintName } from "../../constants/theme";
import { haptics } from "../../lib/haptics";

const C = Colors.light;

export type ChipBold = "light" | "dark" | "blue" | "line";
export type ButtonBold = "primary" | "secondary" | "small" | "smallAct" | "onHero" | "link";

/** One chip spec app-wide: sentence case, Outfit SemiBold 12, a pill. The copy is never typed in capitals. */
export function Chip({ tint = "none", tone, bold, children, icon, style, testID }: { tint?: TintName; tone?: { bg: string; fg: string } | null; bold?: ChipBold; children: string; icon?: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  if (bold) {
    return (
      <View style={[styles.chipBold, BOLD_CHIP[bold], style]} accessibilityRole="text" testID={testID ?? `chip-${bold}`}>
        {icon ? <View style={styles.chipIcon}>{icon}</View> : null}
        <Text style={[bold === "line" ? styles.chipTextLine : styles.chipTextBold, { color: BOLD_CHIP_INK[bold] }]}>{children}</Text>
      </View>
    );
  }
  const t = tone ?? Tint[tint];
  return (
    <View style={[styles.chip, { backgroundColor: t.bg }, style]} accessibilityRole="text" testID={testID}>
      {icon ? <View style={styles.chipIcon}>{icon}</View> : null}
      <Text style={[styles.chipText, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

export function Pill({ selected, onPress, children, style, disabled }: { selected?: boolean; onPress: () => void; children: string; style?: StyleProp<ViewStyle>; disabled?: boolean }) {
  return (
    <Pressable
      style={[styles.pill, selected && styles.pillOn, disabled && styles.disabled, style]}
      onPress={() => { haptics.select(); onPress(); }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
    >
      <Text style={[styles.pillText, selected && styles.pillTextOn]}>{children}</Text>
    </Pressable>
  );
}

export function Button({ children, onPress, ghost, primary, onHero, bold, icon, loading, disabled, style, small, testID, accessibilityLabel }: {
  children:  string;
  onPress:   () => void;
  ghost?:    boolean;
  primary?:  boolean;
  onHero?:   boolean;
  /** Look B. */
  bold?:     ButtonBold;
  icon?:     React.ReactNode;
  loading?:  boolean;
  disabled?: boolean;
  small?:    boolean;
  style?:    StyleProp<ViewStyle>;
  testID?:   string;
  accessibilityLabel?: string;
}) {
  const off = disabled || loading;
  if (bold) {
    const ink = bold === "primary" || bold === "smallAct" ? Bold.onAct : bold === "secondary" ? Bold.onDark : bold === "link" ? Bold.blue : Bold.ink;
    return (
      <Pressable
        style={({ pressed }) => [styles.btnBold, BOLD_BTN[bold], off && styles.disabled, pressed && !off && styles.pressedBold, style]}
        onPress={() => { haptics.press(); onPress(); }}
        disabled={off}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: !!off }}
        testID={testID}
      >
        {loading ? <ActivityIndicator size="small" color={ink} /> : (
          <>
            {icon ? <View style={styles.btnIcon}>{icon}</View> : null}
            <Text style={[bold === "small" || bold === "smallAct" ? styles.btnTextSmallBold : bold === "link" ? styles.btnTextLink : styles.btnTextBold, { color: ink }]}>{children}</Text>
          </>
        )}
      </Pressable>
    );
  }
  const fill = primary ? styles.btnPrimary : onHero ? styles.btnOnHero : ghost ? styles.btnGhost : styles.btnInk;
  const text = onHero ? styles.btnTextOnHero : ghost ? styles.btnTextGhost : styles.btnTextLight;
  return (
    <Pressable
      style={({ pressed }) => [styles.btn, small && styles.btnSmall, fill, off && styles.disabled, pressed && !off && styles.pressed, style]}
      onPress={() => { haptics.press(); onPress(); }}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!off }}
      testID={testID}
    >
      {loading ? <ActivityIndicator size="small" color={ghost ? C.text : "#FFFFFF"} /> : (
        <>
          {icon ? <View style={styles.btnIcon}>{icon}</View> : null}
          <Text style={[styles.btnText, small && styles.btnTextSmall, text]}>{children}</Text>
        </>
      )}
    </Pressable>
  );
}

export function IconButton({ children, onPress, onHero, accessibilityLabel, style }: { children: React.ReactNode; onPress: () => void; onHero?: boolean; accessibilityLabel: string; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.iconBtn, onHero && styles.iconBtnOnHero, pressed && styles.pressed, style]}
      onPress={() => { haptics.press(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Pressable>
  );
}

const BOLD_CHIP: Record<ChipBold, ViewStyle> = {
  light: { backgroundColor: Bold.paper },
  dark:  { backgroundColor: Bold.ink },
  blue:  { backgroundColor: Bold.blue },
  line:  { backgroundColor: Bold.paper, borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.control, paddingHorizontal: 10, paddingVertical: 6 },
};
const BOLD_CHIP_INK: Record<ChipBold, string> = { light: Bold.ink, dark: Bold.onDark, blue: Bold.onDark, line: Bold.ink };
const BOLD_BTN: Record<ButtonBold, ViewStyle> = {
  primary:   { backgroundColor: Bold.act },
  secondary: { backgroundColor: Bold.ink },
  small:     { height: Bold.buttonSmall, paddingHorizontal: 12, backgroundColor: Bold.paper, borderWidth: 1.5, borderColor: Bold.ink },
  smallAct:  { height: Bold.buttonSmall, paddingHorizontal: 12, backgroundColor: Bold.act, borderWidth: 1.5, borderColor: Bold.act },
  onHero:    { backgroundColor: Bold.paper, height: 40 },
  link:      { height: undefined, paddingHorizontal: 0, backgroundColor: "transparent", gap: 4 },
};

const styles = StyleSheet.create({
  // DESIGN.md Chip: 28 high, corner xs, 6 × 4 padding, 12 SemiBold.
  chip:           { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28, borderRadius: BorderRadius.xs, paddingHorizontal: 8, paddingVertical: 4, alignSelf: "flex-start" },
  chipIcon:       { marginRight: 1 },
  chipText:       { ...Type.chip },
  // Look B chip: 24 high, corner 3, 7 × 8 padding, 10/900 uppercase.
  chipBold:       { flexDirection: "row", alignItems: "center", gap: 5, minHeight: Bold.chip, borderRadius: Bold.radius.chip, paddingHorizontal: 8, paddingVertical: 6, alignSelf: "flex-start" },
  chipTextBold:   { ...BoldType.chip },
  chipTextLine:   { ...BoldType.chipLine },
  pill:           { height: 32, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: C.border, alignItems: "center", justifyContent: "center", backgroundColor: C.card },
  pillOn:         { backgroundColor: C.text, borderColor: C.text },
  pillText:       { ...Type.caption, color: C.textSecondary },
  pillTextOn:     { color: "#FFFFFF" },
  btn:            { height: 44, paddingHorizontal: 22, borderRadius: 999, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  btnSmall:       { height: 32, paddingHorizontal: 14 },
  // The legacy filled button is the screen's main action: the ONE raspberry (C.primary = Bold.act), not ink.
  btnInk:         { backgroundColor: C.primary },
  btnPrimary:     { backgroundColor: C.primary },
  btnOnHero:      { backgroundColor: C.onHero },
  btnGhost:       { borderWidth: 1, borderColor: C.border, backgroundColor: "transparent" },
  btnIcon:        {},
  btnText:        { ...Type.action },
  btnTextSmall:   { ...Type.caption },
  btnTextLight:   { color: "#FFFFFF" },
  btnTextOnHero:  { color: "#0D0B08" },
  btnTextGhost:   { color: C.textSecondary },
  // Look B button: 48 high, corner 4, rectangular, 13/800 uppercase.
  btnBold:        { height: Bold.button, paddingHorizontal: 20, borderRadius: Bold.radius.pill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  btnTextBold:    { ...BoldType.button },
  btnTextSmallBold:{ ...BoldType.buttonSmall },
  btnTextLink:    { ...BoldType.link },
  pressedBold:    { transform: [{ scale: Bold.pressScale }] },
  iconBtn:        { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: C.border, alignItems: "center", justifyContent: "center", backgroundColor: C.card },
  iconBtnOnHero:  { borderColor: "rgba(255,255,255,0.3)", backgroundColor: "transparent" },
  pressed:        { opacity: 0.85 },
  disabled:       { opacity: 0.4 },
});
