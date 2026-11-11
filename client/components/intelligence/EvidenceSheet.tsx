// Concept 0.4 Slice 2 · Level 3, the evidence sheet for one area. Groups are the server's citation-strength buckets,
// in a fixed order (Checked · Site found, page not confirmed · From your connected accounts · Recorded before source
// checks). A cite the server marks `not_support` (ungrounded, asserted only) is never drawn and never counted (O-5;
// visual rules, Oct 2026): a link Nomila could not confirm is not evidence she should be shown.

import React from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, Linking } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Sheet } from "../ui";
import { LogoMark, LOGO_MARK_SIZES } from "../ui/LogoMark";
import { CitationGlyph } from "./Glyphs";
import { COPY, evidenceGroups, readDate, type EvidenceGroup } from "../../lib/myIntelligenceLogic";
import type { CitationStrength, MyIntelligenceEvidence } from "../../hooks/use-me-intelligence";
import { Bold, BoldType } from "../../constants/theme";

export function EvidenceSheet({ title, readOn, sources, evidence, hasReasons, onClose }: {
  title: string;
  readOn: string;
  sources: Record<CitationStrength, string[]>;
  evidence: MyIntelligenceEvidence[];
  hasReasons: boolean;
  onClose: () => void;
}) {
  const groups = evidenceGroups(sources, evidence);
  return (
    <Sheet onClose={onClose} title={title} headBelow={<Text style={styles.meta}>From the read on {readDate(readOn)}</Text>}>
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {!hasReasons ? <Text style={styles.empty}>{COPY.sourcesNotSaved}</Text>
          : groups.length === 0 ? <Text style={styles.empty}>No sources were cited for this area.</Text>
          : groups.map((g) => <Group key={g.strength} g={g} />)}
      </ScrollView>
    </Sheet>
  );
}

function Group({ g }: { g: EvidenceGroup }) {
  const ink = g.weaker ? Bold.mute : Bold.ink;
  return (
    <View style={styles.group} testID={`evidence-group-${g.strength}`}>
      <View style={styles.groupHead} accessibilityRole="header">
        <CitationGlyph kind={g.glyph} color={ink} />
        <Text style={[styles.groupTitle, { color: ink }]}>{g.title}</Text>
        <Text style={styles.count}>{g.items.length}</Text>
      </View>
      <Text style={styles.note}>{g.note}</Text>
      {g.items.map((e) => <Source key={e.id} e={e} weaker={g.weaker} />)}
    </View>
  );
}

function Source({ e, weaker }: { e: MyIntelligenceEvidence; weaker: boolean }) {
  const meta = [e.domain, e.observedAt ? readDate(e.observedAt) : null].filter(Boolean).join(" · ");
  return (
    <View style={styles.src} testID={`evidence-${e.id}`}>
      <LogoMark domain={e.domain} name={e.sourceTitle ?? e.domain ?? "?"} size={LOGO_MARK_SIZES.sm} bold />
      <View style={{ flex: 1, minWidth: 0 }}>
        {e.sourceTitle ? <Text style={[styles.srcTitle, weaker && { color: Bold.ink2 }]} numberOfLines={2}>{e.sourceTitle}</Text> : null}
        {meta ? <Text style={styles.srcMeta} numberOfLines={1}>{meta}</Text> : null}
        {e.claim ? <Text style={styles.claim}>{e.claim}</Text> : null}
        {e.sourceUrl ? (
          <Pressable onPress={() => Linking.openURL(e.sourceUrl!)} accessibilityRole="link" style={styles.open}>
            <Feather name="external-link" size={12} color={Bold.blue} />
            <Text style={styles.openText}>Open source</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll:     { maxHeight: 520 },
  meta:       { ...BoldType.caption, color: Bold.mute },
  empty:      { ...BoldType.body, color: Bold.mute, paddingVertical: 12 },
  group:      { marginTop: 12 },
  groupHead:  { flexDirection: "row", alignItems: "center", gap: 8 },
  groupTitle: { flex: 1, ...BoldType.h4 },
  count:      { ...BoldType.caption, color: Bold.mute },
  note:       { ...BoldType.caption, color: Bold.mute, marginTop: 2, marginBottom: 4 },
  src:        { flexDirection: "row", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: Bold.line },
  srcTitle:   { ...BoldType.body, color: Bold.ink },
  srcMeta:    { ...BoldType.caption, color: Bold.quiet, marginTop: 2 },
  claim:      { ...BoldType.lede, color: Bold.ink2, marginTop: 3 },
  open:       { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  openText:   { ...BoldType.link, color: Bold.blue },
});
