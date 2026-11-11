// ProvenanceGlyph — the quiet mark at the end of a fact row that says where it came from, by shape, never by words on
// the face (the tier is still said in words inside the entry's sheet). ONE set of source marks, shared by What Nomila
// Knows, My Intelligence and a recommendation's evidence (visual rules, Oct 2026): inline, glyph 16, no tile.
//
//   <ProvenanceGlyph kind="you" />         person     = you confirmed it (the one blue, "from her")
//   <ProvenanceGlyph kind="document" />    document   = an official source (the team, school, governing body)
//   <ProvenanceGlyph kind="search" />      magnifier  = researched
//   <ProvenanceGlyph kind="link" />        link       = a connected account or your inbox
//   <ProvenanceGlyph kind="proof" />       briefcase  = a deal on record
//   unconfirmed                            a dashed ring around the mark (sources disagree, or you said it isn't right)
//   count                                  a small number at the corner: how many entries sit behind the row
//
// `size` is the GLYPH's size (16 inline); the ring and the badge sit in a ring 8 wider.

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import type { ProvenanceGlyph as GlyphKind } from "../../lib/myIntelligenceLogic";

type IconName = React.ComponentProps<typeof Feather>["name"];

export const ICON: Record<GlyphKind, IconName> = { you: "user", document: "file-text", search: "search", link: "link", proof: "briefcase" };
const WORD: Record<GlyphKind, string> = { you: "Confirmed by you", document: "Official source", search: "Researched", link: "From your accounts", proof: "From your deals" };
export const INLINE_GLYPH = 16;

export function ProvenanceGlyph({ kind, unconfirmed, count, size = INLINE_GLYPH }: { kind: GlyphKind; unconfirmed?: boolean; count?: number | null; size?: number }) {
  const ink = kind === "you" ? Bold.blue : Bold.quiet;
  const ring = size + 8;
  const label = `${WORD[kind]}${unconfirmed ? ", unconfirmed" : ""}${count && count > 1 ? `, ${count} entries` : ""}`;
  return (
    <View style={[styles.wrap, { width: ring, height: ring, borderRadius: ring / 2 }, unconfirmed && styles.unconfirmed]} accessibilityLabel={label} accessibilityRole="image" testID={`prov-${kind}${unconfirmed ? "-unconfirmed" : ""}`}>
      <Feather name={ICON[kind]} size={size} color={ink} />
      {count && count > 1 ? <View style={styles.badge}><Text style={styles.badgeText}>{count}</Text></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:        { alignItems: "center", justifyContent: "center" },
  unconfirmed: { borderWidth: 1, borderStyle: "dashed", borderColor: Bold.quiet },
  badge:       { position: "absolute", right: -5, top: -4, minWidth: 14, height: 14, borderRadius: Bold.radius.chip, paddingHorizontal: 3, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  badgeText:   { ...BoldType.herLabel, color: Bold.ink2 },
});
