// Filtered / not-a-deal — FilteredView: the transparency drill-in (a pushed screen).
//
// The promise: "we file, we don't silently drop." This screen shows the athlete every
// message Nomila auto-filed as junk/non-deal — sender, why, and when — so nothing is a
// black box. It mirrors YourWeekOutcome's pushed-screen shell (safe-area back header +
// editorial masthead + its own ScrollView) and reads the SAME agent_actions feed
// (useAgentActions), filtered down to junk filings by the pure buildFiltered core.
//
// Rows are grouped by reason (biggest reason first). Each row carries a low-key
// "Actually a deal" affordance — a light recovery hook that confirms, then calls the
// (currently stubbed) onRecover. Full recovery lands later; this just wires the intent.

import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useAgentActions } from "../../../hooks/use-agent-actions";
import { haptics } from "../../../lib/haptics";
import { buildFiltered, type FilteredItem } from "./filteredLogic";
import { Fonts, Colors, Spacing, BorderRadius, Shadows } from "../../../constants/theme";

interface FilteredViewProps {
  /** Dismiss the pushed screen (back). Renders a back chevron in the header. */
  onClose?: () => void;
  /**
   * "This is actually a deal" — the recovery intent for one filed non-deal (by
   * agent_actions id). Optional + currently a stub upstream: full recovery is a later
   * step. When absent, the affordance still confirms and acknowledges locally.
   */
  onRecover?: (item: FilteredItem) => void;
}

export function FilteredView({ onClose, onRecover }: FilteredViewProps) {
  // Only the "file" action can be a junk filing — narrow the feed server-side, then
  // buildFiltered keeps just payload.kind==='junk'.
  const actionsQuery = useAgentActions({ action: "file" });
  const insets       = useSafeAreaInsets();

  const now      = Date.now();
  const filtered = useMemo(() => buildFiltered(actionsQuery.data, now), [actionsQuery.data, now]);

  // Rows the athlete has flagged as "actually a deal" this session — acknowledged inline
  // even while the real recovery path is still a stub, so the tap always feels heard.
  const [recovered, setRecovered] = useState<Set<string>>(new Set());

  function handleRecover(item: FilteredItem) {
    haptics.tap();
    Alert.alert(
      "This is actually a deal?",
      `I'll take another look at ${item.sender} and move it back into your deals.`,
      [
        { text: "Never mind", style: "cancel" },
        {
          text: "Yes, recover it",
          onPress: () => {
            setRecovered((prev) => new Set(prev).add(item.id));
            onRecover?.(item);
          },
        },
      ],
    );
  }

  let body: React.ReactNode;
  if (actionsQuery.isLoading) {
    body = (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={Colors.light.primary} />
        <Text style={styles.muted}>Pulling up what I filed…</Text>
      </View>
    );
  } else if (actionsQuery.error) {
    body = (
      <View style={styles.centered}>
        <Feather name="alert-circle" size={20} color={Colors.light.error} />
        <Text style={styles.muted}>Couldn't load your filtered list</Text>
      </View>
    );
  } else if (filtered.isEmpty) {
    // Warm empty state — the whole point of the screen is trust, so silence reads as a
    // promise kept, not an error.
    body = (
      <View style={styles.centered}>
        <View style={styles.emptyIcon}>
          <Feather name="check" size={22} color={Colors.light.primary} />
        </View>
        <Text style={styles.emptyTitle}>Nothing filtered</Text>
        <Text style={styles.muted}>I only surface real deals — nothing's been set aside as noise.</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {filtered.groups.map((group) => (
          <View key={group.reason} style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionLabel} numberOfLines={1}>{group.reason}</Text>
              <View style={styles.sectionRule} />
              <Text style={styles.sectionTotal}>{group.items.length}</Text>
            </View>
            <View style={styles.card}>
              {group.items.map((item, i) => {
                const isRecovered = recovered.has(item.id);
                return (
                  <View key={item.id} style={[styles.row, i > 0 && styles.rowDivider]}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowSender} numberOfLines={1}>{item.sender}</Text>
                      <View style={styles.rowMetaRow}>
                        <Text style={styles.rowReason} numberOfLines={1}>{group.reason}</Text>
                        {!!item.dateLabel && (
                          <>
                            <Text style={styles.rowDot}>·</Text>
                            <Text style={styles.rowDate}>{item.dateLabel}</Text>
                          </>
                        )}
                      </View>
                    </View>
                    {isRecovered ? (
                      <View style={styles.recoveredPill}>
                        <Feather name="check" size={11} color={Colors.light.success} />
                        <Text style={styles.recoveredText}>On it</Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => handleRecover(item)}
                        style={styles.recoverPill}
                        hitSlop={6}
                      >
                        <Feather name="corner-up-left" size={11} color={Colors.light.primary} />
                        <Text style={styles.recoverText}>Actually a deal</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        ))}

        {/* The promise that makes the screen worth trusting */}
        <View style={styles.reassureNote}>
          <Feather name="shield" size={11} color="#B98FA8" />
          <Text style={styles.reassureText}>I file, I never silently delete — anything here you can pull back.</Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Masthead — back control below the status bar so it never hides under the notch. */}
      <View style={[styles.header, { paddingTop: insets.top + Spacing.xs }]}>
        {onClose ? (
          <Pressable onPress={() => { haptics.tap(); onClose?.(); }} hitSlop={12} style={styles.backBtn}>
            <Feather name="chevron-left" size={24} color={Colors.light.text} />
            <Text style={styles.backLabel}>Brief</Text>
          </Pressable>
        ) : (
          <View style={styles.backBtn} />
        )}
      </View>
      <View style={styles.masthead}>
        <Text style={styles.mastheadTitle}>Filtered</Text>
        <Text style={styles.mastheadSub}>
          {filtered.isEmpty
            ? "What I set aside as noise — nothing yet."
            : `${filtered.total} ${filtered.total === 1 ? "message" : "messages"} I filed as not-a-deal · here's why`}
        </Text>
      </View>
      {body}
    </View>
  );
}

