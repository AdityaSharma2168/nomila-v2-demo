// DealDetailRoute — ONE detail per deal (owner, 8 Oct 2026). With the opportunity board on, every path that still opens a
// deal by its id (a money line on Financials, Home's older fallback, a deep link, Mila's navigate) lands on the brand's
// detail (OpportunityDetail: the grouped brand page with "Looks signed — confirm?"), never the older DealDetailScreen with
// its own stage bar and buttons. The deal is looked up once for its opportunity and the route is REPLACED, so back
// returns to where she came from. Only a deal that has no opportunity at all (one she added herself, before any email)
// keeps the older screen — it has no brand page to open.
import React, { useEffect } from "react";
import { View, ActivityIndicator, SafeAreaView, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useDeal } from "../hooks/use-deals";
import { StackHeader } from "../components/ui/StackHeader";
import { Bold } from "../constants/theme";
import { OPPS_LABEL } from "../lib/flags";

export type DealDetailTarget = { screen: "OpportunityDetail"; opportunityId: string } | { screen: "DealDetail" } | { screen: "pending" };

/** Where a deal opens. Pure: the board flag, whether the deal has loaded, and its opportunity. */
export function dealDetailTarget(board: boolean, loaded: boolean, deal: { opportunityId?: string | null } | null): DealDetailTarget {
  if (!board) return { screen: "DealDetail" };
  if (!loaded) return { screen: "pending" };
  return deal?.opportunityId ? { screen: "OpportunityDetail", opportunityId: deal.opportunityId } : { screen: "DealDetail" };
}

export function DealDetailRoute({ dealId, board, children }: { dealId: string; board: boolean; children: React.ReactNode }) {
  const navigation = useNavigation<any>();
  const { deal, isLoading, error } = useDeal(board ? dealId : undefined);
  const target = dealDetailTarget(board, !isLoading || !!error, deal);
  useEffect(() => {
    if (target.screen === "OpportunityDetail") navigation.replace("OpportunityDetail", { opportunityId: target.opportunityId });
  }, [target.screen, target.screen === "OpportunityDetail" ? target.opportunityId : null, navigation]);

  if (target.screen === "DealDetail") return <>{children}</>;
  return (
    <SafeAreaView style={styles.root} testID="deal-detail-route">
      <StackHeader title={OPPS_LABEL} bold onBack={() => navigation.goBack()} />
      <View style={styles.center}><ActivityIndicator color={Bold.ink} /></View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: Bold.paper },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
