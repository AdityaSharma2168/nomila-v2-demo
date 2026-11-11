/**
 * agent/parts — the small pieces every agent card shares, on the Mila surfaces' Muse look (DESIGN.md §16): soft rounded
 * buttons with no ink outline, the fact-type mark (a word and a shape, never colour alone), the source chip (tappable when
 * it has a link), and the card's eyebrow. Type comes from BoldType roles only.
 */
import React from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType } from "../../constants/theme";
import { FACT_MARK, hostOf } from "../../lib/agent/cardLogic";
import type { CardSource, FactType } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

/** Every agent card's corner (the Mila card corner, milaSurface). */
export const AGENT_RADIUS = 18;

/**
 * The presentation cards (thesis, where you stand, positioning, timeline, partners, the play, what I couldn't confirm,
 * the reveal and early reads) wear Home's own visual language (owner, 9 Oct 2026; DESIGN.md look B): a white card with
 * a 1px line and corner 6, no shadow; the one black block at corner 6 inside the gutter. The interactive answers (facts,
 * goals, consent, capabilities, connect, action) keep the Mila card surface.
 */
export const HOME_CARD = { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card } as const;
export const HOME_BLOCK = { backgroundColor: Bold.ink, borderRadius: Bold.radius.card } as const;
/** Soft controls inside a card. */
const BTN_H = 44;

export type MilaButtonTone = "primary" | "soft" | "quiet" | "onDark";

/**
 * A rounded pill button: primary = the ONE raspberry action (Bold.act, white label); soft = the grey ground fill; quiet =
 * text only; onDark = white on a black card. Labels are uppercase by transform (BoldType.button), like every button.
 */