// ─── Styles (mirrors YourWeekOutcome's cream shell) ──────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: Spacing.lg, paddingBottom: 2,
  },
  backBtn: { flexDirection: "row", alignItems: "center", height: 36, marginLeft: -6, paddingRight: 8 },
  backLabel: { fontFamily: Fonts.body, fontSize: 15, color: Colors.light.text, marginLeft: -2 },

  // ── Masthead ──
  masthead: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg, gap: 3 },
  mastheadTitle: { fontFamily: Fonts.display, fontSize: 28, color: Colors.light.text, letterSpacing: -0.6 },
  mastheadSub: { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, lineHeight: 18 },

  scroll: { paddingTop: Spacing.xs, paddingBottom: Spacing["3xl"] },

  centered: { alignItems: "center", paddingTop: 56, paddingHorizontal: Spacing["3xl"], gap: Spacing.sm },
  muted:    { fontFamily: Fonts.body, fontSize: 14, color: Colors.light.textMuted, textAlign: "center", lineHeight: 20 },
  emptyIcon: {
    width: 48, height: 48, borderRadius: 24, marginBottom: 2,
    alignItems: "center", justifyContent: "center", backgroundColor: Colors.light.primaryLight,
  },
  emptyTitle: { fontFamily: Fonts.headingSemiBold, fontSize: 17, color: Colors.light.text },

  // ── Ledger section head (accent label · rule · count) ──
  section: { marginBottom: Spacing["2xl"] },
  sectionHead: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm + 2,
  },
  sectionLabel: {
    flexShrink: 1, fontFamily: Fonts.bodySemiBold, fontSize: 12.5, letterSpacing: 0.6,
    color: "#4A4640", textTransform: "uppercase",
  },
  sectionRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Colors.light.border },
  sectionTotal: {
    fontFamily: Fonts.bodySemiBold, fontSize: 11, color: "#9C968D",
    letterSpacing: 0.2, fontVariant: ["tabular-nums"],
  },

  // ── Shared card shell ──
  card: {
    marginHorizontal: Spacing.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1, borderColor: Colors.light.borderLight, borderRadius: BorderRadius.sm,
    overflow: "hidden",
    ...Shadows.sm,
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.borderLight },

  // ── Row: sender + reason·date, with the recovery pill on the right ──
  row: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: 12,
  },
  rowMain: { flex: 1, minWidth: 0, gap: 3 },
  rowSender: { fontFamily: Fonts.bodySemiBold, fontSize: 14.5, color: Colors.light.text, letterSpacing: -0.1 },
  rowMetaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  rowReason: { flexShrink: 1, fontFamily: Fonts.body, fontSize: 12.5, color: "#6B6560" },
  rowDot:    { fontFamily: Fonts.body, fontSize: 12.5, color: "#C5BFB8" },
  rowDate:   { fontFamily: Fonts.body, fontSize: 12.5, color: "#9C968D", fontVariant: ["tabular-nums"] },

  recoverPill: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0,
    minHeight: 26, paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.primaryLight,
  },
  recoverText: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Colors.light.primary },
  recoveredPill: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0,
    minHeight: 26, paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: BorderRadius.full, backgroundColor: Colors.light.successLight,
  },
  recoveredText: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Colors.light.success },

  reassureNote: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.xs,
  },
  reassureText: { fontFamily: Fonts.body, fontSize: 11.5, color: "#9C968D", flexShrink: 1 },
});
