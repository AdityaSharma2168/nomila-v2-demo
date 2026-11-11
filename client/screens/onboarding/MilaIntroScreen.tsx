/**
 * MilaIntroScreen — Mila's intro (the agent onboarding front; Option B of the "Mila intro — redesign" canvas, approved
 * 12 Oct 2026). A dark status bar over the white ground. The head is the onboarding variant of DESIGN.md §16: her avatar
 * floats small (48, idle) at the top LEFT beside a two-line frosted label, "Mila / Your agent" (her name shown once),
 * and ONE frosted round "i" at the right opens the "How it works" sheet. Then the lede and the QUESTION, "What are you
 * most interested in?", over white Mila cards: Your brand full width on top, then a 2-column grid whose half tiles
 * all share one height (the tallest tile's), so no line is clipped. Multi-select: a chosen tile takes the raspberry tint and
 * line with a raspberry check (the sport grid's "on"). A "Soon" tile sits on the grey ground with a dashed "Soon" chip where the check
 * goes, shown last (display order only), and stays pickable; picking it adds a plain line above the button. The
 * button, "Let's start · N picked", is sticky over a white fade, and the list's foot clears it on any screen.
 * "Let's start" hands the picks back; the flow saves them as "said" facts through the turn's `capability` action.
 */
import React, { useCallback, useState } from "react";
import { Pressable, ScrollView, StatusBar, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { MilaAvatar } from "../../components/mila/MilaAvatar";
import { Frost } from "../../components/mila/Frost";
import { MILA_CARD, MILA_CARD_RADIUS } from "../../components/mila/milaSurface";
import { MilaButton, SoftChip } from "../../components/agent/parts";
import { N } from "../../components/deals/opps/tokens";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { toggleKey } from "../../lib/onboardingFront";
import { FRONT_COPY } from "./frontCopy";

/** Her avatar with the one-line frosted "Mila" label under it, top-centre (DESIGN.md §16). "What Mila already has" uses it. */
export function MilaHead({ size = 96 }: { size?: number }) {
  return (
    <View style={styles.milaHead}>
      <MilaAvatar state="idle" size={size} />
      <Frost radius={14} style={styles.milaLabel}><Text style={styles.milaLabelText}>Mila</Text></Frost>
    </View>
  );
}

const AVATAR = 48;
const INFO_BTN = 40;
/** The screen's side padding. */
const SIDE = 20;
const TILE_PAD = 14;
/** The gap between the grid's two columns and its rows. */
const GAP = 8;
/** A half tile's height before its text is measured (the design's floor). */
const TILE_MIN = 124;

export function MilaIntroScreen({ onStart, busy, error, initial = [], sheetOpen = false }: {
  onStart: (picked: string[]) => void;
  busy?: boolean;
  error?: boolean;
  initial?: string[];
  sheetOpen?: boolean;
}) {
  const c = FRONT_COPY.intro;
  const insets = useSafeAreaInsets();
  const [picked, setPicked] = useState<string[]>(initial);
  const [sheet, setSheet] = useState(sheetOpen);
  // Every half tile takes the tallest one's height: each reports its content's natural height (not the stretched tile).
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [footH, setFootH] = useState(0);
  const tileH = Math.max(TILE_MIN, ...Object.values(heights));
  // A fixed two-column grid: each half tile is half the row less the gap (known before the first draw).
  const halfW = Math.floor((useWindowDimensions().width - SIDE * 2 - GAP) / 2);
  // The grid stays invisible for the one frame until every half tile has reported its height, so it never jumps.
  const halfCount = c.interests.filter((x) => x.key !== "brand").length;
  const measured = Object.keys(heights).length >= halfCount;
  const measure = useCallback((key: string) => (e: LayoutChangeEvent) => {
    const h = Math.ceil(e.nativeEvent.layout.height) + TILE_PAD * 2;
    setHeights((m) => (m[key] === h ? m : { ...m, [key]: h }));
  }, []);

  const soonPicked = c.interests.filter((x) => x.soon && picked.includes(x.key)).map((x) => x.label);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingTop: insets.top + 12, paddingBottom: footH + 8 }]}
        testID="mila-intro"
      >
        <View style={styles.head}>
          <MilaAvatar state="idle" size={AVATAR} />
          <Frost radius={16} style={styles.nameLabel}>
            <Text style={styles.name}>{c.name}</Text>
            <Text style={styles.role}>{c.role}</Text>
          </Frost>
          <View style={styles.headSpace} />
          <Pressable
            onPress={() => { haptics.press(); setSheet(true); }}
            accessibilityRole="button"
            accessibilityLabel={c.more}
            testID="intro-more"
            style={({ pressed }) => [styles.infoBtn, pressed && styles.pressed]}
          >
            <Frost radius={INFO_BTN / 2} style={styles.infoGlass}>
              <Feather name="info" size={18} color={Bold.ink2} />
            </Frost>
          </Pressable>
        </View>
        <Text style={styles.lede}>{c.lede}</Text>
        <Text style={styles.ask} accessibilityRole="header">{c.ask}</Text>
        <Text style={styles.askSub}>{c.askSub}</Text>

        <View style={[styles.grid, !measured && styles.unmeasured]}>
          {c.interests.map((x) => {
            const on = picked.includes(x.key);
            const wide = x.key === "brand";
            const fg = Bold.ink;
            const check = (
              <View style={[styles.check, { backgroundColor: on ? Bold.act : x.soon ? Bold.paper : Bold.ground }]} testID={on ? `interest-check-${x.key}` : undefined}>
                {on ? <Feather name="check" size={13} color={Bold.onAct} /> : null}
              </View>
            );
            const glyph = <Feather name={x.icon} size={18} color={on ? Bold.act : Bold.ink2} />;
            const words = (
              <>
                <Text style={[styles.tileLabel, { color: fg }]}>{x.label}</Text>
                <Text style={[styles.tileLine, { color: Bold.mute }]}>{x.line}</Text>
              </>
            );
            return (
              <Pressable
                key={x.key}
                onPress={() => { haptics.select(); setPicked((p) => toggleKey(p, x.key)); }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${x.label}. ${x.line}${x.soon ? `. ${c.soon}` : ""}`}
                testID={`interest-${x.key}`}
                style={({ pressed }) => [
                  styles.tile,
                  wide ? styles.tileWide : { width: halfW, minHeight: tileH },
                  on ? styles.tileOn : x.soon ? styles.tileSoon : MILA_CARD,
                  pressed && styles.pressed,
                ]}
              >
                {wide ? (
                  <View style={styles.wideRow}>
                    {glyph}
                    <View style={styles.wideWords}>{words}</View>
                    {check}
                  </View>
                ) : (
                  <View style={styles.halfBody} onLayout={measure(x.key)}>
                    <View style={styles.tileHead}>
                      {glyph}
                      <View style={styles.tileMarks}>
                        {x.soon ? <SoftChip tone="dashed" testID={`interest-soon-${x.key}`}>{c.soon}</SoftChip> : null}
                        {check}
                      </View>
                    </View>
                    {words}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <View
        style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 16) }]}
        onLayout={(e) => setFootH(Math.ceil(e.nativeEvent.layout.height))}
        pointerEvents="box-none"
        testID="intro-foot"
      >
        <LinearGradient colors={[N.cream100Clear, N.cream100]} locations={[0, 0.25]} style={StyleSheet.absoluteFill} pointerEvents="none" />
        {soonPicked.length ? (
          <View style={styles.soonLine} accessibilityLiveRegion="polite" testID="intro-soon-line">
            <Feather name="bell" size={12} color={Bold.ink2} />
            <Text style={styles.soonText}>{c.soonLine(soonPicked)}</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{c.error}</Text> : null}
        <MilaButton label={picked.length ? c.goPicked(picked.length) : c.go} onPress={() => onStart(picked)} loading={busy} testID="intro-start" />
      </View>

      {sheet ? (
        <View style={StyleSheet.absoluteFill} testID="intro-sheet">
          <Pressable style={[StyleSheet.absoluteFill, styles.dim]} onPress={() => setSheet(false)} accessibilityRole="button" accessibilityLabel={c.close} testID="intro-sheet-close" />
          <View style={styles.sheetWrap} pointerEvents="box-none">
            <View style={[MILA_CARD, styles.sheet, { marginBottom: insets.bottom + 24 }]} accessibilityViewIsModal>
              <View style={styles.grabber} />
              <Text style={styles.sheetTitle} accessibilityRole="header">{c.howTitle}</Text>
              <Text style={styles.sheetLead}>{c.howLead}</Text>
              {c.how.map((h) => (
                <View key={h.line} style={styles.sheetRow}>
                  <Feather name={h.icon} size={16} color={h.strong ? Bold.ink : Bold.quiet} />
                  <Text style={h.strong ? styles.sheetStrong : styles.sheetText}>{h.line}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root:          { flex: 1, backgroundColor: N.cream100 },
  body:          { paddingHorizontal: SIDE },
  unmeasured:    { opacity: 0 },
  pressed:       { transform: [{ scale: Bold.pressScale }] },
  milaHead:      { alignItems: "center", gap: 8 },
  milaLabel:     { paddingHorizontal: 14, paddingVertical: 5, marginTop: -6 },
  milaLabelText: { ...BoldType.rowTitle, color: Bold.ink },
  head:          { flexDirection: "row", alignItems: "center", gap: 10 },
  nameLabel:     { paddingHorizontal: 12, paddingVertical: 6 },
  name:          { ...BoldType.rowTitle, color: Bold.ink },
  role:          { ...BoldType.caption, color: Bold.mute },
  headSpace:     { flex: 1 },
  infoBtn:       { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  infoGlass:     { width: INFO_BTN, height: INFO_BTN, alignItems: "center", justifyContent: "center" },
  lede:          { ...BoldType.body, color: Bold.ink2, maxWidth: 320, marginTop: 14 },
  ask:           { ...BoldType.headedTitle, color: Bold.ink, marginTop: 12 },
  askSub:        { ...BoldType.rowMeta, color: Bold.mute, marginTop: 2, marginBottom: 12 },
  grid:          { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: GAP },
  tile:          { borderRadius: MILA_CARD_RADIUS, padding: TILE_PAD },
  tileWide:      { width: "100%", minHeight: 64, justifyContent: "center" },

  // Picked: the sport grid's raspberry tint and line (SportTile), never solid black.
  tileOn:        { backgroundColor: Bold.actSoft, borderWidth: 1.5, borderColor: Bold.act },
  tileSoon:      { backgroundColor: Bold.ground },
  wideRow:       { flexDirection: "row", alignItems: "center", gap: 12 },
  wideWords:     { flex: 1, gap: 2 },
  halfBody:      { gap: 6 },
  tileHead:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 22 },
  tileMarks:     { flexDirection: "row", alignItems: "center", gap: 6 },
  check:         { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  tileLabel:     { ...BoldType.rowTitle },
  tileLine:      { ...BoldType.caption },
  foot:          { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 24, paddingHorizontal: Bold.gutter, gap: 10 },
  soonLine:      { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  soonText:      { ...BoldType.caption, color: Bold.ink2, textAlign: "center", flexShrink: 1 },
  error:         { ...BoldType.caption, color: Bold.ink, textAlign: "center" },
  dim:           { backgroundColor: Bold.scrimMid },
  sheetWrap:     { flex: 1, justifyContent: "flex-end" },
  sheet:         { marginHorizontal: 10, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 18, gap: 10 },
  grabber:       { width: 38, height: 4, borderRadius: 2, backgroundColor: Bold.line, alignSelf: "center", marginBottom: 6 },
  sheetTitle:    { ...BoldType.h4, color: Bold.ink },
  sheetLead:     { ...BoldType.body, color: Bold.ink, marginBottom: 4 },
  sheetRow:      { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  sheetText:     { flex: 1, ...BoldType.rowMeta, color: Bold.ink2 },
  sheetStrong:   { flex: 1, ...BoldType.rowTitle, color: Bold.ink },
});
