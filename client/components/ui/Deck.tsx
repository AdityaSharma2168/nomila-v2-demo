// Deck — the swipeable image deck a letter sits over (DESIGN.md "Density: collapsed cards, decks and letters", look B).
//
//   <Deck pages={[{ key, image, children }]} onPagePress={toLetter} topBar={<‹ YOUR PLAN />} />
//
// Full-bleed pages, 372 tall, no peek: the counter chip "n / N" (bottom-right, clear of the letter) is the only swipe
// affordance and exists only when there are two or more pages. ONE page is a plain hero — no counter, nothing to swipe.
// The deck shows what it is about (images and facts about the subject); what Nomila thinks and asks lives in the
// LetterSheet beneath, which overlaps the deck by `Bold.deck.overlap`. Tap anywhere on a page → `onPagePress` (the
// screen scrolls to the letter); the top bar rides over the deck.
//
//   <DeckPanel label="About gorjana">…</DeckPanel>     the fact panel on pages 2…N of a brand deck (solid black 66%,
//                                                      1px white 16% line, radius 6, inset 14, lifted clear of the letter)
//   <DeckIdentity logo name category />                page 1 of a brand deck: logo · brand · category on one line
//   <DeckChip>Athlete</DeckChip>  <DeckChip blue>      a ghost chip on a dark page (athletes they work with, sports)
//
// Scrim 5% → 30% → 72%; no image ⇒ the blank ground (never a tint, never a stock picture); `fallback` draws instead of
// the ground (a recommendation's category default). Theme tokens and BoldType roles only.

import React, { useCallback, useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Bold, BoldType } from "../../constants/theme";
import { Eyebrow } from "./Bold";
import { Photo } from "./Photo";

export const DECK_HEIGHT = Bold.deck.height;
export const LETTER_OVERLAP = Bold.deck.overlap;
export const DECK_FOOT = Bold.deck.foot;

export interface DeckPage {
  key: string;
  /** The page's full-bleed image; null ⇒ `fallback`, else the blank ground. */
  image: string | null;
  fallback?: React.ReactNode;
  /** What rides over the page: chips + a title at the foot, the identity pill, a fact panel. */
  children?: React.ReactNode;
  accessibilityLabel?: string;
}

export function Deck({ pages, height = DECK_HEIGHT, onPagePress, topBar, style, testID }: {
  pages: DeckPage[];
  height?: number;
  /** A tap on any page: the screen scrolls to the letter. */
  onPagePress?: () => void;
  /** ‹ PARENT over the top of the deck (white on the scrim). */
  topBar?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const n = pages.length;
  const onEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.max(0, Math.min(n - 1, Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width))));
    setIndex((prev) => (prev === i ? prev : i));
  }, [n, width]);

  return (
    <View style={[styles.wrap, { height }, style]} testID={testID ?? "deck"}>
      <FlatList
        data={pages}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        scrollEnabled={n > 1}
        keyExtractor={(p) => p.key}
        onMomentumScrollEnd={onEnd}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item, index: i }) => (
          <Pressable
            style={{ width, height }}
            onPress={onPagePress}
            disabled={!onPagePress}
            accessibilityRole={onPagePress ? "button" : undefined}
            accessibilityLabel={item.accessibilityLabel ?? (n > 1 ? `Page ${i + 1} of ${n}` : undefined)}
            testID={`deck-page-${i + 1}`}
          >
            {item.image
              ? <Photo uri={item.image} style={StyleSheet.absoluteFill} testID={`deck-image-${i + 1}`} />
              : item.fallback ?? <View style={[StyleSheet.absoluteFill, styles.blank]} testID={`deck-blank-${i + 1}`} />}
            <LinearGradient colors={[Bold.deck.scrimTop, Bold.deck.scrimMid, Bold.deck.scrimFoot]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
            {item.children ? <View style={[styles.foot, n > 1 && styles.footClearOfCounter]}>{item.children}</View> : null}
          </Pressable>
        )}
      />
      {topBar ? <View style={styles.top} pointerEvents="box-none">{topBar}</View> : null}
      {n > 1 ? (
        <View style={styles.counter} pointerEvents="none" accessibilityLiveRegion="polite" accessibilityLabel={`Page ${index + 1} of ${n}`} testID="deck-counter">
          <Text style={styles.counterText}>{`${index + 1} / ${n}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The fact panel on a brand deck's pages 2…N: an eyebrow label and the facts, lifted clear of the letter. */
export function DeckPanel({ label, children, testID }: { label: string; children: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.panel} testID={testID}>
      <Eyebrow onDark>{label}</Eyebrow>
      {children}
    </View>
  );
}

/** Page 1 of a brand deck: the mark, the brand and its category on ONE line, bottom-left. */
export function DeckIdentity({ logo, name, category, testID }: { logo?: React.ReactNode; name: string; category?: string | null; testID?: string }) {
  return (
    <View style={styles.pill} testID={testID ?? "deck-identity"}>
      {logo ? <View style={styles.pillLogo}>{logo}</View> : null}
      <Text style={styles.pillName} numberOfLines={1}>
        {name}
        {category ? <Text style={styles.pillCategory}>{` · ${category}`}</Text> : null}
      </Text>
    </View>
  );
}

/** A ghost chip on a dark page (never tappable): white 18% with a hairline; `blue` for a sport. */
export function DeckChip({ children, blue }: { children: string; blue?: boolean }) {
  return (
    <View style={[styles.chip, blue && styles.chipBlue]} accessibilityRole="text" testID={blue ? "deck-chip-blue" : "deck-chip"}>
      <Text style={styles.chipText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:         { backgroundColor: Bold.ink, overflow: "hidden" },
  blank:        { backgroundColor: Bold.heroBlank },
  top:          { position: "absolute", top: 0, left: 0, right: 0 },
  foot:         { position: "absolute", left: Bold.gutter, right: Bold.gutter, bottom: DECK_FOOT, gap: 8 },
  footClearOfCounter: { right: 76 },
  counter:      { position: "absolute", right: 14, bottom: DECK_FOOT, backgroundColor: Bold.deck.counter, borderWidth: 1, borderColor: Bold.deck.counterLine, borderRadius: Bold.radius.chip, paddingHorizontal: 8, paddingVertical: 6 },
  counterText:  { ...BoldType.buttonSmall, color: Bold.onDark, fontVariant: ["tabular-nums"] },
  panel:        { position: "absolute", left: 14, right: 14, bottom: DECK_FOOT, backgroundColor: Bold.deck.panel, borderWidth: 1, borderColor: Bold.deck.panelLine, borderRadius: Bold.radius.card, padding: 14, gap: 8 },
  pill:         { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", backgroundColor: Bold.deck.pill, borderRadius: Bold.radius.control, paddingVertical: 6, paddingLeft: 6, paddingRight: 10 },
  pillLogo:     { flexShrink: 0 },
  pillName:     { ...BoldType.h4, color: Bold.ink, flexShrink: 1 },
  pillCategory: { ...BoldType.sigMeta, color: Bold.ink2 },
  chip:         { backgroundColor: Bold.deck.chip, borderWidth: 1, borderColor: Bold.deck.chipLine, borderRadius: Bold.radius.chip, paddingHorizontal: 8, paddingVertical: 5 },
  chipBlue:     { backgroundColor: Bold.deck.chipBlue },
  chipText:     { ...BoldType.chipLine, color: Bold.onDark },
});
