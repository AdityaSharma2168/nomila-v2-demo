// Home — the daily briefing (app layout B, agreed 8 Oct 2026): "how am I doing, and what needs me now". The Home tab's
// landing in the shell (HomeStack › Landing): no back button, the shell's gear + avatar on the hero. In this order:
//
//   Hero          her photo full-bleed under the scrim, "GOOD MORNING, {first name}" as the display, "Build what's next."
//   Score block   the ONE black block: the ring glowing with the number inside, Nomila's served read, the quiet
//                 confidence line, the capital legend, "Open My Intelligence" — the only place the score is featured
//                 (Me repeats it as one compact row, nothing more)
//   Coming up     AGENT_V3 + the server's AGENT_PLAN only: the next 2–3 dated events (components/goals/ComingUpStrip);
//                 a row opens Goals at the goal timed for it. Absent otherwise
//   What matters  ONE ranked list across every tab, five at most, anything on a clock first (lib/whatMattersNext). Each
//   next          row opens where it is handled (Opportunities › a deal, Financials …);
//                 Home never accepts, declines or replies. "See all N" → Opportunities; empty → "Nothing waiting on
//                 you" and the link to her Plan
//   Mila chips    "Mila can help with…": Mila's frosted chips from her open requests + imputed signals she can resolve;
//                 hidden when empty. Add contract → AddContractSheet · Connect insights → Settings · Share performance
//                 data → Mila with the prompt prefilled. Never a health item.
//
// There are NO shortcut rows on Home: every door lives on Me (opened by her avatar).
//
// Reads: GET /me/overview (the hero), GET /me/intelligence (the block), GET /me/what-matters-next (the list; an older
// server without it answers 404 → an empty list), GET /me/intelligence-requests
// and the connections read (the chips).

import React, { Suspense, useState } from "react";
import { View, ScrollView, SafeAreaView, StatusBar, StyleSheet, ActivityIndicator, Text } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { HomeStackParamList } from "../../navigation/MainTabNavigator";
import { leaveMeTo, openSettings } from "../../navigation/meNav";
import { useMeOverview, useMePool } from "../../hooks/use-me-knowledge";
import { useConnections } from "../../hooks/use-connections";
import { greetingFor } from "../../lib/knowledgeLogic";
import { meImagery, photoUri } from "../../lib/myStoryLogic";
import { useLastHero } from "../../lib/lastHero";
import { useAuth } from "../../lib/auth-context";
import { useMeIntelligence } from "../../hooks/use-me-intelligence";
import { meCardModel, ringBands } from "../../lib/myIntelligenceLogic";
import { useIntelligenceRequests } from "../../hooks/use-intelligence-requests";
import { useWhatMattersNext } from "../../hooks/use-what-matters-next";
import { rankNext, type NextCandidate } from "../../lib/whatMattersNext";
import { confidenceHomeLine, connectedPlatformIds, firstName, HOME_COPY, milaChips, type MilaChip } from "../../lib/strategyLogic";
import { openMila } from "../../lib/milaLaunch";
import { AGENT_V3, OPPS_BOARD } from "../../lib/flags";
import { HomeComingUp } from "../../components/goals/ComingUpStrip";
import { MeHero, MeHeroLine } from "../../components/me/MeHero";
import { TopBarActions } from "../../components/shell/TopBar";
import { ScoreBlock, MilaChips, NextList } from "../../components/home/HomeBriefing";
import { Button, LinkText } from "../../components/ui";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { Bold, BoldType } from "../../constants/theme";

// The contract sheet pulls the Expo pickers in at import time; it is loaded only when a chip opens it.
const AddContractSheet = React.lazy(() => import("../../components/deals/AddContractSheet").then((m) => ({ default: m.AddContractSheet })));

type NavProp = NativeStackNavigationProp<HomeStackParamList, "Landing">;

export const HOME_NEXT_ERROR = "Couldn't load what's next.";

/** Where a row opens: the screen that handles it. Nothing here acts on the item. */
export function openNextTarget(navigation: any, item: NextCandidate): void {
  const t = item.target;
  switch (t.screen) {
    case "opportunity":
      if (OPPS_BOARD) { leaveMeTo(navigation, "Opportunities", "OpportunityDetail", { opportunityId: t.opportunityId }); return; }
      if (t.dealId) { leaveMeTo(navigation, "Opportunities", "DealDetail", { dealId: t.dealId }); return; }
      leaveMeTo(navigation, "Opportunities");
      return;
    case "financials": leaveMeTo(navigation, "Opportunities", "Financials"); return;
    // Mila's suggestion: the chat its card is in (answered there: Update · Keep mine · Edit it).
    case "mila": openMila(t.conversationId ? { conversationId: t.conversationId } : {}); return;
    // No booking detail or card screen exists yet: bookings live in their Opportunities section.
    case "booking": case "card": leaveMeTo(navigation, "Opportunities"); return;
  }
}

