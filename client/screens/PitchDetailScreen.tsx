import React, { useEffect, useState } from "react";
import {
  View, Text, SafeAreaView, StatusBar, Pressable, StyleSheet, Share, ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { StudioStackParamList } from "../navigation/MainTabNavigator";
import { useAuth } from "../lib/auth-context";
import { useMyPitches, useRebuildPitch } from "../hooks/use-pitches";
import { useAthleteCard, useCreateShare, useSaveCardTheme } from "../hooks/use-card";
import { CardDeck } from "../components/card-native/CardDeck";
import { NATIVE_LOOKS } from "../components/card-native/looks";
import { DECK_LOOK_LABEL, DEFAULT_DECK_LOOK, resolveDeckLook, type DeckLook } from "../../shared/deckLooks";
import { OpensPill } from "../components/pitch/OpensPill";
import { isNeedsRefresh } from "../components/pitch/pitchStatus";
import { Bold, Colors, Fonts, Spacing } from "../constants/theme";

// Stale/opened notes read ink on grey: the ring gold paints the M.I.A. score only (one look, 23 Oct 2026).
const GOLD_INK = Bold.ink;

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function PitchDetailScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const route = useRoute<RouteProp<StudioStackParamList, "PitchDetail">>();
  const { brandId, brandName } = route.params;
  const { athlete } = useAuth();
  const athleteId = athlete?.id;
  const qc = useQueryClient();

  const { pitches, refetch: refetchPitches } = useMyPitches(athleteId);
  const pitch = pitches.find((p) => p.brandId === brandId);
  const { kit } = useAthleteCard(athleteId, brandId);           // shares CardDeck's cache — no extra request
  const createShare = useCreateShare(athleteId);
  const rebuild = useRebuildPitch(athleteId);

  const saveLook = useSaveCardTheme(athleteId, brandId);

  // The pitch's look: the one she picked for this brand, else the one recommended from the brand's category
  // (kit.tokens.lookAdvice, shown under the switcher). Picking one saves it for this brand, so the share shows it.
  const advice = kit?.tokens?.lookAdvice;
  const [look, setLook] = useState<DeckLook>(DEFAULT_DECK_LOOK);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && kit?.tokens?.theme) { setLook(resolveDeckLook(kit.tokens.theme)); setSeeded(true); }
  }, [kit?.tokens?.theme, seeded]);
  const pickLook = (next: DeckLook) => {
    if (next === look) return;
    setSeeded(true);
    setLook(next);
    saveLook.mutate(next);
  };

  const opened = pitch?.status === "opened";
  const needsRefresh = pitch ? isNeedsRefresh(pitch) : false;
  const alreadySent = pitch?.status === "sent" || opened;

  const onShare = async () => {
    if (!athleteId) return;
    try {
      const r = await createShare.mutateAsync({
        mode: "live", tailoring: "brand", brandId, dealId: pitch?.dealId ?? undefined,
      });
      await Share.share({ message: r.url, url: r.url });
      refetchPitches();
    } catch { /* surfaced by mutation state */ }
  };

  const onRebuild = async () => {
    try {
      await rebuild.mutateAsync(brandId);
      qc.invalidateQueries({ queryKey: [`/api/card/${athleteId}?brandId=${brandId}`] });
      refetchPitches();
    } catch { /* surfaced by mutation state */ }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      {/* header */}
      <View style={styles.header}>
        <Pressable onPress={() => nav.goBack()} style={styles.icoBtn} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={Colors.light.text} />
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.title} numberOfLines={1}>{brandName ?? pitch?.brandName ?? "Pitch"}</Text>
          {opened ? (
            <Text style={styles.subGold}>Opened · {pitch!.opensCount} {pitch!.opensCount === 1 ? "open" : "opens"} · {ago(pitch!.lastOpenedAt)}</Text>
          ) : alreadySent ? (
            <Text style={styles.sub}>Sent {ago(pitch!.sentAt)}</Text>
          ) : (
            <Text style={styles.sub}>Ready to send</Text>
          )}
        </View>
        {opened && pitch!.opensCount > 0 ? <OpensPill count={pitch!.opensCount} compact /> : <View style={styles.icoBtn} />}
      </View>

      {/* stale nudge */}
      {needsRefresh ? (
        <View style={styles.stale}>
          <Feather name="refresh-cw" size={14} color={GOLD_INK} />
          <Text style={styles.staleTxt}>Your public card changed — this pitch is out of date.</Text>
          <Pressable onPress={onRebuild} disabled={rebuild.isPending} style={styles.staleBtn}>
            {rebuild.isPending ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.staleBtnTxt}>Refresh</Text>}
          </Pressable>
        </View>
      ) : null}

      {/* the tailored deck */}
      <View style={styles.deck}>
        <CardDeck athleteId={athleteId} brandId={brandId} theme={look} />
      </View>

      {/* footer: look switcher + actions */}
      <View style={styles.footer}>
        <View style={styles.lookRow}>
          <Text style={styles.lookLabel}>Look</Text>
          <View style={styles.lookPills}>
            {NATIVE_LOOKS.map((l) => (
              <Pressable
                key={l}
                onPress={() => pickLook(l)}
                style={[styles.lookPill, look === l && styles.lookPillOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: look === l }}
                accessibilityLabel={`${DECK_LOOK_LABEL[l]} look${advice?.look === l ? ", suggested" : ""}`}
              >
                <Text style={[styles.lookPillTxt, look === l && styles.lookPillTxtOn]}>{DECK_LOOK_LABEL[l]}</Text>
                {advice?.look === l ? <View style={[styles.suggestDot, look === l && styles.suggestDotOn]} /> : null}
              </Pressable>
            ))}
          </View>
        </View>
        {advice ? (
          <View style={styles.adviceRow}>
            <View style={styles.suggestDot} />
            <Text style={styles.adviceTxt} numberOfLines={2}>
              {advice.look === look ? advice.reason : `Suggested: ${DECK_LOOK_LABEL[advice.look]}. ${advice.reason}`}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable style={[styles.action, styles.actionPrimary]} onPress={onShare} disabled={createShare.isPending}>
            {createShare.isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Feather name={alreadySent ? "refresh-ccw" : "send"} size={16} color="#fff" />
                <Text style={styles.actionPrimaryTxt}>{alreadySent ? "Resend" : "Share"}</Text>
              </>
            )}
          </Pressable>
          <Pressable style={styles.action} onPress={onRebuild} disabled={rebuild.isPending}>
            {rebuild.isPending ? (
              <ActivityIndicator size="small" color={Colors.light.text} />
            ) : (
              <>
                <Feather name="refresh-cw" size={16} color={Colors.light.text} />
                <Text style={styles.actionTxt}>Rebuild</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  icoBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: Fonts.heading, fontSize: 18, fontWeight: "700", color: Colors.light.text },
  sub: { fontFamily: Fonts.bodyMedium, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 1 },
  subGold: { fontFamily: Fonts.bodyBold, fontSize: 11.5, color: GOLD_INK, fontWeight: "700", marginTop: 1 },
  stale: {
    flexDirection: "row", alignItems: "center", gap: 9, marginHorizontal: Spacing.lg, marginBottom: Spacing.sm,
    padding: 10, borderRadius: 14, backgroundColor: Bold.ground, borderWidth: 1, borderColor: Bold.line,
  },
  staleTxt: { flex: 1, fontFamily: Fonts.bodyMedium, fontSize: 12, color: GOLD_INK, fontWeight: "600" },
  staleBtn: { backgroundColor: Bold.ink, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7, minWidth: 66, alignItems: "center" },
  staleBtnTxt: { fontFamily: Fonts.bodyBold, fontSize: 12.5, fontWeight: "700", color: "#fff" },
  deck: { flex: 1, paddingHorizontal: Spacing.lg },
  footer: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.sm, gap: 14 },
  lookRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  lookLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: Colors.light.textMuted },
  lookPills: { flexDirection: "row", gap: 6, flex: 1 },
  lookPill: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 999, paddingVertical: 8,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
  },
  suggestDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.light.primary },
  suggestDotOn: { backgroundColor: "#fff" },
  adviceRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: -4 },
  adviceTxt: { flex: 1, fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: Colors.light.textSecondary },
  lookPillOn: { backgroundColor: Colors.light.text, borderColor: Colors.light.text },
  lookPillTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 11.5, color: Colors.light.textSecondary },
  lookPillTxtOn: { color: "#fff" },
  actions: { flexDirection: "row", gap: 10 },
  action: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, height: 48,
    borderRadius: 999, backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  actionPrimary: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  actionTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: Colors.light.text },
  actionPrimaryTxt: { fontFamily: Fonts.bodyBold, fontSize: 14, fontWeight: "700", color: "#fff" },
});
