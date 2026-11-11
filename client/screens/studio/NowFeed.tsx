/**
 * NowFeed — what is happening, and what is worth doing next.
 *
 * ─── NOT A LEDGER ──────────────────────────────────────────────────────────────────────────────
 * Three things only: something rendering right now, what is owed with a date on it, and a small
 * number of moments worth making something for. Everything finished lives on the Made shelf. A Now
 * screen that lists everything is the Made shelf with worse sorting.
 *
 * ─── THE IN-PROGRESS CARD IS CONDITIONAL ───────────────────────────────────────────────────────
 * It appears only while something is actually rendering. A permanent slot showing "nothing in
 * progress" is a status light for the absence of work.
 *
 * ─── ORDER IS BY WHAT IT COSTS TO IGNORE ───────────────────────────────────────────────────────
 * Rendering first (it is happening), then deadlines (they expire), then suggestions (they do not).
 */
import React from "react";
import { View, Text, ScrollView, StyleSheet, Image, ActivityIndicator } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { Feather } from "@expo/vector-icons";
import { HapticPressable } from "../../components/HapticPressable";
import { BrandLogo } from "../../components/BrandLogo";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { useDeliverables, useFixtures, useMadeShelf } from "../../hooks/use-studio-pending";
import { useEditsList } from "../../hooks/use-studio-edits";
import { STUDIO_IMAGE_EDIT } from "../../lib/flags";
import { readyBatches } from "./carouselLogic";
import { suggestionsFrom } from "./personalLogic";
import { dueLabel } from "./nowLogic";

