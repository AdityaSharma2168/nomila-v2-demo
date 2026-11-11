/**
 * MilaFollowUps — what Mila's chat draws under her newest answer, once it has finished: the read-only nav chips (a
 * small frosted chip with a "go" glyph: it opens an existing screen, never drafts or sends) above the follow-up questions
 * (full-width frosted rows with a ↳ glyph: a tap asks it). Moved here unchanged from MilaSearchOverlay so the old chat
 * and chat v2 (thread/) draw the same rows from the same code.
 */
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { N, oppsFont } from "../deals/opps/tokens";
import { Frost } from "./Frost";
import type { MilaNavChip, MilaNavTarget } from "../../hooks/use-mila-chat";

/** Opener, follow-up and nav rows: soft frosted rows (DESIGN.md §16), never dark or outlined pills. */
const ROW_RADIUS = 18;
const NAV_RADIUS = 17;

/** A full-width tappable row: the ↳ glyph, then the FULL question (it wraps, never truncated). */
export function FollowUpRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => pressed && { opacity: 0.7 }}>
      <Frost radius={ROW_RADIUS} style={styles.row}>
        <Feather name="corner-down-right" size={16} color={N.ink500} />
        <Text style={styles.rowText}>{label}</Text>
      </Frost>
    </Pressable>
  );
}

/** A navigation chip: the leading glyph says it takes you somewhere, not that it asks a question. */
export function NavPill({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => pressed && { opacity: 0.7 }}>
      <Frost radius={NAV_RADIUS} style={styles.navPill}>
        <Feather name="corner-up-right" size={13} color={N.ink700} />
        <Text style={styles.navPillText} numberOfLines={1}>{label}</Text>
      </Frost>
    </Pressable>
  );
}

/** Nav chips (a horizontal row) above the follow-up questions (a labelled section). Draws nothing when both are empty. */
export function MilaFollowUps({
  actions = [], suggestions = [], onNav, onAsk,
}: {
  actions?: readonly MilaNavChip[];
  suggestions?: readonly string[];
  onNav: (target: MilaNavTarget) => void;
  onAsk: (question: string) => void;
}) {
  return (
    <>
      {actions.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow} keyboardShouldPersistTaps="handled" testID="mila-nav-chips">
          {actions.map((a, i) => <NavPill key={`nav-${i}`} label={a.label} onPress={() => onNav(a.target)} />)}
        </ScrollView>
      )}
      {suggestions.length > 0 && (
        <View style={styles.followupSection} testID="mila-followups">
          <Text style={styles.followupHeading}>Follow-ups</Text>
          {suggestions.map((s) => <FollowUpRow key={s} label={s} onPress={() => onAsk(s)} />)}
        </View>
      )}
    </>
  );
}

// Values from MilaSearchOverlay's StyleSheet (unchanged).
const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  rowText: { flex: 1, fontFamily: oppsFont(600), fontSize: 15, color: N.ink900 },
  pillRow: { gap: 8, paddingBottom: 2 },
  followupSection: { gap: 8, marginTop: 16, width: "100%" },
  followupHeading: { fontFamily: oppsFont(700), fontSize: 12.5, color: N.ink500 },
  navPill: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 13, justifyContent: "center" },
  navPillText: { fontFamily: oppsFont(700), fontSize: 12.5, color: N.ink900 },
});
