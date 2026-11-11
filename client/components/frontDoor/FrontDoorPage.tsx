/**
 * FrontDoorPage — the athlete's public page in the app, the approved FRONT DOOR design (promoted from PR #900,
 * client/screens/prototypes/FrontDoorPage.tsx; the visitor's web page is server/services/publicCard/render.ts, the same
 * design). The one look (owner, 23 Oct 2026): a WHITE page ground, photo cards and door tiles at corner 16, the first
 * door as the page's ONE raspberry action (Bold.act), the rest grey (a dark door, Create "soon", stays black); Outfit
 * roles only.
 *
 *   top bar       NOMILA at the left, the handle at the right — and, for a VISITOR, the heart: one like per visitor,
 *                 tap again to take it back. Visitors never see a count; the athlete sees it in the metrics rail
 *   hero cards    the ONLY part that swipes. Card 1 is Highlights: her own photo full-bleed under the look-B scrim, her
 *                 name in display caps, ONE quote in her words behind the blue rule, the identity line. Then her
 *                 chapters, each only when the data holds it, on ATMOSPHERE (they are not photos of her; the category
 *                 default when the picker has none). "Highlights · 1 of N" with the rail's dots, a 7pt peek of the next card
 *   door grid     2 × 2 exactly as resolved at publish (Partner · Book · Picks · Create, or a fallback), Create dark.
 *                 Mila sits where the four tiles meet (48, inside the page-ground ring): Ask Mila. The doors NEVER move
 *                 with the cards, and with `pinnedDoors` they stay pinned under the page while it scrolls (owner rule)
 *   footer        Follow <First>, and who published the page
 *
 *   OWNER VIEW    (`metrics` set, her own view only) a slim vertical METRICS RAIL on the right of the hero:
 *                 views · likes · requests · bookings · shop, each an icon over its number (last 30 days)
 *
 * "Verified by Nomila" follows the one switch (shared/publicPageStats SHOW_VERIFIED, off).
 */
import React, { useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Photo } from "../ui/Photo";
import { MilaAvatar } from "../mila/MilaAvatar";
import { Bold, BoldType } from "../../constants/theme";
import { AtmosphereSlot } from "./Atmosphere";
import { CHAPTER_DOMAIN, shortCount, type FrontDoorModel, type FrontDoorTile } from "../../lib/frontDoorLogic";
import { SHOW_VERIFIED, type PublicPageMetrics } from "../../../shared/publicPageStats";

type IconName = React.ComponentProps<typeof Feather>["name"];

export const FRONT_DOOR_COPY = {
  verified: "Verified by Nomila",
  highlights: "Highlights",
  counter: (title: string, i: number, n: number) => `${title} · ${i} of ${n}`,
  askMila: "Ask Mila",
  follow: (first: string) => `Follow ${first}`,
  publishedBy: (first: string) => `Everything on this page is published by ${first}.`,
  metrics: { views: "Views", likes: "Likes", requests: "Requests", bookings: "Bookings", shop: "Shop" },
  like: "Like this page",
  liked: "You like this page",
  metricsWindow: "Last 30 days",
} as const;

const TILE_ICON: Record<FrontDoorTile["key"], IconName> = {
  partner: "briefcase", book: "calendar", shop: "shopping-bag", create: "star", story: "book-open", follow: "user-plus", ask: "message-square",
};

const G = 6;
/** The page's ONE raspberry action: its first door (unless that door is a dark "soon" one). */
const actOf = (t: FrontDoorTile, i: number) => i === 0 && !t.dark;
const TILE_H = 88;
const MILA = 48;
const RING = MILA + G * 2;
const PEEK = 7;
/** The door grid's height (two tiles, the gaps around them). */
export const DOOR_GRID_H = TILE_H * 2 + G * 3;

export type ChapterImages = Record<string, { url: string; credit: string } | undefined>;