export function NowFeed({
  onOpenItem, onMakeFor, onStart, onOpenCarousel,
}: {
  onOpenItem: (assetId: string) => void;
  onMakeFor: () => void;
  /** A suggestion tapped: starts the brand flow (PR 9, Lane 3b — personal posts are gone). */
  onStart: () => void;
  /** A carousel with results waiting (PR 9, Lane 4 — the one away-completion surface). */
  onOpenCarousel: (batchId: string) => void;
}) {
  const { data: made, isLoading, isError, isUnavailable } = useMadeShelf(true);
  const { data: deliverables } = useDeliverables();
  const { data: fixtures } = useFixtures();
  const edits = useEditsList(STUDIO_IMAGE_EDIT);
  // Swipe down: every Studio read on screen again (its content, deliverables and edits — all under ["studio"]).
  const qc = useQueryClient();
  const pull = usePullRefresh(() => qc.refetchQueries({ queryKey: ["studio"], type: "active" }));
  const ready = readyBatches(edits.data?.edits ?? []);

  const making = made.filter((m) => m.state === "making");
  const awaiting = made.filter((m) => m.state === "awaiting");
  const suggestions = suggestionsFrom(fixtures);

  /**
   * "Nothing needs you" is a CLAIM, and it is only true if we managed to ask. A failed read gives
   * `made: []` exactly as a genuinely quiet day does, so without this the screen reassures her that
   * she is all clear at the moment it knows least. Same bug, same hook, as the Made shelf's.
   */
  const cannotAsk = isError || isUnavailable;
  const empty =
    !isLoading && !cannotAsk && making.length === 0 && awaiting.length === 0 &&
    deliverables.length === 0 && suggestions.length === 0;

  return (
    <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false} refreshControl={pullRefresh(pull)}>
      {isLoading ? <ActivityIndicator style={{ marginTop: 34 }} color={Colors.light.primary} /> : null}

      {/* Only while something is rendering. */}
      {making.map((m) => (
        <View key={m.assetId} style={styles.progress}>
          <View style={styles.progressThumb}>
            {m.thumbUrl ? (
              <Image source={{ uri: m.thumbUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            ) : null}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.progressTitle} numberOfLines={1}>{m.title}</Text>
            <Text style={styles.progressSub}>Making it now</Text>
            <View style={styles.bar}><View style={styles.barFill} /></View>
          </View>
        </View>
      ))}

      {awaiting.length > 0 ? (
        <>
          <Text style={styles.label}>WAITING ON YOU</Text>
          {awaiting.map((m) => (
            <HapticPressable
              key={m.assetId}
              style={styles.row}
              onPress={() => onOpenItem(m.assetId)}
              accessibilityRole="button"
              accessibilityLabel={`${m.title}, waiting on you`}
            >
              <View style={styles.rowThumb}>
                {m.thumbUrl ? (
                  <Image source={{ uri: m.thumbUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : (
                  <View style={[StyleSheet.absoluteFill, styles.blank]}>
                    <Feather name="image" size={14} color={Colors.light.tabIconDefault} />
                  </View>
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{m.title}</Text>
                <Text style={styles.rowSub}>Made and not yet cleared by you.</Text>
              </View>
              <Feather name="chevron-right" size={15} color={Colors.light.tabIconDefault} />
            </HapticPressable>
          ))}
        </>
      ) : null}

      {ready.length > 0 ? (
        <>
          <Text style={styles.label}>READY</Text>
          {ready.map((b) => (
            <HapticPressable
              key={b.batchId}
              style={styles.row}
              onPress={() => onOpenCarousel(b.batchId)}
              accessibilityRole="button"
              accessibilityLabel={`Your carousel is ready, ${b.ready} of ${b.total} frames`}
            >
              <View style={styles.sparkWrap}>
                <Feather name="layers" size={16} color={Colors.light.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>Your carousel is ready</Text>
                <Text style={styles.rowSub}>{b.ready} {b.ready === 1 ? "frame" : "frames"} to look at · nothing saved yet</Text>
              </View>
              <Feather name="chevron-right" size={15} color={Colors.light.tabIconDefault} />
            </HapticPressable>
          ))}
        </>
      ) : null}

      {deliverables.length > 0 ? (
        <>
          <Text style={styles.label}>OWED</Text>
          {deliverables.map((d) => (
            <HapticPressable
              key={d.id}
              style={styles.row}
              onPress={onMakeFor}
              accessibilityRole="button"
              accessibilityLabel={`${d.campaign} for ${d.brandName}, ${dueLabel(d)}`}
            >
              <BrandLogo brandName={d.brandName} brandDomain={null} size={38} borderRadius={11} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{d.campaign}</Text>
                <Text style={styles.rowSub}>{d.brandName} · {d.format}</Text>
              </View>
              <View style={[styles.due, d.optional && styles.dueOptional]}>
                <Text style={styles.dueTxt}>{dueLabel(d)}</Text>
              </View>
            </HapticPressable>
          ))}
        </>
      ) : null}

      {suggestions.length > 0 ? (
        <>
          <Text style={styles.label}>WORTH MAKING</Text>
          {suggestions.map((s) => (
            <HapticPressable
              key={s.id}
              style={styles.row}
              onPress={onStart}
              accessibilityRole="button"
              accessibilityLabel={`${s.title}. ${s.why}`}
            >
              <View style={styles.sparkWrap}>
                <Feather name="zap" size={16} color={Colors.light.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle}>{s.title}</Text>
                <Text style={styles.rowSub}>{s.why}</Text>
              </View>
              <Feather name="chevron-right" size={15} color={Colors.light.tabIconDefault} />
            </HapticPressable>
          ))}
        </>
      ) : null}

      {cannotAsk && !isLoading ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {isError ? "Couldn't load what needs you" : "Not switched on yet"}
          </Text>
          <Text style={styles.emptyBody}>
            {isError
              ? "This is us, not you. Pull to refresh and try again."
              : "Making posts isn't live on your account yet."}
          </Text>
        </View>
      ) : null}

      {empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Nothing needs you right now</Text>
          <Text style={styles.emptyBody}>
            Deadlines from your deals and moments from your calendar show up here. Make something
            anyway with the ＋ above.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: Spacing.xl, paddingBottom: 30 },

  progress: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 18, padding: 12, marginBottom: 8,
  },
  progressThumb: {
    width: 44, height: 54, borderRadius: 10, overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  progressTitle: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.text },
  progressSub: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 2 },
  bar: {
    height: 4, borderRadius: 99, marginTop: 7, overflow: "hidden",
    backgroundColor: Colors.light.backgroundTertiary,
  },
  barFill: { width: "54%", height: "100%", borderRadius: 99, backgroundColor: Colors.light.primary },

  label: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, fontWeight: "700", letterSpacing: 1.3,
    color: Colors.light.textMuted, marginTop: 18, marginBottom: 9,
  },
  row: {
    flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 8,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 11,
  },
  rowThumb: {
    width: 38, height: 46, borderRadius: 9, overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  blank: { alignItems: "center", justifyContent: "center" },
  sparkWrap: {
    width: 38, height: 38, borderRadius: 11, backgroundColor: Colors.light.primaryLight,
    alignItems: "center", justifyContent: "center",
  },
  rowTitle: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.text },
  rowSub: {
    fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16,
    color: Colors.light.textMuted, marginTop: 2,
  },
  due: {
    borderRadius: 99, paddingHorizontal: 9, paddingVertical: 4,
    backgroundColor: Colors.light.warningLight,
  },
  dueOptional: { backgroundColor: Colors.light.backgroundSecondary },
  dueTxt: { fontFamily: Fonts.bodyBold, fontSize: 10.5, fontWeight: "700", color: Colors.light.text },

  empty: { alignItems: "center", paddingTop: 44, paddingHorizontal: 16 },
  emptyTitle: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.text },
  emptyBody: {
    fontFamily: Fonts.body, fontSize: 13, lineHeight: 19, color: Colors.light.textMuted,
    marginTop: 6, textAlign: "center", maxWidth: 280,
  },
});