export function MilaButton({
  label, onPress, tone = "primary", loading, disabled, icon, testID, accessibilityLabel, style, flex,
}: {
  label: string;
  onPress: () => void;
  tone?: MilaButtonTone;
  loading?: boolean;
  disabled?: boolean;
  icon?: string;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  flex?: boolean;
}) {
  const fg = tone === "primary" ? Bold.onAct : Bold.ink;
  const off = disabled || loading;
  return (
    <Pressable
      onPress={() => { if (off) return; haptics.press(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      disabled={off}
      hitSlop={tone === "quiet" ? 8 : 0}
      testID={testID}
      style={({ pressed }) => [
        styles.btn,
        tone === "primary" && styles.btnPrimary,
        tone === "soft" && styles.btnSoft,
        tone === "quiet" && styles.btnQuiet,
        tone === "onDark" && styles.btnOnDark,
        flex && styles.flex,
        off && !loading && styles.btnOff,
        pressed && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <>
          {icon ? <Feather name={icon as any} size={15} color={fg} /> : null}
          <Text style={[styles.btnText, { color: fg }]} numberOfLines={1}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

/** The fact-type mark: Measured (solid square) · Found (outlined square) · You said (blue rule) · Mila's read (dashed). */
export function FactMark({ type, onDark, testID }: { type: FactType; onDark?: boolean; testID?: string }) {
  const m = FACT_MARK[type];
  const ink = onDark ? Bold.onDark : Bold.ink;
  return (
    <View style={styles.mark} accessibilityLabel={m.word} testID={testID ?? `fact-mark-${type}`}>
      <View
        style={[
          styles.markShape,
          m.shape === "solid" && { backgroundColor: ink },
          m.shape === "outline" && { borderWidth: 1.5, borderColor: ink },
          m.shape === "rule" && styles.markRule,
          m.shape === "dashed" && { borderWidth: 1.5, borderColor: ink, borderStyle: "dashed" },
        ]}
      />
      <Text style={[styles.markText, { color: onDark ? Bold.onDarkLabel : Bold.mute }]}>{m.word}</Text>
    </View>
  );
}

export function openUrl(url: string) {
  Promise.resolve(Linking.openURL(url)).catch(() => {});
}

/** Where a fact came from. With a url it is a link (opens the source); without, a plain label. */
export function SourceChip({ source, onDark, onGround, square, testID }: { source: CardSource; onDark?: boolean; onGround?: boolean; square?: boolean; testID?: string }) {
  const label = source.label || (source.url ? hostOf(source.url) : "Source");
  const body = (
    <>
      <Text style={[styles.sourceText, onDark && { color: Bold.onDarkSoft }]} numberOfLines={1}>{label}</Text>
      {source.url ? <Feather name="arrow-up-right" size={12} color={onDark ? Bold.onDarkSoft : Bold.ink2} /> : null}
    </>
  );
  if (!source.url) {
    return <View style={[styles.source, onDark && styles.sourceOnDark, onGround && styles.sourceOnGround, square && styles.sourceSquare]} testID={testID}>{body}</View>;
  }
  const url = source.url;
  return (
    <Pressable
      onPress={() => { haptics.tap(); openUrl(url); }}
      accessibilityRole="link"
      accessibilityLabel={`Source: ${label}`}
      hitSlop={10}
      testID={testID}
      style={({ pressed }) => [styles.source, onDark && styles.sourceOnDark, onGround && styles.sourceOnGround, square && styles.sourceSquare, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

export function Eyebrow({ children, onDark, right }: { children: string; onDark?: boolean; right?: React.ReactNode }) {
  return (
    <View style={styles.eyebrowRow}>
      <Text style={[styles.eyebrow, onDark && { color: Bold.onDarkLabel }]} numberOfLines={1}>{children}</Text>
      {right}
    </View>
  );
}

/** A small rounded word chip on a Mila card (status words, horizons, "Experimental"). `blue` (historic name) = needs you:
 * the raspberry tint with deep raspberry ink, as on Bookings. */
export function SoftChip({ children, tone = "ground", testID }: { children: string; tone?: "ground" | "ink" | "blue" | "dashed" | "dashedOnDark"; testID?: string }) {
  return (
    <View
      style={[
        styles.chip,
        tone === "ink" && { backgroundColor: Bold.ink },
        tone === "blue" && { backgroundColor: Bold.actSoft },
        tone === "dashed" && styles.chipDashed,
        tone === "dashedOnDark" && styles.chipDashedOnDark,
      ]}
      testID={testID}
    >
      <Text style={[styles.chipText, (tone === "ink" || tone === "dashedOnDark") && { color: Bold.onDark }, tone === "blue" && { color: Accent.pinkDeep }]}>{children}</Text>
    </View>
  );
}

/** A settled line under a card that has been answered ("Sent.", "Added to your goals"). */
export function SettledLine({ text, icon = "check", testID }: { text: string; icon?: string; testID?: string }) {
  return (
    <View style={styles.settled} testID={testID} accessibilityLiveRegion="polite">
      <View style={styles.settledDot}><Feather name={icon as any} size={12} color={Bold.onDark} /></View>
      <Text style={styles.settledText}>{text}</Text>
    </View>
  );
}

/** A partner's rule, explained in one plain line (never a block: the athlete's tap works as always). */
export function PartnerNote({ text }: { text: string }) {
  return (
    <View style={styles.note} testID="partner-note">
      <Feather name="info" size={14} color={Bold.ink2} style={styles.noteIcon} />
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );
}

export const partStyles = StyleSheet.create({
  title:   { ...BoldType.headedTitle, color: Bold.ink },
  h4:      { ...BoldType.h4, color: Bold.ink },
  body:    { ...BoldType.read, color: Bold.ink2 },
  lede:    { ...BoldType.lede, color: Bold.mute },
  caption: { ...BoldType.caption, color: Bold.mute },
  row:     { flexDirection: "row", alignItems: "center", gap: 8 },
  wrap:    { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  actions: { flexDirection: "row", gap: 8, alignItems: "center" },
  error:   { ...BoldType.caption, color: Bold.ink },
  input: {
    ...BoldType.read,
    color: Bold.ink,
    backgroundColor: Bold.ground,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: BTN_H,
  },
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { transform: [{ scale: Bold.pressScale }], opacity: 0.92 },
  btn: { height: BTN_H, borderRadius: BTN_H / 2, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  btnPrimary: { backgroundColor: Bold.act },
  btnSoft: { backgroundColor: Bold.ground },
  btnQuiet: { backgroundColor: "transparent", paddingHorizontal: 8 },
  btnOnDark: { backgroundColor: Bold.paper },
  btnOff: { opacity: 0.4 },
  btnText: { ...BoldType.button },

  mark: { flexDirection: "row", alignItems: "center", gap: 6 },
  markShape: { width: 9, height: 9, borderRadius: 1 },
  markRule: { width: 3, height: 12, borderRadius: 0, backgroundColor: Bold.blue },
  markText: { ...BoldType.caption },

  source: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: Bold.ground, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4, maxWidth: 220 },
  sourceOnDark: { backgroundColor: "rgba(255,255,255,0.12)" },
  sourceOnGround: { backgroundColor: Bold.paper, alignSelf: "flex-start" },
  sourceSquare: { borderRadius: Bold.radius.control },
  sourceText: { ...BoldType.caption, color: Bold.ink2, flexShrink: 1 },

  eyebrowRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  eyebrow: { ...BoldType.label, color: Bold.mute, flexShrink: 1 },

  chip: { borderRadius: 8, backgroundColor: Bold.ground, paddingHorizontal: 8, paddingVertical: 4, alignSelf: "flex-start" },
  chipDashed: { backgroundColor: "transparent", borderWidth: 1, borderStyle: "dashed", borderColor: Bold.mute },
  chipDashedOnDark: { backgroundColor: "transparent", borderWidth: 1, borderStyle: "dashed", borderColor: Bold.onDarkMute },
  chipText: { ...BoldType.chipLine, color: Bold.ink },

  note: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  noteIcon: { marginTop: 2 },
  noteText: { ...BoldType.caption, color: Bold.ink2, flex: 1 },

  settled: { flexDirection: "row", alignItems: "center", gap: 8 },
  settledDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  settledText: { ...BoldType.rowTitle, color: Bold.ink, flexShrink: 1 },
});