function MetricsRail({ m }: { m: Pick<PublicPageMetrics, "views" | "likes" | "requests" | "bookings" | "shop"> }) {
  const c = FRONT_DOOR_COPY.metrics;
  const items: [IconName, number, string][] = [
    ["eye", m.views, c.views], ["heart", m.likes, c.likes], ["briefcase", m.requests, c.requests], ["calendar", m.bookings, c.bookings], ["shopping-bag", m.shop, c.shop],
  ];
  return (
    <View style={styles.rail} accessibilityLabel={`${FRONT_DOOR_COPY.metricsWindow}: ${items.map(([, n, l]) => `${n} ${l.toLowerCase()}`).join(", ")}`} testID="front-door-metrics">
      {items.map(([icon, n, label]) => (
        <View key={label} style={styles.railItem} testID={`metric-${label.toLowerCase()}`}>
          <Feather name={icon} size={22} color={Bold.onDark} />
          <Text style={styles.railValue}>{shortCount(n)}</Text>
          <Text style={styles.railLabel}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export function FrontDoorPage({
  model, owner = false, metrics = null, verified = false, chapterImages = {}, heroHeight, width: forcedWidth, pinnedDoors = false,
  liked: likedInitial = false, onLike, onAsk = () => {}, onDoor = () => {},
}: {
  model: FrontDoorModel;
  /** Her own view: the metrics rail on the hero, no heart. Visitors: false (the heart, no rail, never a count). */
  owner?: boolean;
  /** Her rail's numbers (owner only); the rail waits for them rather than show zeros that are not hers. */
  metrics?: Pick<PublicPageMetrics, "views" | "likes" | "requests" | "bookings" | "shop"> | null;
  /** The snapshot's verified mark; drawn only while SHOW_VERIFIED is on. */
  verified?: boolean;
  /** Atmosphere per chapter key (the picker); a chapter without one draws its category default. */
  chapterImages?: ChapterImages;
  /** The hero's height (default ~68% of the screen). */
  heroHeight?: number;
  /** Lay the page out at this width (the mini on Me renders at phone width and scales). */
  width?: number;
  /** The full page: the doors stay pinned under the page while the cards and the footer scroll. */
  pinnedDoors?: boolean;
  /** A visitor's own like (one per visitor, toggles). */
  liked?: boolean;
  onLike?: (liked: boolean) => void;
  onAsk?: () => void;
  /** A door (a story / follow tile swipes to its chapter here first, as on the web page). */
  onDoor?: (tile: FrontDoorTile) => void;
}) {
  const [liked, setLiked] = useState(likedInitial);
  const win = useWindowDimensions();
  const W = forcedWidth ?? Math.min(win.width, 480);
  const H = heroHeight ?? Math.round(Math.min(win.height, 900) * (pinnedDoors ? 0.62 : 0.68));
  const cardW = W - PEEK - G * 2;
  const [index, setIndex] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const m = model;
  const cards: { key: string; title: string }[] = [{ key: "highlights", title: FRONT_DOOR_COPY.highlights }, ...m.chapters.map((c) => ({ key: c.key, title: c.title }))];
  const n = cards.length;
  const onEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => setIndex(Math.max(0, Math.min(n - 1, Math.round(e.nativeEvent.contentOffset.x / (cardW + G)))));
  const c = FRONT_DOOR_COPY;
  const tap = (t: FrontDoorTile) => {
    const i = t.targetChapter ? cards.findIndex((k) => k.key === t.targetChapter) : -1;
    if (t.key === "story" && i >= 0) {
      setIndex(i);
      scroller.current?.scrollTo?.({ x: i * (cardW + G), animated: true });
      return;
    }
    onDoor(t);
  };
  const like = () => { const next = !liked; setLiked(next); onLike?.(next); };

  const top = (
    <View style={styles.top}>
      <Text style={styles.wordmark}>NOMILA</Text>
      <View style={styles.topRight}>
        {m.handle ? <Text style={styles.handle} numberOfLines={1}>{m.handle}</Text> : null}
        {owner ? null : (
          <Pressable onPress={like} hitSlop={8} accessibilityRole="button" accessibilityState={{ selected: liked }} accessibilityLabel={liked ? c.liked : c.like} style={[styles.heart, liked && styles.heartOn]} testID="front-door-like">
            <Feather name="heart" size={16} color={liked ? Bold.onAct : Bold.ink} />
          </Pressable>
        )}
      </View>
    </View>
  );

  const hero = (
    <View style={{ height: H }}>
      <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} snapToInterval={cardW + G} decelerationRate="fast" onMomentumScrollEnd={onEnd} contentContainerStyle={styles.cards} testID="front-door-cards">
        <View style={[styles.card, { width: cardW, height: H }]} testID="front-door-highlights">
          {m.heroPhoto ? <Photo uri={m.heroPhoto} style={StyleSheet.absoluteFill} /> : <View style={[StyleSheet.absoluteFill, styles.blank]} />}
          <LinearGradient colors={[Bold.scrimTop, Bold.scrimClear, Bold.scrimMid, Bold.scrimDeep]} locations={[0, 0.3, 0.5, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
          <View style={[styles.foot, owner && styles.footOwner]}>
            {SHOW_VERIFIED && verified ? (
              <View style={styles.verified} testID="front-door-verified"><Feather name="check-circle" size={13} color={Bold.blueOnDark} /><Text style={styles.verifiedText}>{c.verified}</Text></View>
            ) : null}
            <Text style={styles.name}>{m.name}</Text>
            {m.quote ? <View style={styles.quote}><Text style={styles.quoteText}>{`“${m.quote}”`}</Text></View> : null}
            {m.identity ? <Text style={styles.identity}>{m.identity}</Text> : null}
          </View>
          {owner && metrics ? <MetricsRail m={metrics} /> : null}
        </View>
        {m.chapters.map((ch) => (
          <View key={ch.key} style={[styles.card, { width: cardW, height: H }]} testID={`front-door-chapter-${ch.key}`}>
            <AtmosphereSlot image={chapterImages[ch.key]} domain={CHAPTER_DOMAIN[ch.key] ?? null} height={H} style={StyleSheet.absoluteFill} testID={`front-door-atmosphere-${ch.key}`} />
            <LinearGradient colors={["rgba(0,0,0,0.35)", "rgba(0,0,0,0.55)", Bold.scrimDeep]} locations={[0, 0.4, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
            <View style={styles.foot}>
              {ch.headline !== ch.title ? <Text style={styles.chEyebrow}>{ch.title}</Text> : null}
              <Text style={styles.chHeadline}>{ch.headline}</Text>
              {ch.lines.map((l) => <View key={l} style={styles.chLine}><View style={styles.chDot} /><Text style={styles.chLineText}>{l}</Text></View>)}
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={styles.counter} pointerEvents="none" accessibilityLiveRegion="polite">
        <Text style={styles.counterText} testID="front-door-counter">{c.counter(cards[index].title, index + 1, n)}</Text>
        <View style={styles.dots}>{cards.map((k, i) => <View key={k.key} style={[styles.dot, i === index && styles.dotOn]} />)}</View>
      </View>
    </View>
  );

  const grid = (
    <View style={[styles.grid, pinnedDoors && styles.gridPinned]} testID="front-door-grid">
      {m.tiles.map((t, i) => (
        <Pressable key={`${t.key}-${i}`} onPress={() => tap(t)} accessibilityRole="button" accessibilityLabel={`${t.label}. ${t.sub}`} style={({ pressed }) => [styles.tile, actOf(t, i) && styles.tileAct, t.dark && styles.tileDark, i % 2 === 1 && styles.tileRight, pressed && styles.pressed]} testID={`front-door-tile-${t.key}`}>
          <View style={[styles.tileHead, i % 2 === 1 && styles.tileHeadRight]}>
            <Feather name={TILE_ICON[t.key] ?? "circle"} size={15} color={t.dark || actOf(t, i) ? Bold.onDark : Bold.ink} />
            <Text style={[styles.tileLabel, (t.dark || actOf(t, i)) && styles.onDark]} numberOfLines={1}>{t.label}</Text>
          </View>
          <Text style={[styles.tileSub, t.dark && styles.onDarkMute, actOf(t, i) && styles.onActSoft, i % 2 === 1 && styles.right]} numberOfLines={2}>{t.sub}</Text>
        </Pressable>
      ))}
      {m.askMila ? (
        <Pressable onPress={onAsk} accessibilityRole="button" accessibilityLabel={c.askMila} style={styles.milaRing} testID="front-door-mila">
          <MilaAvatar state="idle" size={MILA} active={false} />
        </Pressable>
      ) : null}
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      <Text style={styles.follow}>{c.follow(m.firstName)}</Text>
      {m.socials.length ? <Text style={styles.socials}>{m.socials.map((s) => `${s.network} @${s.handle}`).join("  ·  ")}</Text> : null}
      <Text style={styles.published}>{c.publishedBy(m.firstName)}</Text>
    </View>
  );

  if (pinnedDoors) {
    // Only the hero swipes; the page (hero + footer) scrolls under the doors, which never leave the screen.
    return (
      <View style={[styles.page, styles.pageFill, { width: W }]} testID={owner ? "front-door-owner" : "front-door-visitor"}>
        {top}
        <ScrollView style={styles.flex} showsVerticalScrollIndicator={false} testID="front-door-scroll">
          {hero}
          {footer}
        </ScrollView>
        {grid}
      </View>
    );
  }
  return (
    <View style={[styles.page, { width: W }]} testID={owner ? "front-door-owner" : "front-door-visitor"}>
      {top}
      {hero}
      {grid}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  page:          { backgroundColor: Bold.paper },
  pageFill:      { flex: 1, alignSelf: "center" },
  flex:          { flex: 1 },
  top:           { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Bold.gutter },
  wordmark:      { ...BoldType.wordmark, color: Bold.ink },
  handle:        { ...BoldType.backLabel, color: Bold.mute, flexShrink: 1 },
  topRight:      { flexDirection: "row", alignItems: "center", gap: 12, maxWidth: "70%" },
  heart:         { width: 32, height: 32, borderRadius: 16, borderWidth: 1.5, borderColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  heartOn:       { backgroundColor: Bold.act, borderColor: Bold.act },
  cards:         { paddingHorizontal: G, gap: G },
  card:          { overflow: "hidden", backgroundColor: Bold.heroBlank, borderRadius: Bold.radius.card },
  blank:         { backgroundColor: Bold.heroBlank },
  foot:          { position: "absolute", left: 0, right: 0, bottom: 52, paddingHorizontal: Bold.gutter, gap: 8 },
  footOwner:     { right: 64 },
  verified:      { flexDirection: "row", alignItems: "center", gap: 6 },
  verifiedText:  { ...BoldType.label, color: Bold.blueOnDark },
  name:          { ...BoldType.display, color: Bold.onDark },
  quote:         { borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 10 },
  quoteText:     { ...BoldType.herWords, color: Bold.onDark },
  identity:      { ...BoldType.heroLineSmall, color: Bold.onDarkSoft },
  rail:          { position: "absolute", right: 10, bottom: 56, alignItems: "center", gap: 14, paddingVertical: 10, width: 52 },
  railItem:      { alignItems: "center", gap: 1 },
  railValue:     { ...BoldType.sigValue, color: Bold.onDark },
  railLabel:     { ...BoldType.caption, color: Bold.onDarkLabel },
  chEyebrow:     { ...BoldType.label, color: Bold.onDarkLabel },
  chHeadline:    { ...BoldType.displaySm, color: Bold.onDark },
  chLine:        { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  chDot:         { width: 6, height: 6, borderRadius: 3, backgroundColor: Bold.onDark, marginTop: 8 },
  chLineText:    { flex: 1, ...BoldType.body, color: Bold.onDarkSoft },
  counter:       { position: "absolute", left: G + Bold.gutter, right: Bold.gutter + PEEK + G, bottom: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  counterText:   { ...BoldType.caption, color: Bold.onDarkSoft },
  dots:          { flexDirection: "row", alignItems: "center", gap: 5 },
  dot:           { width: 5, height: 5, borderRadius: 3, backgroundColor: Bold.onDarkMute },
  dotOn:         { width: 14, backgroundColor: Bold.onDark },
  grid:          { flexDirection: "row", flexWrap: "wrap", gap: G, padding: G },
  gridPinned:    { backgroundColor: Bold.paper },
  tile:          { width: "49.2%", flexGrow: 1, height: TILE_H, backgroundColor: Bold.ground, borderRadius: Bold.radius.card, padding: 12, justifyContent: "space-between" },
  tileAct:       { backgroundColor: Bold.act },
  tileRight:     { alignItems: "flex-end" },
  tileDark:      { backgroundColor: Bold.ink },
  tileHead:      { flexDirection: "row", alignItems: "center", gap: 6 },
  tileHeadRight: { flexDirection: "row-reverse" },
  tileLabel:     { ...BoldType.section, color: Bold.ink, flexShrink: 1 },
  tileSub:       { ...BoldType.caption, color: Bold.mute },
  right:         { textAlign: "right" },
  onDark:        { color: Bold.onDark },
  onDarkMute:    { color: Bold.onDarkMute },
  onActSoft:     { color: Bold.onDarkSoft },
  pressed:       { transform: [{ scale: Bold.pressScale }] },
  milaRing:      { position: "absolute", left: "50%", top: G + TILE_H + G / 2 - RING / 2, marginLeft: -RING / 2, width: RING, height: RING, borderRadius: RING / 2, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center" },
  footer:        { paddingHorizontal: Bold.gutter, paddingTop: 18, paddingBottom: 28, gap: 6 },
  follow:        { ...BoldType.section, color: Bold.ink },
  socials:       { ...BoldType.caption, color: Bold.ink2 },
  published:     { ...BoldType.caption, color: Bold.mute },
});
