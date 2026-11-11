// Look B's shared pieces (DESIGN.md "B · Full-bleed bold", Oct 2026) — the small parts every Concept 0.4 surface draws
// the same way. Theme tokens and BoldType roles only.
//
//   <SectionHead title="What matters next" link="See all 3" onLink sub="…" />   17/900 uppercase + an optional blue link
//   <Eyebrow>Your marketability</Eyebrow>  <Eyebrow onDark>                       11/800 uppercase .12em, mute (or on black)
//   <LinkText onPress>See all 3</LinkText>                                        13/800 blue with its arrow; `onDark` lifts it
//   <HerWords label="In your words" text="…" source="Interview" url />           anything SHE said: 16/600 behind a 3px blue
//                                                                                 rule with a blue label — Nomila's text never
//   <RuledHead title="At a glance" right={…} />                                   a white card's black-ruled head (Knows)

import React from "react";
import { View, Text, Pressable, StyleSheet, Linking, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";

export function Eyebrow({ children, onDark, style, testID }: { children: string; onDark?: boolean; style?: StyleProp<ViewStyle>; testID?: string }) {
  return <Text style={[styles.eyebrow, onDark && styles.eyebrowOnDark, style as object]} testID={testID}>{children}</Text>;
}

export function LinkText({ children, onPress, onDark, arrow = true, testID, accessibilityLabel, style }: { children: string; onPress: () => void; onDark?: boolean; arrow?: boolean; testID?: string; accessibilityLabel?: string; style?: StyleProp<ViewStyle> }) {
  const ink = onDark ? Bold.blueOnDark : Bold.blue;
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={[styles.link, style]} testID={testID}>
      <Text style={[styles.linkText, { color: ink }]}>{children}</Text>
      {arrow ? <Feather name="arrow-right" size={13} color={ink} /> : null}
    </Pressable>
  );
}

export function SectionHead({ title, sub, link, onLink, right, style, testID }: { title: string; sub?: string | null; link?: string | null; onLink?: () => void; right?: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[styles.sh, style]} testID={testID}>
      <View style={styles.shRow}>
        <Text style={styles.shTitle}>{title}</Text>
        {link && onLink ? <LinkText onPress={onLink}>{link}</LinkText> : right ?? null}
      </View>
      {sub ? <Text style={styles.shSub}>{sub}</Text> : null}
    </View>
  );
}

/** A white card's head with the 2px black rule under it (What Nomila Knows, My Intelligence). */
export function RuledHead({ title, right, style }: { title: string; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.ruled, style]}>
      <Eyebrow>{title}</Eyebrow>
      {right ?? null}
    </View>
  );
}

export function HerWords({ label, text, source, url, style, testID, children }: {
  label: string;
  /** Her words, verbatim; the quotation marks are drawn here. */
  text?: string;
  /** Where it is from (a caption under the words). */
  source?: string | null;
  url?: string | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={[styles.her, style]} testID={testID}>
      <Text style={styles.herLabel}>{label}</Text>
      {text ? <Text style={styles.herText}>{`“${text}”`}</Text> : null}
      {children}
      {source ? (
        url ? (
          <Pressable onPress={() => Linking.openURL(url)} style={styles.herSourceRow} accessibilityRole="link" accessibilityLabel={`Open source: ${source}`}>
            <Text style={styles.herSource}>{source}</Text>
            <Feather name="external-link" size={11} color={Bold.mute} />
          </Pressable>
        ) : <Text style={styles.herSource}>{source}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrow:       { ...BoldType.label, color: Bold.mute },
  eyebrowOnDark: { color: Bold.onDarkLabel },
  link:          { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  linkText:      { ...BoldType.link },
  sh:            { gap: 2 },
  shRow:         { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  shTitle:       { flex: 1, ...BoldType.section, color: Bold.ink },
  shSub:         { ...BoldType.lede, color: Bold.mute },
  ruled:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 4, borderBottomWidth: 2, borderBottomColor: Bold.ink, marginBottom: 4 },
  her:           { borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 12, paddingVertical: 4, gap: 4 },
  herLabel:      { ...BoldType.herLabel, color: Bold.blue },
  herText:       { ...BoldType.herWords, color: Bold.ink },
  herSourceRow:  { flexDirection: "row", alignItems: "center", gap: 4 },
  herSource:     { ...BoldType.caption, color: Bold.mute },
});
