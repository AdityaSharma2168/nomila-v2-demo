// Card — the deal card's container, for everything that is a card.
//
//   <Card>                       corner 16 · Shadows.card · white
//   <Card flat>                  corner 16 · 1px border · no shadow (inside a sheet, or dense lists)
//   <Card.Header icon|logo title subtitle eyebrow trailing />
//   <Card.Body>                  padding 12 16 16
//   <Card.Inner>                 the only allowed card-in-a-card: tint, corner 12, no shadow
//   <Card bold>                  look B (DESIGN.md, Oct 2026): white · 1px line · corner 6 · NO shadow — the Concept 0.4
//                                surfaces pass it; a legacy screen keeps the corner-20 shadow card until it migrates
//
// Rows (ui/Row) go straight inside a Card — the Card owns the edges and the shadow, the Row owns
// its divider. Kit page: https://claude.ai/code/artifact/814fcfe0-1537-4764-be21-51050dbe3ef0

import React from "react";
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Colors, Fonts, Spacing, Shadows, Bold } from "../../constants/theme";

const C = Colors.light;

interface CardProps {
  children?: React.ReactNode;
  /** 1px border instead of a shadow — for a card inside a sheet, or a dense list. */
  flat?:     boolean;
  /** Look B: white, 1px line, corner 6, no shadow. */
  bold?:     boolean;
  style?:    StyleProp<ViewStyle>;
  /** Default 16 (Bold.radius.card). Pass a smaller corner only for a card in a tight row. */
  radius?:   number;
  testID?:   string;
}

function CardRoot({ children, flat, bold, style, radius, testID }: CardProps) {
  return (
    <View style={[styles.card, bold ? styles.bold : flat ? styles.flat : styles.shadow, radius != null && { borderRadius: radius }, style]} testID={testID}>
      {children}
    </View>
  );
}

interface HeaderProps {
  /** A 36×36 tile with an icon inside (Settings look) … */
  icon?:     React.ReactNode;
  iconTint?: string;
  /** … or a 40×40 logo (deal-card look). Pass one or the other. */
  logo?:     React.ReactNode;
  eyebrow?:  string;
  title?:    string;
  subtitle?: string;
  /** A chip, a value, a chevron — sits at the right edge. */
  trailing?: React.ReactNode;
  /** Header content below the title line (the score card's hero row). */
  children?: React.ReactNode;
  /** Draw the hairline under the header. Default true. */
  divider?:  boolean;
}

function Header({ icon, iconTint, logo, eyebrow, title, subtitle, trailing, children, divider = true }: HeaderProps) {
  return (
    <View style={[styles.header, divider && styles.headerDivider]}>
      <View style={styles.headerTop}>
        {logo ? <View style={styles.logo}>{logo}</View> : icon ? <View style={[styles.icon, iconTint ? { backgroundColor: iconTint } : null]}>{icon}</View> : null}
        <View style={styles.headerText}>
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text> : null}
        </View>
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
      {children ? <View style={styles.headerBelow}>{children}</View> : null}
    </View>
  );
}

function Body({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.body, style]}>{children}</View>;
}

function Inner({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.inner, style]}>{children}</View>;
}

export const Card = Object.assign(CardRoot, { Header, Body, Inner });

const styles = StyleSheet.create({
  // One look (23 Oct 2026): every text card is corner 16 (Bold.radius.card), legacy or bold.
  card:          { backgroundColor: C.card, borderRadius: Bold.radius.card, overflow: "hidden" },
  shadow:        { ...(Shadows.card as object) },
  flat:          { borderWidth: 1, borderColor: C.border },
  bold:          { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card },
  header:        { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, gap: Spacing.sm },
  headerDivider: { borderBottomWidth: 1, borderBottomColor: C.borderLight },
  headerTop:     { flexDirection: "row", alignItems: "center", gap: Spacing.md },
  headerText:    { flex: 1, minWidth: 0 },
  headerBelow:   {},
  icon:          { width: 36, height: 36, borderRadius: 10, backgroundColor: C.backgroundDefault, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  logo:          { width: 40, height: 40, borderRadius: 12, overflow: "hidden", flexShrink: 0 },
  eyebrow:       { fontFamily: Fonts.bodySemiBold, fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase", color: C.textQuiet },
  title:         { fontFamily: Fonts.bodySemiBold, fontSize: 15, lineHeight: 19, color: C.text },
  subtitle:      { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet, marginTop: 1 },
  trailing:      { flexShrink: 0, alignItems: "flex-end" },
  body:          { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.lg },
  inner:         { backgroundColor: C.backgroundDefault, borderRadius: 12, padding: Spacing.md },
});
