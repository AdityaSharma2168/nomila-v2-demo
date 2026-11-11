// Home v3's full-screen stories (EXPO_PUBLIC_HOME_V3; the "Alive" framework's Story: full screen, tap through, ONE
// action). One circle's items, one at a time on hero black: progress dots, the circle's name and "i of n" with ✕ at the
// top (over a top scrim, so it reads on a light photo too); the picture — a post's own first photo; an offer as a poster
// (her avatar × the brand's logo, the money large in gold or the ask, the brand's short name as faint texture); a moment
// with nothing prepared as a poster too (its date, what kind of moment, Mila's hook and angle) — at the foot the eyebrow, one headline, one line, the action (pink; gold
// for a win) and "Not now". Tap the right side for the next story, the left for the one before; past
// the last it closes. Each story she sees is marked seen (`onSeen`). An empty circle shows one story saying so.

import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Modal, SafeAreaView, StatusBar } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { Photo } from "../ui/Photo";
import { LogoMark } from "../ui/LogoMark";
import { useReducedMotion } from "../ui";
import { useKitPhoto } from "./useKitPhoto";
import { HOME_V3_COPY, type Circle, type StoryItem } from "../../lib/homeV3Logic";

export function StoryViewer({ circle, start, avatarUrl, onClose, onAction, onSeen }: {
  circle: Circle;
  start: number;
  /** Her own photo, for an offer poster's lockup (her × the brand). */
  avatarUrl?: string | null;
  onClose: () => void;
  onAction: (item: StoryItem) => void;
  onSeen: (id: string) => void;
}) {
  const reduced = useReducedMotion();
  const items = circle.items;
  const [index, setIndex] = useState(Math.min(Math.max(0, start), Math.max(0, items.length - 1)));
  const item = items[index] ?? null;
  useEffect(() => { if (item) onSeen(item.id); }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => { if (index < items.length - 1) { haptics.select(); setIndex(index + 1); } else onClose(); };
  const prev = () => { if (index > 0) { haptics.select(); setIndex(index - 1); } };

  return (
    <Modal visible animationType={reduced ? "none" : "fade"} presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" />
      <View style={styles.ground} testID={`home-v3-story-${circle.key}`}>
        {item ? <StoryPicture item={item} avatarUrl={avatarUrl ?? null} /> : null}
        <LinearGradient
          colors={[Bold.scrimTop, Bold.scrimClear, Bold.scrimClear, Bold.scrimDeep]}
          locations={[0, 0.22, 0.48, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* Tap zones: the left third goes back, the rest goes on. Under the top bar and the foot. */}
        <View style={styles.zones}>
          <Pressable style={styles.zonePrev} onPress={prev} accessibilityRole="button" accessibilityLabel="Previous story" testID="home-v3-story-prev" />
          <Pressable style={styles.zoneNext} onPress={next} accessibilityRole="button" accessibilityLabel="Next story" testID="home-v3-story-next" />
        </View>

        <SafeAreaView style={styles.safe} pointerEvents="box-none">
          <View style={styles.top} pointerEvents="box-none">
            <View style={styles.dots}>
              {(items.length ? items : [null]).map((_, i) => (
                <View key={i} style={[styles.dot, i <= index && styles.dotOn]} />
              ))}
            </View>
            <View style={styles.head}>
              <Text style={styles.headText} numberOfLines={1}>
                {items.length > 1 ? `${circle.label} · ${HOME_V3_COPY.ofN(index + 1, items.length)}` : circle.label}
              </Text>
              <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" testID="home-v3-story-close" style={styles.close}>
                <Feather name="x" size={20} color={Bold.onDark} />
              </Pressable>
            </View>
          </View>

          <View style={styles.foot} pointerEvents="box-none">
            {item ? <StoryFoot item={item} gold={circle.key === "wins"} onAction={() => onAction(item)} onClose={onClose} /> : <EmptyFoot circle={circle} onAction={onAction} onClose={onClose} />}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** A post's own first photo full-bleed; an offer as a poster; a moment's date; else the black alone. */
function StoryPicture({ item, avatarUrl }: { item: StoryItem; avatarUrl: string | null }) {
  const photo = useKitPhoto(item.kitActionId ?? null);
  if (photo) return <Photo uri={photo} style={StyleSheet.absoluteFill} transition={0} />;
  if (item.poster) return <OfferPosterView item={item} avatarUrl={avatarUrl} />;
  if (item.moment) return <MomentPosterView item={item} />;
  if (item.dateFace) {
    return (
      <View style={styles.dateWrap} pointerEvents="none" testID="home-v3-story-date">
        {item.dateFace.top ? <Text style={styles.dateTop}>{item.dateFace.top}</Text> : null}
        <Text style={styles.dateBig}>{item.dateFace.big}</Text>
      </View>
    );
  }
  if (item.brandName && (item.logoUrl || item.logoDomain)) {
    return (
      <View style={styles.logoWrap} pointerEvents="none">
        <LogoMark bold logoUrl={item.logoUrl ?? null} domain={item.logoDomain ?? null} name={item.brandName} size={96} />
      </View>
    );
  }
  return null;
}

/**
 * An offer with no picture of its own, as a poster built from its data alone (any brand, any athlete): a soft pink glow,
 * her avatar × the brand's logo, the money large in gold (or, with no fee stated, the ask large in white), and the
 * brand's short name as faint oversized texture running off the edge.
 */
function OfferPosterView({ item, avatarUrl }: { item: StoryItem; avatarUrl: string | null }) {
  const p = item.poster!;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="home-v3-offer-poster">
      {item.coverUrl ? (
        <>
          {/* The brand's own cover under the dark scrim, so the lockup and the money read on any photo. */}
          <Photo uri={item.coverUrl} style={StyleSheet.absoluteFill} transition={0} />
          <LinearGradient colors={[Bold.cardScrim, "rgba(0,0,0,0.35)", Bold.cardScrim]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
        </>
      ) : null}
      <LinearGradient colors={[Accent.pinkGlow, Bold.scrimClear]} start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 0.6 }} style={StyleSheet.absoluteFill} />
      <BrandTexture name={p.name} />
      <View style={styles.poster}>
        <View style={styles.lockup}>
          {avatarUrl
            ? <Photo uri={avatarUrl} style={styles.lockAvatar} transition={0} />
            : <View style={[styles.lockAvatar, styles.lockBlank]} />}
          <Text style={styles.lockX}>×</Text>
          {item.logoUrl || item.logoDomain
            ? <LogoMark bold logoUrl={item.logoUrl ?? null} domain={item.logoDomain ?? null} name={p.name} size={48} style={styles.lockRound} />
            : <View style={styles.lockLogo}><Text style={styles.lockInitial}>{p.name.charAt(0).toUpperCase()}</Text></View>}
          {item.via ? <Text style={styles.via} numberOfLines={1}>{`via ${item.via}`}</Text> : null}
        </View>
        {p.amount
          ? <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>{p.amount}</Text>
          : p.ask ? <Text style={styles.askBig} numberOfLines={2}>{p.ask.charAt(0).toUpperCase() + p.ask.slice(1)}</Text> : null}
      </View>
    </View>
  );
}

/** The brand's short name, oversized and faint, running off the right edge: clipped there, never ellipsized. */
function BrandTexture({ name }: { name: string }) {
  return (
    <View style={styles.textureClip} pointerEvents="none">
      <Text style={styles.texture} numberOfLines={1} ellipsizeMode="clip">{name}</Text>
    </View>
  );
}

/**
 * A moment with no picture of its own, as a poster from its data (any kind, any athlete): a soft pink glow, its date as
 * a calendar page with what kind of moment it is, and Mila's hook large, her angle under it.
 */
function MomentPosterView({ item }: { item: StoryItem }) {
  const m = item.moment!;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="home-v3-moment-poster">
      <LinearGradient colors={[Accent.pinkGlow, Bold.scrimClear]} start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 0.6 }} style={StyleSheet.absoluteFill} />
      <View style={styles.poster}>
        <View style={styles.momentHead}>
          {item.dateFace ? (
            <View style={styles.momentDate}>
              {item.dateFace.top ? <Text style={styles.momentDateTop}>{item.dateFace.top}</Text> : null}
              <Text style={styles.momentDateBig}>{item.dateFace.big}</Text>
            </View>
          ) : null}
          <View style={styles.kindChip}><Text style={styles.kindText}>{m.kind}</Text></View>
        </View>
        <Text style={styles.askBig} numberOfLines={4}>{m.hook}</Text>
        {m.angle ? <Text style={styles.angle} numberOfLines={3}>{`Mila's angle: ${m.angle}`}</Text> : null}
      </View>
    </View>
  );
}

