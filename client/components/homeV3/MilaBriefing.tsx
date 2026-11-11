// Home v3's Mila briefing (option C, 19 Oct 2026; design "Studio and Home, designed", 20 Oct 2026,
// https://claude.ai/artifact/CPRh4oiAaEMdNEJTNKNrsg). Below the circles, Home reads as Mila talking: up to three
// messages, each ONE sentence beside her (alive: a slow bob, still under Reduce Motion) and, under it, the item:
//
//   the FIRST   a hero card (~180): an offer on the brand's own colour (its logo chip, the fee large in gold, the ask,
//               glass buttons over the colour); a post or a moment led by its picture under a scrim; a payment on gold
//   the next    compact light cards: the picture on the left (58×70: the post's photo, the moment's picture, the
//               brand's logo on its colour), name, title (two lines), one quiet meta line, small chips inside
//
// Hero + two compact fit above the fold on a 6.1" phone. What she says, what each card says and what each chip does is
// lib/homeV3Logic `briefing` (pure, tested). The pictures: kit photos (useKitPhoto), moment pictures (MomentArt over
// the atmosphere picker's image), brand logos (LogoMark, the Opportunities cards' chain).

import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Image, Animated, Easing, AccessibilityInfo } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Accent, Bold, BoldType, Fonts } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { Photo } from "../ui/Photo";
import { LogoMark } from "../ui/LogoMark";
import { SOFT_LIFT } from "../mila/softLift";
import { useKitPhoto } from "./useKitPhoto";
import { MomentArt } from "../studioV3/MomentArt";
import { BRIEFING_COPY, type BriefChip, type BriefMessage, type Briefing } from "../../lib/homeV3Logic";

const MILA_STILL = require("../../../assets/mila/mila-still.png");

/**
 * A briefing item drawn by someone else (the card system v2, EXPO_PUBLIC_MILA_CARDS_V2): Mila's one sentence and the
 * card under it. Design "Mila card designs" v2.2 decision 3: the new cards (Insight, Idea, Turn-on, collapsed) TAKE the
 * briefing's compact slots — the hero stays today's card, and at most three items show in all (Home v3's limit).
 */
export interface BriefSlot { key: string; text: string; node: React.ReactNode }

/** The briefing's three slots: today's hero first; then the v2 cards in the compact slots; then today's compact items in
 *  any slot left. What does not fit counts in "N more" (it is in the circles above). Pure. */
export function briefingLayout(briefing: Briefing, slots: readonly BriefSlot[] = [], max = 3):
  { rows: Array<{ kind: "hero" | "compact"; m: BriefMessage } | { kind: "slot"; slot: BriefSlot }>; overflow: number } {
  if (!slots.length) return { rows: briefing.messages.map((m, i) => ({ kind: i === 0 ? "hero" as const : "compact" as const, m })), overflow: briefing.overflow };
  const [hero, ...rest] = briefing.messages;
  const rows: Array<{ kind: "hero" | "compact"; m: BriefMessage } | { kind: "slot"; slot: BriefSlot }> = hero ? [{ kind: "hero", m: hero }] : [];
  for (const slot of slots.slice(0, max - rows.length)) rows.push({ kind: "slot", slot });
  const room = Math.max(0, max - rows.length);
  for (const m of rest.slice(0, room)) rows.push({ kind: "compact", m });
  return { rows, overflow: briefing.overflow + Math.max(0, rest.length - room) };
}