export function HomeScreen({ now = new Date() }: { now?: Date } = {}) {
  const navigation = useNavigation<NavProp>();
  const overview = useMeOverview();
  const pool = useMePool();
  const o = overview.data;
  const img = meImagery(pool, "home");
  // Never the record's photo as a hero: it is a small sign-in picture; while the library loads, the hero is its plain ground.
  const { athlete } = useAuth();
  const shown = useLastHero(athlete?.id, img.hero && photoUri(img.hero) ? { uri: photoUri(img.hero)!, key: img.hero.asset_id } : null);
  const entry = o?.intelligence ?? null;
  const intel = useMeIntelligence(!!entry && entry.score != null);
  const card = meCardModel(entry, intel.data);

  // What matters next: the server's candidates; an older server (404) → nothing to rank.
  const next = useWhatMattersNext();
  const fallback = !!next.data?.unavailable;
  const candidates = fallback ? [] : next.data?.items ?? [];
  // The same count the Opportunities tab shows ("N waiting on you"): the server's `waiting`.
  const ranked = rankNext(candidates, fallback ? null : next.data?.waiting ?? null);

  const requests = useIntelligenceRequests(true);
  const connections = useConnections();
  const chips = milaChips(requests.data?.items, intel.data, connectedPlatformIds(connections.connections));
  const [contractFor, setContractFor] = useState<string | null>(null);
  const toPlan = () => leaveMeTo(navigation, "Strategy", "StrategyRoot");
  const toOpportunities = () => leaveMeTo(navigation, "Opportunities");

  // Swipe down: this screen's reads again — the overview, the score read, the list, the chips.
  const pull = usePullRefresh(() => Promise.all([
    overview.refetch?.(),
    entry && entry.score != null ? intel.refetch?.() : undefined,
    next.refetch?.(),
    requests.refetch?.(),
    connections.refetch?.(),
  ]));
  const onChip = (chip: MilaChip) => {
    if (chip.kind === "add_contract") setContractFor(chip.requestId ?? "");
    else if (chip.kind === "connect_insights") openSettings(navigation);
    else openMila({ context: { type: "brand" }, draft: chip.draft ?? undefined });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} refreshControl={pullRefresh(pull)}>
        <MeHero
          photoUrl={shown?.uri ?? null}
          photoKey={shown?.key}
          topRight={<TopBarActions onHero />}
          loading={overview.isLoading}
          greeting={`${greetingFor(now)},`}
          title={firstName(o?.identity.displayName)}
          minHeight={340}
          subtitle={<MeHeroLine strong>{HOME_COPY.heroLine}</MeHeroLine>}
        >
          {overview.isError ? <Button bold="onHero" onPress={() => overview.refetch()} style={styles.retry}>Retry</Button> : null}
        </MeHero>

        {/* ── your marketability: the black block ── */}
        {entry ? (
          <ScoreBlock
            score={card.score ? Number(card.score) : null}
            early={card.early}
            line={card.line}
            confidence={card.score && intel.data?.assessment ? confidenceHomeLine(intel.data.assessment.overall.level) : null}
            bands={card.score && intel.data?.assessment ? ringBands(intel.data.assessment) : undefined}
            preliminary={!!(intel.data?.preview?.preliminary ?? entry.preliminary)}
            preliminaryLine={intel.data?.preview?.label ?? null}
            onPress={() => navigation.navigate("Intelligence")}
          />
        ) : null}

        {/* ── coming up (AGENT_V3 + the server's AGENT_PLAN): the next dated events; a row with a prepared post opens
             that post kit, otherwise Goals at its goal. Draws nothing while either flag is off ── */}
        {AGENT_V3 ? <HomeComingUp enabled onOpen={(item) => (item.kitActionId
          ? leaveMeTo(navigation, "Studio", "PostKit", { id: item.kitActionId })
          : leaveMeTo(navigation, "Strategy", "StrategyRoot", item.goalId ? { goalId: item.goalId } : undefined))} /> : null}

        {/* ── what matters next: one ranked list, five at most, each row opens where it is handled ── */}
        {next.isLoading ? (
          <View style={styles.state} testID="home-next-loading"><ActivityIndicator color={Bold.ink} /></View>
        ) : next.isError ? (
          <View style={styles.state} testID="home-next-error">
            <Text style={styles.stateText}>{HOME_NEXT_ERROR}</Text>
            <LinkText onPress={() => { void next.refetch(); }}>Try again</LinkText>
          </View>
        ) : (
          <NextList ranked={ranked} now={now} onOpen={(item) => openNextTarget(navigation, item)} onSeeAll={toOpportunities} onPlan={toPlan} />
        )}

        {/* ── Mila can help with…: frosted chips, hidden when empty ── */}
        <MilaChips chips={chips} onPress={onChip} />
      </ScrollView>

      {contractFor !== null ? (
        <Suspense fallback={null}>
          <AddContractSheet visible onClose={() => setContractFor(null)} onCreated={() => setContractFor(null)} requestId={contractFor || undefined} />
        </Suspense>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: Bold.paper },
  content:   { paddingBottom: 40 },
  retry:     { alignSelf: "flex-start" },
  state:     { marginTop: 16, marginHorizontal: Bold.gutter, paddingVertical: 16, gap: 8, alignItems: "flex-start" },
  stateText: { ...BoldType.body, color: Bold.ink2 },
});