function StoryFoot({ item, gold, onAction, onClose }: { item: StoryItem; gold: boolean; onAction: () => void; onClose: () => void }) {
  return (
    <>
      <Text style={[styles.kicker, gold && styles.kickerGold]} numberOfLines={1}>{item.kicker}</Text>
      <Text style={styles.title} numberOfLines={3}>{item.title}</Text>
      {item.line ? <Text style={styles.line} numberOfLines={3}>{item.line}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          onPress={() => { haptics.press(); onAction(); }}
          style={({ pressed }) => [styles.cta, gold && styles.ctaGold, pressed && styles.pressed]}
          accessibilityRole="button"
          testID="home-v3-story-action"
        >
          <Text style={styles.ctaText}>{item.action.label}</Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={8} style={styles.later} accessibilityRole="button" testID="home-v3-story-later">
          <Text style={styles.laterText}>{HOME_V3_COPY.notNow}</Text>
        </Pressable>
      </View>
    </>
  );
}

function EmptyFoot({ circle, onAction, onClose }: { circle: Circle; onAction: (item: StoryItem) => void; onClose: () => void }) {
  const e = HOME_V3_COPY.empty[circle.key];
  const ask: StoryItem | null = e.action && e.draft
    ? { id: `empty:${circle.key}`, circle: circle.key, kicker: circle.label, title: e.title, line: e.line, action: { label: e.action, target: { screen: "mila", draft: e.draft } } }
    : null;
  return (
    <>
      <Text style={styles.title}>{e.title}</Text>
      {e.line ? <Text style={styles.line}>{e.line}</Text> : null}
      <View style={styles.actions}>
        {ask ? (
          <Pressable onPress={() => onAction(ask)} style={({ pressed }) => [styles.cta, pressed && styles.pressed]} accessibilityRole="button" testID="home-v3-story-action">
            <Text style={styles.ctaText}>{ask.action.label}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} hitSlop={8} style={styles.later} accessibilityRole="button">
          <Text style={styles.laterText}>Close</Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  ground:     { flex: 1, backgroundColor: Accent.hero },
  zones:      { ...StyleSheet.absoluteFill, flexDirection: "row" },
  zonePrev:   { flex: 1 },
  zoneNext:   { flex: 2 },
  safe:       { flex: 1, justifyContent: "space-between" },
  top:        { paddingHorizontal: Bold.gutter, paddingTop: 10, gap: 10 },
  dots:       { flexDirection: "row", gap: 4 },
  dot:        { flex: 1, height: 3, borderRadius: 2, backgroundColor: Bold.lineOnDark },
  dotOn:      { backgroundColor: Bold.onDark },
  head:       { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 32 },
  headText:   { ...BoldType.label, color: Bold.onDark, flexShrink: 1 },
  logoWrap:   { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", paddingBottom: 160 },
  close:      { width: 32, height: 32, borderRadius: 16, backgroundColor: Accent.closeDisc, alignItems: "center", justifyContent: "center" },
  dateWrap:   { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", paddingBottom: 160 },
  dateTop:    { ...BoldType.label, fontSize: 18, lineHeight: 26, letterSpacing: 3, color: Accent.pinkOnDark },
  dateBig:    { ...BoldType.display, fontSize: 132, lineHeight: 140, color: Bold.onDark },
  textureClip:{ ...StyleSheet.absoluteFill, overflow: "hidden" },
  texture:    { position: "absolute", left: Bold.gutter, top: "40%", width: 2400, fontFamily: BoldType.display.fontFamily, fontWeight: "900", fontSize: 150, lineHeight: 170, letterSpacing: -4, color: Accent.texture },
  momentHead: { flexDirection: "row", alignItems: "center", gap: 14 },
  momentDate: { width: 76, height: 84, borderRadius: 14, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center" },
  momentDateTop:{ ...BoldType.chip, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, color: Accent.pink },
  momentDateBig:{ ...BoldType.display, fontSize: 40, lineHeight: 46, color: Bold.ink },
  kindChip:   { paddingHorizontal: 10, height: 26, borderRadius: 13, borderWidth: 1, borderColor: Bold.lineOnDark, alignItems: "center", justifyContent: "center" },
  kindText:   { ...BoldType.chip, color: Bold.onDarkSoft },
  angle:      { ...BoldType.read, color: Bold.onDarkSoft },
  poster:     { position: "absolute", left: Bold.gutter, right: Bold.gutter, top: 120, gap: 18 },
  lockup:     { flexDirection: "row", alignItems: "center", gap: 10 },
  lockAvatar: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: Bold.onDark },
  lockBlank:  { backgroundColor: Bold.lineOnDark },
  lockX:      { ...BoldType.label, fontSize: 16, color: Bold.onDarkSoft },
  lockLogo:   { width: 48, height: 48, borderRadius: 24, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  lockRound:  { borderRadius: 24, borderWidth: 0 },
  via:        { ...BoldType.caption, color: Bold.onDarkSoft, flexShrink: 1 },
  lockInitial:{ ...BoldType.headedTitle, fontSize: 20, color: Bold.ink },
  amount:     { ...BoldType.display, fontSize: 76, lineHeight: 84, letterSpacing: -2, color: Accent.gold },
  askBig:     { ...BoldType.display, fontSize: 40, lineHeight: 44, letterSpacing: -1, color: Bold.onDark },
  foot:       { paddingHorizontal: Bold.gutter, paddingBottom: 28, gap: 8 },
  kicker:     { ...BoldType.label, color: Accent.pinkSoft },
  kickerGold: { color: Accent.gold },
  title:      { ...BoldType.headedTitle, fontSize: 24, lineHeight: 28, color: Bold.onDark },
  line:       { ...BoldType.read, color: Bold.onDarkSoft },
  actions:    { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 8 },
  cta:        { height: Bold.button, paddingHorizontal: 22, borderRadius: Bold.button / 2, backgroundColor: Accent.pink, alignItems: "center", justifyContent: "center" },
  ctaGold:    { backgroundColor: Accent.gold },
  ctaText:    { ...BoldType.button, color: Bold.onDark },
  pressed:    { transform: [{ scale: Bold.pressScale }] },
  later:      { paddingVertical: 10 },
  laterText:  { ...BoldType.link, color: Bold.onDarkSoft },
});