export function MilaBriefing({ briefing, momentImages, onOpen, onChip, onMore, slots }: {
  briefing: Briefing;
  /** Moment pictures by story id (hooks/use-moment-images). */
  momentImages?: Record<string, string>;
  onOpen: (m: BriefMessage) => void;
  onChip: (m: BriefMessage, chip: BriefChip) => void;
  onMore: () => void;
  /** The card system v2's items (EXPO_PUBLIC_MILA_CARDS_V2): they take the compact slots (briefingLayout). */
  slots?: readonly BriefSlot[];
}) {
  const { rows, overflow } = briefingLayout(briefing, slots);
  return (
    <View style={styles.wrap} testID="home-v3-briefing">
      {rows.map((r) => r.kind === "slot" ? (
        <View key={r.slot.key} style={styles.message} testID={`home-v3-brief-slot-${r.slot.key}`}>
          <View style={styles.says}>
            <MilaBob />
            <Text style={styles.bubble} testID="home-v3-brief-text">{r.slot.text}</Text>
          </View>
          <View style={styles.slotCard}>{r.slot.node}</View>
        </View>
      ) : (
        <View key={r.m.id} style={styles.message} testID={`home-v3-brief-msg-${r.m.kind}`}>
          <View style={styles.says}>
            <MilaBob />
            <Text style={styles.bubble} testID="home-v3-brief-text">{r.m.text}</Text>
          </View>
          {r.kind === "hero"
            ? <HeroCard m={r.m} imageUrl={r.m.item ? momentImages?.[r.m.item.id] ?? null : null} onOpen={onOpen} onChip={onChip} />
            : <CompactCard m={r.m} imageUrl={r.m.item ? momentImages?.[r.m.item.id] ?? null : null} onOpen={onOpen} onChip={onChip} />}
        </View>
      ))}
      {overflow > 0 ? (
        <Pressable onPress={onMore} hitSlop={8} accessibilityRole="button" style={styles.more} testID="home-v3-brief-more">
          <Text style={styles.moreText}>{BRIEFING_COPY.more(overflow)}</Text>
          <Feather name="arrow-up" size={13} color={Accent.pinkDeep} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Mila beside her sentence, alive: a slow 3s bob and tilt; still when the OS asks for less motion. */
function MilaBob() {
  const t = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(true);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (mounted) setStill(!!v); }).catch(() => { if (mounted) setStill(false); });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v: boolean) => setStill(!!v));
    return () => { mounted = false; sub?.remove?.(); };
  }, []);
  useEffect(() => {
    if (still) { t.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(t, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [still, t]);
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [0, -2.5] });
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ["-3deg", "3deg"] });
  return (
    <View style={styles.milaRing} testID="home-v3-mila">
      <Animated.Image source={MILA_STILL} style={[styles.milaFace, { transform: [{ translateY }, { rotate }] }]} accessibilityIgnoresInvertColors />
    </View>
  );
}

