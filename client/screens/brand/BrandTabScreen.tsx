// The Brand tab: one header, four tabs.
//
//   Card    — the Nomi Card in place, then the doors: Deck, Score (→ My Intelligence), Your floor
//   Story   — the brand layer (PR C); today the raw material + what's coming
//   Facts   — the athlete record: every fact, who it came from, change / tell Mila / history
//   Growth  — the analytics that used to be the Brand › Analytics tab, unchanged
//
// Route params: `brandId/brandName` is the Opportunities "Tailor & send" bridge (unchanged);
// `tab` opens a specific tab (Mila's navigate chips: story / facts). On the kit: the doors are
// a Card of Rows.

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, StyleSheet, RefreshControl, Platform, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { BrandStackParamList, BrandTabKey } from "../../navigation/MainTabNavigator";
import { NomiCardHero } from "../../components/brand/NomiCardHero";
import { BrandHeader } from "../../components/brand/BrandHeader";
import { AnalyticsTab } from "../../components/analytics/AnalyticsTab";
import { useAuth } from "../../lib/auth-context";
import { useMeOverview } from "../../hooks/use-me-knowledge";
import { useAthleteRecord } from "../../hooks/use-athlete-record";
import { useShares } from "../../hooks/use-card";
import { FactsTab } from "./FactsTab";
import { StoryTab } from "./StoryTab";
import { Card, Row } from "../../components/ui";
import { OPPS_V2 } from "../../lib/flags";
import { leaveMeTo, openIntelligence, openRates, openSettings } from "../../navigation/meNav";
import { Fonts, Colors, Spacing } from "../../constants/theme";

const C = Colors.light;
type NavProp   = NativeStackNavigationProp<BrandStackParamList, "BrandOverview">;
type RouteProp_ = RouteProp<BrandStackParamList, "BrandOverview">;

const TABS: Array<{ key: BrandTabKey; label: string }> = [
  { key: "card",   label: "Card" },
  { key: "story",  label: "Story" },
  { key: "facts",  label: "Facts" },
  { key: "growth", label: "Growth" },
];

const DoorIcon = ({ name }: { name: React.ComponentProps<typeof Feather>["name"] }) => (
  <View style={styles.doorIcon}><Feather name={name} size={16} color={C.text} /></View>
);

