/**
 * WaitlistScreen — shown to authenticated athletes whose status is still 'waitlisted'.
 *
 * The app gates by status (see App.tsx RootGate): waitlisted users see this "you're on
 * the list" state instead of the full app. When an admin promotes them (status → active),
 * "Check access" re-fetches the profile and RootGate drops them into the real app.
 */

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth-context";
import { getApiUrl } from "../lib/query-client";
import { logger } from "../lib/logger";
import { Bold, Brand, Fonts, Spacing, BorderRadius } from "../constants/theme";

const BG    = Brand.heroBg;
// One look (23 Oct 2026): the action is raspberry; the status chip and rank read white on hero black (no ring colours).
const ACT = Bold.act;
const ON_DARK = "#FFFFFF";
const WHITE = "#FFFFFF";
const MUTED  = "rgba(255,255,255,0.55)";
const MUTED2 = "rgba(255,255,255,0.32)";

interface RankResponse {
  rank:    number;
  total:   number;
  socials: number;
}

export function WaitlistScreen() {
  const insets = useSafeAreaInsets();
  const { athlete, signOut, getAccessToken, refreshAthlete } = useAuth();

  const [rank, setRank]         = useState<RankResponse | null>(null);
  const [loadingRank, setLoadingRank] = useState(true);
  const [checking, setChecking] = useState(false);

  const firstName = athlete?.firstName?.trim() || athlete?.email?.split("@")[0] || null;

  const loadRank = useCallback(async () => {
    setLoadingRank(true);
    try {
      const token = await getAccessToken();
      if (!token) { setRank(null); return; }
      const res = await fetch(new URL("/api/v1/waitlist/rank", getApiUrl()).toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setRank((await res.json()) as RankResponse);
      else setRank(null);
    } catch (err) {
      logger.error("WaitlistScreen rank fetch failed:", err);
      setRank(null);
    } finally {
      setLoadingRank(false);
    }
  }, [getAccessToken]);

  useEffect(() => { loadRank(); }, [loadRank]);

  // Re-pull the profile (status may have flipped to 'active') and refresh the rank.
  const handleCheckAccess = async () => {
    setChecking(true);
    try {
      await refreshAthlete();
      await loadRank();
    } finally {
      setChecking(false);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + Spacing["3xl"], paddingBottom: insets.bottom + Spacing.xl }]}>
      <View style={styles.content}>
        <Text style={styles.wordmark}>NOMILA</Text>

        <View style={styles.chip}>
          <View style={styles.chipDot} />
          <Text style={styles.chipText}>SAVED</Text>
        </View>

        <Text style={styles.headline}>
          You're on the list{firstName ? `, ${firstName}` : ""}.
        </Text>
        <Text style={styles.sub}>
          We'll email you the moment access opens. Your Nomila agent is being prepared.
        </Text>

        {/* Rank */}
        <View style={styles.rankCard}>
          {loadingRank ? (
            <ActivityIndicator color={WHITE} />
          ) : rank ? (
            <>
              <View style={styles.rankRow}>
                <Text style={styles.rankHash}>#</Text>
                <Text style={styles.rankNum}>{rank.rank.toLocaleString()}</Text>
              </View>
              <Text style={styles.rankOf}>of {rank.total.toLocaleString()}</Text>
            </>
          ) : (
            <Text style={styles.rankSaved}>✓ Your spot is saved</Text>
          )}
        </View>

        <Text style={styles.hint}>
          Connect more socials on your profile to climb the list — each connection bumps your rank.
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed, checking && { opacity: 0.7 }]}
          onPress={handleCheckAccess}
          disabled={checking}
        >
          {checking ? <ActivityIndicator color={WHITE} size="small" /> : <Text style={styles.primaryBtnText}>Check access</Text>}
        </Pressable>
        <Pressable style={styles.signOutBtn} onPress={signOut} disabled={checking}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG, paddingHorizontal: Spacing["2xl"], justifyContent: "space-between" },
  content: { alignItems: "center", flex: 1, justifyContent: "center" },

  wordmark: {
    fontFamily: Fonts.display, fontSize: 15, letterSpacing: 5, color: WHITE,
    marginBottom: Spacing["3xl"],
  },

  chip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: BorderRadius.full,
    backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: "rgba(255,255,255,0.24)",
    marginBottom: Spacing.xl,
  },
  chipDot:  { width: 7, height: 7, borderRadius: 4, backgroundColor: ON_DARK },
  chipText: { fontFamily: Fonts.bodySemiBold, fontSize: 11, letterSpacing: 1.5, color: ON_DARK },

  headline: {
    fontFamily: Fonts.display, fontSize: 27, lineHeight: 34, color: WHITE,
    textAlign: "center", marginBottom: Spacing.md,
  },
  sub: {
    fontFamily: Fonts.body, fontSize: 14, lineHeight: 21, color: MUTED,
    textAlign: "center", marginBottom: Spacing["2xl"], paddingHorizontal: Spacing.md,
  },

  rankCard: {
    alignItems: "center", justifyContent: "center", minHeight: 96, minWidth: 160,
    paddingHorizontal: Spacing["2xl"], paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg, backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", marginBottom: Spacing.xl,
  },
  rankRow:  { flexDirection: "row", alignItems: "flex-start" },
  rankHash: { fontFamily: Fonts.display, fontSize: 24, color: "rgba(255,255,255,0.6)", marginTop: 4 },
  rankNum:  { fontFamily: Fonts.display, fontSize: 44, color: WHITE, lineHeight: 50 },
  rankOf:   { fontFamily: Fonts.body, fontSize: 13, color: MUTED2, marginTop: 2 },
  rankSaved:{ fontFamily: Fonts.bodySemiBold, fontSize: 18, color: ON_DARK },

  hint: {
    fontFamily: Fonts.body, fontSize: 12, lineHeight: 18, color: MUTED2,
    textAlign: "center", paddingHorizontal: Spacing.lg,
  },

  actions: { width: "100%", gap: Spacing.sm },
  primaryBtn: {
    alignItems: "center", justifyContent: "center", backgroundColor: ACT,
    paddingVertical: 15, borderRadius: BorderRadius.full,
  },
  primaryBtnText: {
    fontFamily: Fonts.bodySemiBold, fontSize: 15, letterSpacing: 2,
    textTransform: "uppercase", color: WHITE,
  },
  btnPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  signOutBtn:  { alignItems: "center", paddingVertical: Spacing.sm },
  signOutText: { fontFamily: Fonts.body, fontSize: 13, color: MUTED2 },
});