function Chips({ m, onChip, onColour }: { m: BriefMessage; onChip: (m: BriefMessage, c: BriefChip) => void; onColour?: boolean }) {
  return (
    <View style={styles.chips}>
      {m.chips.map((c) => {
        const label = <Text style={[styles.chipText, (c.primary || onColour) && styles.chipTextLight]}>{c.label}</Text>;
        const press = () => { haptics.tap(); onChip(m, c); };
        const testID = `home-v3-chip-${m.kind}-${c.act.kind}`;
        if (onColour && !c.primary) {
          return (
            <Pressable key={c.label} onPress={press} hitSlop={6} accessibilityRole="button" accessibilityLabel={c.label} testID={testID}>
              <View style={styles.glassChip}>{label}</View>
            </Pressable>
          );
        }
        return (
          <Pressable key={c.label} onPress={press} hitSlop={6}
            style={({ pressed }) => [styles.chip, c.primary ? styles.chipPrimary : styles.chipQuiet, pressed && styles.pressed]}
            accessibilityRole="button" accessibilityLabel={c.label} testID={testID}>
            {label}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The first message's card: big and picture-led (or drawn on the brand's colour). */
function HeroCard({ m, imageUrl, onOpen, onChip }: { m: BriefMessage; imageUrl: string | null; onOpen: (m: BriefMessage) => void; onChip: (m: BriefMessage, c: BriefChip) => void }) {
  const it = m.item;
  const kitPhoto = useKitPhoto(m.kind === "post" ? it?.kitActionId ?? null : null);
  const open = () => { haptics.press(); onOpen(m); };

  if (m.kind === "offer" && it) {
    const p = it.poster;
    return (
      <View style={[styles.hero, styles.heroOffer, { backgroundColor: it.brandColor ?? Accent.hero }]} testID="home-v3-hero-offer">
        {it.coverUrl ? (
          <>
            {/* The brand's cover, photo-led, under the dark scrim; no cover → the brand's colour as before. */}
            <Photo uri={it.coverUrl} style={StyleSheet.absoluteFill} transition={0} testID="home-v3-hero-offer-cover" />
            <LinearGradient colors={[Bold.cardScrim, "rgba(0,0,0,0.30)", Bold.cardScrim]} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
          </>
        ) : (
          <LinearGradient colors={["rgba(255,255,255,0.10)", "rgba(0,0,0,0.28)"]} style={StyleSheet.absoluteFill} pointerEvents="none" />
        )}
        <Text style={styles.heroTexture} numberOfLines={1}>{p?.name ?? it.brandName ?? ""}</Text>
        <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${m.card.title}. Open`} style={styles.heroBody}>
          <View style={styles.heroTop}>
            <View style={styles.logoChip}>
              <LogoMark bold logoUrl={it.logoUrl ?? null} domain={it.logoDomain ?? null} name={it.brandName ?? it.title} size={30} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.heroName} numberOfLines={1}>{p?.name ?? it.brandName ?? it.title}</Text>
              {m.card.meta ? <Text style={styles.heroMeta} numberOfLines={1}>{m.card.meta}</Text> : null}
            </View>
          </View>
          {p?.amount ? <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit testID="home-v3-hero-amount">{p.amount}</Text> : null}
          <Text style={[styles.heroTitle, !p?.amount && styles.heroTitleBig]} numberOfLines={2}>{m.card.title}</Text>
        </Pressable>
        <Chips m={m} onChip={onChip} onColour />
      </View>
    );
  }

  const photo = m.kind === "post" ? kitPhoto : null;
  const isMoment = m.kind === "moment" && !!it;
  const gold = m.kind === "win";
  return (
    <View style={[styles.hero, gold && styles.heroGold]} testID={`home-v3-hero-${m.kind}`}>
      <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${m.card.title}. Open`} style={StyleSheet.absoluteFill}>
        {photo ? <Photo uri={photo} style={StyleSheet.absoluteFill} transition={0} />
          : isMoment ? <MomentArt story={it!} imageUrl={imageUrl} style={StyleSheet.absoluteFill} />
          : gold ? <LinearGradient colors={[Accent.gold, Accent.goldDeep]} style={StyleSheet.absoluteFill} />
          : <View style={[StyleSheet.absoluteFill, styles.heroInk]}><Image source={MILA_STILL} style={styles.heroMila} /></View>}
      </Pressable>
      {photo || isMoment ? <LinearGradient colors={[Bold.scrimClear, Bold.scrimFoot]} locations={[0.25, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
      <View style={styles.heroFoot} pointerEvents="box-none">
        {m.card.meta ? <Text style={styles.heroKicker} numberOfLines={1}>{m.card.meta}</Text> : null}
        <Text style={styles.heroTitle} numberOfLines={2}>{m.card.title}</Text>
        <Chips m={m} onChip={onChip} onColour />
      </View>
    </View>
  );
}

/** The next messages' cards: light, the picture small on the left. */
function CompactCard({ m, imageUrl, onOpen, onChip }: { m: BriefMessage; imageUrl: string | null; onOpen: (m: BriefMessage) => void; onChip: (m: BriefMessage, c: BriefChip) => void }) {
  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => { haptics.press(); onOpen(m); }}
        style={({ pressed }) => [styles.cardBody, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${m.card.title}. Open`}
        testID={`home-v3-brief-card-${m.kind}`}
      >
        <Thumb m={m} imageUrl={imageUrl} />
        <View style={styles.flex}>
          {m.card.name ? <Text style={styles.name} numberOfLines={1}>{m.card.name}</Text> : null}
          <Text style={styles.title} numberOfLines={2}>{m.card.title}</Text>
          {m.card.meta ? <Text style={styles.meta} numberOfLines={1} testID="home-v3-brief-meta">{m.card.meta}</Text> : null}
        </View>
      </Pressable>
      <Chips m={m} onChip={onChip} />
    </View>
  );
}

/** The compact card's picture (58×70). */
function Thumb({ m, imageUrl }: { m: BriefMessage; imageUrl: string | null }) {
  const it = m.item;
  const photo = useKitPhoto(m.kind === "post" ? it?.kitActionId ?? null : null);
  if (m.kind === "post") {
    return (
      <View style={styles.photo} testID="home-v3-brief-post">
        {photo ? <Photo uri={photo} style={StyleSheet.absoluteFill} transition={0} /> : <Feather name="image" size={18} color={Bold.mute} />}
      </View>
    );
  }
  if (m.kind === "moment" && it) return <MomentArt story={it} imageUrl={imageUrl} size="thumb" style={styles.photo} />;
  if (it && (m.kind === "offer" || (m.kind === "win" && (it.logoUrl || it.logoDomain)))) {
    return (
      <View style={[styles.photo, { backgroundColor: it.brandColor ?? Bold.ground }]} testID={`home-v3-brief-${m.kind}`}>
        <View style={styles.logoDisc}>
          <LogoMark bold logoUrl={it.logoUrl ?? null} domain={it.logoDomain ?? null} name={it.brandName ?? it.title} size={28} />
        </View>
      </View>
    );
  }
  if (m.kind === "booking") return <View style={[styles.photo, { backgroundColor: Accent.pinkSoft }]}><Feather name="clock" size={20} color={Accent.pinkDeep} /></View>;
  if (m.kind === "win") return <View style={[styles.photo, { backgroundColor: Accent.goldSoft }]}><Feather name="award" size={20} color={Accent.gold} /></View>;
  return <View style={[styles.photo, { backgroundColor: Bold.ground }]}><Image source={MILA_STILL} style={styles.thumbMila} accessibilityIgnoresInvertColors /></View>;
}

const THUMB_W = 58;
const THUMB_H = 70;
const CARD_INDENT = Bold.gutter + 36;

const styles = StyleSheet.create({
  flex:          { flex: 1, gap: 2 },
  pressed:       { opacity: 0.85 },
  wrap:          { marginTop: 6, gap: 14 },
  message:       { gap: 7 },
  // Under her sentence, like today's cards (CARD_INDENT), so the briefing reads as one column.
  slotCard:      { marginLeft: CARD_INDENT, marginRight: Bold.gutter },
  says:          { flexDirection: "row", alignItems: "flex-start", gap: 8, marginHorizontal: Bold.gutter },
  milaRing:      { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: Accent.pink, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  milaFace:      { width: 23, height: 23, borderRadius: 12 },
  bubble:        { ...BoldType.rowMeta, fontSize: 15, lineHeight: 20, color: Bold.ink, flex: 1, paddingTop: 4 },
  // The hero: ~180 high, full card width under her sentence.
  hero:          { marginLeft: CARD_INDENT, marginRight: Bold.gutter, height: 184, borderRadius: 20, overflow: "hidden", backgroundColor: Accent.hero, ...SOFT_LIFT },
  heroOffer:     { padding: 14, justifyContent: "space-between" },
  heroGold:      { backgroundColor: Accent.gold },
  heroInk:       { backgroundColor: Accent.hero, alignItems: "flex-end", justifyContent: "center", paddingRight: 18 },
  heroMila:      { width: 84, height: 84, borderRadius: 42, opacity: 0.9 },
  heroBody:      { gap: 4 },
  heroTop:       { flexDirection: "row", alignItems: "center", gap: 10 },
  logoChip:      { width: 40, height: 40, borderRadius: 10, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  heroName:      { ...BoldType.label, color: Bold.onDark },
  heroMeta:      { ...BoldType.caption, color: Bold.onDarkSoft },
  heroAmount:    { ...BoldType.screenTitle, fontSize: 40, lineHeight: 44, color: Accent.gold, letterSpacing: -1, marginTop: 4 },
  heroTitle:     { ...BoldType.headedTitle, fontSize: 17, lineHeight: 21, color: Bold.onDark },
  heroTitleBig:  { fontSize: 22, lineHeight: 26, marginTop: 6 },
  heroTexture:   { ...BoldType.screenTitle, position: "absolute", left: 150, bottom: -16, fontSize: 64, lineHeight: 68, letterSpacing: -2, color: Accent.texture, width: 900 },
  heroFoot:      { position: "absolute", left: 14, right: 14, bottom: 12, gap: 6 },
  heroKicker:    { ...BoldType.chip, color: Bold.onDarkSoft, letterSpacing: 0.8 },
  card:          { marginLeft: CARD_INDENT, marginRight: Bold.gutter, backgroundColor: Bold.paper, borderRadius: 16, padding: 10, gap: 8, ...SOFT_LIFT },
  cardBody:      { flexDirection: "row", alignItems: "center", gap: 12 },
  photo:         { width: THUMB_W, height: THUMB_H, borderRadius: 12, overflow: "hidden", backgroundColor: Bold.line, alignItems: "center", justifyContent: "center" },
  thumbMila:     { width: 40, height: 40, borderRadius: 20 },
  logoDisc:      { width: 40, height: 40, borderRadius: 20, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  name:          { ...BoldType.caption, color: Bold.mute, fontFamily: Fonts.bodySemiBold },
  title:         { ...BoldType.headedTitle, fontSize: 15, lineHeight: 19, color: Bold.ink },
  meta:          { ...BoldType.caption, color: Bold.mute },
  chips:         { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip:          { height: 30, paddingHorizontal: 12, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  // On a brand colour the glass has nothing behind it to blur: a clear white wash and a hairline edge read the same.
  glassChip:     { height: 30, paddingHorizontal: 12, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: Accent.glassLight, borderWidth: StyleSheet.hairlineWidth, borderColor: Accent.glassEdge },
  chipPrimary:   { backgroundColor: Accent.pink },
  chipQuiet:     { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line },
  chipText:      { ...BoldType.buttonSmall, color: Bold.ink },
  chipTextLight: { color: Bold.onDark },
  more:          { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", marginLeft: CARD_INDENT },
  moreText:      { ...BoldType.link, color: Accent.pinkDeep },
});
