// LetterSheet — the white sheet that rises over a deck's foot (DESIGN.md "Density: collapsed cards, decks and letters").
//
//   <LetterSheet meta="Suggested 27 Sep 2026">…</LetterSheet>          a recommendation letter: no title (the deck's page 1
//                                                                       carries it), it opens with the date
//   <LetterSheet title="Adidas and you" meta="What Nomila knows…">     a brand letter is headed "<Brand> and you"
//   <LetterBlock title="Why this fits">…</LetterBlock>                 a hairline-divided block with its 15/800 heading
//   <LetterBlock row onPress>…</LetterBlock>                           a tappable row block (the goal it advances)
//
// The letter shows what Nomila thinks and asks — proposal, why, priority, action, decision — and never a line the deck
// already shows. It overlaps the deck by `Bold.deck.overlap` (24), corner 6 on the top corners only, and scrolls with the
// screen inside the same scroll view: never a modal. Its first line (the date, or the brand heading) is a header for
// assistive tech, the next focus stop after the deck. Theme tokens and BoldType roles only.

import React from "react";
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Bold, BoldType } from "../../constants/theme";

export function LetterSheet({ title, meta, children, style, testID }: {
  /** A brand letter's heading ("gorjana and you"); a recommendation letter has none. */
  title?: string | null;
  /** The first line: the date a recommendation was suggested, or what the brand letter holds. */
  meta?: string | null;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View style={[styles.sheet, style]} testID={testID ?? "letter"}>
      {title || meta ? (
        <View style={styles.head} accessible accessibilityRole="header" testID="letter-head">
          {title ? <Text style={styles.title} testID="letter-title">{title}</Text> : null}
          {meta ? <Text style={styles.meta} testID="letter-meta">{meta}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function LetterBlock({ title, meta, children, row, onPress, accessibilityLabel, style, testID }: {
  title?: string | null;
  /** A caption at the heading's right (a count, "3 sources"). */
  meta?: string | null;
  children?: React.ReactNode;
  /** Lay the children in one row (a tile · text · chevron). */
  row?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const inner = (
    <>
      {title ? (
        <View style={styles.blockHead}>
          <Text style={styles.blockTitle}>{title}</Text>
          {meta ? <Text style={styles.blockMeta}>{meta}</Text> : null}
        </View>
      ) : null}
      {row ? <View style={styles.row}>{children}</View> : children}
    </>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title ?? undefined} style={({ pressed }) => [styles.block, pressed && styles.pressed, style]} testID={testID}>
        {inner}
      </Pressable>
    );
  }
  return <View style={[styles.block, style]} testID={testID}>{inner}</View>;
}

const styles = StyleSheet.create({
  sheet:      { marginTop: -Bold.deck.overlap, backgroundColor: Bold.paper, borderTopLeftRadius: Bold.radius.card, borderTopRightRadius: Bold.radius.card, paddingTop: 20, paddingHorizontal: Bold.gutter, paddingBottom: 20, gap: 14 },
  head:       { gap: 6 },
  title:      { ...BoldType.statement, color: Bold.ink },
  meta:       { ...BoldType.caption, color: Bold.mute },
  block:      { paddingTop: 14, borderTopWidth: 1, borderTopColor: Bold.line, gap: 8 },
  pressed:    { opacity: 0.8 },
  blockHead:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  blockTitle: { flex: 1, ...BoldType.h4, color: Bold.ink },
  blockMeta:  { ...BoldType.caption, color: Bold.mute },
  row:        { flexDirection: "row", alignItems: "center", gap: 12 },
});