export function BrandTabScreen() {
  const navigation  = useNavigation<NavProp>();
  const route       = useRoute<RouteProp_>();
  const { athlete } = useAuth();
  // The M.I.A. score shown here is the modern ledger read (my-intelligence), never the legacy
  // athletes_current.display_score/tier. `intelligence.score` is already null whenever the page withholds it.
  // Legacy retirement, phase 1 (8 Oct 2026): every score entry point opens My Intelligence, and the Rates door
  // is her floor only — the legacy projected annual value / rate card are no longer read here.
  const { data: overview, refetch: refetchOverview } = useMeOverview();
  const miaScore = overview?.intelligence.score ?? null;
  const record      = useAthleteRecord();
  const { totalOpens } = useShares(athlete?.id);
  const [tab, setTab] = useState<BrandTabKey>(route.params?.tab ?? "card");
  const [refreshing, setRefreshing] = useState(false);

  // A navigate chip can land here with a tab; honour it once, then clear so the next focus
  // doesn't yank the athlete back.
  useEffect(() => {
    if (route.params?.tab) { setTab(route.params.tab); navigation.setParams({ tab: undefined }); }
  }, [route.params?.tab, navigation]);

  // Cross-tab "Tailor & send" bridge (OpportunitiesScreen → Brand > BrandOverview with a brand picked).
  const pendingBrandId   = route.params?.brandId;
  const pendingBrandName = route.params?.brandName;
  const initialShareBrand = pendingBrandId != null ? { brandId: pendingBrandId, brandName: pendingBrandName } : undefined;
  const clearPendingBrand = useCallback(() => { navigation.setParams({ brandId: undefined, brandName: undefined }); }, [navigation]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchOverview(), record.refetch()]);
    setRefreshing(false);
  }, [refetchOverview, record]);

  // The Brand stack is a tab under Classic layout and pushed above the tabs in the shell; pushed, it needs a way back.
  const pushed = navigation.getParent()?.getState?.()?.type === "stack";

  // Record rows that belong elsewhere: the link names a place, we pick the screen (in either shell).
  const onLink = useCallback((link: string) => {
    switch (link) {
      case "score":       openIntelligence(navigation); break;
      case "rates":       openRates(navigation); break;
      case "deck":        navigation.navigate("Deck"); break;
      case "deals":       leaveMeTo(navigation, "Opportunities", "OpportunitiesList"); break;
      case "connections":
      case "settings":    openSettings(navigation); break;
      default: break;
    }
  }, [navigation]);

  const name = record.data?.header.name ?? ([athlete?.firstName, athlete?.lastName].filter(Boolean).join(" ") || null);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={C.backgroundRoot} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={C.primary} colors={[C.primary]} />}
      >
        {Platform.OS === "web" && refreshing && (
          <View style={styles.webRefreshBar}><ActivityIndicator size="small" color={C.primary} /></View>
        )}

        <BrandHeader
          name={name}
          identityLine={record.data?.header.identityLine ?? null}
          displayScore={miaScore}
          tier={null}
          photoUrl={record.data?.header.photoUrl}
          onScore={() => openIntelligence(navigation)}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          onBack={pushed ? () => navigation.getParent()?.goBack() : undefined}
        />

        <View style={styles.tabBar}>
          {TABS.map((t) => (
            <Pressable key={t.key} onPress={() => setTab(t.key)} style={styles.tabButton} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
              <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>{t.label}</Text>
              <View style={[styles.tabUnderline, tab === t.key && styles.tabUnderlineActive]} />
            </Pressable>
          ))}
        </View>

        {tab === "card" && (
          <>
            <NomiCardHero
              athleteId={athlete?.id}
              initialShareBrand={initialShareBrand}
              onConsumedInitialBrand={clearPendingBrand}
              onOpenDeck={() => navigation.navigate("Deck")}
            />

            {/* The doors — what a brand sees next, and what it costs */}
            <Card style={styles.doors}>
              <Row
                leading={<DoorIcon name="layers" />}
                value="Open the deck"
                meta={totalOpens > 0 ? `${totalOpens} open${totalOpens === 1 ? "" : "s"} · who looked, and when` : "Full screen, share, and who opened it"}
                onPress={() => navigation.navigate("Deck")}
              />
              <Row
                leading={<DoorIcon name="star" />}
                value="Score"
                meta={miaScore != null ? `${miaScore} of 850` : "Not computed yet"}
                onPress={() => openIntelligence(navigation)}
              />
              <Row
                leading={<DoorIcon name="dollar-sign" />}
                value={OPPS_V2 ? "Your rates" : "Your floor"}
                meta={OPPS_V2 ? "Ranges + your minimums" : "The least you'll take, per deal type"}
                onPress={() => openRates(navigation)}
                last
              />
            </Card>
          </>
        )}

        {tab === "story"  && <StoryTab onLink={onLink} />}
        {tab === "facts"  && <FactsTab onLink={onLink} />}
        {tab === "growth" && <AnalyticsTab />}

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: C.backgroundRoot },
  scroll:   { flex: 1 },
  content:  { paddingBottom: Spacing.xl },
  webRefreshBar: { alignItems: "center", paddingVertical: Spacing.sm },
  tabBar: { flexDirection: "row", paddingHorizontal: Spacing.xl, marginTop: Spacing.xs, marginBottom: Spacing.sm },
  tabButton: { flex: 1, alignItems: "center", gap: Spacing.sm },
  tabLabel: { fontFamily: Fonts.headingSemiBold, fontSize: 15, color: C.textMuted },
  tabLabelActive: { color: C.text },
  tabUnderline: { height: 2, width: "60%", borderRadius: 1, backgroundColor: "transparent" },
  tabUnderlineActive: { backgroundColor: C.primary },
  doors:     { marginHorizontal: Spacing.xl, marginTop: Spacing.md },
  doorIcon:  { width: 34, height: 34, borderRadius: 10, backgroundColor: C.backgroundDefault, alignItems: "center", justifyContent: "center" },
  bottomPad: { height: Spacing["4xl"] },
});
