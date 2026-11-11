/**
 * MeAgentScreen — Me on the agent memory (EXPO_PUBLIC_AGENT_V3, and only while GET /me/scouting has her memory; the old
 * Me stays otherwise: MeScreen decides). Promoted from the approved prototype (PR #900,
 * client/screens/prototypes/MeProposalScreen.tsx). No greeting (that belongs to Home). Top to bottom:
 *
 *   the bar            ‹ HOME (Me is opened from the avatar). Settings live ONLY in the gear on Home's bar
 *   Your public page   PublicPageMini: a mini of her Front Door page itself (the same layout, scaled), her own view with
 *                      the metrics rail; the whole card (and its expand icon) opens the full page, Edit opens it in Edit.
 *                      With EXPO_PUBLIC_PUBLIC_CARD off: the existing card section (My Nomi), unchanged
 *   Scouting report    components/me/Scouting: the ONE place it lives, read from GET /me/scouting; each section's detail
 *                      opens in a sheet
 *   What Nomila knows  the door → What Nomila knows on the memory (GET /me/facts; correct · hide · dispute · confirm)
 */
import React, { useState } from "react";
import { View, ScrollView, SafeAreaView, StatusBar, StyleSheet } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { StackHeader } from "../../components/ui";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { Bold } from "../../constants/theme";
import { PUBLIC_CARD } from "../../lib/flags";
import { RatesDoor } from "../../components/me/RatesDoor";
import { toBrand } from "../../navigation/meNav";
import { PublicPageMini } from "../../components/me/PublicPageMini";
import { PublicCardSection } from "../../components/me/PublicCardSection";
import { DetailSheet } from "../../components/me/DetailSheet";
import { KnowsDoor, SHEET_TITLE, ScoutingInline, ScoutingSheetBody, type PillarImages, type ScoutSheet } from "../../components/me/Scouting";
import { useMyFrontDoor } from "../../hooks/use-my-front-door";
import { useAtmosphere } from "../../hooks/use-me-memory";
import type { ScoutingReport } from "../../../shared/meScouting";

export const ME_AGENT_COPY = { back: "Home" } as const;

export function MeAgentScreen({ report, onRefresh, sheet: initialSheet = null }: { report: ScoutingReport; onRefresh?: () => Promise<unknown> | void; sheet?: ScoutSheet | null }) {
  const navigation = useNavigation<any>();
  const route = useRoute();
  const [sheet, setSheet] = useState<ScoutSheet | null>(initialSheet);
  const page = useMyFrontDoor(PUBLIC_CARD);
  const pillars = report.defines?.pillars ?? [];
  const atm = useAtmosphere("me_scouting", pillars.map((p) => ({ key: `pillar:${p.key}`, type: "section_header" as const, purpose: "positioning", context: p.label })));
  const pillarImages: PillarImages = {};
  for (const p of pillars) {
    const img = atm[`pillar:${p.key}`];
    if (img) pillarImages[p.key] = { url: img.url, credit: img.credit };
  }
  const pull = usePullRefresh(() => Promise.all([onRefresh?.(), PUBLIC_CARD ? page.refetch() : undefined]));

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      {/* HOME_V3 opens this from Me's Brand book tile (Me › Scouting): its back row names Me. */}
      <StackHeader title={route?.name === "Scouting" ? "Me" : ME_AGENT_COPY.back} bold onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} refreshControl={pullRefresh(pull)} testID="me-agent">
        {PUBLIC_CARD ? (
          <PublicPageMini
            model={page.model}
            metrics={page.metrics}
            verified={page.verified}
            chapterImages={page.chapterImages}
            live={page.live}
            loading={page.isLoading}
            onExpand={() => navigation.navigate("PublicPage")}
            onEdit={() => navigation.navigate("PublicPage", { edit: true })}
          />
        ) : (
          <PublicCardSection
            enabled={false}
            photo={null}
            onDeck={() => toBrand(navigation, "Deck")}
            onReview={() => navigation.navigate("PublicCardReview")}
            onPreview={() => navigation.navigate("PublicCardPreview")}
            onSettings={() => navigation.navigate("PublicCardSettings")}
          />
        )}
        <ScoutingInline report={report} pillarImages={pillarImages} onSheet={setSheet} onIntelligence={() => navigation.navigate("Intelligence")} />
        <View style={styles.gap} />
        <KnowsDoor facts={report.knows.facts} unconfirmed={report.knows.unconfirmed} onPress={() => navigation.navigate("KnowsFacts")} />
        {/* OPPS_V2: Your rates (draws nothing otherwise). */}
        <RatesDoor style={styles.ratesDoor} onPress={() => navigation.navigate("YourRates")} />
      </ScrollView>
      {sheet ? (
        <DetailSheet title={SHEET_TITLE[sheet]} onClose={() => setSheet(null)} testID={`me-sheet-${sheet}`}>
          <ScoutingSheetBody kind={sheet} report={report} pillarImages={pillarImages} />
        </DetailSheet>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  ratesDoor: { marginHorizontal: Bold.gutter, marginTop: 16 },
  safe:    { flex: 1, backgroundColor: Bold.paper },
  content: { paddingBottom: 40 },
  gap:     { height: 6 },
});
